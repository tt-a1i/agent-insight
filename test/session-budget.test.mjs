import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { finalizeSemanticRun, getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';
import { AGGREGATE_TASKS } from '../src/aggregate-protocol.mjs';

async function prepare(audit = false, projectPath = undefined) {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-budget-'));
  const transcript = join(root, 'large.jsonl');
  const text = `${'quote '.repeat(15_000)}Late acceptance constraint.`;
  await writeFile(transcript, [
    { type: 'user', cwd: projectPath, timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: text } },
    { type: 'assistant', timestamp: '2026-07-01T09:02:00Z', message: { role: 'assistant', content: 'Tests still fail.' } },
    { type: 'user', timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: 'Explain the failure.' } }
  ].map(JSON.stringify).join('\n'));
  const runsRoot = join(root, 'runs');
  const prepared = await prepareSemanticRun({
    runsRoot, request: { host: 'claude', sources: ['claude'], days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: 'test' }
  });
  const context = { runsRoot, runId: prepared.id };
  if (audit) {
    const run = await getSemanticRun(context);
    run.sessions[0].status = 'complete';
    run.sessions[0].facet = { underlyingGoal: 'Fix the parser', goalCategories: { fix_bug: 1 }, outcome: 'not_achieved' };
    run.sections = Object.fromEntries(AGGREGATE_TASKS.map((section) => [section, {}]));
    await writeFile(prepared.manifestPath, JSON.stringify(run));
  }
  return { context, text };
}

function findings(message, count = 3, explanationLength = 960) {
  return Array.from({ length: count }, (_, index) => ({
    category: 'acceptance_criteria', severity: 'high', evidence_posture: 'observed_instance',
    accusation: `Finding ${index}`, explanation: 'x'.repeat(explanationLength),
    quotations: [message.text.slice(0, 30)], locators: [{ message_indexes: [message.index] }],
    better_alternative: 'Name the regression gate.', root_cause: `Acceptance gap ${index}`
  }));
}

test('audit chunk budgets include validated carry and preserve persisted boundaries on resume and ingest', async () => {
  const { context, text } = await prepare(true);
  let task = await nextSemanticTask(context);
  const initial = await getSemanticRun(context);
  const id = initial.sessions[0].id;
  const initialCount = initial.extensions.userAudit.sessionChunks[id].chunkCount;
  let reconstructed = '';
  while (task.kind === 'session_audit_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    const resumed = await nextSemanticTask(context);
    assert.deepEqual(resumed, task);
    reconstructed += task.input.messages.filter((message) => message.index === 1).map((message) => message.text).join('');
    await ingestSemanticResult({ ...context, taskId: task.id, result: {
      summary: 'Cumulative audit with supported evidence.', findings: findings(task.input.messages[0])
    } });
    task = await nextSemanticTask(context);
  }
  assert.equal(task.kind, 'session_audit');
  assert.ok(task.request.prompt.length <= 30_000);
  assert.equal(reconstructed, text);
  const complete = await getSemanticRun(context);
  assert.ok(complete.extensions.userAudit.sessionChunks[id].chunkCount > initialCount);
});

test('baseline chunk budgets include substantial legal carry without exposing oversized prompts', async () => {
  const { context, text } = await prepare();
  let task = await nextSemanticTask(context);
  const initial = await getSemanticRun(context);
  const initialCount = initial.sessions[0].chunkCount;
  let reconstructed = '';
  while (task.kind === 'session_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), task);
    reconstructed += task.input.messages.filter((message) => message.index === 1).map((message) => message.text).join('');
    const message = task.input.messages[0];
    await ingestSemanticResult({ ...context, taskId: task.id, result: {
      summary: 'Supported cumulative synthesis.', evidence: Array.from({ length: 8 }, () => ({
        message_indexes: [message.index], description: 'd'.repeat(480), quotation: message.text.slice(0, 300)
      }))
    } });
    task = await nextSemanticTask(context);
  }
  assert.equal(task.kind, 'session_facet');
  assert.ok(task.request.prompt.length <= 30_000);
  assert.equal(reconstructed, text);
  assert.ok((await getSemanticRun(context)).sessions[0].chunkCount > initialCount);
});

test('carry that alone exceeds the prompt limit fails visibly instead of dropping synthesis or transcript', async () => {
  const { context } = await prepare(true);
  const first = await nextSemanticTask(context);
  await ingestSemanticResult({ ...context, taskId: first.id, result: {
    summary: 'Large but individually valid findings.', findings: findings(first.input.messages[0], 20, 2_000)
  } });
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const run = await getSemanticRun(context);
  assert.equal(run.extensionFailures.userAudit.reason, 'safety_limit');
  assert.equal(run.sessions[0].status, 'complete');
  const state = run.extensions.userAudit.sessionChunks[run.sessions[0].id];
  assert.equal(state.chunkResults[0].findings.length, 20);
  assert.equal(state.chunkResults[0].findings[0].explanation.length, 2_000);
  assert.equal(state.chunkResults.length, 1);
  const finalized = await finalizeSemanticRun({ ...context, outputDirectory: join(context.runsRoot, 'report') });
  assert.equal(finalized.report.extensions.userAudit.status, 'incomplete');
  assert.equal(finalized.report.extensions.userAudit.failure.reason, 'safety_limit');
});

test('baseline carry overflow records a recoverable safety failure before exposing another prompt', async () => {
  const { context } = await prepare(false, `/work/${'long-project-'.repeat(100)}`);
  const first = await nextSemanticTask(context);
  const message = first.input.messages[0];
  await ingestSemanticResult({ ...context, taskId: first.id, result: {
    summary: 'Legal evidence with long project metadata.',
    evidence: Array.from({ length: 20 }, () => ({
      message_indexes: [message.index], description: 'd'.repeat(480), quotation: message.text.slice(0, 300)
    }))
  } });
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const run = await getSemanticRun(context);
  assert.equal(run.sessions[0].status, 'failed');
  assert.equal(run.sessions[0].failure.reason, 'safety_limit');
  assert.equal(run.sessions[0].chunkResults[0].evidence.length, 20);
  await finalizeSemanticRun({ ...context, outputDirectory: join(context.runsRoot, 'report') });
});

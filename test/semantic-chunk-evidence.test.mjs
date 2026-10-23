import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const facet = (evidence) => ({
  underlying_goal: 'Repair the parser', goal_categories: { fix_bug: 1 }, outcome: 'not_achieved',
  user_satisfaction_counts: {}, agent_helpfulness: 'slightly_helpful', session_type: 'single_task',
  friction_counts: { buggy_code: 1 }, friction_detail: 'Regression failed.', primary_success: 'none',
  brief_summary: 'The requested tests still fail.', evidence
});

async function prepare(transcript, home) {
  const runsRoot = join(home, 'runs');
  const run = await prepareSemanticRun({
    runsRoot, request: { host: 'claude', sources: ['claude'], days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: 'test-model' }
  });
  return { runsRoot, runId: run.id };
}

test('long single-message tasks preserve late evidence and verify only exposed fragments and validated carry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-long-evidence-'));
  const transcript = join(home, 'long.jsonl');
  const tail = 'Do not deploy; the regression test must pass.';
  const failure = 'The regression failed; the goal is not achieved.';
  await writeFile(transcript, [
    { type: 'user', timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: `${'Context '.repeat(12_000)}${tail}` } },
    { type: 'assistant', timestamp: '2026-07-01T09:02:00Z', message: { role: 'assistant', content: `${'Investigation '.repeat(100)}${failure}` } },
    { type: 'user', timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: 'Report the failure.' } }
  ].map(JSON.stringify).join('\n'));
  const context = await prepare(transcript, home);
  let task = await nextSemanticTask(context);
  assert.equal(task.kind, 'session_chunk');
  assert.equal(task.input.messages.some((message) => message.text.includes(tail)), false);
  await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: {
    summary: 'Forged access to unseen tail.', evidence: [{ message_indexes: [1], description: 'Unseen instruction.', quotation: tail }]
  } }), /quotation does not match/);
  const resumed = await nextSemanticTask(context);
  assert.deepEqual(resumed.input.messages, task.input.messages);

  let evidence = [];
  let sawTail = false;
  let sawFailure = false;
  while (task.kind === 'session_chunk') {
    assert.ok(JSON.stringify(task.input.messages).length <= 25_000);
    for (const message of task.input.messages) {
      if (message.text.includes(tail)) {
        sawTail = true;
        evidence.push({ message_indexes: [message.index], description: 'Acceptance constraint.', quotation: tail });
      }
      if (message.text.includes(failure)) {
        sawFailure = true;
        evidence.push({ message_indexes: [message.index], description: 'Observed failed outcome.', quotation: failure });
      }
    }
    await ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'Preserve observed constraints and failures.', evidence } });
    task = await nextSemanticTask(context);
  }
  assert.equal(sawTail, true);
  assert.equal(sawFailure, true);
  assert.equal(task.kind, 'session_facet');
  await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: facet([
    { message_indexes: [1], description: 'Misattributed failure.', quotation: failure }
  ]) }), /quotation does not match/);
  const result = await ingestSemanticResult({ ...context, taskId: task.id, result: facet(evidence) });
  assert.deepEqual(result.evidence.map((item) => item.quotation), [tail, failure]);
  const complete = await getSemanticRun(context);
  assert.equal(complete.activeTask, null);
  assert.equal(JSON.stringify(complete).includes('Context Context Context'), false);
});

test('direct task quotation checks stay frozen when its source grows after exposure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-frozen-evidence-'));
  const transcript = join(home, 'active.jsonl');
  await copyFile(new URL('./fixtures/claude-parity.jsonl', import.meta.url), transcript);
  const context = await prepare(transcript, home);
  const task = await nextSemanticTask(context);
  await appendFile(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'New secret acceptance criterion.' } })}\n`);
  await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: facet([
    { message_indexes: [1], description: 'Unexposed later text.', quotation: 'New secret acceptance criterion.' }
  ]) }), /quotation does not match/);
  await ingestSemanticResult({ ...context, taskId: task.id, result: facet([
    { message_indexes: [1], description: 'Original instruction.', quotation: 'Fix the broken parser' }
  ]) });
  assert.equal((await getSemanticRun(context)).activeTask, null);
});

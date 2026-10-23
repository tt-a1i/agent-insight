import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AGGREGATE_TASKS } from '../src/aggregate-protocol.mjs';
import {
  createAuditAggregateRequest, createSessionAuditChunkRequest, createSessionAuditRequest,
  splitAuditMessages, validateSessionAuditChunkResult, validateSessionAuditResult
} from '../src/audit-protocol.mjs';
import { projectMessages } from '../src/protocol.mjs';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';
import { extractAnalysisInput } from '../src/transcript.mjs';

const input = {
  source: 'claude', date: '2026-07-03', opaqueId: 'aaaaaaaaaaaaaaaaaaaaaaaa', sessionId: 'context', locale: 'en',
  messages: [
    { index: 1, role: 'user', text: 'Compare both options before editing.' },
    { index: 2, role: 'assistant', text: 'I edited before receiving your decision.' },
    { index: 3, role: 'tool', text: 'npm', tool: { kind: 'result', name: 'npm', callId: 'call-1', status: 'failed', input: 'RAW_INPUT_SECRET', output: 'RAW_OUTPUT_SECRET' } },
    { index: 4, role: 'agent_event', text: '', agent: { status: 'failed', error: 'RAW_ERROR_SECRET' } },
    { index: 5, role: 'user', text: 'Stop editing; inspect the existing module offline after the registry failure.' }
  ]
};

function interaction(prompt) {
  return JSON.parse(/<interaction-json>\n([^]*?)\n<\/interaction-json>/.exec(prompt)[1]);
}

const strength = (quote, index) => ({ habit: 'States an approval boundary.', explanation: 'The instruction explicitly reserves the decision.', quotations: [quote], locators: [{ message_indexes: [index] }] });

test('direct and chunk audits see sanitized role-labeled context, while only genuine users qualify as evidence', () => {
  const direct = createSessionAuditRequest(input);
  const chunks = splitAuditMessages(input.messages);
  const chunk = createSessionAuditChunkRequest(input, chunks[0], 0, chunks.length);
  for (const request of [direct, chunk]) {
    assert.deepEqual(interaction(request.prompt), projectMessages(input.messages));
    assert.deepEqual(interaction(request.prompt).map((message) => message.role), ['user', 'assistant', 'tool', 'agent_event', 'user']);
    assert.match(request.prompt, /assistant ignoring a clear request/);
    assert.match(request.prompt, /justified change of plan or exploration/);
    assert.match(request.prompt, /Do not assign responsibility when context is missing/);
    assert.doesNotMatch(request.prompt, /RAW_INPUT_SECRET|RAW_OUTPUT_SECRET|RAW_ERROR_SECRET/);
  }
  for (const validate of [validateSessionAuditResult, validateSessionAuditChunkResult]) {
    for (const message of input.messages.filter((message) => message.role !== 'user' && message.text)) {
      assert.throws(() => validate({ summary: 'Context is not user evidence.', findings: [], strengths: [strength(message.text, message.index)] }, input), /fabricated quotation|unknown message index/);
    }
    assert.equal(validate({ summary: 'The boundary was clear.', findings: [], strengths: [strength(input.messages[0].text, 1)] }, input).strengths.length, 1);
  }
});

test('aggregate audits retain derived baseline responsibility context without treating it as causal fact', () => {
  const session = { id: input.opaqueId, source: input.source, date: input.date,
    facet: { underlyingGoal: 'Compare options', briefSummary: 'The options were explored.', outcome: 'not_achieved', frictionCounts: { wrong_approach: 1, external_issue: 1 }, frictionDetail: 'The assistant crossed an approval boundary and the registry failed.' }, userMessages: input.messages.filter((message) => message.role === 'user') };
  const request = createAuditAggregateRequest({ locale: 'en', sessions: [session] });
  const payload = JSON.parse(/<audit-data>\n([^]*?)\n<\/audit-data>/.exec(request.prompt)[1]);
  assert.deepEqual(payload.sessions[0].baseline_assessment, {
    evidence_status: 'derived assessment, not an independently established causal fact', outcome: 'not_achieved',
    friction_counts: { wrong_approach: 1, external_issue: 1 }, friction_detail: session.facet.frictionDetail
  });
  const changed = createAuditAggregateRequest({ locale: 'en', sessions: [{ ...session, facet: { ...session.facet, frictionCounts: { user_unclear: 1 } } }] });
  assert.notEqual(changed.prompt, request.prompt);
  assert.match(request.prompt, /derived judgments, not independently established causal facts/);
});

test('full-interaction audit chunks preserve long assistant context, frozen offsets and user-only evidence across resume and ingest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-audit-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcript = join(root, 'context.jsonl');
  const assistantText = `I ignored the approval boundary. ${'Reasoned assistant context. '.repeat(3000)} ASSISTANT_LATE_CONTEXT`;
  const records = [
    { type: 'user', timestamp: '2026-07-03T09:00:00Z', message: { role: 'user', content: 'Compare both options before editing.' } },
    { type: 'assistant', timestamp: '2026-07-03T09:01:00Z', message: { role: 'assistant', content: assistantText } },
    { type: 'assistant', timestamp: '2026-07-03T09:02:00Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'RAW_TOOL_INPUT_SECRET' } }] } },
    { type: 'user', timestamp: '2026-07-03T09:03:00Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'RAW_TOOL_OUTPUT_SECRET' },
      { type: 'text', text: 'Stop editing and inspect the existing module offline after the registry failure.' }
    ] } }
  ];
  await writeFile(transcript, `${records.map(JSON.stringify).join('\n')}\n`);
  const original = await extractAnalysisInput(transcript, 'claude');
  const runsRoot = join(root, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: Infinity, locale: 'en' },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }], analyzer: { host: 'claude', model: 'test' } });
  const context = { runsRoot, runId: prepared.id };
  const run = await getSemanticRun(context);
  run.sessions[0].status = 'complete';
  run.sessions[0].facet = { underlyingGoal: 'Compare options first', goalCategories: { understand_codebase: 1 }, outcome: 'not_achieved' };
  run.sections = Object.fromEntries(AGGREGATE_TASKS.map((section) => [section, {}]));
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  const fragments = new Map();
  let sawAssistantOnlyChunk = false;
  let sawFailedTool = false;
  let carry = [];
  let task = await nextSemanticTask(context);
  while (task.kind === 'session_audit_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), task);
    assert.deepEqual(interaction(task.request.prompt), task.input.messages);
    assert.doesNotMatch(JSON.stringify(task), /RAW_TOOL_INPUT_SECRET|RAW_TOOL_OUTPUT_SECRET/);
    for (const message of task.input.messages) {
      const texts = fragments.get(message.index) ?? [];
      texts.push(message.text);
      fragments.set(message.index, texts);
      if (message.tool?.status === 'failed') sawFailedTool = true;
    }
    if (task.input.messages.every((message) => message.role === 'assistant')) sawAssistantOnlyChunk = true;
    const assistant = task.input.messages.find((message) => message.role === 'assistant' && message.text.length > 30);
    if (assistant) {
      await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'Do not turn context into user evidence.', findings: [], strengths: [strength(assistant.text.slice(0, 30), assistant.index)] } }), /fabricated quotation|unknown message index/);
    }
    const user = task.input.messages.find((message) => message.role === 'user');
    if (user) carry = [strength(user.text, user.index)];
    await ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'The user stated an approval boundary; assistant noncompliance and a failed tool justify the correction and offline plan.', findings: [], strengths: carry } });
    task = await nextSemanticTask(context);
  }
  assert.equal(task.kind, 'session_audit');
  assert.ok(task.request.prompt.length <= 30_000);
  assert.match(task.request.prompt, /assistant noncompliance and a failed tool/);
  assert.equal(sawAssistantOnlyChunk, true);
  assert.equal(sawFailedTool, true);
  for (const message of original.messages) assert.equal(fragments.get(message.index).join(''), message.text);
  assert.equal([...fragments.values()].flat().join('').includes('ASSISTANT_LATE_CONTEXT'), true);
  await ingestSemanticResult({ ...context, taskId: task.id, result: { findings: [], strengths: carry } });
  const stored = await readFile(prepared.manifestPath, 'utf8');
  assert.doesNotMatch(stored, /Reasoned assistant context\. Reasoned assistant context/);
  assert.doesNotMatch(stored, /RAW_TOOL_INPUT_SECRET|RAW_TOOL_OUTPUT_SECRET/);
  assert.equal((await getSemanticRun(context)).activeTask, null);
});

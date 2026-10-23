import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  auditAggregateEvidenceContext, createAuditAggregateRequest, validateAuditAggregateChunkResult,
  validateAuditAggregateResult, validateSessionAuditChunkResult, validateSessionAuditResult
} from '../src/audit-protocol.mjs';
import { AGGREGATE_TASKS } from '../src/aggregate-protocol.mjs';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const positive = '先明确边界，再提供验收证据。';
const workflow = 'Read the diff, run the focused tests, then prepare the review checklist.';
const strength = (quote = positive, index = 1, sessionId) => ({
  habit: 'Scope and verification are explicit.', explanation: 'Preserve the clear boundary and evidence gate.',
  quotations: [quote], locators: [{ ...(sessionId ? { session_id: sessionId } : {}), message_indexes: [index] }]
});
const aggregate = (overrides = {}) => ({
  top_three: [], remaining: [], strengths: [], self_defeating_patterns: [],
  highest_leverage_change: null, automation_candidates: [], ...overrides
});
const recommendation = (overrides = {}) => ({
  change: 'Name the acceptance gate in the initial request.', rationale: 'The observed request omitted a success signal.',
  copyable_prompt: 'Review the parser only, and finish when its regression test passes.',
  quotations: ['Review the parser.'], locators: [{ session_id: 's', message_indexes: [1] }], ...overrides
});
const candidate = (overrides = {}) => ({
  name: 'Review checklist', type: 'prompt_template', trigger: 'When preparing a code review',
  frequency: 'Every day five times', inputs: ['diff', 'focused test command'], outputs: ['review checklist'],
  rationale: 'The same multi-step request appears twice.', over_automation_risk: 'A checklist can miss unusual risks.',
  draft_body: 'Read the diff, run the selected tests, and prepare a review checklist.',
  quotations: [workflow], locators: [{ session_id: 's', message_indexes: [1, 2] }], ...overrides
});

test('a positive late-session habit survives bounded storage with no negative finding', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    index: index + 1, role: 'user', text: index === 19 ? `${'context '.repeat(8000)}${positive}` : `Read-only check ${index + 1}.`
  }));
  const audit = validateSessionAuditResult({ findings: [], strengths: [strength(positive, 20)] }, { opaqueId: 's', messages });
  assert.deepEqual(audit.findings, []);
  assert.equal(audit.strengths.length, 1);
  assert.ok(JSON.stringify(audit).length < 5000);
  assert.ok(audit.userMessages.some((message) => message.index === 20 && message.text === positive && message.excerpt));
  assert.equal(JSON.stringify(audit).includes('context context'), false);
  const context = { sessions: [{ ...audit, id: 's' }] };
  assert.ok(createAuditAggregateRequest(context).prompt.includes(positive));
  const result = validateAuditAggregateResult(aggregate({ strengths: [strength(positive, 20, 's')] }), context);
  assert.equal(result.highestLeverageChange, null);
  assert.equal(result.strengths[0].quotations[0], positive);
});

test('strengths require genuine cited user quotations in session and chunk results', () => {
  const input = { opaqueId: 's', messages: [{ index: 1, role: 'user', text: positive }, { index: 2, role: 'assistant', text: 'Tests passed.' }] };
  for (const validate of [validateSessionAuditResult, validateSessionAuditChunkResult]) {
    const raw = { summary: 'Clear request.', findings: [], strengths: [strength()] };
    assert.equal(validate(raw, input).strengths.length, 1);
    assert.throws(() => validate({ ...raw, strengths: [{ ...strength(), quotations: undefined }] }, input), /quotations is required/);
    assert.throws(() => validate({ ...raw, strengths: [strength('Tests passed.', 2)] }, input), /fabricated quotation|unknown message index/);
    assert.throws(() => validate({ ...raw, strengths: [strength('Unseen tail')] }, input), /fabricated quotation/);
  }
});

test('positive-only rolling aggregate carry preserves evidence without reopening other text', () => {
  const sessions = [
    { id: 's', userMessages: [{ index: 1, role: 'user', text: `${positive} hidden extra detail` }] },
    { id: 'next', userMessages: [{ index: 1, role: 'user', text: 'Keep the accepted scope.' }] }
  ];
  const first = validateAuditAggregateChunkResult({ summary: 'Scope discipline works.', findings: [], strengths: [strength(positive, 1, 's')] }, { sessions: sessions.slice(0, 1) });
  const nextContext = auditAggregateEvidenceContext({ sessions }, [sessions[1]], first);
  const second = validateAuditAggregateChunkResult({ summary: 'Preserve the established scope habit.', findings: [], strengths: first.strengths }, nextContext);
  const finalContext = auditAggregateEvidenceContext({ sessions }, [], second);
  const result = validateAuditAggregateResult(aggregate({ strengths: second.strengths }), finalContext);
  assert.equal(result.strengths[0].quotations[0], positive);
  assert.deepEqual(result.topThree, []);
  assert.throws(() => validateAuditAggregateResult(aggregate({ strengths: [strength('hidden extra detail', 1, 's')] }), finalContext), /fabricated quotation/);
  assert.throws(() => validateAuditAggregateResult(aggregate({ strengths: [strength('Keep the accepted scope.', 1, 'next')] }), finalContext), /fabricated quotation/);
});

test('highest-leverage recommendations can abstain and otherwise require matching real evidence', () => {
  const context = { sessions: [{ id: 's', userMessages: [{ index: 1, role: 'user', text: 'Review the parser.' }, { index: 2, role: 'user', text: positive }] }] };
  assert.equal(validateAuditAggregateResult(aggregate(), context).highestLeverageChange, null);
  assert.equal(validateAuditAggregateResult(aggregate({ highest_leverage_change: recommendation() }), context).highestLeverageChange.locators[0].sessionId, 's');
  assert.throws(() => validateAuditAggregateResult(aggregate({ highest_leverage_change: recommendation({ quotations: undefined, locators: undefined }) }), context), /quotations is required/);
  for (const prompt of [undefined, null, '']) assert.throws(() => validateAuditAggregateResult(aggregate({ highest_leverage_change: recommendation({ copyable_prompt: prompt }) }), context), /copyable_prompt must be a non-empty string/);
  assert.throws(() => validateAuditAggregateResult(aggregate({ highest_leverage_change: recommendation({ locators: [{ session_id: 's', message_indexes: [2] }] }) }), context), /does not match its cited user messages/);
  assert.throws(() => validateAuditAggregateResult(aggregate({ highest_leverage_change: recommendation({ quotations: ['You publish five times per day.'] }) }), context), /fabricated quotation/);
});

test('automation recurrence is measured from distinct quoted messages, never model frequency', () => {
  const context = { sessions: [{ id: 's', userMessages: [
    { index: 1, role: 'user', text: workflow }, { index: 2, role: 'user', text: workflow },
    { index: 3, role: 'user', text: 'Unrelated one-off request.' }
  ] }] };
  const result = validateAuditAggregateResult(aggregate({ automation_candidates: [candidate()] }), context).automationCandidates[0];
  assert.equal(result.occurrenceCount, 2);
  assert.equal(result.sessionCount, 1);
  assert.equal(result.frequency, '2 cited user messages across 1 sessions');
  assert.equal(JSON.stringify(result).includes('Every day five times'), false);
  for (const indexes of [[1], [1, 1]]) {
    assert.throws(() => validateAuditAggregateResult(aggregate({ automation_candidates: [candidate({ locators: [{ session_id: 's', message_indexes: indexes }] })] }), context), /at least two distinct user messages/);
  }
  assert.throws(() => validateAuditAggregateResult(aggregate({ automation_candidates: [candidate({ locators: [{ session_id: 's', message_indexes: [1, 3] }] })] }), context), /matching quotation for every (?:cited|repeated) user message/);
  assert.throws(() => validateAuditAggregateResult(aggregate({ automation_candidates: [candidate({ quotations: undefined })] }), context), /quotations is required/);
  const fillerContext = { sessions: [{ id: 's', userMessages: [{ index: 1, role: 'user', text: '继续' }, { index: 2, role: 'user', text: 'ok' }] }] };
  assert.deepEqual(validateAuditAggregateResult(aggregate({ automation_candidates: [candidate({ quotations: ['继续', 'ok'] })] }), fillerContext).automationCandidates, []);
});

test('real audit chunk ingest carries positive-only evidence while rejecting unseen and uncarried long-message text', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-positive-carry-'));
  const transcript = join(home, 'session.jsonl');
  const early = 'Confirm scope before making changes.';
  const tail = 'The approved acceptance check passed; keep that evidence gate.';
  const hidden = 'UNQUOTED_MIDDLE_DETAIL';
  await writeFile(transcript, [
    { type: 'user', timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: `${early}${' context'.repeat(6000)}${hidden}${' context'.repeat(6000)}${tail}` } },
    { type: 'assistant', timestamp: '2026-07-01T09:02:00Z', message: { role: 'assistant', content: 'The accepted check passed.' } },
    { type: 'user', timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: 'Close this task.' } }
  ].map(JSON.stringify).join('\n'));
  const runsRoot = join(home, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }], analyzer: { host: 'claude', model: 'test' } });
  const context = { runsRoot, runId: prepared.id };
  // This regression isolates the audit state machine after a completed baseline.
  const run = await getSemanticRun(context);
  run.sessions[0].status = 'complete';
  run.sessions[0].facet = { underlyingGoal: 'A bounded review', briefSummary: 'The acceptance check passed.', goalCategories: { code_review: 1 }, outcome: 'fully_achieved' };
  run.sections = Object.fromEntries(AGGREGATE_TASKS.map((section) => [section, {}]));
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  let task = await nextSemanticTask(context);
  assert.equal(task.kind, 'session_audit_chunk');
  assert.equal(task.request.prompt.includes(tail), false);
  await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'Unseen claim.', findings: [], strengths: [strength(tail)] } }), /fabricated quotation/);
  let strengths = [];
  while (task.kind === 'session_audit_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), task);
    for (const quote of [early, tail]) {
      if (task.input.messages.some((message) => message.text.includes(quote)) && !strengths.some((item) => item.quotations.includes(quote))) strengths.push(strength(quote));
    }
    await ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'Preserve supported scope and acceptance habits.', findings: [], strengths } });
    task = await nextSemanticTask(context);
  }
  assert.equal(task.kind, 'session_audit');
  assert.equal(strengths.length, 2);
  await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: { findings: [], strengths: [strength(hidden)] } }), /does not match its cited user messages/);
  const audit = await ingestSemanticResult({ ...context, taskId: task.id, result: { findings: [], strengths } });
  assert.equal(audit.strengths.length, 2);
  assert.equal(JSON.stringify(audit).includes(hidden), false);
  assert.ok(JSON.stringify(audit).length < 5000);
  task = await nextSemanticTask(context);
  assert.equal(task.kind, 'audit_aggregate');
  assert.ok(task.request.prompt.includes(early) && task.request.prompt.includes(tail));
  await ingestSemanticResult({ ...context, taskId: task.id, result: aggregate({ strengths: strengths.map((item) => ({ ...item, locators: [{ session_id: run.sessions[0].id, message_indexes: [1] }] })) }) });
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  assert.equal((await getSemanticRun(context)).extensions.userAudit.aggregate.highestLeverageChange, null);
});

test('real aggregate batch ingest carries verified strengths into the final bounded validation context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-positive-batches-'));
  const candidates = [];
  for (let index = 0; index < 20; index += 1) {
    const path = join(home, `session-${index}.jsonl`);
    await writeFile(path, [
      { type: 'user', sessionId: `positive-${index}`, timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: `${positive} hidden context ${'x'.repeat(1000)}` } },
      { type: 'assistant', sessionId: `positive-${index}`, timestamp: '2026-07-01T09:02:00Z', message: { role: 'assistant', content: 'The accepted check passed.' } },
      { type: 'user', sessionId: `positive-${index}`, timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: `Close this accepted task. ${'y'.repeat(1000)}` } }
    ].map(JSON.stringify).join('\n'));
    candidates.push({ source: 'claude', locator: { kind: 'file', path } });
  }
  const runsRoot = join(home, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: 30 }, candidates, analyzer: { host: 'claude', model: 'test' } });
  const context = { runsRoot, runId: prepared.id };
  // Isolate aggregate execution using already validated, bounded positive-only session audits.
  const run = await getSemanticRun(context);
  run.sections = Object.fromEntries(AGGREGATE_TASKS.map((section) => [section, {}]));
  run.extensions = { userAudit: { sessions: {}, aggregateChunks: [], sessionChunks: {} } };
  for (const session of run.sessions) {
    session.status = 'complete';
    session.facet = { underlyingGoal: 'A bounded review', briefSummary: `Accepted scope. ${'z'.repeat(800)}`, goalCategories: { code_review: 1 }, outcome: 'fully_achieved' };
    run.extensions.userAudit.sessions[session.id] = validateSessionAuditResult({ findings: [], strengths: [strength()] }, {
      opaqueId: session.id, messages: [
        { index: 1, role: 'user', text: `${positive} hidden context ${'x'.repeat(1000)}` },
        { index: 3, role: 'user', text: `Close this accepted task. ${'y'.repeat(1000)}` }
      ]
    });
  }
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  let task = await nextSemanticTask(context);
  assert.equal(task.kind, 'audit_aggregate_chunk');
  const retained = strength(positive, 1, run.sessions[0].id);
  let chunks = 0;
  while (task.kind === 'audit_aggregate_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), task);
    await ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'Preserve the observed acceptance discipline.', findings: [], strengths: [retained] } });
    chunks += 1;
    task = await nextSemanticTask(context);
  }
  assert.ok(chunks > 1);
  assert.equal(task.kind, 'audit_aggregate');
  assert.ok(task.request.prompt.includes('chunk_summaries'));
  assert.ok(task.request.prompt.includes(positive));
  await assert.rejects(ingestSemanticResult({ ...context, taskId: task.id, result: aggregate({ strengths: [strength('hidden context', 1, run.sessions[0].id)] }) }), /fabricated quotation/);
  const result = await ingestSemanticResult({ ...context, taskId: task.id, result: aggregate({ strengths: [retained] }) });
  assert.equal(result.strengths[0].locators[0].sessionId, run.sessions[0].id);
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
});

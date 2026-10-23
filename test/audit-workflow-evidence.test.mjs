import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  auditAggregateEvidenceContext, createAuditAggregateChunkRequest, createAuditAggregateRequest,
  createSessionAuditChunkRequest, createSessionAuditRequest, splitAuditSessions, splitAuditUserMessages,
  validateAuditAggregateChunkResult, validateAuditAggregateResult, validateSessionAuditChunkResult, validateSessionAuditResult
} from '../src/audit-protocol.mjs';
import { AGGREGATE_TASKS } from '../src/aggregate-protocol.mjs';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const quote = 'Inspect the diff, run focused tests, then draft a review checklist without publishing.';
const observation = (index, sessionId, overrides = {}) => ({
  description: 'A multi-step review request.', task_boundary: `Independent review task ${index}.`, quotations: [quote],
  locators: [{ ...(sessionId ? { session_id: sessionId } : {}), message_indexes: [index] }], ...overrides
});
const empty = (overrides = {}) => ({ findings: [], strengths: [], ...overrides });
const aggregate = (overrides = {}) => ({ top_three: [], remaining: [], strengths: [], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: [], ...overrides });
const candidate = (locators) => ({ name: 'Review checklist draft', type: 'prompt_template', trigger: 'For a new independent review', inputs: ['diff', 'focused tests'], outputs: ['checklist draft'], rationale: 'Two independent reviews request the same sequence.', over_automation_risk: 'Review judgment and publication approval stay manual.', draft_body: 'Inspect the diff and run focused tests. Draft a checklist; do not publish.', quotations: [quote], locators });
const session = (audit, id = 's') => ({ ...audit, id, source: 'claude', facet: { underlyingGoal: 'Bounded reviews', briefSummary: 'Review requests.' } });
const data = (request) => JSON.parse(request.prompt.match(/<audit-data>\n([^]*?)\n<\/audit-data>/)[1]);

test('late neutral workflow requests survive without findings or strengths and support grounded automation', () => {
  const messages = [...Array.from({ length: 8 }, (_, i) => ({ index: i + 1, role: 'user', text: `Inspect file ${i + 1} read-only.` })),
    { index: 9, role: 'user', text: `For independent review A: ${quote}` }, { index: 10, role: 'user', text: `For independent review B: ${quote}` }];
  const input = { opaqueId: 's', messages };
  const audit = validateSessionAuditResult(empty({ workflow_evidence: [observation(9), observation(10)] }), input);
  assert.deepEqual(audit.findings, []);
  assert.deepEqual(audit.strengths, []);
  assert.equal(audit.workflowEvidence.length, 2);
  assert.ok(audit.userMessages.some((message) => message.index === 10 && message.text === quote));
  const context = { sessions: [session(audit)] };
  const payload = data(createAuditAggregateRequest(context));
  assert.equal(payload.sessions[0].workflow_evidence.length, 2);
  assert.equal(payload.sessions[0].workflow_evidence[1].taskBoundary, 'Independent review task 10.');
  const result = validateAuditAggregateResult(aggregate({ automation_candidates: [candidate([{ session_id: 's', message_indexes: [9, 10] }])] }), context);
  assert.equal(result.automationCandidates.length, 1);
  assert.equal(result.automationCandidates[0].evidenceMessageCount, 2);
  assert.deepEqual(validateSessionAuditResult(empty(), input).workflowEvidence, [], 'Missing legacy field means no retained workflow records.');
});

test('workflow observations require bounded genuine quotations and cannot borrow summary or other-role text', () => {
  const input = { opaqueId: 's', messages: [{ index: 1, role: 'user', text: quote }, { index: 2, role: 'assistant', text: 'I ran every test.' }] };
  for (const validate of [validateSessionAuditResult, validateSessionAuditChunkResult]) {
    const raw = empty({ summary: 'DERIVED_SUMMARY_ONLY', workflow_evidence: [observation(1)] });
    assert.equal(validate(raw, input).workflowEvidence.length, 1);
    for (const [text, index] of [['DERIVED_SUMMARY_ONLY', 1], ['I ran every test.', 2]]) {
      assert.throws(() => validate({ ...raw, workflow_evidence: [observation(index, null, { quotations: [text] })] }, input), /fabricated quotation|unknown message index/);
    }
    assert.throws(() => validate({ ...raw, workflow_evidence: [observation(2)] }, input), /unknown message index/);
    assert.throws(() => validate({ ...raw, workflow_evidence: [observation(1, null, { task_boundary: undefined })] }, input), /task_boundary must be a non-empty string/);
    assert.throws(() => validate({ ...raw, workflow_evidence: Array.from({ length: 21 }, () => observation(1)) }, input), /at most twenty/);
  }
});

test('one long message exposes only current and carried workflow quotes, never an unexposed fragment', () => {
  const early = 'Inspect the first review without publishing.';
  const late = quote;
  const text = `${early}${' context '.repeat(6000)}UNRETAINED_MIDDLE${' context '.repeat(6000)}${late}`;
  const input = { opaqueId: 's', messages: [{ index: 1, role: 'user', text }] };
  const chunks = splitAuditUserMessages(input.messages);
  const part = (chunk) => chunk.map((item) => ({ ...item, role: 'user' }));
  assert.throws(() => validateSessionAuditChunkResult(empty({ summary: 'Only early context.', workflow_evidence: [observation(1)] }), { ...input, messages: part(chunks[0]) }), /fabricated quotation/);
  const first = validateSessionAuditChunkResult(empty({ summary: 'Observed one request.', workflow_evidence: [observation(1, null, { quotations: [early] })] }), { ...input, messages: part(chunks[0]) });
  const last = validateSessionAuditChunkResult(empty({ summary: 'Same original message, not two independent occurrences.', workflow_evidence: [...first.workflowEvidence, observation(1)] }), {
    ...input, messages: [{ index: 1, role: 'user', text: early, excerpt: true }, ...part(chunks.at(-1))]
  });
  const exposed = [early, late].map((text) => ({ index: 1, role: 'user', text, excerpt: true }));
  assert.throws(() => validateSessionAuditResult(empty({ workflow_evidence: [observation(1, null, { quotations: ['UNRETAINED_MIDDLE'] })] }), { ...input, userMessages: input.messages, messages: exposed }), /fabricated quotation|does not match/);
  const audit = validateSessionAuditResult(empty({ workflow_evidence: last.workflowEvidence }), { ...input, userMessages: input.messages, messages: exposed });
  assert.equal(audit.workflowEvidence.length, 2);
  assert.ok(JSON.stringify(audit).length < 5000);
  assert.throws(() => validateAuditAggregateResult(aggregate({ automation_candidates: [candidate([{ session_id: 's', message_indexes: [1, 1] }])] }), { sessions: [session(audit)] }), /at least two distinct user messages/);
});

test('workflow-only aggregate carry retains cross-session support without reopening unrelated quotes', () => {
  const sessions = ['a', 'b'].map((id) => session(validateSessionAuditResult(empty({ workflow_evidence: [observation(1)] }), {
    opaqueId: id, messages: [{ index: 1, role: 'user', text: quote }, { index: 2, role: 'user', text: `PRIVATE_UNCARRIED_${id}` }]
  }), id));
  const first = validateAuditAggregateChunkResult(empty({ summary: 'Review A request.', workflow_evidence: [observation(1, 'a')] }), { sessions: [sessions[0]] });
  const secondContext = auditAggregateEvidenceContext({ sessions }, [sessions[1]], first);
  const second = validateAuditAggregateChunkResult(empty({ summary: 'Two independent review requests.', workflow_evidence: [...first.workflowEvidence, observation(1, 'b')] }), secondContext);
  const finalContext = auditAggregateEvidenceContext({ sessions }, [], second);
  const result = validateAuditAggregateResult(aggregate({ workflow_evidence: second.workflowEvidence, automation_candidates: [candidate([{ session_id: 'a', message_indexes: [1] }, { session_id: 'b', message_indexes: [1] }])] }), finalContext);
  assert.equal(result.automationCandidates[0].evidenceSessionCount, 2);
  assert.equal(result.workflowEvidence.length, 2);
  assert.throws(() => validateAuditAggregateChunkResult(empty({ summary: 'No reopening.', workflow_evidence: [observation(2, 'a', { quotations: ['PRIVATE_UNCARRIED_a'] })] }), finalContext), /fabricated quotation/);
});

test('near-limit neutral-only channel stays bounded, compact, and safe in session and rolling prompts', () => {
  const messages = Array.from({ length: 12 }, (_, i) => ({ index: i + 1, role: 'user', text: `Review ${i + 1}: ${quote} ${'x'.repeat(110)}` }));
  const input = { opaqueId: 's', messages };
  const raw = messages.map((message) => observation(message.index, null, { quotations: [message.text] }));
  let audit = validateSessionAuditResult(empty({ workflow_evidence: raw }), input);
  let missing = 5800 - JSON.stringify(audit.workflowEvidence).length;
  for (const item of raw) {
    const add = Math.max(0, Math.min(missing, 500 - item.description.length));
    item.description += 'd'.repeat(add); missing -= add;
  }
  audit = validateSessionAuditResult(empty({ workflow_evidence: raw }), input);
  assert.ok(JSON.stringify(audit.workflowEvidence).length >= 5700);
  assert.ok(JSON.stringify(audit.workflowEvidence).length <= 6000);
  const context = { sessions: [session(audit)] };
  assert.equal(splitAuditSessions(context.sessions).length, 1);
  const payload = data(createAuditAggregateRequest(context));
  assert.ok(payload.sessions[0].user_messages.every((item) => !messages.some((message) => message.index === item.index && message.text === item.text)), 'Identical workflow quotes appear once in the prompt.');
  const carry = validateAuditAggregateChunkResult(empty({ summary: 'd'.repeat(1900), workflow_evidence: audit.workflowEvidence }), context);
  assert.ok(createAuditAggregateChunkRequest(context, context.sessions, 1, 2, carry).prompt.length <= 30_000);
  assert.ok(createSessionAuditChunkRequest(input, [], 1, 2, { summary: 'd'.repeat(1900), findings: [], strengths: [], workflowEvidence: audit.workflowEvidence }).prompt.length <= 30_000);
  const oversized = raw.map((item) => ({ ...item, description: 'd'.repeat(500), task_boundary: 'b'.repeat(500) }));
  const copy = structuredClone(oversized);
  assert.throws(() => validateSessionAuditResult(empty({ workflow_evidence: oversized }), input), /6000-character serialized channel budget/);
  assert.deepEqual(oversized, copy, 'Over-budget evidence is rejected without truncation or mutation.');
});

test('all audit prompts distinguish neutral records, independent episodes, and unchanged action authority', () => {
  const input = { opaqueId: 's', messages: [{ index: 1, role: 'user', text: quote }] };
  const requests = [createSessionAuditRequest(input), createSessionAuditChunkRequest(input, input.messages, 0, 1), createAuditAggregateRequest({ sessions: [] }), createAuditAggregateChunkRequest({}, [], 0, 1)];
  for (const request of requests) {
    assert.match(request.prompt, /workflow_evidence/);
    assert.match(request.prompt, /not independent occurrences/);
    assert.match(request.prompt, /Drafts preserve scope, read-only limits, and approval gates/);
  }
});

async function prepareRuntime(long) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-workflow-'));
  const path = join(home, 'session.jsonl');
  const user = (text, minute) => ({ type: 'user', sessionId: 'neutral', timestamp: `2026-07-01T09:${String(minute).padStart(2, '0')}:00Z`, message: { role: 'user', content: text } });
  const records = Array.from({ length: 8 }, (_, i) => user(`Inspect file ${i + 1} read-only.`, i));
  if (long) records.push({ type: 'assistant', sessionId: 'neutral', timestamp: '2026-07-01T09:08:00Z', message: { role: 'assistant', content: 'Neutral comparison context. '.repeat(3000) } });
  records.push(user(`For independent review A: ${quote}`, 10), user(`For independent review B: ${quote}`, 11));
  await writeFile(path, records.map(JSON.stringify).join('\n'));
  const runsRoot = join(home, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: Infinity }, candidates: [{ source: 'claude', locator: { kind: 'file', path } }], analyzer: { host: 'claude', model: 'test' } });
  const context = { runsRoot, runId: prepared.id };
  // Isolate audit execution after a completed baseline. Every audit result,
  // source projection, frozen offset and resume still uses real runtime ingest.
  const run = await getSemanticRun(context);
  run.sessions[0].status = 'complete';
  run.sessions[0].facet = { underlyingGoal: 'Read-only reviews', briefSummary: 'Bounded review requests.', goalCategories: { code_review: 1 }, outcome: 'fully_achieved' };
  run.sections = Object.fromEntries(AGGREGATE_TASKS.map((name) => [name, {}]));
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  return { context, run };
}

test('real direct and chunk-final ingestion preserve late neutral workflow evidence through the aggregate', async () => {
  for (const long of [false, true]) {
    const { context, run } = await prepareRuntime(long);
    let task = await nextSemanticTask(context);
    let observations = [];
    let chunks = 0;
    while (task.kind === 'session_audit_chunk') {
      assert.ok(task.request.prompt.length <= 30_000);
      assert.deepEqual(await nextSemanticTask(context), task);
      for (const message of task.input.messages.filter((item) => item.role === 'user' && item.text.includes(quote))) observations.push(observation(message.index));
      await ingestSemanticResult({ ...context, taskId: task.id, result: empty({ summary: 'Preserve exposed neutral workflow requests.', workflow_evidence: observations }) });
      chunks += 1;
      task = await nextSemanticTask(context);
    }
    assert.equal(task.kind, 'session_audit');
    if (!long) observations = task.input.messages.filter((item) => item.role === 'user' && item.text.includes(quote)).map((message) => observation(message.index));
    assert.equal(observations.length, 2);
    assert.equal(chunks > 1, long);
    const audit = await ingestSemanticResult({ ...context, taskId: task.id, result: empty({ workflow_evidence: observations }) });
    assert.ok(audit.userMessages.some((message) => message.index > 8 && message.text === quote));
    assert.equal(JSON.stringify(audit).includes('Neutral comparison context.'), false);
    task = await nextSemanticTask(context);
    assert.equal(task.kind, 'audit_aggregate');
    assert.equal(data(task.request).sessions[0].workflow_evidence.length, 2);
    const locators = observations.flatMap((item) => item.locators.map((locator) => ({ ...locator, session_id: run.sessions[0].id })));
    const final = await ingestSemanticResult({ ...context, taskId: task.id, result: aggregate({ automation_candidates: [candidate(locators)] }) });
    assert.equal(final.automationCandidates.length, 1);
    assert.equal((await nextSemanticTask(context)).kind, 'complete');
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  auditAssessmentContext, auditCarryAssessmentContext, auditAggregateEvidenceContext,
  createAuditAggregateChunkRequest, createAuditAggregateRequest, createSessionAuditChunkRequest,
  createSessionAuditFromChunksRequest, createSessionAuditRequest, validateAuditAggregateChunkResult,
  validateAuditAggregateResult, validateSessionAuditChunkResult, validateSessionAuditResult
} from '../src/audit-protocol.mjs';
import { AGGREGATE_TASKS } from '../src/aggregate-protocol.mjs';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const userMessages = [
  { index: 1, role: 'user', text: 'Compare A and B for the required platform before implementation.' },
  { index: 3, role: 'user', text: 'Then choose B. Keep implementation paused until acceptance criteria are agreed.' }
];
const input = { opaqueId: 's', source: 'claude', date: '2026-10-22', messages: [
  userMessages[0], { index: 2, role: 'assistant', text: 'NEW_PLATFORM_FACT: A lacks required platform support. B supports it.' }, userMessages[1]
] };
const assessed = (summary) => ({ status: 'assessed', summary });
const emptyAggregate = (extra = {}) => ({ top_three: [], remaining: [], strengths: [], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: [], ...extra });
const session = (audit) => ({ ...audit, id: 's', source: 'claude', facet: { underlyingGoal: 'Compare platform options', briefSummary: 'Compared A and B; implementation remains paused.' } });
const payload = (request) => JSON.parse(request.prompt.match(/<audit-data>\n([^]*?)\n<\/audit-data>/)[1]);

test('missing assessment context stays explicitly unknown, supplied context is bounded and derived', () => {
  const audit = validateSessionAuditResult({ findings: [], strengths: [] }, input);
  assert.equal(audit.assessmentContext.status, 'unknown');
  assert.equal(audit.assessmentContext.summary, null);
  assert.match(audit.assessmentContext.evidenceStatus, /not an independently established causal fact or complete transcript/);
  assert.deepEqual(payload(createAuditAggregateRequest({ sessions: [session(audit)] })).sessions[0].assessment_context, audit.assessmentContext);
  assert.throws(() => auditAssessmentContext(assessed('x'.repeat(2001))), /summary is too long/);
  assert.throws(() => auditAssessmentContext({ status: 'complete', summary: 'Everything is known.' }), /status assessed or unknown/);
  assert.throws(() => auditAssessmentContext({ status: 'unknown', summary: 'Pretend complete.' }), /null summary/);
  assert.throws(() => auditAssessmentContext(assessed('')), /non-empty string/);
});

test('justified and unresolved plan changes retain distinct assessment contexts through the aggregate boundary', () => {
  const justified = 'The new platform constraint explains choosing B; no direction-churn finding is supported.';
  const unresolved = 'No new constraint has been identified; why the plan changed is unknown.';
  const audits = [justified, unresolved].map((summary) => validateSessionAuditResult({ findings: [], strengths: [], assessment_context: assessed(summary) }, input));
  const requests = audits.map((audit) => createAuditAggregateRequest({ sessions: [session(audit)] }));
  assert.notEqual(requests[0].prompt, requests[1].prompt);
  assert.equal(payload(requests[0]).sessions[0].assessment_context.summary, justified);
  assert.equal(payload(requests[1]).sessions[0].assessment_context.summary, unresolved);
  assert.deepEqual(audits[0].userMessages.map(({ text }) => text), userMessages.map(({ text }) => text));
  assert.equal(JSON.stringify(audits[0].userMessages).includes('NEW_PLATFORM_FACT'), false);
  assert.equal(JSON.stringify(audits[0]).includes(input.messages[1].text), false);
});

test('legacy cumulative chunk summaries survive final omission, but explicit unknown is never upgraded', () => {
  const summary = 'The newly discovered platform constraint resolves the apparent direction change; withdraw the earlier concern.';
  const chunk = validateSessionAuditChunkResult({ summary, findings: [], strengths: [] }, input);
  assert.equal(chunk.assessmentContext.status, 'assessed');
  const request = createSessionAuditFromChunksRequest(input, [chunk]);
  assert.equal(request.prompt.split(summary).length - 1, 1, 'Do not send duplicate prose in summary and assessmentContext.');
  const audit = validateSessionAuditResult({ findings: [], strengths: [] }, { ...input, assessmentContext: auditCarryAssessmentContext(chunk) });
  assert.equal(audit.assessmentContext.summary, summary);
  const explicitUnknown = validateSessionAuditChunkResult({ summary, findings: [], strengths: [], assessment_context: { status: 'unknown', summary: null } }, input);
  assert.equal(auditCarryAssessmentContext(explicitUnknown).status, 'unknown');
  assert.equal(auditCarryAssessmentContext({ summary }).summary, summary, 'Pre-field persisted chunk still carries its derived summary.');
  assert.equal(validateSessionAuditResult({ findings: [], assessment_context: { status: 'unknown', summary: null } }, { ...input, assessmentContext: chunk.assessmentContext }).assessmentContext.status, 'unknown');
});

test('context-only aggregate carry survives empty quote permissions and cannot become user evidence', () => {
  const summary = 'CONTEXT_ONLY_EXONERATION: choosing B was justified by newly discovered platform incompatibility.';
  const context = { sessions: [session(validateSessionAuditResult({ findings: [], strengths: [], assessment_context: assessed(summary) }, input))] };
  const first = validateAuditAggregateChunkResult({ summary, findings: [], strengths: [] }, context);
  const bounded = auditAggregateEvidenceContext(context, [], first);
  assert.deepEqual(bounded.sessions, []);
  assert.equal(bounded.assessmentContext.summary, summary);
  const request = createAuditAggregateRequest({ ...bounded, chunkSummaries: [first] });
  assert.equal(request.prompt.split(summary).length - 1, 1);
  assert.equal(validateAuditAggregateResult(emptyAggregate(), bounded).assessmentContext.summary, summary);
  assert.throws(() => validateAuditAggregateResult(emptyAggregate({ highest_leverage_change: {
    change: 'Choose B sooner.', rationale: 'The summary is not user evidence.', copyable_prompt: 'Choose B after comparing platform support.',
    quotations: [summary], locators: [{ session_id: 's', message_indexes: [1] }]
  } }), bounded), /fabricated quotation/);
  const unknown = auditAggregateEvidenceContext(context, [], { ...first, assessmentContext: auditAssessmentContext({ status: 'unknown', summary: null }) });
  assert.equal(unknown.assessmentContext.status, 'unknown');
});

test('audit prompts separate effective corrections from defects and preserve contextual limits in every stage', () => {
  const requests = [
    createSessionAuditRequest(input), createSessionAuditChunkRequest(input, input.messages, 0, 1),
    createSessionAuditFromChunksRequest(input, [{ summary: 'No issue found.', findings: [], strengths: [] }]),
    createAuditAggregateRequest({ sessions: [] }), createAuditAggregateChunkRequest({ sessions: [] }, [], 0, 1)
  ];
  for (const request of requests) {
    assert.match(request.prompt, /Each accusation, title, change, and habit must independently respect evidence/);
    assert.match(request.prompt, /Unknown background permits directly observable user mistakes/);
  }
  for (const request of requests.slice(0, 3)) {
    assert.doesNotMatch(request.prompt, /Include correction_quality when the user issues useful or poor corrections/);
    assert.match(request.prompt, /Effective corrections belong in strengths/);
  }
  for (const request of requests.slice(3)) assert.match(request.prompt, /Do not resurrect a withdrawn finding/);
});

async function prepareAuditOnly({ assistantText, count = 1 }) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-assessment-'));
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(home, `session-${index}.jsonl`);
    await writeFile(path, [
      { type: 'user', sessionId: `assessment-${index}`, timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: userMessages[0].text } },
      { type: 'assistant', sessionId: `assessment-${index}`, timestamp: '2026-07-01T09:01:00Z', message: { role: 'assistant', content: assistantText } },
      { type: 'user', sessionId: `assessment-${index}`, timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: userMessages[1].text } }
    ].map(JSON.stringify).join('\n'));
    candidates.push({ source: 'claude', locator: { kind: 'file', path } });
  }
  const runsRoot = join(home, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: Infinity }, candidates, analyzer: { host: 'claude', model: 'test' } });
  const context = { runsRoot, runId: prepared.id };
  const run = await getSemanticRun(context);
  // Isolate audit execution after a completed baseline; source messages and
  // every audit chunk/session result still go through actual runtime ingest.
  for (const entry of run.sessions) {
    entry.status = 'complete';
    entry.facet = { underlyingGoal: 'Compare platform options', briefSummary: 'A bounded comparison.', goalCategories: { understand_codebase: 1 }, outcome: 'fully_achieved' };
  }
  run.sections = Object.fromEntries(AGGREGATE_TASKS.map((name) => [name, {}]));
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  return { context, prepared, run };
}

test('direct and chunk-final real ingestion retains derived reasons without persisting assistant bodies', async () => {
  for (const long of [false, true]) {
    const decisive = 'The required platform makes option A incompatible; option B is compatible.';
    const assistantText = long ? `${'Comparison context. '.repeat(4000)}${decisive}` : decisive;
    const { context, run } = await prepareAuditOnly({ assistantText });
    const summary = 'DERIVED_REASON: platform incompatibility justifies choosing B; no user defect was found.';
    let task = await nextSemanticTask(context);
    let sawDecisive = false;
    while (task.kind === 'session_audit_chunk') {
      assert.ok(task.request.prompt.length <= 30_000);
      assert.deepEqual(await nextSemanticTask(context), task);
      if (task.input.messages.some((message) => message.text.includes(decisive))) sawDecisive = true;
      await ingestSemanticResult({ ...context, taskId: task.id, result: { summary: sawDecisive ? summary : 'The comparison is still in progress; causal context is incomplete.', findings: [], strengths: [] } });
      task = await nextSemanticTask(context);
    }
    assert.equal(task.kind, 'session_audit');
    const audit = await ingestSemanticResult({ ...context, taskId: task.id, result: { findings: [], strengths: [], ...(!long ? { assessment_context: assessed(summary) } : {}) } });
    assert.equal(audit.assessmentContext.summary, summary);
    assert.equal(JSON.stringify(audit).includes(assistantText), false);
    task = await nextSemanticTask(context);
    assert.equal(task.kind, 'audit_aggregate');
    const data = payload(task.request);
    assert.equal(data.sessions[0].assessment_context.summary, summary);
    assert.equal(data.sessions[0].id, run.sessions[0].id);
    await ingestSemanticResult({ ...context, taskId: task.id, result: emptyAggregate({ assessment_context: assessed(summary) }) });
    assert.equal((await nextSemanticTask(context)).kind, 'complete');
  }
});

test('real aggregate rolling ingestion preserves old summary context with no surviving user evidence', async () => {
  const { context, prepared, run } = await prepareAuditOnly({ assistantText: 'B supports the required platform.', count: 20 });
  const summary = 'ROLLING_CONTEXT_REASON: the plan change was justified, the earlier suspicion was withdrawn.';
  run.extensions = { userAudit: { sessions: {}, aggregateChunks: [], sessionChunks: {} } };
  for (const entry of run.sessions) {
    run.extensions.userAudit.sessions[entry.id] = validateSessionAuditResult({ findings: [], strengths: [], assessment_context: assessed(`${summary} ${'bounded detail '.repeat(80)}`) }, { ...input, opaqueId: entry.id });
  }
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  let task = await nextSemanticTask(context);
  assert.equal(task.kind, 'audit_aggregate_chunk');
  let chunks = 0;
  while (task.kind === 'audit_aggregate_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), task);
    assert.ok(task.request.prompt.includes(summary));
    await ingestSemanticResult({ ...context, taskId: task.id, result: { summary, findings: [], strengths: [] } });
    chunks += 1;
    task = await nextSemanticTask(context);
  }
  assert.ok(chunks > 1);
  assert.equal(task.kind, 'audit_aggregate');
  assert.equal(task.request.prompt.split(summary).length - 1, 1);
  const final = await ingestSemanticResult({ ...context, taskId: task.id, result: emptyAggregate() });
  assert.equal(final.assessmentContext.summary, summary);
  assert.equal(final.assessmentContext.status, 'assessed');
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
});

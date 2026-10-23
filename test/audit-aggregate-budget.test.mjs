import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AGGREGATE_TASKS, legacySplitAggregateSessions } from '../src/aggregate-protocol.mjs';
import {
  auditAggregateEvidenceContext, auditAggregateUnits, materializeAuditAggregateUnits,
  createAuditAggregateChunkRequest, splitAuditSessions,
  validateAuditAggregateChunkResult, validateSessionAuditResult, collapseByRootCause, collapseByIntent
} from '../src/audit-protocol.mjs';
import { failSemanticTask, finalizeSemanticRun, getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun, semanticSubmissionForTask } from '../src/semantic-run.mjs';

const prose = (size) => 'The request postpones its acceptance signal. This describes authorization wording, not implementation or completion. '.repeat(Math.ceil(size / 116)).slice(0, size);
const text = (index) => `Review module ${index}, run focused checks, and draft notes. Keep work read-only and require approval before publishing; define the acceptance signal later.`;
const observations = (messages, big = true) => ({
  findings: messages.slice(0, big ? 6 : 2).map((message, index) => ({ category: 'acceptance_criteria', severity: 'low', evidence_posture: 'observed_instance', accusation: `Request ${index} defers its acceptance signal.`, explanation: prose(big ? 1050 : 250), quotations: [message.text], locators: [{ message_indexes: [message.index] }], better_alternative: 'Define the acceptance signal before authorizing a change, and preserve the read-only boundary.', copyable_prompt: `For module ${index}, agree the acceptance check first; inspect read-only and draft notes without publishing.`, root_cause: `Deferred acceptance signal ${index}` })),
  strengths: messages.slice(0, big ? 3 : 1).map((message, index) => ({ habit: `Request ${index} preserves an approval gate.`, explanation: prose(big ? 500 : 200), quotations: [message.text], locators: [{ message_indexes: [message.index] }] })),
  workflow_evidence: messages.slice(0, big ? 2 : 1).map((message, index) => ({ description: 'A neutral multi-step review request; not execution evidence.', task_boundary: `Module review ${index}; independence requires context.`, quotations: [message.text], locators: [{ message_indexes: [message.index] }] })),
  assessment_context: { status: 'assessed', summary: 'Approval and read-only limits are explicit; these observations do not assert implementation began.' }
});
const normalized = (id, big = true) => {
  const messages = Array.from({ length: big ? 8 : 2 }, (_, i) => ({ index: i + 1, role: 'user', text: text(i) }));
  return { ...validateSessionAuditResult(observations(messages, big), { opaqueId: id, messages }), id, source: 'claude', facet: { underlyingGoal: 'Bounded module reviews', briefSummary: 'Review requests with explicit permission gates.' } };
};
const aggregate = (carry = {}) => ({ top_three: (carry.findings ?? []).slice(0, 3), remaining: (carry.findings ?? []).slice(3), strengths: carry.strengths ?? [], workflow_evidence: carry.workflowEvidence ?? [], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: [], assessment_context: carry.assessmentContext ?? { status: 'unknown', summary: null } });
const payload = (task) => JSON.parse(task.request.prompt.match(/<audit-data>\n([^]*?)\n<\/audit-data>/)[1]);
const extend = (carry, task) => {
  const current = payload(task).sessions;
  return {
    summary: 'Preserve the observed requests, their permission gates, and original support. No execution claim is established.',
    findings: collapseByRootCause([...(carry?.findings ?? []), ...current.flatMap((item) => item.findings)]),
    strengths: collapseByIntent([...(carry?.strengths ?? []), ...current.flatMap((item) => item.strengths)].map((item) => ({ ...item, intent: item.habit }))),
    workflowEvidence: [...new Map([...(carry?.workflowEvidence ?? []), ...current.flatMap((item) => item.workflow_evidence)].map((item) => [JSON.stringify(item), item])).values()]
  };
};

async function preparedAudit(count = 2, big = true) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-audit-aggregate-'));
  const candidates = [];
  for (let index = 0; index < count; index += 1) {
    const path = join(home, `session-${index}.jsonl`);
    await writeFile(path, Array.from({ length: big ? 8 : 2 }, (_, i) => ({ type: 'user', sessionId: `audit-budget-${index}`, timestamp: `2026-07-01T09:${String(i).padStart(2, '0')}:00Z`, message: { role: 'user', content: text(i) } })).map(JSON.stringify).join('\n'));
    candidates.push({ source: 'claude', locator: { kind: 'file', path } });
  }
  const runsRoot = join(home, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: Infinity }, candidates, analyzer: { host: 'claude', model: 'test' } });
  const context = { runsRoot, runId: prepared.id };
  const run = await getSemanticRun(context);
  // Baseline isolation: all source projections and audit ingests remain real.
  for (const session of run.sessions) { session.status = 'complete'; session.facet = normalized(session.id, big).facet; }
  run.sections = Object.fromEntries(AGGREGATE_TASKS.map((key) => [key, {}]));
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  let task = await nextSemanticTask(context);
  while (task.kind === 'session_audit') {
    await ingestSemanticResult({ ...context, taskId: task.id, result: observations(task.input.messages.filter((item) => item.role === 'user'), big) });
    task = await nextSemanticTask(context);
  }
  return { context, prepared, home, task };
}

function contextFrom(run) {
  return { sessions: run.sessions.map((session) => ({ ...run.extensions.userAudit.sessions[session.id], id: session.id, facet: session.facet, source: session.source })) };
}

test('large session fragments preserve complete records/context while future excerpts stay unexposed', () => {
  const source = normalized('s');
  const units = auditAggregateUnits([source]);
  const first = materializeAuditAggregateUnits({ sessions: [source] }, units.slice(0, 1));
  const second = materializeAuditAggregateUnits({ sessions: [source] }, units.slice(1, 2));
  assert.equal(first[0].id, second[0].id);
  assert.equal(first[0].assessmentContext.summary, source.assessmentContext.summary);
  const context = { sessions: [source] };
  assert.throws(() => validateAuditAggregateChunkResult({ summary: 'Do not open a later request.', findings: [source.findings[1]] }, auditAggregateEvidenceContext(context, first)), /fabricated quotation/);
  const carry = validateAuditAggregateChunkResult({ summary: 'First request support.', findings: [source.findings[0]] }, auditAggregateEvidenceContext(context, first));
  const both = validateAuditAggregateChunkResult({ summary: 'Both request observations.', findings: [source.findings[0], source.findings[1]] }, auditAggregateEvidenceContext(context, second, carry));
  assert.equal(both.findings.length, 2, 'Current fragment must not replace old proof from the same session.');
  assert.equal(new Set(both.findings.flatMap((item) => item.locators.map((locator) => locator.sessionId))).size, 1);
  const groups = splitAuditSessions([source]);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flatMap((group) => group.flatMap((item) => item.findings)), source.findings);
  assert.deepEqual(groups.flatMap((group) => group.flatMap((item) => item.strengths)), source.strengths);
  assert.deepEqual(groups.flatMap((group) => group.flatMap((item) => item.workflowEvidence)), source.workflowEvidence);
});

test('two fragments of one original message merge only exposed quotations and count one session/message', () => {
  const early = 'First inspect this module read-only.';
  const late = 'Only draft review notes; do not publish.';
  const middle = 'NEVER_EXPOSE_THIS_MIDDLE';
  const source = normalized('same');
  const base = source.findings[0];
  const messages = [{ index: 1, role: 'user', text: `${early}${' neutral context'.repeat(200)}${middle}${' context'.repeat(100)}${late}` }];
  const audit = { ...validateSessionAuditResult({ findings: [
    { ...base, quotations: [early], locators: [{ message_indexes: [1] }] },
    { ...base, quotations: [late], locators: [{ message_indexes: [1] }], rootCause: 'Separate publication boundary observation' }
  ], strengths: [] }, { opaqueId: 'same', messages }), id: 'same' };
  const context = { sessions: [audit] }, units = auditAggregateUnits(context.sessions);
  const first = materializeAuditAggregateUnits(context, units.slice(0, 1));
  const second = materializeAuditAggregateUnits(context, units.slice(1, 2));
  assert.throws(() => validateAuditAggregateChunkResult({ summary: 'Future tail is not exposed.', findings: [audit.findings[1]] }, auditAggregateEvidenceContext(context, first)), /fabricated quotation/);
  const carry = validateAuditAggregateChunkResult({ summary: 'Earlier proof retained.', findings: [audit.findings[0]] }, auditAggregateEvidenceContext(context, first));
  const both = auditAggregateEvidenceContext(context, second, carry);
  const merged = validateAuditAggregateChunkResult({ summary: 'Two excerpts, one source.', findings: [{ ...base, quotations: [early, late], locators: [{ session_id: 'same', message_indexes: [1] }] }] }, both);
  assert.equal(merged.findings[0].evidenceMessageCount, 1);
  assert.equal(merged.findings[0].evidenceSessionCount, 1);
  assert.throws(() => validateAuditAggregateChunkResult({ summary: 'No source reopening.', findings: [{ ...base, quotations: [middle], locators: [{ session_id: 'same', message_indexes: [1] }] }] }, both), /fabricated quotation/);
});

test('two legal large audits finish through frozen adaptive batches with no evidence or source-text loss', async () => {
  const { context, prepared, home, task: first } = await preparedAudit();
  let task = first;
  assert.equal(task.kind, 'audit_aggregate_chunk');
  let carry = null;
  let chunks = 0;
  while (task.kind === 'audit_aggregate_chunk') {
    assert.ok(task.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), task);
    assert.equal(await semanticSubmissionForTask({ ...context, taskId: task.id }), task.submissionPath);
    carry = await ingestSemanticResult({ ...context, taskId: task.id, result: extend(carry, task) });
    chunks += 1;
    task = await nextSemanticTask(context);
  }
  assert.ok(chunks > 1);
  assert.equal(task.kind, 'audit_aggregate');
  const run = await getSemanticRun(context);
  assert.ok(run.extensions.userAudit.aggregatePlan.batches.length > 1);
  const planText = JSON.stringify(run.extensions.userAudit.aggregatePlan);
  assert.doesNotMatch(planText, /explanation|quotations|request authorizes/);
  assert.ok(run.extensions.userAudit.aggregatePlan.units.every((unit) => Object.keys(unit).sort().join(',') === 'field,index,sessionId'));
  const result = await ingestSemanticResult({ ...context, taskId: task.id, result: aggregate(carry) });
  assert.equal(result.topThree.length + result.remaining.length, 6);
  assert.ok([...result.topThree, ...result.remaining].every((finding) => finding.evidenceSessionCount === 2));
  assert.equal(result.strengths.length, 3);
  assert.equal(result.workflowEvidence.length, 4);
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const final = await finalizeSemanticRun({ ...context, outputDirectory: join(home, 'report') });
  assert.equal(final.report.extensions.userAudit.status, 'complete');
  assert.equal(final.report.coverage.eligibility.eligible, 2);
  assert.equal((await readFile(prepared.manifestPath, 'utf8')).includes('raw transcript'), false);
});

test('moderate legal carry shrinks the next batch instead of failing the entire extension', async () => {
  const { context, task: first } = await preparedAudit(6, false);
  const sessions = payload(first).sessions;
  const largeCarry = { summary: prose(1700), findings: sessions.flatMap((session) => session.findings).map((finding, index) => ({ ...finding, explanation: index < 4 ? prose(1800) : finding.explanation })), strengths: sessions.flatMap((session) => session.strengths).slice(0, 2).map((strength) => ({ ...strength, explanation: prose(1300) })), workflowEvidence: sessions.flatMap((session) => session.workflow_evidence).slice(0, 2) };
  let carry = await ingestSemanticResult({ ...context, taskId: first.id, result: largeCarry });
  let task = await nextSemanticTask(context);
  assert.equal(task.kind, 'audit_aggregate_chunk');
  assert.ok(task.request.prompt.length <= 30_000);
  assert.deepEqual(await nextSemanticTask(context), task);
  const run = await getSemanticRun(context), all = contextFrom(run), plan = run.extensions.userAudit.aggregatePlan;
  const batch = plan.batches[1];
  const maximal = materializeAuditAggregateUnits(all, plan.units.slice(batch.start));
  assert.ok(createAuditAggregateChunkRequest(all, maximal, 1, null, carry).prompt.length > 30_000, 'The previous carry really requires dynamic reduction.');
  while (task.kind === 'audit_aggregate_chunk') {
    carry = await ingestSemanticResult({ ...context, taskId: task.id, result: extend(carry, task) });
    task = await nextSemanticTask(context);
  }
  assert.equal(task.kind, 'audit_aggregate');
  await ingestSemanticResult({ ...context, taskId: task.id, result: aggregate(carry) });
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
});

test('irreducible carry fails explicitly, retains accepted proof, and still permits finalization', async () => {
  const { context, home, task } = await preparedAudit();
  const first = payload(task).sessions.flatMap((item) => item.findings)[0];
  const accepted = await ingestSemanticResult({ ...context, taskId: task.id, result: { summary: 'Oversized but schema-valid carry.', findings: Array.from({ length: 20 }, (_, index) => ({ ...first, rootCause: `Distinct model interpretation ${index}`, explanation: prose(2000) })) } });
  assert.equal(accepted.findings.length, 20);
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const run = await getSemanticRun(context);
  assert.equal(run.extensionFailures.userAudit.reason, 'safety_limit');
  assert.equal(run.extensions.userAudit.aggregateChunks[0].findings.length, 20);
  const final = await finalizeSemanticRun({ ...context, outputDirectory: join(home, 'report') });
  assert.equal(final.report.extensions.userAudit.status, 'incomplete');
});

test('an irreducible metadata envelope records a visible audit safety failure without an endless pending task', async () => {
  const { context, prepared, home } = await preparedAudit();
  const run = await getSemanticRun(context);
  // Public synthetic checkpoint with metadata that cannot fit even around one
  // evidence record; no source text is enlarged, sliced, or silently dropped.
  run.activeTask = null;
  delete run.extensions.userAudit.aggregatePlan;
  run.sessions[0].projectPath = `/synthetic/${'long-project-component/'.repeat(1600)}`;
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const failed = await getSemanticRun(context);
  assert.equal(failed.extensionFailures.userAudit.reason, 'safety_limit');
  assert.equal(Object.keys(failed.extensions.userAudit.sessions).length, 2);
  assert.equal(failed.extensions.userAudit.aggregateChunks.length, 0);
  const final = await finalizeSemanticRun({ ...context, outputDirectory: join(home, 'report') });
  assert.equal(final.report.extensions.userAudit.status, 'incomplete');
});

test('a frozen planned audit batch can be explicitly failed without changing its exposure or losing the plan', async () => {
  const { context, task } = await preparedAudit();
  assert.deepEqual(await nextSemanticTask(context), task);
  await failSemanticTask({ ...context, taskId: task.id, reason: 'analyzer_failure' });
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const run = await getSemanticRun(context);
  assert.equal(run.extensionFailures.userAudit.reason, 'analyzer_failure');
  assert.equal(run.extensions.userAudit.aggregatePlan.batches.length, 1);
  assert.equal(Object.keys(run.extensions.userAudit.sessions).length, 2);
});

test('pre-planning baseline checkpoint keeps legacy group identity and exact resumed prompt', async () => {
  const { context, prepared } = await preparedAudit(2, false);
  const run = await getSemanticRun(context);
  delete run.aggregatePlanningVersion;
  run.activeTask = null;
  delete run.aggregateBatch;
  run.sections = {};
  // A legal old session facet with enough evidence prose to force aggregation.
  for (const session of run.sessions) session.facet.briefSummary = prose(8000);
  const sessions = run.sessions.map((session) => ({ ...session, sessionId: session.sessionId ?? session.id }));
  const oldGroups = legacySplitAggregateSessions(sessions);
  assert.ok(oldGroups.length > 1);
  run.activeTask = { id: 'aggregate-chunk:project_areas:0', exposedAt: '2026-07-01T10:00:00Z' };
  await writeFile(prepared.manifestPath, JSON.stringify(run));
  const resumed = await nextSemanticTask(context);
  assert.equal(resumed.kind, 'aggregate_chunk');
  assert.equal(resumed.request.prompt.includes('session_fragment'), false);
  assert.equal(resumed.request.prompt.includes('metrics_in_fragments'), false);
  assert.deepEqual(await nextSemanticTask(context), resumed);
});

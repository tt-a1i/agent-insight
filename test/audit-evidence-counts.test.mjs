import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditAggregateEvidenceContext, impactScore, validateAuditAggregateChunkResult,
  validateAuditAggregateResult, validateSessionAuditChunkResult, validateSessionAuditResult
} from '../src/audit-protocol.mjs';

const quote = 'Review the parser without editing files.';
const second = 'Check the focused regression before closing.';
const finding = (overrides = {}) => ({
  category: 'goal_clarity', severity: 'high', evidence_posture: 'observed_instance',
  accusation: 'This request may need a clearer completion signal.',
  explanation: 'This is a model interpretation of the quoted request, not a verified behavioral frequency.',
  quotations: [quote], locators: [{ message_indexes: [1] }], occurrence_count: 1,
  better_alternative: 'State the check that ends the review.',
  copyable_prompt: 'Review the parser only and finish with the focused regression result.',
  root_cause: 'a completion signal may be absent', ...overrides
});
const aggregate = (topThree, overrides = {}) => ({
  top_three: topThree, remaining: [], strengths: [], self_defeating_patterns: [],
  highest_leverage_change: null, automation_candidates: [], ...overrides
});
const user = (index, text) => ({ index, role: 'user', text });
const sessionInput = { opaqueId: 'a', messages: [user(1, quote), user(2, 'An unrelated request.')] };
const sessions = [
  { id: 'a', sessionId: 'source-a', userMessages: [user(1, quote), user(2, second)] },
  { id: 'b', userMessages: [user(2, 'An unrelated request.')] },
  { id: 'c', userMessages: [], userMessageIndexes: [3] }
];

for (const [name, validate] of [['session', validateSessionAuditResult], ['session chunk', validateSessionAuditChunkResult]]) {
  test(`${name} rejects extra cited messages without a matching quotation`, () => {
    const raw = { summary: 'An unsupported expanded claim.', findings: [finding({
      evidence_posture: 'established_pattern', locators: [{ message_indexes: [1, 2] }], occurrence_count: 2
    })] };
    assert.throws(() => validate(raw, sessionInput), /matching quotation for every cited user message/);
  });
}

for (const stage of ['aggregate chunk', 'final aggregate', 'aggregate carry']) {
  test(`${stage} rejects unrelated and bare-index locators used to inflate quotation coverage`, () => {
    const unsupported = finding({
      evidence_posture: 'established_pattern', occurrence_count: 3,
      locators: [{ session_id: 'a', message_indexes: [1] }, { session_id: 'b', message_indexes: [2] }, { session_id: 'c', message_indexes: [3] }]
    });
    const context = stage === 'aggregate carry'
      ? auditAggregateEvidenceContext({ sessions }, [], { findings: [{ ...unsupported, locators: unsupported.locators.map(({ session_id, message_indexes }) => ({ sessionId: session_id, messageIndexes: message_indexes })) }] })
      : { sessions };
    const validate = stage === 'aggregate chunk'
      ? () => validateAuditAggregateChunkResult({ summary: 'Expanded evidence.', findings: [unsupported] }, context)
      : () => validateAuditAggregateResult(aggregate([unsupported]), context);
    assert.throws(validate, /matching quotation for every cited user message/);
  });
}

test('canonical aliases, repeated locators and fragments of one message cannot multiply coverage', () => {
  const context = { sessions: [{ ...sessions[0], userMessages: [user(1, quote), user(1, second)] }] };
  const raw = finding({
    quotations: [quote, second], evidence_message_count: 999, evidenceSessionCount: 999,
    locators: [{ session_id: 'a', message_indexes: [1, 1] }, { session_id: 'source-a', message_indexes: [1] }]
  });
  const result = validateAuditAggregateResult(aggregate([raw]), context).topThree[0];
  assert.deepEqual(result.locators, [{ sessionId: 'a', messageIndexes: [1] }]);
  assert.equal(result.evidenceMessageCount, 1);
  assert.equal(result.evidenceSessionCount, 1);
  assert.equal(result.occurrenceCount, null);
  assert.throws(() => validateAuditAggregateResult(aggregate([{ ...raw, evidence_posture: 'established_pattern' }]), context), /at least two distinct quoted user messages/);
});

test('established patterns require two quoted user messages and retain the actual session coverage', () => {
  const raw = finding({ evidence_posture: 'established_pattern', quotations: [quote, second], locators: [{ message_indexes: [1, 2] }], occurrence_count: 2 });
  const result = validateSessionAuditResult({ findings: [raw] }, { opaqueId: 'a', messages: sessions[0].userMessages }).findings[0];
  assert.equal(result.evidenceMessageCount, 2);
  assert.equal(result.evidenceSessionCount, 1);
  assert.equal(result.occurrenceCount, null);
  const singleton = finding({ evidence_posture: 'established_pattern' });
  assert.throws(() => validateSessionAuditResult({ findings: [singleton] }, sessionInput), /use observed_instance or bold_inference/);
  for (const posture of ['observed_instance', 'bold_inference']) {
    assert.equal(validateSessionAuditResult({ findings: [finding({ evidence_posture: posture })] }, sessionInput).findings[0].evidenceMessageCount, 1);
  }
});

test('self-defeating patterns also require repeated separately quoted messages', () => {
  const pattern = { pattern: 'A recurring request shape.', intent: 'request shape', explanation: 'This remains an interpretation of the cited messages.', quotations: [quote], locators: [{ session_id: 'a', message_indexes: [1] }] };
  assert.throws(() => validateAuditAggregateResult(aggregate([], { self_defeating_patterns: [pattern] }), { sessions }), /at least two distinct quoted user messages/);
  const result = validateAuditAggregateResult(aggregate([], { self_defeating_patterns: [{ ...pattern, quotations: [quote, second], locators: [{ session_id: 'a', message_indexes: [1, 2] }] }] }), { sessions });
  assert.equal(result.selfDefeatingPatterns[0].evidenceMessageCount, 2);
  assert.equal(result.selfDefeatingPatterns[0].evidenceSessionCount, 1);
});

test('strength and recommendation counts cover only quoted genuine user messages', () => {
  const evidence = { quotations: [quote], locators: [{ session_id: 'a', message_indexes: [1] }] };
  const raw = aggregate([], {
    strengths: [{ habit: 'Names an execution boundary.', explanation: 'The literal request prohibits edits.', ...evidence }],
    highest_leverage_change: { change: 'Name a completion check.', rationale: 'This could clarify the endpoint.', copyable_prompt: 'Review only the parser; finish after the focused regression.', ...evidence }
  });
  const result = validateAuditAggregateResult(raw, { sessions });
  for (const item of [result.strengths[0], result.highestLeverageChange]) {
    assert.equal(item.evidenceMessageCount, 1);
    assert.equal(item.evidenceSessionCount, 1);
  }
  raw.strengths[0].locators.push({ session_id: 'c', message_indexes: [3] });
  assert.throws(() => validateAuditAggregateResult(raw, { sessions }), /matching quotation for every cited user message/);
});

test('severity wins over legacy occurrence counts and arbitrarily broad quotation coverage', () => {
  const context = { sessions: Array.from({ length: 20 }, (_, session) => ({
    id: `s${session}`, userMessages: Array.from({ length: 20 }, (_, index) => user(index + 1, quote))
  })) };
  const low = finding({ severity: 'low', evidence_posture: 'established_pattern', root_cause: 'low impact', occurrence_count: 400,
    locators: context.sessions.map(({ id }) => ({ session_id: id, message_indexes: Array.from({ length: 20 }, (_, i) => i + 1) })) });
  const critical = finding({ severity: 'critical', root_cause: 'critical impact', locators: [{ session_id: 's0', message_indexes: [1] }] });
  const result = validateAuditAggregateResult(aggregate([low, critical]), context);
  assert.equal(result.topThree[0].severity, 'critical');
  assert.equal(result.topThree[1].evidenceMessageCount, 400);
  assert.equal(result.topThree[1].occurrenceCount, null);
  assert.ok(impactScore({ severity: 'critical', occurrenceCount: 1 }) > impactScore({ severity: 'low', occurrenceCount: 400 }));
});

const automation = (quotations) => ({
  name: 'Review checklist', type: 'prompt_template', trigger: 'When reviewing a diff', inputs: ['diff'], outputs: ['checklist'],
  rationale: 'The cited requests describe a workflow.', over_automation_risk: 'Keep acceptance judgment explicit.',
  draft_body: 'Inspect the diff, run focused tests, and produce the checklist.', quotations,
  locators: [{ session_id: 'a', message_indexes: [1, 2] }]
});

test('punctuation quotations and excerpts of filler-only source messages cannot create automation', () => {
  const context = { sessions: [{ id: 'a', userMessages: [user(1, 'ok.'), user(2, 'yes.')] }] };
  for (const quotations of [['.'], ['o', 'y']]) {
    const result = validateAuditAggregateResult(aggregate([], { automation_candidates: [automation(quotations)] }), context);
    assert.deepEqual(result.automationCandidates, []);
  }
});

test('substantive Chinese and code workflow quotations remain eligible evidence', () => {
  for (const text of ['先读取差异，再运行测试，最后生成检查清单。', 'read_diff(); run_tests(); write_checklist();']) {
    const context = { sessions: [{ id: 'a', userMessages: [user(1, text), user(2, text)] }] };
    const result = validateAuditAggregateResult(aggregate([], { automation_candidates: [automation([text])] }), context).automationCandidates[0];
    assert.equal(result.evidenceMessageCount, 2);
    assert.equal(result.evidenceSessionCount, 1);
  }
});

test('Chinese absolute attribution is rejected for bold inference while explicit qualifications remain allowed', () => {
  for (const accusation of ['你总是在没有验收标准时下令。', '这次请求证明你从不先确定验收标准。', '这次请求不能证明别的，但这次请求证明你从不先确定验收标准。']) {
    assert.throws(() => validateSessionAuditResult({ findings: [finding({ evidence_posture: 'bold_inference', accusation })] }, sessionInput), /absolute certainty language/);
  }
  for (const accusation of ['你并不总是跳过验收；这次缺少一个完成信号。', '这次请求还不能证明你从不先确定验收标准。', '不能断言：你总是在没有验收标准时下令。', '如果你总是先写验收条件，后续沟通会更短。']) {
    assert.equal(validateSessionAuditResult({ findings: [finding({ evidence_posture: 'bold_inference', accusation })] }, sessionInput).findings.length, 1);
  }
});

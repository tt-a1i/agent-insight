import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditAggregateEvidenceContext, createAuditAggregateRequest, validateAuditAggregateChunkResult,
  validateAuditAggregateResult, validateSessionAuditResult
} from '../src/audit-protocol.mjs';

const user = (index, text, extra = {}) => ({ index, role: 'user', text, ...extra });
const strength = (indexes = [1, 2]) => ({
  habit: 'Confirms the next step.', explanation: 'The user gave short confirmations.',
  quotations: ['o', 'e'], locators: [{ session_id: 'a', message_indexes: indexes }],
  // Model-declared source qualification is ignored by the validator.
  sourceMessageEligibility: 'substantive'
});
const candidate = (indexes = [1, 2]) => ({
  name: 'Release checklist', type: 'Skill', trigger: 'Before releasing', inputs: ['diff'], outputs: ['review'],
  rationale: 'Repeated multi-step work.', over_automation_risk: 'Keep human approval.',
  draft_body: 'Inspect changes, run tests, then ask for release approval.',
  quotations: ['o', 'e'], locators: [{ session_id: 'a', message_indexes: indexes }],
  sourceMessageEligibility: 'substantive'
});
const final = (indexes) => ({
  top_three: [], remaining: [], strengths: [], self_defeating_patterns: [],
  highest_leverage_change: null, automation_candidates: [candidate(indexes)]
});

function carryStrength(context, indexes) {
  const chunk = validateAuditAggregateChunkResult({ summary: 'Prior quoted confirmations.', findings: [], strengths: [strength(indexes)] }, context);
  // A saved manifest/resume must retain the source fact without raw text.
  return JSON.parse(JSON.stringify(auditAggregateEvidenceContext(context, [], chunk)));
}

test('filler source qualification survives quoted aggregate strengths, repeated carry and JSON resume', () => {
  const original = { sessions: [{ id: 'a', sessionId: 'native-a', userMessages: [
    user(1, 'ok.', { sourceMessageEligibility: 'substantive' }), user(2, 'yes.', { sourceMessageEligibility: 'substantive' })
  ], userMessageIndexes: [1, 2] }] };
  assert.deepEqual(validateAuditAggregateResult(final(), original).automationCandidates, []);
  let carry = original;
  for (let index = 0; index < 3; index += 1) {
    carry = carryStrength(carry);
    assert.deepEqual(carry.sessions[0].userMessages.map(({ text }) => text), ['o', 'e']);
    assert.ok(carry.sessions[0].userMessages.every((message) => message.excerpt === true && message.sourceMessageEligibility === 'filler_only'));
    assert.deepEqual(validateAuditAggregateResult(final(), carry).automationCandidates, []);
  }
  const prompt = createAuditAggregateRequest(carry).prompt;
  assert.equal(prompt.includes('sourceMessageEligibility'), false);
  assert.equal(prompt.includes('ok.'), false);
  assert.equal(prompt.includes('yes.'), false);
});

test('late source filler facts survive representative excerpt storage through session and aggregate finalization', () => {
  const messages = [
    ...Array.from({ length: 8 }, (_, index) => user(index + 1, `A bounded earlier request ${index}.`)),
    user(9, 'ok.'), user(10, 'yes.')
  ];
  const normalized = validateSessionAuditResult({ findings: [], strengths: [{ ...strength([9, 10]), locators: [{ message_indexes: [9, 10] }] }] }, { opaqueId: 'a', messages });
  const retained = normalized.userMessages.filter(({ index }) => index >= 9);
  assert.deepEqual(retained.map(({ text }) => text), ['o', 'e']);
  assert.ok(retained.every(({ sourceMessageEligibility, excerpt }) => sourceMessageEligibility === 'filler_only' && excerpt === true));
  // Re-normalizing already bounded evidence must not promote its sample to a
  // complete source message just because no further shortening was needed.
  const normalizedAgain = validateSessionAuditResult({ findings: [], strengths: [{ ...strength([9, 10]), locators: [{ message_indexes: [9, 10] }] }] }, { opaqueId: 'a', messages: retained });
  const context = { sessions: [{ ...JSON.parse(JSON.stringify(normalizedAgain)), id: 'a' }] };
  assert.deepEqual(validateAuditAggregateResult(final([9, 10]), carryStrength(carryStrength(context, [9, 10]), [9, 10])).automationCandidates, []);
});

test('unqualified excerpts cannot establish substantive source eligibility', () => {
  const context = { sessions: [{ id: 'a', userMessages: [user(1, 'o', { excerpt: true }), user(2, 'e', { excerpt: true })] }] };
  assert.throws(() => validateAuditAggregateResult(final(), context), /requires verified substantive source user messages/);
  const carry = carryStrength(context);
  assert.ok(carry.sessions[0].userMessages.every(({ sourceMessageEligibility }) => sourceMessageEligibility === 'unknown'));
  assert.throws(() => validateAuditAggregateResult(final(), carry), /requires verified substantive source user messages/);
});

test('substantive source workflows remain eligible after only quoted excerpts survive', () => {
  const messages = [
    ...Array.from({ length: 8 }, (_, index) => user(index + 1, `An earlier request ${index}.`)),
    user(9, 'Open the diff, run tests, then post a review checklist.'),
    user(10, 'Open the diff, run tests, then post a review checklist.')
  ];
  const normalized = validateSessionAuditResult({ findings: [], strengths: [{ ...strength([9, 10]), locators: [{ message_indexes: [9, 10] }] }] }, { opaqueId: 'a', messages });
  const context = { sessions: [{ ...JSON.parse(JSON.stringify(normalized)), id: 'a' }] };
  const carry = carryStrength(carryStrength(context, [9, 10]), [9, 10]);
  assert.ok(carry.sessions[0].userMessages.every(({ text }) => ['o', 'e'].includes(text)));
  assert.ok(carry.sessions[0].userMessages.every(({ sourceMessageEligibility }) => sourceMessageEligibility === 'substantive'));
  assert.equal(validateAuditAggregateResult(final([9, 10]), carry).automationCandidates.length, 1);
});

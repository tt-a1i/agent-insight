import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAuditAggregateResult } from '../src/audit-protocol.mjs';

const messages = (id) => [
  { index: 1, role: 'user', text: `Session ${id}: implement the change; acceptance will be specified later.` },
  { index: 2, role: 'user', text: `Session ${id}: continue before defining the acceptance gate.` }
];
const sessions = Array.from({ length: 8 }, (_, index) => ({ id: `s${index}`, userMessages: messages(`s${index}`) }));
const finding = (id, extra = {}) => ({
  category: 'acceptance_criteria', severity: 'medium', evidence_posture: 'established_pattern',
  accusation: 'Acceptance follows implementation requests.', explanation: 'Two requests omit the acceptance gate.',
  quotations: messages(id).map((item) => item.text), locators: [{ session_id: id, message_indexes: [1, 2] }],
  better_alternative: 'Define acceptance before authorizing edits.', copyable_prompt: 'Establish the acceptance test before editing.',
  root_cause: 'late acceptance definition', ...extra
});
const pattern = (id, extra = {}) => ({
  pattern: 'Acceptance follows authorization.', intent: 'late acceptance definition', explanation: 'Acceptance criteria arrive after implementation requests.',
  quotations: messages(id).map((item) => item.text), locators: [{ session_id: id, message_indexes: [1, 2] }], ...extra
});
const aggregate = (extra = {}) => ({ top_three: [], remaining: [], strengths: [], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: [], ...extra });

test('same-root findings and same-intent patterns retain all cross-session support on one card', () => {
  const result = validateAuditAggregateResult(aggregate({ top_three: [finding('s0')], remaining: [finding('s1')], self_defeating_patterns: [pattern('s0'), pattern('s1')] }), { sessions });
  for (const items of [result.topThree, result.selfDefeatingPatterns]) {
    assert.equal(items.length, 1);
    assert.equal(items[0].evidenceMessageCount, 4);
    assert.equal(items[0].evidenceSessionCount, 2);
    assert.equal(items[0].quotations.length, 4);
    assert.deepEqual(items[0].locators.map((item) => item.sessionId), ['s0', 's1']);
  }
  assert.deepEqual(result.remaining, []);
  assert.equal(result.topThree[0].severity, 'medium');
  assert.equal(result.topThree[0].evidencePosture, 'established_pattern');
  assert.equal(result.topThree[0].occurrenceCount, null);
});

test('merged support can exceed model per-item limits without losing references or duplicating cards', () => {
  const result = validateAuditAggregateResult(aggregate({ top_three: [finding('s0')], remaining: sessions.slice(1).map((item) => finding(item.id)), self_defeating_patterns: sessions.map((item) => pattern(item.id)) }), { sessions });
  assert.equal(result.topThree.length, 1);
  assert.equal(result.topThree[0].quotations.length, 16);
  assert.equal(result.topThree[0].evidenceMessageCount, 16);
  assert.equal(result.topThree[0].evidenceSessionCount, 8);
  assert.equal(result.selfDefeatingPatterns.length, 1);
  assert.equal(result.selfDefeatingPatterns[0].quotations.length, 16);
  assert.deepEqual(result.remaining, []);
  assert.throws(() => validateAuditAggregateResult(aggregate({ remaining: Array.from({ length: 101 }, () => finding('s0')) }), { sessions }), /at most one hundred/);
});

test('overlapping quotations and locators count unique supporting messages without posture or severity promotion', () => {
  const first = finding('s0', { evidence_posture: 'bold_inference', severity: 'low' });
  const repeated = finding('s0', { evidence_posture: 'established_pattern', severity: 'low', locators: [{ session_id: 's0', message_indexes: [2, 1] }, { session_id: 's0', message_indexes: [1] }] });
  const result = validateAuditAggregateResult(aggregate({ top_three: [first, repeated], remaining: [finding('s1', { severity: 'low' })], self_defeating_patterns: [pattern('s0'), pattern('s0'), pattern('s1')] }), { sessions });
  assert.equal(result.topThree[0].evidenceMessageCount, 4);
  assert.equal(result.topThree[0].evidenceSessionCount, 2);
  assert.equal(result.topThree[0].evidencePosture, 'bold_inference', 'More support does not upgrade a qualified interpretation.');
  assert.equal(result.topThree[0].severity, 'low');
  assert.equal(result.topThree[0].occurrenceCount, null);
  assert.deepEqual(result.topThree[0].locators[0].messageIndexes, [1, 2]);
  assert.equal(result.selfDefeatingPatterns[0].evidenceMessageCount, 4);
});

test('model-owned distinct roots and intents stay separate even with matching words or conflicting advice', () => {
  const result = validateAuditAggregateResult(aggregate({
    top_three: [finding('s0', { root_cause: 'missing acceptance gate' }), finding('s1', { root_cause: 'overly rigid acceptance gate', accusation: 'Scope may have become too rigid.', explanation: 'This is a distinct qualified interpretation.', evidence_posture: 'bold_inference', better_alternative: 'Revisit the acceptance gate when new evidence changes the goal.' })],
    self_defeating_patterns: [pattern('s0', { intent: 'missing gate' }), pattern('s1', { intent: 'rigid gate' })]
  }), { sessions });
  assert.equal(result.topThree.length, 2);
  assert.equal(result.selfDefeatingPatterns.length, 2);
  assert.equal(result.topThree.every((item) => item.evidenceSessionCount === 1), true);
});

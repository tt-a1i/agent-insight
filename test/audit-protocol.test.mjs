import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuditAggregateRequest,
  createSessionAuditRequest,
  validateAuditAggregateResult,
  validateSessionAuditResult
} from '../src/audit-protocol.mjs';

const userText = 'Just fix everything and make it good somehow.';
const input = {
  source: 'claude',
  opaqueId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  sessionId: 'session-a',
  date: '2026-07-01',
  projectPath: '/work/parser',
  projectLabel: 'parser',
  messages: [
    { index: 1, role: 'user', text: userText },
    { index: 2, role: 'assistant', text: 'Working on it.' },
    { index: 3, role: 'user', text: 'Also check the other stuff too.' }
  ]
};

function validFinding(overrides = {}) {
  return {
    category: 'vague_broad_commands',
    severity: 'high',
    evidence_posture: 'established_pattern',
    accusation: 'You outsource taste to vibes.',
    explanation: 'Broad commands replace concrete decisions about scope and done.',
    quotations: [userText],
    locators: [{ message_indexes: [1] }],
    occurrence_count: 1,
    better_alternative: 'Name the files, acceptance checks, and non-goals before asking for a fix.',
    root_cause: 'vague authorization without criteria',
    ...overrides
  };
}

test('session audit accepts grounded findings across the fixed taxonomy and freeform', () => {
  const request = createSessionAuditRequest(input);
  assert.equal(request.task, 'session_audit');
  assert.match(request.prompt, /goal_clarity/);
  assert.match(request.prompt, /freeform/);
  assert.match(request.prompt, /Just fix everything/);

  const result = validateSessionAuditResult({
    findings: [
      validFinding(),
      validFinding({
        category: 'freeform',
        severity: 'medium',
        evidence_posture: 'bold_inference',
        accusation: 'You may be stacking open loops.',
        explanation: 'A second broad ask lands before the first one had a finish line.',
        quotations: ['Also check the other stuff too.'],
        locators: [{ message_indexes: [3] }],
        occurrence_count: null,
        root_cause: 'stacked open loops'
      })
    ]
  }, input);

  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].evidencePosture, 'established_pattern');
  assert.equal(result.findings[1].category, 'freeform');
});

test('session audit rejects fabricated quotations, unknown locators, unsupported counts, disguised certainty, and medical judgments', () => {
  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({ quotations: ['this quote was never said'] })]
  }, input), /fabricated quotation/);

  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({ locators: [{ message_indexes: [99] }] })]
  }, input), /unknown message index/);

  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({ occurrence_count: 9, locators: [{ message_indexes: [1] }] })]
  }, input), /unsupported for the provided evidence/);

  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({
      evidence_posture: 'bold_inference',
      accusation: 'You always dodge decisions.',
      explanation: 'This certainly proves chronic avoidance.'
    })]
  }, input), /absolute certainty language/);

  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({
      accusation: 'Your ADHD makes prompts messy.',
      explanation: 'This looks like an attention disorder pattern.'
    })]
  }, input), /medical, intelligence, moral/);
});

test('audit aggregate collapses duplicate root causes, keeps top three, and severity-orders the rest', () => {
  const sessions = [{
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'session-a',
    findings: [validFinding()]
  }, {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    sessionId: 'session-b',
    findings: []
  }];
  const request = createAuditAggregateRequest({ sessions });
  assert.equal(request.task, 'audit_aggregate');

  const finding = (overrides) => ({
    ...validFinding({
      quotations: [userText],
      locators: [{ session_id: 'session-a', message_indexes: [1] }],
      occurrence_count: 1
    }),
    ...overrides
  });

  const result = validateAuditAggregateResult({
    top_three: [
      finding({ severity: 'critical', root_cause: 'vague authorization without criteria', accusation: 'Vibes-driven shipping.' }),
      finding({ severity: 'high', category: 'acceptance_criteria', root_cause: 'no done definition', accusation: 'Done is undefined.' }),
      finding({ severity: 'medium', category: 'over_control', root_cause: 'micromanaged diffs', accusation: 'You pilot every keystroke.' })
    ],
    remaining: [
      finding({ severity: 'critical', root_cause: 'vague authorization without criteria', accusation: 'Same vague habit again.' }),
      finding({ severity: 'low', category: 'phase_confusion', root_cause: 'mixed explore and ship', accusation: 'Exploration wears a shipping hat.' }),
      finding({ severity: 'high', category: 'direction_churn', root_cause: 'moving target', accusation: 'The north star relocates hourly.' })
    ]
  }, { sessions });

  assert.equal(result.topThree.length, 3);
  assert.equal(result.topThree[0].rootCause, 'vague authorization without criteria');
  assert.equal(result.topThree[0].accusation, 'Vibes-driven shipping.');
  assert.deepEqual(result.remaining.map((item) => item.severity), ['medium', 'low']);
  assert.equal(result.remaining.some((item) => item.rootCause === 'vague authorization without criteria'), false);
});

test('audit aggregate rejects unknown session locators', () => {
  assert.throws(() => validateAuditAggregateResult({
    top_three: [validFinding({
      locators: [{ session_id: 'missing-session', message_indexes: [1] }],
      quotations: [userText]
    })],
    remaining: []
  }, { sessions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', sessionId: 'session-a', findings: [] }] }), /unknown session/);
});

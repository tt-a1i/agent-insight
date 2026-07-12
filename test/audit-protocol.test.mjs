import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAuditAggregateRequest,
  createSessionAuditRequest,
  validateAuditAggregateResult,
  validateSessionAuditResult
} from '../src/audit-protocol.mjs';

const userText = 'Just fix everything and make it good somehow.';
const regressionText = 'Also check the other stuff too.';
const workflowText = 'Run the migration, update the docs, then open the PR with the checklist.';
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
    { index: 3, role: 'user', text: regressionText },
    { index: 4, role: 'user', text: workflowText },
    { index: 5, role: 'user', text: '继续' },
    { index: 6, role: 'user', text: '可以' },
    { index: 7, role: 'user', text: 'ok' }
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

function aggregateFinding(overrides = {}) {
  return {
    ...validFinding({
      quotations: [userText],
      locators: [{ session_id: 'session-a', message_indexes: [1] }],
      occurrence_count: 1
    }),
    ...overrides
  };
}

function extensionFields(overrides = {}) {
  return {
    strengths: [{
      habit: 'You ask for a regression gate after the first repair.',
      explanation: 'The follow-up hardens the win instead of declaring victory on vibes.',
      quotations: [regressionText],
      locators: [{ session_id: 'session-a', message_indexes: [3] }]
    }],
    self_defeating_patterns: [{
      pattern: 'Just fix everything somehow',
      intent: 'vague authorization without criteria',
      explanation: 'Broad permission replaces the missing done definition.',
      quotations: [userText],
      locators: [{ session_id: 'session-a', message_indexes: [1] }]
    }],
    highest_leverage_change: {
      change: 'State the acceptance check before authorizing edits.',
      rationale: 'One concrete done line collapses the vague-authorization habit.'
    },
    automation_candidates: [{
      name: 'ship-checklist',
      type: 'Skill',
      trigger: 'After code is ready to land',
      frequency: 'Repeated across release sessions',
      inputs: ['changed files', 'test command'],
      outputs: ['docs update', 'PR body with checklist'],
      rationale: 'The migrate-docs-PR sequence repeats as one multi-step workflow.',
      over_automation_risk: 'Would hide judgment when the release path actually needs a human gate.'
    }],
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
        quotations: [regressionText],
        locators: [{ message_indexes: [3] }],
        occurrence_count: null,
        root_cause: 'stacked open loops'
      })
    ]
  }, input);

  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].evidencePosture, 'established_pattern');
  assert.equal(result.findings[1].category, 'freeform');
  assert.deepEqual(result.userTexts, [userText, regressionText, workflowText, '继续', '可以', 'ok']);
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
    userTexts: [userText, regressionText, workflowText, '继续', '可以', 'ok'],
    findings: [validFinding()]
  }, {
    id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
    sessionId: 'session-b',
    findings: []
  }];
  const request = createAuditAggregateRequest({ sessions });
  assert.equal(request.task, 'audit_aggregate');
  assert.match(request.prompt, /strengths/);
  assert.match(request.prompt, /automation_candidates/);
  assert.match(request.prompt, /highest_leverage_change/);

  const result = validateAuditAggregateResult({
    top_three: [
      aggregateFinding({ severity: 'critical', root_cause: 'vague authorization without criteria', accusation: 'Vibes-driven shipping.' }),
      aggregateFinding({ severity: 'high', category: 'acceptance_criteria', root_cause: 'no done definition', accusation: 'Done is undefined.' }),
      aggregateFinding({ severity: 'medium', category: 'over_control', root_cause: 'micromanaged diffs', accusation: 'You pilot every keystroke.' })
    ],
    remaining: [
      aggregateFinding({ severity: 'critical', root_cause: 'vague authorization without criteria', accusation: 'Same vague habit again.' }),
      aggregateFinding({ severity: 'low', category: 'phase_confusion', root_cause: 'mixed explore and ship', accusation: 'Exploration wears a shipping hat.' }),
      aggregateFinding({ severity: 'high', category: 'direction_churn', root_cause: 'moving target', accusation: 'The north star relocates hourly.' })
    ],
    ...extensionFields()
  }, { sessions });

  assert.equal(result.topThree.length, 3);
  assert.equal(result.topThree[0].rootCause, 'vague authorization without criteria');
  assert.equal(result.topThree[0].accusation, 'Vibes-driven shipping.');
  assert.deepEqual(result.remaining.map((item) => item.severity), ['medium', 'low']);
  assert.equal(result.remaining.some((item) => item.rootCause === 'vague authorization without criteria'), false);
  assert.equal(result.strengths.length, 1);
  assert.equal(result.highestLeverageChange.change, 'State the acceptance check before authorizing edits.');
  assert.equal(result.automationCandidates[0].type, 'Skill');
});

test('audit aggregate rejects unknown session locators', () => {
  assert.throws(() => validateAuditAggregateResult({
    top_three: [aggregateFinding({
      locators: [{ session_id: 'missing-session', message_indexes: [1] }],
      quotations: [userText]
    })],
    remaining: [],
    ...extensionFields({
      strengths: [],
      self_defeating_patterns: [],
      automation_candidates: []
    })
  }, { sessions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', sessionId: 'session-a', findings: [] }] }), /unknown session/);
});

test('audit aggregate keeps strengths, dedupes self-defeating patterns by intent, and requires one highest-leverage change', () => {
  const sessions = [{
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'session-a',
    userTexts: [userText, regressionText, workflowText],
    findings: [validFinding()]
  }];

  const result = validateAuditAggregateResult({
    top_three: [aggregateFinding()],
    remaining: [],
    ...extensionFields({
      self_defeating_patterns: [
        {
          pattern: 'Just fix everything somehow',
          intent: 'vague authorization without criteria',
          explanation: 'Broad permission replaces the missing done definition.',
          quotations: [userText],
          locators: [{ session_id: 'session-a', message_indexes: [1] }]
        },
        {
          pattern: 'make it good somehow',
          intent: 'vague authorization without criteria',
          explanation: 'Same vague permission wearing a nicer coat.',
          quotations: [userText],
          locators: [{ session_id: 'session-a', message_indexes: [1] }]
        }
      ]
    })
  }, { sessions });

  assert.equal(result.strengths[0].habit.includes('regression'), true);
  assert.equal(result.selfDefeatingPatterns.length, 1);
  assert.equal(result.selfDefeatingPatterns[0].intent, 'vague authorization without criteria');
  assert.match(result.highestLeverageChange.rationale, /done line/);
});

test('audit aggregate rejects longitudinal highest-leverage changes and drops filler-only automation candidates', () => {
  const sessions = [{
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'session-a',
    userTexts: [userText, regressionText, workflowText, '继续', '可以', 'ok'],
    findings: [validFinding()]
  }];

  assert.throws(() => validateAuditAggregateResult({
    top_three: [aggregateFinding()],
    remaining: [],
    ...extensionFields({
      highest_leverage_change: {
        change: 'Build a thirty-day streak of clearer prompts.',
        rationale: 'Tracking progress every day for weeks will supposedly fix the habit.'
      }
    })
  }, { sessions }), /longitudinal goals, streaks, or tracking/);

  const result = validateAuditAggregateResult({
    top_three: [aggregateFinding()],
    remaining: [],
    ...extensionFields({
      automation_candidates: [
        {
          name: 'ok',
          type: 'command',
          trigger: '继续',
          frequency: 'Constant',
          inputs: ['ok'],
          outputs: ['继续'],
          rationale: 'The user keeps saying ok.',
          over_automation_risk: 'Automating filler creates noise.'
        },
        {
          name: 'ship-checklist',
          type: 'prompt_template',
          trigger: 'Ready to land a change',
          frequency: 'Repeated release workflow',
          inputs: ['diff summary'],
          outputs: ['PR checklist'],
          rationale: workflowText,
          over_automation_risk: 'May paper over release judgment.'
        }
      ]
    })
  }, { sessions });

  assert.equal(result.automationCandidates.length, 1);
  assert.equal(result.automationCandidates[0].name, 'ship-checklist');
  assert.equal(result.automationCandidates[0].type, 'prompt_template');
});

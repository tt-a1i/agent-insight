import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditAggregateEvidenceContext,
  createAuditAggregateChunkRequest,
  createAuditAggregateRequest,
  createSessionAuditChunkRequest,
  createSessionAuditFromChunksRequest,
  createSessionAuditRequest,
  splitAuditSessions,
  splitAuditUserMessages,
  validateAuditAggregateChunkResult,
  validateAuditAggregateResult,
  validateSessionAuditResult,
  validateSessionAuditChunkResult
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
    { index: 7, role: 'user', text: 'ok' },
    { index: 8, role: 'user', text: workflowText }
  ]
};

function validFinding(overrides = {}) {
  return {
    category: 'vague_broad_commands',
    severity: 'high',
    evidence_posture: 'observed_instance',
    accusation: 'You outsource taste to vibes.',
    explanation: 'Broad commands replace concrete decisions about scope and done.',
    quotations: [userText],
    locators: [{ message_indexes: [1] }],
    occurrence_count: 1,
    better_alternative: 'Name the files, acceptance checks, and non-goals before asking for a fix.',
    copyable_prompt: 'Fix the parser only: name the failing case, the files in scope, and the test that must pass before editing.',
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
      quotations: [userText, regressionText],
      locators: [{ session_id: 'session-a', message_indexes: [1, 3] }]
    }],
    highest_leverage_change: {
      change: 'State the acceptance check before authorizing edits.',
      rationale: 'One concrete done line collapses the vague-authorization habit.',
      copyable_prompt: 'Before any edits: the acceptance check is <test or observable signal>; stay inside <files>; non-goals are <list>.',
      quotations: [userText],
      locators: [{ session_id: 'session-a', message_indexes: [1] }]
    },
    automation_candidates: [{
      name: 'ship-checklist',
      type: 'Skill',
      trigger: 'After code is ready to land',
      frequency: 'Repeated across release sessions',
      inputs: ['changed files', 'test command'],
      outputs: ['docs update', 'PR body with checklist'],
      rationale: 'The migrate-docs-PR sequence repeats as one multi-step workflow.',
      over_automation_risk: 'Would hide judgment when the release path actually needs a human gate.',
      draft_body: '# ship-checklist\n\n1. Run tests\n2. Update docs\n3. Open PR with checklist',
      quotations: [workflowText],
      locators: [{ session_id: 'session-a', message_indexes: [4, 8] }]
    }],
    ...overrides
  };
}

test('session audit accepts grounded findings across the fixed taxonomy and freeform', () => {
  const request = createSessionAuditRequest(input);
  assert.equal(request.task, 'session_audit');
  assert.match(request.prompt, /goal_clarity/);
  assert.match(request.prompt, /correction_quality/);
  assert.match(request.prompt, /convergence/);
  assert.match(request.prompt, /freeform/);
  assert.match(request.prompt, /Just fix everything/);

  const result = validateSessionAuditResult({
    findings: [
      validFinding(),
      validFinding({
        category: 'correction_quality',
        severity: 'medium',
        evidence_posture: 'bold_inference',
        accusation: 'Corrections arrive late and soft.',
        explanation: 'The follow-up names the missing gate only after the first patch lands.',
        quotations: [regressionText],
        locators: [{ message_indexes: [3] }],
        occurrence_count: null,
        root_cause: 'late correction quality'
      }),
      validFinding({
        category: 'convergence',
        severity: 'low',
        evidence_posture: 'bold_inference',
        accusation: 'You keep the plan slightly movable.',
        explanation: 'A second broad ask keeps the finish line from settling.',
        quotations: [regressionText],
        locators: [{ message_indexes: [3] }],
        occurrence_count: null,
        root_cause: 'incomplete convergence'
      }),
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

  assert.equal(result.findings.length, 4);
  assert.equal(result.findings[0].evidencePosture, 'observed_instance');
  assert.equal(result.findings[0].copyablePrompt.includes('failing case'), true);
  assert.equal(result.findings[1].category, 'correction_quality');
  assert.equal(result.findings[2].category, 'convergence');
  assert.equal(result.findings[3].category, 'freeform');
  assert.equal(result.userTexts, undefined);
  assert.deepEqual(result.userMessageIndexes, [1, 3, 4, 5, 6, 7, 8]);
});

test('session audit rejects a copyable prompt that merely repeats the quotation', () => {
  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({ copyable_prompt: userText })]
  }, input), /rewrite the quotation/);
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
    userMessages: input.messages.filter((message) => message.role === 'user'),
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
  assert.match(request.prompt, /copyable_prompt/);
  assert.match(request.prompt, /draft_body/);
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
  assert.match(result.highestLeverageChange.copyablePrompt, /acceptance check/);
  assert.equal(result.automationCandidates[0].type, 'Skill');
  assert.match(result.automationCandidates[0].draftBody, /ship-checklist/);
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
  }, { sessions: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', sessionId: 'session-a', userMessages: input.messages, userTexts: [userText], findings: [] }] }), /unknown session/);
});

test('audit aggregate keeps strengths, dedupes self-defeating patterns by intent, and requires one highest-leverage change', () => {
  const sessions = [{
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'session-a',
    userMessages: input.messages.filter((message) => message.role === 'user'),
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
          quotations: [userText, regressionText],
          locators: [{ session_id: 'session-a', message_indexes: [1, 3] }]
        },
        {
          pattern: 'make it good somehow',
          intent: 'vague authorization without criteria',
          explanation: 'Same vague permission wearing a nicer coat.',
          quotations: [userText, regressionText],
          locators: [{ session_id: 'session-a', message_indexes: [1, 3] }]
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
    userMessages: input.messages.filter((message) => message.role === 'user'),
    userTexts: [userText, regressionText, workflowText, '继续', '可以', 'ok'],
    findings: [validFinding()]
  }];

  assert.throws(() => validateAuditAggregateResult({
    top_three: [aggregateFinding()],
    remaining: [],
    ...extensionFields({
      highest_leverage_change: {
        change: 'Build a thirty-day streak of clearer prompts.',
        copyable_prompt: 'State the acceptance check before authorizing edits.',
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
          over_automation_risk: 'May paper over release judgment.',
          quotations: [workflowText],
          locators: [{ session_id: 'session-a', message_indexes: [4, 8] }]
        }
      ]
    })
  }, { sessions });

  assert.equal(result.automationCandidates.length, 1);
  assert.equal(result.automationCandidates[0].name, 'ship-checklist');
  assert.equal(result.automationCandidates[0].type, 'prompt_template');
});

test('fabricated quotations fail closed when the user corpus is empty', () => {
  assert.throws(() => validateAuditAggregateResult({
    top_three: [aggregateFinding({
      quotations: ['fabricated'],
      locators: [{ session_id: 'session-a', message_indexes: [1] }]
    })],
    remaining: [],
    ...extensionFields({
      strengths: [],
      self_defeating_patterns: [],
      automation_candidates: []
    })
  }, {
    sessions: [{
      id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      sessionId: 'session-a',
      userTexts: [],
      findings: []
    }]
  }), /fabricated quotation/);
});

test('oversized session and aggregate audit prompts split into bounded chunks', () => {
  const longMessages = [];
  for (let index = 0; index < 100; index += 1) {
    longMessages.push({
      index: index + 1,
      role: 'user',
      text: `User request ${index} ${'x'.repeat(500)}`
    });
  }
  const longInput = {
    ...input,
    messages: longMessages
  };
  const direct = createSessionAuditRequest(longInput);
  assert.ok(direct.prompt.length > 30_000);

  const messageChunks = splitAuditUserMessages(longMessages);
  assert.ok(messageChunks.length > 1);
  for (const [index, chunk] of messageChunks.entries()) {
    const request = createSessionAuditChunkRequest(longInput, chunk, index, messageChunks.length, null);
    assert.ok(request.prompt.length <= 30_000, `session audit chunk ${index} exceeded bound`);
  }
  const fromChunks = createSessionAuditFromChunksRequest(longInput, [{
    summary: 'Cumulative sharp audit of early user habits.',
    findings: []
  }]);
  assert.ok(fromChunks.prompt.length <= 30_000);

  const sessions = Array.from({ length: 100 }, (_, index) => ({
    id: index.toString(16).padStart(24, 'a'),
    sessionId: `session-${index}`,
    source: 'claude',
    date: '2026-07-01',
    projectPath: `/work/project-${index}`,
    projectLabel: `project-${index}`,
    facet: { underlyingGoal: `Goal ${index}`, briefSummary: `Summary ${index} ${'y'.repeat(200)}` },
    userTexts: [`Request ${index} ${'z'.repeat(400)}`],
    findings: [validFinding({
      quotations: [`Request ${index} ${'z'.repeat(400)}`],
      locators: [{ message_indexes: [1] }]
    })]
  }));
  const aggregateDirect = createAuditAggregateRequest({ sessions });
  assert.ok(aggregateDirect.prompt.length > 30_000);
  const sessionGroups = splitAuditSessions(sessions);
  assert.ok(sessionGroups.length > 1);
  for (const [index, group] of sessionGroups.entries()) {
    const request = createAuditAggregateChunkRequest({ sessions }, group, index, sessionGroups.length, null);
    assert.ok(request.prompt.length <= 30_000, `audit aggregate chunk ${index} exceeded bound`);
  }
  const aggregateFromChunks = createAuditAggregateRequest({
    sessions,
    chunkSummaries: [{ summary: 'Cross-session synthesis of sharp habits.', findings: [] }]
  });
  assert.ok(aggregateFromChunks.prompt.length <= 30_000);
  assert.match(aggregateFromChunks.prompt, /chunk_summaries/);
});


test('audit binds quotations to genuine cited messages and counts unique occurrences', () => {
  for (const messageIndex of [2, 3]) {
    assert.throws(() => validateSessionAuditResult({
      findings: [validFinding({ locators: [{ message_indexes: [messageIndex] }] })]
    }, input), /unknown message index|does not match its cited user messages/);
  }
  assert.throws(() => validateSessionAuditResult({
    findings: [validFinding({ locators: [{ message_indexes: [1] }, { message_indexes: [1] }], occurrence_count: 2 })]
  }, input), /unsupported for the provided evidence/);
  const result = validateSessionAuditResult({
    findings: [validFinding({ locators: [{ message_indexes: [1] }, { message_indexes: [1] }] })]
  }, input);
  assert.deepEqual(result.findings[0].locators, [{ sessionId: input.opaqueId, messageIndexes: [1] }]);
  assert.deepEqual(result.userMessages.map(({ sourceMessageEligibility, ...message }) => message), input.messages.filter((message) => message.role === 'user'));
});

test('cross-session audit rejects misbound, invented and assistant message locators', () => {
  const context = { sessions: [
    { id: 'a', sessionId: 'session-a', userMessages: input.messages },
    { id: 'b', sessionId: 'session-b', userMessages: [{ index: 1, role: 'user', text: 'Run tests only.' }] }
  ] };
  for (const [sessionId, index, error] of [
    ['session-b', 1, /does not match its cited user messages/],
    ['session-a', 2, /unknown message index/],
    ['session-a', 999999, /unknown message index/]
  ]) {
    assert.throws(() => validateAuditAggregateResult({
      top_three: [aggregateFinding({ locators: [{ session_id: sessionId, message_indexes: [index] }] })],
      ...extensionFields({ strengths: [], self_defeating_patterns: [], automation_candidates: [] })
    }, context), error);
  }
  const result = validateAuditAggregateResult({
    top_three: [aggregateFinding()],
    ...extensionFields({ strengths: [{ habit: 'Provides context', explanation: 'Context helps.', quotations: ['Run tests only.'], locators: [{ session_id: 'session-b', message_indexes: [1] }] }], self_defeating_patterns: [], automation_candidates: [] })
  }, context);
  assert.deepEqual(result.strengths[0].locators, [{ sessionId: 'b', messageIndexes: [1] }]);
});

test('audit long-message chunks preserve each fragment with the same original index', () => {
  const text = 'early quote ' + 'x'.repeat(50000) + ' late quote';
  const messages = [{ index: 7, role: 'user', text }];
  const chunks = splitAuditUserMessages(messages);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => JSON.stringify(chunk).length <= 25000));
  assert.equal(chunks.flat().map((message) => message.text).join(''), text);
  const fragmentInput = { ...input, messages: chunks[0].map((message) => ({ ...message, role: 'user' })) };
  assert.throws(() => validateSessionAuditChunkResult({ summary: 'Scoped chunk', findings: [validFinding({ quotations: ['late quote'], locators: [{ message_indexes: [7] }] })] }, fragmentInput), /fabricated quotation/);
  const carriedInput = { ...input, messages: [{ index: 7, role: 'user', text: 'early quote' }, ...chunks.at(-1).map((message) => ({ ...message, role: 'user' }))] };
  const result = validateSessionAuditChunkResult({ summary: 'Preserved both fragments', findings: [validFinding({ quotations: ['early quote', 'late quote'], locators: [{ message_indexes: [7] }] })] }, carriedInput);
  assert.equal(result.findings.length, 1);
});


test('audit retains bounded indexed samples and cited excerpts instead of full user text', () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ index: index + 1, role: 'user', text: `Message ${index} ` + 'x'.repeat(10000) + ` PRIVATE_TAIL_${index}` }));
  const audit = validateSessionAuditResult({ findings: [validFinding({ quotations: ['PRIVATE_TAIL_19'], locators: [{ message_indexes: [20] }] })] }, { ...input, messages });
  assert.equal(audit.userTexts, undefined);
  assert.equal(audit.userMessageIndexes.length, 20);
  assert.ok(JSON.stringify(audit).length < 5000);
  assert.equal(JSON.stringify(audit).includes('PRIVATE_TAIL_0'), false);
  assert.ok(audit.userMessages.some((message) => message.index === 20 && message.text === 'PRIVATE_TAIL_19'));
  const session = { ...audit, id: input.opaqueId, sessionId: 'same-human-id' };
  const request = createAuditAggregateRequest({ sessions: [session] });
  const data = JSON.parse(request.prompt.match(/<audit-data>\n(.*?)\n<\/audit-data>/s)[1]);
  assert.equal(data.sessions[0].user_texts, undefined);
  assert.ok(data.sessions[0].user_messages.every((message) => message.session_id === input.opaqueId && Number.isInteger(message.index)));
  assert.equal(request.prompt.includes('PRIVATE_TAIL_0'), false);
  assert.throws(() => validateAuditAggregateResult({ top_three: [aggregateFinding({ quotations: ['PRIVATE_TAIL_0'], locators: [{ session_id: input.opaqueId, message_indexes: [1] }] })], ...extensionFields({ strengths: [], self_defeating_patterns: [] }) }, { sessions: [session] }), /fabricated quotation/);
  const noFinding = validateSessionAuditResult({ findings: [] }, { ...input, messages });
  const context = { sessions: [{ ...noFinding, id: input.opaqueId }] };
  assert.throws(() => validateAuditAggregateResult({ top_three: [], ...extensionFields({ strengths: [{ habit: 'Helpful guidance', explanation: 'A bare index is not supporting evidence.', locators: [{ session_id: input.opaqueId, message_indexes: [20] }] }], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: [] }) }, context), /quotations is required/);
});

test('ambiguous source session aliases are rejected while canonical ids remain usable', () => {
  const context = { sessions: [
    { id: 'a', sessionId: 'shared', source: 'codex', userMessages: input.messages },
    { id: 'b', sessionId: 'shared', source: 'claude', userMessages: input.messages },
    { id: 'c', sessionId: 'a', source: 'cursor', userMessages: input.messages }
  ] };
  const value = (id) => ({ top_three: [aggregateFinding({ locators: [{ session_id: id, message_indexes: [1] }] })], ...extensionFields({ strengths: [], self_defeating_patterns: [], highest_leverage_change: { ...extensionFields().highest_leverage_change, locators: [{ session_id: id, message_indexes: [1] }] }, automation_candidates: [] }) });
  assert.throws(() => validateAuditAggregateResult(value('shared'), context), /ambiguous session alias/);
  assert.equal(validateAuditAggregateResult(value('a'), context).topThree[0].locators[0].sessionId, 'a');
  assert.equal(validateAuditAggregateResult(value('b'), context).topThree[0].locators[0].sessionId, 'b');
});

test('rolling audit aggregation cannot reopen uncarried prior-session quotations', () => {
  const sessions = [{ id: 'a', userMessages: [{ index: 1, role: 'user', text: userText }, { index: 2, role: 'user', text: 'hidden previous sample' }] }, { id: 'b', userMessages: [{ index: 1, role: 'user', text: 'current sample' }] }];
  const carry = { summary: 'Prior claim', findings: [{ quotations: [userText], locators: [{ sessionId: 'a', messageIndexes: [1] }] }] };
  for (const current of [[], [sessions[1]]]) {
    const context = auditAggregateEvidenceContext({ sessions }, current, carry);
    assert.throws(() => validateAuditAggregateChunkResult({ summary: 'Hidden claim', findings: [aggregateFinding({ quotations: ['hidden previous sample'], locators: [{ session_id: 'a', message_indexes: [2] }] })] }, context), /fabricated quotation/);
    const accepted = validateAuditAggregateChunkResult({ summary: 'Retained claim', findings: [aggregateFinding({ locators: [{ session_id: 'a', message_indexes: [1] }] })] }, context);
    assert.equal(accepted.findings.length, 1);
  }
});

test('a single oversized audit session exposes every validated finding without creating extra sessions', () => {
  const audit = validateSessionAuditResult({ findings: Array.from({ length: 10 }, (_, index) => validFinding({ explanation: 'x'.repeat(2000), root_cause: `cause ${index}` })) }, input);
  const session = { ...audit, id: input.opaqueId };
  const groups = splitAuditSessions([session]);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flatMap((group) => group.flatMap((fragment) => fragment.findings)), audit.findings);
  assert.deepEqual([...new Set(groups.flat().map((fragment) => fragment.id))], [input.opaqueId]);
  for (const [index, group] of groups.entries()) {
    const request = createAuditAggregateChunkRequest({ sessions: [session] }, group, index, groups.length);
    assert.ok(request.prompt.length <= 30_000);
  }
});

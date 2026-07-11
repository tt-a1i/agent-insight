import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSessionFacet, validateSessionFacet } from '../src/protocol.mjs';
import { createAggregateChunkRequest, createAggregateRequest, createAtAGlanceChunkRequest, splitAggregateSections, splitAggregateSessions, validateAggregateChunkResult, validateAggregateResult } from '../src/aggregate-protocol.mjs';

test('session facet analysis validates evidence and returns no transcript text', async () => {
  const secret = 'repair the private payment parser';
  let request;
  const facet = await analyzeSessionFacet({
    source: 'claude',
    sessionId: 'session-7a9c',
    opaqueId: 'session-7a9c',
    date: '2026-07-01',
    durationMinutes: 12,
    projectLabel: 'payments',
    messages: [
      { index: 1, role: 'user', text: secret },
      { index: 2, role: 'assistant', text: 'Implemented and verified the parser fix.' }
    ]
  }, {
    completeJson: async (value) => {
      request = value;
      return {
        underlying_goal: 'Repair a payment parser defect',
        goal_categories: { fix_bug: 1 },
        outcome: 'fully_achieved',
        user_satisfaction_counts: { satisfied: 1 },
        agent_helpfulness: 'very_helpful',
        session_type: 'single_task',
        friction_counts: {},
        friction_detail: '',
        primary_success: 'good_debugging',
        brief_summary: 'The parser defect was fixed and verified.',
        evidence: [{ message_indexes: [1, 2], description: 'Request followed by a verified implementation.' }]
      };
    }
  });

  assert.equal(request.task, 'session_facet');
  assert.match(request.prompt, new RegExp(secret));
  assert.match(request.prompt, /Session ID: session-7a9c/);
  assert.match(request.prompt, /Duration minutes: 12/);
  assert.equal(facet.outcome, 'fully_achieved');
  assert.deepEqual(facet.evidence[0], {
    source: 'claude',
    date: '2026-07-01',
    opaqueSessionId: 'session-7a9c',
    messageIndexes: [1, 2],
    description: 'Request followed by a verified implementation.'
  });
  assert.equal(JSON.stringify(facet).includes(secret), false);
});

test('session facet rejects invented taxonomy labels and unbounded prose', () => {
  const input = { source: 'claude', opaqueId: 'opaque', date: '2026-07-01', messages: [{ index: 1, role: 'user', text: 'help' }] };
  const base = {
    underlying_goal: 'Resolve a defect', goal_categories: { made_up_goal: 1 }, outcome: 'fully_achieved',
    user_satisfaction_counts: { satisfied: 1 }, agent_helpfulness: 'very_helpful', session_type: 'single_task',
    friction_counts: {}, friction_detail: '', primary_success: 'good_debugging', brief_summary: 'Resolved.',
    evidence: [{ message_indexes: [1], description: 'The request was resolved.' }]
  };
  assert.throws(() => validateSessionFacet(base, input), /unsupported category/);
  assert.throws(() => validateSessionFacet({ ...base, goal_categories: { fix_bug: 1 }, brief_summary: 'x'.repeat(1_001) }, input), /too long/);
});

test('project areas aggregate keeps opaque evidence references', () => {
  const context = {
    metrics: { totalSessions: 2 },
    sessions: [
      { id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Fix parser', briefSummary: 'Parser fixed', goalCategories: { fix_bug: 1 } } },
      { id: 'session-b', date: '2026-07-02', facet: { underlyingGoal: 'Add tests', briefSummary: 'Tests added', goalCategories: { tests: 1 } } }
    ]
  };
  const request = createAggregateRequest('project_areas', context);
  assert.equal(request.task, 'project_areas');
  assert.match(request.prompt, /session-a/);

  const result = validateAggregateResult('project_areas', {
    areas: [{
      name: 'Parser reliability',
      session_count: 2,
      description: 'Work focused on parser correctness and tests.',
      evidence_session_ids: ['session-a', 'session-b']
    }]
  }, context);
  assert.deepEqual(result.areas[0], {
    name: 'Parser reliability',
    sessionCount: 2,
    description: 'Work focused on parser correctness and tests.',
    evidenceSessionIds: ['session-a', 'session-b']
  });
});

test('interaction style aggregate validates its narrative evidence', () => {
  const context = {
    metrics: { totalSessions: 1 },
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Fix parser', briefSummary: 'Parser fixed', goalCategories: {}, outcome: 'fully_achieved', frictionDetail: '' } }]
  };
  const request = createAggregateRequest('interaction_style', context);
  assert.equal(request.task, 'interaction_style');
  const result = validateAggregateResult('interaction_style', {
    narrative: 'You iterate in focused verification loops.',
    key_pattern: 'Fast iteration with explicit checks.',
    evidence_session_ids: ['session-a']
  }, context);
  assert.deepEqual(result, {
    narrative: 'You iterate in focused verification loops.',
    keyPattern: 'Fast iteration with explicit checks.',
    evidenceSessionIds: ['session-a']
  });
});

test('what works aggregate preserves impressive workflows and evidence', () => {
  const context = {
    metrics: {},
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Ship fix', briefSummary: 'Fix shipped', goalCategories: {}, outcome: 'fully_achieved', frictionDetail: '' } }]
  };
  const result = validateAggregateResult('what_works', {
    intro: 'Your strongest sessions close the verification loop.',
    impressive_workflows: [{
      title: 'Verify before shipping',
      description: 'You pair implementation with focused checks.',
      evidence_session_ids: ['session-a']
    }, {
      title: 'Keep scope narrow',
      description: 'You keep fixes bounded to the reported problem.',
      evidence_session_ids: ['session-a']
    }, {
      title: 'Close the loop',
      description: 'You finish with a concrete delivery step.',
      evidence_session_ids: ['session-a']
    }]
  }, context);
  assert.deepEqual(result.impressiveWorkflows[0], {
    title: 'Verify before shipping',
    description: 'You pair implementation with focused checks.',
    evidenceSessionIds: ['session-a']
  });
});

test('friction aggregate requires three evidenced categories with two examples each', () => {
  const context = {
    metrics: {},
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Fix parser', briefSummary: 'Parser fixed', goalCategories: {}, outcome: 'mostly_achieved', frictionDetail: 'A tool failed.' } }]
  };
  const category = (name) => ({
    category: name,
    description: `${name} caused avoidable rework.`,
    examples: [
      { text: `${name} example one.`, evidence_session_ids: ['session-a'] },
      { text: `${name} example two.`, evidence_session_ids: ['session-a'] }
    ]
  });
  const result = validateAggregateResult('friction_analysis', {
    intro: 'Most friction came from execution boundaries.',
    categories: [category('Tool failures'), category('Wrong approach'), category('Missing context')]
  }, context);
  assert.equal(result.categories.length, 3);
  assert.deepEqual(result.categories[0].examples[0], {
    text: 'Tool failures example one.',
    evidenceSessionIds: ['session-a']
  });
});

test('suggestions aggregate validates durable instructions, features, and usage patterns', () => {
  const context = {
    metrics: {},
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Verify changes', briefSummary: 'Checks ran', goalCategories: {}, outcome: 'fully_achieved', frictionDetail: '' } }]
  };
  const evidence = { evidence_session_ids: ['session-a'] };
  const result = validateAggregateResult('suggestions', {
    claude_md_additions: [
      { addition: 'Run tests after edits.', why: 'This instruction recurred.', prompt_scaffold: 'Add under Testing.', ...evidence },
      { addition: 'Keep changes scoped.', why: 'This preference recurred.', prompt_scaffold: 'Add under Workflow.', ...evidence }
    ],
    features_to_try: [
      { feature: 'Custom Skills', one_liner: 'Package repeated workflows.', why_for_you: 'You repeat verification steps.', example_code: '/test', ...evidence },
      { feature: 'Hooks', one_liner: 'Run checks automatically.', why_for_you: 'Checks matter in your sessions.', example_code: 'hooks config', ...evidence }
    ],
    usage_patterns: [
      { title: 'State the gate', suggestion: 'Name the final check.', detail: 'This makes completion measurable.', copyable_prompt: 'Finish only after tests pass.', ...evidence },
      { title: 'Use evidence', suggestion: 'Ask for proof.', detail: 'This keeps claims grounded.', copyable_prompt: 'Show the verification result.', ...evidence }
    ]
  }, context);
  assert.equal(result.instructionAdditions.length, 2);
  assert.equal(result.featuresToTry[0].feature, 'Custom Skills');
  assert.equal(result.usagePatterns[0].copyablePrompt, 'Finish only after tests pass.');
  assert.deepEqual(result.instructionAdditions[0].evidenceSessionIds, ['session-a']);
});

test('on-the-horizon aggregate requires three evidenced opportunities', () => {
  const context = {
    metrics: {},
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Automate checks', briefSummary: 'Checks automated', goalCategories: {}, outcome: 'fully_achieved', frictionDetail: '' } }]
  };
  const opportunity = (title) => ({
    title,
    whats_possible: `${title} can become autonomous.`,
    how_to_try: 'Start with a bounded pilot.',
    copyable_prompt: `Pilot ${title}.`,
    evidence_session_ids: ['session-a']
  });
  const result = validateAggregateResult('on_the_horizon', {
    intro: 'More capable models unlock larger closed loops.',
    opportunities: [opportunity('Release validation'), opportunity('Parallel diagnosis'), opportunity('Continuous maintenance')]
  }, context);
  assert.equal(result.opportunities.length, 3);
  assert.equal(result.opportunities[0].copyablePrompt, 'Pilot Release validation.');
});

test('fun ending is qualitative and traceable to a session', () => {
  const context = {
    metrics: {},
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Fix parser', briefSummary: 'A stubborn parser finally passed', goalCategories: {}, outcome: 'fully_achieved', frictionDetail: '' } }]
  };
  const result = validateAggregateResult('fun_ending', {
    headline: 'The parser finally blinked first',
    detail: 'A stubborn failure turned into a verified fix.',
    evidence_session_ids: ['session-a']
  }, context);
  assert.deepEqual(result, {
    headline: 'The parser finally blinked first',
    detail: 'A stubborn failure turned into a verified fix.',
    evidenceSessionIds: ['session-a']
  });
});

test('at-a-glance synthesis is generated after the seven aggregate sections', () => {
  const context = {
    metrics: {},
    sessions: [{ id: 'session-a', date: '2026-07-01', facet: { underlyingGoal: 'Fix parser', briefSummary: 'Parser fixed', goalCategories: {}, outcome: 'fully_achieved', frictionDetail: '' } }],
    sections: {
      project_areas: { areas: [] },
      interaction_style: { narrative: 'Focused loops.' },
      what_works: { intro: 'Verification works.' },
      friction_analysis: { intro: 'Tools can fail.' },
      suggestions: { instructionAdditions: [] },
      on_the_horizon: { intro: 'Larger loops are coming.' },
      fun_ending: { headline: 'Parser fixed.' }
    }
  };
  const request = createAggregateRequest('at_a_glance', context);
  assert.match(request.prompt, /Focused loops/);
  const result = validateAggregateResult('at_a_glance', {
    whats_working: 'Focused verification is producing reliable outcomes.',
    whats_hindering: 'Tool failures occasionally interrupt the loop.',
    quick_wins: 'Turn repeated checks into a reusable skill.',
    ambitious_workflows: 'Prepare bounded autonomous release validation.',
    evidence_session_ids: ['session-a']
  }, context);
  assert.equal(result.whatsWorking, 'Focused verification is producing reliable outcomes.');
  assert.deepEqual(result.evidenceSessionIds, ['session-a']);
});

test('large aggregate contexts split into bounded derived-evidence chunks', () => {
  const sessions = Array.from({ length: 200 }, (_, index) => ({
    id: `session-${index}`, date: '2026-07-01', facet: {
      underlyingGoal: `Goal ${index} ${'g'.repeat(120)}`, briefSummary: `Summary ${index} ${'s'.repeat(200)}`,
      goalCategories: { fix_bug: 1 }, outcome: 'fully_achieved', userSatisfactionCounts: { satisfied: 1 },
      agentHelpfulness: 'very_helpful', sessionType: 'single_task', frictionCounts: {}, frictionDetail: '',
      primarySuccess: 'good_debugging', userInstructionsToAgent: []
    }
  }));
  const groups = splitAggregateSessions(sessions);
  assert.ok(groups.length > 1);
  const request = createAggregateChunkRequest('project_areas', { metrics: { totalSessions: 200 }, sessions }, groups[0], 0, groups.length);
  assert.ok(request.prompt.length < 30_000);
  const result = validateAggregateChunkResult({ summary: 'This group centers on parser repair workflows.', evidence_session_ids: [groups[0][0].id] }, { sessions });
  assert.equal(result.evidenceSessionIds[0], groups[0][0].id);
});

test('aggregate prompts do not duplicate unbounded summaries or raw timing samples', () => {
  const session = {
    id: 'session-a', date: '2026-07-01', facet: {
      underlyingGoal: 'Repair a parser', briefSummary: 'The parser was repaired.',
      goalCategories: { fix_bug: 1 }, outcome: 'fully_achieved', userSatisfactionCounts: { satisfied: 1 },
      agentHelpfulness: 'very_helpful', sessionType: 'single_task', frictionCounts: {}, frictionDetail: '',
      primarySuccess: 'good_debugging', userInstructionsToAgent: []
    }
  };
  const context = {
    metrics: {
      totalSessions: 1,
      toolCounts: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`tool-${index}-${'t'.repeat(80)}`, 1])),
      projects: Object.fromEntries(Array.from({ length: 5_000 }, (_, index) => [`project-${index}-${'p'.repeat(80)}`, 1])),
      sessionSummaries: Array.from({ length: 1_000 }, () => ({ summary: 'x'.repeat(1_000) })),
      userResponseTimes: Array.from({ length: 100_000 }, () => 12)
    },
    sessions: [session]
  };
  const direct = createAggregateRequest('project_areas', context);
  const chunk = createAggregateChunkRequest('project_areas', context, [session], 0, 1);
  assert.ok(direct.prompt.length < 30_000);
  assert.ok(chunk.prompt.length < 30_000);
  assert.doesNotMatch(direct.prompt, /sessionSummaries|userResponseTimes/);
  assert.match(direct.prompt, /responseTimeSampleCount/);
});

test('large completed sections use bounded rolling chunks before at-a-glance synthesis', () => {
  const sections = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`section-${index}`, { narrative: 'n'.repeat(20_000), evidenceSessionIds: ['session-a'] }]));
  const groups = splitAggregateSections(sections);
  assert.ok(groups.length > 7);
  const request = createAtAGlanceChunkRequest({ sections }, groups[0], 0, groups.length, null);
  assert.ok(request.prompt.length < 30_000);
  assert.equal(request.section, 'at_a_glance');
});

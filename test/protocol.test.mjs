import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSessionFacet, createSessionFacetRequest, validateSessionChunkResult, validateSessionFacet } from '../src/protocol.mjs';
import { createAggregateChunkRequest, createAggregateRequest, createAtAGlanceChunkRequest, splitAggregateSections, splitAggregateSessions, validateAggregateChunkResult, validateAggregateResult } from '../src/aggregate-protocol.mjs';
import { createSessionAuditRequest } from '../src/audit-protocol.mjs';

test('session facet analysis validates concrete evidence including quotations', async () => {
  const secret = 'repair the private payment parser';
  let request;
  const facet = await analyzeSessionFacet({
    source: 'claude',
    sessionId: 'session-7a9c',
    opaqueId: 'session-7a9c',
    date: '2026-07-01',
    durationMinutes: 12,
    projectPath: '/work/payments',
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
        evidence: [{
          message_indexes: [1, 2],
          description: 'Request followed by a verified implementation.',
          quotation: secret
        }]
      };
    }
  });

  assert.equal(request.task, 'session_facet');
  assert.match(request.prompt, new RegExp(secret));
  assert.match(request.prompt, /Session ID: session-7a9c/);
  assert.match(request.prompt, /Project: \/work\/payments/);
  assert.match(request.prompt, /Duration minutes: 12/);
  assert.doesNotMatch(request.prompt, /Paraphrase every conclusion/);
  assert.equal(facet.outcome, 'fully_achieved');
  assert.deepEqual(facet.evidence[0], {
    source: 'claude',
    date: '2026-07-01',
    opaqueSessionId: 'session-7a9c',
    sessionId: 'session-7a9c',
    projectPath: '/work/payments',
    projectLabel: 'payments',
    messageIndexes: [1, 2],
    description: 'Request followed by a verified implementation.',
    quotation: secret
  });
});

test('baseline evidence rejects fabricated and misplaced quotations', () => {
  const input = {
    source: 'claude', opaqueId: 'session', date: '2026-07-01',
    messages: [
      { index: 1, role: 'user', text: 'Inspect only; do not deploy.' },
      { index: 2, role: 'assistant', text: 'Inspected the service; no deployment performed.' },
      { index: 3, role: 'user', text: 'Deploy production immediately.' }
    ]
  };
  const chunk = (quotation, indexes = [1]) => ({
    summary: 'The user requested an inspection.',
    evidence: [{ message_indexes: indexes, description: 'Concrete excerpt.', quotation }]
  });
  assert.throws(() => validateSessionChunkResult(chunk('Invented request.'), input), /quotation.*cited messages/);
  assert.throws(() => validateSessionChunkResult(chunk('Deploy production immediately.'), input), /quotation.*cited messages/);
  assert.throws(() => validateSessionChunkResult(chunk('Inspect only; no deployment performed.', [1, 2]), input), /quotation.*cited messages/);
  assert.equal(validateSessionChunkResult(chunk('do not deploy.'), input).evidence[0].quotation, 'do not deploy.');
  assert.equal(validateSessionChunkResult(chunk('no deployment performed.', [2]), input).evidence[0].quotation, 'no deployment performed.');
  const facet = (evidence) => ({
    underlying_goal: 'Inspect the service', goal_categories: { debug_investigate: 1 }, outcome: 'fully_achieved',
    user_satisfaction_counts: {}, agent_helpfulness: 'very_helpful', session_type: 'single_task',
    friction_counts: {}, friction_detail: '', primary_success: 'fast_accurate_search', brief_summary: 'Inspected.', evidence
  });
  assert.throws(() => validateSessionFacet(facet(chunk('Deploy production immediately.').evidence), input), /quotation.*cited messages/);
  assert.equal(validateSessionFacet(facet(chunk('no deployment performed.', [2]).evidence), input).evidence[0].quotation, 'no deployment performed.');
  assert.throws(() => validateSessionChunkResult(chunk('Inspect only;'), { ...input, messages: [{ index: 1 }] }), /quotation.*cited messages/);
});

test('baseline derived evidence retains quotation provenance across chunk fragments', () => {
  const input = {
    source: 'claude', opaqueId: 'session', date: '2026-07-01',
    messages: [
      { index: 1, role: 'user', text: 'Inspect only; do not deploy.' },
      { index: 1, role: 'user', text: ' Preserve this final instruction.' },
      { index: 2, role: 'assistant', text: 'The inspection passed.' }
    ]
  };
  const result = (quotation, indexes = [1]) => ({
    summary: 'The user requested an inspection.',
    evidence: [{ message_indexes: indexes, description: 'Concrete excerpt.', quotation }]
  });
  const carry = validateSessionChunkResult(result('do not deploy.', [1, 2]), input);
  assert.equal(validateSessionChunkResult(result('Inspect only;'), input).evidence[0].quotation, 'Inspect only;');
  assert.equal(validateSessionChunkResult(result('final instruction.'), input).evidence[0].quotation, 'final instruction.');
  const laterInput = {
    ...input,
    messages: [{ index: 3, role: 'assistant', text: 'A later chunk.' }],
    derivedEvidence: carry.evidence
  };
  assert.equal(validateSessionChunkResult(result('not deploy.', [1, 2]), laterInput).evidence[0].quotation, 'not deploy.');
  assert.throws(() => validateSessionChunkResult(result('do not deploy.', [2]), laterInput), /quotation.*cited messages/);
  assert.throws(() => validateSessionChunkResult(result('Inspect only;', [1, 2]), laterInput), /quotation.*cited messages/);
  assert.throws(() => validateSessionChunkResult(result('do not deploy.', [4]), laterInput), /unknown message index/);
  assert.throws(() => validateSessionChunkResult(result('not deploy.', [1]), { ...laterInput, derivedEvidence: [{ messageIndexes: [1], quotation: null, description: 'do not deploy.' }] }), /quotation.*cited messages/);
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

test('project areas aggregate accepts concrete session identifiers as evidence', () => {
  const context = {
    metrics: { totalSessions: 1 },
    sessions: [
      { id: 'opaque-a', sessionId: 'claude-parity', date: '2026-07-01', facet: { underlyingGoal: 'g', briefSummary: 'b', goalCategories: {}, outcome: 'fully_achieved', userSatisfactionCounts: {}, agentHelpfulness: 'very_helpful', sessionType: 'single_task', frictionCounts: {}, frictionDetail: '', primarySuccess: 'none', userInstructionsToAgent: [], evidence: [] } }
    ]
  };
  const result = validateAggregateResult('project_areas', {
    areas: [{ name: 'Parser work', session_count: 1, description: 'Parser reliability.', evidence_session_ids: ['claude-parity'] }]
  }, context);
  assert.deepEqual(result.areas[0].evidenceSessionIds, ['opaque-a']);
});

test('project areas aggregate keeps evidence session references', () => {
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

test('friction aggregate preserves up to three evidenced categories with two examples each', () => {
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
  context.sessions.push({ ...context.sessions[0], id: 'session-b' });
  const evidence = { evidence_session_ids: ['session-a', 'session-b'] };
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
  assert.deepEqual(result.instructionAdditions[0].evidenceSessionIds, ['session-a', 'session-b']);
});

test('on-the-horizon aggregate preserves three evidenced opportunities', () => {
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

test('zh locale appends Simplified Chinese prose instruction without changing JSON keys', () => {
  const input = {
    source: 'cursor',
    opaqueId: 'opaque-zh',
    sessionId: 'session-zh',
    date: '2026-07-01',
    durationMinutes: 5,
    messages: [{ index: 1, role: 'user', text: 'fix the parser' }],
    locale: 'zh'
  };
  const facet = createSessionFacetRequest(input);
  assert.match(facet.prompt, /Write all human-readable prose values in Simplified Chinese/);
  assert.match(facet.prompt, /Keep JSON keys and taxonomy enum values unchanged/);
  assert.doesNotMatch(createSessionFacetRequest({ ...input, locale: 'en' }).prompt, /Simplified Chinese/);

  const audit = createSessionAuditRequest(input);
  assert.match(audit.prompt, /Simplified Chinese/);

  const aggregate = createAggregateRequest('interaction_style', {
    locale: 'zh',
    metrics: { totalSessions: 1 },
    sessions: [{ id: 'opaque-zh', date: '2026-07-01', facet: { underlyingGoal: 'g', briefSummary: 'b', goalCategories: {}, outcome: 'fully_achieved', userSatisfactionCounts: {}, agentHelpfulness: 'very_helpful', sessionType: 'single_task', frictionCounts: {}, frictionDetail: '', primarySuccess: 'none', evidence: [] } }]
  });
  assert.match(aggregate.prompt, /Simplified Chinese/);
});


test('sparse aggregate baseline accepts no observed problems without filling quotas', () => {
  const context = { sessions: [{ id: 'only', sessionId: 'original', facet: { underlyingGoal: 'Fix parser', briefSummary: 'Verified fix.', frictionCounts: {}, evidence: [] } }], metrics: {} };
  assert.deepEqual(validateAggregateResult('friction_analysis', { intro: 'No friction observed in this one-session sample.', categories: [] }, context), { intro: 'No friction observed in this one-session sample.', categories: [] });
  assert.deepEqual(validateAggregateResult('what_works', { intro: 'Insufficient evidence of a distinctive workflow.', impressive_workflows: [] }, context).impressiveWorkflows, []);
  assert.deepEqual(validateAggregateResult('project_areas', { areas: [] }, context).areas, []);
  assert.deepEqual(validateAggregateResult('on_the_horizon', { intro: 'No opportunity justified by this sample.', opportunities: [] }, context).opportunities, []);
  assert.deepEqual(validateAggregateResult('suggestions', { claude_md_additions: [], features_to_try: [], usage_patterns: [] }, context), { instructionAdditions: [], featuresToTry: [], usagePatterns: [] });
  const workflow = { title: 'Verified the fix', description: 'One successful session.', evidence_session_ids: ['only'] };
  assert.equal(validateAggregateResult('what_works', { intro: 'Observed once.', impressive_workflows: [workflow] }, context).impressiveWorkflows.length, 1);
  const category = { category: 'Tool failure', description: 'Observed once.', examples: [{ text: 'One failed command.', evidence_session_ids: ['only'] }] };
  assert.equal(validateAggregateResult('friction_analysis', { intro: 'One incident.', categories: [category] }, context).categories[0].examples.length, 1);
  const opportunity = { title: 'Bounded check', whats_possible: 'Rerun a check.', how_to_try: 'Try once.', copyable_prompt: 'Run the check.', evidence_session_ids: ['only'] };
  assert.equal(validateAggregateResult('on_the_horizon', { intro: 'One possibility.', opportunities: [opportunity] }, context).opportunities.length, 1);
  const usage = { title: 'Check completion', suggestion: 'Ask for a check.', detail: 'Based on one observation.', copyable_prompt: 'Show the check result.', evidence_session_ids: ['only'] };
  assert.equal(validateAggregateResult('suggestions', { claude_md_additions: [], features_to_try: [], usage_patterns: [usage] }, context).usagePatterns.length, 1);
  for (const task of ['what_works', 'friction_analysis', 'suggestions', 'on_the_horizon', 'at_a_glance']) {
    assert.match(createAggregateRequest(task, context).prompt, /never fill a quota/);
    assert.match(createAggregateRequest(task, context).prompt, /not recurring habits/);
  }
});

test('sparse aggregate validation still rejects malformed and unsupported claims', () => {
  const context = { sessions: [{ id: 'only' }], metrics: {} };
  const workflow = { title: 'Good', description: 'Observed.', evidence_session_ids: ['only'] };
  assert.throws(() => validateAggregateResult('what_works', { intro: 'Good', impressive_workflows: [workflow, workflow, workflow, workflow] }, context), /0 to 3/);
  assert.throws(() => validateAggregateResult('what_works', { intro: 'Good', impressive_workflows: [{ ...workflow, evidence_session_ids: [] }] }, context), /evidence_session_ids/);
  assert.throws(() => validateAggregateResult('what_works', { intro: 'Good', impressive_workflows: [{ ...workflow, evidence_session_ids: ['foreign'] }] }, context), /unknown evidence/);
  assert.throws(() => validateAggregateResult('what_works', { intro: 'Good', impressive_workflows: [{ ...workflow, title: '' }] }, context), /non-empty string/);
  assert.throws(() => validateAggregateResult('friction_analysis', { intro: 'Issue', categories: [{ category: 'Issue', description: 'Issue', examples: [] }] }, context), /1 to 2/);
  assert.throws(() => validateAggregateResult('suggestions', { claude_md_additions: [{ addition: 'Repeat', why: 'Repeat', prompt_scaffold: 'Repeat', evidence_session_ids: ['only'] }], features_to_try: [], usage_patterns: [] }, context), /at least two sessions/);
  assert.throws(() => validateAggregateResult('suggestions', { claude_md_additions: [], features_to_try: [] }, context), /usage_patterns/);
});

test('aggregate evidence prefers canonical ids and rejects ambiguous source aliases', () => {
  const context = { sessions: [{ id: 'a', sessionId: 'shared' }, { id: 'b', sessionId: 'shared' }, { id: 'shared', sessionId: 'other' }] };
  const result = (id, sessions = context.sessions) => validateAggregateResult('interaction_style', { narrative: 'Observed.', key_pattern: 'One observation.', evidence_session_ids: [id] }, { sessions });
  assert.deepEqual(result('shared').evidenceSessionIds, ['shared']);
  assert.deepEqual(result('other').evidenceSessionIds, ['shared']);
  assert.throws(() => result('shared', context.sessions.slice(0, 2)), /ambiguous evidence session alias/);
  assert.deepEqual(result('a').evidenceSessionIds, ['a']);
});

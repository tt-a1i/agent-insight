import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { failSemanticTask, finalizeSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

function aggregateResult(task, id) {
  const evidence = { evidence_session_ids: [id] };
  const workflow = (title) => ({ title, description: `${title} description.`, ...evidence });
  const example = (text) => ({ text, ...evidence });
  const category = (name) => ({ category: name, description: `${name} description.`, examples: [example(`${name} one.`), example(`${name} two.`)] });
  const opportunity = (title) => ({ title, whats_possible: `${title} is possible.`, how_to_try: 'Start bounded.', copyable_prompt: `Try ${title}.`, ...evidence });
  const values = {
    project_areas: { areas: [{ name: 'Parser work', session_count: 1, description: 'Parser reliability.', ...evidence }] },
    interaction_style: { narrative: 'You verify changes.', key_pattern: 'Verification loops.', ...evidence },
    what_works: { intro: 'Checks work.', impressive_workflows: [workflow('One'), workflow('Two'), workflow('Three')] },
    friction_analysis: { intro: 'Some friction.', categories: [category('Tools'), category('Context'), category('Approach')] },
    suggestions: {
      claude_md_additions: [],
      features_to_try: [
        { feature: 'Custom Skills', one_liner: 'Reuse workflows.', why_for_you: 'Checks repeat.', example_code: '/test', ...evidence },
        { feature: 'Hooks', one_liner: 'Automate checks.', why_for_you: 'Checks matter.', example_code: 'hooks', ...evidence }
      ],
      usage_patterns: [
        { title: 'Gate', suggestion: 'Name checks.', detail: 'Makes done clear.', copyable_prompt: 'Finish after tests.', ...evidence },
        { title: 'Evidence', suggestion: 'Ask for proof.', detail: 'Grounds claims.', copyable_prompt: 'Show results.', ...evidence }
      ]
    },
    on_the_horizon: { intro: 'Larger loops.', opportunities: [opportunity('Release'), opportunity('Diagnosis'), opportunity('Maintenance')] },
    fun_ending: { headline: 'The parser blinked first', detail: 'The failure became green.', ...evidence },
    at_a_glance: { whats_working: 'Verification works.', whats_hindering: 'Tools fail.', quick_wins: 'Create a skill.', ambitious_workflows: 'Automate releases.', ...evidence }
  };
  return values[task];
}

function sessionAuditResult() {
  return {
    findings: [{
      category: 'acceptance_criteria',
      severity: 'high',
      evidence_posture: 'observed_instance',
      accusation: 'You patch first and define done later.',
      explanation: 'The ask jumps to a fix without stating the regression gate up front.',
      quotations: ['Fix the broken parser'],
      locators: [{ message_indexes: [1] }],
      occurrence_count: 1,
      better_alternative: 'State the failing case and the test that must pass before authorizing edits.',
      root_cause: 'implementation before acceptance criteria'
    }, {
      category: 'fragmented_requirements',
      severity: 'medium',
      evidence_posture: 'bold_inference',
      accusation: 'Scope arrives in sequel form.',
      explanation: 'A follow-up regression request appears only after the first repair lands.',
      quotations: ['Add a regression test for the parser edge case.'],
      locators: [{ message_indexes: [10] }],
      occurrence_count: null,
      better_alternative: 'Bundle the repair and the regression expectation in the first instruction.',
      root_cause: 'late requirement drip'
    }]
  };
}

function auditAggregateResult(sessionId) {
  return {
    top_three: [
      {
        category: 'acceptance_criteria',
        severity: 'high',
        evidence_posture: 'observed_instance',
        accusation: 'You patch first and define done later.',
        explanation: 'The ask jumps to a fix without stating the regression gate up front.',
        quotations: ['Fix the broken parser'],
        locators: [{ session_id: sessionId, message_indexes: [1] }],
        occurrence_count: 1,
        better_alternative: 'State the failing case and the test that must pass before authorizing edits.',
        root_cause: 'implementation before acceptance criteria'
      },
      {
        category: 'fragmented_requirements',
        severity: 'medium',
        evidence_posture: 'bold_inference',
        accusation: 'Scope arrives in sequel form.',
        explanation: 'A follow-up regression request appears only after the first repair lands.',
        quotations: ['Add a regression test for the parser edge case.'],
        locators: [{ session_id: sessionId, message_indexes: [10] }],
        occurrence_count: null,
        better_alternative: 'Bundle the repair and the regression expectation in the first instruction.',
        root_cause: 'late requirement drip'
      },
      {
        category: 'goal_clarity',
        severity: 'low',
        evidence_posture: 'bold_inference',
        accusation: 'The mission title is implied, not named.',
        explanation: 'Parser work is obvious from the ask, but success criteria stay implicit.',
        quotations: ['Fix the broken parser'],
        locators: [{ session_id: sessionId, message_indexes: [1] }],
        occurrence_count: null,
        better_alternative: 'Name the broken behavior and the observable green signal.',
        root_cause: 'implied goals'
      }
    ],
    remaining: [],
    strengths: [{
      habit: 'You harden the win with a regression ask.',
      explanation: 'After the first repair, you demand an edge-case test instead of declaring victory.',
      quotations: ['Add a regression test for the parser edge case.'],
      locators: [{ session_id: sessionId, message_indexes: [10] }]
    }],
    // One observed request cannot establish a recurring self-defeating habit.
    self_defeating_patterns: [],
    highest_leverage_change: {
      change: 'Lead with the failing case and the green bar that proves it.',
      copyable_prompt: 'Fix this parser failure and add its regression test; finish after that test passes.',
      rationale: 'One acceptance sentence collapses the patch-first habit without inventing a tracker.',
      quotations: ['Fix the broken parser'],
      locators: [{ session_id: sessionId, message_indexes: [1] }]
    },
    // This sample has no repeated multi-step workflow.
    automation_candidates: []
  };
}

async function prepareCompleteRun(home) {
  const runsRoot = join(home, 'runs');
  const prepared = await prepareSemanticRun({
    runsRoot,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30, start: null, end: null, semantic: true, fast: false },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: 'current' },
    diagnostics: [{ source: 'claude', coverage: 'available', filesFound: 1, filesSelected: 1, filesLimited: 0, filesPartial: 0, filesSkipped: 0 }]
  });
  return { runsRoot, prepared };
}

async function driveBaseline(runsRoot, runId) {
  const facetTask = await nextSemanticTask({ runsRoot, runId });
  await ingestSemanticResult({ runsRoot, runId, taskId: facetTask.id, result: {
    underlying_goal: 'Fix a parser', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved', user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful', session_type: 'single_task', friction_counts: {}, friction_detail: '', primary_success: 'good_debugging',
    brief_summary: 'Parser fixed.', evidence: [{
      message_indexes: [1],
      description: 'The user asked for a parser fix.',
      quotation: 'Fix the broken parser'
    }]
  } });
  const id = facetTask.input.opaqueId;
  const sessionId = facetTask.input.sessionId ?? id;
  while (true) {
    const task = await nextSemanticTask({ runsRoot, runId });
    if (task.kind === 'session_audit' || task.kind === 'audit_aggregate' || task.kind === 'complete') return { id, sessionId, task };
    if (task.kind === 'aggregate_batch') {
      assert.equal(task.tasks.length, 7);
      for (const item of task.tasks) await ingestSemanticResult({ runsRoot, runId, taskId: item.id, result: aggregateResult(item.section, id) });
      continue;
    }
    assert.equal(task.kind, 'aggregate');
    await ingestSemanticResult({ runsRoot, runId, taskId: task.id, result: aggregateResult(task.section, id) });
  }
}

test('a semantic run progresses through every section and finalizes a timestamped report', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-complete-'));
  const { runsRoot, prepared } = await prepareCompleteRun(home);
  const { sessionId, task: firstAudit } = await driveBaseline(runsRoot, prepared.id);
  assert.equal(firstAudit.kind, 'session_audit');
  await ingestSemanticResult({ runsRoot, runId: prepared.id, taskId: firstAudit.id, result: sessionAuditResult() });
  const aggregateAudit = await nextSemanticTask({ runsRoot, runId: prepared.id });
  assert.equal(aggregateAudit.kind, 'audit_aggregate');
  await ingestSemanticResult({
    runsRoot,
    runId: prepared.id,
    taskId: aggregateAudit.id,
    result: auditAggregateResult(sessionId)
  });
  assert.equal((await nextSemanticTask({ runsRoot, runId: prepared.id })).kind, 'complete');

  const final = await finalizeSemanticRun({ runsRoot, runId: prepared.id, outputDirectory: join(home, 'usage-data') });
  assert.equal(final.report.parity.structuralStatus, 'complete');
  assert.equal(final.report.extensions.userAudit.status, 'complete');
  assert.equal(final.report.extensions.userAudit.aggregate.topThree.length, 3);
  // Metadata outliers must never become unvalidated claims about user intent.
  assert.ok(final.report.efficiency.flagged.length > 0);
  assert.deepEqual(final.report.extensions.userAudit.aggregate.remaining, []);
  assert.equal(final.report.extensions.userAudit.aggregate.strengths.length, 1);
  assert.equal(final.report.extensions.userAudit.aggregate.selfDefeatingPatterns.length, 0);
  assert.match(final.report.extensions.userAudit.aggregate.highestLeverageChange.change, /failing case/);
  assert.deepEqual(final.report.extensions.userAudit.aggregate.automationCandidates, []);
  assert.deepEqual(final.report.coverage.eligibility, { scanned: 1, eligible: 1, excluded: 0, reasons: {} });
  assert.match(final.files.timestampedHtml, /report-\d{4}-\d{2}-\d{2}-\d{6}-[a-f0-9-]{36}\.html$/);
  const html = await readFile(final.files.timestampedHtml, 'utf8');
  assert.match(html, /At a Glance/);
  assert.match(html, /1 eligible/);
  assert.match(html, /The parser blinked first/);
  assert.match(html, /Fix the broken parser/);
  assert.match(html, /Priority findings/);
  assert.match(html, /All findings/);
  assert.match(html, /Habits that undercut you/);
  assert.match(html, /Habits worth keeping/);
  assert.match(html, /Automation candidates/);
  assert.match(html, /One highest-leverage change/);
  assert.match(html, /You patch first and define done later/);
  assert.match(html, /claude-parity/);
  assert.match(html, /\/work\/parity/);
  assert.match(final.report.privacy.note, /representative user quotations/);
  assert.equal(final.report.semantic.sessions[0].sessionId, 'claude-parity');
  assert.equal(final.report.semantic.sessions[0].projectPath, '/work/parity');
  assert.ok(html.indexOf('<h2>Priority findings</h2>') > html.indexOf('The parser blinked first'));
  assert.ok(html.indexOf('One highest-leverage change') < html.indexOf('<h2>Priority findings</h2>'));
  assert.ok(html.indexOf('Habits that undercut you') > html.indexOf('All findings'));
  assert.ok(html.indexOf('Automation candidates') > html.indexOf('Habits worth keeping'));
  assert.ok(html.indexOf('Evidence index') > html.indexOf('Automation candidates'));
  assert.ok(html.indexOf('Evidence index') > html.indexOf('One highest-leverage change'));
  assert.match(html, /This run’s one change|Try saying this next/);
  assert.ok(final.report.semantic.sessions[0].transcriptPath || final.report.semantic.sessions[0].reopenCommand);
  const outputNames = await readdir(join(home, 'usage-data'));
  assert.deepEqual(outputNames.sort(), [
    'agent-prompt.md',
    final.files.timestampedHtml.split('/').at(-1),
    'report.html',
    'report.json',
    'report.md'
  ].sort());
  assert.equal(outputNames.some((name) => /skill|command|template|automation|hooks/i.test(name)), false);
  const homeNames = await readdir(home);
  assert.equal(homeNames.includes('.claude'), false);
  assert.equal(homeNames.includes('.agents'), false);
  assert.equal(homeNames.includes('.cursor'), false);
});

test('audit task failure still finalizes the Claude baseline with explicit incomplete extension coverage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-audit-fail-'));
  const { runsRoot, prepared } = await prepareCompleteRun(home);
  const { task: auditTask } = await driveBaseline(runsRoot, prepared.id);
  assert.equal(auditTask.kind, 'session_audit');
  await failSemanticTask({ runsRoot, runId: prepared.id, taskId: auditTask.id, reason: 'invalid_analyzer_response' });
  assert.equal((await nextSemanticTask({ runsRoot, runId: prepared.id })).kind, 'complete');

  const final = await finalizeSemanticRun({ runsRoot, runId: prepared.id, outputDirectory: join(home, 'usage-data') });
  assert.equal(final.report.parity.structuralStatus, 'complete');
  assert.equal(final.report.extensions.userAudit.status, 'incomplete');
  assert.equal(final.report.extensions.userAudit.failure.reason, 'invalid_analyzer_response');
  assert.equal(final.report.coverage.extensionFailures[0].extension, 'userAudit');
  const html = await readFile(final.files.html, 'utf8');
  assert.match(html, /At a Glance/);
  assert.match(html, /The parser blinked first/);
  assert.match(html, /Priority findings/);
  assert.match(html, /User audit extension coverage is incomplete/);
  assert.match(html, /Extension coverage is partial: userAudit/);
  assert.doesNotMatch(html, /All findings/);
});

test('oversized audit aggregation reads every finding and finalizes a complete fused report', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-audit-limit-'));
  const { runsRoot, prepared } = await prepareCompleteRun(home);
  const { task } = await driveBaseline(runsRoot, prepared.id);
  const finding = sessionAuditResult().findings[0];
  await ingestSemanticResult({ runsRoot, runId: prepared.id, taskId: task.id, result: {
    findings: Array.from({ length: 20 }, (_, index) => ({ ...finding, explanation: 'x'.repeat(2000), root_cause: `distinct cause ${index}` }))
  } });
  const context = { runsRoot, runId: prepared.id };
  const seen = new Map();
  let next = await nextSemanticTask(context);
  let chunks = 0;
  while (next.kind === 'audit_aggregate_chunk') {
    assert.ok(next.request.prompt.length <= 30_000);
    assert.deepEqual(await nextSemanticTask(context), next);
    const data = JSON.parse(next.request.prompt.match(/<audit-data>\n([\s\S]*?)\n<\/audit-data>/)[1]);
    for (const session of data.sessions) for (const item of session.findings) {
      assert.equal(item.explanation.length, 2000);
      seen.set(item.rootCause, { ...item, explanation: `Supported observation for ${item.rootCause}.` });
    }
    await ingestSemanticResult({ ...context, taskId: next.id, result: { summary: 'Cumulative distinct observations, retaining their original support.', findings: [...seen.values()] } });
    chunks += 1;
    assert.ok(chunks < 30);
    next = await nextSemanticTask(context);
  }
  assert.ok(chunks > 1);
  assert.equal(seen.size, 20);
  assert.equal(next.kind, 'audit_aggregate');
  await ingestSemanticResult({ ...context, taskId: next.id, result: {
    top_three: [], remaining: [...seen.values()], strengths: [], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: []
  } });
  assert.equal((await nextSemanticTask(context)).kind, 'complete');
  const final = await finalizeSemanticRun({ runsRoot, runId: prepared.id, outputDirectory: join(home, 'usage-data') });
  assert.equal(final.report.parity.structuralStatus, 'complete');
  assert.equal(final.report.extensions.userAudit.status, 'complete');
  const aggregate = final.report.extensions.userAudit.aggregate;
  const delivered = [...aggregate.topThree, ...aggregate.remaining];
  assert.equal(delivered.length, 20);
  assert.deepEqual(new Set(delivered.map((item) => item.rootCause)), new Set(seen.keys()));
  assert.ok(delivered.every((item) => item.evidenceSessionCount === 1 && item.evidenceMessageCount === 1));
  assert.deepEqual(final.report.coverage.extensionFailures, []);
  const html = await readFile(final.files.html, 'utf8');
  assert.match(html, /The parser blinked first/);
  assert.match(html, /All findings/);
  assert.doesNotMatch(html, /User audit extension coverage is incomplete/);
});

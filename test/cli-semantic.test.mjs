import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('insights CLI asks on every invocation and prepares a current-host semantic run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-semantic-'));
  const project = join(home, '.claude', 'projects', 'project-a');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session.jsonl'), await readFile(fixture('claude-parity.jsonl')));
  const answers = ['current', '30'];
  const result = await main(['insights', '--host', 'claude'], {
    cwd: home,
    home,
    ask: async () => answers.shift(),
    quiet: true
  });

  assert.equal(result.request.scope, 'current');
  assert.equal(result.request.days, 30);
  assert.match(result.runId, /^[a-f0-9-]{36}$/);
  const manifest = JSON.parse(await readFile(join(home, '.agent-insight', 'runs', result.runId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sessions.length, 1);
  assert.equal(manifest.analyzer.host, 'claude');
});

test('prepare and semantic commands form a host-mediated analysis loop', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-loop-'));
  const project = join(home, '.claude', 'projects', 'project-a');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session.jsonl'), await readFile(fixture('claude-parity.jsonl')));

  const prepared = await main(['prepare', '--host', 'claude', '--source', 'claude', '--days', '30'], {
    cwd: home,
    home,
    quiet: true
  });
  const task = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(task.kind, 'session_facet');
  assert.match(task.submissionPath, /submission\.json$/);
  assert.equal(JSON.stringify(task.request).includes('Fix the broken parser'), true);

  await appendFile(join(project, 'session.jsonl'), `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:04:00.000Z', message: { role: 'assistant', content: 'the active host continued' } })}\n`);

  await writeFile(task.submissionPath, JSON.stringify({
    underlying_goal: 'Fix a parser',
    goal_categories: { fix_bug: 1 },
    outcome: 'fully_achieved',
    user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful',
    session_type: 'single_task',
    friction_counts: {},
    friction_detail: '',
    primary_success: 'good_debugging',
    brief_summary: 'The parser was fixed.',
    evidence: [{ message_indexes: [1], description: 'The user requested the parser fix.' }]
  }));
  const ingested = await main(['semantic', 'ingest', '--run', prepared.runId, '--task', task.id, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(ingested.outcome, 'fully_achieved');
  await assert.rejects(access(task.submissionPath), /ENOENT/);

  const next = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(next.kind, 'aggregate_batch');
  assert.ok(next.tasks.some((task) => task.id === 'aggregate:project_areas'));
});

test('semantic commands reject a host or model different from the prepared owner', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-owner-'));
  const project = join(home, '.claude', 'projects', 'project-a');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session.jsonl'), await readFile(fixture('claude-parity.jsonl')));
  const prepared = await main(['prepare', '--host', 'claude', '--model', 'model-a', '--source', 'claude', '--days', '30'], { cwd: home, home, quiet: true });
  await assert.rejects(main(['semantic', 'next', '--run', prepared.runId, '--host', 'codex', '--model', 'model-b'], { cwd: home, home, quiet: true }), /belongs to claude\/model-a/);
  const task = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'model-a'], { cwd: home, home, quiet: true });
  assert.equal(task.kind, 'session_facet');
});

test('an empty or unavailable source still produces a transparent empty report', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-empty-'));
  const prepared = await main(['prepare', '--host', 'claude', '--source', 'claude', '--days', '30'], { home, cwd: home, quiet: true });
  assert.equal((await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { home, cwd: home, quiet: true })).kind, 'complete');
  const finalized = await main(['semantic', 'finalize', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { home, cwd: home, quiet: true });
  assert.equal(finalized.report.totals.sessions, 0);
  assert.equal(finalized.report.parity.structuralStatus, 'complete');
  assert.equal(finalized.report.parity.dataStatus, 'partial');
  assert.equal(finalized.report.coverage.sourcesScanned[0].coverage, 'not_found');
});

function aggregateResult(section, id) {
  const evidence = { evidence_session_ids: [id] };
  const workflow = (title) => ({ title, description: `${title} description.`, ...evidence });
  const example = (text) => ({ text, ...evidence });
  const category = (name) => ({ category: name, description: `${name} description.`, examples: [example(`${name} one.`), example(`${name} two.`)] });
  const opportunity = (title) => ({ title, whats_possible: `${title} is possible.`, how_to_try: 'Start bounded.', copyable_prompt: `Try ${title}.`, ...evidence });
  return {
    project_areas: { areas: [{ name: 'Parser work', session_count: 1, description: 'Parser reliability.', ...evidence }] },
    interaction_style: { narrative: 'You verify changes.', key_pattern: 'Verification loops.', ...evidence },
    what_works: { intro: 'Checks work.', impressive_workflows: [workflow('One'), workflow('Two'), workflow('Three')] },
    friction_analysis: { intro: 'Some friction.', categories: [category('Tools'), category('Context'), category('Approach')] },
    suggestions: {
      claude_md_additions: [
        { addition: 'Run tests.', why: 'Repeated.', prompt_scaffold: 'Add under Testing.', ...evidence },
        { addition: 'Keep scope.', why: 'Repeated.', prompt_scaffold: 'Add under Workflow.', ...evidence }
      ],
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
  }[section];
}

async function submit(home, runId, task, result) {
  await writeFile(task.submissionPath, JSON.stringify(result));
  return main(['semantic', 'ingest', '--run', runId, '--task', task.id, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
}

test('CLI drives one complete host-mediated fused report including audit extensions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-fused-'));
  const project = join(home, '.claude', 'projects', 'project-a');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session.jsonl'), await readFile(fixture('claude-parity.jsonl')));

  const prepared = await main(['prepare', '--host', 'claude', '--source', 'claude', '--days', '30'], { cwd: home, home, quiet: true });
  const facet = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(facet.kind, 'session_facet');
  const id = facet.input.opaqueId;
  const sessionId = facet.input.sessionId ?? id;
  await submit(home, prepared.runId, facet, {
    underlying_goal: 'Fix a parser',
    goal_categories: { fix_bug: 1 },
    outcome: 'fully_achieved',
    user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful',
    session_type: 'single_task',
    friction_counts: {},
    friction_detail: '',
    primary_success: 'good_debugging',
    brief_summary: 'Parser fixed.',
    evidence: [{ message_indexes: [1], description: 'The user asked for a parser fix.', quotation: 'Fix the broken parser' }]
  });

  const batch = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(batch.kind, 'aggregate_batch');
  for (const item of batch.tasks) {
    await submit(home, prepared.runId, item, aggregateResult(item.section, id));
  }

  let audit;
  while (true) {
    const task = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
    if (task.kind === 'session_audit') {
      audit = task;
      break;
    }
    assert.equal(task.kind, 'aggregate');
    await submit(home, prepared.runId, task, aggregateResult(task.section, id));
  }
  await submit(home, prepared.runId, audit, {
    findings: [{
      category: 'acceptance_criteria',
      severity: 'high',
      evidence_posture: 'established_pattern',
      accusation: 'You patch first and define done later.',
      explanation: 'The ask jumps to a fix without stating the regression gate up front.',
      quotations: ['Fix the broken parser'],
      locators: [{ message_indexes: [1] }],
      occurrence_count: 1,
      better_alternative: 'State the failing case and the test that must pass before authorizing edits.',
      root_cause: 'implementation before acceptance criteria'
    }]
  });

  const aggregateAudit = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(aggregateAudit.kind, 'audit_aggregate');
  await submit(home, prepared.runId, aggregateAudit, {
    top_three: [{
      category: 'acceptance_criteria',
      severity: 'high',
      evidence_posture: 'established_pattern',
      accusation: 'You patch first and define done later.',
      explanation: 'The ask jumps to a fix without stating the regression gate up front.',
      quotations: ['Fix the broken parser'],
      locators: [{ session_id: sessionId, message_indexes: [1] }],
      occurrence_count: 1,
      better_alternative: 'State the failing case and the test that must pass before authorizing edits.',
      root_cause: 'implementation before acceptance criteria'
    }],
    remaining: [],
    strengths: [{
      habit: 'You harden the win with a regression ask.',
      explanation: 'After the first repair, you demand an edge-case test.',
      quotations: ['Add a regression test for the parser edge case.'],
      locators: [{ session_id: sessionId, message_indexes: [9] }]
    }],
    self_defeating_patterns: [{
      pattern: 'Fix it, then remember the test',
      intent: 'implementation before acceptance criteria',
      explanation: 'Acceptance arrives as a sequel.',
      quotations: ['Fix the broken parser'],
      locators: [{ session_id: sessionId, message_indexes: [1] }]
    }],
    highest_leverage_change: {
      change: 'Lead with the failing case and the green bar that proves it.',
      rationale: 'One acceptance sentence collapses the patch-first habit.'
    },
    automation_candidates: [{
      name: 'parser-regression-gate',
      type: 'Skill',
      trigger: 'When asking to fix a parser failure',
      frequency: 'Repeated repair-then-test sessions',
      inputs: ['failing behavior'],
      outputs: ['fix plus regression test'],
      rationale: 'Repair then regression ask is a multi-step workflow.',
      over_automation_risk: 'A canned skill could skip novel diagnosis.'
    }]
  });

  assert.equal((await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true })).kind, 'complete');
  const finalized = await main(['semantic', 'finalize', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], { cwd: home, home, quiet: true });
  assert.equal(finalized.report.extensions.userAudit.status, 'complete');
  assert.match(finalized.report.extensions.userAudit.aggregate.highestLeverageChange.change, /failing case/);
  const html = await readFile(finalized.files.html, 'utf8');
  assert.match(html, /Three hard truths/);
  assert.match(html, /Habits worth keeping/);
});

test('doctor text states the fused one-shot flow and host coverage limits', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-doctor-'));
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await main(['doctor'], { cwd: home, home, quiet: true });
  } finally {
    console.log = original;
  }
  const text = lines.join('\n');
  assert.match(text, /One-shot fused Insights/i);
  assert.match(text, /no cross-run cache/i);
  assert.match(text, /Cursor collection is experimental/i);
  assert.match(text, /OpenCode lists root sessions only/i);
  assert.match(text, /Groq is import-only/i);
  assert.match(text, /experimental local agent-transcript JSONL/);
  assert.match(text, /official CLI export \(root sessions only\)/);
});

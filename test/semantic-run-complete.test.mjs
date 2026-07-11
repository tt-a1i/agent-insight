import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FacetCache } from '../src/cache.mjs';
import { finalizeSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

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
  };
  return values[task];
}

test('a semantic run progresses through every section and finalizes a timestamped report', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-complete-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30, start: null, end: null, semantic: true, fast: false },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: 'current' },
    diagnostics: [{ source: 'claude', coverage: 'available', filesFound: 1, filesSelected: 1, filesLimited: 0, filesPartial: 0, filesSkipped: 0 }]
  });
  const facetTask = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  await ingestSemanticResult({ runsRoot, cache, runId: prepared.id, taskId: facetTask.id, result: {
    underlying_goal: 'Fix a parser', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved', user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful', session_type: 'single_task', friction_counts: {}, friction_detail: '', primary_success: 'good_debugging',
    brief_summary: 'Parser fixed.', evidence: [{ message_indexes: [1], description: 'The user asked for a parser fix.' }]
  } });
  const id = facetTask.input.opaqueId;
  while (true) {
    const task = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
    if (task.kind === 'complete') break;
    if (task.kind === 'aggregate_batch') {
      assert.equal(task.tasks.length, 7);
      for (const item of task.tasks) await ingestSemanticResult({ runsRoot, cache, runId: prepared.id, taskId: item.id, result: aggregateResult(item.section, id) });
      continue;
    }
    assert.equal(task.kind, 'aggregate');
    await ingestSemanticResult({ runsRoot, cache, runId: prepared.id, taskId: task.id, result: aggregateResult(task.section, id) });
  }

  const final = await finalizeSemanticRun({ runsRoot, runId: prepared.id, outputDirectory: join(home, 'usage-data') });
  assert.equal(final.report.parity.structuralStatus, 'complete');
  assert.deepEqual(final.report.coverage.eligibility, { scanned: 1, eligible: 1, excluded: 0, reasons: {} });
  assert.match(final.files.timestampedHtml, /report-\d{4}-\d{2}-\d{2}-\d{6}\.html$/);
  const html = await readFile(final.files.timestampedHtml, 'utf8');
  assert.match(html, /At a Glance/);
  assert.match(html, /1 eligible/);
  assert.match(html, /The parser blinked first/);
  assert.equal(html.includes('Fix the parser'), false);
});

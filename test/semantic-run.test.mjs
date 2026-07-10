import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FacetCache } from '../src/cache.mjs';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('semantic run exposes transcript only in the next task and persists only a validated facet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const run = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30, start: null, end: null, semantic: true, fast: false },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: null }
  });

  assert.match(run.id, /^[a-f0-9-]{36}$/);
  const stored = await readFile(run.manifestPath, 'utf8');
  assert.equal(stored.includes('Fix the broken parser'), false);
  assert.equal(stored.includes('I will fix and verify it'), false);
  assert.equal(stored.includes('/work/parity'), false);
  assert.equal(JSON.parse(stored).sessions[0].metrics.userMessages, 2);
  assert.equal((await stat(run.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(run.manifestPath)).mode & 0o777, 0o600);

  const task = await nextSemanticTask({ runsRoot, cache, runId: run.id });
  assert.equal(task.kind, 'session_facet');
  assert.equal(task.request.task, 'session_facet');
  assert.equal(JSON.stringify(task.input).includes('Fix the broken parser'), true);
  await ingestSemanticResult({
    runsRoot,
    cache,
    runId: run.id,
    taskId: task.id,
    result: {
      underlying_goal: 'Fix a parser',
      goal_categories: { fix_bug: 1 },
      outcome: 'fully_achieved',
      user_satisfaction_counts: { unsure: 1 },
      claude_helpfulness: 'very_helpful',
      session_type: 'single_task',
      friction_counts: {},
      friction_detail: '',
      primary_success: 'correct_code_edits',
      brief_summary: 'The parser was inspected and fixed.',
      evidence: [{ message_indexes: [1], description: 'The user requested a parser fix.' }]
    }
  });

  const completed = await getSemanticRun({ runsRoot, runId: run.id });
  assert.equal(completed.sessions[0].status, 'complete');
  assert.equal(completed.sessions[0].facet.outcome, 'fully_achieved');
  assert.equal(JSON.stringify(completed).includes('Fix the broken parser'), false);
  assert.equal((await cache.status()).entries, 1);

  const aggregate = await nextSemanticTask({ runsRoot, cache, runId: run.id });
  assert.equal(aggregate.kind, 'aggregate');
  assert.equal(aggregate.section, 'project_areas');
  assert.equal(aggregate.request.task, 'project_areas');
  assert.match(aggregate.request.prompt, /"totalMessages":2/);
  assert.equal(JSON.stringify(aggregate).includes('Fix the broken parser'), false);
  await ingestSemanticResult({
    runsRoot,
    cache,
    runId: run.id,
    taskId: aggregate.id,
    result: {
      areas: [{
        name: 'Parser work',
        session_count: 1,
        description: 'The session focused on parser correctness.',
        evidence_session_ids: [completed.sessions[0].id]
      }]
    }
  });
  assert.equal((await getSemanticRun({ runsRoot, runId: run.id })).sections.project_areas.areas[0].name, 'Parser work');
});

test('parity eligibility visibly excludes sessions with fewer than two user messages', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-eligibility-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [
      { source: 'claude', locator: { kind: 'file', path: fixture('claude.jsonl') } },
      { source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }
    ],
    analyzer: { host: 'claude', model: null }
  });

  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.sessions.filter((session) => session.status === 'excluded').length, 1);
  assert.equal(run.sessions.find((session) => session.status === 'excluded').eligibilityReason, 'fewer_than_two_user_messages');
  assert.deepEqual(run.eligibility, { scanned: 2, eligible: 1, excluded: 1, reasons: { fewer_than_two_user_messages: 1 } });
  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'session_facet');
});

test('ingest validates against the frozen task shape even if the active transcript grows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-active-'));
  const transcript = join(home, 'active.jsonl');
  await copyFile(fixture('claude-parity.jsonl'), transcript);
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: null }
  });
  const task = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:03:00.000Z', message: { role: 'assistant', content: 'new host activity' } })}\n`);

  await ingestSemanticResult({
    runsRoot,
    cache,
    runId: prepared.id,
    taskId: task.id,
    result: {
      underlying_goal: 'Fix a parser', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved',
      user_satisfaction_counts: { satisfied: 1 }, claude_helpfulness: 'very_helpful', session_type: 'single_task',
      friction_counts: {}, friction_detail: '', primary_success: 'good_debugging', brief_summary: 'Parser fixed.',
      evidence: [{ message_indexes: [1], description: 'The user asked for the parser fix.' }]
    }
  });
  assert.equal((await getSemanticRun({ runsRoot, runId: prepared.id })).sessions[0].status, 'complete');
});

test('a transcript changed before its task is exposed is excluded instead of aborting the run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-changing-'));
  const transcript = join(home, 'changing.jsonl');
  await copyFile(fixture('claude-parity.jsonl'), transcript);
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: null }
  });
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:03:00.000Z', message: { role: 'assistant', content: 'prepare command completed' } })}\n`);

  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'complete');
  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.sessions[0].status, 'excluded');
  assert.equal(run.sessions[0].eligibilityReason, 'changed_after_prepare');
});

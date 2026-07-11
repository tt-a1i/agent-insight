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

test('cache CLI reports and clears derived facet cache entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-cache-'));
  assert.deepEqual(await main(['cache', 'status'], { home, quiet: true }), { entries: 0, bytes: 0, valid: 0, invalid: 0 });
  assert.equal(await main(['cache', 'clear'], { home, quiet: true }), 0);
  await assert.rejects(main(['cache', 'rebuild'], { home, quiet: true }), /requires --host.*--model/);
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

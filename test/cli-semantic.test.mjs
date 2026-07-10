import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  const task = await main(['semantic', 'next', '--run', prepared.runId], { cwd: home, home, quiet: true });
  assert.equal(task.kind, 'session_facet');
  assert.match(task.submissionPath, /submission\.json$/);
  assert.equal(JSON.stringify(task.request).includes('Fix the broken parser'), true);

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
  const ingested = await main(['semantic', 'ingest', '--run', prepared.runId, '--task', task.id], { cwd: home, home, quiet: true });
  assert.equal(ingested.outcome, 'fully_achieved');
  await assert.rejects(access(task.submissionPath), /ENOENT/);

  const next = await main(['semantic', 'next', '--run', prepared.runId], { cwd: home, home, quiet: true });
  assert.equal(next.id, 'aggregate:project_areas');
});

test('cache CLI reports and clears derived facet cache entries', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-cache-'));
  assert.deepEqual(await main(['cache', 'status'], { home, quiet: true }), { entries: 0, bytes: 0 });
  assert.equal(await main(['cache', 'clear'], { home, quiet: true }), 0);
  assert.equal(await main(['cache', 'rebuild'], { home, quiet: true }), 0);
});

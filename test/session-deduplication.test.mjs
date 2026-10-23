import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { collectSessions } from '../src/adapters.mjs';
import { getSemanticRun, prepareSemanticRun } from '../src/semantic-run.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-dedup-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const write = async (source, name, id, project, extra = 0) => {
    const file = source === 'codex'
      ? join(home, '.codex', name.startsWith('archive') ? 'archived_sessions' : 'sessions', `${name}.jsonl`)
      : join(home, '.claude', 'projects', 'synthetic', `${name}.jsonl`);
    const turns = [
      ['user', 'Fix the parser.', 0], ['assistant', 'Investigating.', 1],
      ['user', 'Require a regression test.', 2], ['assistant', 'The tests failed.', 3],
      ...Array.from({ length: extra }, (_, index) => ['user', `Additional request ${index}`, 4 + index])
    ];
    const records = source === 'codex' ? [
      { type: 'session_meta', timestamp: '2026-07-01T09:00:00Z', payload: { id, cwd: project } },
      ...turns.map(([role, text, minute]) => ({ type: 'response_item', timestamp: `2026-07-01T09:${String(minute).padStart(2, '0')}:00Z`, payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } }))
    ] : turns.map(([role, content, minute]) => ({ type: role, sessionId: id, cwd: project, timestamp: `2026-07-01T09:${String(minute).padStart(2, '0')}:00Z`, message: { role, content } }));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${records.map(JSON.stringify).join('\n')}\n`);
    return file;
  };
  const collect = (options = {}) => collectSessions({ sources: 'codex', home, cwd: home, env: {}, days: Infinity, ...options });
  const prepare = async (collected) => {
    const runsRoot = join(home, 'runs');
    const run = await prepareSemanticRun({ runsRoot, request: { host: 'codex', sources: collected.sources, days: Infinity }, candidates: collected.analysisCandidates, diagnostics: collected.diagnostics, projectFilter: collected.projectFilter, analyzer: { host: 'codex', model: 'test' } });
    return getSemanticRun({ runsRoot, runId: run.id });
  };
  return { home, write, collect, prepare };
}

for (const source of ['codex', 'claude']) {
  test(`${source} complete duplicates remain analyzable when a richer copy is partial`, async (t) => {
    const { write, collect, prepare } = await fixture(t);
    const complete = await write(source, 'complete', 'same-native', '/work/A');
    const partial = await write(source, 'archive-partial', 'same-native', '/work/A', 15);
    for (const newer of [partial, complete]) {
      await Promise.all([partial, complete].map((path) => utimes(path, new Date('2026-07-02'), new Date('2026-07-02'))));
      await utimes(newer, new Date('2026-07-03'), new Date('2026-07-03'));
      const collected = await collect({ sources: source, maxRecords: 8 });
      assert.equal(collected.sessions.length, 1);
      assert.equal(collected.sessions[0].partial, false);
      assert.equal(collected.analysisCandidates[0].locator.path, complete);
      assert.equal(collected.diagnostics[0].filesPartial, 1);
      assert.equal(collected.diagnostics[0].coverage, 'partial');
      const run = await prepare(collected);
      assert.equal(run.sessions.length, 1);
      assert.equal(run.sessions[0].status, 'pending');
    }
  });
}

test('duplicate groups retain all project provenance before scoped exclusion and count conflicts once', async (t) => {
  const { write, collect } = await fixture(t);
  const a = await write('codex', 'project-A', 'same-native', '/work/A');
  const b = await write('codex', 'archive-project-B', 'same-native', '/work/B', 1);
  const unscoped = await collect();
  assert.equal(unscoped.sessions.length, 1);
  assert.deepEqual(new Set(unscoped.sessions[0].projectPaths), new Set(['/work/A', '/work/B']));
  assert.equal(unscoped.analysisCandidates[0].locator.path, b);
  assert.equal(unscoped.diagnostics[0].duplicateProjectConflicts, 1);
  for (const project of ['/work/A', '/work/B']) {
    const scoped = await collect({ project, inputFiles: [a, a, b] });
    assert.equal(scoped.sessions.length, 0);
    assert.equal(scoped.analysisCandidates.length, 0);
    assert.equal(scoped.projectFilter.mixedProjectExcluded, 1);
    assert.equal(scoped.diagnostics.reduce((sum, row) => sum + (row.duplicateProjectConflicts ?? 0), 0), 1);
    assert.equal(scoped.diagnostics.reduce((sum, row) => sum + (row.mixedProjectExcluded ?? 0), 0), 1);
    assert.equal(scoped.diagnostics[0].coverage, 'partial');
    assert.match(scoped.diagnostics[0].warning, /duplicate session group.*multiple known project paths/);
    assert.match(scoped.diagnostics[0].warning, /mixed-project session/);
  }
});

for (const source of ['codex', 'claude']) {
  test(`${source} scoped selection uses the complete copy that proves its own project in either traversal order`, async (t) => {
    const { write, collect, prepare } = await fixture(t);
    const known = await write(source, 'known-project', 'same-native', '/work/target');
    const unknown = await write(source, 'archive-unknown-project', 'same-native', undefined, 4);
    // A third unknown copy guards against treating an earlier union as the
    // current representative's original metadata during a later comparison.
    const anotherUnknown = await write(source, 'archive-second-unknown', 'same-native', undefined, 2);
    for (const newer of [known, unknown]) {
      await Promise.all([known, unknown, anotherUnknown].map((path) => utimes(path, new Date('2026-07-02'), new Date('2026-07-02'))));
      await utimes(newer, new Date('2026-07-03'), new Date('2026-07-03'));
      const scoped = await collect({ sources: source, project: '/work/target' });
      assert.equal(scoped.analysisCandidates.length, 1);
      assert.equal(scoped.analysisCandidates[0].locator.path, known);
      const run = await prepare(scoped);
      assert.equal(run.sessions.length, 1);
      assert.equal(run.sessions[0].projectPath, '/work/target');
      assert.equal(run.sessions[0].status, 'pending');
      assert.deepEqual(run.preparationFailures, []);
      const unscoped = await collect({ sources: source });
      assert.equal(unscoped.analysisCandidates.length, 1);
      assert.equal(unscoped.analysisCandidates[0].locator.path, unknown);
      const unscopedRun = await prepare(unscoped);
      assert.equal(unscopedRun.sessions.length, 1);
      assert.equal(unscopedRun.sessions[0].id, run.sessions[0].id);
    }
  });
}

test('one file discovered and explicitly imported is not merged as two Claude journals', async (t) => {
  const { write, collect, prepare } = await fixture(t);
  const file = await write('claude', 'single', 'same-native', '/work/A');
  const collected = await collect({ sources: 'claude', includeSubagents: true, inputFiles: [file, file] });
  assert.equal(collected.sessions.length, 1);
  assert.equal(collected.sessions[0].userMessages, 2);
  assert.equal(collected.analysisCandidates.length, 1);
  assert.equal(collected.diagnostics.some((row) => row.duplicateProjectConflicts || row.semanticExcluded), false);
  assert.equal((await prepare(collected)).sessions.length, 1);
});

test('identical active/archive copies analyze once while cross-source native IDs remain distinct', async (t) => {
  const { write, collect, prepare } = await fixture(t);
  await write('codex', 'active', 'same-native', '/work/A');
  await write('codex', 'archive-copy', 'same-native', '/work/A');
  await write('claude', 'other-source', 'same-native', '/work/B');
  const collected = await collect({ sources: 'codex,claude' });
  assert.equal(collected.sessions.length, 2);
  assert.equal(collected.analysisCandidates.length, 2);
  assert.equal(collected.diagnostics.some((row) => row.duplicateProjectConflicts), false);
  const run = await prepare(collected);
  assert.equal(run.sessions.length, 2);
  assert.equal(new Set(run.sessions.map((session) => session.id)).size, 2);
});

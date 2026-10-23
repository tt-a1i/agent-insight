import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectSessions } from '../src/adapters.mjs';
import { main } from '../src/cli.mjs';
import { finalizeSemanticRun, getSemanticRun, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const anchor = Date.parse('2026-07-04T00:00:00.000Z');

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-semantic-scope-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, '.claude', 'projects', 'synthetic');
  await mkdir(directory, { recursive: true });
  const record = (id, timestamp, content) => ({ type: 'user', sessionId: id, cwd: join(home, 'project'), timestamp, message: { role: 'user', content } });
  const write = async (id, lastTimestamp = '2026-07-03T09:02:00.000Z') => {
    const path = join(directory, `${id}.jsonl`);
    const records = [record(id, new Date(Date.parse(lastTimestamp) - 120_000).toISOString(), 'First synthetic request.'), record(id, lastTimestamp, 'Second synthetic request.')];
    await writeFile(path, `${records.map(JSON.stringify).join('\n')}\n`);
    return path;
  };
  const collect = (options = {}) => collectSessions({ sources: 'claude', home, cwd: home, env: {}, days: 30, now: anchor, ...options });
  const prepare = async (collected, request = {}) => {
    const runsRoot = join(home, 'runs');
    const run = await prepareSemanticRun({
      runsRoot,
      request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30, selectedAt: new Date(anchor).toISOString(), ...request },
      candidates: collected.analysisCandidates, diagnostics: collected.diagnostics,
      analyzer: { host: 'claude', model: 'scope-test' }
    });
    return { runsRoot, runId: run.id };
  };
  return { home, directory, record, write, collect, prepare };
}

test('semantic preparation rejects a damaged tail added after collection and finalizes explicit partial coverage', async (t) => {
  const f = await fixture(t);
  const file = await f.write('damaged-tail');
  const collected = await f.collect();
  assert.equal(collected.diagnostics[0].coverage, 'available');
  await appendFile(file, '{"type":"user","message":{"role":"user","content":"The verification failed');
  const args = await f.prepare(collected);
  const run = await getSemanticRun(args);
  assert.equal(run.sessions.length, 0);
  assert.deepEqual(run.preparationFailures, [{ source: 'claude', reason: 'incomplete_transcript' }]);
  assert.equal(run.diagnostics[0].coverage, 'partial');
  assert.equal(run.diagnostics[0].semanticFailures, 1);
  assert.equal((await nextSemanticTask(args)).kind, 'complete');
  const final = await finalizeSemanticRun({ ...args, outputDirectory: join(f.home, 'out') });
  assert.equal(final.report.parity.dataStatus, 'partial');
  assert.equal(final.report.totals.sessions, 0);
  assert.equal(final.report.coverage.eligibility.reasons.incomplete_transcript, 1);
  assert.equal(final.report.coverage.selectedAt, new Date(anchor).toISOString());
});

test('semantic preparation rechecks custom and anchored rolling scope after a session changes', async (t) => {
  for (const custom of [false, true]) {
    const f = await fixture(t);
    const file = await f.write('scope-change');
    const scope = custom ? { days: null, start: '2026-07-03', end: '2026-07-03' } : { days: 30 };
    const collected = await f.collect(scope);
    assert.equal(collected.analysisCandidates.length, 1);
    await appendFile(file, `${JSON.stringify(f.record('scope-change', '2026-07-04T10:00:00Z', 'Outside the frozen requested window.'))}\n`);
    const args = await f.prepare(collected, scope);
    const run = await getSemanticRun(args);
    assert.deepEqual(run.preparationFailures, [{ source: 'claude', reason: 'time_scope_mismatch' }]);
    assert.equal(run.sessions.length, 0);
    assert.equal(run.diagnostics[0].coverage, 'partial');
    assert.equal((await nextSemanticTask(args)).kind, 'complete');
  }
});

test('custom scope is rechecked even for callers without a rolling-window anchor', async (t) => {
  const f = await fixture(t);
  await f.write('outside-day', '2026-07-04T10:00:00Z');
  const collected = await f.collect({ days: Infinity, now: anchor + 86_400_000 });
  const args = await f.prepare({ ...collected, diagnostics: [] }, { days: null, selectedAt: undefined, start: '2026-07-03', end: '2026-07-03' });
  const run = await getSemanticRun(args);
  assert.deepEqual(run.preparationFailures, [{ source: 'claude', reason: 'time_scope_mismatch' }]);
  assert.equal(run.diagnostics[0].source, 'claude');
  assert.equal(run.diagnostics[0].coverage, 'partial');
});

test('rolling and all-history selection exclude future records while custom dates retain UTC boundaries', async (t) => {
  const f = await fixture(t);
  await f.write('older', '2026-07-02T23:59:59.999Z');
  await f.write('lower-boundary', '2026-07-03T00:00:00.000Z');
  await f.write('custom-end', '2026-07-03T23:59:59.999Z');
  await f.write('anchor', '2026-07-04T00:00:00.000Z');
  await f.write('future', '2026-07-04T00:00:00.001Z');
  const ids = (result) => result.sessions.map((session) => session.id).sort();
  assert.deepEqual(ids(await f.collect({ days: 1 })), ['anchor', 'custom-end', 'lower-boundary']);
  assert.deepEqual(ids(await f.collect({ days: Infinity })), ['anchor', 'custom-end', 'lower-boundary', 'older']);
  assert.deepEqual(ids(await f.collect({ start: '2026-07-03', end: '2026-07-03' })), ['custom-end', 'lower-boundary']);
  // Explicit custom dates may request dates later than the collection clock.
  assert.deepEqual(ids(await f.collect({ start: '2026-07-04', end: '2026-07-04' })), ['anchor', 'future']);
});

test('CLI checkpoints the collection anchor and resumed finalization does not move it to report generation time', async (t) => {
  const f = await fixture(t);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(f.home, '.claude');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const context = { home: f.home, cwd: f.home, now: anchor, quiet: true };
  const prepared = await main(['prepare', '--host', 'claude', '--days', '7'], context);
  const run = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
  assert.equal(run.request.selectedAt, new Date(anchor).toISOString());
  const final = await main(['semantic', 'finalize', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown', '--output', join(f.home, 'out')], { ...context, now: anchor + 30 * 86_400_000 });
  assert.equal(final.report.coverage.selectedAt, run.request.selectedAt);
  assert.equal(final.report.coverage.requestedDays, 7);
  const persisted = JSON.parse(await readFile(final.files.json, 'utf8'));
  assert.equal(persisted.coverage.selectedAt, run.request.selectedAt);

  const legacy = await f.prepare({ analysisCandidates: [], diagnostics: [] }, { selectedAt: undefined });
  const oldFinal = await finalizeSemanticRun({ ...legacy, outputDirectory: join(f.home, 'legacy-out') });
  assert.equal(oldFinal.report.coverage.selectedAt, null);
});

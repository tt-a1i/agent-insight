import assert from 'node:assert/strict';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectSessions } from '../src/adapters.mjs';
import { main } from '../src/cli.mjs';
import { summarizeSessions } from '../src/analyze.mjs';
import { getSemanticRun, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-project-scope-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.claude', 'projects', 'synthetic');
  await mkdir(root, { recursive: true });
  const write = async (id, project, date = '2026-07-03', directory = root) => {
    await mkdir(directory, { recursive: true });
    const file = join(directory, `${id}.jsonl`);
    const records = ['00', '02'].map((minute) => ({
      type: 'user', sessionId: id, ...(project ? { cwd: project } : {}),
      timestamp: `${date}T09:${minute}:00.000Z`,
      message: { role: 'user', content: `Synthetic request ${id} at ${minute}.` }
    }));
    await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    return file;
  };
  return { home, root, write };
}

test('prepare and insights apply relative project scope to next tasks and retain it through finalize', async (t) => {
  const { home, write } = await fixture(t);
  const target = join(home, 'projects', 'target');
  await write('target', target);
  await write('child', join(target, 'child'));
  await write('other', join(home, 'projects', 'other'));
  await write('prefix-sibling', `${target}-other`);
  await write('unknown', null);
  // Keep this CLI exercise isolated even on machines with a custom Claude home.
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const context = { home, cwd: home, now: Date.parse('2026-07-04T00:00:00Z'), quiet: true };
  const expectedFilter = { requested: true, path: target, unknownProjectExcluded: 1, mixedProjectExcluded: 0 };
  for (const command of ['prepare', 'insights']) {
    const answers = ['current', 'all'];
    const prepared = await main([command, '--host', 'claude', '--all', '--project', 'projects/target'], {
      ...context, ask: async () => answers.shift()
    });
    let manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
    assert.equal(manifest.request.project, target);
    assert.deepEqual(manifest.projectFilter, expectedFilter);
    assert.deepEqual(manifest.sessions.map((session) => session.sessionId).sort(), ['child', 'target']);
    const seen = [];
    for (let index = 0; index < 2; index += 1) {
      const task = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown'], context);
      assert.equal(task.kind, 'session_facet');
      seen.push(task.input.sessionId);
      await main(['semantic', 'fail', '--run', prepared.runId, '--task', task.id, '--host', 'claude', '--model', 'unknown'], context);
    }
    assert.deepEqual(seen.sort(), ['child', 'target']);
    const final = await main(['semantic', 'finalize', '--run', prepared.runId, '--host', 'claude', '--model', 'unknown', '--output', join(home, `out-${command}`)], context);
    assert.deepEqual(final.report.coverage.projectFilter, expectedFilter);
    const persisted = JSON.parse(await readFile(final.files.json, 'utf8'));
    assert.deepEqual(persisted.coverage.projectFilter, expectedFilter);
    manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
    assert.deepEqual(manifest.projectFilter, expectedFilter);
  }
});

test('bounded candidate selection warns that project and date matches may remain unread', async (t) => {
  const { home, write } = await fixture(t);
  const target = join(home, 'target');
  const inside = await write('inside', target);
  const outside = await write('outside', join(home, 'other'), '2026-01-01');
  await utimes(inside, new Date('2020-01-01'), new Date('2020-01-01'));
  await utimes(outside, new Date('2026-07-04'), new Date('2026-07-04'));
  const options = { home, cwd: home, env: {}, sources: 'claude', days: Infinity, project: 'target', start: '2026-07-01', end: '2026-07-04' };
  const capped = await collectSessions({ ...options, maxSessionsPerSource: 1 });
  assert.equal(capped.sessions.length, 0);
  assert.equal(capped.diagnostics[0].filesSelected, 1);
  assert.equal(capped.diagnostics[0].filesLimited, 1);
  assert.equal(capped.diagnostics[0].coverage, 'partial');
  assert.match(capped.diagnostics[0].warning, /before session date and project filtering/);
  const full = await collectSessions({ ...options, maxSessionsPerSource: 2 });
  assert.deepEqual(full.sessions.map((session) => session.id), ['inside']);
  assert.equal(full.projectFilter.path, target);
});

test('merged subagent metadata explicitly excludes unsupported semantic candidates', async (t) => {
  const { home, root, write } = await fixture(t);
  const target = join(home, 'target');
  await write('main', target);
  await write('main', target, '2026-07-03', join(root, 'main', 'subagents'));
  const result = await collectSessions({ home, cwd: home, env: {}, sources: 'claude', days: Infinity, includeSubagents: true });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessages, 4);
  assert.equal(result.sessions[0].semanticExclusionReason, 'merged_subagent_transcripts');
  assert.deepEqual(result.analysisCandidates, []);
  assert.equal(result.diagnostics[0].coverage, 'partial');
  assert.equal(result.diagnostics[0].semanticExcluded, 1);
  assert.match(result.diagnostics[0].warning, /excluded from semantic analysis/);
  await assert.rejects(main(['prepare', '--host', 'claude', '--include-subagents'], { home, cwd: home, quiet: true }), /does not support --include-subagents/);
  await assert.rejects(main(['prepare', '--host', 'claude', '--project'], { home, cwd: home, quiet: true }), /--project requires a non-empty path/);
});

test('merged subagent journals retain scalar token subtotals without inheriting one file’s complete coverage', async (t) => {
  const { home, root, write } = await fixture(t);
  const target = join(home, 'target');
  const mainFile = await write('main', target);
  const childFile = await write('main', target, '2026-07-03', join(root, 'main', 'subagents'));
  for (const [file, input, output] of [[mainFile, 10, 2], [childFile, 20, 3]]) {
    await appendFile(file, `${JSON.stringify({
      type: 'assistant', sessionId: 'main', timestamp: '2026-07-03T09:03:00.000Z',
      message: { role: 'assistant', content: 'Synthetic work.', usage: {
        input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
      } }
    })}\n`);
  }
  const options = { home, cwd: home, env: {}, sources: 'claude', days: Infinity };
  const single = await collectSessions(options);
  assert.equal(single.sessions[0].tokenUsage.coverage, 'complete');
  assert.equal(single.sessions[0].tokenUsage.totalTokens, 12);
  const merged = await collectSessions({ ...options, includeSubagents: true });
  assert.equal(merged.sessions.length, 1);
  assert.equal(merged.sessions[0].inputTokens, 30);
  assert.equal(merged.sessions[0].outputTokens, 5);
  assert.equal(Object.hasOwn(merged.sessions[0], 'tokenUsage'), false);
  assert.equal(merged.diagnostics[0].coverage, 'partial');
  assert.equal(merged.diagnostics[0].semanticExcluded, 1);
});

async function writeCodex(file, id, firstProject, secondProject, prefix = id) {
  await mkdir(join(file, '..'), { recursive: true });
  const records = [
    { type: 'session_meta', timestamp: '2026-07-03T09:00:00Z', payload: { id, cwd: firstProject } },
    { type: 'response_item', timestamp: '2026-07-03T09:00:00Z', payload: { role: 'user', content: [{ type: 'input_text', text: `${prefix}_FIRST_QUOTE` }] } },
    { type: 'turn_context', timestamp: '2026-07-03T09:02:00Z', payload: { cwd: secondProject } },
    { type: 'response_item', timestamp: '2026-07-03T09:03:00Z', payload: { role: 'user', content: [{ type: 'input_text', text: `${prefix}_SECOND_QUOTE` }] } }
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
}

test('cross-project sessions are counted and excluded before CLI next, while root-to-child sessions remain eligible', async (t) => {
  const { home } = await fixture(t);
  const projectA = join(home, 'a');
  const projectB = join(home, 'b');
  const codexHome = join(home, '.codex');
  const crossFile = join(codexHome, 'sessions', 'cross.jsonl');
  const childFile = join(codexHome, 'sessions', 'child.jsonl');
  await writeCodex(crossFile, 'cross', projectA, projectB, 'CROSS');
  await writeCodex(childFile, 'child', projectA, join(projectA, 'child'), 'CHILD');
  const collected = await collectSessions({ home, cwd: home, env: {}, sources: 'codex', days: Infinity, project: projectB });
  assert.deepEqual(collected.sessions, []);
  assert.equal(collected.projectFilter.mixedProjectExcluded, 1);
  assert.equal(collected.diagnostics[0].mixedProjectExcluded, 1);
  assert.equal(collected.diagnostics[0].coverage, 'partial');
  assert.match(collected.diagnostics[0].warning, /mixed-project session/);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  });
  const context = { home, cwd: home, quiet: true };
  const prepared = await main(['prepare', '--host', 'codex', '--all', '--project', projectA], context);
  const manifest = JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
  assert.deepEqual(manifest.sessions.map((session) => session.sessionId), ['child']);
  assert.equal(manifest.projectFilter.mixedProjectExcluded, 1);
  const task = await main(['semantic', 'next', '--run', prepared.runId, '--host', 'codex', '--model', 'unknown'], context);
  assert.equal(task.kind, 'session_facet');
  assert.equal(task.input.sessionId, 'child');
  assert.match(JSON.stringify(task.input), /CHILD_FIRST_QUOTE/);
  assert.match(JSON.stringify(task.input), /CHILD_SECOND_QUOTE/);
  assert.doesNotMatch(JSON.stringify(task), /CROSS_FIRST_QUOTE|CROSS_SECOND_QUOTE/);
  const direct = await prepareSemanticRun({
    runsRoot: join(home, 'direct-runs'), request: { host: 'codex', sources: ['codex'], project: projectA, days: Infinity },
    candidates: [{ source: 'codex', locator: { kind: 'file', path: crossFile } }], analyzer: { host: 'codex', model: 'test' }
  });
  const rejected = await getSemanticRun({ runsRoot: join(home, 'direct-runs'), runId: direct.id });
  assert.deepEqual(rejected.sessions, []);
  assert.equal(rejected.preparationFailures[0].reason, 'project_scope_mismatch');
  assert.equal(rejected.diagnostics[0].coverage, 'partial');
  assert.equal((await nextSemanticTask({ runsRoot: join(home, 'direct-runs'), runId: direct.id })).kind, 'complete');
});

test('prepare rechecks project scope after collection and rejects conflicting API scope declarations', async (t) => {
  const { home } = await fixture(t);
  const projectA = join(home, 'a');
  const projectB = join(home, 'b');
  const file = join(home, '.codex', 'sessions', 'changed.jsonl');
  await writeCodex(file, 'changed', projectA, projectA);
  const collected = await collectSessions({ home, cwd: home, env: {}, sources: 'codex', days: Infinity, project: projectA });
  assert.equal(collected.analysisCandidates.length, 1);
  await writeCodex(file, 'changed', projectB, projectB, 'OUTSIDE');
  const runsRoot = join(home, 'runs');
  const options = { runsRoot, request: { host: 'codex', sources: ['codex'], project: projectA, days: Infinity },
    candidates: collected.analysisCandidates, diagnostics: collected.diagnostics,
    projectFilter: collected.projectFilter, analyzer: { host: 'codex', model: 'test' } };
  const prepared = await prepareSemanticRun(options);
  const manifest = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.deepEqual(manifest.sessions, []);
  assert.equal(manifest.preparationFailures[0].reason, 'project_scope_mismatch');
  assert.equal(manifest.diagnostics[0].coverage, 'partial');
  assert.equal(manifest.eligibility.reasons.project_scope_mismatch, 1);
  const next = await nextSemanticTask({ runsRoot, runId: prepared.id });
  assert.equal(next.kind, 'complete');
  assert.doesNotMatch(JSON.stringify(next), /OUTSIDE/);
  await assert.rejects(prepareSemanticRun({ ...options, projectFilter: { ...collected.projectFilter, path: projectB } }), /same project scope/);
});

test('report, prepare and insights reject bare or empty project flags before writing outputs', async (t) => {
  const { home } = await fixture(t);
  for (const command of ['report', 'prepare', 'insights']) {
    for (const projectArgs of [['--project'], ['--project='], ['--project', '   ']]) {
      const output = join(home, `output-${command}`);
      await assert.rejects(main([command, '--host', 'codex', ...projectArgs, '--output', output], {
        home, cwd: home, quiet: true, ask: async () => { throw new Error('Project validation must precede prompts.'); }
      }), /--project requires a non-empty path/);
      await assert.rejects(access(output), /ENOENT/);
      await assert.rejects(access(join(home, '.agent-insight', 'runs')), /ENOENT/);
    }
  }
});

test('OpenCode and explicit imports count attempted reads before project filtering', async (t) => {
  const { home, write } = await fixture(t);
  const projectA = join(home, 'a');
  const projectB = join(home, 'b');
  const exported = [];
  const runner = async (args) => {
    if (args[0] === 'session') return JSON.stringify([{ id: 'a' }, { id: 'b' }]);
    exported.push(args[1]);
    return JSON.stringify({ info: { id: args[1], directory: args[1] === 'a' ? projectA : projectB,
      time: { created: Date.parse('2026-07-03T09:00:00Z'), updated: Date.parse('2026-07-03T09:03:00Z') } }, messages: [] });
  };
  const options = { home, cwd: home, env: {}, days: Infinity, project: projectA };
  const openCode = await collectSessions({ ...options, sources: 'opencode', openCodeRunner: runner });
  assert.deepEqual(exported, ['a', 'b']);
  assert.deepEqual(openCode.sessions.map((session) => session.id), ['a']);
  assert.equal(openCode.diagnostics[0].filesSelected, 2);
  assert.equal(summarizeSessions(openCode.sessions, { sourcesScanned: openCode.diagnostics }).insights.totalSessionsScanned, 2);
  const file = await write('explicit-other', projectB, '2026-07-03', join(home, 'exports'));
  const explicit = await collectSessions({ ...options, sources: 'generic', inputFiles: [file] });
  assert.deepEqual(explicit.sessions, []);
  assert.equal(explicit.diagnostics.at(-1).filesSelected, 1);
  assert.equal(summarizeSessions(explicit.sessions, { sourcesScanned: explicit.diagnostics }).insights.totalSessionsScanned, 1);
});

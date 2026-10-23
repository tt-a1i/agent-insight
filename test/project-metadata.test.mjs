import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseSessionFile } from '../src/parse.mjs';
import { extractAnalysisInput } from '../src/transcript.mjs';

async function project(t, records, source = 'codex') {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-project-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'journal.jsonl');
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  const session = await parseSessionFile(file, source);
  const input = await extractAnalysisInput(file, source);
  assert.equal(session.project, input.projectPath);
  assert.deepEqual(session.projectPaths, input.projectPaths);
  return { session, input };
}

const user = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

for (const [description, next] of [['another project', '/work/B'], ['a child directory', '/work/A/child']]) {
  test(`Codex project change to ${description} preserves every cwd and a consistent primary project`, async (t) => {
    const { session, input } = await project(t, [
      { type: 'session_meta', payload: { id: 'project-change', cwd: '/work/A' } },
      user('Work in the first directory.'),
      { type: 'turn_context', payload: { cwd: next } },
      user('Continue after changing directory.')
    ]);
    assert.equal(session.project, '/work/A');
    assert.deepEqual(session.projectPaths, ['/work/A', next]);
    assert.equal(input.messages.length, 2);
  });
}

test('repeated project metadata is deduplicated in first-seen order', async (t) => {
  const { session } = await project(t, [
    { type: 'session_meta', payload: { id: 'project-duplicate', cwd: ' /work/A ' } },
    { type: 'turn_context', cwd: '/work/A', payload: { cwd: '/work/A' } },
    user('Keep working in this project.')
  ]);
  assert.equal(session.project, '/work/A');
  assert.deepEqual(session.projectPaths, ['/work/A']);
});

test('absent project metadata remains unknown and is never inferred from user text', async (t) => {
  const { session, input } = await project(t, [user('Please inspect /work/A and /work/B in this quoted example.')]);
  assert.equal(session.project, null);
  assert.equal(input.projectPath, null);
  assert.deepEqual(session.projectPaths, []);
  assert.equal(input.projectLabel, 'unknown');
});

test('collection and projection read the same known project path aliases', async (t) => {
  const { session } = await project(t, [
    { type: 'session_meta', payload: { id: 'project-aliases', projectPath: '/work/A', project_path: '/work/A/nested' } },
    { type: 'turn_context', workspace: '/work/B' },
    { type: 'user', message: { role: 'user', cwd: '/work/C', content: 'Inspect the project metadata.' } }
  ]);
  assert.equal(session.project, '/work/A');
  assert.deepEqual(session.projectPaths, ['/work/A', '/work/A/nested', '/work/B', '/work/C']);
});

test('Pi project provenance follows only the active parent chain', async (t) => {
  const { session } = await project(t, [
    { type: 'session', version: 3, id: 'pi-project-branch', cwd: '/work/A', timestamp: '2026-10-22T00:00:00Z' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Start in this project.' } },
    { type: 'message', id: 'old', parentId: 'root', cwd: '/work/discarded', message: { role: 'user', content: 'Discarded branch.' } },
    { type: 'message', id: 'active', parentId: 'root', cwd: '/work/A/child', message: { role: 'user', content: 'Current branch.' } }
  ], 'pi');
  assert.deepEqual(session.projectPaths, ['/work/A', '/work/A/child']);
});

test('Claude project provenance excludes unselected sibling branches', async (t) => {
  const record = (uuid, parentUuid, cwd, content) => ({ type: 'user', uuid, parentUuid, cwd, sessionId: 'claude-project-branch', message: { role: 'user', content } });
  const { session } = await project(t, [
    record('root', null, '/work/A', 'Start in this project.'),
    record('active', 'root', '/work/A/child', 'Winning branch request.'),
    record('active-next', 'active', '/work/A/child', 'Winning branch follow-up.'),
    record('old', 'root', '/work/discarded', 'Discarded sibling.')
  ], 'claude');
  assert.deepEqual(session.projectPaths, ['/work/A', '/work/A/child']);
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { main } from '../src/cli.mjs';

const exec = promisify(execFile);

test('the printed Next command preserves model identity through a real POSIX shell', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-command-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = join(home, '.claude', 'projects', 'synthetic');
  const bin = join(home, 'bin');
  await mkdir(root, { recursive: true });
  await mkdir(bin);
  await writeFile(join(root, 'session.jsonl'), [0, 120_000].map((offset) => JSON.stringify({
    type: 'user', sessionId: 'synthetic-command',
    timestamp: new Date(Date.now() - 300_000 + offset).toISOString(),
    message: { role: 'user', content: 'Verify the parser regression.' }
  })).join('\n'));
  // Resolve only this product CLI, using an argv-preserving shim. No agent host
  // executable is started by the copied Next command.
  await writeFile(join(bin, 'agent-insight'), '#!/bin/sh\nexec "$TEST_NODE" "$TEST_ENTRY" "$@"\n');
  await chmod(join(bin, 'agent-insight'), 0o700);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  try {
    for (const model of ["provider model's=variant==revision", 'model=revision==two', 'ordinary-model-v1', undefined]) {
      const lines = [];
      const original = console.log;
      const answers = ['current', 'all'];
      console.log = (...args) => lines.push(args.join(' '));
      try {
        await main(['insights', '--host', 'claude', ...(model === undefined ? [] : ['--model', model])], {
          home, cwd: home, ask: async () => answers.shift()
        });
      } finally { console.log = original; }
      const line = lines.find((value) => value.startsWith('Next: '));
      assert.ok(line);
      const { stdout, stderr } = await exec('/bin/sh', ['-c', line.slice(6)], {
        cwd: home,
        env: {
          ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
          PATH: `${bin}:${process.env.PATH}`, TEST_NODE: process.execPath,
          TEST_ENTRY: fileURLToPath(new URL('../bin/agent-insight.mjs', import.meta.url))
        }
      });
      // The host/model ownership gate proves the copied value survived intact.
      assert.equal(JSON.parse(stdout).kind, 'session_facet');
      assert.equal(stderr, '');
    }
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

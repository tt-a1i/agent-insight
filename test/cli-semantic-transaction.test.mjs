import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';

async function preparedSubmission(t) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cli-transaction-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, '.claude', 'projects', 'project-a');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'session.jsonl'), await readFile(new URL('./fixtures/claude-parity.jsonl', import.meta.url)));
  const context = { cwd: home, home, now: Date.parse('2026-07-04T00:00:00Z'), quiet: true };
  const prepared = await main(['prepare', '--host', 'claude', '--days', '30'], context);
  const args = ['--run', prepared.runId, '--host', 'claude', '--model', 'unknown'];
  const task = await main(['semantic', 'next', ...args], context);
  await writeFile(task.submissionPath, JSON.stringify({
    underlying_goal: 'Fix a parser', goal_categories: { fix_bug: 1 },
    outcome: 'fully_achieved', user_satisfaction_counts: { satisfied: 1 },
    claude_helpfulness: 'very_helpful', session_type: 'single_task',
    friction_counts: {}, friction_detail: '', primary_success: 'good_debugging',
    brief_summary: 'The parser was fixed.',
    evidence: [{ message_indexes: [1], description: 'The user requested the parser fix.' }]
  }));
  return { home, context, prepared, task, args };
}

function runIngestChild(t, prepared, mode) {
  // Inject only the cleanup operation in a separate real process. All state
  // transitions, checkpoint writes, locks and CLI calls use production code.
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const [home, runId, taskId, submissionPath, mode] = process.argv.slice(1);
    const unlink = fs.promises.unlink;
    fs.promises.unlink = async (path) => {
      if (mode === 'lock-fail' && String(path).includes('/.run-lock/owner-')) {
        throw Object.assign(new Error('injected lock cleanup denial'), { code: 'EACCES' });
      }
      if (path === submissionPath && mode === 'fail') throw Object.assign(new Error('injected cleanup denial'), { code: 'EACCES' });
      if (path === submissionPath && mode === 'pause') {
        const resume = new Promise(resolve => process.once('message', resolve));
        process.send({ phase: 'cleanup' });
        await resume;
      }
      return unlink(path);
    };
    syncBuiltinESMExports();
    const { main } = await import(${JSON.stringify(new URL('../src/cli.mjs', import.meta.url).href)});
    const result = await main(['semantic', 'ingest', '--run', runId, '--task', taskId,
      '--host', 'claude', '--model', 'unknown'], { home, cwd: home, quiet: true });
    process.stdout.write(JSON.stringify(result));
    if (process.connected) process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script,
    prepared.home, prepared.prepared.runId, prepared.task.id, prepared.task.submissionPath, mode],
  { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  });
  return { child, result: async () => {
    const [code] = await closed;
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  } };
}

test('CLI retains the run transaction until accepted submission cleanup finishes', { timeout: 20_000 }, async (t) => {
  const prepared = await preparedSubmission(t);
  const running = runIngestChild(t, prepared, 'pause');
  const [message] = await once(running.child, 'message');
  assert.equal(message.phase, 'cleanup');
  await assert.rejects(main(['semantic', 'next', ...prepared.args], prepared.context),
    { code: 'ERR_SEMANTIC_RUN_BUSY' });
  await access(prepared.task.submissionPath);
  running.child.send({ resume: true });
  assert.equal((await running.result()).outcome, 'fully_achieved');
  await assert.rejects(access(prepared.task.submissionPath), { code: 'ENOENT' });
  assert.equal((await main(['semantic', 'next', ...prepared.args], prepared.context)).kind, 'aggregate_batch');
});

test('CLI reports accepted results with a cleanup warning when submission unlink fails', { timeout: 20_000 }, async (t) => {
  const prepared = await preparedSubmission(t);
  const value = await runIngestChild(t, prepared, 'fail').result();
  assert.equal(value.outcome, 'fully_achieved');
  assert.equal(value.submissionCleanupWarning.code, 'EACCES');
  assert.match(value.submissionCleanupWarning.message, /Result accepted/);
  await access(prepared.task.submissionPath);
  assert.equal((await main(['semantic', 'next', ...prepared.args], prepared.context)).kind, 'aggregate_batch');
});

test('CLI preserves accepted results when releasing the run lock fails', { timeout: 20_000 }, async (t) => {
  const prepared = await preparedSubmission(t);
  const value = await runIngestChild(t, prepared, 'lock-fail').result();
  assert.equal(value.outcome, 'fully_achieved');
  assert.equal(value.lockCleanupWarning.code, 'EACCES');
  await assert.rejects(access(prepared.task.submissionPath), { code: 'ENOENT' });
  // The child has exited: a subsequent CLI call can recover its remaining lock
  // and proceed without re-submitting the already accepted facet.
  assert.equal((await main(['semantic', 'next', ...prepared.args], prepared.context)).kind, 'aggregate_batch');
});

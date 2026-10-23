import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireRunLock, DirectoryLockCleanupError, withDirectoryLock, withRunLock } from '../src/run-lock.mjs';

const moduleURL = new URL('../src/run-lock.mjs', import.meta.url).href;
const childCode = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const options = JSON.parse(process.argv[1]);
const receive = () => new Promise(resolve => process.once('message', resolve));
if (options.mode === 'init') {
  const original = fs.writeFile;
  fs.writeFile = async (...args) => {
    if (String(args[0]).includes('.run-lock-init-')) {
      process.send({event:'initializing'});
      await receive();
    }
    return original(...args);
  };
  syncBuiltinESMExports();
}
const {acquireRunLock} = await import(options.moduleURL);
if (options.mode === 'contend') { process.send({event:'ready'}); await receive(); }
try {
  const lock = await acquireRunLock(options.directory);
  process.send({event:'acquired', token:lock.token});
  await receive();
  await lock.release();
  process.send({event:'released'});
  process.exit(0);
} catch (error) { process.send({event:'error',code:error.code,message:error.message}); process.exit(1); }
`;

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function child(t, directory, mode = 'hold') {
  const process_ = spawn(process.execPath, ['--input-type=module', '-e', childCode, JSON.stringify({ directory, mode, moduleURL })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const messages = [];
  const waiting = [];
  let stderr = '';
  process_.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => process_.once('exit', (code, signal) => resolve({ code, signal, stderr })));
  process_.on('message', (message) => {
    messages.push(message);
    for (const item of [...waiting]) if (item.events.includes(message.event)) {
      waiting.splice(waiting.indexOf(item), 1);
      item.resolve(message);
    }
  });
  t.after(() => { if (process_.exitCode === null && process_.signalCode === null) process_.kill('SIGKILL'); });
  return {
    process_, exited,
    send: () => process_.send('continue'),
    wait: (...events) => messages.some((message) => events.includes(message.event))
      ? Promise.resolve(messages.find((message) => events.includes(message.event)))
      : new Promise((resolve) => waiting.push({ events, resolve }))
  };
}

test('run lock fails fast for a live process and releases after an operation error', async (t) => {
  const directory = await root(t);
  const owner = child(t, directory);
  const held = await owner.wait('acquired');
  await assert.rejects(acquireRunLock(directory), { code: 'ERR_SEMANTIC_RUN_BUSY' });
  const filename = `owner-${held.token}.json`;
  assert.equal((await stat(join(directory, '.run-lock', filename))).mode & 0o777, 0o600);
  owner.send();
  assert.equal((await owner.exited).code, 0);
  await assert.rejects(withRunLock(directory, async () => { throw new Error('operation failed'); }), /operation failed/);
  await withRunLock(directory, async () => {});
  await assert.rejects(access(join(directory, '.run-lock')), { code: 'ENOENT' });
});

test('a crashed owner is recovered and concurrent reapers cannot delete the new owner', async (t) => {
  const directory = await root(t);
  const crashed = child(t, directory);
  const old = await crashed.wait('acquired');
  crashed.process_.kill('SIGKILL');
  await crashed.exited;
  const a = child(t, directory, 'contend');
  const b = child(t, directory, 'contend');
  await Promise.all([a.wait('ready'), b.wait('ready')]);
  a.send(); b.send();
  const outcomes = await Promise.all([a.wait('acquired', 'error'), b.wait('acquired', 'error')]);
  assert.deepEqual(outcomes.map((value) => value.event).sort(), ['acquired', 'error']);
  const winner = outcomes[0].event === 'acquired' ? a : b;
  const acquired = outcomes.find((value) => value.event === 'acquired');
  assert.notEqual(acquired.token, old.token);
  assert.equal(outcomes.find((value) => value.event === 'error').code, 'ERR_SEMANTIC_RUN_BUSY');
  assert.deepEqual(await readdir(join(directory, '.run-lock')), [`owner-${acquired.token}.json`]);
  await assert.rejects(acquireRunLock(directory), { code: 'ERR_SEMANTIC_RUN_BUSY' });
  winner.send();
  assert.equal((await winner.exited).code, 0);
});

test('a crash before writing owner information never publishes an ownerless lock', async (t) => {
  const directory = await root(t);
  const initializing = child(t, directory, 'init');
  await initializing.wait('initializing');
  await assert.rejects(access(join(directory, '.run-lock')), { code: 'ENOENT' });
  await withRunLock(directory, async () => {});
  initializing.process_.kill('SIGKILL');
  await initializing.exited;
  await withRunLock(directory, async () => {});
});

test('old release tokens never remove a later owner and unknown owner data is not stolen', async (t) => {
  const directory = await root(t);
  const old = await acquireRunLock(directory);
  await old.release();
  const current = await acquireRunLock(directory);
  await old.release();
  assert.deepEqual(await readdir(current.lockPath), [`owner-${current.token}.json`]);
  const ownerPath = join(current.lockPath, `owner-${current.token}.json`);
  const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
  await writeFile(ownerPath, JSON.stringify({ ...owner, host: 'unknown-other-host' }));
  await assert.rejects(acquireRunLock(directory), { code: 'ERR_SEMANTIC_RUN_BUSY' });
  await current.release();
  await mkdir(join(directory, '.run-lock'));
  await withRunLock(directory, async () => {});
  await mkdir(join(directory, '.run-lock'));
  await writeFile(join(directory, '.run-lock', 'unknown-owner'), 'preserve');
  await assert.rejects(acquireRunLock(directory), { code: 'ERR_SEMANTIC_RUN_BUSY' });
});

test('directory locks support independent resources and report-specific busy errors', async (t) => {
  const directory = await root(t);
  const lock = await acquireRunLock(directory);
  await withDirectoryLock({ directory, lockName: '.report-lock', busyCode: 'ERR_REPORT_OUTPUT_BUSY', description: 'Report output' }, async () => {
    await assert.rejects(withDirectoryLock({ directory, lockName: '.report-lock', busyCode: 'ERR_REPORT_OUTPUT_BUSY', description: 'Report output' }, async () => {}), { code: 'ERR_REPORT_OUTPUT_BUSY' });
  });
  await lock.release();
});

test('persistent release errors retain primitive successful results and retry only completed lock handles', async (t) => {
  const directory = await root(t);
  const original = fs.unlink;
  let denied = true;
  let callbacks = 0;
  fs.unlink = async (path, ...args) => {
    if (denied && String(path).includes('/.run-lock/owner-')) throw Object.assign(new Error('persistent release denial'), { code: 'EACCES' });
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(withRunLock(directory, async () => { callbacks += 1; return 37; }), (error) => {
      assert.ok(error instanceof DirectoryLockCleanupError);
      assert.equal(error.code, 'ERR_DIRECTORY_LOCK_CLEANUP');
      assert.equal(error.operationCompleted, true);
      assert.equal(error.result, 37);
      assert.equal(error.lockCleanupWarning.code, 'EACCES');
      assert.match(error.message, /completed successfully.*Do not repeat/);
      return true;
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(withRunLock(directory, async () => { callbacks += 1; }), (error) => {
        assert.equal(error.code, 'ERR_DIRECTORY_LOCK_CLEANUP_PENDING');
        assert.equal(error.operationCompleted, false);
        return true;
      });
    }
    assert.equal(callbacks, 1);
    denied = false;
    assert.equal(await withRunLock(directory, async () => { callbacks += 1; return 41; }), 41);
    assert.equal(callbacks, 2);
    await assert.rejects(access(join(directory, '.run-lock')), { code: 'ENOENT' });
  } finally {
    fs.unlink = original;
    syncBuiltinESMExports();
  }
});

test('callback errors survive simultaneous persistent release failures without changing their identity', async (t) => {
  const directory = await root(t);
  const original = fs.unlink;
  fs.unlink = async (path, ...args) => {
    if (String(path).includes('/.run-lock/owner-')) throw Object.assign(new Error('release denied'), { code: 'EACCES' });
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  const operationError = Object.assign(new Error('original operation failure'), { code: 'ORIGINAL_FAILURE' });
  try {
    await assert.rejects(withRunLock(directory, async () => { throw operationError; }), (error) => {
      assert.equal(error, operationError);
      assert.equal(error.code, 'ORIGINAL_FAILURE');
      assert.equal(error.lockCleanupWarning.code, 'EACCES');
      return true;
    });
  } finally {
    fs.unlink = original;
    syncBuiltinESMExports();
  }
  await withRunLock(directory, async () => {});
});

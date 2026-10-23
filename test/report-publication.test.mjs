import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { summarizeSessions } from '../src/analyze.mjs';
import { renderAgentPrompt, renderHtml, renderMarkdown, writeReport } from '../src/report.mjs';

const reportModule = new URL('../src/report.mjs', import.meta.url).href;
const names = ['report.json', 'report.md', 'report.html', 'agent-prompt.md'];
const ioError = (message) => Object.assign(new Error(message), { code: 'EIO' });

function fixture(marker, locale = 'en') {
  const report = summarizeSessions([], { days: marker === 'old' ? 7 : 30, locale });
  report.reviewMarker = marker;
  report.generatedAt = '2026-10-22T09:10:11.123Z';
  return report;
}

function expected(report) {
  return [`${JSON.stringify(report, null, 2)}\n`, renderMarkdown(report), renderHtml(report), renderAgentPrompt(report)];
}

async function latest(directory) {
  return Promise.all(names.map((name) => fs.readFile(join(directory, name), 'utf8')));
}

async function setup(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'agent-insight-report-publication-'));
  t.after(async () => {
    t.mock.restoreAll();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const old = fixture('old');
  const files = await writeReport(old, directory);
  return { directory, old, files, before: await fs.readdir(directory) };
}

function child(script, args, ipc = false) {
  const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'ignore', 'pipe', ...(ipc ? ['ipc'] : [])] });
  let stderr = '';
  process.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', (code) => resolve({ code, stderr }));
  });
  return { process, closed };
}

test('a preparation failure leaves every previous report file and archive intact', async (t) => {
  const { directory, old, files, before } = await setup(t);
  const history = await fs.readFile(files.timestampedHtml, 'utf8');
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (path, ...args) => {
    if (String(path).endsWith('/staged/report.md')) throw ioError('staging write failed');
    return write(path, ...args);
  });
  await assert.rejects(writeReport(fixture('new', 'zh'), directory), /staging write failed/);
  assert.deepEqual(await latest(directory), expected(old));
  assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), history);
  assert.deepEqual((await fs.readdir(directory)).sort(), before.sort());
});

test('a failure after replacing the first latest file rolls back the complete previous report', async (t) => {
  const { directory, old, files, before } = await setup(t);
  const history = await fs.readFile(files.timestampedHtml, 'utf8');
  const rename = fs.rename;
  let firstReplaced = false;
  t.mock.method(fs, 'rename', async (source, destination) => {
    if (String(source).endsWith('/staged/report.md')) {
      assert.equal(firstReplaced, true);
      throw ioError('second commit rename failed');
    }
    const result = await rename(source, destination);
    if (String(source).endsWith('/staged/report.json')) firstReplaced = true;
    return result;
  });
  await assert.rejects(writeReport(fixture('new', 'zh'), directory), /second commit rename failed/);
  assert.deepEqual(await latest(directory), expected(old));
  assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), history);
  assert.deepEqual((await fs.readdir(directory)).sort(), before.sort());
});

test('a failed rollback preserves its journal and backups, and the next publisher recovers before writing', async (t) => {
  const { directory, old, files } = await setup(t);
  const rename = fs.rename;
  const failure = t.mock.method(fs, 'rename', async (source, destination) => {
    if (String(source).endsWith('/staged/report.md')) throw ioError('commit failed');
    if (String(source).endsWith('/restore-report.json')) throw ioError('restore failed');
    return rename(source, destination);
  });
  await assert.rejects(writeReport(fixture('new', 'zh'), directory), { code: 'ERR_REPORT_RECOVERY_REQUIRED' });
  const transaction = join(directory, '.report-transaction');
  const journal = JSON.parse(await fs.readFile(join(transaction, 'journal.json'), 'utf8'));
  assert.equal(journal.phase, 'prepared');
  assert.equal(await fs.readFile(join(transaction, 'previous', 'report.json'), 'utf8'), expected(old)[0]);
  failure.mock.restore();

  // Fail only the next preparation, proving recovery restores the old complete
  // report independently of whether the replacement can subsequently publish.
  const write = fs.writeFile;
  const preparation = t.mock.method(fs, 'writeFile', async (path, ...args) => {
    if (String(path).endsWith('/staged/report.json')) throw ioError('replacement preparation failed');
    return write(path, ...args);
  });
  await assert.rejects(writeReport(fixture('retry', 'zh'), directory), /replacement preparation failed/);
  assert.deepEqual(await latest(directory), expected(old));
  assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), expected(old)[2]);
  assert.equal((await fs.readdir(directory)).some((name) => name === '.report-transaction'), false);
  preparation.mock.restore();
  const retried = fixture('retry', 'zh');
  await writeReport(retried, directory);
  assert.deepEqual(await latest(directory), expected(retried));
});

test('same-second reports get distinct readable archives independent of edits to latest HTML', async (t) => {
  const { directory, old, files } = await setup(t);
  const next = fixture('new', 'zh');
  const second = await writeReport(next, directory);
  assert.notEqual(second.timestampedHtml, files.timestampedHtml);
  assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), expected(old)[2]);
  assert.equal(await fs.readFile(second.timestampedHtml, 'utf8'), expected(next)[2]);
  assert.deepEqual(await latest(directory), expected(next));
  await fs.writeFile(second.html, 'Local edit to latest HTML');
  assert.equal(await fs.readFile(second.timestampedHtml, 'utf8'), expected(next)[2]);
  assert.equal((await fs.stat(second.timestampedHtml)).mode & 0o777, 0o600);
});

for (const recoveryOfPendingTransaction of [false, true]) {
  test(`partial cleanup after ${recoveryOfPendingTransaction ? 'recovering a pending transaction' : 'rolling back a failed commit'} does not require deleted backups on retry`, async (t) => {
    const { directory, old, files } = await setup(t);
    const transaction = join(directory, '.report-transaction');
    const rename = fs.rename;
    let restoringBlocked = recoveryOfPendingTransaction;
    const commitFailure = t.mock.method(fs, 'rename', async (source, destination) => {
      if (String(source).endsWith('/staged/report.md')) throw ioError('commit failed');
      if (restoringBlocked && String(source).endsWith('/restore-report.json')) throw ioError('restore temporarily failed');
      return rename(source, destination);
    });
    if (recoveryOfPendingTransaction) {
      await assert.rejects(writeReport(fixture('failed'), directory), { code: 'ERR_REPORT_RECOVERY_REQUIRED' });
      assert.equal(JSON.parse(await fs.readFile(join(transaction, 'journal.json'), 'utf8')).phase, 'prepared');
      restoringBlocked = false;
    }
    const remove = fs.rm;
    let interruptedCleanup = false;
    const cleanupFailure = t.mock.method(fs, 'rm', async (path, options) => {
      if (!interruptedCleanup && String(path) === transaction) {
        interruptedCleanup = true;
        await remove(join(transaction, 'previous', 'report.json'));
        throw ioError('recursive cleanup partially failed');
      }
      return remove(path, options);
    });
    await assert.rejects(writeReport(fixture('failed', 'zh'), directory), { code: 'ERR_REPORT_RECOVERY_REQUIRED' });
    assert.equal(interruptedCleanup, true);
    assert.equal(JSON.parse(await fs.readFile(join(transaction, 'journal.json'), 'utf8')).phase, 'rolled_back');
    await assert.rejects(fs.stat(join(transaction, 'previous', 'report.json')), { code: 'ENOENT' });
    assert.deepEqual(await latest(directory), expected(old));
    commitFailure.mock.restore();
    cleanupFailure.mock.restore();
    const retried = fixture('healthy retry', 'zh');
    await writeReport(retried, directory);
    assert.deepEqual(await latest(directory), expected(retried));
    assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), expected(old)[2]);
    assert.equal((await fs.readdir(directory)).some((name) => name === '.report-transaction'), false);
  });
}

test('a process interrupted during commit leaves a journal that the next publisher rolls back', async (t) => {
  const { directory, old, files } = await setup(t);
  const script = `
    import fs from 'node:fs/promises';
    import { writeReport } from ${JSON.stringify(reportModule)};
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
      const result = await rename(source, destination);
      if (String(source).endsWith('/staged/report.json')) process.exit(71);
      return result;
    };
    await writeReport(JSON.parse(process.argv[2]), process.argv[1]);
  `;
  const interrupted = child(script, [directory, JSON.stringify(fixture('interrupted', 'zh'))]);
  t.after(() => interrupted.process.kill());
  assert.deepEqual(await interrupted.closed, { code: 71, stderr: '' });
  const journal = JSON.parse(await fs.readFile(join(directory, '.report-transaction', 'journal.json'), 'utf8'));
  assert.equal(journal.phase, 'prepared');
  const write = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (path, ...args) => {
    if (String(path).endsWith('/staged/report.json')) throw ioError('new preparation failed after recovery');
    return write(path, ...args);
  });
  await assert.rejects(writeReport(fixture('retry'), directory), /new preparation failed after recovery/);
  assert.deepEqual(await latest(directory), expected(old));
  assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), expected(old)[2]);
  assert.equal((await fs.readdir(directory)).some((name) => name.startsWith('.report-')), false);
});

test('different processes cannot interleave one output set and a busy publisher can retry', async (t) => {
  const { directory, old, files } = await setup(t);
  const first = fixture('first publisher', 'zh');
  const second = fixture('second publisher');
  const script = `
    import fs from 'node:fs/promises';
    import { writeReport } from ${JSON.stringify(reportModule)};
    const rename = fs.rename;
    let held = false;
    fs.rename = async (source, destination) => {
      if (!held && String(source).endsWith('/staged/report.json')) {
        held = true;
        const resume = new Promise((resolve) => process.once('message', resolve));
        process.send('holding-commit');
        await resume;
      }
      return rename(source, destination);
    };
    const files = await writeReport(JSON.parse(process.argv[2]), process.argv[1]);
    process.send(files);
    process.disconnect();
  `;
  const publisher = child(script, [directory, JSON.stringify(first)], true);
  t.after(() => publisher.process.kill());
  const held = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('publisher did not acquire the output lock')), 10_000);
    publisher.process.once('message', (message) => { clearTimeout(timer); resolve(message); });
  });
  assert.equal(await held, 'holding-commit');
  await assert.rejects(writeReport(second, directory), { code: 'ERR_REPORT_OUTPUT_BUSY' });
  assert.deepEqual(await latest(directory), expected(old));
  const published = new Promise((resolve) => publisher.process.once('message', resolve));
  publisher.process.send('resume');
  const firstFiles = await published;
  assert.deepEqual(await publisher.closed, { code: 0, stderr: '' });
  assert.deepEqual(await latest(directory), expected(first));
  const secondFiles = await writeReport(second, directory);
  assert.deepEqual(await latest(directory), expected(second));
  for (const [archive, report] of [[files.timestampedHtml, old], [firstFiles.timestampedHtml, first], [secondFiles.timestampedHtml, second]]) {
    assert.equal(await fs.readFile(archive, 'utf8'), expected(report)[2]);
  }
});

test('a completed report returns its files and a warning when lock release fails, then permits publication after cleanup recovers', async (t) => {
  const { directory, old, files } = await setup(t);
  const unlink = fs.unlink;
  const releaseFailure = t.mock.method(fs, 'unlink', async (path, ...args) => {
    if (String(path).includes('/.report-lock/owner-')) {
      throw Object.assign(new Error('owner unlink denied'), { code: 'EACCES' });
    }
    return unlink(path, ...args);
  });
  // The shared lock intentionally uses named built-in imports. Refresh those
  // live bindings after installing and restoring this filesystem fault.
  syncBuiltinESMExports();
  t.after(() => { releaseFailure.mock.restore(); syncBuiltinESMExports(); });
  const published = fixture('accepted publication', 'zh');
  const result = await writeReport(published, directory);
  assert.equal(result.lockCleanupWarning.code, 'EACCES');
  assert.equal(result.lockCleanupWarning.lockPath, join(directory, '.report-lock'));
  assert.match(result.lockCleanupWarning.message, /owner unlink denied/);
  assert.deepEqual(await latest(directory), expected(published));
  assert.equal(await fs.readFile(result.timestampedHtml, 'utf8'), expected(published)[2]);

  const beforeBlockedRetry = (await fs.readdir(directory)).sort();
  await assert.rejects(writeReport(fixture('blocked retry'), directory), { code: 'ERR_DIRECTORY_LOCK_CLEANUP_PENDING' });
  assert.deepEqual((await fs.readdir(directory)).sort(), beforeBlockedRetry);
  assert.deepEqual(await latest(directory), expected(published));
  releaseFailure.mock.restore();
  syncBuiltinESMExports();
  const retried = fixture('healthy retry');
  const next = await writeReport(retried, directory);
  assert.equal(next.lockCleanupWarning, undefined);
  assert.deepEqual(await latest(directory), expected(retried));
  assert.equal(await fs.readFile(files.timestampedHtml, 'utf8'), expected(old)[2]);
  assert.equal(await fs.readFile(result.timestampedHtml, 'utf8'), expected(published)[2]);
});

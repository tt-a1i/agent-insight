import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

const OWNER_FILE = /^owner-([a-f0-9-]{36})\.json$/;
// Only callbacks that have settled may leave retryable release handles here.
// An active transaction is never eligible for in-process recovery.
const completedReleases = new Map();

function cleanupWarning(lock, cause) {
  return {
    code: cause.code ?? 'UNKNOWN',
    message: `The operation finished, but its directory lock could not be released: ${cause.message}`,
    lockPath: lock.lockPath
  };
}

export class DirectoryLockCleanupError extends Error {
  constructor(result, lock, cause) {
    super('The operation completed successfully, but directory lock cleanup failed. Do not repeat the accepted operation.', { cause });
    this.code = 'ERR_DIRECTORY_LOCK_CLEANUP';
    this.operationCompleted = true;
    this.result = result;
    this.lockCleanupWarning = cleanupWarning(lock, cause);
  }
}

function busy(description, code) {
  const error = new Error(`${description} is busy in another transaction; retry the same command after it finishes.`);
  error.code = code;
  return error;
}

async function removeOwner(directory, filename) {
  // Never recursively remove the shared lock directory. A new owner has a
  // different token, so an old releaser/reaper cannot delete its owner file.
  await unlink(join(directory, filename)).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await rmdir(directory).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}

async function recoverDeadOwner(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const names = await readdir(directory);
    if (names.length === 0) {
      // Published live locks always contain an owner token. An empty directory
      // can be a release/reap window; rmdir refuses a concurrently new owner.
      try {
        await rmdir(directory);
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return true;
        if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return false;
        throw error;
      }
    }
    if (names.length !== 1 || !OWNER_FILE.test(names[0])) return false;
    const owner = JSON.parse(await readFile(join(directory, names[0]), 'utf8'));
    if (owner.token !== OWNER_FILE.exec(names[0])[1] || owner.host !== hostname()
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      // EPERM and unrecognized errors are not proof of a dead owner.
      if (error.code !== 'ESRCH') return false;
    }
    await removeOwner(directory, names[0]);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

async function acquireDirectoryLock({ directory, lockName = '.run-lock', busyCode = 'ERR_SEMANTIC_RUN_BUSY', description = 'Semantic run' }) {
  if (!/^\.[A-Za-z0-9_-]+$/.test(lockName)) throw new Error('Invalid directory lock name.');
  const lockPath = resolve(directory, lockName);
  const previous = completedReleases.get(lockPath);
  if (previous) {
    try {
      await previous.release();
      if (completedReleases.get(lockPath) === previous) completedReleases.delete(lockPath);
    } catch (cause) {
      const error = new Error(`${description} is blocked by unfinished lock cleanup from a completed transaction; cleanup retry failed.`, { cause });
      error.code = 'ERR_DIRECTORY_LOCK_CLEANUP_PENDING';
      error.operationCompleted = false;
      error.lockCleanupWarning = cleanupWarning(previous, cause);
      throw error;
    }
  }
  const token = randomUUID();
  const filename = `owner-${token}.json`;
  // Publish a nonempty, fully initialized directory atomically. A crash before
  // rename leaves only an unused private candidate, never an ownerless lock.
  const candidate = await mkdtemp(join(directory, `${lockName}-init-`));
  let published = false;
  try {
    await writeFile(join(candidate, filename), JSON.stringify({ token, pid: process.pid, host: hostname() }), { mode: 0o600, flag: 'wx' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(candidate, lockPath);
        published = true;
        let released = false;
        return {
          token,
          lockPath,
          async release() {
            if (released) return;
            await removeOwner(lockPath, filename);
            released = true;
          }
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw error;
        if (!await recoverDeadOwner(lockPath)) throw busy(description, busyCode);
      }
    }
    throw busy(description, busyCode);
  } finally {
    if (!published) await removeOwner(candidate, filename);
  }
}

export function acquireRunLock(directory) {
  return acquireDirectoryLock({ directory });
}

export async function withDirectoryLock(options, callback) {
  const lock = await acquireDirectoryLock(options);
  let result;
  try {
    result = await callback();
  } catch (error) {
    try {
      await lock.release();
    } catch (cause) {
      completedReleases.set(lock.lockPath, lock);
      // Retain the original operation error, including primitive/frozen throws.
      if (error && (typeof error === 'object' || typeof error === 'function')) {
        try { error.lockCleanupWarning = cleanupWarning(lock, cause); } catch {}
      }
    }
    throw error;
  }
  try {
    await lock.release();
  } catch (cause) {
    completedReleases.set(lock.lockPath, lock);
    throw new DirectoryLockCleanupError(result, lock, cause);
  }
  return result;
}

export function withRunLock(directory, callback) {
  return withDirectoryLock({ directory }, callback);
}

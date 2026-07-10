import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FacetCache } from '../src/cache.mjs';

test('facet cache reuses validated semantic results without storing transcript text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-cache-'));
  const cache = new FacetCache(root);
  const key = {
    source: 'claude',
    opaqueSessionId: 'session-7a9c',
    contentHash: 'content-abc',
    analyzerHost: 'claude',
    analyzerModel: 'sonnet',
    promptVersion: 'session-facet-v1'
  };
  const facet = {
    protocolVersion: 'claude-insights-2.1.206/v1',
    underlyingGoal: 'Fix a parser',
    evidence: []
  };

  await cache.put(key, facet);
  assert.deepEqual(await cache.get(key), facet);
  const status = await cache.status();
  assert.equal(status.entries, 1);
  assert.ok(status.bytes > 0);

  const files = await readdir(root);
  assert.equal(files.length, 1);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, files[0]))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(root, files[0]), 'utf8')).includes('raw-secret-transcript'), false);
});

test('facet cache can be cleared through its public cache boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-cache-clear-'));
  const cache = new FacetCache(root);
  const key = {
    source: 'claude',
    opaqueSessionId: 'session-clear',
    contentHash: 'content-clear',
    analyzerHost: 'claude',
    analyzerModel: null,
    promptVersion: 'session-facet-v1'
  };
  await cache.put(key, { protocolVersion: 'claude-insights-2.1.206/v1' });

  assert.equal(await cache.clear(), 1);
  assert.deepEqual(await cache.status(), { entries: 0, bytes: 0 });
  assert.equal(await cache.get(key), null);
});

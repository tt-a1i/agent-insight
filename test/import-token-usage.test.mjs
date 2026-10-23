import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { parseSessionFile } from '../src/parse.mjs';

test('import CLI preserves measured-zero and missing token presence without retaining raw messages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-import-token-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cases = [
    { name: 'zero', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, coverage: 'complete', total: 0 },
    { name: 'missing-output', usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, coverage: 'partial', total: null },
    { name: 'missing-usage', coverage: 'unavailable', total: null }
  ];
  const directory = join(root, '.agent-insight', 'imports', 'generic');
  const seen = new Set();
  for (const entry of cases) {
    const origin = join(root, `${entry.name}.jsonl`);
    const secret = `RAW_BODY_${entry.name}_must_not_persist`;
    await writeFile(origin, `${JSON.stringify({
      type: 'assistant', timestamp: '2026-07-03T10:00:00.000Z',
      message: { role: 'assistant', content: secret, ...(entry.usage ? { usage: entry.usage } : {}) }
    })}\n`);
    const original = await parseSessionFile(origin, 'generic');
    assert.equal(original.tokenUsage.coverage, entry.coverage);
    assert.equal(original.tokenUsage.totalTokens, entry.total);
    await main(['import', '--source', 'generic', '--from', origin], { home: root, cwd: root, quiet: true });
    const filename = (await readdir(directory)).find((name) => !seen.has(name));
    assert.ok(filename);
    seen.add(filename);
    const snapshotPath = join(directory, filename);
    const rawSnapshot = await readFile(snapshotPath, 'utf8');
    const snapshot = JSON.parse(rawSnapshot);
    assert.deepEqual(snapshot.session.tokenUsage, original.tokenUsage);
    assert.equal(rawSnapshot.includes(secret), false);
    assert.equal(rawSnapshot.includes(origin), false);
    assert.equal(Object.hasOwn(snapshot.session, 'message'), false);
    const roundTrip = await parseSessionFile(snapshotPath, 'generic');
    assert.deepEqual(roundTrip.tokenUsage, original.tokenUsage);
    assert.equal(roundTrip.inputTokens, 0);
    assert.equal(roundTrip.outputTokens, 0);
    assert.equal(roundTrip.tokenUsage.output.reportedRecords, entry.name === 'zero' ? 1 : 0);
    assert.equal(roundTrip.tokenUsage.output.missingRecords, entry.name === 'zero' ? 0 : 1);
  }
});

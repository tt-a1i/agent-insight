import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseSessionFile } from '../src/parse.mjs';

// Pi contract checked against be14d9732f98fcc33929cf103a92b96afaa6523e:
// ai/src/api/openai-responses-shared.ts subtracts cached tokens from input;
// coding-agent/src/core/agent-session.ts totals the four disjoint buckets.
const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });
const header = { type: 'session', version: 3, id: 'native-pi-usage', cwd: '/work/example', timestamp: '2026-10-22T00:00:00Z' };
const message = (id, parentId, role, extra = {}) => ({ type: 'message', id, parentId, timestamp: '2026-10-22T00:01:00Z', message: { role, content: role === 'user' ? 'Inspect the parser.' : [{ type: 'text', text: 'Inspected.' }], ...extra } });

async function parseRecords(t, records, source = 'pi') {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-pi-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'journal.jsonl');
  await writeFile(file, records.map(JSON.stringify).join('\n') + '\n');
  return parseSessionFile(file, source);
}

test('Pi maps native input/output once and preserves disjoint cache buckets without adding subsets', async (t) => {
  const session = await parseRecords(t, [header, message('u1', null, 'user'), message('a1', 'u1', 'assistant', {
    usage: { ...usage(11, 7, 13, 17), reasoning: 3, cacheWrite1h: 5 }
  })]);
  assert.equal(session.inputTokens, 11);
  assert.equal(session.outputTokens, 7);
  assert.deepEqual(session.tokenUsage, {
    scope: 'active_branch', records: { expected: 1, withUsage: 1 },
    input: { observed: 11, reportedRecords: 1, missingRecords: 0 },
    output: { observed: 7, reportedRecords: 1, missingRecords: 0 },
    cacheRead: { observed: 13, reportedRecords: 1, missingRecords: 0 },
    cacheWrite: { observed: 17, reportedRecords: 1, missingRecords: 0 },
    totalTokens: 48, coverage: 'complete'
  });
});

test('Pi active-branch usage excludes discarded siblings and counts each supported record once', async (t) => {
  const session = await parseRecords(t, [
    header, message('root', null, 'user'),
    message('discarded', 'root', 'assistant', { usage: usage(9000, 8000, 7000, 6000) }),
    message('active', 'root', 'assistant', { usage: usage(10, 20, 30, 40) }),
    { type: 'usage', id: 'warm', parentId: 'active', timestamp: '2026-10-22T00:02:00Z', kind: 'cache_warm', provider: 'anthropic', model: 'model', usage: usage(1, 2, 3, 4) },
    message('tool', 'warm', 'toolResult', { toolName: 'model-tool', toolCallId: 'call-1', isError: false, usage: usage(2, 3, 4, 5) }),
    { type: 'compaction', id: 'compact', parentId: 'tool', timestamp: '2026-10-22T00:03:00Z', summary: 'Summary.', firstKeptEntryId: 'active', tokensBefore: 100, usage: usage(3, 4, 5, 6) }
  ]);
  assert.equal(session.assistantMessages, 1);
  assert.equal(session.hasBranches, true);
  assert.equal(session.inputTokens, 16);
  assert.equal(session.outputTokens, 29);
  assert.equal(session.tokenUsage.cacheRead.observed, 42);
  assert.equal(session.tokenUsage.cacheWrite.observed, 55);
  assert.deepEqual(session.tokenUsage.records, { expected: 4, withUsage: 4 });
  assert.equal(session.tokenUsage.totalTokens, 142);
});

test('missing Pi usage and missing fields remain unknown while explicitly reported zero remains known', async (t) => {
  const session = await parseRecords(t, [
    header, message('u1', null, 'user'),
    message('a1', 'u1', 'assistant', { usage: { input: 0, output: null, cacheRead: 0 } }),
    message('a2', 'a1', 'assistant')
  ]);
  assert.deepEqual(session.tokenUsage.records, { expected: 2, withUsage: 1 });
  assert.deepEqual(session.tokenUsage.input, { observed: 0, reportedRecords: 1, missingRecords: 1 });
  assert.deepEqual(session.tokenUsage.output, { observed: 0, reportedRecords: 0, missingRecords: 2 });
  assert.deepEqual(session.tokenUsage.cacheRead, { observed: 0, reportedRecords: 1, missingRecords: 1 });
  assert.deepEqual(session.tokenUsage.cacheWrite, { observed: 0, reportedRecords: 0, missingRecords: 2 });
  assert.equal(session.tokenUsage.totalTokens, null);
  assert.equal(session.tokenUsage.coverage, 'partial');
});

test('Pi summary records without usage expose missing coverage instead of extending known totals', async (t) => {
  const session = await parseRecords(t, [
    header, message('a1', null, 'assistant', { usage: usage(0, 0, 0, 0) }),
    { type: 'branch_summary', id: 'summary', parentId: 'a1', timestamp: '2026-10-22T00:02:00Z', fromId: 'a1', summary: 'Summary.' }
  ]);
  assert.equal(session.tokenUsage.input.reportedRecords, 1);
  assert.equal(session.tokenUsage.input.missingRecords, 1);
  assert.equal(session.tokenUsage.totalTokens, null);
});

test('existing generic usage aliases gain presence coverage without guessing absent cache fields', async (t) => {
  const session = await parseRecords(t, [
    { type: 'assistant', message: { role: 'assistant', content: 'One.', usage: { input_tokens: 12, output_tokens: 3 } } },
    { type: 'assistant', message: { role: 'assistant', content: 'Two.', usage: { inputTokens: 0, outputTokens: '4' } } }
  ], 'generic');
  assert.equal(session.inputTokens, 12);
  assert.equal(session.outputTokens, 7);
  assert.equal(session.tokenUsage.scope, 'selected_transcript');
  assert.deepEqual(session.tokenUsage.input, { observed: 12, reportedRecords: 2, missingRecords: 0 });
  assert.equal(session.tokenUsage.cacheRead.missingRecords, 2);
  assert.equal(session.tokenUsage.totalTokens, null);
  assert.equal(session.tokenUsage.coverage, 'partial');
});

test('invalid native token values do not become measured zeros', async (t) => {
  const session = await parseRecords(t, [header, message('a1', null, 'assistant', {
    usage: { input: -1, output: '0', cacheRead: null, cacheWrite: false }
  })]);
  for (const bucket of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    assert.deepEqual(session.tokenUsage[bucket], { observed: 0, reportedRecords: 0, missingRecords: 1 });
  }
  assert.equal(session.tokenUsage.coverage, 'unavailable');
  assert.equal(session.tokenUsage.totalTokens, null);
});

test('legacy import snapshots never infer complete coverage from numeric zero counters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-pi-usage-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'legacy.json');
  await writeFile(file, JSON.stringify({ schema: 'agent-insight/import-v1', session: { id: 'legacy', inputTokens: 0, outputTokens: 0 } }));
  const session = await parseSessionFile(file, 'generic');
  assert.equal(session.tokenUsage, undefined);
});

test('new import snapshots retain validated field presence and recompute coverage and total', async (t) => {
  const original = await parseRecords(t, [header, message('a1', null, 'assistant', { usage: usage(11, 7, 13, 17) })]);
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-pi-usage-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'current.json');
  await writeFile(file, JSON.stringify({ schema: 'agent-insight/import-v1', session: { ...original, tokenUsage: { ...original.tokenUsage, coverage: 'unavailable', totalTokens: 999999 } } }));
  const session = await parseSessionFile(file, 'generic');
  assert.deepEqual(session.tokenUsage, original.tokenUsage);
  assert.equal(session.inputTokens, 11);
  assert.equal(session.outputTokens, 7);
});

test('a truncated Pi transcript exposes only observed subtotals even when every parsed usage field is present', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-pi-usage-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'partial.jsonl');
  const completePrefix = [header, message('a1', null, 'assistant', { usage: usage(11, 7, 13, 17) })].map(JSON.stringify).join('\n') + '\n';
  await writeFile(file, completePrefix + JSON.stringify(message('a2', 'a1', 'assistant', { usage: usage(100, 200, 300, 400) })) + '\n');
  const session = await parseSessionFile(file, 'pi', { maxBytes: Buffer.byteLength(completePrefix) });
  assert.equal(session.partial, true);
  assert.equal(session.inputTokens, 11);
  assert.equal(session.tokenUsage.coverage, 'partial');
  assert.equal(session.tokenUsage.totalTokens, null);
});

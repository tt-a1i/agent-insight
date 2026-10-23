import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseSessionFile } from '../src/parse.mjs';
import { summarizeSessions } from '../src/analyze.mjs';
import { createAggregateRequest, createAggregateChunkRequest } from '../src/aggregate-protocol.mjs';

async function piSession(t, usage, id = 'pi-usage') {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-token-coverage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'session.jsonl');
  await writeFile(file, [
    { type: 'session', version: 3, id, cwd: '/work/example', timestamp: '2026-10-22T00:00:00Z' },
    { type: 'message', id: 'answer', parentId: null, timestamp: '2026-10-22T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Checked.' }], ...(usage === undefined ? {} : { usage }) } }
  ].map(JSON.stringify).join('\n') + '\n');
  return parseSessionFile(file, 'pi');
}

test('complete selected-branch usage includes cache once and keeps measured zero distinct from unknown', async (t) => {
  const positive = await piSession(t, { input: 11, output: 7, cacheRead: 13, cacheWrite: 17, reasoning: 3, cacheWrite1h: 5 });
  const zero = await piSession(t, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, 'zero');
  const report = summarizeSessions([positive, zero]);
  assert.equal(report.totals.inputTokens, 11);
  assert.equal(report.insights.totalOutputTokens, 7);
  assert.equal(report.coverage.tokenUsage.totalTokens, 48);
  assert.equal(report.coverage.tokenUsage.coverage, 'complete');
  assert.deepEqual(report.coverage.tokenUsage.scopes, { active_branch: 2 });
  assert.equal(summarizeSessions([zero]).coverage.tokenUsage.totalTokens, 0);
  assert.equal(summarizeSessions([]).coverage.tokenUsage.totalTokens, null);
  assert.deepEqual(report.insights.tokenUsageCoverage, report.coverage.tokenUsage);
});

test('mixed known, missing and old metadata cannot promote observed subtotals to a complete total', async (t) => {
  const known = await piSession(t, { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 });
  const missing = await piSession(t, undefined, 'missing');
  const legacy = { ...known, id: 'old-import', source: 'groq', inputTokens: 100, outputTokens: 20 };
  delete legacy.tokenUsage;
  const report = summarizeSessions([known, missing, legacy], { sourcesScanned: [{ source: 'pi', coverage: 'available' }] });
  const usage = report.coverage.tokenUsage;
  assert.equal(report.insights.totalInputTokens, 111, 'legacy subtotal remains compatible but cannot establish presence');
  assert.deepEqual(usage.sessions, { total: 3, complete: 1, partial: 0, unavailable: 2 });
  assert.equal(usage.coverage, 'partial');
  assert.equal(usage.totalTokens, null);
  assert.deepEqual(usage.input, { observed: 11, reportedRecords: 1, missingRecords: 1, untrackedSessions: 1, partialSessions: 0 });
  assert.deepEqual(usage.scopes, { active_branch: 2, unknown: 1 });
  assert.equal(summarizeSessions([missing, legacy]).coverage.tokenUsage.coverage, 'unavailable');
});

test('a truncated transcript cannot establish a total even if every parsed usage bucket is present', async (t) => {
  const parsed = await piSession(t, { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 });
  const report = summarizeSessions([{ ...parsed, partial: true, partialReason: 'truncated_line' }]);
  assert.equal(report.coverage.tokenUsage.input.observed, 11);
  assert.equal(report.coverage.tokenUsage.input.partialSessions, 1);
  assert.equal(report.coverage.tokenUsage.sessions.partial, 1);
  assert.equal(report.coverage.tokenUsage.coverage, 'partial');
  assert.equal(report.coverage.tokenUsage.totalTokens, null);
});

test('aggregate and rolling prompts carry usage coverage and forbid interpreting missing usage as zero or efficiency', async (t) => {
  const session = await piSession(t, { input: 0, output: 0 });
  const context = { metrics: summarizeSessions([session]).insights, sessions: [], locale: 'en' };
  for (const request of [createAggregateRequest('interaction_style', context), createAggregateChunkRequest('interaction_style', context, [], 0, 1)]) {
    const data = JSON.parse(request.prompt.match(/<insights-data>\n([\s\S]*?)\n<\/insights-data>/)[1]);
    assert.equal(data.metrics.tokenUsageCoverage.input.reportedRecords, 1);
    assert.equal(data.metrics.tokenUsageCoverage.cacheRead.missingRecords, 1);
    assert.equal(data.metrics.tokenUsageCoverage.totalTokens, null);
    assert.match(request.prompt, /unknown, not measured zero/);
    assert.match(request.prompt, /active branch/);
    assert.match(request.prompt, /do not establish account billing, comparative cost, or collaboration efficiency/);
  }
});

test('scanned session count reflects selected files rather than every discovered candidate', () => {
  const report = summarizeSessions([], { sourcesScanned: [{ source: 'claude', coverage: 'partial', filesFound: 100, filesSelected: 3, filesLimited: 97 }] });
  assert.equal(report.insights.totalSessionsScanned, 3);
});

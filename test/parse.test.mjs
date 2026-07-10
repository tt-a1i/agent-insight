import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseSessionFile } from '../src/parse.mjs';
import { summarizeSessions } from '../src/analyze.mjs';
import { writeReport } from '../src/report.mjs';
import { collectSessions } from '../src/adapters.mjs';
import { sourceConfigurations } from '../src/adapters.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('parses Claude Code JSONL without retaining message content', async () => {
  const session = await parseSessionFile(fixture('claude.jsonl'), 'claude');
  assert.equal(session.id, 'claude-1');
  assert.equal(session.project, '/work/alpha');
  assert.equal(session.userMessages, 1);
  assert.equal(session.assistantMessages, 2);
  assert.equal(session.toolCalls, 2);
  assert.equal(session.inputTokens, 20);
  assert.equal(session.outputTokens, 40);
  assert.equal(JSON.stringify(session).includes('Fix the parser'), false);
});

test('parses Codex response_item records', async () => {
  const session = await parseSessionFile(fixture('codex.jsonl'), 'codex');
  assert.equal(session.id, 'codex-1');
  assert.equal(session.project, '/work/beta');
  assert.equal(session.userMessages, 1);
  assert.equal(session.assistantMessages, 1);
  assert.equal(session.toolCalls, 1);
  assert.equal(session.toolNames.exec_command, 1);
});

test('extracts Claude 2.1.206 deterministic insights metrics', async () => {
  const session = await parseSessionFile(fixture('claude-parity.jsonl'), 'claude');

  assert.equal(session.userMessages, 2);
  assert.equal(session.assistantMessages, 2);
  assert.equal(session.gitCommits, 1);
  assert.equal(session.gitPushes, 1);
  assert.equal(session.userInterruptions, 1);
  assert.deepEqual(session.userResponseTimes, [10]);
  assert.deepEqual(session.toolErrorCategories, { 'Command Failed': 1 });
  assert.equal(session.usesTaskAgent, true);
  assert.equal(session.usesMcp, true);
  assert.equal(session.usesWebSearch, true);
  assert.equal(session.usesWebFetch, false);
  assert.equal(session.linesAdded, 2);
  assert.equal(session.linesRemoved, 1);
  assert.equal(session.filesModified, 1);
  assert.deepEqual(session.languages, { TypeScript: 1 });
  assert.deepEqual(session.messageHours, { 9: 2 });
  assert.deepEqual(session.userMessageTimestamps, [
    '2026-07-03T09:00:00.000Z',
    '2026-07-03T09:02:10.000Z'
  ]);
});

test('summarizes sessions and emits only metadata reports', async () => {
  const [claude, codex] = await Promise.all([
    parseSessionFile(fixture('claude.jsonl'), 'claude'),
    parseSessionFile(fixture('codex.jsonl'), 'codex')
  ]);
  const report = summarizeSessions([claude, codex], { days: 30 });
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.totals.toolCalls, 3);
  assert.equal(report.sources.claude.sessions, 1);
  assert.equal(report.sources.codex.sessions, 1);
  assert.equal(JSON.stringify(report).includes('Investigate failure'), false);

  const output = await mkdtemp(join(tmpdir(), 'agent-insight-'));
  await chmod(output, 0o755);
  await writeReport(report, output);
  const markdown = await readFile(join(output, 'report.md'), 'utf8');
  assert.match(markdown, /2 sessions/);
  assert.doesNotMatch(markdown, /Fix the parser/);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
});

test('does not double-count Claude subagent journals by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-home-'));
  const project = join(home, '.claude', 'projects', 'encoded-project');
  const subagents = join(project, 'main-session', 'subagents');
  await mkdir(subagents, { recursive: true });
  const main = await readFile(fixture('claude.jsonl'), 'utf8');
  await Promise.all([
    writeFile(join(project, 'main-session.jsonl'), main),
    writeFile(join(subagents, 'worker.jsonl'), main)
  ]);
  const defaultScan = await collectSessions({ sources: 'claude', home, cwd: home, days: Infinity });
  const fullScan = await collectSessions({ sources: 'claude', home, cwd: home, days: Infinity, includeSubagents: true });
  assert.equal(defaultScan.sessions.length, 1);
  assert.deepEqual(defaultScan.analysisCandidates, [{
    source: 'claude',
    locator: { kind: 'file', path: join(project, 'main-session.jsonl') }
  }]);
  assert.equal(fullScan.sessions.length, 1);
  assert.equal(fullScan.sessions[0].userMessages, 2);
});

test('filters discovery and parsed sessions by an inclusive custom date range', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-date-range-'));
  const project = join(home, '.claude', 'projects', 'encoded-project');
  await mkdir(project, { recursive: true });
  const record = (id, timestamp) => `${JSON.stringify({ type: 'user', timestamp, sessionId: id, message: { role: 'user', content: 'hello' } })}\n`;
  const inside = join(project, 'inside.jsonl');
  const outside = join(project, 'outside.jsonl');
  await writeFile(inside, record('inside', '2026-07-03T12:00:00.000Z'));
  await writeFile(outside, record('outside', '2026-06-30T12:00:00.000Z'));
  await utimes(inside, new Date('2026-07-03T12:00:00.000Z'), new Date('2026-07-03T12:00:00.000Z'));
  await utimes(outside, new Date('2026-06-30T12:00:00.000Z'), new Date('2026-06-30T12:00:00.000Z'));

  const result = await collectSessions({
    sources: 'claude', home, cwd: home, days: Infinity, start: '2026-07-03', end: '2026-07-03'
  });
  assert.deepEqual(result.sessions.map((session) => session.id), ['inside']);
  assert.equal(result.diagnostics[0].filesWithinWindow, 1);
});

test('marks an oversized JSONL transcript as partial instead of reading it all', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-limit-'));
  const file = join(directory, 'large.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: '2026-07-01T00:00:00.000Z', message: { role: 'user', content: 'x'.repeat(4_000) } })}\n`);
  const session = await parseSessionFile(file, 'generic', { maxBytes: 256, maxRecords: 10, maxRecordBytes: 128 });
  assert.equal(session.partial, true);
  assert.ok(['byte_limit', 'record_limit'].includes(session.partialReason));
  assert.equal(JSON.stringify(session).includes('x'.repeat(20)), false);
});

test('honours explicit Codex and Claude homes without falling back to defaults', () => {
  const config = sourceConfigurations({
    home: '/tmp/default-home',
    env: {
      CODEX_HOME: '/tmp/custom-codex',
      CLAUDE_CONFIG_DIR: '/tmp/custom-claude',
      PI_CODING_AGENT_SESSION_DIR: '/tmp/custom-pi-sessions'
    }
  });
  assert.deepEqual(config.codex.roots, ['/tmp/custom-codex/sessions', '/tmp/custom-codex/archived_sessions']);
  assert.deepEqual(config.claude.roots, ['/tmp/custom-claude/projects']);
  assert.deepEqual(config.pi.roots, ['/tmp/custom-pi-sessions']);
});

test('marks malformed input as skipped and partial coverage rather than a clean empty session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-malformed-'));
  const invalid = join(root, 'invalid.jsonl');
  await writeFile(invalid, '{not-json}\n');
  const result = await collectSessions({ sources: 'generic', home: root, cwd: root, inputFiles: [invalid], days: Infinity });
  assert.equal(result.sessions.length, 0);
  assert.equal(result.diagnostics.at(-1).coverage, 'partial');
  assert.equal(result.diagnostics.at(-1).filesSkipped, 1);
});

test('limits discovery visibly and scans only Cursor agent-transcript JSONL', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-cursor-'));
  const cursorRoot = join(home, '.cursor', 'projects', 'project-a', 'agent-transcripts', 'thread-a');
  await mkdir(cursorRoot, { recursive: true });
  const session = `${JSON.stringify({ type: 'user', timestamp: '2026-07-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } })}\n`;
  await writeFile(join(cursorRoot, 'session.jsonl'), session);
  await writeFile(join(home, '.cursor', 'projects', 'project-a', 'telemetry.jsonl'), session);
  const cursor = await collectSessions({ sources: 'cursor', home, cwd: home, days: Infinity });
  assert.equal(cursor.sessions.length, 1);

  const importRoot = join(home, '.agent-insight', 'imports', 'generic');
  await mkdir(importRoot, { recursive: true });
  await Promise.all([
    writeFile(join(importRoot, 'one.json'), JSON.stringify({ type: 'user', content: 'hello' })),
    writeFile(join(importRoot, 'two.json'), JSON.stringify({ type: 'user', content: 'hello' }))
  ]);
  const limited = await collectSessions({ sources: 'generic', home, cwd: home, days: Infinity, maxDiscoveryFiles: 1 });
  assert.equal(limited.diagnostics[0].discoveryTruncated, true);
  assert.equal(limited.diagnostics[0].coverage, 'partial');
});

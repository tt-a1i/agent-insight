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

test('matches Claude 2.1.206 git, tool-error, and response-time edge semantics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-claude-edges-'));
  const file = join(directory, 'edges.jsonl');
  const records = [
    { type: 'assistant', timestamp: '2026-07-03T09:00:00.000Z', sessionId: 'claude-edges', message: { role: 'assistant', content: 'Ready.' } },
    { type: 'user', timestamp: '2026-07-03T09:00:10.000Z', sessionId: 'claude-edges', message: { role: 'user', content: 'First follow-up.' } },
    { type: 'user', timestamp: '2026-07-03T09:00:20.000Z', sessionId: 'claude-edges', message: { role: 'user', content: 'Second follow-up.' } },
    { type: 'assistant', timestamp: '2026-07-03T09:00:30.000Z', sessionId: 'claude-edges', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', input: { command: 'xgit commitish' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'git   push' } }
    ] } },
    { type: 'user', timestamp: '2026-07-03T09:00:40.000Z', sessionId: 'claude-edges', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-1', is_error: true, content: [{ type: 'text', text: 'exit code 1' }] }
    ] } }
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const session = await parseSessionFile(file, 'claude');

  assert.equal(session.gitCommits, 1);
  assert.equal(session.gitPushes, 0);
  assert.deepEqual(session.toolErrorCategories, { Other: 1 });
  assert.deepEqual(session.userResponseTimes, [10, 20]);
});

test('large identical Edit inputs retain exact zero line deltas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-large-edit-'));
  const file = join(root, 'large-edit.jsonl');
  const unchanged = Array.from({ length: 317 }, (_, index) => `line-${index}`).join('\n');
  await writeFile(file, `${JSON.stringify({
    type: 'assistant', timestamp: '2026-07-01T00:00:00.000Z', sessionId: 'large-edit',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/work/file.ts', old_string: unchanged, new_string: unchanged } }] }
  })}\n`);
  const session = await parseSessionFile(file, 'claude');
  assert.equal(session.linesAdded, 0);
  assert.equal(session.linesRemoved, 0);
});

test('selects the Claude leaf branch with the most user messages before duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-claude-branch-count-'));
  const file = join(directory, 'branch-count.jsonl');
  const message = (type, uuid, parentUuid, timestamp, content) => ({
    type, uuid, parentUuid, timestamp, sessionId: 'claude-branch-count',
    message: { role: type, content }
  });
  const records = [
    message('user', 'u0', null, '2026-07-03T09:00:00.000Z', 'Start.'),
    message('assistant', 'a0', 'u0', '2026-07-03T09:01:00.000Z', 'Choose a path.'),
    message('user', 'u1', 'a0', '2026-07-03T09:02:00.000Z', 'Dense branch.'),
    message('assistant', 'a1', 'u1', '2026-07-03T09:03:00.000Z', [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m dense' } }]),
    message('user', 'u2', 'a1', '2026-07-03T09:04:00.000Z', 'One more turn.'),
    message('assistant', 'a2', 'u2', '2026-07-03T09:05:00.000Z', 'Done.'),
    message('user', 'u3', 'a0', '2026-07-03T09:10:00.000Z', 'Long branch.'),
    message('assistant', 'a3', 'u3', '2026-07-03T10:00:00.000Z', [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }])
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const session = await parseSessionFile(file, 'claude');

  assert.equal(session.userMessages, 3);
  assert.equal(session.gitCommits, 1);
  assert.equal(session.gitPushes, 0);
  assert.equal(session.endedAt, '2026-07-03T09:05:00.000Z');
  assert.equal(session.hasBranches, true);
});

test('breaks equal-user-message Claude leaf ties by branch duration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-claude-branch-duration-'));
  const file = join(directory, 'branch-duration.jsonl');
  const message = (type, uuid, parentUuid, timestamp, content) => ({
    type, uuid, parentUuid, timestamp, sessionId: 'claude-branch-duration',
    message: { role: type, content }
  });
  const records = [
    message('user', 'u0', null, '2026-07-03T09:00:00.000Z', 'Start.'),
    message('assistant', 'a0', 'u0', '2026-07-03T09:01:00.000Z', 'Choose a path.'),
    message('user', 'u1', 'a0', '2026-07-03T09:02:00.000Z', 'Short branch.'),
    message('assistant', 'a1', 'u1', '2026-07-03T09:03:00.000Z', [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m short' } }]),
    message('user', 'u2', 'a0', '2026-07-03T09:04:00.000Z', 'Long branch.'),
    message('assistant', 'a2', 'u2', '2026-07-03T09:20:00.000Z', [{ type: 'tool_use', name: 'Bash', input: { command: 'git push' } }])
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const session = await parseSessionFile(file, 'claude');

  assert.equal(session.userMessages, 2);
  assert.equal(session.gitCommits, 0);
  assert.equal(session.gitPushes, 1);
  assert.equal(session.endedAt, '2026-07-03T09:20:00.000Z');
  assert.equal(session.hasBranches, true);
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

test('deduplicates Claude files by user-message count before transcript richness', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-claude-dedup-count-'));
  const project = join(home, '.claude', 'projects', 'encoded-project');
  await mkdir(project, { recursive: true });
  const preferred = join(project, 'preferred.jsonl');
  const verbose = join(project, 'verbose.jsonl');
  const user = (timestamp, content) => ({ type: 'user', timestamp, sessionId: 'shared-session', message: { role: 'user', content } });
  const assistant = (timestamp) => ({ type: 'assistant', timestamp, sessionId: 'shared-session', message: { role: 'assistant', content: 'Work.' } });
  await writeFile(preferred, `${[
    user('2026-07-03T09:00:00.000Z', 'One.'),
    user('2026-07-03T09:00:10.000Z', 'Two.'),
    user('2026-07-03T09:00:20.000Z', 'Three.')
  ].map((record) => JSON.stringify(record)).join('\n')}\n`);
  await writeFile(verbose, `${[
    user('2026-07-03T09:00:00.000Z', 'One.'),
    ...Array.from({ length: 8 }, (_, index) => assistant(`2026-07-03T09:${String(index + 1).padStart(2, '0')}:00.000Z`)),
    user('2026-07-03T10:00:00.000Z', 'Two.')
  ].map((record) => JSON.stringify(record)).join('\n')}\n`);

  const result = await collectSessions({ sources: 'claude', home, cwd: home, days: Infinity });

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessages, 3);
  assert.equal(result.sessions[0].assistantMessages, 0);
  assert.equal(result.analysisCandidates[0].locator.path, preferred);
});

test('breaks equal-user-message Claude file ties by duration', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-claude-dedup-duration-'));
  const project = join(home, '.claude', 'projects', 'encoded-project');
  await mkdir(project, { recursive: true });
  const noisy = join(project, 'noisy.jsonl');
  const longer = join(project, 'longer.jsonl');
  const user = (timestamp, content) => ({ type: 'user', timestamp, sessionId: 'shared-session', message: { role: 'user', content } });
  const assistant = (timestamp) => ({ type: 'assistant', timestamp, sessionId: 'shared-session', message: { role: 'assistant', content: 'Work.' } });
  await writeFile(noisy, `${[
    user('2026-07-03T09:00:00.000Z', 'One.'),
    ...Array.from({ length: 8 }, (_, index) => assistant(`2026-07-03T09:00:${String(index + 1).padStart(2, '0')}.000Z`)),
    user('2026-07-03T09:01:00.000Z', 'Two.')
  ].map((record) => JSON.stringify(record)).join('\n')}\n`);
  await writeFile(longer, `${[
    user('2026-07-03T09:00:00.000Z', 'One.'),
    user('2026-07-03T09:20:00.000Z', 'Two.')
  ].map((record) => JSON.stringify(record)).join('\n')}\n`);

  const result = await collectSessions({ sources: 'claude', home, cwd: home, days: Infinity });

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].endedAt, '2026-07-03T09:20:00.000Z');
  assert.equal(result.sessions[0].assistantMessages, 0);
  assert.equal(result.analysisCandidates[0].locator.path, longer);
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
  await utimes(inside, new Date('2020-01-01T12:00:00.000Z'), new Date('2020-01-01T12:00:00.000Z'));
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

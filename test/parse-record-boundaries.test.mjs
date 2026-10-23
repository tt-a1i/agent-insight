import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectSessions } from '../src/adapters.mjs';
import { parseSessionFile } from '../src/parse.mjs';

const header = { timestamp: '2026-10-22T01:00:00Z', type: 'session_meta', payload: { id: 'record-boundary', cwd: '/synthetic/project' } };
const user = (text, timestamp = '2026-10-22T01:03:00Z') => ({ timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const records = [header, user('Fix the failing parser.', '2026-10-22T01:00:01Z'), user('Verify the regression check.')];
const lines = records.map(JSON.stringify);

async function transcript(t, text) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-record-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'session.jsonl');
  await writeFile(file, text);
  return { file, directory };
}

test('exact record budget is complete with or without a final newline and trailing blank lines', async (t) => {
  for (const ending of ['', '\n', '\n\n \t\r\n  ']) {
    const { file } = await transcript(t, lines.join('\n\n \t\n') + ending);
    const session = await parseSessionFile(file, 'codex', { maxRecords: 3 });
    assert.equal(session.partial, false, JSON.stringify(ending));
    assert.equal(session.recordsRead, 3);
    assert.equal(session.userMessages, 2);
  }
});

test('the next nonblank record exceeds the budget without being counted, including at EOF', async (t) => {
  for (const ending of ['', '\n']) {
    const { file } = await transcript(t, lines.join('\n') + '\n\n \t\n' + JSON.stringify(user('Do not treat this fourth record as read.')) + ending);
    const session = await parseSessionFile(file, 'codex', { maxRecords: 3 });
    assert.equal(session.partial, true);
    assert.equal(session.partialReason, 'event_limit');
    assert.equal(session.recordsRead, 3);
    assert.equal(session.userMessages, 2);
  }
});

test('record budget remains exact across a stream chunk boundary inside a UTF-8 character', async (t) => {
  const base = JSON.stringify(header) + '\n';
  const serialized = JSON.stringify(user('', '2026-10-22T01:00:01Z'));
  const prefix = serialized.slice(0, serialized.indexOf('"text":"') + '"text":"'.length);
  const padding = 'x'.repeat(65535 - Buffer.byteLength(base + prefix));
  const text = base + JSON.stringify(user(padding + '中文🙂', '2026-10-22T01:00:01Z')) + '\n' + lines[2] + '\n';
  assert.equal(Buffer.from(text).indexOf(Buffer.from('中文')), 65535);
  const { file } = await transcript(t, text);
  const complete = await parseSessionFile(file, 'codex', { maxRecords: 3 });
  assert.equal(complete.partial, false);
  assert.equal(complete.recordsRead, 3);
  assert.equal(complete.userMessages, 2);
  const exceeded = await parseSessionFile(file, 'codex', { maxRecords: 2 });
  assert.equal(exceeded.partialReason, 'event_limit');
  assert.equal(exceeded.recordsRead, 2);
  assert.equal(exceeded.userMessages, 1);
  const byteLimited = await parseSessionFile(file, 'codex', { maxBytes: 65536, maxRecords: 3 });
  assert.equal(byteLimited.partial, true);
  assert.equal(byteLimited.partialReason, 'byte_limit');
});

test('record-size and malformed-record diagnostics retain their existing limits', async (t) => {
  const { file: oversized } = await transcript(t, lines[0] + '\n' + JSON.stringify(user('x'.repeat(1000))) + '\n');
  const sizeLimited = await parseSessionFile(oversized, 'codex', { maxRecords: 2, maxRecordBytes: 256 });
  assert.equal(sizeLimited.partialReason, 'record_limit');
  assert.equal(sizeLimited.recordsRead, 1);

  const { file: malformed } = await transcript(t, lines[0] + '\n{not-json}\n');
  const damaged = await parseSessionFile(malformed, 'codex', { maxRecords: 2 });
  assert.equal(damaged.partialReason, 'malformed_record');
  assert.equal(damaged.recordsRead, 2);
  assert.equal(damaged.malformedRecords, 1);

  const { file: beyondBudget } = await transcript(t, lines.join('\n') + '\n{not-json}\n');
  const unread = await parseSessionFile(beyondBudget, 'codex', { maxRecords: 3 });
  assert.equal(unread.partialReason, 'event_limit');
  assert.equal(unread.recordsRead, 3);
  assert.equal(unread.malformedRecords, 0);
});

test('a complete file exactly at the record budget remains eligible for semantic collection', async (t) => {
  const { file, directory } = await transcript(t, lines.join('\n') + '\n');
  const collection = await collectSessions({ sources: 'codex', home: directory, cwd: directory, env: { CODEX_HOME: join(directory, 'isolated-codex') }, inputFiles: [file], days: Infinity, maxRecords: 3 });
  assert.equal(collection.diagnostics.at(-1).coverage, 'available');
  assert.equal(collection.sessions[0].partial, false);
  assert.equal(collection.analysisCandidates.length, 1);
});

test('oversized blank tails remain complete across chunks at newline and EOF', async (t) => {
  for (const ending of ['', '\n']) {
    const text = lines.join('\n') + '\n' + ' '.repeat(2 * 1024 * 1024 + 1) + ending;
    const { file, directory } = await transcript(t, text);
    const complete = await parseSessionFile(file, 'codex', { maxRecords: 3 });
    assert.equal(complete.partial, false);
    assert.equal(complete.recordsRead, 3);
    assert.equal(complete.userMessages, 2);
    const collection = await collectSessions({ sources: 'codex', home: directory, cwd: directory, env: { CODEX_HOME: join(directory, 'isolated-codex') }, inputFiles: [file], days: Infinity, maxRecords: 3 });
    assert.equal(collection.analysisCandidates.length, 1);
    assert.equal(collection.diagnostics.at(-1).coverage, 'available');
    const byteLimited = await parseSessionFile(file, 'codex', { maxRecords: 3, maxBytes: 128 * 1024 });
    assert.equal(byteLimited.partialReason, 'byte_limit');
  }
});

test('an oversized blank line does not discard the following normal record', async (t) => {
  const { file } = await transcript(t, lines.slice(0, 2).join('\n') + '\n' + ' \t'.repeat(100_000) + '\n' + lines[2] + '\n');
  const session = await parseSessionFile(file, 'codex', { maxRecords: 3, maxRecordBytes: 256 });
  assert.equal(session.partial, false);
  assert.equal(session.recordsRead, 3);
  assert.equal(session.userMessages, 2);
});

test('oversized whitespace prefixes cannot hide nonblank records from the record-size limit', async (t) => {
  for (const ending of ['', '\n']) {
    const prefix = ' '.repeat(3 * 64 * 1024 + 1);
    const { file } = await transcript(t, lines.join('\n') + '\n' + prefix + JSON.stringify(user('Still an oversized logical record.')) + ending);
    const session = await parseSessionFile(file, 'codex', { maxRecords: 3, maxRecordBytes: 256 });
    assert.equal(session.partial, true);
    assert.equal(session.partialReason, 'record_limit');
    assert.equal(session.recordsRead, 3);
    assert.equal(session.userMessages, 2);
  }
});

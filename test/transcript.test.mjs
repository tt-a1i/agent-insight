import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractAnalysisInput } from '../src/transcript.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('Claude semantic input keeps bounded dialogue and tool names but omits tool payloads', async () => {
  const input = await extractAnalysisInput(fixture('claude.jsonl'), 'claude');

  assert.equal(input.source, 'claude');
  assert.equal(input.date, '2026-07-01');
  assert.equal(input.projectLabel, 'alpha');
  assert.equal(input.sessionId, 'claude-1');
  assert.match(input.opaqueId, /^[a-f0-9]{24}$/);
  assert.match(input.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(input.userMessageCount, 1);
  assert.equal(input.durationMinutes, 2);
  assert.deepEqual(input.messages, [
    { index: 1, role: 'user', text: 'Fix the parser' },
    { index: 2, role: 'assistant', text: 'I will inspect it' },
    { index: 3, role: 'tool', text: 'Read' },
    { index: 4, role: 'tool', text: 'Bash' }
  ]);
  assert.equal(JSON.stringify(input.messages).includes('claude-1'), false);
});

test('semantic extraction fails closed at the configured transcript byte limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-transcript-limit-'));
  const file = join(root, 'large.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: '2026-07-01T00:00:00.000Z', message: { role: 'user', content: 'x'.repeat(2_000) } })}\n`);
  await assert.rejects(extractAnalysisInput(file, 'claude', { maxBytes: 256 }), /semantic byte limit/);
});

test('Claude semantic projection uses the same winning leaf as deterministic metrics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-transcript-branch-'));
  const file = join(root, 'branch.jsonl');
  const record = (role, uuid, parentUuid, minute, content) => ({
    type: role, uuid, parentUuid, timestamp: `2026-07-01T09:${String(minute).padStart(2, '0')}:00.000Z`,
    sessionId: 'branch-semantic', message: { role, content }
  });
  const records = [
    record('user', 'u0', null, 0, 'Start request.'),
    record('assistant', 'a0', 'u0', 1, 'Choose.'),
    record('user', 'u1', 'a0', 2, 'Winning branch request.'),
    record('assistant', 'a1', 'u1', 3, 'Winning branch answer.'),
    record('user', 'u2', 'a1', 4, 'Winning branch follow-up.'),
    record('assistant', 'a2', 'u2', 5, 'Winning branch done.'),
    record('user', 'u3', 'a0', 6, 'Losing branch private text.'),
    record('assistant', 'a3', 'u3', 20, 'Losing branch answer.')
  ];
  await writeFile(file, `${records.map(JSON.stringify).join('\n')}\n`);
  const input = await extractAnalysisInput(file, 'claude');
  const text = JSON.stringify(input.messages);
  assert.match(text, /Winning branch follow-up/);
  assert.doesNotMatch(text, /Losing branch/);
  assert.equal(input.userMessageCount, 3);
});

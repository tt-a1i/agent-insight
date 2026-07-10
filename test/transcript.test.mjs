import assert from 'node:assert/strict';
import test from 'node:test';

import { extractAnalysisInput } from '../src/transcript.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('Claude semantic input keeps bounded dialogue and tool names but omits tool payloads', async () => {
  const input = await extractAnalysisInput(fixture('claude.jsonl'), 'claude');

  assert.equal(input.source, 'claude');
  assert.equal(input.date, '2026-07-01');
  assert.equal(input.projectLabel, 'alpha');
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
  assert.equal(JSON.stringify(input).includes('claude-1'), false);
});

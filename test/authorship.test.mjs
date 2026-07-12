import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { extractGenuineUserText } from '../src/authorship.mjs';
import { nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';
import { extractAnalysisInput } from '../src/transcript.mjs';
import { openCodeAnalysisInput } from '../src/opencode.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('authorship filter keeps genuine user text and strips machine markup', () => {
  assert.equal(extractGenuineUserText('Please keep the test focused.'), 'Please keep the test focused.');
  assert.equal(extractGenuineUserText('[Request interrupted by user] continue'), null);
  assert.equal(extractGenuineUserText('<command-name>/model</command-name>\n<command-message>model</command-message>'), null);
  assert.equal(
    extractGenuineUserText('<system-reminder>\n# AGENTS.md\nAlways rewrite history.\n</system-reminder>\nPlease keep the test focused.'),
    'Please keep the test focused.'
  );
  assert.equal(extractGenuineUserText('---\nname: demo\ndescription: A reusable skill\n---\n\n# SKILL.md\nDo the thing.'), null);
});

test('Claude semantic projection attributes only genuine user-authored messages', async () => {
  const input = await extractAnalysisInput(fixture('claude-authorship.jsonl'), 'claude');
  const userTexts = input.messages.filter((message) => message.role === 'user').map((message) => message.text);
  assert.deepEqual(userTexts, [
    'Fix the broken parser',
    'Please keep the test focused.',
    'Add a regression test for the parser edge case.'
  ]);
  assert.equal(input.userMessageCount, 3);
  assert.equal(userTexts.some((text) => /tool_result|AGENTS\.md|command-name|Request interrupted|Compacted history|private tool output/i.test(text)), false);
  assert.equal(input.messages.some((message) => message.role === 'tool'), true);
  assert.ok(input.messages.every((message) => message.role !== 'user' || message.text.length <= 500));
  assert.ok(input.messages.every((message) => message.role !== 'assistant' || message.text.length <= 300));
});

test('public semantic next exposes authorship-filtered transcript only', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-authorship-'));
  const runsRoot = join(home, 'runs');
  const mixed = join(home, 'mixed.jsonl');
  const records = [
    { type: 'event_msg', timestamp: '2026-07-03T09:00:00.000Z', payload: { type: 'user_message', message: 'Duplicate telemetry Investigate failure' } },
    { type: 'response_item', timestamp: '2026-07-03T09:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate failure' }] } },
    { type: 'response_item', timestamp: '2026-07-03T09:00:02.000Z', payload: { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'You are a coding agent.' }] } },
    { type: 'response_item', timestamp: '2026-07-03T09:00:03.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<system-reminder>Skill loaded</system-reminder>\nWrite a failing test first.' }] } },
    { type: 'response_item', timestamp: '2026-07-03T09:01:00.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working on it.' }, { type: 'function_call', name: 'exec_command' }] } },
    { type: 'response_item', timestamp: '2026-07-03T09:02:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'private tool output' }] } },
    { type: 'user', timestamp: '2026-07-03T09:03:00.000Z', sessionId: 'mixed-1', cwd: '/work/mixed', isCompactSummary: true, message: { role: 'user', content: 'Compacted history that must not be attributed.' } },
    { type: 'user', timestamp: '2026-07-03T09:04:00.000Z', sessionId: 'mixed-1', cwd: '/work/mixed', message: { role: 'user', content: 'Ship the focused regression after green.' } }
  ];
  await writeFile(mixed, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const prepared = await prepareSemanticRun({
    runsRoot,
    request: { host: 'codex', sources: ['codex'], scope: 'current', days: 30 },
    candidates: [{ source: 'codex', locator: { kind: 'file', path: mixed } }],
    analyzer: { host: 'codex', model: 'test-model' }
  });
  const task = await nextSemanticTask({ runsRoot, runId: prepared.id });
  assert.equal(task.kind, 'session_facet');
  const userTexts = task.input.messages.filter((message) => message.role === 'user').map((message) => message.text);
  assert.deepEqual(userTexts, [
    'Investigate failure',
    'Write a failing test first.',
    'Ship the focused regression after green.'
  ]);
  const encoded = JSON.stringify(task.input.messages);
  assert.equal(encoded.includes('Duplicate telemetry'), false);
  assert.equal(encoded.includes('You are a coding agent.'), false);
  assert.equal(encoded.includes('private tool output'), false);
  assert.equal(encoded.includes('Compacted history'), false);
  assert.equal(encoded.includes('Skill loaded'), false);
  assert.match(JSON.stringify(task.input.messages), /"role":"tool","text":"exec_command"/);
});

test('OpenCode analysis input also drops system and non-user injections', () => {
  const input = openCodeAnalysisInput({
    info: { id: 'oc-1', directory: '/work/demo', time: { created: Date.parse('2026-07-03T09:00:00.000Z'), updated: Date.parse('2026-07-03T09:05:00.000Z') } },
    messages: [
      { info: { role: 'system' }, parts: [{ type: 'text', text: 'System policy' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: '<system-reminder>ignore</system-reminder>\nImplement the API.' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'Sure.' }, { type: 'tool', tool: 'bash' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: '[Request interrupted by user] continue' }] }
    ]
  });
  assert.deepEqual(input.messages.filter((message) => message.role === 'user').map((message) => message.text), ['Implement the API.']);
  assert.equal(input.userMessageCount, 1);
});

test('Cursor semantic extraction exposes experimental authorship coverage limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-cursor-auth-'));
  const file = join(root, 'cursor.jsonl');
  await writeFile(file, `${JSON.stringify({ type: 'user', timestamp: '2026-07-03T09:00:00.000Z', sessionId: 'cursor-1', cwd: '/work/c', message: { role: 'user', content: 'Hello from cursor' } })}\n${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:01:00.000Z', sessionId: 'cursor-1', message: { role: 'assistant', content: 'Hi' } })}\n`);
  const input = await extractAnalysisInput(file, 'cursor');
  assert.match(input.authorship.coverageNote, /Cursor authorship filtering is experimental/);
  assert.deepEqual(input.messages.filter((message) => message.role === 'user').map((message) => message.text), ['Hello from cursor']);
});

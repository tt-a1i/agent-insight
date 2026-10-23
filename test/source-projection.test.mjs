import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractAnalysisInput } from '../src/transcript.mjs';
import { parseSessionFile, recordTimestamp } from '../src/parse.mjs';
import { normaliseOpenCodeExport, openCodeAnalysisInput } from '../src/opencode.mjs';

async function project(t, records, source) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'journal.jsonl');
  await writeFile(file, `${records.map(JSON.stringify).join('\n')}\n`);
  return { input: await extractAnalysisInput(file, source), session: await parseSessionFile(file, source) };
}

test('source projection retains authored code indentation and surrounding whitespace verbatim', async (t) => {
  const text = '\n    an indented user snippet  \n';
  const { input } = await project(t, [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }
  ], 'claude');
  assert.equal(input.messages[0].text, text);
  const openCode = openCodeAnalysisInput({ info: { id: 'whitespace' }, messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text }] }
  ] });
  assert.equal(openCode.messages[0].text, text);
});

test('only a Cursor user transport timestamp at the message beginning supplies a fallback clock', () => {
  const prefix = '<timestamp>2050-01-01T00:00:00Z</timestamp>\n<user_query>Inspect this example.</user_query>';
  const user = (content) => ({ role: 'user', message: { content: [{ type: 'text', text: content }] } });
  assert.equal(recordTimestamp(user(prefix), 'cursor'), '2050-01-01T00:00:00.000Z');
  for (const source of ['claude', 'codex', 'pi', 'opencode', undefined]) {
    assert.equal(recordTimestamp(user(prefix), source), null);
  }
  for (const text of [
    'Example: <timestamp>2050-01-01T00:00:00Z</timestamp>',
    '`<timestamp>2050-01-01T00:00:00Z</timestamp>`',
    '    <timestamp>2050-01-01T00:00:00Z</timestamp>',
    '```xml\n<timestamp>2050-01-01T00:00:00Z</timestamp>\n```',
    '<timestamp>2050-01-01T00:00:00Z</timestamp> is a quoted inline example.'
  ]) assert.equal(recordTimestamp(user(text), 'cursor'), null);
  assert.equal(recordTimestamp({ role: 'assistant', message: { content: prefix } }, 'cursor'), null);
  assert.equal(recordTimestamp({ type: 'user', message: { role: 'assistant', content: prefix } }, 'cursor'), null);
  assert.equal(recordTimestamp({ ...user(prefix), timestamp: '2026-10-22T00:00:00Z' }, 'cursor'), '2026-10-22T00:00:00.000Z');
});

test('Cursor quoted timestamp examples neither extend the session window nor change retained quotations', async (t) => {
  const examples = [
    { role: 'assistant', text: 'Example: <timestamp>2050-01-01T00:00:00Z</timestamp>' },
    { role: 'user', text: '```xml\n<timestamp>2051-01-01T00:00:00Z</timestamp>\n```' },
    { role: 'user', text: 'Use `<timestamp>2052-01-01T00:00:00Z</timestamp>` as a literal example.' }
  ];
  const { input, session } = await project(t, [
    { role: 'user', message: { content: '<timestamp>2026-10-22T00:00:00Z</timestamp>\n<user_query>Inspect the parser.</user_query>' } },
    ...examples.map(({ role, text }) => ({ role, message: { content: [{ type: 'text', text }] } })),
    { role: 'user', message: { content: '<timestamp>2026-10-22T00:10:00Z</timestamp>\n<user_query>Keep the examples literal.</user_query>' } }
  ], 'cursor');
  assert.equal(input.date, '2026-10-22');
  assert.equal(input.durationMinutes, 10);
  assert.equal(session.startedAt, '2026-10-22T00:00:00.000Z');
  assert.equal(session.endedAt, '2026-10-22T00:10:00.000Z');
  assert.deepEqual(input.messages.slice(1, 4).map(({ text }) => text), examples.map(({ text }) => text));
});

for (const source of ['claude', 'cursor']) {
  test(`${source} preserves tool execution failure and adjacent authored feedback without tool payloads`, async (t) => {
    const { input, session } = await project(t, [
      { type: 'user', message: { role: 'user', content: 'Run the regression tests.' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'private-command' } }] } },
      { type: 'user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'private-failing-output' },
        { type: 'text', text: 'Keep investigating the failure.' }
      ] } }
    ], source);
    assert.equal(input.userMessageCount, 2);
    assert.deepEqual(input.messages.map(({ role, text, tool }) => ({ role, text, ...(tool ? { tool } : {}) })), [
      { role: 'user', text: 'Run the regression tests.' },
      { role: 'tool', text: 'Bash', tool: { kind: 'call', name: 'Bash', callId: 'call-1', status: 'unknown' } },
      { role: 'tool', text: 'Bash', tool: { kind: 'result', name: 'Bash', callId: 'call-1', status: 'failed' } },
      { role: 'user', text: 'Keep investigating the failure.' }
    ]);
    assert.equal(session.toolCalls, 1);
    assert.equal(session.toolErrors, 1);
    assert.doesNotMatch(JSON.stringify(input.messages), /private-command|private-failing-output/);
  });
}

test('Codex function and custom outputs remain results with unknown execution state', async (t) => {
  const { input, session } = await project(t, [
    { type: 'event_msg', payload: { type: 'function_call', name: 'telemetry-duplicate', call_id: 'call-1' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect the failing test.' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call-1', arguments: 'private-command' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'Process exited with code 1\nprivate-output' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'call-2', input: 'private-patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-2', output: 'private-patch-output' } }
  ], 'codex');
  assert.equal(session.toolCalls, 2);
  assert.deepEqual(input.messages.filter(({ role }) => role === 'tool').map(({ tool }) => tool), [
    { kind: 'call', name: 'exec_command', callId: 'call-1', status: 'unknown' },
    { kind: 'result', name: 'exec_command', callId: 'call-1', status: 'unknown' },
    { kind: 'call', name: 'apply_patch', callId: 'call-2', status: 'unknown' },
    { kind: 'result', name: 'apply_patch', callId: 'call-2', status: 'unknown' }
  ]);
  assert.doesNotMatch(JSON.stringify(input.messages), /private-|Process exited/);
  assert.doesNotMatch(JSON.stringify(input.messages), /telemetry-duplicate/);
});

test('Pi native toolCall/toolResult preserves execution status and session identity', async (t) => {
  const { input, session } = await project(t, [
    { type: 'session', version: 3, id: 'pi-native-session', cwd: '/work/example', timestamp: '2026-10-22T00:00:00Z' },
    { type: 'message', id: 'user', parentId: null, timestamp: '2026-10-22T00:01:00Z', message: { role: 'user', content: 'Run tests.' } },
    { type: 'message', id: 'assistant', parentId: 'user', timestamp: '2026-10-22T00:02:00Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'private-command' } }] } },
    { type: 'message', id: 'result', parentId: 'assistant', timestamp: '2026-10-22T00:03:00Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'private-result' }], isError: true } }
  ], 'pi');
  assert.equal(input.sessionId, 'pi-native-session');
  assert.equal(session.id, 'pi-native-session');
  assert.equal(input.messages.length, 3);
  assert.deepEqual(input.messages[2].tool, { kind: 'result', name: 'bash', callId: 'call-1', status: 'failed' });
  assert.equal(session.toolCalls, 1);
  assert.equal(session.toolErrors, 1);
  assert.equal(session.partial, false);
  assert.doesNotMatch(JSON.stringify(input.messages), /private-/);
});

test('Pi projection and metrics follow the latest parent chain rather than mixing sibling branches', async (t) => {
  // Native tree contract: SessionManager._buildIndex uses the last entry as
  // leaf; getBranch follows parentId (official Pi session-manager.ts).
  const { input, session } = await project(t, [
    { type: 'session', version: 3, id: 'pi-tree', cwd: '/work/example', timestamp: '2026-10-22T00:00:00Z' },
    { type: 'message', id: 'root', parentId: null, timestamp: '2026-10-22T00:01:00Z', message: { role: 'user', content: 'Implement an endpoint.' } },
    { type: 'message', id: 'old-user', parentId: 'root', timestamp: '2026-10-22T00:02:00Z', message: { role: 'user', content: 'Obsolete branch request.' } },
    { type: 'message', id: 'old-answer', parentId: 'old-user', timestamp: '2026-10-22T00:03:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Obsolete branch succeeded.' }] } },
    { type: 'message', id: 'new-user', parentId: 'root', timestamp: '2026-10-22T00:04:00Z', message: { role: 'user', content: 'Try another approach.' } },
    { type: 'message', id: 'new-answer', parentId: 'new-user', timestamp: '2026-10-22T00:05:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Active branch failed.' }] } }
  ], 'pi');
  assert.deepEqual(input.messages.map(({ text }) => text), ['Implement an endpoint.', 'Try another approach.', 'Active branch failed.']);
  assert.equal(input.userMessageCount, 2);
  assert.equal(session.userMessages, 2);
  assert.equal(session.assistantMessages, 1);
  assert.equal(session.hasBranches, true);
});

for (const [stopReason, status] of [['error', 'failed'], ['aborted', 'cancelled']]) {
  test(`Pi assistant ${stopReason} with empty content survives as a payload-free agent event`, async (t) => {
    const { input, session } = await project(t, [
      { type: 'session', version: 3, id: 'pi-terminal', cwd: '/work/example', timestamp: '2026-10-22T00:00:00Z' },
      { type: 'message', id: 'user', parentId: null, timestamp: '2026-10-22T00:01:00Z', message: { role: 'user', content: 'Complete the task.' } },
      { type: 'message', id: 'assistant', parentId: 'user', timestamp: '2026-10-22T00:02:00Z', message: { role: 'assistant', content: [], stopReason, errorMessage: 'private-runtime-error' } }
    ], 'pi');
    assert.deepEqual(input.messages[1], { index: 2, role: 'agent_event', text: '', agent: { status } });
    assert.equal(input.userMessageCount, 1);
    assert.equal(session.turnFailures, stopReason === 'error' ? 1 : 0);
    assert.equal(session.toolCalls, 0);
    assert.doesNotMatch(JSON.stringify(input.messages), /private-runtime-error/);
  });
}

test('OpenCode excludes native synthetic continuation and preserves explicit tool state', () => {
  const input = openCodeAnalysisInput({ info: { id: 'opencode-native' }, messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'Run the focused test.' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'bash', callID: 'call-1', state: { status: 'error', error: 'private-error', input: { command: 'private-command' } } }] },
    { info: { role: 'user' }, parts: [{ type: 'text', synthetic: true, text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.' }] },
    { info: { role: 'user' }, parts: [{ type: 'text', ignored: true, text: 'ignored-private-context' }, { type: 'text', text: 'Explain why it failed.' }] }
  ] });
  assert.equal(input.userMessageCount, 2);
  assert.deepEqual(input.messages.filter(({ role }) => role === 'user').map(({ text }) => text), ['Run the focused test.', 'Explain why it failed.']);
  assert.deepEqual(input.messages.find(({ tool }) => tool?.kind === 'result').tool, { kind: 'result', name: 'bash', callId: 'call-1', status: 'failed' });
  assert.doesNotMatch(JSON.stringify(input.messages), /private-|Continue if/);
});

test('completed OpenCode execution remains a tool result, separate from goal completion', () => {
  const input = openCodeAnalysisInput({ info: { id: 'opencode-completed' }, messages: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'Fix the bug and deploy it.' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'tool', tool: 'read', callID: 'call-1', state: { status: 'completed', output: 'private-file-content' } }] }
  ] });
  assert.deepEqual(input.messages[2].tool, { kind: 'result', name: 'read', callId: 'call-1', status: 'succeeded' });
  assert.doesNotMatch(JSON.stringify(input.messages), /private-file-content/);
});

for (const [name, status] of [['APIError', 'failed'], ['MessageAbortedError', 'cancelled']]) {
  test(`OpenCode assistant ${name} without text preserves only its terminal status`, () => {
    const document = { info: { id: 'opencode-terminal' }, messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'Complete the task.' }] },
      { info: { role: 'assistant', error: { name, data: { message: 'private-runtime-error' } } }, parts: [] }
    ] };
    const input = openCodeAnalysisInput(document);
    assert.deepEqual(input.messages[1], { index: 2, role: 'agent_event', text: '', agent: { status } });
    assert.equal(input.userMessageCount, 1);
    assert.equal(normaliseOpenCodeExport(document).turnFailures, status === 'failed' ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(input.messages), /private-runtime-error|APIError|MessageAbortedError/);
  });
}

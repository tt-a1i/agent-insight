import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectOpenCodeSessions, normaliseOpenCodeExport, openCodeAnalysisInput } from '../src/opencode.mjs';
import { AGENTS, installIntegration, integrationPath, renderIntegration } from '../src/integrations.mjs';
import { summarizeSessions } from '../src/analyze.mjs';

test('normalises an OpenCode export without retaining transcript content', () => {
  const session = normaliseOpenCodeExport({
    info: {
      id: 'ses-secret',
      directory: '/private/work/insight',
      time: { created: 1_783_000_000_000, updated: 1_783_000_100_000 },
      tokens: { input: 12, output: 34 }
    },
    messages: [
      { info: { role: 'user', model: { providerID: 'groq', modelID: 'llama-4' } }, parts: [{ type: 'text', text: 'do not retain me' }] },
      { info: { role: 'assistant', model: { providerID: 'groq', modelID: 'llama-4' } }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'error', input: { command: 'shell-danger-raw' } } }] }
    ]
  });
  assert.equal(session.userMessages, 1);
  assert.equal(session.assistantMessages, 1);
  assert.equal(session.toolCalls, 1);
  assert.equal(session.toolErrors, 1);
  assert.equal(session.providers.groq, 2);
  assert.equal(JSON.stringify(session).includes('do not retain me'), false);
  assert.equal(JSON.stringify(session).includes('shell-danger-raw'), false);
  const report = summarizeSessions([session]);
  assert.equal(report.totals.inputTokens, 12);
  assert.equal(report.totals.outputTokens, 34);
  assert.equal(JSON.stringify(report).includes('ses-secret'), false);
  assert.equal(JSON.stringify(report).includes('/private/work/insight'), false);
});

test('uses the official OpenCode CLI contract and declares root-session coverage', async () => {
  const invocations = [];
  const runner = async (args) => {
    invocations.push(args);
    if (args[0] === 'session') return JSON.stringify([{ id: 'ses-1', directory: '/work/demo', created: 1_783_000_000_000, updated: 1_783_000_100_000 }]);
    return JSON.stringify({ info: { id: 'ses-1', directory: '/work/demo', time: { created: 1_783_000_000_000, updated: 1_783_000_100_000 } }, messages: [] });
  };
  const result = await collectOpenCodeSessions({ runner, maxSessions: 10 });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.diagnostic.coverage, 'root_sessions_only');
  assert.deepEqual(invocations[0], ['session', 'list', '--format', 'json', '--max-count', '10']);
  assert.deepEqual(invocations[1], ['export', 'ses-1', '--sanitize']);
  assert.deepEqual(result.sessions[0].analysisLocator, { kind: 'opencode', sessionId: 'ses-1', cwd: process.cwd() });
});

test('builds bounded OpenCode semantic input without tool payloads', () => {
  const input = openCodeAnalysisInput({
    info: { id: 'ses-semantic', directory: '/work/demo', time: { created: 1_783_000_000_000, updated: 1_783_000_120_000 } },
    messages: [
      { info: { role: 'user', time: { created: 1_783_000_000_000 } }, parts: [{ type: 'text', text: 'Explain this failure' }] },
      { info: { role: 'assistant', time: { created: 1_783_000_120_000 } }, parts: [{ type: 'text', text: 'I found it' }, { type: 'tool', tool: 'bash', state: { input: { command: 'private-command' }, output: 'private-output' } }] }
    ]
  });
  assert.equal(input.userMessageCount, 1);
  assert.equal(input.durationMinutes, 2);
  assert.deepEqual(input.messages, [
    { index: 1, role: 'user', text: 'Explain this failure' },
    { index: 2, role: 'assistant', text: 'I found it' },
    { index: 3, role: 'tool', text: 'bash' }
  ]);
  assert.equal(JSON.stringify(input).includes('private-command'), false);
  assert.equal(JSON.stringify(input).includes('private-output'), false);
});

test('installs a real Pi slash-command extension and protects existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-install-'));
  const target = await installIntegration({ agent: 'pi', scope: 'project', cwd: root, home: root });
  assert.equal(target, integrationPath({ agent: 'pi', scope: 'project', cwd: root, home: root }));
  const content = await readFile(target, 'utf8');
  assert.match(content, /registerCommand\("agent-insights"/);
  assert.match(content, /ctx\.ui\.select\("Agent scope"/);
  assert.match(content, /\["prepare", "--host", "pi", "--source", sources/);
  assert.ok(content.includes('\nexport default function'));
  assert.equal(content.includes('\\nexport default function'), false);
  await assert.rejects(() => installIntegration({ agent: 'pi', scope: 'project', cwd: root, home: root }), /already exists/);
});

test('installs Codex skills in the shared .agents skill surface', () => {
  const path = integrationPath({ agent: 'codex', scope: 'project', cwd: '/tmp/project', home: '/tmp/home' });
  assert.equal(path, '/tmp/project/.agents/skills/agent-insights/SKILL.md');
});

test('host bridges prepare semantic runs for their active model', () => {
  assert.deepEqual(AGENTS, ['claude', 'codex', 'cursor', 'opencode', 'pi']);
  assert.match(renderIntegration('claude'), /agent-insight prepare --host claude --source/);
  assert.match(renderIntegration('codex'), /agent-insight prepare --host codex --source/);
  assert.match(renderIntegration('opencode'), /agent-insight prepare --host opencode --source/);
  assert.match(renderIntegration('cursor'), /agent-insight prepare --host cursor --source/);
  assert.doesNotMatch(renderIntegration('claude'), /claude\s+(?:-p|--print)/i);
  assert.doesNotMatch(renderIntegration('codex'), /codex\s+exec/i);
  assert.doesNotMatch(renderIntegration('opencode'), /opencode\s+run/i);
  assert.doesNotMatch(renderIntegration('cursor'), /cursor-agent\s+(?:-p|--print)/i);
  assert.throws(() => renderIntegration('groq'), /Unknown host agent/);
});

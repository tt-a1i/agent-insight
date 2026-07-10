import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectOpenCodeSessions, normaliseOpenCodeExport } from '../src/opencode.mjs';
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
});

test('installs a real Pi slash-command extension and protects existing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-install-'));
  const target = await installIntegration({ agent: 'pi', scope: 'project', cwd: root, home: root });
  assert.equal(target, integrationPath({ agent: 'pi', scope: 'project', cwd: root, home: root }));
  const content = await readFile(target, 'utf8');
  assert.match(content, /registerCommand\("agent-insights"/);
  assert.match(content, /--source", "pi"/);
  assert.ok(content.includes('\nexport default function'));
  assert.equal(content.includes('\\nexport default function'), false);
  await assert.rejects(() => installIntegration({ agent: 'pi', scope: 'project', cwd: root, home: root }), /already exists/);
});

test('installs Codex skills in the shared .agents skill surface', () => {
  const path = integrationPath({ agent: 'codex', scope: 'project', cwd: '/tmp/project', home: '/tmp/home' });
  assert.equal(path, '/tmp/project/.agents/skills/agent-insights/SKILL.md');
});

test('host bridges invoke their own source instead of an indiscriminate auto scan', () => {
  assert.deepEqual(AGENTS, ['claude', 'codex', 'cursor', 'opencode', 'pi']);
  assert.match(renderIntegration('claude'), /--source claude --project/);
  assert.match(renderIntegration('codex'), /--source codex --project/);
  assert.match(renderIntegration('opencode'), /--source opencode --project/);
  assert.match(renderIntegration('cursor'), /--source cursor/);
  assert.doesNotMatch(renderIntegration('cursor'), /--source cursor --project/);
  assert.throws(() => renderIntegration('groq'), /Unknown host agent/);
});

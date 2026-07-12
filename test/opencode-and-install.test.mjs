import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, stat, symlink } from 'node:fs/promises';
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
  assert.match(content, /\["prepare", "--host", "pi", "--model", modelId, "--source", sources/);
  assert.ok(content.includes('\nexport default function'));
  assert.equal(content.includes('\\nexport default function'), false);
  await assert.rejects(() => installIntegration({ agent: 'pi', scope: 'project', cwd: root, home: root }), /already exists/);
});

test('force install tightens an existing integration file to mode 0600', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-force-install-'));
  const options = { agent: 'pi', scope: 'project', cwd: root, home: root };
  const target = await installIntegration(options);
  await chmod(target, 0o644);

  await installIntegration({ ...options, force: true });

  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test('install refuses dangling integration symlinks instead of writing outside the project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-symlink-install-'));
  const target = integrationPath({ agent: 'claude', scope: 'project', cwd: root, home: root });
  const outside = join(root, 'outside', 'captured.md');
  await mkdir(join(root, '.claude', 'commands'), { recursive: true });
  await symlink(outside, target);
  await assert.rejects(installIntegration({ agent: 'claude', scope: 'project', cwd: root, home: root }), /symbolic link/);
  await assert.rejects(installIntegration({ agent: 'claude', scope: 'project', cwd: root, home: root, force: true }), /symbolic link/);
  await assert.rejects(access(outside), /ENOENT/);
});

test('project install refuses a symlinked parent directory that escapes scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-parent-symlink-'));
  const outside = await mkdtemp(join(tmpdir(), 'agent-insight-parent-outside-'));
  await symlink(outside, join(root, '.claude'));
  await assert.rejects(installIntegration({ agent: 'claude', scope: 'project', cwd: root, home: root }), /symbolic-link parent/);
  await assert.rejects(access(join(outside, 'commands', 'agent-insights.md')), /ENOENT/);
});

test('installs Codex skills in the shared .agents skill surface', () => {
  const path = integrationPath({ agent: 'codex', scope: 'project', cwd: '/tmp/project', home: '/tmp/home' });
  assert.equal(path, '/tmp/project/.agents/skills/agent-insights/SKILL.md');
});

test('host bridges prepare fused semantic runs for their active model', () => {
  assert.deepEqual(AGENTS, ['claude', 'codex', 'cursor', 'opencode', 'pi']);
  for (const agent of AGENTS.filter((name) => name !== 'pi')) {
    const body = renderIntegration(agent);
    assert.match(body, new RegExp(`agent-insight prepare --host ${agent} --model .* --source`));
    assert.match(body, /agent-insight semantic next --run/);
    assert.match(body, /agent-insight semantic ingest --run/);
    assert.match(body, /agent-insight semantic fail --run/);
    assert.match(body, /agent-insight semantic finalize --run/);
    assert.match(body, /session_audit/);
    assert.match(body, /audit_aggregate/);
    assert.doesNotMatch(body, /agent-insight\s+cache\b/i);
  }
  const pi = renderIntegration('pi');
  assert.match(pi, /\["prepare", "--host", "pi", "--model", modelId, "--source"/);
  assert.match(pi, /agent-insight semantic next --run/);
  assert.match(pi, /agent-insight semantic ingest --run/);
  assert.match(pi, /agent-insight semantic fail --run/);
  assert.match(pi, /agent-insight semantic finalize --run/);
  assert.match(pi, /session_audit/);
  assert.match(pi, /audit_aggregate/);
  assert.doesNotMatch(pi, /agent-insight\s+cache\b/i);
  assert.match(renderIntegration('cursor'), /experimental/i);
  assert.match(renderIntegration('opencode'), /root sessions only/i);
  assert.doesNotMatch(renderIntegration('claude'), /claude\s+(?:-p|--print)/i);
  assert.doesNotMatch(renderIntegration('codex'), /codex\s+exec/i);
  assert.doesNotMatch(renderIntegration('opencode'), /opencode\s+run/i);
  assert.doesNotMatch(renderIntegration('cursor'), /cursor-agent\s+(?:-p|--print)/i);
  assert.throws(() => renderIntegration('groq'), /Unknown host agent/);
});

test('install refuses Groq because it is a provider, not a slash-command host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-groq-install-'));
  await assert.rejects(
    () => installIntegration({ agent: 'groq', scope: 'project', cwd: root, home: root }),
    /Groq is a provider/
  );
});

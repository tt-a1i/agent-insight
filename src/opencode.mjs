import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const execFileAsync = promisify(execFile);

function iso(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function increment(object, key) {
  if (!key || typeof key !== 'string') return;
  object[key] = (object[key] ?? 0) + 1;
}

function addAnalysisMessage(messages, role, text, limit) {
  if (typeof text !== 'string' || !text.trim()) return false;
  messages.push({ index: messages.length + 1, role, text: text.trim().slice(0, limit) });
  return true;
}

export function openCodeAnalysisInput(document) {
  const info = document?.info ?? {};
  const messages = [];
  let userMessageCount = 0;
  for (const message of document?.messages ?? []) {
    const role = String(message?.info?.role ?? '').toLowerCase();
    let userText = false;
    for (const part of message?.parts ?? []) {
      if (part?.type === 'text' && (role === 'user' || role === 'assistant')) {
        const added = addAnalysisMessage(messages, role, part.text, role === 'user' ? 500 : 300);
        if (role === 'user') userText ||= added;
      }
      if (part?.type === 'tool') addAnalysisMessage(messages, 'tool', part.tool ?? 'unknown', 120);
    }
    if (userText) userMessageCount += 1;
  }
  if (messages.length === 0) throw new Error('OpenCode export contains no analyzable messages.');
  const created = Date.parse(iso(info.time?.created));
  const updated = Date.parse(iso(info.time?.updated));
  const sessionId = String(info.id ?? 'unknown-opencode-session');
  return {
    source: 'opencode',
    sessionId,
    opaqueId: createHash('sha256').update(`opencode\u0000${sessionId}`).digest('hex').slice(0, 24),
    contentHash: createHash('sha256').update(JSON.stringify(document)).digest('hex'),
    date: Number.isFinite(created) ? new Date(created).toISOString().slice(0, 10) : null,
    projectPath: info.directory ? String(info.directory) : null,
    projectLabel: info.directory ? basename(String(info.directory).replace(/[\\/]+$/, '')) : 'unknown',
    userMessageCount,
    durationMinutes: Number.isFinite(created) && Number.isFinite(updated) && updated >= created ? Math.round((updated - created) / 60_000) : 0,
    messages
  };
}

/**
 * Keeps only metadata from OpenCode's official export shape. The JSON returned
 * by the OpenCode export command never reaches a report or the filesystem.
 */
export function normaliseOpenCodeExport(document, fallback = {}) {
  const info = document?.info ?? {};
  const session = {
    id: info.id ?? fallback.id ?? 'unknown-opencode-session',
    source: 'opencode',
    project: info.directory ?? fallback.directory ?? null,
    startedAt: iso(info.time?.created ?? fallback.created),
    endedAt: iso(info.time?.updated ?? fallback.updated),
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    turnFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolNames: {},
    providers: {},
    models: {},
    partial: false,
    partialReason: null,
    recordsRead: 0
  };
  let messageTokenData = false;
  for (const message of document?.messages ?? []) {
    session.recordsRead += 1;
    const messageInfo = message?.info ?? {};
    const role = String(messageInfo.role ?? '').toLowerCase();
    if (role === 'user') session.userMessages += 1;
    if (role === 'assistant') session.assistantMessages += 1;
    increment(session.providers, messageInfo.model?.providerID);
    increment(session.models, messageInfo.model?.modelID);
    if (messageInfo.tokens) {
      messageTokenData = true;
      session.inputTokens += Number(messageInfo.tokens.input ?? 0) || 0;
      session.outputTokens += Number(messageInfo.tokens.output ?? 0) || 0;
    }
    for (const part of message?.parts ?? []) {
      if (part?.type !== 'tool') continue;
      session.toolCalls += 1;
      increment(session.toolNames, part.tool ?? 'unknown');
      const status = String(part.state?.status ?? '').toLowerCase();
      if (['error', 'failed', 'denied'].includes(status)) session.toolErrors += 1;
    }
  }
  if (!messageTokenData) {
    session.inputTokens = Number(info.tokens?.input ?? 0) || 0;
    session.outputTokens = Number(info.tokens?.output ?? 0) || 0;
  }
  return session;
}

async function defaultRunner(args, { cwd, env }) {
  const binary = env.OPENCODE_BIN || 'opencode';
  const { stdout } = await execFileAsync(binary, [...args, '--pure'], {
    cwd,
    env,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

function requireSessionId(value) {
  const sessionId = String(value ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(sessionId)) throw new Error('Invalid OpenCode session id.');
  return sessionId;
}

export async function exportOpenCodeSession({ sessionId, cwd = process.cwd(), env = process.env, runner = defaultRunner }) {
  const document = JSON.parse(await runner(['export', requireSessionId(sessionId), '--sanitize'], { cwd, env }));
  return {
    document,
    session: normaliseOpenCodeExport(document, { id: sessionId }),
    input: openCodeAnalysisInput(document)
  };
}

/**
 * Uses only OpenCode's public CLI surface. Session list deliberately returns
 * root sessions, so the coverage result makes that limitation explicit.
 */
export async function collectOpenCodeSessions({
  cwd = process.cwd(),
  env = process.env,
  maxSessions = 500,
  runner = defaultRunner
} = {}) {
  let listed;
  try {
    listed = JSON.parse(await runner(['session', 'list', '--format', 'json', '--max-count', String(maxSessions)], { cwd, env }));
  } catch {
    return {
      sessions: [],
      diagnostic: {
        source: 'opencode',
        label: 'OpenCode',
        mode: 'official CLI export (root sessions only)',
        rootsFound: 0,
        filesFound: 0,
        filesSkipped: 0,
        filesPartial: 0,
        filesTooLarge: 0,
        coverage: 'unavailable',
        warning: 'OpenCode CLI is unavailable or failed. No OpenCode session metadata was read.'
      }
    };
  }

  const sessions = [];
  let failures = 0;
  const entries = Array.isArray(listed) ? listed : [];
  const concurrency = 6;
  for (let index = 0; index < entries.length; index += concurrency) {
    const batch = entries.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (listedSession) => {
      try {
        const exported = JSON.parse(await runner(['export', listedSession.id, '--sanitize'], { cwd, env }));
        const session = normaliseOpenCodeExport(exported, listedSession);
        Object.defineProperty(session, 'analysisLocator', {
          value: { kind: 'opencode', sessionId: String(listedSession.id), cwd },
          enumerable: false
        });
        return session;
      } catch {
        return null;
      }
    }));
    for (const result of results) {
      if (result) sessions.push(result);
      else failures += 1;
    }
  }
  return {
    sessions,
    diagnostic: {
      source: 'opencode',
      label: 'OpenCode',
      mode: 'official CLI export (root sessions only)',
      rootsFound: 1,
      filesFound: entries.length,
      filesSkipped: failures,
      filesPartial: 0,
      filesTooLarge: 0,
      coverage: failures || entries.length >= maxSessions ? 'partial_root_sessions' : 'root_sessions_only',
      warning: 'OpenCode CLI lists root sessions; forked and child sessions are not included by this adapter.'
    }
  };
}

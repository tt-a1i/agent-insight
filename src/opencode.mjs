import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

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
        return normaliseOpenCodeExport(exported, listedSession);
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

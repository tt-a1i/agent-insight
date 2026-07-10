import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { parseSessionFile } from './parse.mjs';
import { collectOpenCodeSessions } from './opencode.mjs';

export const SUPPORTED_SOURCES = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'groq', 'generic'];
const AUTO_SOURCES = ['claude', 'codex', 'cursor', 'opencode', 'pi', 'groq'];
const IMPORT_EXTENSIONS = new Set(['.jsonl', '.json', '.md', '.markdown']);

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function discoverFiles(root, { maxFiles = 10_000, maxDirectoryDepth = Infinity, extensions = IMPORT_EXTENSIONS } = {}) {
  const files = [];
  let errors = 0;
  const pending = [{ path: root, depth: 0 }];
  while (pending.length && files.length < maxFiles) {
    const { path: directory, depth } = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      errors += 1;
      continue;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('.DS_Store')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < maxDirectoryDepth) pending.push({ path, depth: depth + 1 });
      else if (entry.isFile() && extensions.has(extname(entry.name).toLowerCase())) files.push(path);
    }
  }
  return { files, truncated: files.length >= maxFiles, errors };
}

async function findCursorTranscriptRoots(projectRoots) {
  const roots = [];
  let errors = 0;
  for (const projectsRoot of projectRoots) {
    let projects;
    try {
      projects = await readdir(projectsRoot, { withFileTypes: true });
    } catch {
      errors += 1;
      continue;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const transcriptRoot = join(projectsRoot, project.name, 'agent-transcripts');
      if (await exists(transcriptRoot)) roots.push(transcriptRoot);
    }
  }
  return { roots, errors };
}

async function selectFilesForWindow(files, { days, now, maxSessions }) {
  const cutoff = days === Infinity ? -Infinity : now - days * 86_400_000;
  let statErrors = 0;
  const candidates = await Promise.all(files.map(async (path) => {
    try {
      const info = await stat(path);
      return { path, mtime: info.mtimeMs };
    } catch {
      statErrors += 1;
      return null;
    }
  }));
  const readable = candidates.filter(Boolean);
  const withinWindow = readable.filter((file) => file.mtime >= cutoff).sort((left, right) => right.mtime - left.mtime);
  return {
    files: withinWindow.slice(0, maxSessions).map((file) => file.path),
    filesFound: readable.length,
    filesWithinWindow: withinWindow.length,
    filesLimited: Math.max(0, withinWindow.length - maxSessions),
    statErrors
  };
}

export function sourceConfigurations({ home = homedir(), cwd = process.cwd(), env = process.env } = {}) {
  const xdgData = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const appSupport = join(home, 'Library', 'Application Support');
  const globalImports = join(home, '.agent-insight', 'imports');
  // An explicit home override must win even when it is invalid. Falling back
  // would make doctor report data from a different Codex/Claude installation.
  const codexHome = env.CODEX_HOME || join(home, '.codex');
  const claudeHome = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const explicitPiHome = env.PI_CODING_AGENT_SESSION_DIR || (env.PI_CODING_AGENT_DIR ? join(env.PI_CODING_AGENT_DIR, 'sessions') : null);
  const piRoots = explicitPiHome
    ? [explicitPiHome]
    : [
      join(home, '.pi', 'agent', 'sessions'),
      join(home, '.pi', 'sessions'),
      join(xdgData, 'pi', 'sessions'),
      join(cwd, '.pi', 'sessions')
    ];
  const cursorHome = env.CURSOR_DATA_DIR || join(home, '.cursor');
  return {
    claude: {
      label: 'Claude Code',
      mode: 'native JSONL',
      extensions: new Set(['.jsonl']),
      // ~/.claude/projects/<project>/<session>.jsonl. Nested files are
      // subagent journals and must not be counted as independent sessions.
      maxDirectoryDepth: 1,
      roots: [join(claudeHome, 'projects')]
    },
    codex: {
      label: 'Codex',
      mode: 'native JSONL',
      extensions: new Set(['.jsonl']),
      maxDirectoryDepth: 5,
      roots: [join(codexHome, 'sessions'), join(codexHome, 'archived_sessions')]
    },
    opencode: {
      label: 'OpenCode',
      mode: 'official CLI export (root sessions only)',
      maxDirectoryDepth: 0,
      roots: [join(xdgData, 'opencode', 'opencode.db'), join(appSupport, 'opencode', 'opencode.db')]
    },
    pi: {
      label: 'Pi',
      mode: 'best-effort local session scan',
      extensions: new Set(['.jsonl']),
      maxDirectoryDepth: 6,
      roots: piRoots
    },
    cursor: {
      label: 'Cursor',
      mode: 'experimental local agent-transcript JSONL',
      extensions: new Set(['.jsonl']),
      maxDirectoryDepth: 1,
      roots: [join(cursorHome, 'projects')]
    },
    groq: {
      label: 'Groq',
      mode: 'import-only (Groq is an API provider, not a desktop agent transcript store)',
      extensions: IMPORT_EXTENSIONS,
      maxDirectoryDepth: 3,
      roots: [join(globalImports, 'groq'), join(cwd, '.agent-insight', 'imports', 'groq')]
    },
    generic: {
      label: 'Generic JSONL/JSON/Markdown export',
      mode: 'import-only',
      extensions: IMPORT_EXTENSIONS,
      maxDirectoryDepth: 3,
      roots: [join(globalImports, 'generic'), join(cwd, '.agent-insight', 'imports', 'generic')]
    }
  };
}

export function resolveSources(requested = 'auto') {
  if (!requested || requested === 'auto') return AUTO_SOURCES;
  const sources = [...new Set(String(requested).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const unknown = sources.filter((source) => !SUPPORTED_SOURCES.includes(source));
  if (unknown.length) throw new Error(`Unknown source: ${unknown.join(', ')}. Supported: ${SUPPORTED_SOURCES.join(', ')}`);
  return sources;
}

async function parseFiles(files, source, limits) {
  const sessions = [];
  const failures = { parse: 0, tooLarge: 0, partial: 0 };
  const batchSize = 16;
  for (let index = 0; index < files.length; index += batchSize) {
    const batch = files.slice(index, index + batchSize);
    const outcomes = await Promise.all(batch.map(async (file) => {
      try {
        return { file, session: await parseSessionFile(file, source, limits) };
      } catch (error) {
        return { file, error };
      }
    }));
    for (const outcome of outcomes) {
      if (outcome.session) {
        sessions.push(outcome.session);
        if (outcome.session.partial) failures.partial += 1;
      } else if (outcome.error?.code === 'TRANSCRIPT_LIMIT') failures.tooLarge += 1;
      else failures.parse += 1;
    }
  }
  return { sessions, failures };
}

function sessionMatchesProject(session, project) {
  if (!project) return true;
  if (!session.project) return false;
  const normalizedProject = resolve(project);
  const normalizedSession = resolve(session.project);
  return normalizedSession === normalizedProject || normalizedSession.startsWith(`${normalizedProject}/`);
}

function sessionIsWithinDays(session, days, now) {
  if (days === Infinity) return true;
  const timestamp = Date.parse(session.endedAt ?? session.startedAt);
  return Number.isFinite(timestamp) && timestamp >= now - days * 86_400_000;
}

function mergeSession(current, incoming) {
  const merged = { ...current, toolNames: { ...current.toolNames }, providers: { ...current.providers }, models: { ...current.models } };
  for (const field of ['userMessages', 'assistantMessages', 'toolCalls', 'toolErrors', 'turnFailures', 'inputTokens', 'outputTokens', 'recordsRead']) {
    merged[field] = (current[field] ?? 0) + (incoming[field] ?? 0);
  }
  for (const [provider, count] of Object.entries(incoming.providers ?? {})) merged.providers[provider] = (merged.providers[provider] ?? 0) + count;
  for (const [model, count] of Object.entries(incoming.models ?? {})) merged.models[model] = (merged.models[model] ?? 0) + count;
  for (const [tool, count] of Object.entries(incoming.toolNames)) merged.toolNames[tool] = (merged.toolNames[tool] ?? 0) + count;
  merged.startedAt = !current.startedAt || (incoming.startedAt && incoming.startedAt < current.startedAt) ? incoming.startedAt : current.startedAt;
  merged.endedAt = !current.endedAt || (incoming.endedAt && incoming.endedAt > current.endedAt) ? incoming.endedAt : current.endedAt;
  merged.project ??= incoming.project;
  merged.partial ||= incoming.partial;
  merged.partialReason ??= incoming.partialReason;
  merged.hasBranches ||= incoming.hasBranches;
  return merged;
}

function chooseRicherSession(current, incoming) {
  const currentScore = (current.recordsRead ?? 0) * 10 + (current.assistantMessages ?? 0) + (current.toolCalls ?? 0);
  const incomingScore = (incoming.recordsRead ?? 0) * 10 + (incoming.assistantMessages ?? 0) + (incoming.toolCalls ?? 0);
  if (incomingScore !== currentScore) return incomingScore > currentScore ? incoming : current;
  return (incoming.endedAt ?? '') > (current.endedAt ?? '') ? incoming : current;
}

/** Collects transcript-derived metadata. It intentionally never returns raw text. */
export async function collectSessions({
  sources = 'auto',
  home,
  cwd,
  env,
  inputFiles = [],
  days = 30,
  project,
  includeSubagents = false,
  maxFileBytes = 16 * 1024 * 1024,
  maxRecords = 100_000,
  maxRecordBytes = 2 * 1024 * 1024,
  maxSessionsPerSource = 100,
  maxDiscoveryFiles = 10_000,
  maxOpenCodeSessions = 100,
  openCodeRunner,
  now = Date.now()
} = {}) {
  const config = sourceConfigurations({ home, cwd, env });
  const selected = resolveSources(sources);
  const diagnostics = [];
  const allSessions = [];
  for (const source of selected) {
    if (source === 'opencode') {
      const result = await collectOpenCodeSessions({ cwd, env: env ?? process.env, maxSessions: Math.min(maxOpenCodeSessions, maxSessionsPerSource), ...(openCodeRunner ? { runner: openCodeRunner } : {}) });
      allSessions.push(...result.sessions);
      diagnostics.push(result.diagnostic);
      continue;
    }
    const adapter = config[source];
    const readableRoots = [];
    for (const root of adapter.roots) {
      if (await exists(root)) readableRoots.push(root);
    }
    let files = [];
    let discoveryTruncated = false;
    let discoveryErrors = 0;
    let scanRoots = readableRoots;
    if (source === 'cursor') {
      const cursorRoots = await findCursorTranscriptRoots(readableRoots);
      scanRoots = cursorRoots.roots;
      discoveryErrors += cursorRoots.errors;
    }
    const maxDirectoryDepth = source === 'claude' && includeSubagents ? Infinity : adapter.maxDirectoryDepth;
    for (const root of scanRoots) {
      const discovered = await discoverFiles(root, { maxDirectoryDepth, maxFiles: maxDiscoveryFiles, extensions: adapter.extensions });
      files.push(...discovered.files);
      discoveryTruncated ||= discovered.truncated;
      discoveryErrors += discovered.errors;
    }
    files = [...new Set(files)];
    const selectedFiles = await selectFilesForWindow(files, { days, now, maxSessions: maxSessionsPerSource });
    const { sessions, failures } = await parseFiles(selectedFiles.files, source, { maxBytes: maxFileBytes, maxRecords, maxRecordBytes });
    allSessions.push(...sessions);
    diagnostics.push({
      source,
      label: adapter.label,
      mode: adapter.mode,
      rootsFound: readableRoots.length,
      transcriptRootsFound: source === 'cursor' ? scanRoots.length : undefined,
      filesFound: selectedFiles.filesFound,
      filesWithinWindow: selectedFiles.filesWithinWindow,
      filesSelected: selectedFiles.files.length,
      filesLimited: selectedFiles.filesLimited,
      discoveryTruncated,
      discoveryLimit: maxDiscoveryFiles,
      discoveryErrors,
      statErrors: selectedFiles.statErrors,
      filesSkipped: failures.parse + failures.tooLarge,
      filesPartial: failures.partial,
      filesTooLarge: failures.tooLarge,
      coverage: readableRoots.length === 0 ? 'not_found' : selectedFiles.filesWithinWindow === 0 ? 'empty' : (failures.parse || failures.partial || failures.tooLarge || selectedFiles.filesLimited || discoveryTruncated || discoveryErrors || selectedFiles.statErrors) ? 'partial' : 'available'
    });
  }

  for (const input of inputFiles) {
    const source = selected.length === 1 ? selected[0] : 'generic';
    const { sessions, failures } = await parseFiles([resolve(input)], source, { maxBytes: maxFileBytes, maxRecords, maxRecordBytes });
    allSessions.push(...sessions);
    diagnostics.push({ source, label: 'Explicit import', mode: 'explicit file', rootsFound: 1, filesFound: 1, filesSkipped: failures.parse + failures.tooLarge, filesPartial: failures.partial, filesTooLarge: failures.tooLarge, coverage: (failures.parse || failures.tooLarge || failures.partial) ? 'partial' : 'available' });
  }

  const unique = new Map();
  for (const session of allSessions) {
    const key = `${session.source}:${session.id}`;
    if (!unique.has(key)) unique.set(key, session);
    else if (session.source === 'claude' && includeSubagents) unique.set(key, mergeSession(unique.get(key), session));
    // Cursor may persist incremental copies of one conversation in more than
    // one project store; active/archive Codex duplicates have the same issue.
    else unique.set(key, chooseRicherSession(unique.get(key), session));
  }
  const deduplicated = [...unique.values()];
  const unknownProjectExcluded = project ? deduplicated.filter((session) => !session.project).length : 0;
  const filtered = deduplicated.filter((session) => sessionMatchesProject(session, project) && sessionIsWithinDays(session, days, now));
  return {
    sessions: filtered,
    diagnostics,
    sources: selected,
    projectFilter: project ? { requested: true, unknownProjectExcluded } : { requested: false, unknownProjectExcluded: 0 }
  };
}

export async function inspectSources(options = {}) {
  const config = sourceConfigurations(options);
  const sourceNames = resolveSources(options.sources ?? 'auto');
  return Promise.all(sourceNames.map(async (source) => {
    const adapter = config[source];
    const roots = await Promise.all(adapter.roots.map(async (path) => ({ path, found: await exists(path) })));
    return { source, label: adapter.label, mode: adapter.mode, roots };
  }));
}

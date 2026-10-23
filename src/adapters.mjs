import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { parseSessionFile } from './parse.mjs';
import { collectOpenCodeSessions } from './opencode.mjs';
import { authorshipCoverageNote } from './authorship.mjs';

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

function timeBounds({ days, now, start, end }) {
  if (start || end) {
    return {
      earliest: start ? Date.parse(`${start}T00:00:00.000Z`) : -Infinity,
      latest: end ? Date.parse(`${end}T23:59:59.999Z`) : Infinity
    };
  }
  return { earliest: days === Infinity ? -Infinity : now - days * 86_400_000, latest: now };
}

async function selectFilesForWindow(files, { days, now, start, end, maxSessions }) {
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
  // mtime is only a discovery ordering hint. Restores, copies, migrations, and
  // sync tools can change it independently of the session timestamps.
  const ordered = readable.sort((left, right) => right.mtime - left.mtime);
  return {
    files: ordered.slice(0, maxSessions).map((file) => file.path),
    filesFound: readable.length,
    filesWithinWindow: null,
    filesLimited: Math.max(0, ordered.length - maxSessions),
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
  // Claude branch selection needs a compact UUID topology per file before a
  // second streaming pass can aggregate the winning leaf. Keep that bounded
  // across large histories while other adapters retain the faster batch size.
  const batchSize = source === 'claude' ? 2 : 16;
  for (let index = 0; index < files.length; index += batchSize) {
    const batch = files.slice(index, index + batchSize);
    const outcomes = await Promise.all(batch.map(async (file) => {
      try {
        const session = await parseSessionFile(file, source, limits);
        if (session) {
          const locator = { kind: 'file', path: file };
          Object.defineProperties(locator, {
            maxBytes: { value: limits.maxBytes, enumerable: false },
            maxRecords: { value: limits.maxRecords, enumerable: false },
            maxRecordBytes: { value: limits.maxRecordBytes, enumerable: false }
          });
          Object.defineProperty(session, 'analysisLocator', { value: locator, enumerable: false });
        }
        return { file, session };
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

function sessionProjectPaths(session) {
  const paths = Array.isArray(session.projectPaths) ? session.projectPaths : [session.project ?? session.projectPath];
  return [...new Set(paths.filter((path) => typeof path === 'string' && path.trim()).map((path) => path.trim()))];
}

export function sessionMatchesProject(session, project, cwd = process.cwd()) {
  if (!project) return true;
  const paths = sessionProjectPaths(session);
  return paths.length > 0 && paths.every((path) => {
    const child = relative(resolve(cwd, project), resolve(cwd, path));
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../') && !child.startsWith('..\\'));
  });
}

export function sessionIsWithinWindow(session, { days, now, start, end }) {
  const { earliest, latest } = timeBounds({ days, now, start, end });
  const timestamp = Date.parse(session.endedAt ?? session.startedAt);
  return Number.isFinite(timestamp) && timestamp >= earliest && timestamp <= latest;
}

function mergeSession(current, incoming) {
  const merged = { ...current, toolNames: { ...current.toolNames }, providers: { ...current.providers }, models: { ...current.models } };
  // Per-file coverage cannot describe merged journals. Keep compatible scalar
  // subtotals, but leave measured token coverage unknown until it can be merged.
  delete merged.tokenUsage;
  for (const field of ['userMessages', 'assistantMessages', 'toolCalls', 'toolErrors', 'turnFailures', 'inputTokens', 'outputTokens', 'recordsRead']) {
    merged[field] = (current[field] ?? 0) + (incoming[field] ?? 0);
  }
  for (const [provider, count] of Object.entries(incoming.providers ?? {})) merged.providers[provider] = (merged.providers[provider] ?? 0) + count;
  for (const [model, count] of Object.entries(incoming.models ?? {})) merged.models[model] = (merged.models[model] ?? 0) + count;
  for (const [tool, count] of Object.entries(incoming.toolNames)) merged.toolNames[tool] = (merged.toolNames[tool] ?? 0) + count;
  merged.startedAt = !current.startedAt || (incoming.startedAt && incoming.startedAt < current.startedAt) ? incoming.startedAt : current.startedAt;
  merged.endedAt = !current.endedAt || (incoming.endedAt && incoming.endedAt > current.endedAt) ? incoming.endedAt : current.endedAt;
  merged.project ??= incoming.project;
  merged.projectPaths = [...new Set([...sessionProjectPaths(current), ...sessionProjectPaths(incoming)])];
  merged.partial ||= incoming.partial;
  merged.partialReason ??= incoming.partialReason;
  merged.hasBranches ||= incoming.hasBranches;
  // The merged metadata describes several files. A locator for only one file
  // would falsely claim that semantic analysis covered the entire session.
  Object.defineProperty(merged, 'semanticExclusionReason', { value: 'merged_subagent_transcripts', enumerable: false });
  return merged;
}

function chooseRicherSession(current, incoming) {
  if (Boolean(current.partial) !== Boolean(incoming.partial)) return current.partial ? incoming : current;
  const currentScore = (current.recordsRead ?? 0) * 10 + (current.assistantMessages ?? 0) + (current.toolCalls ?? 0);
  const incomingScore = (incoming.recordsRead ?? 0) * 10 + (incoming.assistantMessages ?? 0) + (incoming.toolCalls ?? 0);
  if (incomingScore !== currentScore) return incomingScore > currentScore ? incoming : current;
  return (incoming.endedAt ?? '') > (current.endedAt ?? '') ? incoming : current;
}

function sessionDurationMinutes(session) {
  const start = Date.parse(session.startedAt);
  const end = Date.parse(session.endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? Math.round((end - start) / 60_000)
    : 0;
}

function chooseClaudeSession(current, incoming) {
  if (Boolean(current.partial) !== Boolean(incoming.partial)) return current.partial ? incoming : current;
  if (incoming.userMessages !== current.userMessages) {
    return incoming.userMessages > current.userMessages ? incoming : current;
  }
  return sessionDurationMinutes(incoming) > sessionDurationMinutes(current) ? incoming : current;
}

/** Collects transcript-derived metadata. It intentionally never returns raw text. */
export async function collectSessions({
  sources = 'auto',
  home,
  cwd,
  env,
  inputFiles = [],
  days = 30,
  start,
  end,
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
  const collectionCwd = resolve(cwd ?? process.cwd());
  const normalizedProject = project ? resolve(collectionCwd, project) : null;
  const config = sourceConfigurations({ home, cwd, env });
  const selected = resolveSources(sources);
  const diagnostics = [];
  const allSessions = [];
  for (const source of selected) {
    if (source === 'opencode') {
      const result = await collectOpenCodeSessions({ cwd, env: env ?? process.env, maxSessions: Math.min(maxOpenCodeSessions, maxSessionsPerSource), ...(openCodeRunner ? { runner: openCodeRunner } : {}) });
      if (result.diagnostic.coverage === 'partial_root_sessions') {
        result.diagnostic.warning += ' Candidate session limits apply before session date and project filtering; matching sessions may remain unread.';
      }
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
    const selectedFiles = await selectFilesForWindow(files, { days, now, start, end, maxSessions: maxSessionsPerSource });
    const { sessions, failures } = await parseFiles(selectedFiles.files, source, { maxBytes: maxFileBytes, maxRecords, maxRecordBytes });
    const sessionsWithinWindow = sessions.filter((session) => sessionIsWithinWindow(session, { days, now, start, end }));
    allSessions.push(...sessions);
    const authorshipNote = authorshipCoverageNote(source);
    const selectionNote = selectedFiles.filesLimited || discoveryTruncated
      ? 'Candidate file limits apply before session date and project filtering; matching sessions may remain unread. Selection uses filesystem modification time, not session date.'
      : null;
    diagnostics.push({
      source,
      label: adapter.label,
      mode: adapter.mode,
      rootsFound: readableRoots.length,
      transcriptRootsFound: source === 'cursor' ? scanRoots.length : undefined,
      filesFound: selectedFiles.filesFound,
      filesWithinWindow: sessionsWithinWindow.length,
      filesSelected: selectedFiles.files.length,
      filesLimited: selectedFiles.filesLimited,
      discoveryTruncated,
      discoveryLimit: maxDiscoveryFiles,
      discoveryErrors,
      statErrors: selectedFiles.statErrors,
      filesSkipped: failures.parse + failures.tooLarge,
      filesPartial: failures.partial,
      filesTooLarge: failures.tooLarge,
      warning: [authorshipNote, selectionNote].filter(Boolean).join('; ') || undefined,
      coverage: readableRoots.length === 0
        ? 'not_found'
        : (failures.parse || failures.partial || failures.tooLarge || selectedFiles.filesLimited || discoveryTruncated || discoveryErrors || selectedFiles.statErrors)
            ? 'partial'
            : sessionsWithinWindow.length === 0 ? 'empty' : 'available'
    });
  }

  for (const input of inputFiles) {
    const source = selected.length === 1 ? selected[0] : 'generic';
    const { sessions, failures } = await parseFiles([resolve(input)], source, { maxBytes: maxFileBytes, maxRecords, maxRecordBytes });
    allSessions.push(...sessions);
    diagnostics.push({ source, label: 'Explicit import', mode: 'explicit file', rootsFound: 1, filesFound: 1, filesSelected: 1, filesSkipped: failures.parse + failures.tooLarge, filesPartial: failures.partial, filesTooLarge: failures.tooLarge, coverage: (failures.parse || failures.tooLarge || failures.partial) ? 'partial' : 'available' });
  }

  const unique = new Map();
  const projectsByGroup = new Map();
  const seenFiles = new Set();
  const duplicateGroups = new Set();
  for (const session of allSessions) {
    const file = session.analysisLocator?.kind === 'file' ? `${session.source}:${resolve(session.analysisLocator.path)}` : null;
    // Discovery and --input can refer to the same physical path. That is not a
    // second journal to merge, or another identity/provenance conflict.
    if (file && seenFiles.has(file)) continue;
    if (file) seenFiles.add(file);
    const key = `${session.source}:${session.id}`;
    const current = unique.get(key);
    if (!current) {
      unique.set(key, session);
      projectsByGroup.set(key, sessionProjectPaths(session));
      continue;
    }
    duplicateGroups.add(key);
    // Scope belongs to the whole source/native identity, not just whichever
    // physical copy wins the semantic representative comparison.
    projectsByGroup.set(key, [...new Set([...projectsByGroup.get(key), ...sessionProjectPaths(session)])]);
    let preferred;
    if (session.source === 'claude' && includeSubagents) preferred = mergeSession(current, session);
    else {
      // Use each physical copy's own provenance here. Group-unioned paths must
      // never make an unknown-project transcript appear to prove scope.
      const currentScoped = !current.partial && sessionMatchesProject(current, normalizedProject, collectionCwd);
      const incomingScoped = !session.partial && sessionMatchesProject(session, normalizedProject, collectionCwd);
      preferred = normalizedProject && currentScoped !== incomingScoped
        ? currentScoped ? current : session
        : session.source === 'claude' ? chooseClaudeSession(current, session) : chooseRicherSession(current, session);
    }
    unique.set(key, preferred);
  }
  const deduplicated = [...unique.values()];
  for (const [key, session] of unique) session.projectPaths = projectsByGroup.get(key);
  const projectConflicts = deduplicated.filter((session) => duplicateGroups.has(`${session.source}:${session.id}`)
    && new Set(sessionProjectPaths(session).map((path) => resolve(collectionCwd, path))).size > 1);
  const unknownProjectExcluded = normalizedProject ? deduplicated.filter((session) => !sessionProjectPaths(session).length).length : 0;
  const mixedProjects = normalizedProject ? deduplicated.filter((session) => {
    const matches = sessionProjectPaths(session).map((path) => sessionMatchesProject({ project: path }, normalizedProject, collectionCwd));
    return matches.some(Boolean) && matches.some((match) => !match);
  }) : [];
  const filtered = deduplicated.filter((session) => sessionMatchesProject(session, normalizedProject, collectionCwd) && sessionIsWithinWindow(session, { days, now, start, end }));
  const diagnosedSources = new Set();
  for (const diagnostic of diagnostics) {
    // Group-level exclusions/conflicts are counted once per source, even when
    // explicit input files produced additional per-file diagnostic rows.
    if (diagnosedSources.has(diagnostic.source)) continue;
    diagnosedSources.add(diagnostic.source);
    const conflicts = projectConflicts.filter((session) => session.source === diagnostic.source).length;
    if (conflicts) {
      diagnostic.duplicateProjectConflicts = conflicts;
      diagnostic.coverage = 'partial';
      diagnostic.warning = [diagnostic.warning, `${conflicts} duplicate session group(s) have multiple known project paths; all observed project provenance is retained for scope checks.`].filter(Boolean).join('; ');
    }
    const mixed = mixedProjects.filter((session) => session.source === diagnostic.source).length;
    if (mixed) {
      diagnostic.mixedProjectExcluded = mixed;
      diagnostic.coverage = 'partial';
      diagnostic.warning = [diagnostic.warning, `${mixed} mixed-project session(s) excluded because their metadata crosses the requested project scope.`].filter(Boolean).join('; ');
    }
    const excluded = filtered.filter((session) => session.source === diagnostic.source && session.semanticExclusionReason).length;
    if (!excluded) continue;
    diagnostic.semanticExcluded = excluded;
    diagnostic.coverage = 'partial';
    diagnostic.warning = [diagnostic.warning, `${excluded} merged session(s) excluded from semantic analysis: merged subagent transcripts have no complete semantic projection.`].filter(Boolean).join('; ');
  }
  return {
    sessions: filtered,
    analysisCandidates: filtered.flatMap((session) => session.analysisLocator && !session.partial ? [{ source: session.source, locator: session.analysisLocator }] : []),
    diagnostics,
    sources: selected,
    projectFilter: normalizedProject ? { requested: true, path: normalizedProject, unknownProjectExcluded, mixedProjectExcluded: mixedProjects.length } : { requested: false, unknownProjectExcluded: 0, mixedProjectExcluded: 0 }
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

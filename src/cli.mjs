import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { collectSessions, inspectSources, resolveSources, SUPPORTED_SOURCES } from './adapters.mjs';
import { summarizeSessions } from './analyze.mjs';
import { installIntegration, AGENTS } from './integrations.mjs';
import { parseSessionFile } from './parse.mjs';
import { writeReport } from './report.mjs';

const HELP = `agent-insight — local-first cross-agent session insights\n\nUsage:\n  agent-insight doctor [--source auto|codex,claude,...] [--json]\n  agent-insight report [--source auto|codex,claude,...] [--days 30|--all]\n                       [--project <path>] [--input <export-file>] [--output <directory>]\n                       [--include-subagents] [--max-file-mb 16] [--max-sessions 100]\n                       [--max-discovery-files 10000]\n  agent-insight install --agent claude|codex|cursor|opencode|pi [--scope project|user] [--force]\n  agent-insight import --source groq|generic --from <export-file>\n\nThe report is metadata-only: no raw prompts, tool output, code, source file paths, or session IDs are written.\n`;

function parseFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) {
      flags._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split('=', 2);
    const value = inline ?? (args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : true);
    if (key === 'input') flags.input = [...(flags.input ?? []), value];
    else flags[key] = value;
  }
  return flags;
}

function printDoctor(rows, json) {
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const row of rows) {
    const locations = row.roots.map((root) => root.found ? `found ${root.path}` : `missing ${root.path}`).join('\n    ');
    console.log(`${row.source.padEnd(9)} ${row.mode}\n    ${locations}`);
  }
}

function daysFrom(flags) {
  if (flags.all) return Infinity;
  if (flags.days === undefined) return 30;
  const days = Number(flags.days);
  if (!Number.isFinite(days) || days < 0) throw new Error('--days must be a non-negative number.');
  return days;
}

function maxFileBytesFrom(flags) {
  if (flags['max-file-mb'] === undefined) return 16 * 1024 * 1024;
  const megabytes = Number(flags['max-file-mb']);
  if (!Number.isFinite(megabytes) || megabytes <= 0) throw new Error('--max-file-mb must be greater than zero.');
  return Math.floor(megabytes * 1024 * 1024);
}

function maxSessionsFrom(flags) {
  if (flags['max-sessions'] === undefined) return 100;
  const count = Number(flags['max-sessions']);
  if (!Number.isInteger(count) || count <= 0) throw new Error('--max-sessions must be a positive integer.');
  return count;
}

function maxDiscoveryFilesFrom(flags) {
  if (flags['max-discovery-files'] === undefined) return 10_000;
  const count = Number(flags['max-discovery-files']);
  if (!Number.isInteger(count) || count <= 0) throw new Error('--max-discovery-files must be a positive integer.');
  return count;
}

async function runReport(flags, context) {
  const days = daysFrom(flags);
  const source = flags.source ?? 'auto';
  const { sessions, diagnostics, sources, projectFilter } = await collectSessions({
    sources: source,
    home: context.home,
    cwd: context.cwd,
    inputFiles: flags.input?.filter((value) => typeof value === 'string') ?? [],
    days,
    project: typeof flags.project === 'string' ? flags.project : undefined,
    includeSubagents: Boolean(flags['include-subagents']),
    maxFileBytes: maxFileBytesFrom(flags),
    maxSessionsPerSource: maxSessionsFrom(flags),
    maxDiscoveryFiles: maxDiscoveryFilesFrom(flags)
  });
  const report = summarizeSessions(sessions, { days, sourcesScanned: diagnostics, projectFilter });
  const output = resolve(typeof flags.output === 'string' ? flags.output : join(context.home, '.agent-insight', 'latest'));
  const files = await writeReport(report, output);
  console.log(`Agent Insight ready: ${report.totals.sessions} sessions from ${sources.join(', ') || 'no sources'}`);
  console.log(`HTML: ${files.html}`);
  console.log(`Markdown: ${files.markdown}`);
  console.log(`Agent handoff: ${files.prompt}`);
  return { report, files };
}

async function runImport(flags, context) {
  const source = String(flags.source ?? 'generic').toLowerCase();
  if (!['groq', 'generic'].includes(source)) throw new Error('import currently supports --source groq or --source generic.');
  if (typeof flags.from !== 'string') throw new Error('import requires --from <export-file>.');
  const origin = resolve(flags.from);
  const extension = extname(origin).toLowerCase();
  if (!['.jsonl', '.json', '.md', '.markdown'].includes(extension)) throw new Error('Supported imports: .jsonl, .json, .md, .markdown');
  const directory = join(context.home, '.agent-insight', 'imports', source);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // Read the export once, reduce it to permitted metadata, then discard the
  // raw bytes. Imports deliberately never become an on-disk transcript cache.
  const session = await parseSessionFile(origin, source, { maxBytes: maxFileBytesFrom(flags) });
  const info = await stat(origin);
  const stableId = createHash('sha256').update(`${source}\u0000${origin}\u0000${info.size}\u0000${info.mtimeMs}`).digest('hex').slice(0, 32);
  const metadata = {
    schema: 'agent-insight/import-v1',
    session: {
      id: stableId,
      source,
      project: null,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      userMessages: session.userMessages,
      assistantMessages: session.assistantMessages,
      toolCalls: session.toolCalls,
      toolErrors: session.toolErrors,
      turnFailures: session.turnFailures,
      inputTokens: session.inputTokens,
      outputTokens: session.outputTokens,
      toolNames: session.toolNames,
      providers: session.providers,
      models: session.models,
      partial: session.partial,
      partialReason: session.partialReason,
      recordsRead: session.recordsRead,
      hasBranches: session.hasBranches
    }
  };
  const target = join(directory, `${stableId}.json`);
  await writeFile(target, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  console.log(`Imported ${source} metadata snapshot: ${target}`);
}

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), home = homedir() } = {}) {
  const [command = 'help', ...rest] = argv;
  const flags = parseFlags(rest);
  const context = { cwd, home };
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  if (command === '--version' || command === 'version') {
    console.log('agent-insight 0.1.0');
    return;
  }
  if (command === 'doctor') {
    printDoctor(await inspectSources({ ...context, sources: flags.source ?? 'auto' }), Boolean(flags.json));
    return;
  }
  if (command === 'report') return runReport(flags, context);
  if (command === 'install') {
    const agent = String(flags.agent ?? '').toLowerCase();
    if (agent === 'groq') throw new Error('Groq is a provider, not a slash-command host. Use: agent-insight import --source groq --from <export-file>');
    if (!AGENTS.includes(agent)) throw new Error(`install requires --agent ${AGENTS.join('|')}`);
    const scope = flags.scope ?? 'project';
    if (!['project', 'user'].includes(scope)) throw new Error('--scope must be project or user.');
    const target = await installIntegration({ agent, scope, cwd, home, force: Boolean(flags.force) });
    console.log(`Installed ${agent} integration: ${target}`);
    return;
  }
  if (command === 'import') return runImport(flags, context);
  if (command === 'sources') {
    console.log(SUPPORTED_SOURCES.join('\n'));
    return;
  }
  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

export { HELP, parseFlags, resolveSources };

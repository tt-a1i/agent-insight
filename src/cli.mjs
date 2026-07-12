import { chmod, mkdir, open, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { collectSessions, inspectSources, resolveSources, SUPPORTED_SOURCES } from './adapters.mjs';
import { summarizeSessions } from './analyze.mjs';
import { installIntegration, AGENTS } from './integrations.mjs';
import { parseSessionFile } from './parse.mjs';
import { writeReport } from './report.mjs';
import { HOSTS, resolveInsightRequest } from './interaction.mjs';
import { FacetCache } from './cache.mjs';
import { failSemanticTask, finalizeSemanticRun, getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun, semanticSubmissionForTask } from './semantic-run.mjs';
import { compareParityReports, createBlindSemanticBundle, evaluateBlindSemanticRatings } from './parity.mjs';

const HELP = `agent-insight — local-first cross-agent session insights\n\nUsage:\n  agent-insight insights --host claude|codex|cursor|opencode|pi\n  agent-insight prepare --host <host> --source <agents> [--days 30|--all|--start YYYY-MM-DD --end YYYY-MM-DD]\n  agent-insight semantic next|ingest|finalize --run <run-id> [--task <task-id>] [--output <directory>]\n  agent-insight cache status|clear\n  agent-insight cache rebuild --host <host> --model <exact-model-id> [--source <agents>] [--days 30|--all]\n  agent-insight parity compare --reference <report.json> --candidate <report.json> [--output <comparison.json>] [--blind-output <review.json>]\n  agent-insight parity evaluate --review <rated-review.json> [--seed <secret>] [--output <result.json>]\n  agent-insight doctor [--source auto|codex,claude,...] [--json]\n  agent-insight report [--source auto|codex,claude,...] [--days 30|--all]\n                       [--project <path>] [--input <export-file>] [--output <directory>]\n                       [--include-subagents] [--max-file-mb 16] [--max-sessions 100]\n                       [--max-discovery-files 10000]\n  agent-insight install --agent claude|codex|cursor|opencode|pi [--scope project|user] [--force]\n  agent-insight import --source groq|generic --from <export-file>\n\nInsights uses the current host model for semantic analysis. Reports may include representative user quotations, project paths, agent identity, dates, and session identifiers. Complete transcripts and tool payloads are not copied into the report.\n`;

const PUBLIC_HELP = HELP
  .replace('semantic next|ingest|finalize --run <run-id> [--task <task-id>] [--output <directory>]', 'semantic next|ingest|fail|finalize --run <run-id> --host <host> --model <exact-model-id-or-unknown> [--task <task-id>] [--reason <failure-code>] [--output <directory>]')
  .replace('parity compare --reference <report.json> --candidate <report.json>', 'parity compare --reference <report.json> --reference-sha256 <trusted-hash> --candidate <report.json>');

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

async function prepareFromRequest(request, flags, context) {
  const collected = await collectSessions({
    sources: request.sources.join(','),
    home: context.home,
    cwd: context.cwd,
    days: request.days ?? Infinity,
    start: request.start,
    end: request.end,
    maxFileBytes: maxFileBytesFrom(flags),
    maxSessionsPerSource: flags['max-sessions'] === undefined ? 100_000 : maxSessionsFrom(flags),
    maxDiscoveryFiles: flags['max-discovery-files'] === undefined ? 100_000 : maxDiscoveryFilesFrom(flags)
  });
  const base = join(context.home, '.agent-insight');
  const run = await prepareSemanticRun({
    runsRoot: join(base, 'runs'),
    cache: new FacetCache(join(base, 'cache', 'facets')),
    request,
    candidates: collected.analysisCandidates,
    analyzer: { host: request.host, model: typeof flags.model === 'string' ? flags.model.trim() : 'unknown' },
    diagnostics: collected.diagnostics
  });
  if (!context.quiet) console.log(JSON.stringify({ runId: run.id, manifestPath: run.manifestPath }, null, 2));
  return { request, runId: run.id, manifestPath: run.manifestPath };
}

async function runInsights(flags, context) {
  let reader;
  const ask = context.ask ?? ((question) => {
    reader ??= createInterface({ input: process.stdin, output: process.stdout });
    return reader.question(question);
  });
  let request;
  try {
    request = await resolveInsightRequest({ host: flags.host, fast: Boolean(flags.fast) }, { ask });
  } finally {
    reader?.close();
  }
  const prepared = await prepareFromRequest(request, flags, context);
  if (!context.quiet) console.log(`Next: agent-insight semantic next --run ${prepared.runId} --host ${request.host} --model ${typeof flags.model === 'string' ? flags.model.trim() : 'unknown'}`);
  return prepared;
}

function requireHostFlag(value) {
  const host = String(value ?? '').toLowerCase();
  if (!HOSTS.includes(host)) throw new Error(`--host must be one of: ${HOSTS.join(', ')}.`);
  return host;
}

function dateFlag(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  return value;
}

function requestFromFlags(flags) {
  const host = requireHostFlag(flags.host);
  const sources = resolveSources(flags.source ?? host);
  const invalid = sources.filter((source) => !HOSTS.includes(source));
  if (invalid.length) throw new Error(`Semantic insights supports agent sources only: ${HOSTS.join(', ')}.`);
  const custom = flags.start !== undefined || flags.end !== undefined;
  if (custom && (flags.all || flags.days !== undefined)) throw new Error('Use either --days/--all or --start with --end.');
  const start = custom ? dateFlag(flags.start, '--start') : null;
  const end = custom ? dateFlag(flags.end, '--end') : null;
  if (start && end && start > end) throw new Error('--start must not be after --end.');
  const days = custom ? null : daysFrom(flags);
  const allSelected = HOSTS.every((source) => sources.includes(source)) && sources.length === HOSTS.length;
  return {
    host,
    sources,
    scope: allSelected ? 'all' : sources.length === 1 && sources[0] === host ? 'current' : 'select',
    days,
    start,
    end,
    semantic: true,
    fast: Boolean(flags.fast)
  };
}

async function runPrepare(flags, context) {
  return prepareFromRequest(requestFromFlags(flags), flags, context);
}

function semanticPaths(context) {
  const base = join(context.home, '.agent-insight');
  return { runsRoot: join(base, 'runs'), cache: new FacetCache(join(base, 'cache', 'facets')) };
}

async function runSemantic(flags, context) {
  const action = flags._[0];
  if (!['next', 'ingest', 'fail', 'finalize'].includes(action)) throw new Error('semantic requires next, ingest, fail, or finalize.');
  if (typeof flags.run !== 'string') throw new Error('semantic requires --run <run-id>.');
  const paths = semanticPaths(context);
  const actorHost = requireHostFlag(flags.host);
  if (typeof flags.model !== 'string' || !flags.model.trim()) throw new Error('semantic requires --model <exact-model-id-or-unknown>.');
  const actorModel = flags.model.trim();
  const run = await getSemanticRun({ runsRoot: paths.runsRoot, runId: flags.run });
  const expectedModel = run.analyzer?.model ?? 'unknown';
  if (run.analyzer?.host !== actorHost || expectedModel !== actorModel) {
    throw new Error(`Semantic run belongs to ${run.analyzer?.host}/${expectedModel}; refusing ${actorHost}/${actorModel}.`);
  }
  if (action === 'next') {
    const task = await nextSemanticTask({ ...paths, runId: flags.run });
    if (!context.quiet) console.log(JSON.stringify(task, null, 2));
    return task;
  }
  if (action === 'fail') {
    if (typeof flags.task !== 'string') throw new Error('semantic fail requires --task <task-id>.');
    const value = await failSemanticTask({ runsRoot: paths.runsRoot, runId: flags.run, taskId: flags.task, reason: String(flags.reason ?? 'analyzer_failure') });
    if (!context.quiet) console.log(JSON.stringify(value, null, 2));
    return value;
  }
  if (action === 'ingest') {
    if (typeof flags.task !== 'string') throw new Error('semantic ingest requires --task <task-id>.');
    const submissionPath = await semanticSubmissionForTask({ runsRoot: paths.runsRoot, runId: flags.run, taskId: flags.task });
    const handle = await open(submissionPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let result;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Semantic submission must be a regular JSON file no larger than 2 MiB.');
      result = JSON.parse(await handle.readFile('utf8'));
    } finally {
      await handle.close();
    }
    const value = await ingestSemanticResult({ ...paths, runId: flags.run, taskId: flags.task, result });
    await unlink(submissionPath);
    if (!context.quiet) console.log(JSON.stringify(value, null, 2));
    return value;
  }
  const outputDirectory = resolve(typeof flags.output === 'string' ? flags.output : join(context.home, '.agent-insight', 'usage-data'));
  const value = await finalizeSemanticRun({ runsRoot: paths.runsRoot, runId: flags.run, outputDirectory });
  if (!context.quiet) {
    console.log(`Your shareable insights report is ready:\nfile://${value.files.timestampedHtml}`);
    console.log('\nWant to dig into any section or try one of the suggestions?');
  }
  return value;
}

async function runCache(flags, context) {
  const action = flags._[0] ?? 'status';
  const cache = semanticPaths(context).cache;
  if (action === 'status') {
    const value = await cache.status();
    if (!context.quiet) console.log(JSON.stringify(value, null, 2));
    return value;
  }
  if (action === 'clear') {
    const value = await cache.clear();
    if (!context.quiet) console.log(`${value} cached facets removed.`);
    return value;
  }
  if (action === 'rebuild') {
    if (typeof flags.host !== 'string' || typeof flags.model !== 'string' || flags.model === 'unknown') {
      throw new Error('cache rebuild requires --host <host> and --model <exact-model-id>; it creates a semantic rebuild run.');
    }
    const removed = await cache.clearForAnalyzer(flags.host, flags.model);
    const prepared = await runPrepare(flags, context);
    return { removed, ...prepared };
  }
  throw new Error('cache requires status, clear, or rebuild.');
}

async function writePrivateJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

async function runParity(flags, context) {
  if (flags._[0] === 'evaluate') {
    if (typeof flags.review !== 'string') throw new Error('parity evaluate requires --review <rated-review.json>.');
    const review = JSON.parse(await readFile(resolve(flags.review), 'utf8'));
    const evaluation = evaluateBlindSemanticRatings(review, { seed: String(flags.seed ?? '') });
    if (typeof flags.output === 'string') await writePrivateJson(flags.output, evaluation);
    if (!context.quiet) console.log(JSON.stringify(evaluation, null, 2));
    return evaluation;
  }
  if (flags._[0] !== 'compare') throw new Error('parity requires compare or evaluate.');
  if (typeof flags.reference !== 'string' || typeof flags.candidate !== 'string') {
    throw new Error('parity compare requires --reference <report.json> and --candidate <report.json>.');
  }
  const [referenceText, candidateText] = await Promise.all([
    readFile(resolve(flags.reference), 'utf8'),
    readFile(resolve(flags.candidate), 'utf8')
  ]);
  const reference = JSON.parse(referenceText);
  const candidate = JSON.parse(candidateText);
  const referenceFileHash = createHash('sha256').update(referenceText).digest('hex');
  const candidateHtmlPath = typeof flags['candidate-html'] === 'string'
    ? resolve(flags['candidate-html'])
    : resolve(flags.candidate).replace(/\.json$/i, '.html');
  const candidateHtml = await readFile(candidateHtmlPath, 'utf8').catch(() => null);
  const comparison = compareParityReports(reference, candidate, {
    candidateHtml,
    referenceFileHash,
    trustedReferenceFileHash: typeof flags['reference-sha256'] === 'string' ? flags['reference-sha256'].toLowerCase() : null
  });
  if (typeof flags.output === 'string') await writePrivateJson(flags.output, comparison);
  if (typeof flags['blind-output'] === 'string') {
    await writePrivateJson(flags['blind-output'], createBlindSemanticBundle(reference, candidate, { seed: String(flags.seed ?? ''), machineComparison: comparison }));
  }
  if (!context.quiet) console.log(JSON.stringify(comparison, null, 2));
  return comparison;
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

export async function main(argv = process.argv.slice(2), options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? homedir();
  const [command = 'help', ...rest] = argv;
  const flags = parseFlags(rest);
  const context = { cwd, home, ask: options.ask, quiet: Boolean(options.quiet) };
  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(PUBLIC_HELP);
    return;
  }
  if (command === '--version' || command === 'version') {
    console.log('agent-insight 0.2.0');
    return;
  }
  if (command === 'doctor') {
    printDoctor(await inspectSources({ ...context, sources: flags.source ?? 'auto' }), Boolean(flags.json));
    return;
  }
  if (command === 'insights') return runInsights(flags, context);
  if (command === 'prepare') return runPrepare(flags, context);
  if (command === 'semantic') return runSemantic(flags, context);
  if (command === 'cache') return runCache(flags, context);
  if (command === 'parity') return runParity(flags, context);
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

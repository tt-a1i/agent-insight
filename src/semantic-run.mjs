import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { ANALYSIS_PROTOCOL_VERSION, createSessionFacetRequest, validateSessionFacet } from './protocol.mjs';
import { AGGREGATE_TASKS, createAggregateRequest, validateAggregateResult } from './aggregate-protocol.mjs';
import { extractAnalysisInput } from './transcript.mjs';
import { parseSessionFile } from './parse.mjs';
import { summarizeSessions } from './analyze.mjs';
import { writeReport } from './report.mjs';
import { exportOpenCodeSession } from './opencode.mjs';

const RUN_SCHEMA = 'agent-insight/semantic-run-v1';
const PROMPT_VERSION = 'session-facet-v1';

function requireRunId(runId) {
  const value = String(runId ?? '');
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid semantic run id.');
  return value;
}

function runDirectory(runsRoot, runId) {
  return join(runsRoot, requireRunId(runId));
}

function manifestPath(runsRoot, runId) {
  return join(runDirectory(runsRoot, runId), 'manifest.json');
}

function normalizedLocator(locator) {
  if (locator?.kind === 'file') return { kind: 'file', path: locator.path instanceof URL ? fileURLToPath(locator.path) : String(locator.path) };
  if (locator?.kind === 'opencode') return { kind: 'opencode', sessionId: String(locator.sessionId), cwd: String(locator.cwd) };
  throw new Error('Unsupported semantic session locator.');
}

async function loadAnalysisInput(locator, source) {
  if (locator.kind === 'file') return extractAnalysisInput(locator.path, source);
  if (locator.kind === 'opencode') return (await exportOpenCodeSession(locator)).input;
  throw new Error('Unsupported semantic session locator.');
}

async function loadDeterministicSession(locator, source) {
  if (locator.kind === 'file') return parseSessionFile(locator.path, source);
  if (locator.kind === 'opencode') return (await exportOpenCodeSession(locator)).session;
  throw new Error('Unsupported semantic session locator.');
}

function cacheKey(session, analyzer) {
  return {
    source: session.source,
    opaqueSessionId: session.id,
    contentHash: session.contentHash,
    analyzerHost: analyzer.host,
    analyzerModel: analyzer.model,
    promptVersion: PROMPT_VERSION
  };
}

function freezeDeterministicMetrics(session, input) {
  const { id: _id, project: _project, ...metrics } = session;
  return {
    ...metrics,
    id: input.opaqueId,
    project: input.projectLabel === 'unknown' ? null : input.projectLabel
  };
}

function aggregateContext(run) {
  const completed = run.sessions.filter((session) => session.status === 'complete');
  const semanticSessions = completed.map(({ id, date, facet }) => ({ id, date, facet }));
  const metrics = summarizeSessions(completed.map((session) => session.metrics), {
    semantic: { analyzer: run.analyzer, sessions: semanticSessions, sections: run.sections }
  }).insights;
  return {
    metrics,
    sessions: semanticSessions,
    sections: run.sections
  };
}

function deterministicEligibility(input) {
  if (input.userMessageCount < 2) return 'fewer_than_two_user_messages';
  if (input.durationMinutes < 1) return 'shorter_than_one_minute';
  return null;
}

function isWarmupFacet(facet) {
  const categories = Object.entries(facet?.goalCategories ?? {}).filter(([, count]) => Number(count) > 0);
  return categories.length === 1 && categories[0][0] === 'warmup_minimal';
}

function eligibilitySummary(sessions) {
  const reasons = {};
  for (const session of sessions.filter((entry) => entry.status === 'excluded')) {
    reasons[session.eligibilityReason] = (reasons[session.eligibilityReason] ?? 0) + 1;
  }
  return {
    scanned: sessions.length,
    eligible: sessions.filter((entry) => ['pending', 'complete'].includes(entry.status)).length,
    excluded: sessions.filter((entry) => entry.status === 'excluded').length,
    reasons
  };
}

function emptySections() {
  const unavailable = 'No sessions met the Claude Insights eligibility rules for this range.';
  return {
    project_areas: { areas: [] },
    interaction_style: { narrative: unavailable, keyPattern: unavailable, evidenceSessionIds: [] },
    what_works: { intro: unavailable, impressiveWorkflows: [] },
    friction_analysis: { intro: unavailable, categories: [] },
    suggestions: { instructionAdditions: [], featuresToTry: [], usagePatterns: [] },
    on_the_horizon: { intro: unavailable, opportunities: [] },
    fun_ending: { headline: 'No eligible sessions', detail: unavailable, evidenceSessionIds: [] },
    at_a_glance: { whatsWorking: unavailable, whatsHindering: unavailable, quickWins: unavailable, ambitiousWorkflows: unavailable, evidenceSessionIds: [] }
  };
}

function fillEmptySectionsIfFinished(run) {
  if (!run.sessions.some((session) => session.status === 'pending' || session.status === 'complete')) run.sections = emptySections();
}

async function writeManifest(runsRoot, manifest) {
  const directory = runDirectory(runsRoot, manifest.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = manifestPath(runsRoot, manifest.id);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { directory, manifestPath: file };
}

export async function getSemanticRun({ runsRoot, runId }) {
  const document = JSON.parse(await readFile(manifestPath(runsRoot, runId), 'utf8'));
  if (document?.schema !== RUN_SCHEMA || document.id !== runId) throw new Error('Invalid semantic run manifest.');
  return document;
}

export async function prepareSemanticRun({ runsRoot, cache, request, candidates, analyzer, diagnostics = [] }) {
  const id = randomUUID();
  const sessions = [];
  for (const candidate of candidates) {
    const locator = normalizedLocator(candidate.locator);
    const input = await loadAnalysisInput(locator, candidate.source);
    const deterministic = await loadDeterministicSession(locator, candidate.source);
    const session = {
      id: input.opaqueId,
      source: input.source,
      date: input.date,
      projectLabel: input.projectLabel,
      contentHash: input.contentHash,
      locator,
      userMessageCount: input.userMessageCount,
      durationMinutes: input.durationMinutes,
      messageCount: input.messages.length,
      metrics: freezeDeterministicMetrics(deterministic, input),
      status: 'pending',
      eligibilityReason: null,
      facet: null
    };
    const exclusion = deterministicEligibility(input);
    if (exclusion) {
      session.status = 'excluded';
      session.eligibilityReason = exclusion;
    } else {
      const cached = await cache.get(cacheKey(session, analyzer));
      if (cached?.protocolVersion === ANALYSIS_PROTOCOL_VERSION) {
        session.status = isWarmupFacet(cached) ? 'excluded' : 'complete';
        session.eligibilityReason = isWarmupFacet(cached) ? 'warmup_minimal' : null;
        session.facet = cached;
      }
    }
    sessions.push(session);
  }
  const manifest = {
    schema: RUN_SCHEMA,
    id,
    createdAt: new Date().toISOString(),
    request: { ...request, days: request.days === Infinity ? 'all' : request.days },
    analyzer: { host: analyzer.host, model: analyzer.model ?? null },
    diagnostics,
    sessions,
    sections: {},
    eligibility: eligibilitySummary(sessions),
    protocolVersion: ANALYSIS_PROTOCOL_VERSION
  };
  fillEmptySectionsIfFinished(manifest);
  const paths = await writeManifest(runsRoot, manifest);
  return { id, ...paths };
}

export async function nextSemanticTask({ runsRoot, cache: _cache, runId }) {
  const run = await getSemanticRun({ runsRoot, runId });
  while (true) {
    const session = run.sessions.find((candidate) => candidate.status === 'pending');
    if (!session) {
      const section = AGGREGATE_TASKS.find((task) => run.sections[task] === undefined);
      if (!section) return { kind: 'complete', runId };
      return {
        id: `aggregate:${section}`,
        kind: 'aggregate',
        section,
        runId,
        request: createAggregateRequest(section, aggregateContext(run)),
        submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
      };
    }
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      session.status = 'excluded';
      session.eligibilityReason = 'changed_after_prepare';
      run.eligibility = eligibilitySummary(run.sessions);
      fillEmptySectionsIfFinished(run);
      await writeManifest(runsRoot, run);
      continue;
    }
    return {
      id: `session:${session.id}`,
      kind: 'session_facet',
      runId,
      input,
      request: createSessionFacetRequest(input),
      submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
    };
  }
}

export async function ingestSemanticResult({ runsRoot, cache, runId, taskId, result }) {
  const run = await getSemanticRun({ runsRoot, runId });
  if (String(taskId).startsWith('aggregate:')) {
    const section = String(taskId).slice('aggregate:'.length);
    if (!AGGREGATE_TASKS.includes(section) || run.sections[section] !== undefined) throw new Error('Aggregate semantic task is missing or already complete.');
    const value = validateAggregateResult(section, result, aggregateContext(run));
    run.sections[section] = value;
    await writeManifest(runsRoot, run);
    return value;
  }
  if (!String(taskId).startsWith('session:')) throw new Error('Unsupported semantic task id.');
  const session = run.sessions.find((candidate) => `session:${candidate.id}` === taskId);
  if (!session || session.status !== 'pending') throw new Error('Semantic session task is missing or already complete.');
  const frozenInput = {
    source: session.source,
    date: session.date,
    opaqueId: session.id,
    messages: Array.from({ length: session.messageCount }, (_, index) => ({ index: index + 1 }))
  };
  const facet = validateSessionFacet(result, frozenInput);
  await cache.put(cacheKey(session, run.analyzer), facet);
  session.status = isWarmupFacet(facet) ? 'excluded' : 'complete';
  session.eligibilityReason = isWarmupFacet(facet) ? 'warmup_minimal' : null;
  session.facet = facet;
  run.eligibility = eligibilitySummary(run.sessions);
  fillEmptySectionsIfFinished(run);
  await writeManifest(runsRoot, run);
  return facet;
}

export async function finalizeSemanticRun({ runsRoot, runId, outputDirectory }) {
  const run = await getSemanticRun({ runsRoot, runId });
  const missing = AGGREGATE_TASKS.filter((section) => run.sections[section] === undefined);
  if (run.sessions.some((session) => session.status === 'pending') || missing.length > 0) {
    throw new Error(`Semantic run is incomplete${missing.length ? `; missing sections: ${missing.join(', ')}` : ''}.`);
  }
  const eligibleSessions = run.sessions.filter((session) => session.status === 'complete');
  const sessions = eligibleSessions.map((session) => session.metrics);
  const semantic = {
    analyzer: run.analyzer,
    sessions: eligibleSessions.map(({ id, date, facet }) => ({ id, date, facet })),
    sections: run.sections
  };
  const report = summarizeSessions(sessions, {
    days: run.request.days === 'all' ? Infinity : run.request.days,
    sourcesScanned: run.diagnostics,
    semantic,
    eligibility: run.eligibility
  });
  const files = await writeReport(report, outputDirectory);
  run.status = 'complete';
  run.completedAt = new Date().toISOString();
  run.report = { timestampedHtml: files.timestampedHtml, html: files.html, json: files.json, markdown: files.markdown };
  await writeManifest(runsRoot, run);
  return { report, files };
}

export { PROMPT_VERSION, RUN_SCHEMA };

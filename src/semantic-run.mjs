import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { ANALYSIS_PROTOCOL_VERSION, createSessionChunkRequest, createSessionFacetFromChunksRequest, createSessionFacetRequest, splitSessionMessages, validateCachedSessionFacet, validateSessionChunkResult, validateSessionFacet } from './protocol.mjs';
import { AGGREGATE_TASKS, createAggregateChunkRequest, createAggregateRequest, createAtAGlanceChunkRequest, splitAggregateSections, splitAggregateSessions, validateAggregateChunkResult, validateAggregateResult } from './aggregate-protocol.mjs';
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

function taskSubmissionPath(runsRoot, runId, taskId) {
  const section = /^aggregate:([a-z_]+)$/.exec(String(taskId))?.[1];
  return join(runDirectory(runsRoot, runId), section ? `submission-${section}.json` : 'submission.json');
}

function manifestPath(runsRoot, runId) {
  return join(runDirectory(runsRoot, runId), 'manifest.json');
}

function normalizedLocator(locator) {
  if (locator?.kind === 'file') return {
    kind: 'file',
    path: locator.path instanceof URL ? fileURLToPath(locator.path) : String(locator.path),
    maxBytes: Number(locator.maxBytes) || 16 * 1024 * 1024,
    maxRecords: Number(locator.maxRecords) || 100_000,
    maxRecordBytes: Number(locator.maxRecordBytes) || 2 * 1024 * 1024
  };
  if (locator?.kind === 'opencode') return { kind: 'opencode', sessionId: String(locator.sessionId), cwd: String(locator.cwd) };
  throw new Error('Unsupported semantic session locator.');
}

async function loadAnalysisInput(locator, source) {
  if (locator.kind === 'file') return extractAnalysisInput(locator.path, source, locator);
  if (locator.kind === 'opencode') return (await exportOpenCodeSession(locator)).input;
  throw new Error('Unsupported semantic session locator.');
}

async function loadDeterministicSession(locator, source) {
  if (locator.kind === 'file') return parseSessionFile(locator.path, source, locator);
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
  const semanticSessions = completed.map(({ id, date, source, sessionId, projectPath, projectLabel, facet }) => ({
    id,
    date,
    source,
    sessionId: sessionId ?? id,
    projectPath: projectPath ?? null,
    projectLabel: projectLabel ?? null,
    facet
  }));
  const metrics = summarizeSessions(completed.map((session) => session.metrics), {
    semantic: { analyzer: run.analyzer, sessions: semanticSessions, sections: run.sections }
  }).insights;
  return {
    metrics,
    sessions: semanticSessions,
    sections: run.sections
  };
}

function aggregateGroups(section, context) {
  return section === 'at_a_glance' ? splitAggregateSections(context.sections) : splitAggregateSessions(context.sessions);
}

function evidenceIdsIn(value, output = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => evidenceIdsIn(item, output));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'evidenceSessionIds' && Array.isArray(item)) item.forEach((id) => output.add(String(id)));
      else evidenceIdsIn(item, output);
    }
  }
  return output;
}

function evidenceContext(context, ids) {
  const allowed = new Set(ids);
  return { ...context, sessions: context.sessions.filter((session) => allowed.has(session.id)) };
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

function eligibilitySummary(sessions, preparationFailures = []) {
  const reasons = {};
  for (const session of sessions.filter((entry) => entry.status === 'excluded' || entry.status === 'failed')) {
    reasons[session.eligibilityReason] = (reasons[session.eligibilityReason] ?? 0) + 1;
  }
  for (const failure of preparationFailures) reasons[failure.reason] = (reasons[failure.reason] ?? 0) + 1;
  return {
    scanned: sessions.length + preparationFailures.length,
    eligible: sessions.filter((entry) => ['pending', 'complete'].includes(entry.status)).length,
    excluded: sessions.filter((entry) => entry.status === 'excluded' || entry.status === 'failed').length + preparationFailures.length,
    reasons
  };
}

function nextAggregateSection(run) {
  return AGGREGATE_TASKS.find((name) => run.sections[name] === undefined && run.sectionFailures?.[name] === undefined);
}

function recordSemanticFailure(run, taskId, reason) {
  run.failures ??= [];
  run.failures.push({ taskId, reason, at: new Date().toISOString() });
}

function emptySections() {
  const unavailable = 'No fully analyzable sessions were available for this range; check Read coverage for eligibility, source, and safety-limit details.';
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
  if (!(run.preparationFailures?.length) && !run.sessions.some((session) => session.status === 'pending' || session.status === 'complete' || session.status === 'failed')) run.sections = emptySections();
}

async function writeManifest(runsRoot, manifest) {
  const directory = runDirectory(runsRoot, manifest.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const file = manifestPath(runsRoot, manifest.id);
  const temporary = join(directory, `.manifest-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { directory, manifestPath: file };
}

async function exposeTask(runsRoot, run, task, _messages = null) {
  if (run.activeTask && run.activeTask.id !== task.id) throw new Error(`Semantic task ${run.activeTask.id} is still awaiting ingest or fail.`);
  if (!run.activeTask) {
    run.activeTask = {
      id: task.id,
      exposedAt: new Date().toISOString()
    };
    await writeManifest(runsRoot, run);
  }
  return task;
}

async function resumeActiveTask(runsRoot, run) {
  const id = run.activeTask.id;
  const submissionPath = join(runDirectory(runsRoot, run.id), 'submission.json');
  const chunkMatch = /^session-chunk:([a-f0-9]{24}):(\d+)$/.exec(id);
  const sessionMatch = /^session:([a-f0-9]{24})$/.exec(id);
  if (chunkMatch || sessionMatch) {
    const session = run.sessions.find((candidate) => candidate.id === (chunkMatch?.[1] ?? sessionMatch?.[1]));
    if (!session || session.status !== 'pending') throw new Error('The frozen semantic session task is no longer pending.');
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      return { kind: 'source_changed', id, runId: run.id, submissionPath, message: 'The source changed after this task was exposed. Mark it failed with reason source_changed, then continue.' };
    }
    if (chunkMatch) {
      const chunks = splitSessionMessages(input.messages);
      const index = Number(chunkMatch[2]);
      return {
        id, kind: 'session_chunk', runId: run.id,
        input: { source: input.source, opaqueId: input.opaqueId, date: input.date, messages: chunks[index] },
        request: createSessionChunkRequest(input, chunks[index], index, chunks.length, session.chunkResults.at(-1) ?? null),
        submissionPath
      };
    }
    if (session.analysisMode === 'chunked') {
      return { id, kind: 'session_facet', runId: run.id, request: createSessionFacetFromChunksRequest(session, session.chunkResults.length ? [session.chunkResults.at(-1)] : []), submissionPath };
    }
    return { id, kind: 'session_facet', runId: run.id, input, request: createSessionFacetRequest(input), submissionPath };
  }
  const context = aggregateContext(run);
  const aggregateChunk = /^aggregate-chunk:([a-z_]+):(\d+)$/.exec(id);
  if (aggregateChunk) {
    const section = aggregateChunk[1];
    const index = Number(aggregateChunk[2]);
    const groups = aggregateGroups(section, context);
    const carry = run.aggregateChunks?.[section]?.at(-1) ?? null;
    const request = section === 'at_a_glance'
      ? createAtAGlanceChunkRequest(context, groups[index], index, groups.length, carry)
      : createAggregateChunkRequest(section, context, groups[index], index, groups.length, carry);
    return { id, kind: 'aggregate_chunk', section, runId: run.id, request, submissionPath };
  }
  const section = /^aggregate:([a-z_]+)$/.exec(id)?.[1];
  if (!section) throw new Error('Unsupported frozen semantic task.');
  const direct = createAggregateRequest(section, context);
  const request = direct.prompt.length > 30_000
    ? createAggregateRequest(section, { ...context, chunkSummaries: [run.aggregateChunks?.[section]?.at(-1)] })
    : direct;
  return { id, kind: 'aggregate', section, runId: run.id, request, submissionPath };
}

export async function getSemanticRun({ runsRoot, runId }) {
  const document = JSON.parse(await readFile(manifestPath(runsRoot, runId), 'utf8'));
  if (document?.schema !== RUN_SCHEMA || document.id !== runId) throw new Error('Invalid semantic run manifest.');
  return document;
}

export async function semanticSubmissionForTask({ runsRoot, runId, taskId }) {
  const run = await getSemanticRun({ runsRoot, runId });
  const id = String(taskId ?? '');
  if (run.aggregateBatch?.ids?.includes(id)) {
    const section = /^aggregate:([a-z_]+)$/.exec(id)?.[1];
    if (!section || run.sections[section] !== undefined || run.sectionFailures?.[section] !== undefined) throw new Error('The batched aggregate task is missing or already complete.');
    return taskSubmissionPath(runsRoot, runId, id);
  }
  if (id.startsWith('session-chunk:')) {
    const pending = run.sessions.find((session) => session.status === 'pending');
    const expectedIndex = pending?.chunkResults?.length ?? 0;
    if (!pending || pending.analysisMode !== 'chunked' || `session-chunk:${pending.id}:${expectedIndex}` !== id || expectedIndex >= pending.chunkCount) {
      throw new Error('The submitted chunk is not the next pending semantic task.');
    }
  } else if (id.startsWith('session:')) {
    const pending = run.sessions.find((session) => session.status === 'pending');
    if (!pending || `session:${pending.id}` !== id) throw new Error('The submitted session is not the next pending semantic task.');
    if (pending.analysisMode === 'chunked' && pending.chunkResults.length !== pending.chunkCount) {
      throw new Error('All session chunks must complete before the final session facet.');
    }
  } else if (id.startsWith('aggregate-chunk:')) {
    if (run.sessions.some((session) => session.status === 'pending')) throw new Error('Session facets must complete before aggregate tasks.');
    const section = nextAggregateSection(run);
    const context = aggregateContext(run);
    const groups = section ? aggregateGroups(section, context) : [];
    const expectedIndex = section ? (run.aggregateChunks?.[section]?.length ?? 0) : -1;
    if (!section || `aggregate-chunk:${section}:${expectedIndex}` !== id || expectedIndex >= groups.length) {
      throw new Error('The submitted aggregate chunk is not the next pending semantic task.');
    }
  } else if (id.startsWith('aggregate:')) {
    if (run.sessions.some((session) => session.status === 'pending')) throw new Error('Session facets must complete before aggregate tasks.');
    const section = nextAggregateSection(run);
    if (!section || `aggregate:${section}` !== id) throw new Error('The submitted section is not the next pending aggregate task.');
    const context = aggregateContext(run);
    const direct = createAggregateRequest(section, context);
    if (direct.prompt.length > 30_000) {
      const groups = aggregateGroups(section, context);
      if ((run.aggregateChunks?.[section]?.length ?? 0) < groups.length) throw new Error('Aggregate evidence chunks must complete before the final section task.');
    }
  } else {
    throw new Error('Unsupported semantic task id.');
  }
  return taskSubmissionPath(runsRoot, runId, id);
}

export async function prepareSemanticRun({ runsRoot, cache, request, candidates, analyzer, diagnostics = [] }) {
  const id = randomUUID();
  const sessions = [];
  const preparationFailures = [];
  const runDiagnostics = structuredClone(diagnostics);
  const normalizedModel = typeof analyzer.model === 'string' ? analyzer.model.trim() : '';
  const cacheEnabled = normalizedModel !== '' && normalizedModel.toLowerCase() !== 'unknown';
  const cacheStats = { enabled: cacheEnabled, hits: 0, misses: 0, invalid: 0, stale: 0, bypassedUnknownModel: 0, writeFailures: 0 };
  for (const candidate of candidates) {
    const locator = normalizedLocator(candidate.locator);
    let input;
    let deterministic;
    try {
      input = await loadAnalysisInput(locator, candidate.source);
      deterministic = await loadDeterministicSession(locator, candidate.source);
    } catch (error) {
      const reason = /changed while|changed during|content changed/i.test(String(error?.message)) ? 'changed_during_read' : 'transcript_extraction_failed';
      preparationFailures.push({ source: candidate.source, reason });
      const diagnostic = runDiagnostics.find((entry) => entry.source === candidate.source);
      if (diagnostic) {
        diagnostic.coverage = 'partial';
        diagnostic.semanticFailures = (diagnostic.semanticFailures ?? 0) + 1;
        diagnostic.warning = [diagnostic.warning, `${reason.replaceAll('_', ' ')} during semantic preparation`].filter(Boolean).join('; ');
      }
      continue;
    }
    const session = {
      id: input.opaqueId,
      source: input.source,
      date: input.date,
      sessionId: input.sessionId,
      projectPath: input.projectPath ?? null,
      projectLabel: input.projectLabel,
      contentHash: input.contentHash,
      locator,
      userMessageCount: input.userMessageCount,
      durationMinutes: input.durationMinutes,
      messageCount: input.messages.length,
      analysisMode: createSessionFacetRequest(input).prompt.length > 30_000 ? 'chunked' : 'direct',
      chunkMessageIndexes: [],
      chunkCount: 0,
      chunkResults: [],
      metrics: freezeDeterministicMetrics(deterministic, input),
      status: 'pending',
      eligibilityReason: null,
      facet: null
    };
    if (session.analysisMode === 'chunked') {
      const chunks = splitSessionMessages(input.messages);
      session.chunkMessageIndexes = chunks.map((chunk) => chunk.map((message) => message.index));
      session.chunkCount = chunks.length;
    }
    const exclusion = deterministicEligibility(input);
    if (exclusion) {
      session.status = 'excluded';
      session.eligibilityReason = exclusion;
    } else if (!cacheEnabled) {
      cacheStats.bypassedUnknownModel += 1;
    } else {
      const key = cacheKey(session, analyzer);
      const lookup = await cache.lookup(key);
      if (lookup.status === 'miss') cacheStats.misses += 1;
      else if (lookup.status === 'stale') cacheStats.stale += lookup.removed ?? 1;
      else if (lookup.status === 'invalid') cacheStats.invalid += 1;
      else {
        try {
          const cached = validateCachedSessionFacet(lookup.facet, input);
          cacheStats.hits += 1;
          session.status = isWarmupFacet(cached) ? 'excluded' : 'complete';
          session.eligibilityReason = isWarmupFacet(cached) ? 'warmup_minimal' : null;
          session.facet = cached;
        } catch {
          cacheStats.invalid += 1;
          await cache.remove(key);
        }
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
    diagnostics: runDiagnostics,
    sessions,
    sections: {},
    sectionFailures: {},
    aggregateChunks: {},
    preparationFailures,
    failures: preparationFailures.map((failure) => ({ taskId: null, reason: failure.reason, source: failure.source, at: new Date().toISOString() })),
    eligibility: eligibilitySummary(sessions, preparationFailures),
    cache: cacheStats,
    protocolVersion: ANALYSIS_PROTOCOL_VERSION
  };
  if (preparationFailures.length && !sessions.some((session) => session.status === 'pending' || session.status === 'complete')) {
    for (const section of AGGREGATE_TASKS) manifest.sectionFailures[section] = { reason: 'no_semantic_evidence' };
  }
  fillEmptySectionsIfFinished(manifest);
  const paths = await writeManifest(runsRoot, manifest);
  return { id, ...paths };
}

export async function nextSemanticTask({ runsRoot, cache: _cache, runId }) {
  const run = await getSemanticRun({ runsRoot, runId });
  if (run.aggregateBatch?.ids?.length) {
    const context = aggregateContext(run);
    return {
      kind: 'aggregate_batch',
      runId,
      tasks: run.aggregateBatch.ids.map((id) => {
        const section = id.slice('aggregate:'.length);
        return { id, kind: 'aggregate', section, runId, request: createAggregateRequest(section, context), submissionPath: taskSubmissionPath(runsRoot, runId, id) };
      })
    };
  }
  if (run.activeTask) return resumeActiveTask(runsRoot, run);
  while (true) {
    const session = run.sessions.find((candidate) => candidate.status === 'pending');
    if (!session) {
      const section = nextAggregateSection(run);
      if (!section) return { kind: 'complete', runId };
      const context = aggregateContext(run);
      const parallelSections = AGGREGATE_TASKS.slice(0, -1).filter((name) => run.sections[name] === undefined && run.sectionFailures?.[name] === undefined);
      if (section === AGGREGATE_TASKS[0] && parallelSections.length === AGGREGATE_TASKS.length - 1) {
        const tasks = parallelSections.map((name) => ({
          id: `aggregate:${name}`,
          kind: 'aggregate',
          section: name,
          runId,
          request: createAggregateRequest(name, context),
          submissionPath: taskSubmissionPath(runsRoot, runId, `aggregate:${name}`)
        }));
        if (tasks.every((task) => task.request.prompt.length <= 30_000)) {
          run.aggregateBatch = { ids: tasks.map((task) => task.id), exposedAt: new Date().toISOString() };
          await writeManifest(runsRoot, run);
          return { kind: 'aggregate_batch', runId, tasks };
        }
      }
      let request = createAggregateRequest(section, context);
      if (request.prompt.length > 30_000) {
        const groups = aggregateGroups(section, context);
        run.aggregateChunks ??= {};
        run.aggregateChunks[section] ??= [];
        const chunkIndex = run.aggregateChunks[section].length;
        if (chunkIndex < groups.length) {
          const carry = run.aggregateChunks[section].at(-1) ?? null;
          const chunkRequest = section === 'at_a_glance'
            ? createAtAGlanceChunkRequest(context, groups[chunkIndex], chunkIndex, groups.length, carry)
            : createAggregateChunkRequest(section, context, groups[chunkIndex], chunkIndex, groups.length, carry);
          if (chunkRequest.prompt.length > 30_000) throw new Error(`Aggregate safety limit exceeded for ${section} chunk ${chunkIndex + 1}.`);
          return exposeTask(runsRoot, run, {
            id: `aggregate-chunk:${section}:${chunkIndex}`,
            kind: 'aggregate_chunk',
            section,
            runId,
            request: chunkRequest,
            submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
          });
        }
        request = createAggregateRequest(section, { ...context, chunkSummaries: [run.aggregateChunks[section].at(-1)] });
        if (request.prompt.length > 30_000) throw new Error(`Aggregate safety limit exceeded for final ${section} synthesis.`);
      }
      return exposeTask(runsRoot, run, {
        id: `aggregate:${section}`,
        kind: 'aggregate',
        section,
        runId,
        request,
        submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
      });
    }
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      session.status = 'excluded';
      session.eligibilityReason = 'changed_after_prepare';
      run.eligibility = eligibilitySummary(run.sessions, run.preparationFailures);
      fillEmptySectionsIfFinished(run);
      await writeManifest(runsRoot, run);
      continue;
    }
    if (session.analysisMode === 'chunked') {
      const chunks = splitSessionMessages(input.messages);
      const chunkIndex = session.chunkResults.length;
      if (chunkIndex < session.chunkCount) {
        return exposeTask(runsRoot, run, {
          id: `session-chunk:${session.id}:${chunkIndex}`,
          kind: 'session_chunk',
          runId,
          input: { source: input.source, opaqueId: input.opaqueId, date: input.date, messages: chunks[chunkIndex] },
            request: createSessionChunkRequest(input, chunks[chunkIndex], chunkIndex, chunks.length, session.chunkResults.at(-1) ?? null),
          submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
        }, chunks[chunkIndex]);
      }
      return exposeTask(runsRoot, run, {
        id: `session:${session.id}`,
        kind: 'session_facet',
        runId,
        request: createSessionFacetFromChunksRequest(session, session.chunkResults.length ? [session.chunkResults.at(-1)] : []),
        submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
      });
    }
    return exposeTask(runsRoot, run, {
      id: `session:${session.id}`,
      kind: 'session_facet',
      runId,
      input,
      request: createSessionFacetRequest(input),
      submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
    }, input.messages);
  }
}

export async function ingestSemanticResult({ runsRoot, cache, runId, taskId, result }) {
  const run = await getSemanticRun({ runsRoot, runId });
  const batched = run.aggregateBatch?.ids?.includes(String(taskId));
  if (!batched && run.activeTask?.id !== String(taskId)) throw new Error('Semantic result does not match the task most recently exposed by semantic next.');
  if (String(taskId).startsWith('aggregate-chunk:')) {
    const match = /^aggregate-chunk:([a-z_]+):(\d+)$/.exec(String(taskId));
    const section = match?.[1];
    const index = match ? Number(match[2]) : -1;
    const expectedSection = nextAggregateSection(run);
    const context = aggregateContext(run);
    const groups = section ? aggregateGroups(section, context) : [];
    if (!section || section !== expectedSection || index !== (run.aggregateChunks?.[section]?.length ?? 0) || index >= groups.length) {
      throw new Error('Aggregate chunk task is missing or already complete.');
    }
    run.aggregateChunks ??= {};
    run.aggregateChunks[section] ??= [];
    const priorIds = run.aggregateChunks?.[section]?.at(-1)?.evidenceSessionIds ?? [];
    const currentIds = section === 'at_a_glance'
      ? [...evidenceIdsIn(Object.fromEntries(groups[index].map((fragment) => [fragment.section, context.sections[fragment.section]])))]
      : groups[index].map((session) => session.id);
    const chunk = validateAggregateChunkResult(result, evidenceContext(context, [...priorIds, ...currentIds]));
    run.aggregateChunks[section].push(chunk);
    run.activeTask = null;
    await writeManifest(runsRoot, run);
    return chunk;
  }
  if (String(taskId).startsWith('session-chunk:')) {
    const match = /^session-chunk:([a-f0-9]{24}):(\d+)$/.exec(String(taskId));
    const session = match && run.sessions.find((candidate) => candidate.id === match[1]);
    const index = match ? Number(match[2]) : -1;
    if (!session || session.status !== 'pending' || session.analysisMode !== 'chunked' || index !== session.chunkResults.length || index >= session.chunkCount) {
      throw new Error('Semantic chunk task is missing or already complete.');
    }
    const indexes = session.chunkMessageIndexes[index];
    const priorIndexes = (session.chunkResults.at(-1)?.evidence ?? []).flatMap((item) => item.messageIndexes ?? []);
    const allowedIndexes = [...new Set([...indexes, ...priorIndexes])];
    const chunkInput = {
      source: session.source,
      date: session.date,
      opaqueId: session.id,
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      projectLabel: session.projectLabel,
      messages: allowedIndexes.map((messageIndex) => ({ index: messageIndex }))
    };
    const chunk = validateSessionChunkResult(result, chunkInput);
    session.chunkResults.push(chunk);
    run.activeTask = null;
    await writeManifest(runsRoot, run);
    return chunk;
  }
  if (String(taskId).startsWith('aggregate:')) {
    const section = String(taskId).slice('aggregate:'.length);
    const expectedSection = nextAggregateSection(run);
    if (!AGGREGATE_TASKS.includes(section) || (!batched && section !== expectedSection) || run.sessions.some((session) => session.status === 'pending') || run.sections[section] !== undefined) throw new Error('Aggregate semantic task is missing, out of order, or already complete.');
    const context = aggregateContext(run);
    const direct = createAggregateRequest(section, context);
    let validationContext = context;
    if (direct.prompt.length > 30_000) {
      const groups = aggregateGroups(section, context);
      if ((run.aggregateChunks?.[section]?.length ?? 0) < groups.length) throw new Error('Aggregate evidence chunks are incomplete.');
      validationContext = evidenceContext(context, run.aggregateChunks[section].at(-1)?.evidenceSessionIds ?? []);
    }
    const value = validateAggregateResult(section, result, validationContext);
    run.sections[section] = value;
    if (batched) {
      run.aggregateBatch.ids = run.aggregateBatch.ids.filter((id) => id !== String(taskId));
      if (run.aggregateBatch.ids.length === 0) run.aggregateBatch = null;
    } else run.activeTask = null;
    await writeManifest(runsRoot, run);
    return value;
  }
  if (!String(taskId).startsWith('session:')) throw new Error('Unsupported semantic task id.');
  const session = run.sessions.find((candidate) => `session:${candidate.id}` === taskId);
  if (!session || session.status !== 'pending') throw new Error('Semantic session task is missing or already complete.');
  if (session.analysisMode === 'chunked' && session.chunkResults.length !== session.chunkCount) {
    throw new Error('All session chunks must complete before the final session facet.');
  }
  const supportedIndexes = session.analysisMode === 'chunked'
    ? [...new Set((session.chunkResults.at(-1)?.evidence ?? []).flatMap((item) => item.messageIndexes ?? []))]
    : Array.from({ length: session.messageCount }, (_, index) => index + 1);
  const frozenInput = {
    source: session.source,
    date: session.date,
    opaqueId: session.id,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    projectLabel: session.projectLabel,
    messages: supportedIndexes.map((index) => ({ index }))
  };
  const facet = validateSessionFacet(result, frozenInput);
  if (run.cache?.enabled) {
    try {
      await cache.put(cacheKey(session, run.analyzer), facet);
    } catch {
      run.cache.writeFailures += 1;
    }
  }
  session.status = isWarmupFacet(facet) ? 'excluded' : 'complete';
  session.eligibilityReason = isWarmupFacet(facet) ? 'warmup_minimal' : null;
  session.facet = facet;
  run.activeTask = null;
  run.eligibility = eligibilitySummary(run.sessions, run.preparationFailures);
  fillEmptySectionsIfFinished(run);
  await writeManifest(runsRoot, run);
  return facet;
}

export async function failSemanticTask({ runsRoot, runId, taskId, reason = 'analyzer_failure' }) {
  const allowed = new Set(['analyzer_failure', 'invalid_analyzer_response', 'safety_limit', 'source_changed']);
  if (!allowed.has(reason)) throw new Error(`Unsupported semantic failure reason: ${reason}.`);
  await semanticSubmissionForTask({ runsRoot, runId, taskId });
  const run = await getSemanticRun({ runsRoot, runId });
  const id = String(taskId);
  if (id.startsWith('session:') || id.startsWith('session-chunk:')) {
    const sessionId = /^session:([a-f0-9]{24})$/.exec(id)?.[1] ?? /^session-chunk:([a-f0-9]{24}):\d+$/.exec(id)?.[1];
    const session = run.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.status !== 'pending') throw new Error('Semantic session task is missing or already complete.');
    session.status = 'failed';
    session.eligibilityReason = reason;
    session.failure = { taskId: id, reason };
    run.eligibility = eligibilitySummary(run.sessions, run.preparationFailures);
    if (!run.sessions.some((candidate) => candidate.status === 'pending' || candidate.status === 'complete')) {
      run.sectionFailures ??= {};
      for (const section of AGGREGATE_TASKS) run.sectionFailures[section] ??= { reason: 'no_semantic_evidence' };
    }
  } else {
    const section = /^aggregate(?:-chunk)?:([a-z_]+)/.exec(id)?.[1];
    if (!section || !AGGREGATE_TASKS.includes(section)) throw new Error('Unsupported semantic task id.');
    run.sectionFailures ??= {};
    run.sectionFailures[section] = { reason, taskId: id };
    if (run.aggregateBatch?.ids?.includes(id)) {
      run.aggregateBatch.ids = run.aggregateBatch.ids.filter((task) => task !== id);
      if (run.aggregateBatch.ids.length === 0) run.aggregateBatch = null;
    }
  }
  recordSemanticFailure(run, id, reason);
  if (run.activeTask?.id === id) run.activeTask = null;
  await writeManifest(runsRoot, run);
  return { taskId: id, reason, status: 'failed' };
}

export async function finalizeSemanticRun({ runsRoot, runId, outputDirectory }) {
  const run = await getSemanticRun({ runsRoot, runId });
  const missing = AGGREGATE_TASKS.filter((section) => run.sections[section] === undefined);
  const unresolved = missing.filter((section) => run.sectionFailures?.[section] === undefined);
  if (run.sessions.some((session) => session.status === 'pending') || unresolved.length > 0) {
    throw new Error(`Semantic run is incomplete${unresolved.length ? `; missing sections: ${unresolved.join(', ')}` : ''}.`);
  }
  const eligibleSessions = run.sessions.filter((session) => session.status === 'complete');
  const sessions = eligibleSessions.map((session) => session.metrics);
  const semantic = {
    analyzer: run.analyzer,
    cache: run.cache,
    failures: run.failures,
    sectionFailures: run.sectionFailures,
    sessions: eligibleSessions.map(({ id, date, source, sessionId, projectPath, projectLabel, facet }) => ({
      id,
      date,
      source,
      sessionId: sessionId ?? id,
      projectPath: projectPath ?? null,
      projectLabel: projectLabel ?? null,
      facet
    })),
    sections: run.sections
  };
  const report = summarizeSessions(sessions, {
    days: run.request.days === 'all' ? Infinity : run.request.days,
    requestedRange: run.request.start && run.request.end ? { start: run.request.start, end: run.request.end } : null,
    sourcesScanned: run.diagnostics,
    semantic,
    eligibility: run.eligibility
  });
  const files = await writeReport(report, outputDirectory);
  run.status = run.failures?.length ? 'partial' : 'complete';
  run.completedAt = new Date().toISOString();
  run.report = { timestampedHtml: files.timestampedHtml, html: files.html, json: files.json, markdown: files.markdown };
  await writeManifest(runsRoot, run);
  return { report, files };
}

export { PROMPT_VERSION, RUN_SCHEMA };

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { ANALYSIS_PROTOCOL_VERSION, createSessionChunkRequest, createSessionFacetFromChunksRequest, createSessionFacetRequest, projectMessages, splitSessionMessages, validateSessionChunkResult, validateSessionFacet } from './protocol.mjs';
import { AGGREGATE_TASKS, createAggregateChunkRequest, createAggregateRequest, createAtAGlanceChunkRequest, splitAggregateSections, splitAggregateSessions, legacySplitAggregateSessions, legacySplitAggregateSections, validateAggregateChunkResult, validateAggregateResult } from './aggregate-protocol.mjs';
import {
  AUDIT_PROTOCOL_VERSION,
  auditAssessmentContext,
  auditCarryAssessmentContext,
  auditAggregateEvidenceContext,
  auditAggregateUnits,
  auditAggregatePayloadSize,
  materializeAuditAggregateUnits,
  createAuditAggregateChunkRequest,
  createAuditAggregateRequest,
  createSessionAuditChunkRequest,
  createSessionAuditFromChunksRequest,
  createSessionAuditRequest,
  splitAuditSessions,
  splitAuditMessages,
  validateAuditAggregateChunkResult,
  validateAuditAggregateResult,
  validateSessionAuditChunkResult,
  validateSessionAuditResult
} from './audit-protocol.mjs';
import { extractAnalysisInput } from './transcript.mjs';
import { parseSessionFile } from './parse.mjs';
import { summarizeSessions } from './analyze.mjs';
import { writeReport } from './report.mjs';
import { exportOpenCodeSession } from './opencode.mjs';
import { normalizeLocale } from './i18n.mjs';
import { sessionIsWithinWindow, sessionMatchesProject } from './adapters.mjs';
import { DirectoryLockCleanupError, withRunLock } from './run-lock.mjs';

const RUN_SCHEMA = 'agent-insight/semantic-run-v5';
const PROMPT_VERSION = 'session-facet-v5';

function runLocale(runOrRequest) {
  return normalizeLocale(runOrRequest?.request?.locale ?? runOrRequest?.locale);
}

function withLocale(value, locale) {
  return { ...value, locale };
}

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
    analyzedSessionCount: new Set(semanticSessions.map((session) => session.id)).size,
    sections: run.sections,
    locale: runLocale(run),
    legacyAggregatePlanning: run.aggregatePlanningVersion !== 2
  };
}

function aggregateGroups(section, context) {
  if (context.legacyAggregatePlanning) return section === 'at_a_glance' ? legacySplitAggregateSections(context.sections) : legacySplitAggregateSessions(context.sessions);
  return section === 'at_a_glance' ? splitAggregateSections(context.sections) : splitAggregateSessions(context.sessions, 12_000, context.metrics);
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

function auditEligibleSessions(run) {
  return run.sessions.filter((session) => session.status === 'complete');
}

function nextAuditSession(run) {
  if (run.extensionFailures?.userAudit) return null;
  const audits = run.extensions?.userAudit?.sessions ?? {};
  return auditEligibleSessions(run).find((session) => audits[session.id] === undefined);
}

function auditAggregatePending(run) {
  if (run.extensionFailures?.userAudit) return false;
  if (!auditEligibleSessions(run).length) return false;
  if (nextAuditSession(run)) return false;
  return run.extensions?.userAudit?.aggregate === undefined;
}

function ensureUserAuditExtension(run) {
  run.extensions ??= {};
  run.extensions.userAudit ??= {
    sessions: {},
    aggregate: undefined,
    protocolVersion: AUDIT_PROTOCOL_VERSION,
    sessionChunks: {},
    aggregateChunks: []
  };
  run.extensions.userAudit.sessionChunks ??= {};
  run.extensions.userAudit.aggregateChunks ??= [];
  return run.extensions.userAudit;
}

function auditAggregateBatch(run, context, index, allocate = false) {
  const extension = ensureUserAuditExtension(run);
  // Pre-planning checkpoints retain the exact old grouping, including frozen
  // active tasks. New runs persist the plan before exposing their first batch.
  if (!extension.aggregatePlan && (extension.aggregateChunks.length || run.activeTask?.id.startsWith('audit:aggregate'))) {
    const groups = splitAuditSessions(context.sessions, 12_000, true);
    return groups[index] ? { sessions: groups[index], total: groups.length } : null;
  }
  if (!extension.aggregatePlan) {
    if (!allocate) return null;
    extension.aggregatePlan = { units: auditAggregateUnits(context.sessions), batches: [] };
  }
  const plan = extension.aggregatePlan;
  const carry = extension.aggregateChunks.at(-1) ?? null;
  if (plan.batches[index]) {
    const batch = plan.batches[index];
    return { sessions: materializeAuditAggregateUnits(context, plan.units.slice(batch.start, batch.end)), total: batch.total };
  }
  if (!allocate || index !== plan.batches.length) return null;
  const start = index ? plan.batches[index - 1].end : 0;
  if (start >= plan.units.length) return null;
  let end = start;
  for (let candidate = start + 1; candidate <= plan.units.length; candidate += 1) {
    const sessions = materializeAuditAggregateUnits(context, plan.units.slice(start, candidate));
    const request = createAuditAggregateChunkRequest(context, sessions, index, null, carry);
    if (request.prompt.length > 30_000) break;
    if (end > start && auditAggregatePayloadSize(sessions) > 12_000) break;
    end = candidate;
  }
  if (end === start) throw new Error('Audit aggregate safety limit exceeded: an atomic item plus retained carry cannot fit the prompt.');
  const batch = { start, end, total: end === plan.units.length ? index + 1 : null };
  plan.batches.push(batch);
  return { sessions: materializeAuditAggregateUnits(context, plan.units.slice(start, end)), total: batch.total };
}

function auditAggregateBatchesComplete(run, context) {
  const extension = ensureUserAuditExtension(run);
  if (!extension.aggregatePlan) return extension.aggregateChunks.length >= splitAuditSessions(context.sessions, 12_000, true).length;
  const plan = extension.aggregatePlan;
  return extension.aggregateChunks.length === plan.batches.length && (plan.batches.at(-1)?.end ?? 0) === plan.units.length;
}

function auditSessionChunkState(run, sessionId) {
  return ensureUserAuditExtension(run).sessionChunks[sessionId] ?? null;
}

// Persist only source offsets so adaptive chunk boundaries survive next/resume/
// ingest without retaining another copy of the full transcript.
function chunkRanges(chunks, offsets = new Map()) {
  return chunks.map((chunk) => chunk.map((message) => {
    const start = offsets.get(message.index) ?? 0;
    const end = start + message.text.length;
    offsets.set(message.index, end);
    return { index: message.index, start, end };
  }));
}

function sessionChunkMessages(messages, state, index, audit = false) {
  const originals = new Map((audit ? projectMessages(messages) : messages).map((message) => [message.index, message]));
  if (!state.chunkRanges) {
    const chunks = audit ? splitAuditMessages(messages) : splitSessionMessages(messages);
    state.chunkRanges = chunkRanges(chunks);
  }
  return state.chunkRanges[index].map((range) => {
    const original = originals.get(range.index);
    const text = original.text.slice(range.start, range.end);
    return { ...original, text };
  });
}

function boundedSessionChunk(input, state, index, makeRequest, audit = false) {
  let messages = sessionChunkMessages(input.messages, state, index, audit);
  let request = makeRequest(messages, state.chunkCount);
  if (request.prompt.length > 30_000) {
    // Measure the entire scaffold plus validated carry. The small reserve covers
    // changed chunk-count digits after subdivision, without dropping evidence.
    const available = 30_000 - makeRequest([], state.chunkCount).prompt.length + 2 - 64;
    if (available <= 2) throw new Error('Session chunk safety limit exceeded: prior synthesis and metadata leave no room for transcript text.');
    let parts;
    try {
      parts = splitSessionMessages(messages, available);
    } catch (error) {
      throw new Error(`Session chunk safety limit exceeded: ${error.message}`);
    }
    const offsets = new Map();
    for (const range of state.chunkRanges[index]) {
      if (!offsets.has(range.index)) offsets.set(range.index, range.start);
    }
    state.chunkRanges.splice(index, 1, ...chunkRanges(parts, offsets));
    state.chunkCount = state.chunkRanges.length;
    state.chunkMessageIndexes = state.chunkRanges.map((ranges) => ranges.map((range) => range.index));
    messages = sessionChunkMessages(input.messages, state, index, audit);
    request = makeRequest(messages, state.chunkCount);
  }
  if (request.prompt.length > 30_000) throw new Error('Session chunk safety limit exceeded after budgeting transcript and prior synthesis.');
  return { messages, request };
}

// Carry only quotations already validated in the preceding chunk. Reloading a
// whole message by index would expose unseen text when a long message is split.
function auditCarryMessages(input, carry = {}) {
  const original = new Map(input.messages.filter((message) => message.role === 'user').map((message) => [message.index, message.text]));
  return [...(carry.findings ?? []), ...(carry.strengths ?? []), ...(carry.workflowEvidence ?? [])].flatMap((finding) => (finding.locators ?? []).flatMap((locator) =>
    (locator.messageIndexes ?? []).flatMap((index) => {
      const text = original.get(index);
      if (typeof text !== 'string') return [];
      const quotations = (finding.quotations ?? []).filter((quotation) => text.includes(quotation));
      return (quotations.length ? quotations : ['']).map((quotation) => ({ index, role: 'user', text: quotation }));
    })
  ));
}

function initAuditSessionChunks(run, sessionId, messages) {
  const extension = ensureUserAuditExtension(run);
  const chunks = splitAuditMessages(messages);
  extension.sessionChunks[sessionId] = {
    chunkRanges: chunkRanges(chunks),
    chunkMessageIndexes: chunks.map((chunk) => chunk.map((message) => message.index)),
    chunkCount: chunks.length,
    chunkResults: []
  };
  return extension.sessionChunks[sessionId];
}

function auditAggregateContext(run) {
  return {
    locale: runLocale(run),
    sessions: auditEligibleSessions(run).map((session) => {
      const audit = run.extensions?.userAudit?.sessions?.[session.id];
      return {
        id: session.id,
        sessionId: session.sessionId ?? session.id,
        source: session.source,
        date: session.date,
        projectPath: session.projectPath ?? null,
        projectLabel: session.projectLabel ?? null,
        facet: session.facet,
        userMessages: audit?.userMessages ?? [],
        userMessageIndexes: audit?.userMessageIndexes ?? [],
        findings: audit?.findings ?? [],
        strengths: audit?.strengths ?? [],
        workflowEvidence: audit?.workflowEvidence ?? [],
        assessmentContext: auditAssessmentContext(audit?.assessmentContext)
      };
    })
  };
}

function recordSemanticFailure(run, taskId, reason) {
  run.failures ??= [];
  run.failures.push({ taskId, reason, at: new Date().toISOString() });
}

function recordExtensionFailure(run, extension, taskId, reason) {
  run.extensionFailures ??= {};
  run.extensionFailures[extension] = { reason, taskId, at: new Date().toISOString() };
  recordSemanticFailure(run, taskId, reason);
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

async function cleanTransientRunFiles(runsRoot, runId) {
  const directory = runDirectory(runsRoot, runId);
  let names;
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(names.map(async (name) => {
    const transient = name === 'submission.json'
      || /^submission-.+\.json$/.test(name)
      || name.endsWith('.tmp')
      || /projection/i.test(name);
    if (!transient) return;
    await unlink(join(directory, name)).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }));
}

async function exposeTask(runsRoot, run, task, messages = null) {
  if (task.request?.prompt.length > 30_000) throw new Error('Semantic prompt safety limit exceeded (30,000 characters).');
  if (run.activeTask && run.activeTask.id !== task.id) throw new Error(`Semantic task ${run.activeTask.id} is still awaiting ingest or fail.`);
  if (!run.activeTask) {
    run.activeTask = {
      id: task.id,
      exposedAt: new Date().toISOString(),
      ...(['session_chunk', 'session_facet'].includes(task.kind) && messages ? { messages } : {})
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
      const index = Number(chunkMatch[2]);
      const messages = sessionChunkMessages(input.messages, session, index);
      return {
        id, kind: 'session_chunk', runId: run.id,
        input: { source: input.source, opaqueId: input.opaqueId, date: input.date, messages },
        request: createSessionChunkRequest(withLocale(input, runLocale(run)), messages, index, session.chunkCount, session.chunkResults.at(-1) ?? null),
        submissionPath
      };
    }
    if (session.analysisMode === 'chunked') {
      return { id, kind: 'session_facet', runId: run.id, request: createSessionFacetFromChunksRequest(withLocale(session, runLocale(run)), session.chunkResults.length ? [session.chunkResults.at(-1)] : []), submissionPath };
    }
    return { id, kind: 'session_facet', runId: run.id, input, request: createSessionFacetRequest(withLocale(input, runLocale(run))), submissionPath };
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
  if (section) {
    const direct = createAggregateRequest(section, context);
    const request = direct.prompt.length > 30_000
      ? createAggregateRequest(section, { ...context, chunkSummaries: [run.aggregateChunks?.[section]?.at(-1)] })
      : direct;
    return { id, kind: 'aggregate', section, runId: run.id, request, submissionPath };
  }
  const auditSessionChunk = /^audit:session-chunk:([a-f0-9]{24}):(\d+)$/.exec(id);
  if (auditSessionChunk) {
    const session = run.sessions.find((candidate) => candidate.id === auditSessionChunk[1]);
    if (!session || session.status !== 'complete') throw new Error('The frozen audit session chunk task is no longer available.');
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      return { kind: 'source_changed', id, runId: run.id, submissionPath, message: 'The source changed after this task was exposed. Mark it failed with reason source_changed, then continue.' };
    }
    const index = Number(auditSessionChunk[2]);
    const state = auditSessionChunkState(run, session.id);
    const messages = sessionChunkMessages(input.messages, state, index, true);
    return {
      id,
      kind: 'session_audit_chunk',
      runId: run.id,
      input: { source: input.source, opaqueId: input.opaqueId, date: input.date, messages },
      request: createSessionAuditChunkRequest(withLocale(input, runLocale(run)), messages, index, state.chunkCount, state?.chunkResults?.at(-1) ?? null),
      submissionPath
    };
  }
  const auditSession = /^audit:session:([a-f0-9]{24})$/.exec(id)?.[1];
  if (auditSession) {
    const session = run.sessions.find((candidate) => candidate.id === auditSession);
    if (!session || session.status !== 'complete') throw new Error('The frozen audit session task is no longer available.');
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      return { kind: 'source_changed', id, runId: run.id, submissionPath, message: 'The source changed after this task was exposed. Mark it failed with reason source_changed, then continue.' };
    }
    const state = auditSessionChunkState(run, session.id);
    if (state?.chunkCount) {
      return {
        id,
        kind: 'session_audit',
        runId: run.id,
        request: createSessionAuditFromChunksRequest(withLocale(session, runLocale(run)), state.chunkResults.length ? [state.chunkResults.at(-1)] : []),
        submissionPath
      };
    }
    return {
      id,
      kind: 'session_audit',
      runId: run.id,
      input,
      request: createSessionAuditRequest(withLocale(input, runLocale(run))),
      submissionPath
    };
  }
  const auditAggregateChunk = /^audit:aggregate-chunk:(\d+)$/.exec(id);
  if (auditAggregateChunk) {
    const context = auditAggregateContext(run);
    const index = Number(auditAggregateChunk[1]);
    const extension = ensureUserAuditExtension(run);
    const carry = extension.aggregateChunks.at(-1) ?? null;
    const batch = auditAggregateBatch(run, context, index);
    if (!batch) throw new Error('The frozen audit aggregate batch is unavailable.');
    return {
      id,
      kind: 'audit_aggregate_chunk',
      runId: run.id,
      request: createAuditAggregateChunkRequest(context, batch.sessions, index, batch.total, carry),
      submissionPath
    };
  }
  if (id === 'audit:aggregate') {
    const context = auditAggregateContext(run);
    const direct = createAuditAggregateRequest(context);
    const extension = ensureUserAuditExtension(run);
    const request = direct.prompt.length > 30_000
      ? createAuditAggregateRequest({ ...context, chunkSummaries: [extension.aggregateChunks.at(-1)] })
      : direct;
    return {
      id,
      kind: 'audit_aggregate',
      runId: run.id,
      request,
      submissionPath
    };
  }
  throw new Error('Unsupported frozen semantic task.');
}

export async function getSemanticRun({ runsRoot, runId }) {
  const document = JSON.parse(await readFile(manifestPath(runsRoot, runId), 'utf8'));
  if (['agent-insight/semantic-run-v1', 'agent-insight/semantic-run-v2', 'agent-insight/semantic-run-v3', 'agent-insight/semantic-run-v4'].includes(document?.schema) && document.id === runId) {
    throw new Error('This run uses an older evidence protocol. Run prepare again to start a new analysis; the existing checkpoint and reports are preserved.');
  }
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
  } else if (id.startsWith('audit:session-chunk:')) {
    if (nextAggregateSection(run)) throw new Error('Baseline aggregate tasks must complete before audit tasks.');
    if (run.extensionFailures?.userAudit) throw new Error('User audit extension already failed.');
    const match = /^audit:session-chunk:([a-f0-9]{24}):(\d+)$/.exec(id);
    const session = nextAuditSession(run);
    const state = match ? auditSessionChunkState(run, match[1]) : null;
    const expectedIndex = state?.chunkResults?.length ?? 0;
    if (!session || !state || session.id !== match[1] || `audit:session-chunk:${session.id}:${expectedIndex}` !== id || expectedIndex >= state.chunkCount) {
      throw new Error('The submitted audit session chunk is not the next pending audit task.');
    }
  } else if (id.startsWith('audit:session:')) {
    if (nextAggregateSection(run)) throw new Error('Baseline aggregate tasks must complete before audit tasks.');
    if (run.extensionFailures?.userAudit) throw new Error('User audit extension already failed.');
    const session = nextAuditSession(run);
    if (!session || `audit:session:${session.id}` !== id) throw new Error('The submitted audit session is not the next pending audit task.');
    const state = auditSessionChunkState(run, session.id);
    if (state?.chunkCount && state.chunkResults.length !== state.chunkCount) {
      throw new Error('All audit session chunks must complete before the final session audit.');
    }
  } else if (id.startsWith('audit:aggregate-chunk:')) {
    if (!auditAggregatePending(run)) throw new Error('The submitted audit aggregate chunk is not the next pending audit task.');
    const context = auditAggregateContext(run);
    const expectedIndex = ensureUserAuditExtension(run).aggregateChunks.length;
    if (`audit:aggregate-chunk:${expectedIndex}` !== id || !auditAggregateBatch(run, context, expectedIndex)) {
      throw new Error('The submitted audit aggregate chunk is not the next pending audit task.');
    }
  } else if (id === 'audit:aggregate') {
    if (!auditAggregatePending(run)) throw new Error('The submitted audit aggregate is not the next pending audit task.');
    const context = auditAggregateContext(run);
    const direct = createAuditAggregateRequest(context);
    if (direct.prompt.length > 30_000) {
      if (!auditAggregateBatchesComplete(run, context)) {
        throw new Error('Audit aggregate chunks must complete before the final aggregate task.');
      }
    }
  } else {
    throw new Error('Unsupported semantic task id.');
  }
  return join(runDirectory(runsRoot, runId), 'submission.json');
}

export async function prepareSemanticRun({ runsRoot, request, candidates, analyzer, diagnostics = [], projectFilter = { requested: false, unknownProjectExcluded: 0 } }) {
  let selectedAt = null;
  if (request.selectedAt !== undefined && request.selectedAt !== null) {
    if (typeof request.selectedAt !== 'string' || !Number.isFinite(Date.parse(request.selectedAt))) throw new Error('request.selectedAt must be a valid selection timestamp.');
    selectedAt = new Date(request.selectedAt).toISOString();
  }
  // Custom dates are stable without an anchor. Legacy rolling-window callers
  // did not retain one; do not replace that unknown value with today's time.
  const recheckTimeScope = Boolean(selectedAt || request.start || request.end);
  const timeScope = {
    days: request.days === 'all' ? Infinity : request.days ?? Infinity,
    now: selectedAt ? Date.parse(selectedAt) : undefined,
    start: request.start,
    end: request.end
  };
  for (const [label, path] of [['request.project', request.project], ['projectFilter.path', projectFilter.path]]) {
    if (path !== undefined && path !== null && (typeof path !== 'string' || !path.trim())) throw new Error(`${label} requires a non-empty project path.`);
  }
  if (request.project && projectFilter.path && resolve(request.project) !== resolve(projectFilter.path)) throw new Error('request.project and projectFilter.path must refer to the same project scope.');
  const id = randomUUID();
  const sessions = [];
  const preparationFailures = [];
  const runDiagnostics = structuredClone(diagnostics);
  const projectScope = projectFilter.path ?? request.project;
  const runProjectFilter = projectScope
    ? { ...projectFilter, requested: true, path: resolve(projectScope), unknownProjectExcluded: projectFilter.unknownProjectExcluded ?? 0, mixedProjectExcluded: projectFilter.mixedProjectExcluded ?? 0 }
    : structuredClone(projectFilter);
  for (const candidate of candidates) {
    const locator = normalizedLocator(candidate.locator);
    let input;
    let deterministic;
    try {
      input = await loadAnalysisInput(locator, candidate.source);
      deterministic = await loadDeterministicSession(locator, candidate.source);
      if (deterministic.partial) {
        const error = new Error(`Transcript is incomplete during semantic preparation (${deterministic.partialReason ?? 'unknown'}).`);
        error.code = 'INCOMPLETE_TRANSCRIPT';
        throw error;
      }
      if (recheckTimeScope && !sessionIsWithinWindow(deterministic, timeScope)) {
        const error = new Error('Transcript metadata falls outside the selected time window.');
        error.code = 'TIME_SCOPE_MISMATCH';
        throw error;
      }
      if (projectScope && (!sessionMatchesProject(input, runProjectFilter.path) || !sessionMatchesProject(deterministic, runProjectFilter.path))) {
        const error = new Error('Transcript metadata falls outside the requested project scope.');
        error.code = 'PROJECT_SCOPE_MISMATCH';
        throw error;
      }
    } catch (error) {
      const reasons = { PROJECT_SCOPE_MISMATCH: 'project_scope_mismatch', TIME_SCOPE_MISMATCH: 'time_scope_mismatch', INCOMPLETE_TRANSCRIPT: 'incomplete_transcript' };
      const reason = reasons[error?.code] ?? (/changed while|changed during|content changed/i.test(String(error?.message)) ? 'changed_during_read' : 'transcript_extraction_failed');
      preparationFailures.push({ source: candidate.source, reason });
      let diagnostic = runDiagnostics.find((entry) => entry.source === candidate.source);
      if (!diagnostic) {
        diagnostic = { source: candidate.source, coverage: 'partial' };
        runDiagnostics.push(diagnostic);
      }
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
      analysisMode: createSessionFacetRequest(withLocale(input, normalizeLocale(request.locale))).prompt.length > 30_000 ? 'chunked' : 'direct',
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
      session.chunkRanges = chunkRanges(chunks);
      session.chunkMessageIndexes = chunks.map((chunk) => chunk.map((message) => message.index));
      session.chunkCount = chunks.length;
    }
    const exclusion = deterministicEligibility(input);
    if (exclusion) {
      session.status = 'excluded';
      session.eligibilityReason = exclusion;
    }
    sessions.push(session);
  }
  const manifest = {
    schema: RUN_SCHEMA,
    aggregatePlanningVersion: 2,
    id,
    createdAt: new Date().toISOString(),
    request: { ...request, ...(selectedAt ? { selectedAt } : {}), days: request.days === Infinity ? 'all' : request.days, locale: normalizeLocale(request.locale) },
    analyzer: { host: analyzer.host, model: analyzer.model ?? null },
    diagnostics: runDiagnostics,
    projectFilter: runProjectFilter,
    sessions,
    sections: {},
    sectionFailures: {},
    aggregateChunks: {},
    extensions: { userAudit: { sessions: {}, aggregate: undefined, protocolVersion: AUDIT_PROTOCOL_VERSION, sessionChunks: {}, aggregateChunks: [] } },
    extensionFailures: {},
    preparationFailures,
    failures: preparationFailures.map((failure) => ({ taskId: null, reason: failure.reason, source: failure.source, at: new Date().toISOString() })),
    eligibility: eligibilitySummary(sessions, preparationFailures),
    protocolVersion: ANALYSIS_PROTOCOL_VERSION
  };
  if (preparationFailures.length && !sessions.some((session) => session.status === 'pending' || session.status === 'complete')) {
    for (const section of AGGREGATE_TASKS) manifest.sectionFailures[section] = { reason: 'no_semantic_evidence' };
  }
  fillEmptySectionsIfFinished(manifest);
  const paths = await writeManifest(runsRoot, manifest);
  return { id, ...paths };
}

async function nextSemanticTaskUnlocked({ runsRoot, runId }) {
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
  if (run.activeTask) {
    const task = await resumeActiveTask(runsRoot, run);
    if (task.request?.prompt.length > 30_000) throw new Error('Semantic prompt safety limit exceeded (30,000 characters).');
    return task;
  }
  while (true) {
    const session = run.sessions.find((candidate) => candidate.status === 'pending');
    if (!session) {
      const section = nextAggregateSection(run);
      if (!section) {
        const auditSession = nextAuditSession(run);
        if (auditSession) {
          const input = await loadAnalysisInput(auditSession.locator, auditSession.source);
          if (input.contentHash !== auditSession.contentHash || input.opaqueId !== auditSession.id) {
            recordExtensionFailure(run, 'userAudit', `audit:session:${auditSession.id}`, 'source_changed');
            await writeManifest(runsRoot, run);
            continue;
          }
          try {
            let request = createSessionAuditRequest(withLocale(input, runLocale(run)));
            let state = auditSessionChunkState(run, auditSession.id);
            if (request.prompt.length > 30_000 || state?.chunkCount) {
              if (!state?.chunkCount) state = initAuditSessionChunks(run, auditSession.id, input.messages);
              const chunkIndex = state.chunkResults.length;
              if (chunkIndex < state.chunkCount) {
                const { messages, request: chunkRequest } = boundedSessionChunk(input, state, chunkIndex,
                  (messages, count) => createSessionAuditChunkRequest(withLocale(input, runLocale(run)), messages, chunkIndex, count, state.chunkResults.at(-1) ?? null), true
                );
                if (chunkRequest.prompt.length > 30_000) {
                  throw new Error(`Audit session safety limit exceeded for chunk ${chunkIndex + 1}.`);
                }
                return exposeTask(runsRoot, run, {
                  id: `audit:session-chunk:${auditSession.id}:${chunkIndex}`,
                  kind: 'session_audit_chunk',
                  runId,
                  input: { source: input.source, opaqueId: input.opaqueId, date: input.date, messages },
                  request: chunkRequest,
                  submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
                });
              }
              request = createSessionAuditFromChunksRequest(withLocale(auditSession, runLocale(run)), state.chunkResults.length ? [state.chunkResults.at(-1)] : []);
              if (request.prompt.length > 30_000) throw new Error('Audit session safety limit exceeded for final session synthesis.');
              return exposeTask(runsRoot, run, {
                id: `audit:session:${auditSession.id}`,
                kind: 'session_audit',
                runId,
                request,
                submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
              });
            }
            return exposeTask(runsRoot, run, {
              id: `audit:session:${auditSession.id}`,
              kind: 'session_audit',
              runId,
              input,
              request,
              submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
            });
          } catch (error) {
            if (!/safety limit/i.test(error.message)) throw error;
            recordExtensionFailure(run, 'userAudit', `audit:session:${auditSession.id}`, 'safety_limit');
            await writeManifest(runsRoot, run);
            continue;
          }
        }
        if (auditAggregatePending(run)) {
          try {
            const context = auditAggregateContext(run);
            let request = createAuditAggregateRequest(context);
            if (request.prompt.length > 30_000) {
              const extension = ensureUserAuditExtension(run);
              const chunkIndex = extension.aggregateChunks.length;
              const batch = auditAggregateBatch(run, context, chunkIndex, true);
              if (batch) {
                const carry = extension.aggregateChunks.at(-1) ?? null;
                const chunkRequest = createAuditAggregateChunkRequest(context, batch.sessions, chunkIndex, batch.total, carry);
                if (chunkRequest.prompt.length > 30_000) {
                  throw new Error(`Audit aggregate safety limit exceeded for chunk ${chunkIndex + 1}.`);
                }
                return exposeTask(runsRoot, run, {
                  id: `audit:aggregate-chunk:${chunkIndex}`,
                  kind: 'audit_aggregate_chunk',
                  runId,
                  request: chunkRequest,
                  submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
                });
              }
              request = createAuditAggregateRequest({ ...context, chunkSummaries: [extension.aggregateChunks.at(-1)] });
              if (request.prompt.length > 30_000) throw new Error('Audit aggregate safety limit exceeded for final synthesis.');
            }
            return exposeTask(runsRoot, run, {
              id: 'audit:aggregate',
              kind: 'audit_aggregate',
              runId,
              request,
              submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
            });
          } catch (error) {
            if (!/safety limit/i.test(String(error?.message))) throw error;
            recordExtensionFailure(run, 'userAudit', 'audit:aggregate', 'safety_limit');
            await writeManifest(runsRoot, run);
            continue;
          }
        }
        return { kind: 'complete', runId };
      }
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
      try {
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
      } catch (error) {
        if (!/safety limit|too small|cannot fit/i.test(String(error?.message))) throw error;
        const taskId = `aggregate:${section}`;
        run.sectionFailures ??= {};
        run.sectionFailures[section] = { reason: 'safety_limit', taskId };
        recordSemanticFailure(run, taskId, 'safety_limit');
        await writeManifest(runsRoot, run);
        continue;
      }
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
      const chunkIndex = session.chunkResults.length;
      try {
        if (chunkIndex < session.chunkCount) {
          const { messages, request } = boundedSessionChunk(input, session, chunkIndex,
            (messages, count) => createSessionChunkRequest(withLocale(input, runLocale(run)), messages, chunkIndex, count, session.chunkResults.at(-1) ?? null)
          );
          return exposeTask(runsRoot, run, {
            id: `session-chunk:${session.id}:${chunkIndex}`,
            kind: 'session_chunk',
            runId,
            input: { source: input.source, opaqueId: input.opaqueId, date: input.date, messages },
            request,
            submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
          }, messages);
        }
        const request = createSessionFacetFromChunksRequest(withLocale(session, runLocale(run)), session.chunkResults.length ? [session.chunkResults.at(-1)] : []);
        if (request.prompt.length > 30_000) throw new Error('Session final synthesis safety limit exceeded.');
        return exposeTask(runsRoot, run, {
          id: `session:${session.id}`,
          kind: 'session_facet',
          runId,
          request,
          submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
        });
      } catch (error) {
        if (!/safety limit/i.test(error.message)) throw error;
        const taskId = chunkIndex < session.chunkCount ? `session-chunk:${session.id}:${chunkIndex}` : `session:${session.id}`;
        await failSemanticTaskUnlocked({ runsRoot, runId, taskId, reason: 'safety_limit' });
        return nextSemanticTaskUnlocked({ runsRoot, runId });
      }
    }
    return exposeTask(runsRoot, run, {
      id: `session:${session.id}`,
      kind: 'session_facet',
      runId,
      input,
      request: createSessionFacetRequest(withLocale(input, runLocale(run))),
      submissionPath: join(runDirectory(runsRoot, runId), 'submission.json')
    }, input.messages);
  }
}

async function ingestSemanticResultUnlocked({ runsRoot, runId, taskId, result }) {
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
      : groups[index].map((session) => session.id).filter(Boolean);
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
    const messages = run.activeTask.messages;
    if (!Array.isArray(messages)) throw new Error('The pending semantic task has no frozen text; fail it and prepare a fresh run.');
    const chunkInput = {
      source: session.source,
      date: session.date,
      opaqueId: session.id,
      sessionId: session.sessionId,
      projectPath: session.projectPath,
      projectLabel: session.projectLabel,
      messages,
      derivedEvidence: session.chunkResults.at(-1)?.evidence ?? []
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
  if (String(taskId).startsWith('audit:session-chunk:')) {
    const match = /^audit:session-chunk:([a-f0-9]{24}):(\d+)$/.exec(String(taskId));
    const session = match && run.sessions.find((candidate) => candidate.id === match[1]);
    const index = match ? Number(match[2]) : -1;
    const state = session ? auditSessionChunkState(run, session.id) : null;
    if (!session || session.status !== 'complete' || nextAggregateSection(run) || run.extensionFailures?.userAudit) {
      throw new Error('Audit session chunk task is missing, out of order, or already complete.');
    }
    const expected = nextAuditSession(run);
    if (!expected || expected.id !== session.id || !state || index !== state.chunkResults.length || index >= state.chunkCount) {
      throw new Error('Audit session chunk task is out of order.');
    }
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      throw new Error('Audit session source changed after prepare.');
    }
    const chunkMessages = sessionChunkMessages(input.messages, state, index, true);
    const allowedMessages = [...chunkMessages, ...auditCarryMessages(input, state.chunkResults.at(-1))];
    const chunk = validateSessionAuditChunkResult(result, {
      source: input.source,
      opaqueId: input.opaqueId,
      sessionId: input.sessionId,
      date: input.date,
      messages: allowedMessages
    });
    state.chunkResults.push(chunk);
    run.activeTask = null;
    await writeManifest(runsRoot, run);
    return chunk;
  }
  if (String(taskId).startsWith('audit:session:')) {
    const sessionId = String(taskId).slice('audit:session:'.length);
    const session = run.sessions.find((candidate) => candidate.id === sessionId);
    if (!session || session.status !== 'complete' || nextAggregateSection(run) || run.extensionFailures?.userAudit) {
      throw new Error('Audit session task is missing, out of order, or already complete.');
    }
    const expected = nextAuditSession(run);
    if (!expected || expected.id !== session.id) throw new Error('Audit session task is out of order.');
    const input = await loadAnalysisInput(session.locator, session.source);
    if (input.contentHash !== session.contentHash || input.opaqueId !== session.id) {
      throw new Error('Audit session source changed after prepare.');
    }
    const state = auditSessionChunkState(run, session.id);
    if (state?.chunkCount && state.chunkResults.length !== state.chunkCount) {
      throw new Error('All audit session chunks must complete before the final session audit.');
    }
    let auditInput = input;
    if (state?.chunkCount) {
      auditInput = {
        ...input,
        userTexts: input.messages.filter((message) => message?.role === 'user').map((message) => message.text),
        userMessages: input.messages.filter((message) => message?.role === 'user'),
        messages: auditCarryMessages(input, state.chunkResults.at(-1)),
        assessmentContext: auditCarryAssessmentContext(state.chunkResults.at(-1))
      };
    }
    const audit = validateSessionAuditResult(result, auditInput);
    const extension = ensureUserAuditExtension(run);
    extension.sessions[session.id] = audit;
    delete extension.sessionChunks[session.id];
    run.activeTask = null;
    await writeManifest(runsRoot, run);
    return audit;
  }
  if (String(taskId).startsWith('audit:aggregate-chunk:')) {
    if (!auditAggregatePending(run)) throw new Error('Audit aggregate chunk task is missing, out of order, or already complete.');
    const index = Number(String(taskId).slice('audit:aggregate-chunk:'.length));
    const context = auditAggregateContext(run);
    const extension = ensureUserAuditExtension(run);
    const batch = auditAggregateBatch(run, context, index);
    if (!Number.isInteger(index) || index !== extension.aggregateChunks.length || !batch) {
      throw new Error('Audit aggregate chunk task is out of order.');
    }
    const chunkContext = auditAggregateEvidenceContext(context, batch.sessions, extension.aggregateChunks.at(-1));
    const chunk = validateAuditAggregateChunkResult(result, chunkContext);
    extension.aggregateChunks.push(chunk);
    run.activeTask = null;
    await writeManifest(runsRoot, run);
    return chunk;
  }
  if (String(taskId) === 'audit:aggregate') {
    if (!auditAggregatePending(run)) throw new Error('Audit aggregate task is missing, out of order, or already complete.');
    const context = auditAggregateContext(run);
    const direct = createAuditAggregateRequest(context);
    let validationContext = context;
    if (direct.prompt.length > 30_000) {
      const extension = ensureUserAuditExtension(run);
      if (!auditAggregateBatchesComplete(run, context)) throw new Error('Audit aggregate chunks are incomplete.');
      validationContext = auditAggregateEvidenceContext(context, [], extension.aggregateChunks.at(-1));
    }
    const aggregate = validateAuditAggregateResult(result, validationContext);
    const extension = ensureUserAuditExtension(run);
    extension.aggregate = aggregate;
    extension.aggregateChunks = [];
    run.activeTask = null;
    await writeManifest(runsRoot, run);
    return aggregate;
  }
  if (!String(taskId).startsWith('session:')) throw new Error('Unsupported semantic task id.');
  const session = run.sessions.find((candidate) => `session:${candidate.id}` === taskId);
  if (!session || session.status !== 'pending') throw new Error('Semantic session task is missing or already complete.');
  if (session.analysisMode === 'chunked' && session.chunkResults.length !== session.chunkCount) {
    throw new Error('All session chunks must complete before the final session facet.');
  }
  const messages = session.analysisMode === 'chunked' ? [] : run.activeTask.messages;
  if (!Array.isArray(messages)) throw new Error('The pending semantic task has no frozen text; fail it and prepare a fresh run.');
  const frozenInput = {
    source: session.source,
    date: session.date,
    opaqueId: session.id,
    sessionId: session.sessionId,
    projectPath: session.projectPath,
    projectLabel: session.projectLabel,
    messages,
    derivedEvidence: session.analysisMode === 'chunked' ? session.chunkResults.at(-1)?.evidence ?? [] : []
  };
  const facet = validateSessionFacet(result, frozenInput);
  session.status = isWarmupFacet(facet) ? 'excluded' : 'complete';
  session.eligibilityReason = isWarmupFacet(facet) ? 'warmup_minimal' : null;
  session.facet = facet;
  run.activeTask = null;
  run.eligibility = eligibilitySummary(run.sessions, run.preparationFailures);
  fillEmptySectionsIfFinished(run);
  await writeManifest(runsRoot, run);
  return facet;
}

async function failSemanticTaskUnlocked({ runsRoot, runId, taskId, reason = 'analyzer_failure' }) {
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
    recordSemanticFailure(run, id, reason);
    if (!run.sessions.some((candidate) => candidate.status === 'pending' || candidate.status === 'complete')) {
      run.sectionFailures ??= {};
      for (const section of AGGREGATE_TASKS) run.sectionFailures[section] ??= { reason: 'no_semantic_evidence' };
      run.extensionFailures ??= {};
      run.extensionFailures.userAudit ??= { reason: 'no_semantic_evidence', taskId: id, at: new Date().toISOString() };
    }
  } else if (id.startsWith('audit:')) {
    recordExtensionFailure(run, 'userAudit', id, reason);
  } else {
    const section = /^aggregate(?:-chunk)?:([a-z_]+)/.exec(id)?.[1];
    if (!section || !AGGREGATE_TASKS.includes(section)) throw new Error('Unsupported semantic task id.');
    run.sectionFailures ??= {};
    run.sectionFailures[section] = { reason, taskId: id };
    if (run.aggregateBatch?.ids?.includes(id)) {
      run.aggregateBatch.ids = run.aggregateBatch.ids.filter((task) => task !== id);
      if (run.aggregateBatch.ids.length === 0) run.aggregateBatch = null;
    }
    recordSemanticFailure(run, id, reason);
  }
  if (run.activeTask?.id === id) run.activeTask = null;
  await writeManifest(runsRoot, run);
  return { taskId: id, reason, status: 'failed' };
}

async function finalizeSemanticRunUnlocked({ runsRoot, runId, outputDirectory }) {
  const run = await getSemanticRun({ runsRoot, runId });
  const missing = AGGREGATE_TASKS.filter((section) => run.sections[section] === undefined);
  const unresolved = missing.filter((section) => run.sectionFailures?.[section] === undefined);
  const auditUnresolved = Boolean(nextAuditSession(run) || auditAggregatePending(run));
  if (run.sessions.some((session) => session.status === 'pending') || unresolved.length > 0 || auditUnresolved) {
    throw new Error(`Semantic run is incomplete${unresolved.length ? `; missing sections: ${unresolved.join(', ')}` : auditUnresolved ? '; user audit extension is incomplete' : ''}.`);
  }
  const eligibleSessions = run.sessions.filter((session) => session.status === 'complete');
  const sessions = eligibleSessions.map((session) => session.metrics);
  const userAudit = run.extensions?.userAudit;
  const extensions = {
    userAudit: run.extensionFailures?.userAudit
      ? {
          status: 'incomplete',
          protocolVersion: userAudit?.protocolVersion ?? AUDIT_PROTOCOL_VERSION,
          failure: run.extensionFailures.userAudit,
          sessions: userAudit?.sessions ?? {},
          aggregate: userAudit?.aggregate ?? null
        }
      : userAudit?.aggregate
        ? {
            status: 'complete',
            protocolVersion: userAudit.protocolVersion ?? AUDIT_PROTOCOL_VERSION,
            sessions: userAudit.sessions ?? {},
            aggregate: userAudit.aggregate
          }
        : eligibleSessions.length
          ? {
              status: 'incomplete',
              protocolVersion: userAudit?.protocolVersion ?? AUDIT_PROTOCOL_VERSION,
              failure: { reason: 'missing_audit_aggregate' },
              sessions: userAudit?.sessions ?? {},
              aggregate: null
            }
          : {
              status: 'skipped',
              protocolVersion: AUDIT_PROTOCOL_VERSION,
              reason: 'no_eligible_sessions',
              sessions: {},
              aggregate: null
            }
  };
  const semantic = {
    analyzer: run.analyzer,
    failures: run.failures,
    sectionFailures: run.sectionFailures,
    sessions: eligibleSessions.map((session) => {
      const { id, date, source, sessionId, projectPath, projectLabel, facet, locator, metrics, durationMinutes } = session;
      const transcriptPath = locator?.kind === 'file' ? locator.path : null;
      const reopenCommand = transcriptPath
        ? transcriptPath
        : locator?.kind === 'opencode'
          ? `opencode session ${locator.sessionId ?? sessionId ?? id}`
          : null;
      return {
        id,
        date,
        source,
        sessionId: sessionId ?? id,
        projectPath: projectPath ?? null,
        projectLabel: projectLabel ?? null,
        facet,
        transcriptPath,
        reopenCommand,
        userMessages: metrics?.userMessages ?? null,
        assistantMessages: metrics?.assistantMessages ?? null,
        toolCalls: metrics?.toolCalls ?? null,
        toolErrors: metrics?.toolErrors ?? null,
        durationMinutes: durationMinutes ?? null,
        startedAt: metrics?.startedAt ?? null,
        endedAt: metrics?.endedAt ?? null
      };
    }),
    sections: run.sections
  };
  const report = summarizeSessions(sessions, {
    days: run.request.days === 'all' ? Infinity : run.request.days,
    requestedRange: run.request.start && run.request.end ? { start: run.request.start, end: run.request.end } : null,
    selectedAt: run.request.selectedAt ?? null,
    sourcesScanned: run.diagnostics,
    projectFilter: run.projectFilter,
    semantic,
    extensions,
    eligibility: run.eligibility,
    locale: runLocale(run)
  });
  const files = await writeReport(report, outputDirectory);
  run.status = run.failures?.length || run.extensionFailures?.userAudit ? 'partial' : 'complete';
  run.completedAt = new Date().toISOString();
  run.report = { timestampedHtml: files.timestampedHtml, html: files.html, json: files.json, markdown: files.markdown };
  await writeManifest(runsRoot, run);
  await cleanTransientRunFiles(runsRoot, runId);
  return { report, files };
}

export async function withSemanticRunTransaction({ runsRoot, runId }, callback) {
  const context = { runsRoot, runId };
  try {
    return await withRunLock(runDirectory(runsRoot, runId), async () => {
      let active = true;
      let pending = null;
      const invoke = (operation, arguments_ = {}) => {
        if (!active) throw new Error('Semantic run transaction is already closed.');
        if (pending) throw new Error('A semantic transaction operation is still running; await it before starting another.');
        const result = operation({ ...arguments_, ...context });
        const completion = result.finally(() => { if (pending === completion) pending = null; });
        pending = completion;
        return completion;
      };
      const transaction = Object.freeze({
        getRun: () => invoke(getSemanticRun),
        next: () => invoke(nextSemanticTaskUnlocked),
        submissionForTask: (options) => invoke(semanticSubmissionForTask, options),
        ingest: (options) => invoke(ingestSemanticResultUnlocked, options),
        fail: (options) => invoke(failSemanticTaskUnlocked, options),
        finalize: (options) => invoke(finalizeSemanticRunUnlocked, options)
      });
      try {
        return await callback(transaction);
      } finally {
        active = false;
        // Even an accidentally unawaited transaction method must finish before
        // another process may acquire the run and read its checkpoint.
        if (pending) await pending.catch(() => {});
      }
    });
  } catch (error) {
    if (error instanceof DirectoryLockCleanupError) {
      const value = error.result;
      if (value && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
        return { ...value, lockCleanupWarning: error.lockCleanupWarning };
      }
    }
    // Primitive or non-record callbacks retain their original result inside the
    // explicit operationCompleted error instead of silently changing its type.
    throw error;
  }
}

export function nextSemanticTask(options) {
  return withSemanticRunTransaction(options, (transaction) => transaction.next());
}

export function ingestSemanticResult(options) {
  return withSemanticRunTransaction(options, (transaction) => transaction.ingest(options));
}

export function failSemanticTask(options) {
  return withSemanticRunTransaction(options, (transaction) => transaction.fail(options));
}

export function finalizeSemanticRun(options) {
  return withSemanticRunTransaction(options, (transaction) => transaction.finalize(options));
}

export { PROMPT_VERSION, RUN_SCHEMA };

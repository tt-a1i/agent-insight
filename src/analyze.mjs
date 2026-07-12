import { basename } from 'node:path';
import { AGGREGATE_TASKS } from './aggregate-protocol.mjs';
import { normalizeLocale } from './i18n.mjs';

const dateOnly = (value) => value ? value.slice(0, 10) : null;
const number = (value) => new Intl.NumberFormat('en-US').format(value);

function labelProject(project) {
  if (!project) return 'Unknown project';
  if (/\[redacted:|\bses_[A-Za-z0-9]+/i.test(project)) return 'Redacted project';
  const normalized = project.replace(/[\\/]+$/, '');
  return basename(normalized) || normalized;
}

function sortEntries(object, limit = 8) {
  return Object.entries(object)
    .sort(([, left], [, right]) => right - left)
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function addCounts(target, counts) {
  for (const [name, count] of Object.entries(counts ?? {})) target[name] = (target[name] ?? 0) + (Number(count) || 0);
}

function increment(target, name) {
  if (name) target[name] = (target[name] ?? 0) + 1;
}

function rounded(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function responseStats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return { median: null, average: null };
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    average: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length, 1)
  };
}

function multiClauding(sessions) {
  const events = sessions.flatMap((session) => (session.userMessageTimestamps ?? []).map((timestamp) => ({ session: session.id, timestamp, time: Date.parse(timestamp) }))).filter((event) => Number.isFinite(event.time)).sort((left, right) => left.time - right.time);
  const pairs = new Set();
  const involved = new Set();
  const overlappingMessages = new Set();
  const latestBySession = new Map();
  for (let currentIndex = 0; currentIndex < events.length; currentIndex += 1) {
    const current = events[currentIndex];
    const previousIndex = latestBySession.get(current.session);
    if (previousIndex !== undefined && current.time - events[previousIndex].time <= 30 * 60 * 1000) {
      for (let middleIndex = previousIndex + 1; middleIndex < currentIndex; middleIndex += 1) {
        const middle = events[middleIndex];
        if (middle.session === current.session) continue;
        const pair = JSON.stringify([current.session, middle.session].sort());
        const previous = events[previousIndex];
        pairs.add(pair);
        involved.add(current.session);
        involved.add(middle.session);
        overlappingMessages.add(`${previous.timestamp}:${previous.session}`);
        overlappingMessages.add(`${middle.timestamp}:${middle.session}`);
        overlappingMessages.add(`${current.timestamp}:${current.session}`);
        break;
      }
    }
    latestBySession.set(current.session, currentIndex);
  }
  return {
    overlapEvents: pairs.size,
    sessionsInvolved: involved.size,
    userMessagesDuring: overlappingMessages.size
  };
}

function buildInsightsAggregate(sessions, semantic, sourcesScanned) {
  const toolCounts = {};
  const languages = {};
  const projects = {};
  const toolErrorCategories = {};
  const messageHours = {};
  const responseTimes = [];
  let durationMinutes = 0;
  const totals = {
    gitCommits: 0,
    gitPushes: 0,
    interruptions: 0,
    toolErrors: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesModified: 0,
    taskAgentSessions: 0,
    mcpSessions: 0,
    webSearchSessions: 0,
    webFetchSessions: 0
  };
  for (const session of sessions) {
    addCounts(toolCounts, session.toolNames);
    addCounts(languages, session.languages);
    addCounts(toolErrorCategories, session.toolErrorCategories);
    addCounts(messageHours, session.messageHours);
    responseTimes.push(...(session.userResponseTimes ?? []));
    projects[labelProject(session.project)] = (projects[labelProject(session.project)] ?? 0) + 1;
    const start = Date.parse(session.startedAt);
    const end = Date.parse(session.endedAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durationMinutes += Math.round((end - start) / 60_000);
    totals.gitCommits += session.gitCommits ?? 0;
    totals.gitPushes += session.gitPushes ?? 0;
    totals.interruptions += session.userInterruptions ?? 0;
    totals.toolErrors += session.toolErrors ?? 0;
    totals.linesAdded += session.linesAdded ?? 0;
    totals.linesRemoved += session.linesRemoved ?? 0;
    totals.filesModified += session.filesModified ?? 0;
    totals.taskAgentSessions += session.usesTaskAgent ? 1 : 0;
    totals.mcpSessions += session.usesMcp ? 1 : 0;
    totals.webSearchSessions += session.usesWebSearch ? 1 : 0;
    totals.webFetchSessions += session.usesWebFetch ? 1 : 0;
  }
  const goalCategories = {};
  const outcomes = {};
  const satisfaction = {};
  const helpfulness = {};
  const sessionTypes = {};
  const friction = {};
  const primarySuccesses = {};
  const semanticSessions = semantic?.sessions ?? [];
  for (const { facet } of semanticSessions) {
    if (!facet) continue;
    addCounts(goalCategories, facet.goalCategories);
    increment(outcomes, facet.outcome);
    addCounts(satisfaction, facet.userSatisfactionCounts);
    increment(helpfulness, facet.agentHelpfulness);
    increment(sessionTypes, facet.sessionType);
    addCounts(friction, facet.frictionCounts);
    increment(primarySuccesses, facet.primarySuccess);
  }
  const days = new Set(sessions.map((session) => dateOnly(session.startedAt)).filter(Boolean));
  const userMessages = sessions.reduce((sum, session) => sum + session.userMessages, 0);
  const response = responseStats(responseTimes);
  const filesScanned = sourcesScanned.reduce((sum, source) => sum + (source.filesFound ?? 0), 0);
  return {
    totalSessions: sessions.length,
    totalSessionsScanned: Math.max(sessions.length, filesScanned),
    sessionsWithFacets: semanticSessions.filter((session) => session.facet).length,
    dateRange: sessions.length ? { start: dateOnly(sessions[0].startedAt), end: dateOnly(sessions.at(-1).startedAt) } : { start: null, end: null },
    totalMessages: userMessages,
    totalDurationHours: rounded(durationMinutes / 60),
    totalInputTokens: sessions.reduce((sum, session) => sum + (session.inputTokens ?? 0), 0),
    totalOutputTokens: sessions.reduce((sum, session) => sum + (session.outputTokens ?? 0), 0),
    toolCounts,
    languages,
    gitCommits: totals.gitCommits,
    gitPushes: totals.gitPushes,
    projects,
    goalCategories,
    outcomes,
    satisfaction,
    helpfulness,
    sessionTypes,
    friction,
    primarySuccesses,
    sessionSummaries: semanticSessions.filter((session) => session.facet).map((session) => ({ id: session.id, date: session.date, summary: session.facet.briefSummary, underlyingGoal: session.facet.underlyingGoal })),
    totalInterruptions: totals.interruptions,
    totalToolErrors: totals.toolErrors,
    toolErrorCategories,
    userResponseTimes: responseTimes,
    medianResponseTime: response.median,
    averageResponseTime: response.average,
    sessionsUsingTaskAgent: totals.taskAgentSessions,
    sessionsUsingMcp: totals.mcpSessions,
    sessionsUsingWebSearch: totals.webSearchSessions,
    sessionsUsingWebFetch: totals.webFetchSessions,
    totalLinesAdded: totals.linesAdded,
    totalLinesRemoved: totals.linesRemoved,
    totalFilesModified: totals.filesModified,
    daysActive: days.size,
    messagesPerDay: days.size ? rounded(userMessages / days.size, 1) : 0,
    messageHours,
    multiClauding: multiClauding(sessions)
  };
}

function buildObservations(totals, sourceCount, projects, sessions) {
  const observations = [];
  if (sourceCount > 1) {
    observations.push({
      title: 'Cross-agent view',
      detail: `${sourceCount} agents contributed to this report, so the numbers describe your workflow rather than one vendor's telemetry.`
    });
  }
  const oneTurn = sessions.filter((session) => session.userMessages <= 1).length;
  if (totals.sessions && oneTurn / totals.sessions >= 0.4) {
    observations.push({
      title: 'Many short explorations',
      detail: `${number(oneTurn)} of ${number(totals.sessions)} sessions contain one or fewer recorded user turns. That may be healthy exploration; compare it with concrete outcomes before treating it as waste.`
    });
  }
  if (totals.toolErrors > 0) {
    const rate = totals.toolCalls ? Math.round((totals.toolErrors / totals.toolCalls) * 100) : 0;
    observations.push({
      title: 'Tool friction is visible',
      detail: `${number(totals.toolErrors)} tool failures or denials were recorded (${rate}% of recorded tool calls). Look for a repeated permission, environment, or setup cause before changing prompts.`
    });
  }
  if (projects.length >= 5) {
    observations.push({
      title: 'Context switches are material',
      detail: `The sample spans ${number(projects.length)} projects. Generate a project-filtered report before drawing conclusions about any one codebase.`
    });
  }
  if (totals.branchedSessions > 0) {
    observations.push({
      title: 'Branching history is included',
      detail: `${number(totals.branchedSessions)} session files contain multiple branches. Their counts describe stored history, not necessarily only the active conversation path.`
    });
  }
  if (observations.length === 0) {
    observations.push({
      title: 'Start with the baseline',
      detail: 'The local metadata sample is small or fairly even. Re-run after more sessions or expand the time window before optimizing a workflow.'
    });
  }
  return observations;
}

function buildRecommendations(totals, projects, sourceCount) {
  const recommendations = [
    {
      title: 'Turn recurring guidance into durable context',
      detail: 'Ask the active agent to review agent-prompt.md and turn only repeated, evidence-backed instructions into a project instruction file, skill, or command.'
    }
  ];
  if (sourceCount > 1) {
    recommendations.push({
      title: 'Keep the cross-agent baseline, inspect locally',
      detail: 'Use --project <path> when diagnosing one repository, and keep the all-agent report for broader workflow patterns.'
    });
  }
  if (totals.toolErrors > 0) {
    recommendations.push({
      title: 'Fix the workflow boundary before prompt wording',
      detail: 'Review permission rules, missing CLIs, credentials, and project setup around failed calls; a better prompt cannot repair an unavailable tool.'
    });
  }
  if (projects.length > 1) {
    recommendations.push({
      title: 'Make project context explicit',
      detail: 'A short project instruction file with build, test, and verification commands reduces cross-project assumptions for every supported agent.'
    });
  }
  return recommendations.slice(0, 3);
}

export function summarizeSessions(sessions, { days = 30, requestedRange = null, sourcesScanned = [], projectFilter = { requested: false, unknownProjectExcluded: 0 }, semantic = null, extensions = null, eligibility = null, locale = null } = {}) {
  const ordered = [...sessions].sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
  const sourceMap = {};
  const projects = {};
  const tools = {};
  const providers = {};
  const models = {};
  const totals = {
    sessions: ordered.length,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    turnFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    branchedSessions: 0
  };

  for (const session of ordered) {
    const source = sourceMap[session.source] ??= { sessions: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, toolErrors: 0, turnFailures: 0 };
    source.sessions += 1;
    source.userMessages += session.userMessages;
    source.assistantMessages += session.assistantMessages;
    source.toolCalls += session.toolCalls;
    source.toolErrors += session.toolErrors;
    source.turnFailures += session.turnFailures ?? 0;
    if (session.hasBranches) totals.branchedSessions += 1;
    for (const key of Object.keys(totals).filter((key) => key !== 'sessions')) totals[key] += session[key] ?? 0;
    projects[labelProject(session.project)] = (projects[labelProject(session.project)] ?? 0) + 1;
    for (const [tool, count] of Object.entries(session.toolNames)) tools[tool] = (tools[tool] ?? 0) + count;
    for (const [provider, count] of Object.entries(session.providers ?? {})) providers[provider] = (providers[provider] ?? 0) + count;
    for (const [model, count] of Object.entries(session.models ?? {})) models[model] = (models[model] ?? 0) + count;
  }

  const dateRange = ordered.length
    ? { start: dateOnly(ordered[0].startedAt), end: dateOnly(ordered.at(-1).startedAt) }
    : { start: null, end: null };
  const projectEntries = sortEntries(projects);
  const sourceCount = Object.keys(sourceMap).length;
  const sections = semantic?.sections ?? {};
  const missingSections = AGGREGATE_TASKS.filter((section) => sections[section] === undefined);
  const incompleteSources = sourcesScanned.filter((source) => !['available', 'empty'].includes(source.coverage));
  const changedDuringRun = Number(eligibility?.reasons?.changed_after_prepare ?? 0);
  const semanticFailures = semantic?.failures ?? [];
  const extensionFailures = Object.entries(extensions ?? {})
    .filter(([, value]) => value?.status === 'incomplete' || value?.failure)
    .map(([name, value]) => ({ extension: name, reason: value.failure?.reason ?? value.reason ?? 'incomplete' }));
  const dataStatus = incompleteSources.length > 0 || changedDuringRun > 0 || semanticFailures.length > 0 || extensionFailures.length > 0 ? 'partial' : 'complete';
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    locale: normalizeLocale(locale),
    privacy: {
      rawTranscriptRetained: false,
      rawTranscriptWritten: false,
      note: 'This report may include representative user quotations, absolute project paths, agent identity, dates, and session identifiers. It does not copy complete transcripts or tool payloads.'
    },
    parity: {
      target: 'claude-code/2.1.206',
      structuralStatus: missingSections.length === 0 ? 'complete' : 'partial',
      missingSections,
      dataStatus,
      incompleteSources: incompleteSources.map((source) => source.source),
      changedDuringRun,
      evidenceContext: {
        sessions: (semantic?.sessions ?? []).filter((session) => session.facet).map((session) => ({
          id: session.id,
          sessionId: session.sessionId ?? session.id,
          source: session.source ?? 'unknown',
          date: session.date,
          projectPath: session.projectPath ?? null,
          grounding: (session.facet.evidence ?? []).map((item) => ({
            messageIndexes: item.messageIndexes,
            description: item.description,
            quotation: item.quotation ?? null,
            sessionId: item.sessionId ?? session.sessionId ?? session.id,
            projectPath: item.projectPath ?? session.projectPath ?? null
          }))
        })).filter((session) => session.grounding.length > 0)
      }
    },
    coverage: {
      requestedDays: days === Infinity ? 'all available' : days,
      requestedRange,
      sourcesScanned,
      projectFilter,
      eligibility,
      semanticFailures,
      sectionFailures: semantic?.sectionFailures ?? {},
      extensionFailures
    },
    dateRange,
    totals,
    sources: sourceMap,
    projects: projectEntries,
    topTools: sortEntries(tools),
    providers: sortEntries(providers),
    models: sortEntries(models),
    insights: buildInsightsAggregate(ordered, semantic, sourcesScanned),
    semantic: {
      enabled: Boolean(semantic),
      analyzer: semantic?.analyzer ?? null,
      sessions: (semantic?.sessions ?? []).map((session) => ({
        id: session.id,
        date: session.date,
        source: session.source ?? 'unknown',
        sessionId: session.sessionId ?? session.id,
        projectPath: session.projectPath ?? null,
        projectLabel: session.projectLabel ?? null,
        transcriptPath: session.transcriptPath ?? null,
        reopenCommand: session.reopenCommand ?? null,
        userMessages: session.userMessages ?? null,
        assistantMessages: session.assistantMessages ?? null,
        toolCalls: session.toolCalls ?? null,
        toolErrors: session.toolErrors ?? null,
        durationMinutes: session.durationMinutes ?? null,
        startedAt: session.startedAt ?? null,
        endedAt: session.endedAt ?? null
      })),
      failures: semanticFailures,
      sectionFailures: semantic?.sectionFailures ?? {},
      sections
    },
    extensions: extensions ?? {},
    observations: buildObservations(totals, sourceCount, projectEntries, ordered),
    recommendations: buildRecommendations(totals, projectEntries, sourceCount)
  };
}

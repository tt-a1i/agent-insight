import { basename } from 'node:path';

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

export function summarizeSessions(sessions, { days = 30, sourcesScanned = [], projectFilter = { requested: false, unknownProjectExcluded: 0 } } = {}) {
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
    ? { start: dateOnly(ordered[0].startedAt), end: dateOnly(ordered.at(-1).endedAt) }
    : { start: null, end: null };
  const projectEntries = sortEntries(projects);
  const sourceCount = Object.keys(sourceMap).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    privacy: {
      rawTranscriptRetained: false,
      rawTranscriptWritten: false,
      note: 'This report contains derived metadata only. It does not include prompt text, tool output, source code, file paths, or session IDs.'
    },
    coverage: { requestedDays: days === Infinity ? 'all available' : days, sourcesScanned, projectFilter },
    dateRange,
    totals,
    sources: sourceMap,
    projects: projectEntries,
    topTools: sortEntries(tools),
    providers: sortEntries(providers),
    models: sortEntries(models),
    observations: buildObservations(totals, sourceCount, projectEntries, ordered),
    recommendations: buildRecommendations(totals, projectEntries, sourceCount)
  };
}

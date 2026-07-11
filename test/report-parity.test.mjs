import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeSessions } from '../src/analyze.mjs';
import { parseSessionFile } from '../src/parse.mjs';
import { renderMarkdown } from '../src/report.mjs';
import { renderHtml } from '../src/report.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

function metadataSession({ id, startedAt, endedAt, userMessageTimestamps = [] }) {
  return {
    id,
    source: 'claude',
    project: null,
    startedAt,
    endedAt,
    userMessages: userMessageTimestamps.length,
    assistantMessages: 0,
    toolCalls: 0,
    toolErrors: 0,
    turnFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolNames: {},
    languages: {},
    providers: {},
    models: {},
    userMessageTimestamps
  };
}

test('report exposes the Claude 2.1.206 deterministic and semantic aggregate contract', async () => {
  const session = await parseSessionFile(fixture('claude-parity.jsonl'), 'claude');
  const facet = {
    protocolVersion: 'claude-insights-2.1.206/v1',
    underlyingGoal: 'Fix a broken parser',
    goalCategories: { fix_bug: 1 },
    outcome: 'fully_achieved',
    userSatisfactionCounts: { satisfied: 1 },
    agentHelpfulness: 'very_helpful',
    sessionType: 'single_task',
    frictionCounts: { tool_failed: 1 },
    frictionDetail: 'A command failed once.',
    primarySuccess: 'correct_code_edits',
    briefSummary: 'The parser was fixed.',
    evidence: []
  };
  const report = summarizeSessions([session], {
    days: 30,
    semantic: {
      analyzer: { host: 'claude', model: 'current' },
      sessions: [{ id: 'opaque-a', date: '2026-07-03', facet }],
      sections: { interaction_style: { narrative: 'You work in verification loops.', keyPattern: 'Verify each change.', evidenceSessionIds: ['opaque-a'] } }
    }
  });

  assert.equal(report.parity.target, 'claude-code/2.1.206');
  assert.equal(report.parity.structuralStatus, 'partial');
  assert.equal(report.insights.totalSessions, 1);
  assert.equal(report.insights.sessionsWithFacets, 1);
  assert.equal(report.insights.totalMessages, 2);
  assert.equal(report.insights.gitCommits, 1);
  assert.equal(report.insights.gitPushes, 1);
  assert.equal(report.insights.totalInterruptions, 1);
  assert.equal(report.insights.totalToolErrors, 1);
  assert.equal(report.insights.medianResponseTime, 10);
  assert.equal(report.insights.averageResponseTime, 10);
  assert.equal(report.insights.sessionsUsingTaskAgent, 1);
  assert.equal(report.insights.sessionsUsingMcp, 1);
  assert.equal(report.insights.sessionsUsingWebSearch, 1);
  assert.equal(report.insights.sessionsUsingWebFetch, 0);
  assert.equal(report.insights.totalLinesAdded, 2);
  assert.equal(report.insights.totalLinesRemoved, 1);
  assert.equal(report.insights.totalFilesModified, 1);
  assert.deepEqual(report.insights.goalCategories, { fix_bug: 1 });
  assert.deepEqual(report.insights.outcomes, { fully_achieved: 1 });
  assert.deepEqual(report.insights.satisfaction, { satisfied: 1 });
  assert.deepEqual(report.insights.helpfulness, { very_helpful: 1 });
  assert.deepEqual(report.insights.sessionTypes, { single_task: 1 });
  assert.deepEqual(report.insights.friction, { tool_failed: 1 });
  assert.deepEqual(report.insights.primarySuccesses, { correct_code_edits: 1 });
  assert.equal(report.semantic.sections.interaction_style.keyPattern, 'Verify each change.');
  assert.equal(JSON.stringify(report).includes('Fix a broken parser'), true);
  assert.equal(JSON.stringify(report).includes('/work/parity'), false);
  assert.equal(JSON.stringify(report).includes('private output'), false);
});

test('custom semantic date ranges remain explicit in report coverage', () => {
  const report = summarizeSessions([], {
    days: null,
    requestedRange: { start: '2026-06-01', end: '2026-06-30' }
  });
  assert.deepEqual(report.coverage.requestedRange, { start: '2026-06-01', end: '2026-06-30' });
  assert.match(renderMarkdown(report), /2026-06-01 to 2026-06-30 requested range/);
  assert.doesNotMatch(renderMarkdown(report), /null-day/);
});

test('complete section structure never hides partial transcript coverage', () => {
  const completeSections = Object.fromEntries([
    'project_areas', 'interaction_style', 'what_works', 'friction_analysis',
    'suggestions', 'on_the_horizon', 'fun_ending', 'at_a_glance'
  ].map((name) => [name, {}]));
  const report = summarizeSessions([], {
    sourcesScanned: [{ source: 'claude', coverage: 'partial', filesFound: 3, filesSelected: 2, filesLimited: 1 }],
    semantic: { analyzer: { host: 'claude', model: 'current' }, sessions: [], sections: completeSections },
    eligibility: { scanned: 1, eligible: 0, excluded: 1, reasons: { changed_after_prepare: 1 } }
  });
  assert.equal(report.parity.structuralStatus, 'complete');
  assert.equal(report.parity.dataStatus, 'partial');
  assert.match(renderHtml(report), /complete structure · partial data coverage/);
  assert.doesNotMatch(renderHtml(report), />complete parity coverage</);
});

test('semantic cache behavior is visible in report coverage', () => {
  const report = summarizeSessions([], {
    semantic: {
      analyzer: { host: 'codex', model: 'gpt-5' },
      cache: { enabled: true, hits: 2, misses: 1, invalid: 1, stale: 0, writeFailures: 0 },
      sessions: [],
      sections: {}
    }
  });
  assert.deepEqual(report.coverage.cache, {
    enabled: true, hits: 2, misses: 1, invalid: 1, stale: 0, writeFailures: 0
  });
  assert.match(renderMarkdown(report), /Derived-facet cache: 2 hits, 1 miss, 1 invalid/);
  assert.match(renderHtml(report), /Derived-facet cache: 2 hits, 1 miss, 1 invalid/);
});

test('counts Multi-Clauding only when another session is bracketed by one session', () => {
  const sessionA = metadataSession({
    id: 'session-a',
    startedAt: '2026-07-03T09:00:00.000Z',
    endedAt: '2026-07-03T09:10:00.000Z',
    userMessageTimestamps: ['2026-07-03T09:00:00.000Z']
  });
  const sessionB = metadataSession({
    id: 'session-b',
    startedAt: '2026-07-03T09:05:00.000Z',
    endedAt: '2026-07-03T09:05:00.000Z',
    userMessageTimestamps: ['2026-07-03T09:05:00.000Z']
  });

  const merelyConcurrent = summarizeSessions([sessionA, sessionB]).insights.multiClauding;
  assert.deepEqual(merelyConcurrent, { overlapEvents: 0, sessionsInvolved: 0, userMessagesDuring: 0 });

  sessionA.userMessageTimestamps.push('2026-07-03T09:10:00.000Z');
  sessionA.userMessages += 1;
  const bracketed = summarizeSessions([sessionA, sessionB]).insights.multiClauding;
  assert.deepEqual(bracketed, { overlapEvents: 1, sessionsInvolved: 2, userMessagesDuring: 3 });
});

test('uses the last session start for Claude-compatible date-range ends', () => {
  const first = metadataSession({
    id: 'first',
    startedAt: '2026-07-01T09:00:00.000Z',
    endedAt: '2026-07-10T09:00:00.000Z'
  });
  const last = metadataSession({
    id: 'last',
    startedAt: '2026-07-05T09:00:00.000Z',
    endedAt: '2026-07-20T09:00:00.000Z'
  });

  const report = summarizeSessions([last, first]);

  assert.deepEqual(report.dateRange, { start: '2026-07-01', end: '2026-07-05' });
  assert.deepEqual(report.insights.dateRange, { start: '2026-07-01', end: '2026-07-05' });
});

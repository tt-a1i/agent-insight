import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeSessions } from '../src/analyze.mjs';
import { parseSessionFile } from '../src/parse.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

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

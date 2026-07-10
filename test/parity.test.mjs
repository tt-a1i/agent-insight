import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareParityReports, createBlindSemanticBundle } from '../src/parity.mjs';
import { main } from '../src/cli.mjs';

const sections = {
  project_areas: { areas: [] }, interaction_style: { narrative: 'n', keyPattern: 'k' },
  what_works: { intro: 'i', impressiveWorkflows: [] }, friction_analysis: { intro: 'i', categories: [] },
  suggestions: { instructionAdditions: [], featuresToTry: [], usagePatterns: [] },
  on_the_horizon: { intro: 'i', opportunities: [] }, fun_ending: { headline: 'h', detail: 'd' },
  at_a_glance: { whatsWorking: 'w', whatsHindering: 'h', quickWins: 'q', ambitiousWorkflows: 'a' }
};

function report(overrides = {}) {
  return {
    parity: { target: 'claude-code/2.1.206' },
    insights: {
      totalSessions: 2, totalSessionsScanned: 2, sessionsWithFacets: 2,
      dateRange: { start: '2026-07-01', end: '2026-07-02' }, totalMessages: 6,
      totalDurationHours: 1.5, totalInputTokens: 10, totalOutputTokens: 20,
      toolCounts: { Bash: 2 }, languages: { TypeScript: 1 }, gitCommits: 1, gitPushes: 1,
      totalInterruptions: 0, totalToolErrors: 1, toolErrorCategories: { 'Command Failed': 1 },
      userResponseTimes: [5], medianResponseTime: 5, averageResponseTime: 5,
      sessionsUsingTaskAgent: 1, sessionsUsingMcp: 0, sessionsUsingWebSearch: 1, sessionsUsingWebFetch: 0,
      totalLinesAdded: 3, totalLinesRemoved: 1, totalFilesModified: 1, daysActive: 2,
      messagesPerDay: 3, messageHours: { 9: 6 }, multiClauding: { overlapEvents: 0, sessionsInvolved: 0, userMessagesDuring: 0 },
      ...overrides
    },
    semantic: { sections: structuredClone(sections) }
  };
}

test('parity harness proves complete structure and exact deterministic metrics', () => {
  const result = compareParityReports(report(), report());
  assert.equal(result.structural.score, 1);
  assert.equal(result.deterministic.score, 1);
  assert.equal(result.acceptance.structuralParity, true);
  assert.equal(result.acceptance.deterministicCorrectness, true);
});

test('parity harness exposes missing sections and deterministic mismatches', () => {
  const candidate = report({ totalMessages: 7 });
  delete candidate.semantic.sections.fun_ending;
  const result = compareParityReports(report(), candidate);
  assert.equal(result.structural.missing.includes('semantic.sections.fun_ending'), true);
  assert.deepEqual(result.deterministic.mismatches[0], { path: 'insights.totalMessages', reference: 6, candidate: 7 });
  assert.equal(result.acceptance.structuralParity, false);
  assert.equal(result.acceptance.deterministicCorrectness, false);
});

test('blind semantic bundle hides candidate identity and covers all eight sections', () => {
  const bundle = createBlindSemanticBundle(report(), report(), { seed: 'fixed' });
  assert.equal(bundle.items.length, 8);
  assert.equal(JSON.stringify(bundle).includes('reference'), false);
  assert.equal(JSON.stringify(bundle).includes('candidate'), false);
  assert.ok(bundle.items.every((item) => item.A && item.B && item.section));
});

test('parity CLI writes machine-readable comparison and blind-review artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-parity-'));
  const left = join(root, 'left.json');
  const right = join(root, 'right.json');
  const output = join(root, 'comparison.json');
  const blind = join(root, 'blind.json');
  await writeFile(left, JSON.stringify(report()));
  await writeFile(right, JSON.stringify(report()));
  const result = await main(['parity', 'compare', '--reference', left, '--candidate', right, '--output', output, '--blind-output', blind], { quiet: true });
  assert.equal(result.acceptance.structuralParity, true);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).deterministic.score, 1);
  assert.equal(JSON.parse(await readFile(blind, 'utf8')).items.length, 8);
});

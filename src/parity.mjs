import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { AGGREGATE_TASKS } from './aggregate-protocol.mjs';

const DETERMINISTIC_FIELDS = [
  'totalSessions', 'totalSessionsScanned', 'sessionsWithFacets', 'dateRange', 'totalMessages',
  'totalDurationHours', 'totalInputTokens', 'totalOutputTokens', 'toolCounts', 'languages',
  'gitCommits', 'gitPushes', 'totalInterruptions', 'totalToolErrors', 'toolErrorCategories',
  'userResponseTimes', 'medianResponseTime', 'averageResponseTime', 'sessionsUsingTaskAgent',
  'sessionsUsingMcp', 'sessionsUsingWebSearch', 'sessionsUsingWebFetch', 'totalLinesAdded',
  'totalLinesRemoved', 'totalFilesModified', 'daysActive', 'messagesPerDay', 'messageHours',
  'multiClauding'
];

function hasOwn(object, key) {
  return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function score(matched, total) {
  return total === 0 ? 1 : Math.round((matched / total) * 10_000) / 10_000;
}

export function compareParityReports(reference, candidate) {
  if (!reference?.insights || !candidate?.insights) throw new Error('Parity comparison requires two Agent Insight report objects.');
  const structuralPaths = [
    'parity.target', 'insights', 'semantic.sections',
    ...DETERMINISTIC_FIELDS.map((field) => `insights.${field}`),
    ...AGGREGATE_TASKS.map((section) => `semantic.sections.${section}`)
  ];
  const missing = structuralPaths.filter((path) => {
    const parts = path.split('.');
    let value = candidate;
    for (const part of parts) {
      if (!hasOwn(value, part)) return true;
      value = value[part];
    }
    return false;
  });
  const mismatches = DETERMINISTIC_FIELDS.flatMap((field) => {
    const expected = reference.insights[field];
    const actual = candidate.insights[field];
    return isDeepStrictEqual(expected, actual) ? [] : [{ path: `insights.${field}`, reference: expected, candidate: actual }];
  });
  const structuralScore = score(structuralPaths.length - missing.length, structuralPaths.length);
  const deterministicScore = score(DETERMINISTIC_FIELDS.length - mismatches.length, DETERMINISTIC_FIELDS.length);
  return {
    schema: 'agent-insight/parity-comparison-v1',
    target: 'claude-code/2.1.206',
    structural: { required: structuralPaths.length, present: structuralPaths.length - missing.length, score: structuralScore, missing },
    deterministic: { compared: DETERMINISTIC_FIELDS.length, matched: DETERMINISTIC_FIELDS.length - mismatches.length, score: deterministicScore, mismatches },
    semantic: { evaluation: 'blind_review_required', tieOrBetterThreshold: 0.8, sections: [...AGGREGATE_TASKS] },
    acceptance: {
      structuralParity: structuralScore === 1,
      deterministicCorrectness: deterministicScore === 1,
      semanticTieOrBetter: null
    }
  };
}

export function createBlindSemanticBundle(leftReport, rightReport, { seed = '' } = {}) {
  if (!leftReport?.semantic?.sections || !rightReport?.semantic?.sections) throw new Error('Blind comparison requires semantic sections in both reports.');
  return {
    schema: 'agent-insight/blind-semantic-v1',
    target: 'claude-code/2.1.206',
    instructions: 'For each section choose A, B, or tie. Judge usefulness, specificity, grounding, and actionability without guessing origin.',
    items: AGGREGATE_TASKS.map((section) => {
      const swap = Number.parseInt(createHash('sha256').update(`${seed}\u0000${section}`).digest('hex').slice(0, 2), 16) % 2 === 1;
      const left = structuredClone(leftReport.semantic.sections[section]);
      const right = structuredClone(rightReport.semantic.sections[section]);
      return { section, A: swap ? right : left, B: swap ? left : right, rating: null };
    })
  };
}

export { DETERMINISTIC_FIELDS };

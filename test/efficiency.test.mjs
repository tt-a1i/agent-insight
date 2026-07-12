import { test } from 'node:test';
import { strictEqual, deepEqual, ok } from 'node:assert';
import { sessionEfficiency, corpusEfficiency, efficiencyToFindings, EFFICIENCY_TO_CATEGORY } from '../src/efficiency.mjs';

function makeSession(overrides = {}) {
  return {
    id: 'test-1',
    userMessages: 10,
    assistantMessages: 15,
    toolCalls: 20,
    toolErrors: 2,
    toolNames: { Bash: 10, Read: 5, Edit: 3, Write: 2 },
    startedAt: '2026-07-01T09:00:00.000Z',
    endedAt: '2026-07-01T10:00:00.000Z',
    shortUserTurns: 3,
    correctionTurns: 1,
    lastToolSequence: ['Bash', 'Bash', 'Edit', 'Read', 'Bash'],
    ...overrides
  };
}

test('sessionEfficiency computes clarification density from shortUserTurns', () => {
  const s = makeSession({ userMessages: 10, shortUserTurns: 4 });
  const eff = sessionEfficiency(s);
  strictEqual(eff.clarificationDensity, 0.4);
  ok(eff.coverage.clarificationDensity);
});

test('sessionEfficiency computes correction rate from correctionTurns', () => {
  const s = makeSession({ userMessages: 10, correctionTurns: 2 });
  const eff = sessionEfficiency(s);
  strictEqual(eff.correctionRate, 0.2);
  ok(eff.coverage.correctionRate);
});

test('sessionEfficiency computes dominant tool share from toolNames', () => {
  const s = makeSession({ toolCalls: 20, toolNames: { Bash: 12, Read: 5, Edit: 3 } });
  const eff = sessionEfficiency(s);
  strictEqual(eff.dominantToolShare, 0.6);
  strictEqual(eff.dominantTool, 'Bash');
});

test('sessionEfficiency computes turns per hour from duration', () => {
  const s = makeSession({ userMessages: 10, assistantMessages: 10, startedAt: '2026-07-01T09:00:00.000Z', endedAt: '2026-07-01T10:00:00.000Z' });
  const eff = sessionEfficiency(s);
  // 20 turns / 1 hour = 20
  strictEqual(eff.turnsPerHour, 20);
});

test('sessionEfficiency detects verification gap when last 5 tools lack verification', () => {
  const s = makeSession({ lastToolSequence: ['Bash', 'Bash', 'Edit', 'Write', 'Write'] });
  const eff = sessionEfficiency(s);
  strictEqual(eff.verificationGap, true);
});

test('sessionEfficiency detects no verification gap when last 5 tools include test/grep', () => {
  const s = makeSession({ lastToolSequence: ['Bash', 'Edit', 'Bash', 'grep', 'test'] });
  const eff = sessionEfficiency(s);
  strictEqual(eff.verificationGap, false);
});

test('sessionEfficiency returns null coverage when parse layer did not retain text', () => {
  const s = makeSession({ shortUserTurns: null, correctionTurns: null, lastToolSequence: null });
  const eff = sessionEfficiency(s);
  strictEqual(eff.clarificationDensity, null);
  strictEqual(eff.correctionRate, null);
  strictEqual(eff.verificationGap, null);
  strictEqual(eff.coverage.clarificationDensity, false);
  strictEqual(eff.coverage.correctionRate, false);
  strictEqual(eff.coverage.verificationGap, false);
  // These should still work from existing fields
  ok(eff.coverage.dominantToolShare);
  ok(eff.coverage.turnsPerHour);
});

test('corpusEfficiency aggregates across sessions and derives thresholds', () => {
  const sessions = [
    makeSession({ id: 'a', clarificationDensity: 0.1, correctionRate: 0.05 }),
    makeSession({ id: 'b', clarificationDensity: 0.2, correctionRate: 0.1 }),
    makeSession({ id: 'c', clarificationDensity: 0.3, correctionRate: 0.15 }),
    makeSession({ id: 'd', clarificationDensity: 0.4, correctionRate: 0.2 }),
    makeSession({ id: 'e', clarificationDensity: 0.5, correctionRate: 0.25 })
  ];
  const corpus = corpusEfficiency(sessions);
  strictEqual(corpus.sessions.length, 5);
  ok(corpus.aggregates.clarificationDensity.mean !== null);
  ok(corpus.aggregates.clarificationDensity.median !== null);
  ok(corpus.thresholds.clarificationDensityHigh > 0);
});

test('corpusEfficiency flags sessions exceeding thresholds', () => {
  const sessions = [
    makeSession({ clarificationDensity: 0.1, correctionRate: 0.05 }),
    makeSession({ clarificationDensity: 0.8, correctionRate: 0.5, lastToolSequence: ['Write', 'Write', 'Write', 'Write', 'Write'] }),
    makeSession({ clarificationDensity: 0.15, correctionRate: 0.08 }),
    makeSession({ clarificationDensity: 0.2, correctionRate: 0.1 }),
    makeSession({ clarificationDensity: 0.25, correctionRate: 0.12 })
  ];
  const corpus = corpusEfficiency(sessions);
  ok(corpus.flagged.length > 0);
  // The high-clarification session should be flagged
  const flaggedIndices = corpus.flagged.map((f) => f.index);
  ok(flaggedIndices.includes(1));
});

test('corpusEfficiency handles empty sessions array', () => {
  const corpus = corpusEfficiency([]);
  strictEqual(corpus.sessions.length, 0);
  strictEqual(corpus.flagged.length, 0);
  strictEqual(corpus.aggregates.clarificationDensity.mean, null);
});

test('EFFICIENCY_TO_CATEGORY maps all signals to existing AUDIT_CATEGORIES', () => {
  const expectedSignals = ['clarification_density', 'correction_rate', 'dominant_tool_share', 'verification_gap'];
  deepEqual(Object.keys(EFFICIENCY_TO_CATEGORY).sort(), expectedSignals.sort());
  for (const category of Object.values(EFFICIENCY_TO_CATEGORY)) {
    ok(typeof category === 'string' && category.length > 0);
  }
});

test('efficiencyToFindings produces audit-shaped findings from flagged corpus', () => {
  const sessions = [
    makeSession({ clarificationDensity: 0.1, correctionRate: 0.05 }),
    makeSession({ clarificationDensity: 0.8, correctionRate: 0.5, lastToolSequence: ['Write', 'Write', 'Write', 'Write', 'Write'] }),
    makeSession({ clarificationDensity: 0.15, correctionRate: 0.08 }),
    makeSession({ clarificationDensity: 0.2, correctionRate: 0.1 }),
    makeSession({ clarificationDensity: 0.25, correctionRate: 0.12 })
  ];
  const corpus = corpusEfficiency(sessions);
  const findings = efficiencyToFindings(corpus, []);
  ok(findings.length > 0);
  for (const finding of findings) {
    ok(finding.category);
    ok(finding.severity);
    ok(finding.accusation);
    ok(finding.explanation);
    ok(finding.betterAlternative);
    ok(finding.copyablePrompt);
    ok(finding.rootCause);
    deepEqual(finding.quotations, []);
    strictEqual(finding.evidencePosture, 'established_pattern');
  }
});

test('efficiencyToFindings returns empty array when no sessions flagged', () => {
  const sessions = [makeSession({ clarificationDensity: 0.01, correctionRate: 0.01, lastToolSequence: ['test', 'grep', 'diff', 'build', 'lint'] })];
  const corpus = corpusEfficiency(sessions);
  strictEqual(corpus.flagged.length, 0);
  const findings = efficiencyToFindings(corpus, []);
  strictEqual(findings.length, 0);
});

import { test } from 'node:test';
import { strictEqual, deepEqual, ok } from 'node:assert';
import { sessionEfficiency, corpusEfficiency } from '../src/efficiency.mjs';

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
    makeSession({ id: 'a', userMessages: 20, shortUserTurns: 2, correctionTurns: 1 }),
    makeSession({ id: 'b', userMessages: 20, shortUserTurns: 4, correctionTurns: 2 }),
    makeSession({ id: 'c', userMessages: 20, shortUserTurns: 6, correctionTurns: 3 }),
    makeSession({ id: 'd', userMessages: 20, shortUserTurns: 8, correctionTurns: 4 }),
    makeSession({ id: 'e', userMessages: 20, shortUserTurns: 10, correctionTurns: 5 })
  ];
  const corpus = corpusEfficiency(sessions);
  strictEqual(corpus.sessions.length, 5);
  strictEqual(corpus.aggregates.clarificationDensity.mean, 0.3);
  strictEqual(corpus.aggregates.clarificationDensity.median, 0.3);
  strictEqual(corpus.thresholds.clarificationDensityHigh, 0.4);
  deepEqual(corpus.sessions.map((s) => s.sessionId), ['a', 'b', 'c', 'd', 'e']);
});

test('corpusEfficiency flags sessions exceeding thresholds', () => {
  const sessions = [1, 8, 2, 3, 4].map((shortUserTurns, index) => makeSession({
    id: `session-${index}`, shortUserTurns, correctionTurns: 0,
    lastToolSequence: ['test'],
  }));
  const corpus = corpusEfficiency(sessions);
  // Only the actual short-turn outlier should cross the corpus threshold.
  deepEqual(corpus.flagged, [{ index: 1, issues: [{
    signal: 'clarification_density', value: 0.8, threshold: 0.4, severity: 'medium'
  }] }]);
});

test('corpusEfficiency handles empty sessions array', () => {
  const corpus = corpusEfficiency([]);
  strictEqual(corpus.sessions.length, 0);
  strictEqual(corpus.flagged.length, 0);
  strictEqual(corpus.aggregates.clarificationDensity.mean, null);
});

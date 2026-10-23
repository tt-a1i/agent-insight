/**
 * Efficiency signal layer — deterministic, no LLM.
 *
 * Computes per-session and corpus-level efficiency ratios from session
 * metadata. Lives alongside `extensions` on the report object; never enters
 * DETERMINISTIC_FIELDS baseline scoring.
 *
 * Signals:
 *   clarification_density  short recorded user turns / total user turns (legacy key)
 *   correction_rate        correction-like user turns / total user turns
 *   dominant_tool_share    top tool call count / total tool calls
 *   turns_per_hour         (user + assistant turns) / duration hours
 *   verification_gap       last N tool names contain no verification keyword
 */

const VERIFICATION_TOOL_PATTERN = /(?:test|grep|glob|diff|preview|verify|check|lint|build)/i;

const LAST_N_TURNS = 5;

/**
 * @param {object} session — parsed session object (from parse.mjs)
 * @returns {object|null} per-session efficiency metrics, or null if insufficient data
 */
export function sessionEfficiency(session) {
  const userTurns = session.userMessages ?? 0;
  const assistantTurns = session.assistantMessages ?? 0;
  const toolCalls = session.toolCalls ?? 0;
  const toolNames = session.toolNames ?? {};

  // Duration in hours from startedAt/endedAt
  let durationHours = null;
  if (session.startedAt && session.endedAt) {
    const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
    if (Number.isFinite(ms) && ms > 0) durationHours = ms / 3_600_000;
  }

  // Clarification density — needs shortUserTurns counter from parse layer
  const shortUserTurns = session.shortUserTurns ?? null;
  const clarificationDensity = shortUserTurns !== null && userTurns > 0
    ? round(shortUserTurns / userTurns)
    : null;

  // Correction rate — needs correctionTurns counter from parse layer
  const correctionTurns = session.correctionTurns ?? null;
  const correctionRate = correctionTurns !== null && userTurns > 0
    ? round(correctionTurns / userTurns)
    : null;

  // Dominant tool share — derivable from existing toolNames
  let dominantToolShare = null;
  let dominantTool = null;
  if (toolCalls > 0) {
    const entries = Object.entries(toolNames).sort(([, a], [, b]) => b - a);
    if (entries.length > 0) {
      const [name, count] = entries[0];
      dominantTool = name;
      dominantToolShare = round(count / toolCalls);
    }
  }

  // Turns per hour
  const totalTurns = userTurns + assistantTurns;
  const turnsPerHour = durationHours !== null && durationHours > 0
    ? round(totalTurns / durationHours)
    : null;

  // Verification gap — needs lastToolSequence from parse layer
  const lastToolSequence = session.lastToolSequence ?? null;
  let verificationGap = null;
  if (Array.isArray(lastToolSequence) && lastToolSequence.length > 0) {
    const tail = lastToolSequence.slice(-LAST_N_TURNS);
    verificationGap = !tail.some((tool) => VERIFICATION_TOOL_PATTERN.test(tool));
  }

  // Coverage: which signals could be computed
  const coverage = {
    clarificationDensity: clarificationDensity !== null,
    correctionRate: correctionRate !== null,
    dominantToolShare: dominantToolShare !== null,
    turnsPerHour: turnsPerHour !== null,
    verificationGap: verificationGap !== null
  };

  return {
    clarificationDensity,
    correctionRate,
    dominantToolShare,
    dominantTool,
    turnsPerHour,
    verificationGap,
    coverage
  };
}

/**
 * Corpus-level aggregation with relative thresholds.
 * @param {object[]} sessions — parsed session objects
 * @returns {object} corpus efficiency report
 */
export function corpusEfficiency(sessions) {
  const perSession = sessions
    .map((session, index) => ({ index, sessionId: session.id ?? null, source: session.source ?? null, ...sessionEfficiency(session) }));

  if (perSession.length === 0) {
    return {
      sessions: [],
      aggregates: emptyAggregates(),
      thresholds: fixedThresholds(),
      flagged: []
    };
  }

  const aggregates = computeAggregates(perSession);
  const thresholds = deriveThresholds(perSession);
  const flagged = flagSessions(perSession, thresholds);

  return {
    sessions: perSession,
    aggregates,
    thresholds,
    flagged
  };
}

function computeAggregates(perSession) {
  const collect = (key) => perSession.map((s) => s[key]).filter((v) => v !== null);
  const stats = (values) => values.length === 0
    ? { mean: null, median: null, min: null, max: null }
    : {
        mean: round(values.reduce((a, b) => a + b, 0) / values.length),
        median: round(median(values)),
        min: round(Math.min(...values)),
        max: round(Math.max(...values))
      };

  return {
    clarificationDensity: stats(collect('clarificationDensity')),
    correctionRate: stats(collect('correctionRate')),
    dominantToolShare: stats(collect('dominantToolShare')),
    turnsPerHour: stats(collect('turnsPerHour')),
    verificationGapRate: rateVerificationGaps(perSession)
  };
}

function rateVerificationGaps(perSession) {
  const gaps = perSession.filter((s) => s.verificationGap === true).length;
  const total = perSession.filter((s) => s.verificationGap !== null).length;
  return total > 0 ? round(gaps / total) : null;
}

function deriveThresholds(perSession) {
  // Use corpus P75 as the "high" threshold; fall back to fixed heuristics
  const p75 = (key, fixedKey) => {
    const values = perSession.map((s) => s[key]).filter((v) => v !== null).sort((a, b) => a - b);
    if (values.length < 4) return fixedThresholds()[fixedKey];
    return round(values[Math.floor(values.length * 0.75)]);
  };

  return {
    clarificationDensityHigh: p75('clarificationDensity', 'clarificationDensityHigh'),
    correctionRateHigh: p75('correctionRate', 'correctionRateHigh'),
    dominantToolShareHigh: p75('dominantToolShare', 'dominantToolShareHigh'),
    turnsPerHourLow: (() => {
      const values = perSession.map((s) => s.turnsPerHour).filter((v) => v !== null).sort((a, b) => a - b);
      if (values.length < 4) return fixedThresholds().turnsPerHourLow;
      return round(values[Math.floor(values.length * 0.25)]);
    })(),
    verificationGapRateHigh: 0.5
  };
}

function fixedThresholds() {
  return {
    clarificationDensityHigh: 0.30,
    correctionRateHigh: 0.10,
    dominantToolShareHigh: 0.60,
    turnsPerHourLow: 10,
    verificationGapRateHigh: 0.50
  };
}

function flagSessions(perSession, thresholds) {
  const flagged = [];
  for (const entry of perSession) {
    const issues = [];
    if (entry.clarificationDensity !== null && entry.clarificationDensity > thresholds.clarificationDensityHigh) {
      issues.push({ signal: 'clarification_density', value: entry.clarificationDensity, threshold: thresholds.clarificationDensityHigh, severity: 'medium' });
    }
    if (entry.correctionRate !== null && entry.correctionRate > thresholds.correctionRateHigh) {
      issues.push({ signal: 'correction_rate', value: entry.correctionRate, threshold: thresholds.correctionRateHigh, severity: 'high' });
    }
    if (entry.dominantToolShare !== null && entry.dominantToolShare > thresholds.dominantToolShareHigh) {
      issues.push({ signal: 'dominant_tool_share', value: entry.dominantToolShare, threshold: thresholds.dominantToolShareHigh, severity: 'low' });
    }
    if (entry.turnsPerHour !== null && entry.turnsPerHour < thresholds.turnsPerHourLow) {
      issues.push({ signal: 'turns_per_hour', value: entry.turnsPerHour, threshold: thresholds.turnsPerHourLow, severity: 'low' });
    }
    if (entry.verificationGap === true) {
      issues.push({ signal: 'verification_gap', value: true, threshold: false, severity: 'high' });
    }
    if (issues.length > 0) {
      flagged.push({ index: entry.index, issues });
    }
  }
  return flagged;
}

function emptyAggregates() {
  return {
    clarificationDensity: { mean: null, median: null, min: null, max: null },
    correctionRate: { mean: null, median: null, min: null, max: null },
    dominantToolShare: { mean: null, median: null, min: null, max: null },
    turnsPerHour: { mean: null, median: null, min: null, max: null },
    verificationGapRate: null
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

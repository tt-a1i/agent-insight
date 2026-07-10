const HOSTS = ['claude', 'codex', 'cursor', 'opencode', 'pi'];

function requireHost(host) {
  const normalized = String(host ?? '').trim().toLowerCase();
  if (!HOSTS.includes(normalized)) {
    throw new Error(`A supported host is required: ${HOSTS.join(', ')}`);
  }
  return normalized;
}

function requireDate(value, label) {
  const date = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  return date;
}

/** Resolve the two choices every insights invocation must make. */
export async function resolveInsightRequest({ host, fast = false } = {}, { ask } = {}) {
  if (typeof ask !== 'function') throw new Error('Interactive insights requires an ask(question) function.');
  const resolvedHost = requireHost(host);
  const scopeAnswer = String(await ask('Analyze current agent, all agents, or select agents? [current] ')).trim().toLowerCase() || 'current';
  if (!['current', 'all', 'select'].includes(scopeAnswer)) throw new Error('Choose current, all, or select.');
  let sources;
  if (scopeAnswer === 'select') {
    const selected = String(await ask(`Select agents (${HOSTS.join(', ')}): `)).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
    const invalid = selected.filter((source) => !HOSTS.includes(source));
    if (selected.length === 0 || invalid.length > 0) throw new Error(`Select one or more supported agents: ${HOSTS.join(', ')}`);
    sources = [...new Set(selected)];
  } else {
    sources = scopeAnswer === 'all' ? [...HOSTS] : [resolvedHost];
  }
  const rangeAnswer = String(await ask('Time range: 7, 30, 90, all, or custom? [30] ')).trim().toLowerCase() || '30';
  if (!['7', '30', '90', 'all', 'custom'].includes(rangeAnswer)) throw new Error('Choose 7, 30, 90, all, or custom.');
  const start = rangeAnswer === 'custom' ? requireDate(await ask('Start date (YYYY-MM-DD): '), 'Start date') : null;
  const end = rangeAnswer === 'custom' ? requireDate(await ask('End date (YYYY-MM-DD): '), 'End date') : null;
  if (start && end && start > end) throw new Error('Start date must not be after end date.');
  return {
    host: resolvedHost,
    sources,
    scope: scopeAnswer,
    days: rangeAnswer === 'all' ? Infinity : rangeAnswer === 'custom' ? null : Number(rangeAnswer),
    start,
    end,
    semantic: true,
    fast: Boolean(fast)
  };
}

export { HOSTS };

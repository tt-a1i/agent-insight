import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSessions } from '../src/analyze.mjs';
import { renderHtml, renderMarkdown } from '../src/report.mjs';
import { validateSessionAuditResult, validateAuditAggregateResult } from '../src/audit-protocol.mjs';

const quote = 'Please fix the export. I have not specified the acceptance check yet.';
const session = (id, sessionId, source, metrics) => ({ id, sessionId, source, date: '2026-10-23', ...metrics });
function report(sessions, ids, { locale = 'en', host = 'codex', count = 1 } = {}) {
  const audited = sessions.map((source) => ({ ...source, ...validateSessionAuditResult({ findings: [] }, { opaqueId: source.id, sessionId: source.sessionId, messages: [{ index: 1, role: 'user', text: quote }] }) }));
  const aggregate = validateAuditAggregateResult({ top_three: [{ category: 'acceptance_criteria', severity: 'low', evidence_posture: 'observed_instance', accusation: 'Acceptance checks were not specified.', explanation: 'The requests explicitly acknowledge the omission.', quotations: [quote], locators: ids.map((id) => ({ session_id: id, message_indexes: [1] })), better_alternative: 'State an observable check.', root_cause: 'omitted acceptance check' }], remaining: [], strengths: [], self_defeating_patterns: [], highest_leverage_change: null, automation_candidates: [] }, { sessions: audited });
  return summarizeSessions([], { locale, semantic: { analyzer: { host, model: 'test' }, sessions, sections: { project_areas: { areas: [{ name: 'Parser', description: 'Parser work.', sessionCount: count, evidenceSessionIds: ids }] } } }, extensions: { userAudit: { status: 'complete', aggregate } } });
}
const card = (value) => renderHtml(value).match(/<article class="prose-card audit-finding"[\s\S]*?<\/article>/)[0];

test('finding context resolves canonical identity before native aliases and deduplicates legacy references', () => {
  const sessions = [session('a', 'native-a', 'codex', { userMessages: 2, toolErrors: 0, durationMinutes: 5 }), session('b', 'a', 'pi', { userMessages: 90, toolErrors: 7, durationMinutes: 120 })];
  const value = report(sessions, ['a']);
  assert.match(card(value), /1 resolved session · 2 user turns · 0 tool errors · ~5 min/);
  assert.doesNotMatch(card(value), /92 user turns|125 min|2 resolved sessions/);
  value.extensions.userAudit.aggregate.topThree[0].locators.push({ sessionId: 'native-a', messageIndexes: [1] });
  assert.match(card(value), /1 resolved session · 2 user turns/);
});

test('finding context distinguishes missing, partial, explicit zero and invalid numeric records', () => {
  const known = session('a', 'a-native', 'codex', { userMessages: 2, toolErrors: 0, durationMinutes: 5 });
  const missing = session('b', 'b-native', 'pi', { userMessages: null, toolErrors: null, durationMinutes: null });
  const unknown = card(report([missing], ['b']));
  assert.match(unknown, /user turns unknown · tool errors unknown · duration unknown/);
  assert.doesNotMatch(unknown, /0 user turns|0 tool errors|~0 min/);
  const partial = card(report([known, missing], ['a', 'b']));
  assert.match(partial, /2 user turns \(1\/2 resolved sessions recorded\)/);
  assert.match(partial, /0 tool errors \(1\/2 resolved sessions recorded\)/);
  assert.match(partial, /~5 min \(1\/2 resolved sessions recorded\)/);
  const zero = session('z', 'zero', 'claude', { userMessages: 0, toolErrors: 0, durationMinutes: 0 });
  assert.match(card(report([zero], ['z'])), /0 user turns · 0 tool errors · ~0 min/);
  for (const invalid of [NaN, Infinity, -1, '0', []]) {
    const bad = session('bad', 'bad-native', 'codex', { userMessages: invalid, toolErrors: invalid, durationMinutes: invalid });
    assert.match(card(report([bad], ['bad'])), /user turns unknown · tool errors unknown · duration unknown/);
  }
});

test('ambiguous or missing legacy references do not borrow another session metrics', () => {
  const value = report([session('a', 'shared', 'codex', { userMessages: 2 }), session('b', 'shared', 'pi', { userMessages: 90 })], ['a']);
  value.extensions.userAudit.aggregate.topThree[0].locators = [{ sessionId: 'shared', messageIndexes: [1] }, { sessionId: 'missing', messageIndexes: [1] }];
  assert.match(card(value), /0 resolved sessions · 2 unresolved session references · user turns unknown/);
  assert.doesNotMatch(card(value), /92 user turns|90 user turns|2 user turns/);
});

test('duration fallback requires valid ordered timestamps and preserves an observed zero interval', () => {
  const source = session('a', 'native', 'codex', { userMessages: 2, toolErrors: 0, startedAt: '2026-10-23T01:00:00Z', endedAt: '2026-10-23T01:05:00Z' });
  assert.match(card(report([source], ['a'])), /~5 min/);
  assert.match(card(report([{ ...source, endedAt: source.startedAt }], ['a'])), /~0 min/);
  for (const endedAt of ['invalid', '2026-10-23T00:59:00Z', null]) assert.match(card(report([{ ...source, endedAt }], ['a'])), /duration unknown/);
});

test('HTML and Markdown label area counts as model estimates in both locales and Claude profile', () => {
  const source = session('a', 'native', 'codex', { userMessages: 2, toolErrors: 0 });
  for (const locale of ['en', 'zh']) for (const host of ['codex', 'claude']) {
    const value = report([source], ['a'], { locale, host });
    const html = renderHtml(value), markdown = renderMarkdown(value);
    assert.match(html, locale === 'zh' && host !== 'claude' ? /模型估计：1 个会话/ : /Model estimate: 1 sessions/);
    assert.match(markdown.replace(/\\([()])/g, '$1'), locale === 'zh' ? /估计会话数（模型归类）/ : /Estimated sessions \(model grouping\)/);
    assert.match(markdown, locale === 'zh' ? /并非完整的归类清单/ : /not a complete membership list/);
    value.semantic.sections.project_areas.areas[0].sessionCount = null;
    assert.match(renderHtml(value), locale === 'zh' && host !== 'claude' ? /估计会话数：未知/ : /Estimated session count: unknown/);
    assert.match(renderMarkdown(value), locale === 'zh' ? /未知/ : /Unknown/);
  }
});

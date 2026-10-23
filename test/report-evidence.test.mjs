import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSessions } from '../src/analyze.mjs';
import { buildEvidenceIndex } from '../src/report-evidence.mjs';
import { renderHtml, renderMarkdown } from '../src/report.mjs';

function fixture(locale = 'zh') {
  const semantic = {
    analyzer: { host: 'codex', model: 'fixture' },
    sessions: [
      { id: 'canonical-a', sessionId: 'same-native', source: 'claude', projectPath: '/project-a', transcriptPath: '/a.jsonl' },
      { id: 'canonical-b', sessionId: 'same-native', source: 'pi', projectPath: '/project-b', transcriptPath: '/b.jsonl' }
    ],
    sections: {
      at_a_glance: { whatsWorking: 'A clear boundary.', whatsHindering: 'Execution failed.', quickWins: 'Keep the boundary.', ambitiousWorkflows: 'No expansion.', evidenceSessionIds: ['canonical-b'] },
      project_areas: { areas: [{ name: 'Conclusion B', description: 'A scoped conclusion.', sessionCount: 1, evidenceSessionIds: ['canonical-b'] }] },
      interaction_style: { narrative: 'Interaction summary.', keyPattern: 'Keep evidence.', evidenceSessionIds: ['canonical-b'] },
      friction_analysis: { intro: 'A bounded observation.', categories: [] }
    }
  };
  const report = summarizeSessions([], { locale, semantic });
  report.parity.evidenceContext = { sessions: [
    { id: 'canonical-a', sessionId: 'same-native', source: 'claude', grounding: [{ messageIndexes: [5], description: 'Source A evidence.', quotation: 'Quote A' }] },
    { id: 'canonical-b', sessionId: 'same-native', source: 'pi', grounding: [
      { messageIndexes: [4], description: 'A structured failed execution; the cause is unconfirmed.', quotation: null },
      { messageIndexes: [5], description: 'A user boundary.', quotation: 'Quote B' }
    ] }
  ] };
  report.extensions = { userAudit: { status: 'complete', aggregate: { highestLeverageChange: null, topThree: [], remaining: [], selfDefeatingPatterns: [], automationCandidates: [], strengths: [{ habit: 'Keep this boundary', explanation: 'A concrete user request.', quotations: ['Quote B'], locators: [{ sessionId: 'canonical-b', messageIndexes: [5] }] }] } } };
  return report;
}

function assertNavigation(html, markdown) {
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const mdIds = [...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map((match) => match[1]);
  assert.equal(new Set(htmlIds).size, htmlIds.length, 'HTML anchors must be unique');
  assert.equal(new Set(mdIds).size, mdIds.length, 'Markdown anchors must be unique');
  for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) assert.ok(htmlIds.includes(target), `missing HTML target ${target}`);
  for (const [, target] of markdown.matchAll(/\]\(#([^\)]+)\)/g)) assert.ok(mdIds.includes(target), `missing Markdown target ${target}`);
}

test('baseline session links and exact audit links reach the same canonical evidence in both formats', () => {
  for (const locale of ['zh', 'en']) {
    const report = fixture(locale), index = buildEvidenceIndex(report);
    const b = index.resolve('canonical-b').entry;
    const sessionTarget = index.anchor(b), messageTarget = index.groundingAnchor(b, 1);
    const before = JSON.stringify(report);
    const html = renderHtml(report), md = renderMarkdown(report);
    assertNavigation(html, md);
    assert.match(html, new RegExp(`href="#${sessionTarget}">same-native · pi`));
    assert.ok(md.includes(`](#${sessionTarget})`));
    const glance = html.slice(html.indexOf('<h2>'), html.indexOf('<nav class="toc"'));
    assert.ok(glance.includes(`href="#${sessionTarget}"`), 'At a Glance must show its evidence reference');
    assert.ok(html.includes(`href="#${messageTarget}"`), 'exact audit evidence must link to the matched quotation');
    assert.ok(md.includes(`](#${messageTarget})`));
    const group = html.slice(html.indexOf(`id="${sessionTarget}"`));
    assert.match(group, /A structured failed execution; the cause is unconfirmed/);
    assert.doesNotMatch(group, /<blockquote>A structured failed execution/);
    assert.match(group, /<blockquote>Quote B<\/blockquote>/);
    assert.ok(html.includes(locale === 'zh' ? '不是原始 JSONL 行号' : 'not raw JSONL line numbers'));
    assert.equal(JSON.stringify(report), before, 'navigation must not alter the semantic report');
  }
});

test('canonical ids win over native aliases; ambiguous or missing references never guess a source', () => {
  const report = fixture();
  let index = buildEvidenceIndex(report);
  assert.equal(index.resolve('same-native').status, 'ambiguous');
  assert.equal(index.resolve('unknown-session').status, 'missing');
  report.semantic.sections.interaction_style.evidenceSessionIds = ['same-native', 'unknown-session'];
  report.semantic.sections.at_a_glance.evidenceSessionIds = [];
  const html = renderHtml(report), md = renderMarkdown(report);
  for (const output of [html, md]) {
    assert.match(output, /会话标识不唯一/);
    assert.match(output, /未找到对应会话/);
    assert.match(output, /未提供支持本条结论的会话引用/);
  }
  assertNavigation(html, md);
  report.semantic.sessions[0].sessionId = 'canonical-b';
  index = buildEvidenceIndex(report);
  assert.equal(index.resolve('canonical-b').entry.session.source, 'pi');
});

test('missing grounding and mismatched audit quotations keep honest nonlinked locators', () => {
  const report = fixture();
  report.parity.evidenceContext.sessions[1].grounding = [];
  const html = renderHtml(report), md = renderMarkdown(report);
  assertNavigation(html, md);
  for (const output of [html, md]) assert.match(output, /已定位会话，但未提供可展示的消息级证据/);
  const index = buildEvidenceIndex(report);
  assert.equal(index.auditTarget({ sessionId: 'canonical-b', messageIndexes: [5] }, ['Quote B']), null);
  report.parity.evidenceContext.sessions[1].grounding = [{ messageIndexes: [5], quotation: 'Different text', description: 'A different statement.' }];
  const next = buildEvidenceIndex(report);
  assert.equal(next.auditTarget({ sessionId: 'canonical-b', messageIndexes: [5] }, ['Quote B']), null);
  assert.equal(next.auditTarget({ sessionId: 'same-native', messageIndexes: [5] }, ['Different text']), null);
});

test('failed missing sections have explicit placeholders, distinct from completed zero findings', () => {
  for (const locale of ['zh', 'en']) {
    const report = fixture(locale);
    let html = renderHtml(report), md = renderMarkdown(report);
    assert.ok(html.includes(locale === 'zh' ? '已完成分析，本节没有证据支持的条目' : 'Analysis completed; no evidence-backed items'));
    delete report.semantic.sections.friction_analysis;
    delete report.semantic.sections.at_a_glance;
    report.coverage.sectionFailures = { friction_analysis: { reason: 'analyzer_failure', taskId: 'aggregate:friction_analysis' }, at_a_glance: { reason: 'safety_limit', taskId: 'aggregate:at_a_glance' } };
    report.extensions.userAudit = { status: 'incomplete', failure: { reason: 'analyzer_failure' } };
    html = renderHtml(report); md = renderMarkdown(report);
    for (const output of [html, md]) {
      assert.ok(output.includes(locale === 'zh' ? '本节分析未完成，结论不可用（analyzer_failure）' : 'This section is unavailable because its analysis did not complete (analyzer_failure)') || output.includes(locale === 'zh' ? '本节分析未完成，结论不可用（analyzer\\_failure）' : 'This section is unavailable because its analysis did not complete \\(analyzer\\_failure\\)'));
      assert.ok(output.includes(locale === 'zh' ? '问题出在哪' : 'Where Things Go Wrong'));
      assert.ok(output.includes(locale === 'zh' ? '一瞥' : 'At a Glance'));
    }
    assert.doesNotMatch(html, /id="coach-primary-action"|href="#coach-primary-action"/);
    assert.doesNotMatch(md, /## 这次只改这一件|## This run’s one change/);
    assertNavigation(html, md);
  }
});

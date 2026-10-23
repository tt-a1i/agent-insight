import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeSessions } from '../src/analyze.mjs';
import { renderHtml, renderMarkdown } from '../src/report.mjs';

function fixture(locale = 'zh', host = 'codex') {
  const report = summarizeSessions([], { locale });
  report.semantic.analyzer = { host, model: 'fixture' };
  report.coverage.requestedDays = 30;
  report.coverage.selectedAt = '2026-07-01T12:30:00.000Z';
  report.generatedAt = '2035-12-31T23:59:59.000Z';
  report.dateRange = { start: '2026-05-01', end: '2026-06-28' };
  return report;
}
const readable = (markdown) => markdown.replace(/\\([\\`*_{}\[\]<>()#+\-.!|])/g, '$1');
const coverageHtml = (report) => {
  const html = renderHtml(report);
  return html.slice(html.indexOf('class="muted time-scope"'), html.indexOf('</p>', html.indexOf('class="muted time-scope"')));
};

test('rolling scope uses the recorded selection anchor, distinct from actual session dates and later generation time', () => {
  for (const [locale, host] of [['zh', 'codex'], ['en', 'codex'], ['zh', 'claude']]) {
    const report = fixture(locale, host), before = JSON.stringify(report);
    const html = coverageHtml(report), md = readable(renderMarkdown(report));
    for (const output of [html, md]) {
      assert.ok(output.includes('2026-06-01T12:30:00.000Z'));
      assert.ok(output.includes('2026-07-01T12:30:00.000Z'));
      assert.ok(output.includes('2026-05-01'));
      assert.ok(output.includes('2026-06-28'));
      assert.doesNotMatch(output, /2035-12-31/);
    }
    assert.ok(html.includes(locale === 'zh' && host !== 'claude' ? '按会话最后记录时间' : 'selected by their last recorded activity'));
    assert.ok(md.includes(locale === 'zh' ? '不按消息时间裁剪' : 'without filtering individual messages by time'));
    assert.ok(md.includes(locale === 'zh' ? '请求时间范围' : 'Requested time range'));
    assert.ok(html.includes(host === 'claude' || locale === 'en' ? 'session start dates' : '会话开始日期'));
    assert.equal(JSON.stringify(report), before);
  }
});

test('all-history and unknown legacy anchors never borrow generatedAt or invent exact cutoffs', () => {
  for (const locale of ['zh', 'en']) {
    const report = fixture(locale);
    report.coverage.requestedDays = 'all available';
    for (const output of [coverageHtml(report), readable(renderMarkdown(report))]) assert.ok(output.includes('through 2026-07-01T12:30:00.000Z') || output.includes('截至 2026-07-01T12:30:00.000Z'));
    for (const selectedAt of [null, undefined, 'invalid timestamp']) {
      report.coverage.selectedAt = selectedAt;
      for (const days of ['all available', 30]) {
        report.coverage.requestedDays = days;
        for (const output of [coverageHtml(report), readable(renderMarkdown(report))]) {
          assert.ok(output.includes(locale === 'zh' ? '筛选时点未记录' : 'selection time was not recorded'));
          assert.doesNotMatch(output, /2026-07-01T|2026-06-01T|2035-12-31/);
        }
      }
    }
  }
});

test('custom ranges describe inclusive UTC calendar days in the chosen prose locale', () => {
  for (const [locale, host] of [['zh', 'codex'], ['en', 'codex'], ['zh', 'claude']]) {
    const report = fixture(locale, host);
    report.coverage.requestedDays = null;
    report.coverage.requestedRange = { start: '2026-06-01', end: '2026-06-30' };
    const html = coverageHtml(report), md = readable(renderMarkdown(report));
    assert.ok(html.includes(host === 'claude' || locale === 'en' ? '2026-06-01 to 2026-06-30 (UTC, both full calendar days)' : '2026-06-01 至 2026-06-30（UTC，起止日期整日）'));
    assert.ok(md.includes(locale === 'zh' ? '2026-06-01 至 2026-06-30（UTC，起止日期整日）' : '2026-06-01 to 2026-06-30 (UTC, both full calendar days)'));
    assert.doesNotMatch(md, /null-day|null 天/);
  }
});

test('dates are escaped at the report boundary and never become injected markup', () => {
  const report = fixture();
  report.coverage.requestedRange = { start: '<script>bad</script>', end: '[date](https://example.invalid)' };
  report.dateRange = { start: '<img src=x>', end: '<bad>' };
  const html = coverageHtml(report), md = renderMarkdown(report);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.doesNotMatch(html, /<script>|<img src=x>/);
  assert.ok(md.includes('\\<script\\>'));
  assert.ok(md.includes('\\[date\\]\\(https://example\\.invalid\\)'));
  assert.ok(md.includes('\\<img src=x\\>'));
});

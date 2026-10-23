import assert from 'node:assert/strict';
import test from 'node:test';
import { taxonomyLabel } from '../src/i18n.mjs';
import { summarizeSessions } from '../src/analyze.mjs';
import { renderHtml, renderMarkdown, renderAgentPrompt, buildCoachSummary } from '../src/report.mjs';

function reportFixture(locale = 'zh', host = 'codex') {
  const evidence = { quotations: ['Only fix the failing case.'], locators: [{ sessionId: 'session-one', messageIndexes: [42] }] };
  const report = summarizeSessions([], { locale });
  report.semantic = {
    analyzer: { host, model: 'current' },
    sessions: [{ id: 'internal-one', sessionId: 'session-one', source: 'codex', date: '2026-10-22', projectPath: '/work/example', transcriptPath: '/tmp/example.jsonl' }],
    sections: {
      at_a_glance: { whatsWorking: 'Focused verification.', quickWins: 'Fallback quick win.', evidenceSessionIds: ['internal-one'] },
      project_areas: { areas: [{ name: 'Project scope', description: 'Scoped parser work.', sessionCount: 1, evidenceSessionIds: ['internal-one'] }] },
      interaction_style: { narrative: 'Interaction narrative.', keyPattern: 'A named gate.', evidenceSessionIds: ['internal-one'] },
      what_works: { intro: 'Working intro.', impressiveWorkflows: [{ title: 'A workflow', description: 'Workflow detail.', evidenceSessionIds: ['internal-one'] }] },
      friction_analysis: { intro: 'Friction intro.', categories: [{ category: 'Retries', description: 'Retry detail.', examples: [{ text: 'A retry example.', evidenceSessionIds: ['internal-one'] }] }] },
      suggestions: { instructionAdditions: [{ addition: 'Instruction addition.', why: 'Why addition.', promptScaffold: '## Testing\nRun the exact test.', evidenceSessionIds: ['internal-one'] }], featuresToTry: [{ feature: 'A feature', oneLiner: 'Feature purpose.', whyForYou: 'Feature reason.', exampleCode: 'run --exact', evidenceSessionIds: ['internal-one'] }], usagePatterns: [{ title: 'A pattern', suggestion: 'Pattern suggestion.', detail: 'Pattern detail.', copyablePrompt: 'Copy the pattern.', evidenceSessionIds: ['internal-one'] }] },
      on_the_horizon: { intro: 'Horizon intro.', opportunities: [{ title: 'An opportunity', whatsPossible: 'Opportunity possibility.', howToTry: 'Opportunity instructions.', copyablePrompt: 'Copy the opportunity.', evidenceSessionIds: ['internal-one'] }] },
      fun_ending: { headline: 'Ending headline.', detail: 'Ending detail.', evidenceSessionIds: ['internal-one'] }
    }
  };
  const finding = { category: 'scope', severity: 'high', evidencePosture: 'bold_inference', accusation: 'A bounded finding.', explanation: 'Finding explanation.', betterAlternative: 'A better action.', ...evidence };
  report.extensions = { userAudit: { status: 'complete', aggregate: {
    topThree: [finding], remaining: [{ ...finding, accusation: 'Another finding.' }],
    strengths: [{ habit: 'A useful habit.', explanation: 'Strength explanation.', ...evidence }],
    selfDefeatingPatterns: [{ pattern: 'A recurring pattern.', intent: 'Move quickly.', explanation: 'Pattern explanation.', ...evidence }],
    highestLeverageChange: { change: 'One supported change.', rationale: 'Change rationale.', copyablePrompt: 'Keep `literal` syntax.\n## Read coverage\nDo the check.', ...evidence },
    automationCandidates: [{ type: 'Skill', name: 'Gate helper', frequency: 'recurring', occurrenceCount: 2, trigger: 'When fixing', inputs: ['A case'], outputs: ['A result'], rationale: 'Repeated real behavior.', overAutomationRisk: 'Keep manual judgment.', draftBody: '# Helper\n\n```sh\nrun --exact\n```', ...evidence }]
  } } };
  report.parity.evidenceContext = { sessions: [{ id: 'internal-one', sessionId: 'session-one', source: 'codex', date: '2026-10-22', grounding: [{ quotation: 'Baseline exact quotation.', messageIndexes: [17], sessionId: 'session-one' }] }] };
  return report;
}

test('Markdown preserves semantic baseline, audit reasoning, quotations, locators and literal executable drafts', () => {
  const report = reportFixture();
  const markdown = renderMarkdown(report);
  for (const marker of ['Focused verification', 'Scoped parser work', 'Interaction narrative', 'Workflow detail', 'Retry detail', 'Instruction addition', 'Feature reason', 'Pattern suggestion', 'Opportunity instructions', 'Ending detail', 'Finding explanation', 'Another finding', 'A better action', 'Strength explanation', 'Pattern explanation', 'Change rationale', 'Repeated real behavior', 'Keep manual judgment', 'Only fix the failing case', 'session\\-one', '消息 42', '消息 17']) {
    assert.ok(markdown.includes(marker), `missing ${marker}`);
  }
  assert.ok(markdown.includes('/tmp/example\\.jsonl'));
  assert.ok(markdown.includes('Keep `literal` syntax.\n## Read coverage\nDo the check.'));
  assert.ok(markdown.includes('````\n# Helper\n\n```sh\nrun --exact\n```\n````'));
  assert.doesNotMatch(markdown, /Turn recurring guidance into durable context/);
  const html = renderHtml(report);
  assert.match(html, /Baseline exact quotation\.<\/blockquote><p class="evidence">[^<]*消息 17/);
  assert.match(html, /Change rationale\.<\/p><blockquote>Only fix the failing case\./);
  assert.match(html, /Gate helper[\s\S]*Only fix the failing case\./);
});

test('a completed audit with no supported change never promotes an unrelated quick win', () => {
  const report = reportFixture();
  report.extensions.userAudit.aggregate.highestLeverageChange = null;
  assert.equal(buildCoachSummary(report), null);
  const html = renderHtml(report), markdown = renderMarkdown(report), prompt = renderAgentPrompt(report);
  assert.doesNotMatch(html, /id="coach-primary-action"/);
  assert.doesNotMatch(markdown, /## 这次只改这一件/);
  assert.doesNotMatch(prompt, /One change: Fallback quick win/);
  assert.match(markdown, /当前没有证据支持额外改动/);
  assert.match(html, /当前没有证据支持额外改动/);
  assert.match(prompt, /do not manufacture advice/);
});

test('Markdown and narrative language follow locale independently of the Claude HTML compatibility shell', () => {
  for (const locale of ['zh', 'en']) {
    const report = reportFixture(locale, 'claude');
    const markdown = renderMarkdown(report), prompt = renderAgentPrompt(report);
    assert.match(renderHtml(report), /<html lang="en">/);
    assert.ok(markdown.includes(locale === 'zh' ? '## 读取覆盖' : '## Read coverage'));
    assert.ok(markdown.includes(locale === 'zh' ? '## 值得保留的习惯' : '## Habits worth keeping'));
    assert.ok(prompt.includes(locale === 'zh' ? 'Simplified Chinese (简体中文)' : 'review in English'));
    assert.match(prompt, /Examine the quotations and message locators/);
    assert.match(prompt, /do not copy accusations as established facts/);
  }
});

test('completed zero findings are distinct from unavailable analysis and use count-neutral headings', () => {
  const report = reportFixture();
  report.semantic.sections.friction_analysis.categories = [];
  report.semantic.sections.suggestions = { instructionAdditions: [], featuresToTry: [], usagePatterns: [] };
  report.semantic.sections.on_the_horizon.opportunities = [];
  const audit = report.extensions.userAudit.aggregate;
  audit.topThree = [];
  audit.remaining = [];
  audit.selfDefeatingPatterns = [];
  audit.automationCandidates = [];
  audit.highestLeverageChange = null;
  const markdown = renderMarkdown(report), html = renderHtml(report);
  for (const output of [markdown, html]) {
    assert.match(output, /已完成分析，本节没有证据支持的条目/);
    assert.match(output, /优先关注的发现/);
    assert.doesNotMatch(output, /三条硬事实|当前覆盖下此章节不可用/);
    assert.match(output, /当前没有证据支持额外改动/);
  }
  report.extensions.userAudit = { status: 'incomplete', failure: { reason: 'analyzer_failure' } };
  assert.match(renderMarkdown(report), /用户审计扩展不完整/);
});

test('Markdown uses report reading order, descriptive item headings and readable metadata', () => {
  const report = reportFixture();
  // Analysis execution order intentionally differs from reading order.
  const glance = report.semantic.sections.at_a_glance;
  delete report.semantic.sections.at_a_glance;
  report.semantic.sections.at_a_glance = glance;
  report.coverage.requestedDays = 'all available';
  report.insights.goalCategories = { understand_codebase: 1 };
  report.insights.sessionTypes = { exploration: 1 };
  const markdown = renderMarkdown(report);
  assert.ok(markdown.indexOf('## 一瞥') < markdown.indexOf('## 你在做什么'));
  assert.match(markdown, /### Project scope/);
  assert.match(markdown, /### A useful habit/);
  assert.doesNotMatch(markdown, /### 你在做什么|#{3,6} \d+\n|understand\\_codebase|\*\*overlapEvents/);
  assert.match(markdown, /理解代码: 1/);
  assert.match(markdown, /探索: 1/);
  assert.match(markdown, /### 语言\n\n暂无数据/);
  assert.match(markdown, /全部可用的本地历史/);
});

test('every HTML navigation link has a target even when the audit prescribes no change', () => {
  const report = reportFixture();
  report.extensions.userAudit.aggregate.highestLeverageChange = null;
  const html = renderHtml(report);
  const links = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
  for (const id of links) assert.ok(html.includes(`id="${id}"`), `missing target ${id}`);
  assert.doesNotMatch(html, /href="#coach-primary-action"/);
});

test('Markdown labels have one colon and baseline quotations use the canonical source session', () => {
  const report = reportFixture();
  report.semantic.sessions = [
    { id: 'canonical-a', sessionId: 'same-native-id', source: 'claude', projectPath: '/project-a', transcriptPath: '/a.jsonl' },
    { id: 'canonical-b', sessionId: 'same-native-id', source: 'codex', projectPath: '/project-b', transcriptPath: '/b.jsonl' }
  ];
  report.parity.evidenceContext = { sessions: [{ id: 'canonical-b', sessionId: 'same-native-id', source: 'codex', grounding: [{ quotation: 'Quotation from B', sessionId: 'same-native-id', messageIndexes: [7] }] }] };
  const markdown = renderMarkdown(report);
  assert.doesNotMatch(markdown, /：:\*\*/);
  const quoteBlock = markdown.slice(markdown.indexOf('> Quotation from B'));
  assert.match(quoteBlock, /codex · \/project\\-b · 消息 7/);
  assert.match(quoteBlock, /\/b\\.jsonl/);
  assert.doesNotMatch(quoteBlock, /project\\-a|\/a\\.jsonl/);
});

test('the evidence index retains structured execution descriptions without manufacturing quotations', () => {
  const report = reportFixture();
  report.semantic.sessions = [
    { id: 'canonical-a', sessionId: 'same-native-id', source: 'claude', projectPath: '/project-a', transcriptPath: '/a.jsonl' },
    { id: 'canonical-b', sessionId: 'same-native-id', source: 'codex', projectPath: '/project-b', transcriptPath: '/b.jsonl' }
  ];
  report.parity.evidenceContext = { sessions: [{ id: 'canonical-b', sessionId: 'same-native-id', source: 'codex', grounding: [
    { description: 'Structured execution record: failed.', messageIndexes: [4], quotation: null, sessionId: 'same-native-id' },
    { description: 'Assistant self-report, not verified execution success.', messageIndexes: [5], quotation: 'All tests passed.', sessionId: 'same-native-id' }
  ] }] };
  const html = renderHtml(report);
  const index = html.slice(html.indexOf('<section id="evidence-index"'), html.indexOf('</section>', html.indexOf('<section id="evidence-index"')));
  assert.match(index, /Structured execution record: failed\./);
  assert.match(index, /Assistant self-report, not verified execution success\./);
  assert.equal([...index.matchAll(/<blockquote>/g)].length, 1);
  assert.match(index, /<blockquote>All tests passed\.<\/blockquote>/);
  assert.match(index, /codex · \/project-b · 消息 4 · 回开： \/b\.jsonl/);
  assert.match(index, /codex · \/project-b · 消息 5 · 回开： \/b\.jsonl/);
  const markdown = renderMarkdown(report);
  const mdIndex = markdown.slice(markdown.indexOf('## 证据索引'), markdown.indexOf('## 样本计数'));
  assert.match(mdIndex, /\*\*证据说明:\*\* Structured execution record: failed/);
  assert.match(mdIndex, /Assistant self\\-report, not verified execution success/);
  assert.equal([...mdIndex.matchAll(/^> /gm)].length, 1);
  assert.match(mdIndex, /^> All tests passed\\\./m);
  assert.match(mdIndex, /codex · \/project\\-b · 消息 4 · 回开： \/b\\.jsonl/);
  assert.match(mdIndex, /codex · \/project\\-b · 消息 5 · 回开： \/b\\.jsonl/);
});

test('taxonomy labels are scoped, shared by HTML and Markdown, and retain canonical report data', () => {
  for (const [locale, host] of [['zh', 'codex'], ['en', 'codex'], ['zh', 'claude']]) {
    const report = reportFixture(locale, host);
    const finding = report.extensions.userAudit.aggregate.topThree[0];
    Object.assign(finding, { category: 'fragmented_requirements', severity: 'medium', evidencePosture: 'established_pattern' });
    report.insights.outcomes = { not_achieved: 1 };
    report.insights.goalCategories = { understand_codebase: 1 };
    report.insights.toolCounts = { not_achieved: 2, fragmented_requirements: 1 };
    report.semantic.sections.project_areas.areas[0].name = 'not_achieved';
    report.parity.structuralStatus = 'complete';
    report.parity.dataStatus = 'partial';
    const original = JSON.stringify(report);
    const html = renderHtml(report), md = renderMarkdown(report);
    const htmlZh = locale === 'zh' && host !== 'claude';
    assert.ok(html.includes(htmlZh ? '需求碎片化 · 中 · 有重复证据的模式' : 'fragmented requirements · medium · established pattern'));
    assert.ok(html.includes(htmlZh ? '<span>未达成</span>' : '<span>not achieved</span>'));
    assert.ok(html.includes(htmlZh ? '<span>理解代码</span>' : '<span>understand codebase</span>'));
    assert.match(html, /<span>not_achieved<\/span>/, 'tool name must stay literal');
    assert.match(html, /<h3>not_achieved<\/h3>/, 'project name must stay literal');
    assert.match(html, /data-severity="medium" data-posture="established_pattern"/);
    assert.ok(md.includes(locale === 'zh' ? '需求碎片化' : 'fragmented requirements'));
    assert.ok(md.includes(locale === 'zh' ? '未达成: 1' : 'not achieved: 1'));
    assert.ok(md.includes('### not\\_achieved'), 'Markdown project name must stay literal');
    if (htmlZh) {
      assert.match(html, />结构覆盖：完整 · 数据覆盖：部分<\/span>/);
      assert.doesNotMatch(html, />complete parity coverage</);
      report.parity.dataStatus = 'complete';
      assert.match(renderHtml(report), />结构覆盖：完整 · 数据覆盖：完整<\/span>/);
      report.parity.dataStatus = 'partial';
    } else {
      assert.match(html, /complete structure · partial data coverage/);
    }
    if (host === 'claude') assert.match(html, /<title>Claude Code Insights<\/title>/);
    assert.equal(JSON.stringify(report), original, 'rendering must not translate stored keys or values');
  }
  assert.equal(taxonomyLabel('outcomes', 'not_achieved', 'zh'), '未达成');
  assert.equal(taxonomyLabel('toolNames', 'not_achieved', 'zh'), 'not_achieved');
  assert.equal(taxonomyLabel('outcomes', 'future_outcome', 'zh'), 'future_outcome');
});

function tokenUsageFixture(coverage = 'partial') {
  const bucket = (observed, reportedRecords = 1) => ({ observed, reportedRecords, missingRecords: coverage === 'partial' ? 1 : 0, untrackedSessions: coverage === 'partial' ? 1 : 0, partialSessions: coverage === 'partial' ? 1 : 0 });
  return {
    coverage,
    sessions: coverage === 'partial' ? { total: 3, complete: 1, partial: 1, unavailable: 1 } : { total: 1, complete: 1, partial: 0, unavailable: 0 },
    scopes: coverage === 'partial' ? { active_branch: 1, selected_transcript: 1, unknown: 1 } : { active_branch: 0, selected_transcript: 1, unknown: 0 },
    records: { expected: 2, withUsage: 1 },
    input: bucket(120), output: bucket(0), cacheRead: bucket(0, coverage === 'partial' ? 0 : 1), cacheWrite: bucket(8),
    totalTokens: coverage === 'partial' ? null : 128
  };
}

test('token coverage keeps partial subtotals, reported zero and unknown cache usage distinct in both report formats', () => {
  for (const locale of ['zh', 'en']) {
    const report = reportFixture(locale);
    report.coverage.projectFilter = { requested: true, path: '/work/a_[scope]', unknownProjectExcluded: 1 };
    report.coverage.tokenUsage = tokenUsageFixture();
    const html = renderHtml(report), markdown = renderMarkdown(report);
    const md = markdown.replace(/\\([\\`*_{}\[\]<>()#+\-.!|])/g, '$1');
    for (const content of [html, md]) {
      assert.ok(content.includes(locale === 'zh' ? 'Token 用量覆盖' : 'Token usage coverage'));
      assert.ok(content.includes(locale === 'zh' ? '部分记录' : 'Partially reported'));
      assert.ok(content.includes(locale === 'zh' ? '已记录为零' : 'reported zero'));
      assert.ok(content.includes(locale === 'zh' ? '缓存读取 Token' : 'Cache-read tokens'));
      assert.ok(content.includes(locale === 'zh' ? '未提供' : 'Not provided'));
      assert.ok(content.includes(locale === 'zh' ? '缓存写入 Token' : 'Cache-write tokens'));
      assert.ok(content.includes(locale === 'zh' ? '无法确定' : 'Unknown; missing usage'));
      assert.ok(content.includes(locale === 'zh' ? '不是账号账单' : 'not an account bill'));
      assert.ok(content.includes(locale === 'zh' ? 'Pi 的用量仅统计当前分支' : 'Pi usage includes only the current branch'));
      assert.ok(content.includes(locale === 'zh' ? '不推测未知会话的记录数' : 'no record count is guessed for unknown sessions'));
      assert.ok(content.includes('/work/a_[scope]'));
    }
    assert.match(html, /<td>缓存读取 Token<\/td><td>未提供<\/td>|<td>Cache-read tokens<\/td><td>Not provided<\/td>/);
    assert.doesNotMatch(html, /完整总量:<\/strong> 0|Complete total:<\/strong> 0/);
  }
});

test('complete token totals and explicitly reported all-zero usage remain observable', () => {
  for (const locale of ['zh', 'en']) {
    const report = reportFixture(locale);
    report.coverage.tokenUsage = tokenUsageFixture('complete');
    let html = renderHtml(report), md = renderMarkdown(report);
    assert.match(html, /完整总量:<\/strong> 128|Complete total:<\/strong> 128/);
    assert.match(md, /\*\*(?:完整总量|Complete total):\*\* 128/);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) report.coverage.tokenUsage[key].observed = 0;
    report.coverage.tokenUsage.totalTokens = 0;
    html = renderHtml(report); md = renderMarkdown(report);
    assert.match(html, /完整总量:<\/strong> 0|Complete total:<\/strong> 0/);
    assert.equal([...html.matchAll(/0（已记录为零）|0 \(reported zero\)/g)].length, 4);
    assert.match(md, /\*\*(?:完整总量|Complete total):\*\* 0/);
    assert.doesNotMatch(html, /已记录小计可能偏低|recorded subtotals may undercount/);
  }
});

test('unavailable token usage is not displayed as observed zero and can read the insights coverage alias', () => {
  const report = reportFixture('en');
  const usage = tokenUsageFixture('unavailable');
  usage.sessions = { total: 1, complete: 0, partial: 0, unavailable: 1 };
  usage.totalTokens = null;
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) usage[key] = { observed: 0, reportedRecords: 0, missingRecords: 0, untrackedSessions: 1, partialSessions: 0 };
  delete report.coverage.tokenUsage;
  report.insights.tokenUsageCoverage = usage;
  const html = renderHtml(report), md = renderMarkdown(report);
  assert.match(html, /No verifiable usage provided/);
  assert.equal([...html.matchAll(/<td>Not provided<\/td>/g)].length, 4);
  assert.doesNotMatch(html, /reported zero/);
  assert.match(md, /Unknown; missing usage has not been counted as zero/);
  assert.match(md, /0 known records missing; 1 sessions unreported/);
});

test('fixed tool error categories are localized without translating same-named tools', () => {
  const categories = { 'Command Failed': '命令失败', 'User Rejected': '用户拒绝', 'Edit Failed': '编辑失败', 'File Changed': '文件已变化', 'File Too Large': '文件过大', 'File Not Found': '文件未找到', Other: '其他' };
  for (const [canonical, translated] of Object.entries(categories)) {
    assert.equal(taxonomyLabel('toolErrorCategories', canonical, 'zh'), translated);
    assert.equal(taxonomyLabel('toolErrorCategories', canonical, 'en'), canonical);
    assert.equal(taxonomyLabel('toolNames', canonical, 'zh'), canonical);
  }
  for (const locale of ['zh', 'en']) {
    const report = reportFixture(locale);
    report.insights.toolErrorCategories = { 'Command Failed': 2, Other: 1 };
    report.insights.toolCounts = { 'Command Failed': 3 };
    const html = renderHtml(report), md = renderMarkdown(report);
    assert.ok(html.includes(`<span>${locale === 'zh' ? '命令失败' : 'Command Failed'}</span>`));
    assert.ok(md.includes(`${locale === 'zh' ? '命令失败' : 'Command Failed'}: 2`));
    assert.match(html, /<span>Command Failed<\/span>/);
  }
});

test('project coverage explains nonzero mixed-project exclusions without cluttering a zero count', () => {
  for (const locale of ['zh', 'en']) {
    const report = reportFixture(locale);
    report.coverage.projectFilter = { requested: true, path: '/work/project-b', unknownProjectExcluded: 0, mixedProjectExcluded: 2 };
    for (const raw of [renderHtml(report), renderMarkdown(report)]) {
      const output = raw.replaceAll('\\-', '-');
      assert.ok(output.includes(locale === 'zh' ? '排除了 2 个混合项目范围的会话' : '2 mixed-project sessions were also excluded'));
      assert.ok(output.includes(locale === 'zh' ? '包含筛选范围外的项目' : 'include projects outside the requested scope'));
      assert.ok(output.includes(locale === 'zh' ? '无法安全地将整个会话归属于所选项目' : 'entire session cannot safely be attributed to the selected project'));
    }
    report.coverage.projectFilter.mixedProjectExcluded = 0;
    for (const output of [renderHtml(report), renderMarkdown(report)]) assert.doesNotMatch(output, /混合项目范围|mixed-project sessions/);
  }
});

test('automation frequency uses validated counts in both formats and preserves arbitrary legacy prose', () => {
  for (const locale of ['zh', 'en']) {
    const report = reportFixture(locale);
    const automation = report.extensions.userAudit.aggregate.automationCandidates[0];
    Object.assign(automation, { occurrenceCount: 2, sessionCount: 1, evidenceMessageCount: 2, evidenceSessionCount: 1, frequency: '2 cited user messages across 1 sessions' });
    for (const output of [renderHtml(report), renderMarkdown(report)]) {
      assert.ok(output.includes(locale === 'zh' ? '2 条引用用户消息，来自 1 个会话' : '2 cited user messages across 1 session'));
      assert.doesNotMatch(output, /2 cited user messages across 1 sessions/);
    }
    delete automation.occurrenceCount;
    delete automation.sessionCount;
    delete automation.evidenceMessageCount;
    delete automation.evidenceSessionCount;
    automation.frequency = 'Literal legacy cadence';
    for (const output of [renderHtml(report), renderMarkdown(report)]) assert.match(output, /Literal legacy cadence/);
  }
});

test('missing or incomplete audit never promotes baseline quick-win prose into a coach action', () => {
  for (const status of ['missing', 'incomplete']) {
    for (const prose of ['A concrete baseline suggestion.', 'No extra change is supported.']) {
      const report = reportFixture();
      report.semantic.sections.at_a_glance.quickWins = prose;
      if (status === 'missing') delete report.extensions.userAudit;
      else report.extensions.userAudit = { status, failure: { reason: 'analyzer_failure' } };
      assert.equal(buildCoachSummary(report), null);
      const html = renderHtml(report), md = renderMarkdown(report), prompt = renderAgentPrompt(report);
      assert.doesNotMatch(html, /id="coach-primary-action"|href="#coach-primary-action"/);
      assert.doesNotMatch(md, /## 这次只改这一件/);
      assert.doesNotMatch(prompt, /^- One change:/m);
      assert.ok(html.includes(prose));
      assert.ok(md.includes(prose.replaceAll('.', '\\.')));
      assert.match(prompt, /do not promote it into a prescribed one-change action/);
    }
  }
});

test('coach and handoff retain finding posture, limits, quotations and verified citation coverage', () => {
  const report = reportFixture();
  const finding = report.extensions.userAudit.aggregate.topThree[0];
  Object.assign(finding, { evidencePosture: 'bold_inference', explanation: 'Only this task was observed; no long-term habit is established.', occurrenceCount: 999, evidenceMessageCount: 1, evidenceSessionCount: 1 });
  const coach = buildCoachSummary(report);
  assert.equal(coach.findings[0], finding);
  for (const marker of ['bold_inference', finding.explanation, 'Only fix the failing case.', 'messages 42', '已核验引用覆盖：1 条引用用户消息，来自 1 个会话']) {
    assert.ok(coach.hardTruths[0].includes(marker) || coach.hardTruths[0].includes(marker.replace('messages', '消息')), `CLI summary missing ${marker}`);
  }
  const html = renderHtml(report);
  const primary = html.slice(html.indexOf('<aside id="coach-primary-action"'), html.indexOf('</aside>'));
  assert.match(primary, /data-posture="bold_inference"/);
  assert.match(primary, /大胆推断/);
  assert.ok(primary.includes(finding.explanation));
  assert.match(primary, /Only fix the failing case/);
  assert.match(primary, /消息 42/);
  assert.match(primary, /已核验引用覆盖：1 条引用用户消息，来自 1 个会话/);
  assert.match(primary, /不能证明模型解释或因果归因成立/);
  const md = renderMarkdown(report);
  const summary = md.slice(0, md.indexOf('## 一瞥'));
  assert.match(summary, /大胆推断/);
  assert.match(summary, /Only this task was observed/);
  assert.match(summary, /Only fix the failing case/);
  assert.match(summary, /消息 42/);
  assert.match(summary, /已核验引用覆盖：1 条引用用户消息，来自 1 个会话/);
  const prompt = renderAgentPrompt(report);
  assert.match(prompt, /bold_inference/);
  assert.ok(prompt.includes(finding.explanation));
  assert.match(prompt, /Quoted evidence: "Only fix the failing case/);
  assert.match(prompt, /Evidence locator:.*消息 42/);
  assert.match(prompt, /do not prove the model interpretation/);
  for (const output of [html, md, prompt]) assert.doesNotMatch(output, /999|Seen about|大约出现|出现次数/);
  finding.evidencePosture = 'observed_instance';
  assert.match(renderHtml(report), /本次直接观察/);
  assert.match(renderMarkdown(report), /本次直接观察/);
});

test('legacy occurrence counts never become measured frequency or verified citation coverage', () => {
  const report = reportFixture('en');
  const finding = report.extensions.userAudit.aggregate.topThree[0];
  finding.occurrenceCount = 999;
  const automation = report.extensions.userAudit.aggregate.automationCandidates[0];
  Object.assign(automation, { occurrenceCount: 999, sessionCount: 999, frequency: 'A legacy cadence claim' });
  for (const output of [renderHtml(report), renderMarkdown(report), renderAgentPrompt(report)]) {
    assert.doesNotMatch(output, /999|Seen about|Occurrences/);
  }
  assert.match(renderHtml(report), /Legacy frequency description \(unverified\): A legacy cadence claim/);
});

test('completed audit preserves assessed background as derived analysis without inventing a finding or message citation', () => {
  for (const [locale, host] of [['zh', 'codex'], ['en', 'codex'], ['zh', 'claude']]) {
    const report = reportFixture(locale, host);
    const audit = report.extensions.userAudit.aggregate;
    Object.assign(audit, { highestLeverageChange: null, topThree: [], remaining: [], selfDefeatingPatterns: [], strengths: [], automationCandidates: [], assessmentContext: { status: 'assessed', summary: 'The earlier concern was resolved after new information. A justified plan change is not a user defect.', evidenceStatus: 'derived assessment of supplied context, not an independently established causal fact or complete transcript' } });
    const before = JSON.stringify(report);
    const html = renderHtml(report), md = renderMarkdown(report), prompt = renderAgentPrompt(report);
    const context = html.match(/<div class="assessment-context"[\s\S]*?<\/div>/)?.[0];
    assert.ok(context);
    assert.ok(context.includes(audit.assessmentContext.summary));
    assert.ok(context.includes(host === 'claude' || locale === 'en' ? 'Derived analysis, not original evidence' : '这是分析摘要，不是原始证据'));
    assert.doesNotMatch(context, /<blockquote|href=|消息 \d|messages \d/);
    assert.ok(md.includes('The earlier concern was resolved after new information'));
    assert.ok(md.includes(locale === 'zh' ? '### 判断背景' : '### Assessment context'));
    assert.doesNotMatch(md, /^> The earlier concern/m);
    assert.doesNotMatch(html, /id="coach-primary-action"|href="#coach-primary-action"/);
    assert.doesNotMatch(md, /## 这次只改这一件|## This run’s one change/);
    assert.match(prompt, /Keep reasons for no findings, counterevidence, resolved misunderstandings/);
    assert.match(prompt, /do not resurrect withdrawn accusations/);
    assert.equal(JSON.stringify(report), before);
  }
});

test('unknown or absent assessment context never manufactures an assessment summary or advice', () => {
  for (const assessmentContext of [undefined, { status: 'unknown', summary: null }, { status: 'unknown', summary: 'Do not render unsupported legacy context' }, { status: 'assessed', summary: '' }]) {
    const report = reportFixture();
    report.extensions.userAudit.aggregate.highestLeverageChange = null;
    report.extensions.userAudit.aggregate.assessmentContext = assessmentContext;
    const html = renderHtml(report), md = renderMarkdown(report);
    assert.doesNotMatch(html, /class="assessment-context"|Do not render unsupported legacy context|id="coach-primary-action"/);
    assert.doesNotMatch(md, /### 判断背景|Do not render unsupported legacy context|## 这次只改这一件/);
  }
});

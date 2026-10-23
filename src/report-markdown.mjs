import { buildEvidenceIndex } from './report-evidence.mjs';
import { taxonomyLabel, tokenUsageLabels, automationFrequencyLabel, evidenceCoverageLabel, evidenceNavigationLabels } from './i18n.mjs';

export const isUnavailableSemanticReport = (report) => report.semantic?.enabled === true && !(report.semantic.sessions?.length > 0);

/** Explicit reader-facing projection of the validated semantic report contract. */
export function renderSemanticMarkdown(report, { t, escape, locatorLabel, responseBuckets }) {
  const zh = t.htmlLang === 'zh-CN';
  const l = (en, cn) => zh ? cn : en;
  const sessions = report.semantic?.sessions ?? [];
  const index = buildEvidenceIndex(report);
  const nav = evidenceNavigationLabels(t.htmlLang);
  const h = (level, title) => `${'#'.repeat(level)} ${escape(title)}\n\n`;
  const text = (content) => content == null || content === '' ? '' : `${escape(content)}\n\n`;
  const field = (label, content) => content == null || content === '' ? '' : `**${escape(String(label).replace(/[：:]\s*$/, ''))}:** ${text(content)}`;
  const quotation = (quote) => String(quote).split('\n').map((line) => `> ${escape(line)}`).join('\n');
  const empty = (items) => text(Array.isArray(items) ? t.sections.noSupportedItems : t.sections.sectionUnavailable);
  const code = (label, body) => {
    if (!body) return '';
    const fence = '`'.repeat(Math.max(3, ...[...String(body).matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `**${escape(label)}**\n\n${fence}\n${body}\n${fence}\n\n`;
  };
  const sessionLabel = (entry) => {
    const s = entry.session;
    return [s.sessionId ?? entry.id, s.source, s.date, s.projectPath ?? s.projectLabel, s.transcriptPath ?? s.reopenCommand].filter(Boolean).join(' · ');
  };
  const sessionReference = (id) => {
    const resolved = index.resolve(id);
    if (resolved.status !== 'resolved') return `${escape(id)} · ${escape(nav[resolved.status])}`;
    return `[${escape(sessionLabel(resolved.entry))}](#${index.anchor(resolved.entry)})`;
  };
  const evidence = (item) => {
    const quotes = (item.quotations ?? []).map(quotation).join('\n\n');
    const hasLocators = item.locators?.length > 0;
    const labels = hasLocators ? item.locators.map((loc) => auditLocatorMarkdown(loc, item.quotations ?? [], { index, t, escape, locatorLabel })) : (item.evidenceSessionIds ?? []).map(sessionReference);
    const label = hasLocators ? t.audit.evidence : nav.sessionSupport;
    const references = labels.length ? labels.join('; ') : escape(nav.noReference);
    return `${quotes ? quotes + '\n\n' : ''}${text(evidenceCoverageLabel(item, t.htmlLang))}**${escape(String(label).replace(/[：:]\s*$/, ''))}:** ${references}\n\n`;
  };
  const list = (label, items) => items?.length ? field(label, items.join('; ')) : '';
  const cards = (items, title, body) => items?.length ? items.map((item) => `${h(3, title(item))}${body(item)}${evidence(item)}`).join('') : empty(items);
  const section = (title, body) => h(2, title) + body;
  const enumLabel = (domain, name) => taxonomyLabel(domain, name, t.htmlLang);
  const finding = (item) => field(l('Category', '类别'), enumLabel('auditCategory', item.category)) + field(l('Severity', '严重度'), enumLabel('severity', item.severity)) + field(l('Evidence posture', '证据性质'), enumLabel('evidencePosture', item.evidencePosture)) + text(item.explanation) + field(t.audit.betterAlternative, item.betterAlternative) + code(t.audit.trySaying, item.copyablePrompt);
  const unavailable = isUnavailableSemanticReport(report);
  const s = unavailable ? {} : report.semantic?.sections ?? {};
  let result = unavailable ? section(l('Semantic analysis', '语义分析'), text(t.sections.noAnalyzableSessions)) : '';
  const failures = { ...report.semantic?.sectionFailures, ...report.coverage?.sectionFailures };
  const failedSection = (key, title) => Object.hasOwn(failures, key) ? section(title, text(t.sections.sectionFailed(failures[key]?.reason ?? failures[key] ?? 'unavailable'))) : '';
  const failed = (key) => Object.hasOwn(failures, key);
  if (failed('at_a_glance')) result += failedSection('at_a_glance', t.sections.atAGlance);
  else if (s.at_a_glance) result += section(t.sections.atAGlance, ['whatsWorking', 'whatsHindering', 'quickWins', 'ambitiousWorkflows'].map((key) => field(t.sections[key], s.at_a_glance[key])).join('') + evidence(s.at_a_glance));
  if (failed('project_areas')) result += failedSection('project_areas', t.sections.whatYouWorkOn);
  else if (s.project_areas) result += section(t.sections.whatYouWorkOn, (s.project_areas.areas?.length ? text(t.sections.projectAreaCountsNote) : '') + cards(s.project_areas.areas, (item) => item.name, (item) => text(item.description) + field(l('Estimated sessions (model grouping)', '估计会话数（模型归类）'), Number.isSafeInteger(item.sessionCount) && item.sessionCount >= 0 ? item.sessionCount : l('Unknown', '未知'))));
  if (failed('interaction_style')) result += failedSection('interaction_style', t.sections.howYouUse);
  else if (s.interaction_style) result += section(t.sections.howYouUse, text(s.interaction_style.narrative) + field(l('Key pattern', '关键模式'), s.interaction_style.keyPattern) + evidence(s.interaction_style));
  if (failed('what_works')) result += failedSection('what_works', t.sections.impressiveThings);
  else if (s.what_works) result += section(t.sections.impressiveThings, text(s.what_works.intro) + cards(s.what_works.impressiveWorkflows, (item) => item.title, (item) => text(item.description)));
  if (failed('friction_analysis')) result += failedSection('friction_analysis', t.sections.whereThingsGoWrong);
  else if (s.friction_analysis) result += section(t.sections.whereThingsGoWrong, text(s.friction_analysis.intro) + cards(s.friction_analysis.categories, (item) => item.category, (item) => text(item.description) + (item.examples ?? []).map((example) => text(example.text) + evidence(example)).join('')));
  if (failed('suggestions')) result += failedSection('suggestions', t.sections.existingFeatures);
  else if (s.suggestions) {
    const suggestions = s.suggestions;
    result += section(t.sections.claudeMdAdditions, cards(suggestions.instructionAdditions, (item) => item.addition, (item) => text(item.why) + code(l('Copyable scaffold', '可复制模板'), item.promptScaffold)));
    result += section(t.sections.featuresToTry, cards(suggestions.featuresToTry, (item) => item.feature, (item) => text(item.oneLiner) + text(item.whyForYou) + code(l('Copyable example', '可复制示例'), item.exampleCode)));
    result += section(t.sections.newWays, cards(suggestions.usagePatterns, (item) => item.title, (item) => text(item.suggestion) + text(item.detail) + code(t.audit.trySaying, item.copyablePrompt)));
  }
  if (failed('on_the_horizon')) result += failedSection('on_the_horizon', t.sections.onTheHorizon);
  else if (s.on_the_horizon) result += section(t.sections.onTheHorizon, text(s.on_the_horizon.intro) + cards(s.on_the_horizon.opportunities, (item) => item.title, (item) => text(item.whatsPossible) + field(l('How to try', '如何尝试'), item.howToTry) + code(t.audit.trySaying, item.copyablePrompt)));
  if (failed('fun_ending')) result += failedSection('fun_ending', s.fun_ending?.headline ?? t.sections.memorableMoment);
  else if (s.fun_ending) result += section(s.fun_ending.headline ?? t.sections.memorableMoment, text(s.fun_ending.detail) + evidence(s.fun_ending));
  const audit = report.extensions?.userAudit;
  if (audit?.status === 'complete' && audit.aggregate) {
    const a = audit.aggregate;
    const assessment = a.assessmentContext;
    const assessmentMarkdown = assessment?.status === 'assessed' && typeof assessment.summary === 'string' && assessment.summary.trim()
      ? h(3, t.audit.assessmentContext) + text(t.audit.assessmentContextNote) + text(assessment.summary)
      : '';
    const change = a.highestLeverageChange;
    result += section(t.audit.leverage, change ? h(3, change.change) + text(change.rationale) + code(t.audit.trySaying, change.copyablePrompt) + evidence(change) : text(t.audit.noSupportedChange));
    result += section(t.audit.threeHardTruths, text(t.audit.threeHardTruthsLead) + text(t.audit.sourceValidationNote) + assessmentMarkdown + cards(a.topThree, (item) => item.accusation, finding));
    result += section(t.audit.allFindings, cards(a.remaining, (item) => item.accusation, finding));
    result += section(t.audit.selfDefeating, cards(a.selfDefeatingPatterns, (item) => item.pattern, (item) => field(t.audit.intent, item.intent) + text(item.explanation)));
    result += section(t.audit.strengths, cards(a.strengths, (item) => item.habit, (item) => text(item.explanation)));
    result += section(t.audit.automation, text(t.audit.automationLead) + cards(a.automationCandidates, (item) => item.name, (item) => field(l('Type', '类型'), enumLabel('automationType', item.type)) + field(l('Frequency', '频率'), automationFrequencyLabel(item, t.htmlLang)) + field(t.audit.trigger, item.trigger) + list(t.audit.inputs, item.inputs) + list(t.audit.outputs, item.outputs) + text(item.rationale) + field(t.audit.overAutomationRisk, item.overAutomationRisk) + code(t.audit.draftBody, item.draftBody)));
  } else if (audit?.status === 'incomplete') result += section(t.audit.threeHardTruths, text(t.audit.incomplete(audit.failure?.reason ?? 'incomplete')));
  const deterministic = report.insights;
  if (deterministic) {
    const fields = { goalCategories: t.sections.whatYouWanted, languages: t.sections.languages, sessionTypes: t.sections.sessionTypes, multiClauding: t.sections.multiClauding, messageHours: `${t.sections.timeOfDay} (UTC)`, primarySuccesses: t.sections.primarySuccesses, outcomes: t.sections.outcomes, friction: t.sections.frictionTypes, satisfaction: t.sections.inferredSatisfaction, toolErrorCategories: t.sections.toolErrors };
    result += h(2, l('Session metadata', '会话元数据'));
    for (const [key, title] of Object.entries(fields)) {
      const entries = Object.entries(deterministic[key] ?? {});
      result += h(3, title) + (entries.length ? entries.map(([name, count]) => `- ${escape(key === 'messageHours' ? `${String(name).padStart(2, '0')}:00 UTC` : enumLabel(key, name))}: ${escape(count)}`).join('\n') + '\n\n' : text(t.sections.noData));
    }
    if (deterministic.userResponseTimes?.length) result += h(3, t.sections.responseTime) + text(t.sections.medianAverage(deterministic.medianResponseTime ?? '—', deterministic.averageResponseTime ?? '—')) + responseBuckets(deterministic.userResponseTimes).map(([bucket, count]) => `- ${escape(bucket)}: ${count}`).join('\n') + '\n\n';
  }
  if (index.entries.length) {
    const groups = index.entries.map((entry) => {
      const items = entry.grounding.map((item, position) => {
        const description = field(l('Evidence description', '证据说明'), item.description);
        const quote = item.quotation ? `${quotation(item.quotation)}\n\n` : '';
        const locator = { sessionId: entry.id, messageIndexes: item.messageIndexes ?? [] };
        return `<a id="${index.groundingAnchor(entry, position)}"></a>\n\n${description}${quote}${text(locatorLabel(locator, index.entries.map((value) => value.session), t))}`;
      }).join('') || text(nav.noGrounding);
      return `<a id="${index.anchor(entry)}"></a>\n\n${h(3, sessionLabel(entry))}${items}`;
    }).join('');
    result += section(t.sections.evidenceIndex, text(nav.supportScope) + text(t.audit.sourceValidationNote) + groups);
  }
  return result;
}

/** The same compact coverage view feeds HTML and Markdown; JSON stays canonical. */
export function tokenUsagePresentation(report, locale) {
  const usage = report.coverage?.tokenUsage ?? report.insights?.tokenUsageCoverage;
  if (!usage) return null;
  const labels = tokenUsageLabels(locale);
  const fmt = (n) => new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US').format(n);
  const rows = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => {
    const bucket = usage[key] ?? {};
    const recorded = Number(bucket.reportedRecords) > 0 && Number.isFinite(bucket.observed);
    const subtotal = !recorded ? labels.notProvided : bucket.observed === 0 ? labels.observedZero : fmt(bucket.observed);
    return [labels[key], subtotal, labels.recordSummary(fmt(bucket.reportedRecords ?? 0), fmt(bucket.missingRecords ?? 0), fmt(bucket.untrackedSessions ?? 0), fmt(bucket.partialSessions ?? 0))];
  });
  const sessions = usage.sessions ?? { total: 0, complete: 0, partial: 0, unavailable: 0 };
  const notes = [labels.localOnly];
  if (usage.coverage !== 'complete') notes.push(labels.incomplete);
  if (usage.scopes?.active_branch > 0) notes.push(labels.activeBranch(fmt(usage.scopes.active_branch)));
  if (usage.scopes?.selected_transcript > 0) notes.push(labels.selectedTranscript(fmt(usage.scopes.selected_transcript)));
  if (usage.scopes?.unknown > 0) notes.push(labels.unknownScope(fmt(usage.scopes.unknown)));
  return { labels, status: labels[usage.coverage] ?? labels.unavailable, summary: labels.sessionSummary(Object.fromEntries(Object.entries(sessions).map(([key, value]) => [key, fmt(value)]))), rows, total: usage.totalTokens == null ? labels.unknownTotal : fmt(usage.totalTokens), notes };
}

export function renderTokenUsageMarkdown(report, { locale, escape }) {
  const view = tokenUsagePresentation(report, locale);
  if (!view) return '';
  const { labels } = view;
  return `### ${labels.heading}\n\n${escape(view.status)} · ${escape(view.summary)}\n\n| ${labels.kind} | ${labels.subtotal} | ${labels.detail} |\n| --- | ---: | --- |\n${view.rows.map((row) => `| ${row.map(escape).join(' | ')} |`).join('\n')}\n\n**${labels.total}:** ${escape(view.total)}\n\n${view.notes.map((note) => escape(note)).join(' ')}\n\n`;
}


export function renderCoachFindingsMarkdown(findings, { t, escape, sessions, locatorLabel, index }) {
  return findings.map((finding) => {
    const posture = taxonomyLabel('evidencePosture', finding.evidencePosture, t.htmlLang);
    const quotes = (finding.quotations ?? []).map((quote) => String(quote).split('\n').map((line) => `> ${escape(line)}`).join('\n')).join('\n\n');
    const locators = (finding.locators ?? []).map((locator) => index ? auditLocatorMarkdown(locator, finding.quotations ?? [], { index, t, escape, locatorLabel }) : escape(locatorLabel(locator, sessions, t))).join('; ');
    const coverage = evidenceCoverageLabel(finding, t.htmlLang);
    return `### ${escape(finding.accusation)}\n\n**${t.htmlLang === 'zh-CN' ? '证据性质' : 'Evidence posture'}:** ${escape(posture)}\n\n${escape(finding.explanation)}\n\n${quotes}\n\n${coverage ? escape(coverage) + '\n\n' : ''}${locators || escape(t.audit.unavailable)}\n\n`;
  }).join('') + (findings.length ? `${escape(t.audit.sourceValidationNote)}\n\n` : '');
}


function auditLocatorMarkdown(locator, quotations, { index, t, escape, locatorLabel }) {
  const resolution = index.resolve(locator.sessionId);
  const label = escape(locatorLabel(locator, index.entries.map((entry) => entry.session), t));
  if (resolution.status !== 'resolved') return `${label} · ${escape(evidenceNavigationLabels(t.htmlLang)[resolution.status])}`;
  const targets = (locator.messageIndexes ?? []).map((messageIndex) => ({ messageIndex, target: index.auditTarget({ ...locator, messageIndexes: [messageIndex] }, quotations) })).filter((entry) => entry.target);
  if (targets.length === 1 && locator.messageIndexes.length === 1) return `[${label}](#${targets[0].target})`;
  return label + targets.map(({ messageIndex, target }) => ` [${t.htmlLang === 'zh-CN' ? '消息' : 'message'} ${escape(messageIndex)}](#${target})`).join('');
}

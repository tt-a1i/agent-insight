import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DirectoryLockCleanupError, withDirectoryLock } from './run-lock.mjs';
import { reportChrome, normalizeLocale, taxonomyLabel, automationFrequencyLabel, evidenceCoverageLabel, evidenceNavigationLabels } from './i18n.mjs';
import { buildEvidenceIndex } from './report-evidence.mjs';
import { renderSemanticMarkdown, isUnavailableSemanticReport, tokenUsagePresentation, renderTokenUsageMarkdown, renderCoachFindingsMarkdown } from './report-markdown.mjs';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const number = (value, locale = 'en-US') => new Intl.NumberFormat(locale).format(value);
const escapeMarkdown = (value) => String(value).replace(/([\\\`*_{}\[\]<>()#+\-.!|])/g, '\\$1');
const coverageLabel = (value, locale) => taxonomyLabel('coverage', value, locale);
const coverageNumber = (value) => value === undefined || value === null ? '—' : number(value);

function coverageNotes(source, report, locale = report && reportChrome(report).locale) {
  const zh = locale === 'zh';
  const notes = [];
  if (source.warning) notes.push(source.warning);
  if (source.discoveryTruncated) notes.push(zh ? `每个根目录最多发现 ${number(source.discoveryLimit)} 个文件` : `discovery capped at ${number(source.discoveryLimit)} files per root`);
  if (source.discoveryErrors) notes.push(zh ? `${number(source.discoveryErrors)} 次发现错误` : `${number(source.discoveryErrors)} discovery error${source.discoveryErrors === 1 ? '' : 's'}`);
  if (source.statErrors) notes.push(zh ? `${number(source.statErrors)} 次文件状态错误` : `${number(source.statErrors)} stat error${source.statErrors === 1 ? '' : 's'}`);
  if (source.transcriptRootsFound !== undefined) notes.push(zh ? `发现 ${number(source.transcriptRootsFound)} 个会话记录根目录` : `${number(source.transcriptRootsFound)} transcript root${source.transcriptRootsFound === 1 ? '' : 's'} found`);
  return notes.join('; ') || '—';
}

function projectFilterNote(report, locale = reportChrome(report).locale) {
  const filter = report.coverage.projectFilter;
  const mixed = filter?.requested && filter.mixedProjectExcluded > 0
    ? locale === 'zh'
      ? `另排除了 ${number(filter.mixedProjectExcluded)} 个混合项目范围的会话：其中包含筛选范围外的项目，无法安全地将整个会话归属于所选项目。`
      : `${number(filter.mixedProjectExcluded)} mixed-project sessions were also excluded: they include projects outside the requested scope, so the entire session cannot safely be attributed to the selected project.`
    : '';
  if (locale === 'zh') return `${!filter?.requested ? '未请求项目筛选。' : `已请求项目筛选${filter.path ? `：${filter.path}` : ''}；排除了 ${number(filter.unknownProjectExcluded ?? 0)} 个无法识别项目的会话。`}${mixed} ${eligibilityNote(report, locale)}`;
  const project = !filter?.requested
    ? 'No project filter was requested.'
    : `A project filter was requested${filter.path ? `: ${filter.path}` : ''}; ${number(filter.unknownProjectExcluded ?? 0)} session${filter.unknownProjectExcluded === 1 ? '' : 's'} without an identifiable project were excluded.`;
  return `${project}${mixed ? ` ${mixed}` : ''} ${eligibilityNote(report, locale)}`;
}

function eligibilityNote(report, locale = reportChrome(report).locale) {
  const eligibility = report.coverage?.eligibility;
  if (locale === 'zh') {
    if (!eligibility) return '此纯确定性报告未评估语义分析资格。';
    const reasons = Object.entries(eligibility.reasons ?? {}).map(([reason, count]) => `${number(count)} ${reason}`).join('，');
    return `${number(eligibility.eligible)} 个符合资格，${number(eligibility.excluded)} 个被排除，共扫描 ${number(eligibility.scanned)} 个${reasons ? `（${reasons}）` : ''}。`;
  }
  if (!eligibility) return 'Eligibility was not evaluated for this deterministic-only report.';
  const reasons = Object.entries(eligibility.reasons ?? {}).map(([reason, count]) => `${number(count)} ${reason.replaceAll('_', ' ')}`).join(', ');
  return `${number(eligibility.eligible)} eligible, ${number(eligibility.excluded)} excluded, ${number(eligibility.scanned)} scanned${reasons ? ` (${reasons})` : ''}.`;
}

function semanticFailureNote(report, locale = reportChrome(report).locale) {
  const failures = report.coverage?.semanticFailures ?? [];
  const extensionFailures = report.coverage?.extensionFailures ?? [];
  const sectionFailures = { ...report.semantic?.sectionFailures, ...report.coverage?.sectionFailures };
  for (const failure of failures) {
    const section = /^aggregate(?:-chunk)?:([a-z_]+)(?::\d+)?$/.exec(failure.taskId ?? '')?.[1];
    if (section) sectionFailures[section] ??= failure;
  }
  const { t } = reportChrome({ ...report, locale }, { prose: true });
  const sectionLabels = {
    at_a_glance: t.sections.atAGlance,
    project_areas: t.sections.whatYouWorkOn,
    interaction_style: t.sections.howYouUse,
    what_works: t.sections.impressiveThings,
    friction_analysis: t.sections.whereThingsGoWrong,
    suggestions: [t.sections.claudeMdAdditions, t.sections.featuresToTry, t.sections.newWays].join(' / '),
    on_the_horizon: t.sections.onTheHorizon,
    fun_ending: t.sections.memorableMoment
  };
  const unavailable = Object.entries(sectionFailures).map(([section, failure]) => `${sectionLabels[section] ?? section} (${failure?.reason ?? 'incomplete'})`);
  const notes = [];
  if (locale === 'zh') {
    const reasons = Object.entries(failures.reduce((counts, failure) => ({ ...counts, [failure.reason]: (counts[failure.reason] ?? 0) + 1 }), {})).map(([reason, count]) => `${number(count)} ${reason}`).join('，');
    notes.push(failures.length ? `语义分析覆盖不完整：${reasons}。` : unavailable.length ? '语义分析覆盖不完整。' : '未记录语义分析器失败。');
    if (unavailable.length) notes.push(`未完成分析的章节：${unavailable.join('；')}。`);
    if (extensionFailures.length) notes.push(`扩展覆盖不完整：${extensionFailures.map((failure) => `${failure.extension}（${failure.reason}）`).join('；')}。`);
    return notes.join(' ');
  }
  if (failures.length) {
    const reasons = Object.entries(failures.reduce((counts, failure) => ({ ...counts, [failure.reason]: (counts[failure.reason] ?? 0) + 1 }), {}))
      .map(([reason, count]) => `${number(count)} ${reason.replaceAll('_', ' ')}`)
      .join(', ');
    notes.push(`Semantic coverage is partial: ${reasons}.`);
  } else {
    notes.push(unavailable.length ? 'Semantic coverage is partial.' : 'No semantic analyzer failures were recorded.');
  }
  if (unavailable.length) notes.push(`Sections not analyzed: ${unavailable.join('; ')}.`);
  if (extensionFailures.length) {
    notes.push(`Extension coverage is partial: ${extensionFailures.map((failure) => `${failure.extension} (${failure.reason.replaceAll('_', ' ')})`).join('; ')}.`);
  }
  return notes.join(' ');
}

function copyBlock(text) {
  if (!text) return '';
  return `<div class="copy">${escapeHtml(text)}</div>`;
}

function sessionReopenHint(session) {
  if (!session) return null;
  if (session.transcriptPath) return session.transcriptPath;
  if (session.reopenCommand) return session.reopenCommand;
  if (session.source === 'opencode' && (session.sessionId || session.id)) {
    return `opencode session ${session.sessionId ?? session.id}`;
  }
  return null;
}

function evidenceLocatorLabel(locator, evidenceSessions = [], t) {
  const canonical = evidenceSessions.find((entry) => entry.id === locator.sessionId);
  const aliases = evidenceSessions.filter((entry) => entry.sessionId === locator.sessionId);
  const session = canonical ?? (aliases.length === 1 ? aliases[0] : null);
  const label = session
    ? [session.sessionId ?? session.id, session.source, session.date, session.projectPath || session.projectLabel].filter(Boolean).join(' · ')
    : locator.sessionId;
  const reopen = sessionReopenHint(session);
  const reopenPart = reopen ? ` · ${t.audit.reopen} ${reopen}` : '';
  return `${label} · ${t.htmlLang === 'zh-CN' ? '消息' : 'messages'} ${(locator.messageIndexes ?? []).join(', ')}${reopenPart}`;
}

function citedSessionContextSummary(finding, evidenceSessions = [], evidenceIndex) {
  const ids = new Set((finding.locators ?? []).map((locator) => String(locator.sessionId)));
  if (!ids.size) return null;
  const index = evidenceIndex ?? buildEvidenceIndex({ semantic: { sessions: evidenceSessions } });
  const matched = new Map();
  let unresolved = 0;
  for (const id of ids) {
    const resolution = index.resolve(id);
    if (resolution.status === 'resolved') matched.set(resolution.entry.id, resolution.entry.session);
    else unresolved += 1;
  }
  const sessions = [...matched.values()];
  const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const duration = (session) => {
    if (session.durationMinutes != null) return typeof session.durationMinutes === 'number' && Number.isFinite(session.durationMinutes) && session.durationMinutes >= 0 ? session.durationMinutes : null;
    if (typeof session.startedAt !== 'string' || typeof session.endedAt !== 'string') return null;
    const start = Date.parse(session.startedAt), end = Date.parse(session.endedAt);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 60_000) : null;
  };
  const sum = (read) => {
    const values = sessions.map(read).filter((value) => value !== null);
    return { observed: values.length ? values.reduce((total, value) => total + value, 0) : null, recorded: values.length, sessions: sessions.length };
  };
  return {
    sessions: sessions.length,
    unresolved,
    userTurns: sum((session) => count(session.userMessages)),
    toolErrors: sum((session) => count(session.toolErrors)),
    durationMinutes: sum(duration)
  };
}

function findingNarrativeLines(finding, report) {
  const t = reportChrome(report, { prose: true }).t;
  return [
    `Finding to examine (${finding.evidencePosture}; ${taxonomyLabel('evidencePosture', finding.evidencePosture, t.htmlLang)}): ${finding.accusation}`,
    `Explanation and limits: ${finding.explanation}`,
    ...(finding.quotations ?? []).map((quote) => `Quoted evidence: ${JSON.stringify(quote)}`),
    ...(finding.locators ?? []).map((locator) => `Evidence locator: ${evidenceLocatorLabel(locator, report.semantic?.sessions ?? [], t)}`),
    evidenceCoverageLabel(finding, t.htmlLang)
  ].filter(Boolean);
}

export function buildCoachSummary(report) {
  if (isUnavailableSemanticReport(report)) return null;
  const audit = report.extensions?.userAudit;
  const leverage = audit?.status === 'complete' ? audit.aggregate?.highestLeverageChange : null;
  if (!leverage) return null;
  const findings = audit.aggregate?.topThree ?? [];
  return {
    source: 'audit',
    title: leverage.change,
    detail: leverage.rationale,
    copyablePrompt: leverage.copyablePrompt ?? null,
    quotations: leverage.quotations ?? [],
    locators: leverage.locators ?? [],
    evidenceMessageCount: leverage.evidenceMessageCount,
    evidenceSessionCount: leverage.evidenceSessionCount,
    findings,
    // Retained for the CLI consumer; it receives qualified evidence, not accusations alone.
    hardTruths: findings.map((finding) => findingNarrativeLines(finding, report).join('\n')),
    automationName: audit.aggregate?.automationCandidates?.[0]?.name ?? null
  };
}

function renderFindingCard(finding, evidenceSessions = [], t, index) {
  const locators = renderAuditLocators(finding, evidenceSessions, t, index);
  const quotes = (finding.quotations ?? []).map((quotation) => `<blockquote>${escapeHtml(quotation)}</blockquote>`).join('');
  const coverage = evidenceCoverageLabel(finding, t.htmlLang);
  const count = coverage ? `<p class="muted">${escapeHtml(coverage)}</p>` : '';
  const cost = citedSessionContextSummary(finding, evidenceSessions, index);
  const costHtml = cost
    ? `<p class="muted">${escapeHtml(t.audit.habitCost)} ${escapeHtml(t.audit.habitCostDetail(cost))}</p>`
    : '';
  const rewrite = finding.copyablePrompt
    ? `<p><strong>${escapeHtml(t.audit.trySaying)}</strong></p>${copyBlock(finding.copyablePrompt)}`
    : '';
  return `<article class="prose-card audit-finding" data-severity="${escapeHtml(finding.severity)}" data-posture="${escapeHtml(finding.evidencePosture)}"><p class="muted">${escapeHtml(taxonomyLabel('auditCategory', finding.category, t.htmlLang))} · ${escapeHtml(taxonomyLabel('severity', finding.severity, t.htmlLang))} · ${escapeHtml(taxonomyLabel('evidencePosture', finding.evidencePosture, t.htmlLang))}</p><h3>${escapeHtml(finding.accusation)}</h3><p>${escapeHtml(finding.explanation)}</p>${quotes}<p><strong>${escapeHtml(t.audit.betterAlternative)}</strong> ${escapeHtml(finding.betterAlternative)}</p>${rewrite}${count}${costHtml}<p class="evidence">${escapeHtml(t.audit.evidence)} ${locators || escapeHtml(t.audit.unavailable)}</p></article>`;
}

function renderStrengthCard(item, evidenceSessions = [], t, index) {
  return `<article class="prose-card"><h3>${escapeHtml(item.habit)}</h3><p>${escapeHtml(item.explanation)}</p>${renderItemEvidence(item, evidenceSessions, t, index)}</article>`;
}

function renderSelfDefeatingCard(item, evidenceSessions = [], t, index) {
  return `<article class="prose-card"><h3>${escapeHtml(item.pattern)}</h3><p class="muted">${escapeHtml(t.audit.intent)} ${escapeHtml(item.intent)}</p><p>${escapeHtml(item.explanation)}</p>${renderItemEvidence(item, evidenceSessions, t, index)}</article>`;
}

function renderAutomationCard(item, t, evidenceSessions = [], index) {
  const draft = item.draftBody ? `<p><strong>${escapeHtml(t.audit.draftBody)}</strong></p>${copyBlock(item.draftBody)}` : '';
  return `<article class="prose-card"><p class="muted">${escapeHtml(taxonomyLabel('automationType', item.type, t.htmlLang))} · ${escapeHtml(automationFrequencyLabel(item, t.htmlLang))}</p><h3>${escapeHtml(item.name)}</h3><p><strong>${escapeHtml(t.audit.trigger)}</strong> ${escapeHtml(item.trigger)}</p><p><strong>${escapeHtml(t.audit.inputs)}</strong> ${escapeHtml((item.inputs ?? []).join('; '))}</p><p><strong>${escapeHtml(t.audit.outputs)}</strong> ${escapeHtml((item.outputs ?? []).join('; '))}</p><p>${escapeHtml(item.rationale)}</p><p class="muted"><strong>${escapeHtml(t.audit.overAutomationRisk)}</strong> ${escapeHtml(item.overAutomationRisk)}</p>${draft}${renderItemEvidence(item, evidenceSessions, t, index)}</article>`;
}

function renderAuditLocators(item, sessions, t, index) {
  return (item.locators ?? []).map((locator) => {
    const pool = index ? index.entries.map((entry) => entry.session) : sessions;
    const resolution = index?.resolve(locator.sessionId);
    const label = escapeHtml(evidenceLocatorLabel(locator, pool, t)) + (resolution && resolution.status !== 'resolved' ? ` · ${escapeHtml(evidenceNavigationLabels(t.htmlLang)[resolution.status])}` : '');
    const targets = (locator.messageIndexes ?? []).map((messageIndex) => ({ messageIndex, target: index?.auditTarget({ ...locator, messageIndexes: [messageIndex] }, item.quotations ?? []) })).filter((entry) => entry.target);
    if (targets.length === 1 && locator.messageIndexes.length === 1) return `<a href="#${targets[0].target}">${label}</a>`;
    return label + targets.map(({ messageIndex, target }) => ` <a href="#${target}">${t.htmlLang === 'zh-CN' ? '消息' : 'message'} ${escapeHtml(messageIndex)}</a>`).join('');
  }).join('; ');
}

function renderItemEvidence(item, sessions, t, index) {
  const coverage = evidenceCoverageLabel(item, t.htmlLang);
  const quotes = (item.quotations ?? []).map((quote) => `<blockquote>${escapeHtml(quote)}</blockquote>`).join('');
  const labels = renderAuditLocators(item, sessions, t, index);
  return `${quotes}${coverage ? `<p class="muted">${escapeHtml(coverage)}</p>` : ''}${labels.length ? `<p class="evidence">${escapeHtml(t.audit.evidence)} ${labels}</p>` : ''}`;
}

function renderPrimaryAction(report, t) {
  const coach = buildCoachSummary(report);
  if (!coach) return '';
  const sessions = report.semantic?.sessions ?? [];
  const index = buildEvidenceIndex(report);
  const copy = coach.copyablePrompt ? `<p><strong>${escapeHtml(t.audit.trySaying)}</strong></p>${copyBlock(coach.copyablePrompt)}` : '';
  const findings = coach.findings.map((finding) => `<article data-posture="${escapeHtml(finding.evidencePosture)}"><p class="muted">${escapeHtml(taxonomyLabel('evidencePosture', finding.evidencePosture, t.htmlLang))}</p><h4>${escapeHtml(finding.accusation)}</h4><p>${escapeHtml(finding.explanation)}</p>${renderItemEvidence(finding, sessions, t, index)}</article>`).join('');
  return `<aside id="coach-primary-action" class="callout coach-action" data-extension-section="coach_primary_action"><h3>${escapeHtml(t.audit.primaryAction)}</h3><p class="muted">${escapeHtml(t.audit.primaryActionLead)}</p><p><strong>${escapeHtml(coach.title)}</strong></p>${coach.detail ? `<p>${escapeHtml(coach.detail)}</p>` : ''}${copy}${renderItemEvidence(coach, sessions, t, index)}${findings}<p class="muted">${escapeHtml(t.audit.sourceValidationNote)}</p></aside>`;
}

function renderUserAudit(report, t) {
  const audit = report.extensions?.userAudit;
  if (!audit || audit.status === 'skipped') return '';
  const evidenceSessions = report.semantic?.sessions ?? [];
  const index = buildEvidenceIndex(report);
  if (audit.status === 'incomplete') {
    const reason = audit.failure?.reason ?? audit.reason ?? 'incomplete';
    return `<section id="three-hard-truths" data-extension-section="user_audit"><h2>${escapeHtml(t.audit.threeHardTruths)}</h2><div class="empty">${escapeHtml(t.audit.incomplete(reason.replaceAll('_', ' ')))}</div></section>`;
  }
  if (audit.status !== 'complete' || !audit.aggregate) return '';
  const assessment = audit.aggregate.assessmentContext;
  const assessmentHtml = assessment?.status === 'assessed' && typeof assessment.summary === 'string' && assessment.summary.trim()
    ? `<div class="assessment-context" data-derived-context><h3>${escapeHtml(t.audit.assessmentContext)}</h3><p class="muted">${escapeHtml(t.audit.assessmentContextNote)}</p><p>${escapeHtml(assessment.summary)}</p></div>`
    : '';
  const top = audit.aggregate.topThree ?? [];
  const remaining = audit.aggregate.remaining ?? [];
  const patterns = audit.aggregate.selfDefeatingPatterns ?? [];
  const strengths = audit.aggregate.strengths ?? [];
  const automation = audit.aggregate.automationCandidates ?? [];
  const leverage = audit.aggregate.highestLeverageChange;
  const leverageHtml = leverage
    ? `<section id="user-audit-leverage" data-extension-section="user_audit_leverage"><h2>${escapeHtml(t.audit.leverage)}</h2><p class="muted">${escapeHtml(t.audit.leverageLead)}</p><article class="prose-card"><h3>${escapeHtml(leverage.change)}</h3><p>${escapeHtml(leverage.rationale)}</p>${renderItemEvidence(leverage, evidenceSessions, t, index)}${leverage.copyablePrompt ? `<p><strong>${escapeHtml(t.audit.trySaying)}</strong></p>${copyBlock(leverage.copyablePrompt)}` : ''}</article></section>`
    : `<section id="user-audit-leverage" data-extension-section="user_audit_leverage"><h2>${escapeHtml(t.audit.leverage)}</h2><div class="empty">${escapeHtml(t.audit.noSupportedChange)}</div></section>`;
  return [
    leverageHtml,
    `<section id="three-hard-truths" data-extension-section="user_audit"><h2>${escapeHtml(t.audit.threeHardTruths)}</h2><p class="muted">${escapeHtml(t.audit.threeHardTruthsLead)}</p><p class="muted">${escapeHtml(t.audit.sourceValidationNote)}</p>${assessmentHtml}${sectionCards(top, (finding) => renderFindingCard(finding, evidenceSessions, t, index), t)}</section>`,
    `<section id="user-audit-all" data-extension-section="user_audit_all"><h2>${escapeHtml(t.audit.allFindings)}</h2><p class="muted">${escapeHtml(t.audit.allFindingsLead)}</p>${sectionCards(remaining, (finding) => renderFindingCard(finding, evidenceSessions, t, index), t)}</section>`,
    `<section id="user-audit-self-defeating" data-extension-section="user_audit_self_defeating"><h2>${escapeHtml(t.audit.selfDefeating)}</h2><p class="muted">${escapeHtml(t.audit.selfDefeatingLead)}</p>${sectionCards(patterns, (item) => renderSelfDefeatingCard(item, evidenceSessions, t, index), t)}</section>`,
    `<section id="user-audit-strengths" data-extension-section="user_audit_strengths"><h2>${escapeHtml(t.audit.strengths)}</h2><p class="muted">${escapeHtml(t.audit.strengthsLead)}</p>${sectionCards(strengths, (item) => renderStrengthCard(item, evidenceSessions, t, index), t)}</section>`,
    `<section id="user-audit-automation" data-extension-section="user_audit_automation"><h2>${escapeHtml(t.audit.automation)}</h2><p class="muted">${escapeHtml(t.audit.automationLead)}</p>${sectionCards(automation, (item) => renderAutomationCard(item, t, evidenceSessions, index), t)}</section>`
  ].join('');
}

function renderEfficiency(report, t) {
  const eff = report.efficiency;
  if (!eff || !eff.sessions?.length) return '';
  const labels = t.efficiency;
  const fmt = (v) => v === null || v === undefined ? '—' : String(v);
  const agg = eff.aggregates;
  const th = eff.thresholds;
  const hasPartial = eff.sessions.some((s) => Object.values(s.coverage).some((c) => !c));
  const partialNote = hasPartial ? `<p class="muted">${escapeHtml(labels.partial)}</p>` : '';
  const corpusRows = [
    [labels.clarificationDensity, agg.clarificationDensity, th.clarificationDensityHigh, labels.clarificationDensityHint],
    [labels.correctionRate, agg.correctionRate, th.correctionRateHigh, labels.correctionRateHint],
    [labels.dominantToolShare, agg.dominantToolShare, th.dominantToolShareHigh, labels.dominantToolShareHint],
    [labels.turnsPerHour, agg.turnsPerHour, th.turnsPerHourLow, labels.turnsPerHourHint],
    [labels.verificationGap, { mean: agg.verificationGapRate, median: null }, th.verificationGapRateHigh, labels.verificationGapHint]
  ];
  const corpusHtml = `<table class="efficiency-table"><thead><tr><th>${escapeHtml(labels.signal)}</th><th>${escapeHtml(labels.mean)}</th><th>${escapeHtml(labels.median)}</th><th>${escapeHtml(labels.threshold)}</th></tr></thead><tbody>${corpusRows.map(([name, stats, threshold]) => {
    const mean = stats ? fmt(stats.mean) : '—';
    const median = stats ? fmt(stats.median) : '—';
    const thVal = fmt(threshold);
    return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(mean)}</td><td>${escapeHtml(median)}</td><td>${escapeHtml(thVal)}</td></tr>`;
  }).join('')}</tbody></table>`;
  const hintsHtml = corpusRows.map(([, , , hint]) => hint ? `<p class="muted efficiency-hint">${escapeHtml(hint)}</p>` : '').join('');
  const flagged = eff.flagged ?? [];
  const sessionLabel = (index) => {
    const session = eff.sessions[index];
    return session?.sessionId ? `${session.source ?? '?'} · ${session.sessionId}` : `#${index + 1}`;
  };
  const signalLabels = { clarification_density: labels.clarificationDensity, correction_rate: labels.correctionRate, dominant_tool_share: labels.dominantToolShare, turns_per_hour: labels.turnsPerHour, verification_gap: labels.verificationGap };
  const flaggedHtml = flagged.length
    ? `<h3>${escapeHtml(labels.flagged)}</h3>${flagged.map((f) => `<article class="prose-card efficiency-flag"><h4>${escapeHtml(sessionLabel(f.index))}</h4><ul>${f.issues.map((issue) => `<li><strong>${escapeHtml(signalLabels[issue.signal] ?? issue.signal)}</strong>: ${escapeHtml(fmt(issue.value))} <span class="muted">(${escapeHtml(labels.threshold)} ${escapeHtml(fmt(issue.threshold))})</span></li>`).join('')}</ul></article>`).join('')}`
    : `<p class="muted">${escapeHtml(labels.noFlags)}</p>`;
  return `<section id="efficiency-signals" data-extension-section="efficiency"><h2>${escapeHtml(labels.heading)}</h2><p class="muted">${escapeHtml(labels.lead)}</p>${partialNote}${corpusHtml}${hintsHtml}${flaggedHtml}</section>`;
}

function sourceTable(report, zh = false) {
  const rows = Object.entries(report.sources).map(([source, stats]) => `| ${source} | ${number(stats.sessions)} | ${number(stats.userMessages)} | ${number(stats.assistantMessages)} | ${number(stats.toolCalls)} | ${number(stats.toolErrors)} |`);
  return rows.length
    ? [zh ? '| Agent | 会话 | 用户轮次 | 助手轮次 | 工具调用 | 工具错误 |' : '| Agent | Sessions | User turns | Assistant turns | Tool calls | Tool errors |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n')
    : zh ? '_未发现兼容的本地会话。_' : '_No compatible local sessions were found._';
}

function requestedWindowLabel(report, locale = normalizeLocale(report.locale)) {
  const zh = locale === 'zh';
  const range = report.coverage.requestedRange;
  if (range?.start && range?.end) return zh
    ? `${range.start} 至 ${range.end}（UTC，起止日期整日）`
    : `${range.start} to ${range.end} (UTC, both full calendar days)`;
  const selected = typeof report.coverage.selectedAt === 'string' ? Date.parse(report.coverage.selectedAt) : NaN;
  const selectedAt = Number.isFinite(selected) ? new Date(selected).toISOString() : null;
  const all = report.coverage.requestedDays === 'all available';
  if (all) return selectedAt
    ? zh ? `全部可用的本地历史，截至 ${selectedAt}（UTC）` : `All available local history through ${selectedAt} (UTC)`
    : zh ? '全部可用的本地历史（筛选时点未记录，无法确认截止时点）' : 'All available local history (selection time was not recorded; the cutoff is unknown)';
  const days = report.coverage.requestedDays;
  if (selectedAt && Number.isFinite(Number(days)) && Number(days) >= 0) {
    const start = new Date(selected - Number(days) * 86_400_000);
    if (Number.isFinite(start.getTime())) return zh
      ? `${days} 天滚动范围：${start.toISOString()} 至 ${selectedAt}（UTC，以筛选时点为准）`
      : `${days}-day rolling range: ${start.toISOString()} to ${selectedAt} (UTC, anchored to selection time)`;
  }
  return zh
    ? `${days} 天滚动范围（筛选时点未记录，无法还原精确边界）`
    : `${days}-day rolling range (selection time was not recorded; exact boundaries are unknown)`;
}

function timeScopeNote(report, locale) {
  const zh = locale === 'zh';
  const { start, end } = report.dateRange ?? {};
  const actual = start && end ? zh ? `${start} 至 ${end}` : `${start} to ${end}` : zh ? '没有入选会话' : 'No selected sessions';
  return zh
    ? `请求时间范围：${requestedWindowLabel(report, locale)}。实际入选会话日期：${actual}（会话开始日期）。按会话最后记录时间判断是否入选；入选后分析整段会话，不按消息时间裁剪。`
    : `Requested time range: ${requestedWindowLabel(report, locale)}. Actual selected session dates: ${actual} (session start dates). Sessions are selected by their last recorded activity; the entire selected session is analyzed, without filtering individual messages by time.`;
}

function coverageTable(report, locale = reportChrome(report).locale) {
  const rows = report.coverage.sourcesScanned.map((source) => `| ${escapeMarkdown(source.source)} | ${escapeMarkdown(coverageLabel(source.coverage, locale))} | ${coverageNumber(source.filesFound)} | ${coverageNumber(source.filesWithinWindow)} | ${coverageNumber(source.filesSelected)} | ${coverageNumber(source.filesLimited)} | ${coverageNumber(source.filesPartial)} | ${coverageNumber(source.filesSkipped)} | ${escapeMarkdown(coverageNotes(source, report, locale))} |`);
  return rows.length
    ? [locale === 'zh' ? '| 来源 | 覆盖 | 发现 | 时间范围内 | 选用 | 截断 | 部分 | 跳过 | 备注 |' : '| Source | Coverage | Found | Window | Selected | Limited | Partial | Skipped | Notes |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |', ...rows].join('\n')
    : locale === 'zh' ? '_未执行来源探测。_' : '_No source probes ran._';
}

export function renderMarkdown(report) {
  const zh = normalizeLocale(report.locale) === 'zh';
  const label = (en, cn) => zh ? cn : en;
  const range = report.dateRange.start ? `${report.dateRange.start} ${zh ? '至' : 'to'} ${report.dateRange.end}` : label('No eligible sessions', '没有合格会话');
  const metricLabels = zh ? ['会话', '用户轮次', '助手轮次', '工具调用', '工具错误', '轮次失败'] : ['Sessions', 'User turns', 'Assistant turns', 'Tool calls', 'Tool errors', 'Turn failures'];
  const metrics = [
    ['Sessions', report.totals.sessions],
    ['User turns', report.totals.userMessages],
    ['Assistant turns', report.totals.assistantMessages],
    ['Tool calls', report.totals.toolCalls],
    ['Tool errors', report.totals.toolErrors],
    ['Turn failures', report.totals.turnFailures]
  ];
  const list = (items) => items.map((item) => `- **${item.title}:** ${item.detail}`).join('\n');
  const ranked = (items) => items.length ? items.map((item) => `- ${escapeMarkdown(item.name)}: ${number(item.count)}`).join('\n') : label('- No data', '- 暂无数据');
  const coach = buildCoachSummary(report);
  const coachSection = coach
    ? [
      `## ${label('This run’s one change', '这次只改这一件')}`,
      '',
      `- **${label('Change', '改动')}:** ${escapeMarkdown(coach.title)}`,
      coach.detail ? `- **${label('Why', '原因')}:** ${escapeMarkdown(coach.detail)}` : null,
      coach.copyablePrompt ? `- **${label('Try saying', '下次可以这样说')}:** ${escapeMarkdown(coach.copyablePrompt)}` : null,
      renderCoachFindingsMarkdown(coach.findings, { t: reportChrome(report, { prose: true }).t, escape: escapeMarkdown, sessions: report.semantic?.sessions ?? [], locatorLabel: evidenceLocatorLabel, index: buildEvidenceIndex(report) }),
      coach.automationName ? `- **${label('Automation candidate', '可自动化候选')}:** ${escapeMarkdown(coach.automationName)}` : null,
      ''
    ].filter((line) => line !== null).join('\n')
    : '';
  const chrome = reportChrome(report, { prose: true });
  const semantic = renderSemanticMarkdown(report, { t: chrome.t, escape: escapeMarkdown, locatorLabel: evidenceLocatorLabel, responseBuckets: responseTimeBuckets });
  const eff = report.efficiency;
  const labels = chrome.t.efficiency;
  const effSection = eff && eff.sessions?.length
    ? [`## ${labels.heading}`, '', labels.lead, '',
        ...eff.sessions.map((s, i) => `- **${escapeMarkdown(s.sessionId ? `${s.source ?? '?'} · ${s.sessionId}` : `Session #${i + 1}`)}:** ${labels.clarificationDensity} ${s.clarificationDensity ?? '—'} · ${labels.correctionRate} ${s.correctionRate ?? '—'} · ${labels.dominantToolShare} ${s.dominantToolShare ?? '—'} (${escapeMarkdown(s.dominantTool ?? '?')}) · ${labels.turnsPerHour} ${s.turnsPerHour ?? '—'} · ${labels.verificationGap} ${s.verificationGap ?? '—'}`),
        '', labels.verificationGapHint,
        ...(eff.flagged?.length ? ['', `**${labels.flagged}:** ${eff.flagged.map((f) => escapeMarkdown(eff.sessions[f.index]?.sessionId ?? `#${f.index + 1}`)).join(', ')}`] : []), ''].join('\n')
    : '';
  const nextMoves = report.semantic?.enabled || Object.keys(report.semantic?.sections ?? {}).length ? '' : `## ${label('Next moves', '后续建议')}\n\n${list(report.recommendations)}\n\n`;
  const markdown = `# Agent Insight\n\n${label('Actual session dates', '实际会话日期')}: ${escapeMarkdown(range)} · ${escapeMarkdown(requestedWindowLabel(report))}\n\n${coachSection}${semantic}## ${label('Sample counts', '样本计数')}\n\n${metrics.map(([, value], index) => `- **${metricLabels[index]}:** ${number(value)}`).join('\n')}\n\n## ${label('Agent coverage', 'Agent 覆盖')}\n\n${sourceTable(report, zh)}\n\n## ${label('Read coverage', '读取覆盖')}\n\n${escapeMarkdown(timeScopeNote(report, chrome.locale))}\n\n${escapeMarkdown(projectFilterNote(report, chrome.locale))} ${escapeMarkdown(semanticFailureNote(report, chrome.locale))}\n\n${coverageTable(report, chrome.locale)}\n\n${renderTokenUsageMarkdown(report, { locale: chrome.locale, escape: escapeMarkdown })}## ${label('Project areas', '项目领域')}\n\n${ranked(report.projects)}\n\n## ${label('Top tools', '常用工具')}\n\n${ranked(report.topTools)}\n\n## ${label('Providers', '提供商')}\n\n${ranked(report.providers)}\n\n## ${label('Models', '模型')}\n\n${ranked(report.models)}\n\n${effSection}## ${label('Metadata observations', '元数据观察')}\n\n${list(report.observations)}\n\n${nextMoves}## ${label('Evidence policy', '证据策略')}\n\n${report.privacy.note}\n`;
  return markdown;
}

export function renderAgentPrompt(report) {
  const coach = buildCoachSummary(report);
  const language = normalizeLocale(report.locale) === 'zh' ? 'Simplified Chinese (简体中文)' : 'English';
  const coachBlock = coach
    ? [
      '',
      'Coach summary for this run (lead with this):',
      `- One change: ${coach.title}`,
      coach.detail ? `- Why: ${coach.detail}` : null,
      ...coach.quotations.map((quote) => `- Supporting quotation for the change: ${JSON.stringify(quote)}`),
      ...coach.locators.map((locator) => `- Supporting locator for the change: ${evidenceLocatorLabel(locator, report.semantic?.sessions ?? [], reportChrome(report, { prose: true }).t)}`),
      coach.copyablePrompt ? `- Paste-ready rewrite: ${coach.copyablePrompt}` : null,
      ...coach.findings.flatMap((finding) => findingNarrativeLines(finding, report).map((line) => `- ${line}`)),
      coach.automationName ? `- Top automation candidate (advisory only, do not write files unless the user asks): ${coach.automationName}` : null,
      ''
    ].filter((line) => line !== null).join('\n')
    : '\n';
  return `# Agent Insights narrative handoff\n\nRead \`report.md\` in this same directory, then give the user a concise personalized review in ${language}.${coachBlock}Rules:\n\n- Lead with the evidence-supported highest-leverage change, when present. A completed audit with no change means the evidence does not support prescribing one; do not manufacture advice. When the audit is missing or incomplete, leave baseline quick-win prose in the overview; do not promote it into a prescribed one-change action. Do not open with metrics.\n- Examine the quotations and message locators before repeating any finding. Explain the observed behavior and its limits in your own neutral words; do not copy accusations as established facts. Keep evidence-backed strengths and uncertainty visible.\n- Preserve assessed background from the audit as derived analysis, not original evidence. Keep reasons for no findings, counterevidence, resolved misunderstandings, and changes justified by new information or exploration; do not resurrect withdrawn accusations from isolated quotations.\n- Treat every count as metadata, not proof of intent, satisfaction, or quality.\n- Clearly separate measured facts from your inference. Quotation checks validate message provenance; they do not prove the model interpretation or causal attribution. Citation counts describe quoted evidence coverage, never how often a habit occurs.\n- Representative quotations, project paths, transcript paths, and session identifiers in the report are intentional evidence labels; do not treat them as a complete transcript dump.\n- Check **Read coverage / 读取覆盖** first; do not compare or generalize from a partial, unavailable, root-only, or experimental source as if it were complete.\n- Prefer one concrete paste-ready rewrite over a long list of advice. Automation candidates stay advisory unless the user asks you to write a Skill/command.\n- Avoid vendor-specific advice unless the report shows that source.\n\nCurrent coverage: ${report.totals.sessions} sessions across ${Object.keys(report.sources).length} detected agent sources.\n`;
}

function evidence(ids, index, t) {
  const labels = evidenceNavigationLabels(t.htmlLang);
  if (!ids?.length) return `<p class="evidence missing">${escapeHtml(labels.noReference)}</p>`;
  const links = ids.map((id) => {
    const resolved = index.resolve(id);
    if (resolved.status !== 'resolved') return `${escapeHtml(id)} · ${escapeHtml(labels[resolved.status])}`;
    const { entry } = resolved;
    const session = entry.session;
    const label = [session.sessionId ?? entry.id, session.source, session.date, session.projectPath || session.projectLabel].filter(Boolean).join(' · ');
    return `<a href="#${index.anchor(entry)}">${escapeHtml(label)}</a>`;
  });
  return `<p class="evidence">${escapeHtml(labels.sessionSupport)}: ${links.join('; ')}</p>`;
}

function renderTokenUsageHtml(report) {
  const view = tokenUsagePresentation(report, reportChrome(report).locale);
  if (!view) return '';
  const { labels } = view;
  return `<div class="token-usage-coverage"><h3>${escapeHtml(labels.heading)}</h3><p>${escapeHtml(view.status)} · ${escapeHtml(view.summary)}</p><div class="table-wrap"><table><thead><tr>${[labels.kind, labels.subtotal, labels.detail].map((label) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead><tbody>${view.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p><strong>${escapeHtml(labels.total)}:</strong> ${escapeHtml(view.total)}</p><p class="muted">${escapeHtml(view.notes.join(' '))}</p></div>`;
}

function renderEvidenceGrounding(report) {
  const { t, locale } = reportChrome(report);
  const index = buildEvidenceIndex(report);
  const labels = evidenceNavigationLabels(locale);
  return `<p class="muted">${escapeHtml(labels.supportScope)} ${escapeHtml(t.audit.sourceValidationNote)}</p>` + index.entries.map((entry) => {
    const session = entry.session;
    const title = [session.sessionId ?? entry.id, session.source, session.date, session.projectPath || session.projectLabel].filter(Boolean).join(' · ');
    const items = entry.grounding.map((item, position) => {
      const description = item.description ? `<p class="grounding-description"><strong>${locale === 'zh' ? '证据说明：' : 'Evidence description:'}</strong> ${escapeHtml(item.description)}</p>` : '';
      const quotation = item.quotation ? `<blockquote>${escapeHtml(item.quotation)}</blockquote>` : '';
      const locator = { sessionId: entry.id, messageIndexes: item.messageIndexes ?? [] };
      return `<article id="${index.groundingAnchor(entry, position)}" class="panel">${description}${quotation}<p class="evidence">${escapeHtml(evidenceLocatorLabel(locator, index.entries.map((value) => value.session), t))}</p></article>`;
    }).join('') || `<p class="empty">${escapeHtml(labels.noGrounding)}</p>`;
    return `<div id="${index.anchor(entry)}" class="evidence-session"><h3>${escapeHtml(title)}</h3>${items}</div>`;
  }).join('');
}

function entries(value, order) {
  const items = Object.entries(value ?? {}).filter(([, count]) => Number(count) > 0);
  if (order) return order.flatMap((name) => value?.[name] ? [[name, value[name]]] : []);
  return items.sort(([, left], [, right]) => right - left).slice(0, 6);
}

function barChart(label, value, { order, t, domain } = {}) {
  const nameLabel = (name) => domain ? taxonomyLabel(domain, name, t?.htmlLang) : name;
  const items = Array.isArray(value) ? value : entries(value, order);
  const fmt = (n) => number(n, t?.numberLocale ?? 'en-US');
  const emptyLabel = {
    'Response time distribution': t?.sections.noResponseTimeData,
    'Time of day': t?.sections.noTimeData,
    'Tool errors': t?.sections.noToolErrors
  }[label] ?? t?.sections.noData ?? 'No data';
  if (!items.length) return `<div class="empty">${escapeHtml(emptyLabel)}</div><table class="sr-only" aria-label="${escapeHtml(label)} data"><tbody></tbody></table>`;
  const maximum = Math.max(1, ...items.map(([, count]) => Number(count)));
  return `<div class="bar-chart">${items.map(([name, count], index) => `<div class="bar-row" data-bar="${(index % 5) + 1}"><span>${escapeHtml(nameLabel(name))}</span><div class="bar-track"><i style="width:${Math.round((Number(count) / maximum) * 100)}%"></i></div><strong class="num">${fmt(count)}</strong></div>`).join('')}</div><table class="sr-only" aria-label="${escapeHtml(label)} data"><thead><tr><th>Label</th><th>Count</th></tr></thead><tbody>${items.map(([name, count]) => `<tr><td>${escapeHtml(nameLabel(name))}</td><td>${fmt(count)}</td></tr>`).join('')}</tbody></table>`;
}

function responseTimeBuckets(values) {
  if (!values?.length) return [];
  const buckets = [
    ['2–10s', 2, 10], ['10–30s', 10, 30], ['30s–1m', 30, 60], ['1–2m', 60, 120],
    ['2–5m', 120, 300], ['5–15m', 300, 900], ['>15m', 900, Infinity]
  ];
  return buckets.map(([label, minimum, maximum]) => [label, (values ?? []).filter((value) => value >= minimum && value < maximum).length]);
}

function timeOfDayBuckets(messageHours, t) {
  const total = (minimum, maximum) => Object.entries(messageHours ?? {}).reduce((sum, [hour, count]) => {
    const value = Number(hour);
    return sum + (value >= minimum && value < maximum ? Number(count) : 0);
  }, 0);
  const buckets = [
    [t?.sections.morning ?? 'Morning', total(6, 12)],
    [t?.sections.afternoon ?? 'Afternoon', total(12, 18)],
    [t?.sections.evening ?? 'Evening', total(18, 24)],
    [t?.sections.night ?? 'Night', total(0, 6)]
  ];
  return buckets.some(([, count]) => count > 0) ? buckets : [];
}

function proseCard(title, text, t) {
  return `<article class="prose-card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text ?? t?.sections.analysisUnavailable ?? 'Analysis unavailable.')}</p></article>`;
}

function sectionCards(items, renderer, t) {
  return items?.length ? `<div class="card-grid">${items.map(renderer).join('')}</div>` : `<div class="empty">${escapeHtml(Array.isArray(items) ? t?.sections.noSupportedItems ?? 'Analysis completed; no supported items.' : t?.sections.sectionUnavailable ?? 'This section is unavailable for the current coverage.')}</div>`;
}

function reportSkinCss() {
  return `:root{
  color-scheme:light;
  --toc-height:52px;
  --bg:#FBFAF7;--ink:#1A1A1A;--accent:#0E6E6E;--hair:#E7E3DA;--mute:#6B6459;
  --soft:#F4F1EA;--softer:#F8F6F1;--bull:#1F9D55;--bear:#D6453D;
  --bar-1:#0E6E6E;--bar-2:#6B7FD7;--bar-3:#5B6B7A;--bar-4:#C4A35A;--bar-5:#8B6B9E;
  --serif:"Source Serif 4","Noto Serif SC",Georgia,"Songti SC",serif;
  --sans:"Inter","Noto Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --muted:var(--mute);--panel:var(--softer);--line:var(--hair)
}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:calc(var(--toc-height) + 16px)}
body{margin:0 auto;max-width:960px;padding:0 22px 80px;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16.5px;line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
.num,.metric strong,td.n{font-family:var(--mono);font-variant-numeric:tabular-nums}
header.mast{padding:42px 0 22px;border-bottom:1px solid var(--hair)}
.eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:2.2px;text-transform:uppercase;color:var(--accent);font-weight:600;margin:0 0 12px}
header.mast h1{font-family:var(--serif);font-weight:700;font-size:34px;line-height:1.25;margin:0 0 10px;letter-spacing:.2px}
header.mast .subtitle{font-family:var(--serif);font-style:italic;font-size:17.5px;color:var(--mute);line-height:1.5;margin:0 0 14px}
header.mast .meta-line{font-size:13px;color:var(--mute);margin:0 0 10px}
h2{font-family:var(--serif);font-weight:600;font-size:22px;margin:36px 0 14px;line-height:1.3;letter-spacing:.1px}
h3{font-family:var(--serif);font-weight:600;font-size:16px;margin:0 0 8px}
.muted,.evidence,.panel-title{color:var(--mute)}
.evidence{font-size:12.5px;margin-top:12px}
section{padding:8px 0 28px;border-bottom:1px solid var(--hair)}
section:last-of-type{border-bottom:0}
.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;margin:22px 0;border:1px solid var(--hair);background:var(--softer)}
.metric{padding:13px 14px;border-right:1px solid var(--hair);background:transparent;border-radius:0}
.metric:last-child{border-right:0}
.metric span{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--mute);font-weight:500}
.metric strong{display:block;font-size:21px;font-weight:600;margin-top:5px;letter-spacing:-.3px;color:var(--ink)}
.panel,.prose-card,.insight-card{background:var(--softer);border:1px solid var(--hair);border-radius:2px;padding:16px 16px 14px}
.glance,.card-grid,.two-col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.insight-card p,.prose-card p,.panel>p{line-height:1.65;color:var(--ink);margin:0}
.panel-title{font-family:var(--serif);font-size:15px;font-weight:600;color:var(--ink);margin-bottom:10px}
.bar-row{display:grid;grid-template-columns:minmax(88px,1fr) 3fr auto;gap:12px;align-items:center;margin:11px 0;font-size:13px}
.bar-track{height:10px;border-radius:2px;background:#EDE9E0;overflow:hidden}
.bar-track i{display:block;height:100%;border-radius:2px;background:var(--bar-1)}
.bar-row[data-bar="2"] .bar-track i{background:var(--bar-2)}
.bar-row[data-bar="3"] .bar-track i{background:var(--bar-3)}
.bar-row[data-bar="4"] .bar-track i{background:var(--bar-4)}
.bar-row[data-bar="5"] .bar-track i{background:var(--bar-5)}
.bar-row strong{font-family:var(--mono);font-size:12.5px;font-weight:600}
.empty{padding:16px 18px;color:var(--mute);border:1px dashed var(--hair);border-radius:2px;background:var(--soft)}
.callout{padding:14px 16px;border:1px solid var(--hair);border-left:3px solid var(--accent);background:var(--soft);border-radius:0 2px 2px 0;margin:14px 0}
.copy{font-family:var(--mono);font-size:.9em;background:var(--soft);border:1px solid var(--hair);padding:12px;border-radius:2px;white-space:pre-wrap}
.table-wrap{overflow:auto;margin:14px 0;border:1px solid var(--hair);border-radius:2px}
table:not(.sr-only){width:100%;border-collapse:collapse;background:var(--softer);font-size:14px}
td,th{padding:10px 12px;text-align:left;border-bottom:1px solid var(--hair);vertical-align:top}
th{background:var(--soft);color:var(--ink);font-weight:600;font-size:12.5px;border-bottom:1px solid var(--accent)}
tbody tr:last-child td{border-bottom:0}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.status{display:inline-flex;align-items:center;padding:4px 9px;border-radius:2px;border:1px solid var(--hair);background:var(--soft);color:var(--accent);font-family:var(--mono);font-size:11.5px;letter-spacing:.4px}
.status.partial{color:#9A6B16;border-color:#E2D2A8;background:#F7F0DE}
nav.toc{position:sticky;top:0;z-index:100;display:flex;flex-wrap:nowrap;align-items:center;gap:4px 16px;margin:0 -22px;padding:0 22px;min-height:var(--toc-height);background:rgba(251,250,247,.96);border-bottom:1px solid var(--hair);backdrop-filter:saturate(115%) blur(10px);-webkit-backdrop-filter:saturate(115%) blur(10px);overflow-x:auto;scrollbar-width:none}
nav.toc::-webkit-scrollbar{display:none}
nav.toc .wordmark{font-family:var(--serif);font-weight:700;font-size:15px;color:var(--ink);margin-right:8px;white-space:nowrap;flex:none}
nav.toc .wordmark span{color:var(--accent)}
nav.toc a,nav.toc span{color:var(--mute);font-family:var(--mono);font-size:11.5px;letter-spacing:.3px;padding:0;border:0;background:transparent;border-radius:0;text-decoration:none;white-space:nowrap;min-height:44px;display:inline-flex;align-items:center}
nav.toc a:hover{color:var(--accent)}
nav.toc span{opacity:.55}
nav.toc .coach-links{display:inline-flex;gap:4px 16px;margin-left:8px;padding-left:16px;border-left:1px solid var(--hair)}
.coach-action{margin:18px 0 8px}
.timezone{display:flex;gap:10px;align-items:center;color:var(--mute);font-size:12.5px;margin-bottom:12px;font-family:var(--mono)}
.timezone select{background:var(--bg);color:var(--ink);border:1px solid var(--hair);border-radius:2px;padding:6px 8px;font-family:var(--sans)}
blockquote{margin:12px 0;padding:10px 14px;border-left:3px solid var(--accent);background:var(--soft);color:var(--ink);font-family:var(--serif);font-style:italic}
.mermaid{background:var(--softer);border:1px solid var(--hair);border-radius:2px;padding:18px;margin:18px 0;overflow-x:auto}
@media(max-width:760px){
  body{padding:0 16px 64px;font-size:15.5px}
  header.mast h1{font-size:27px}
  .metrics{grid-template-columns:repeat(2,minmax(0,1fr))}
  .metric:nth-child(2n){border-right:0}
  .metric{border-bottom:1px solid var(--hair)}
  .metric:last-child:nth-child(odd){grid-column:1/-1}
  .glance,.card-grid,.two-col{grid-template-columns:1fr}
  nav.toc{margin:0 -16px;padding:0 16px}
}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
@media print{nav.toc{position:static;backdrop-filter:none}body{max-width:none}}`;
}

function mermaidBootScript() {
  return `<script>(()=>{const nodes=document.querySelectorAll('.mermaid');if(!nodes.length)return;const load=()=>{const s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js';s.onload=()=>{window.mermaid.initialize({startOnLoad:false,theme:'neutral',securityLevel:'strict'});window.mermaid.run({nodes:[...nodes]})};document.head.appendChild(s)};if('requestIdleCallback' in window)requestIdleCallback(load,{timeout:2000});else setTimeout(load,0)})();</script>`;
}

function renderHtmlLegacy(report) {
  const chrome = reportChrome(report);
  const { brandTitle, htmlLang, t } = chrome;
  const fmt = (value) => number(value, t.numberLocale);
  const insights = report.insights ?? {};
  const semantic = report.semantic?.sections ?? {};
  const index = buildEvidenceIndex(report);
  const ev = (ids) => evidence(ids, index, t);
  const glance = semantic.at_a_glance ?? {};
  const projectAreas = semantic.project_areas?.areas ?? [];
  const interaction = semantic.interaction_style ?? {};
  const working = semantic.what_works ?? {};
  const friction = semantic.friction_analysis ?? {};
  const suggestions = semantic.suggestions ?? {};
  const horizon = semantic.on_the_horizon ?? {};
  const ending = semantic.fun_ending ?? {};
  const range = insights.dateRange?.start ? `${insights.dateRange.start} to ${insights.dateRange.end}` : t.noEligibleSessions;
  const discoveredSuffix = (insights.totalSessionsScanned ?? 0) > (insights.totalSessions ?? 0)
    ? (chrome.locale === 'zh' ? `（共 ${fmt(insights.totalSessionsScanned)} 个）` : ` (${fmt(insights.totalSessionsScanned)} total)`)
    : '';
  const subtitle = t.subtitle(fmt(insights.totalMessages ?? 0), fmt(insights.totalSessions ?? 0), discoveredSuffix, range);
  const metricDefs = [
    ['Messages', insights.totalMessages ?? 0],
    ['Lines', `+${fmt(insights.totalLinesAdded ?? 0)}/-${fmt(insights.totalLinesRemoved ?? 0)}`],
    ['Files', insights.totalFilesModified ?? 0],
    ['Days', insights.daysActive ?? 0],
    ['Msgs/Day', insights.messagesPerDay ?? 0]
  ];
  const statCards = metricDefs.map(([key, value]) => `<article class="metric"><span>${escapeHtml(t.metrics[key])}</span><strong>${escapeHtml(typeof value === 'number' ? fmt(value) : value)}</strong></article>`).join('');
  const coverageRows = (report.coverage?.sourcesScanned ?? []).map((source) => `<tr><td>${escapeHtml(source.source)}</td><td>${escapeHtml(coverageLabel(source.coverage, reportChrome(report).locale))}</td><td>${coverageNumber(source.filesFound)}</td><td>${coverageNumber(source.filesSelected)}</td><td>${coverageNumber(source.filesLimited)}</td><td>${coverageNumber(source.filesPartial)}</td><td>${coverageNumber(source.filesSkipped)}</td><td>${escapeHtml(coverageNotes(source, report))}</td></tr>`).join('') || `<tr><td colspan="8">${escapeHtml(t.sections.noSourceProbes)}</td></tr>`;
  const outcomeOrder = ['not_achieved', 'partially_achieved', 'mostly_achieved', 'fully_achieved', 'unclear_from_transcript'];
  const satisfactionOrder = ['frustrated', 'dissatisfied', 'likely_satisfied', 'satisfied', 'happy', 'unsure'];
  const brandParts = brandTitle.split(/\s+/);
  const wordmark = brandParts.length > 1
    ? `${escapeHtml(brandParts.slice(0, -1).join(' '))}<span>${escapeHtml(brandParts.at(-1))}</span>`
    : `<span>${escapeHtml(brandTitle)}</span>`;
  const toc = `<nav class="toc" aria-label="${escapeHtml(t.navAria ?? t.tocAria)}"><div class="wordmark">${wordmark}</div><a href="#what-you-work-on">${escapeHtml(t.toc.whatYouWorkOn)}</a><a href="#how-you-use">${escapeHtml(t.toc.howYouUse)}</a><a href="#impressive-things">${escapeHtml(t.toc.impressiveThings)}</a><a href="#where-things-go-wrong">${escapeHtml(t.toc.whereThingsGoWrong)}</a><a href="#features-to-try">${escapeHtml(t.toc.featuresToTry)}</a><a href="#new-usage-patterns">${escapeHtml(t.toc.newUsagePatterns)}</a><a href="#on-the-horizon">${escapeHtml(t.toc.onTheHorizon)}</a><span aria-disabled="true">${escapeHtml(t.toc.teamFeedback)}</span><div class="coach-links" data-extension-toc><a href="#coach-primary-action">${escapeHtml(t.tocCoach.primaryAction)}</a><a href="#three-hard-truths">${escapeHtml(t.tocCoach.hardTruths)}</a><a href="#user-audit-leverage">${escapeHtml(t.tocCoach.leverage)}</a><a href="#user-audit-automation">${escapeHtml(t.tocCoach.automation)}</a><a href="#evidence-index">${escapeHtml(t.tocCoach.evidence)}</a></div></nav>`;
  const utcHours = JSON.stringify(insights.messageHours ?? {});
  const timeChart = `<label class="timezone">${escapeHtml(t.sections.timezone)} <select id="time-zone"><option value="-8">${escapeHtml(t.timezones.pt)}</option><option value="-5">${escapeHtml(t.timezones.et)}</option><option value="0">${escapeHtml(t.timezones.london)}</option><option value="1">${escapeHtml(t.timezones.cet)}</option><option value="9">${escapeHtml(t.timezones.tokyo)}</option><option value="custom">${escapeHtml(t.timezones.custom)}</option></select></label><div id="time-chart" data-utc-hours="${escapeHtml(utcHours)}">${barChart('Time of day', timeOfDayBuckets(insights.messageHours, t), { t })}</div>`;
  const tzPrompt = JSON.stringify(t.timezones.prompt);
  const timezoneScript = `<script>(()=>{const select=document.getElementById('time-zone');const root=document.getElementById('time-chart');if(!select||!root)return;const source=JSON.parse(root.dataset.utcHours||'{}');const rows=[...root.querySelectorAll('.bar-row')];const render=(offset)=>{const counts=[0,0,0,0];for(const [hour,count] of Object.entries(source)){const shifted=(Number(hour)+offset+24)%24;const index=shifted>=6&&shifted<12?0:shifted>=12&&shifted<18?1:shifted>=18?2:3;counts[index]+=Number(count)||0}const maximum=Math.max(1,...counts);rows.forEach((row,index)=>{row.querySelector('strong').textContent=String(counts[index]);row.querySelector('i').style.width=Math.round(counts[index]/maximum*100)+'%'})};const local=-new Date().getTimezoneOffset()/60;const exact=[...select.options].find((option)=>Number(option.value)===local);if(exact)select.value=exact.value;else select.value='custom';render(local);select.addEventListener('change',()=>{let offset=Number(select.value);if(select.value==='custom'){const answer=window.prompt(${tzPrompt},String(local));offset=Number(answer);if(!Number.isFinite(offset)||offset< -12||offset>14){select.value=exact?.value??'custom';offset=local}}render(offset)})})();</script>`;
  const fonts = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&family=Noto+Serif+SC:wght@500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,500;0,8..60,600;0,8..60,700;1,8..60,500&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;
  const css = reportSkinCss();
  return `<!doctype html><html lang="${escapeHtml(htmlLang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#0E6E6E"><title>${escapeHtml(brandTitle)}</title>${fonts}<style>${css}</style></head><body><header class="mast"><div class="eyebrow">${escapeHtml(t.eyebrow)}</div><h1>${escapeHtml(brandTitle)}</h1><p class="subtitle">${escapeHtml(subtitle)}</p><p class="meta-line muted">${escapeHtml(t.analyzer(report.semantic?.analyzer?.host ?? 'local', report.semantic?.analyzer?.model ?? 'unknown'))}</p><span class="status ${report.parity?.structuralStatus === 'complete' ? '' : 'partial'}">${escapeHtml(report.parity?.structuralStatus ?? 'partial')} parity coverage</span></header>${toc}<section class="metrics">${statCards}</section><section><h2>${escapeHtml(t.sections.atAGlance)}</h2><div class="glance">${proseCard(t.sections.whatsWorking, glance.whatsWorking, t)}${proseCard(t.sections.whatsHindering, glance.whatsHindering, t)}${proseCard(t.sections.quickWins, glance.quickWins, t)}${proseCard(t.sections.ambitiousWorkflows, glance.ambitiousWorkflows, t)}</div>${ev(glance.evidenceSessionIds)}</section><section id="what-you-work-on"><h2>${escapeHtml(t.sections.whatYouWorkOn)}</h2>${projectAreas.length ? `<p class="muted">${escapeHtml(t.sections.projectAreaCountsNote)}</p>` : ''}${sectionCards(projectAreas, (area) => `<article class="prose-card"><h3>${escapeHtml(area.name)}</h3><p>${escapeHtml(area.description)}</p><strong>${escapeHtml(Number.isSafeInteger(area.sessionCount) && area.sessionCount >= 0 ? t.sections.estimatedSessionsCount(fmt(area.sessionCount)) : t.sections.projectAreaCountUnknown)}</strong>${ev(area.evidenceSessionIds)}</article>`, t)}</section><section><h2>${escapeHtml(t.sections.whatYouWanted)}</h2><div class="two-col"><div class="panel"><div class="panel-title">${escapeHtml(t.sections.goals)}</div>${barChart('Goal categories', insights.goalCategories, { t, domain: 'goalCategories' })}</div><div class="panel"><div class="panel-title">${escapeHtml(t.sections.topTools)}</div>${barChart('Top tools', insights.toolCounts, { t })}</div></div></section><section><h2>${escapeHtml(t.sections.languages)}</h2><div class="two-col"><div class="panel">${barChart('Languages', insights.languages, { t })}</div><div class="panel"><div class="panel-title">${escapeHtml(t.sections.sessionTypes)}</div>${barChart('Session types', insights.sessionTypes, { t, domain: 'sessionTypes' })}</div></div></section><section id="how-you-use"><h2>${escapeHtml(t.sections.howYouUse)}</h2><article class="panel"><p>${escapeHtml(interaction.narrative ?? t.sections.interactionUnavailable)}</p><div class="callout"><strong>${escapeHtml(interaction.keyPattern ?? t.sections.noKeyPattern)}</strong></div>${ev(interaction.evidenceSessionIds)}</article></section><section><h2>${escapeHtml(t.sections.responseTime)}</h2><div class="panel">${barChart('Response time distribution', responseTimeBuckets(insights.userResponseTimes), { t })}<p class="muted">${escapeHtml(t.sections.medianAverage(coverageNumber(insights.medianResponseTime), coverageNumber(insights.averageResponseTime)))}</p></div></section><section><h2>${escapeHtml(t.sections.multiClauding)}</h2><div class="metrics">${[[t.sections.overlapPairs, insights.multiClauding?.overlapEvents ?? 0], [t.sections.sessionsInvolved, insights.multiClauding?.sessionsInvolved ?? 0], [t.sections.messagesDuringOverlap, insights.multiClauding?.userMessagesDuring ?? 0]].map(([label, value]) => `<article class="metric"><span>${escapeHtml(label)}</span><strong>${fmt(value)}</strong></article>`).join('')}</div></section><section><h2>${escapeHtml(t.sections.timeOfDay)}</h2><div class="two-col"><div class="panel">${timeChart}</div><div class="panel"><div class="panel-title">${escapeHtml(t.sections.toolErrors)}</div>${barChart('Tool errors', insights.toolErrorCategories, { t, domain: 'toolErrorCategories' })}</div></div></section><section id="impressive-things"><h2>${escapeHtml(t.sections.impressiveThings)}</h2><p class="muted">${escapeHtml(working.intro ?? '')}</p>${sectionCards(working.impressiveWorkflows, (workflow) => `<article class="prose-card"><h3>${escapeHtml(workflow.title)}</h3><p>${escapeHtml(workflow.description)}</p>${ev(workflow.evidenceSessionIds)}</article>`, t)}</section><section><h2>${escapeHtml(t.sections.whatHelpedMost)}</h2><div class="two-col"><div class="panel">${barChart(t.sections.primarySuccesses, insights.primarySuccesses ?? insights.helpfulness, { t, domain: insights.primarySuccesses ? 'primarySuccesses' : 'helpfulness' })}</div><div class="panel"><div class="panel-title">${escapeHtml(t.sections.outcomes)}</div>${barChart('Outcomes', insights.outcomes, { order: outcomeOrder, t, domain: 'outcomes' })}</div></div></section><section id="where-things-go-wrong"><h2>${escapeHtml(t.sections.whereThingsGoWrong)}</h2><p class="muted">${escapeHtml(friction.intro ?? '')}</p>${sectionCards(friction.categories, (category) => `<article class="prose-card"><h3>${escapeHtml(category.category)}</h3><p>${escapeHtml(category.description)}</p>${(category.examples ?? []).map((example) => `<div class="callout">${escapeHtml(example.text)}${ev(example.evidenceSessionIds)}</div>`).join('')}</article>`, t)}</section><section><h2>${escapeHtml(t.sections.primaryFriction)}</h2><div class="two-col"><div class="panel">${barChart(t.sections.frictionTypes, insights.friction, { t, domain: 'friction' })}</div><div class="panel"><div class="panel-title">${escapeHtml(t.sections.inferredSatisfaction)}</div>${barChart('Satisfaction', insights.satisfaction, { order: satisfactionOrder, t, domain: 'satisfaction' })}</div></div></section><section id="features-to-try"><h2>${escapeHtml(t.sections.existingFeatures)}</h2><h3>${escapeHtml(t.sections.claudeMdAdditions)}</h3>${sectionCards(suggestions.instructionAdditions, (item) => `<article class="prose-card"><p>${escapeHtml(item.addition)}</p><p class="muted">${escapeHtml(item.why)}</p><div class="copy">${escapeHtml(item.promptScaffold)}</div>${ev(item.evidenceSessionIds)}</article>`, t)}<h3>${escapeHtml(t.sections.featuresToTry)}</h3>${sectionCards(suggestions.featuresToTry, (item) => `<article class="prose-card"><h3>${escapeHtml(item.feature)}</h3><p>${escapeHtml(item.oneLiner)} ${escapeHtml(item.whyForYou)}</p><div class="copy">${escapeHtml(item.exampleCode)}</div>${ev(item.evidenceSessionIds)}</article>`, t)}</section><section id="new-usage-patterns"><h2>${escapeHtml(t.sections.newWays)}</h2>${sectionCards(suggestions.usagePatterns, (item) => `<article class="prose-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.suggestion)} ${escapeHtml(item.detail)}</p><div class="copy">${escapeHtml(item.copyablePrompt)}</div>${ev(item.evidenceSessionIds)}</article>`, t)}</section><section id="on-the-horizon"><h2>${escapeHtml(t.sections.onTheHorizon)}</h2><p class="muted">${escapeHtml(horizon.intro ?? '')}</p>${sectionCards(horizon.opportunities, (item) => `<article class="prose-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.whatsPossible)} ${escapeHtml(item.howToTry)}</p><div class="copy">${escapeHtml(item.copyablePrompt)}</div>${ev(item.evidenceSessionIds)}</article>`, t)}</section><section><h2>${escapeHtml(ending.headline ?? t.sections.memorableMoment)}</h2><article class="panel"><p>${escapeHtml(ending.detail ?? t.sections.noQualitativeMoment)}</p>${ev(ending.evidenceSessionIds)}</article></section><section><h2>${escapeHtml(t.sections.readCoverage)}</h2><p class="muted">${escapeHtml(projectFilterNote(report))}</p><div class="table-wrap"><table><thead><tr><th>${escapeHtml(t.sections.source)}</th><th>${escapeHtml(t.sections.coverage)}</th><th>${escapeHtml(t.sections.found)}</th><th>${escapeHtml(t.sections.selected)}</th><th>${escapeHtml(t.sections.limited)}</th><th>${escapeHtml(t.sections.partial)}</th><th>${escapeHtml(t.sections.skipped)}</th><th>${escapeHtml(t.sections.notes)}</th></tr></thead><tbody>${coverageRows}</tbody></table></div></section>${timezoneScript}${mermaidBootScript()}</body></html>`;
}

function replaceSection(html, startMarker, endMarker, replacement) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end >= 0 ? `${html.slice(0, start)}${replacement}${html.slice(end)}` : html;
}

function sectionBoundsByHeading(html, heading) {
  const headingIndex = html.indexOf(`<h2>${escapeHtml(heading)}</h2>`);
  if (headingIndex < 0) return null;
  const start = html.lastIndexOf('<section', headingIndex);
  const close = html.indexOf('</section>', headingIndex);
  return start >= 0 && close >= 0 ? { start, end: close + '</section>'.length } : null;
}

function removeSectionByHeading(html, heading) {
  const bounds = sectionBoundsByHeading(html, heading);
  return bounds ? `${html.slice(0, bounds.start)}${html.slice(bounds.end)}` : html;
}

function markSemanticSection(html, heading, name) {
  const bounds = sectionBoundsByHeading(html, heading);
  if (!bounds) return html;
  const tagEnd = html.indexOf('>', bounds.start);
  if (tagEnd < 0 || tagEnd > bounds.end) return html;
  return `${html.slice(0, tagEnd)} data-semantic-section="${name}"${html.slice(tagEnd)}`;
}

export function renderHtml(report) {
  const chrome = reportChrome(report);
  const { t } = chrome;
  let html = renderHtmlLegacy(report);
  const structure = report.parity?.structuralStatus ?? 'partial';
  const data = report.parity?.dataStatus ?? 'partial';
  const overallComplete = structure === 'complete' && data === 'complete';
  const legacyBadge = `<span class="status ${structure === 'complete' ? '' : 'partial'}">${escapeHtml(structure)} parity coverage</span>`;
  const coverageText = chrome.locale === 'zh'
    ? `结构覆盖：${taxonomyLabel('analysisStatus', structure, 'zh')} · 数据覆盖：${taxonomyLabel('analysisStatus', data, 'zh')}`
    : overallComplete ? 'complete parity coverage' : `${structure} structure · ${data} data coverage`;
  const badge = `<span class="status ${overallComplete ? '' : 'partial'}">${escapeHtml(coverageText)}</span>`;
  html = html.replace(legacyBadge, badge);
  if (!(report.insights?.multiClauding?.overlapEvents > 0)) {
    html = replaceSection(
      html,
      `<section><h2>${escapeHtml(t.sections.multiClauding)}</h2>`,
      `<section><h2>${escapeHtml(t.sections.timeOfDay)}</h2>`,
      `<section><h2>${escapeHtml(t.sections.multiClauding)}</h2><div class="empty">${escapeHtml(t.sections.noParallel)}</div></section>`
    );
  }
  // Legacy placeholder heading was already localized to whatHelpedMost in renderHtmlLegacy.
  const evidenceRows = (report.semantic?.sessions ?? []).map((session) => {
    const reopen = sessionReopenHint(session) || '—';
    return `<tr><td>${escapeHtml(session.sessionId ?? session.id)}</td><td>${escapeHtml(session.source)}</td><td>${escapeHtml(session.date ?? 'unknown')}</td><td>${escapeHtml(session.projectPath || session.projectLabel || '—')}</td><td><code>${escapeHtml(reopen)}</code></td></tr>`;
  }).join('');
  const evidenceIndex = `<section id="evidence-index"><h2>${escapeHtml(t.sections.evidenceIndex)}</h2><div class="table-wrap"><table><thead><tr><th>${escapeHtml(t.sections.session)}</th><th>${escapeHtml(t.sections.agent)}</th><th>${escapeHtml(t.sections.date)}</th><th>${escapeHtml(t.sections.project)}</th><th>${escapeHtml(t.audit.reopen)}</th></tr></thead><tbody>${evidenceRows || `<tr><td colspan="5">${escapeHtml(t.sections.noEvidenceSessions)}</td></tr>`}</tbody></table></div>${renderEvidenceGrounding(report)}</section>`;
  const userAuditHtml = renderUserAudit(report, t);
  const efficiencyHtml = renderEfficiency(report, t);
  const primaryActionHtml = renderPrimaryAction(report, t);
  html = html.replace(`<section><h2>${escapeHtml(t.sections.readCoverage)}</h2>`, `${userAuditHtml}${efficiencyHtml}${evidenceIndex}<section><h2>${escapeHtml(t.sections.readCoverage)}</h2><p class="muted time-scope">${escapeHtml(timeScopeNote(report, chrome.locale))}</p><p class="muted">${escapeHtml(semanticFailureNote(report))}</p>${renderTokenUsageHtml(report)}`);
  const headerClose = html.indexOf('</header>');
  const headerEnd = headerClose < 0 ? -1 : headerClose + '</header>'.length;
  const tocStart = html.indexOf('<nav class="toc"', headerEnd);
  const tocEnd = html.indexOf('</nav>', tocStart) + '</nav>'.length;
  const metricsStart = html.indexOf('<section class="metrics">', tocEnd);
  const metricsEnd = html.indexOf('</section>', metricsStart) + '</section>'.length;
  const glanceStart = html.indexOf(`<section><h2>${escapeHtml(t.sections.atAGlance)}</h2>`, metricsEnd);
  const nextSection = html.indexOf('<section id="what-you-work-on">', glanceStart);
  if ([headerEnd, tocStart, tocEnd, metricsStart, metricsEnd, glanceStart, nextSection].some((index) => index < 0)) {
    throw new Error('The parity report layout could not be assembled.');
  }
  html = `${html.slice(0, headerEnd)}${html.slice(glanceStart, nextSection)}${primaryActionHtml}${html.slice(tocStart, tocEnd)}${html.slice(metricsStart, metricsEnd)}${html.slice(nextSection)}`;

  const sections = report.semantic?.sections ?? {};
  const sectionFailures = { ...report.semantic?.sectionFailures, ...report.coverage?.sectionFailures };
  const semanticContracts = [
    [t.sections.atAGlance, 'at_a_glance', Boolean(sections.at_a_glance)],
    [t.sections.whatYouWorkOn, 'project_areas', Array.isArray(sections.project_areas?.areas)],
    [t.sections.howYouUse, 'interaction_style', Boolean(sections.interaction_style)],
    [t.sections.impressiveThings, 'what_works', Array.isArray(sections.what_works?.impressiveWorkflows)],
    [t.sections.whereThingsGoWrong, 'friction_analysis', Array.isArray(sections.friction_analysis?.categories)],
    [t.sections.existingFeatures, 'suggestions', Array.isArray(sections.suggestions?.instructionAdditions) || Array.isArray(sections.suggestions?.featuresToTry)],
    [t.sections.newWays, 'suggestions', Array.isArray(sections.suggestions?.usagePatterns)],
    [t.sections.onTheHorizon, 'on_the_horizon', Array.isArray(sections.on_the_horizon?.opportunities)],
    [sections.fun_ending?.headline ?? t.sections.memorableMoment, 'fun_ending', Boolean(sections.fun_ending)]
  ];
  for (const [heading, name, available] of semanticContracts) {
    if (Object.hasOwn(sectionFailures, name)) {
      const bounds = sectionBoundsByHeading(html, heading);
      if (bounds) {
        const original = html.slice(bounds.start, bounds.end);
        const id = original.match(/^<section[^>]* id="([^"]+)"/)?.[1];
        const failure = sectionFailures[name];
        const reason = failure?.reason ?? failure ?? 'unavailable';
        const replacement = `<section${id ? ` id="${id}"` : ''} data-semantic-section="${name}"><h2>${escapeHtml(heading)}</h2><div class="empty">${escapeHtml(t.sections.sectionFailed(reason))}</div></section>`;
        html = html.slice(0, bounds.start) + replacement + html.slice(bounds.end);
      }
    } else html = available && !isUnavailableSemanticReport(report) ? markSemanticSection(html, heading, name) : removeSectionByHeading(html, heading);
  }
  if (isUnavailableSemanticReport(report)) html = html.replace('</header>', `</header><section id="semantic-unavailable"><h2>${escapeHtml(t.sections.analysisUnavailable)}</h2><div class="empty">${escapeHtml(t.sections.noAnalyzableSessions)}</div></section>`);
  html = html.replace(/<a href="#([^"]+)">[\s\S]*?<\/a>/g, (link, id) => html.includes(`id="${id}"`) ? link : '');
  return html;
}


const REPORT_NAMES = ['report.json', 'report.md', 'report.html', 'agent-prompt.md'];
const REPORT_TRANSACTION = '.report-transaction';

async function reportFileInfo(path) {
  try { return await fs.lstat(path, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeReportJournal(directory, journal) {
  const temporary = join(directory, 'journal.tmp');
  await fs.writeFile(temporary, JSON.stringify(journal), { mode: 0o600 });
  await fs.rename(temporary, join(directory, 'journal.json'));
}

function validateReportJournal(journal) {
  if (journal?.version !== 1 || !['prepared', 'committed', 'rolled_back'].includes(journal.phase)
    || !Array.isArray(journal.entries) || journal.entries.length !== REPORT_NAMES.length
    || REPORT_NAMES.some((name, index) => journal.entries[index]?.name !== name || typeof journal.entries[index]?.hadOriginal !== 'boolean')
    || !/^report-\d{4}-\d{2}-\d{2}-\d{6}-[a-f0-9-]{36}\.html$/.test(journal.archiveName ?? '')
    || !/^\d+$/.test(journal.archiveDevice ?? '') || !/^\d+$/.test(journal.archiveInode ?? '')) {
    throw new Error('Invalid pending report transaction; preserve its files for recovery.');
  }
}

async function rollbackReport(outputDirectory, transaction, journal) {
  for (const { name, hadOriginal } of journal.entries) {
    const destination = join(outputDirectory, name);
    if (hadOriginal) {
      // Keep backups intact until every restore succeeds, including after a
      // second interruption during recovery.
      const restored = join(transaction, `restore-${name}`);
      await fs.copyFile(join(transaction, 'previous', name), restored);
      await fs.rename(restored, destination);
    } else await fs.rm(destination, { force: true });
  }
  const archive = join(outputDirectory, journal.archiveName);
  const info = await reportFileInfo(archive);
  // A failed exclusive link must never remove an archive belonging to someone
  // else. The staged HTML's inode identifies only this transaction's history.
  if (info && String(info.dev) === journal.archiveDevice && String(info.ino) === journal.archiveInode) await fs.unlink(archive);
}

async function finishReportRollback(outputDirectory, transaction, journal) {
  await rollbackReport(outputDirectory, transaction, journal);
  // Recursive cleanup can fail after deleting some backups. Record completed
  // restoration first, so a retry cleans up without needing those backups.
  await writeReportJournal(transaction, { ...journal, phase: 'rolled_back' });
}

async function recoverReportTransaction(outputDirectory) {
  const transaction = join(outputDirectory, REPORT_TRANSACTION);
  const info = await reportFileInfo(transaction);
  if (!info) return;
  if (!info.isDirectory()) throw new Error('Pending report transaction is not a directory; preserve it for recovery.');
  let journal;
  try { journal = JSON.parse(await fs.readFile(join(transaction, 'journal.json'), 'utf8')); }
  catch (error) {
    // No latest file is changed until the complete journal has been published.
    if (error.code !== 'ENOENT') throw error;
    await fs.rm(transaction, { recursive: true });
    return;
  }
  validateReportJournal(journal);
  if (journal.phase === 'prepared') await finishReportRollback(outputDirectory, transaction, journal);
  await fs.rm(transaction, { recursive: true });
}

export async function writeReport(report, outputDirectory) {
  // Render every format before touching a previously published report.
  const html = renderHtml(report);
  const contents = [`${JSON.stringify(report, null, 2)}\n`, renderMarkdown(report), html, renderAgentPrompt(report)];
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(outputDirectory, 0o700);
  return withDirectoryLock({ directory: outputDirectory, lockName: '.report-lock', busyCode: 'ERR_REPORT_OUTPUT_BUSY', description: 'Report output' }, async () => {
    try { await recoverReportTransaction(outputDirectory); }
    catch (cause) { throw Object.assign(new Error('Report recovery is incomplete; backups and the journal are preserved. Retry publication after resolving the filesystem error.', { cause }), { code: 'ERR_REPORT_RECOVERY_REQUIRED' }); }
    const timestamp = new Date(report.generatedAt).toISOString().replace(/T/, '-').replace(/:/g, '').slice(0, 17);
    const archiveName = `report-${timestamp}-${randomUUID()}.html`;
    const files = { json: join(outputDirectory, REPORT_NAMES[0]), markdown: join(outputDirectory, REPORT_NAMES[1]), html: join(outputDirectory, REPORT_NAMES[2]), timestampedHtml: join(outputDirectory, archiveName), prompt: join(outputDirectory, REPORT_NAMES[3]) };
    const transaction = join(outputDirectory, REPORT_TRANSACTION);
    let journal;
    let committed = false;
    try {
      await fs.mkdir(transaction, { mode: 0o700 });
      await fs.mkdir(join(transaction, 'staged'), { mode: 0o700 });
      await fs.mkdir(join(transaction, 'previous'), { mode: 0o700 });
      const entries = [];
      for (const [index, name] of REPORT_NAMES.entries()) {
        await fs.writeFile(join(transaction, 'staged', name), contents[index], { flag: 'wx', mode: 0o600 });
        const original = await reportFileInfo(join(outputDirectory, name));
        if (original && !original.isFile()) throw new Error(`Report destination must be a regular file: ${name}`);
        if (original) await fs.copyFile(join(outputDirectory, name), join(transaction, 'previous', name), fsConstants.COPYFILE_EXCL);
        entries.push({ name, hadOriginal: Boolean(original) });
      }
      // Give history its own inode so editing latest HTML cannot alter an
      // already delivered archive through a shared hard link.
      const stagedArchive = join(transaction, 'archive.html');
      await fs.copyFile(join(transaction, 'staged', 'report.html'), stagedArchive, fsConstants.COPYFILE_EXCL);
      const archiveInfo = await fs.stat(stagedArchive, { bigint: true });
      journal = { version: 1, phase: 'prepared', entries, archiveName, archiveDevice: String(archiveInfo.dev), archiveInode: String(archiveInfo.ino) };
      await writeReportJournal(transaction, journal);
      // The exclusive link cannot overwrite history and lets rollback identify
      // only the archive created by this transaction.
      await fs.link(stagedArchive, files.timestampedHtml);
      for (const name of REPORT_NAMES) await fs.rename(join(transaction, 'staged', name), join(outputDirectory, name));
      await writeReportJournal(transaction, { ...journal, phase: 'committed' });
      committed = true;
    } catch (cause) {
      try {
        // A journal write can fail before publishing it; no latest files have
        // changed then. A prepared journal always has a complete backup set.
        if (journal && await reportFileInfo(join(transaction, 'journal.json'))) await finishReportRollback(outputDirectory, transaction, journal);
        await fs.rm(transaction, { recursive: true, force: true });
      } catch (recoveryError) {
        throw Object.assign(new AggregateError([cause, recoveryError], 'Report publication failed and recovery is incomplete; backups and the journal are preserved. Retry after resolving the filesystem error.'), { code: 'ERR_REPORT_RECOVERY_REQUIRED' });
      }
      throw cause;
    }
    // Once committed, a cleanup failure must not roll back a successful report.
    // The next publisher can safely remove this committed transaction instead.
    if (committed) await fs.rm(transaction, { recursive: true, force: true }).catch(() => {});
    return files;
  }).catch((error) => {
    if (error instanceof DirectoryLockCleanupError && error.operationCompleted) {
      return { ...error.result, lockCleanupWarning: error.lockCleanupWarning };
    }
    throw error;
  });
}

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

const number = (value) => new Intl.NumberFormat('en-US').format(value);
const escapeMarkdown = (value) => String(value).replace(/([\\\`*_{}\[\]<>()#+\-.!|])/g, '\\$1');
const coverageNumber = (value) => value === undefined || value === null ? '—' : number(value);

function coverageNotes(source) {
  const notes = [];
  if (source.warning) notes.push(source.warning);
  if (source.discoveryTruncated) notes.push(`discovery capped at ${number(source.discoveryLimit)} files per root`);
  if (source.discoveryErrors) notes.push(`${number(source.discoveryErrors)} discovery error${source.discoveryErrors === 1 ? '' : 's'}`);
  if (source.statErrors) notes.push(`${number(source.statErrors)} stat error${source.statErrors === 1 ? '' : 's'}`);
  if (source.transcriptRootsFound !== undefined) notes.push(`${number(source.transcriptRootsFound)} transcript root${source.transcriptRootsFound === 1 ? '' : 's'} found`);
  return notes.join('; ') || '—';
}

function projectFilterNote(report) {
  const filter = report.coverage.projectFilter;
  const project = !filter?.requested
    ? 'No project filter was requested.'
    : `A project filter was requested; ${number(filter.unknownProjectExcluded ?? 0)} session${filter.unknownProjectExcluded === 1 ? '' : 's'} without an identifiable project were excluded.`;
  return `${project} ${eligibilityNote(report)}`;
}

function eligibilityNote(report) {
  const eligibility = report.coverage?.eligibility;
  if (!eligibility) return 'Eligibility was not evaluated for this deterministic-only report.';
  const reasons = Object.entries(eligibility.reasons ?? {}).map(([reason, count]) => `${number(count)} ${reason.replaceAll('_', ' ')}`).join(', ');
  return `${number(eligibility.eligible)} eligible, ${number(eligibility.excluded)} excluded, ${number(eligibility.scanned)} scanned${reasons ? ` (${reasons})` : ''}.`;
}

function semanticFailureNote(report) {
  const failures = report.coverage?.semanticFailures ?? [];
  if (!failures.length) return 'No semantic analyzer failures were recorded.';
  const reasons = Object.entries(failures.reduce((counts, failure) => ({ ...counts, [failure.reason]: (counts[failure.reason] ?? 0) + 1 }), {}))
    .map(([reason, count]) => `${number(count)} ${reason.replaceAll('_', ' ')}`)
    .join(', ');
  return `Semantic coverage is partial: ${reasons}.`;
}

function sourceTable(report) {
  const rows = Object.entries(report.sources).map(([source, stats]) => `| ${source} | ${number(stats.sessions)} | ${number(stats.userMessages)} | ${number(stats.assistantMessages)} | ${number(stats.toolCalls)} | ${number(stats.toolErrors)} |`);
  return rows.length
    ? ['| Agent | Sessions | User turns | Assistant turns | Tool calls | Tool errors |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n')
    : '_No compatible local sessions were found._';
}

function requestedWindowLabel(report) {
  const range = report.coverage.requestedRange;
  if (range?.start && range?.end) return `${range.start} to ${range.end} requested range`;
  return report.coverage.requestedDays === 'all available' ? 'all available local history' : `${report.coverage.requestedDays}-day window`;
}

function coverageTable(report) {
  const rows = report.coverage.sourcesScanned.map((source) => `| ${escapeMarkdown(source.source)} | ${escapeMarkdown(source.coverage)} | ${coverageNumber(source.filesFound)} | ${coverageNumber(source.filesWithinWindow)} | ${coverageNumber(source.filesSelected)} | ${coverageNumber(source.filesLimited)} | ${coverageNumber(source.filesPartial)} | ${coverageNumber(source.filesSkipped)} | ${escapeMarkdown(coverageNotes(source))} |`);
  return rows.length
    ? ['| Source | Coverage | Found | Window | Selected | Limited | Partial | Skipped | Notes |', '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |', ...rows].join('\n')
    : '_No source probes ran._';
}

export function renderMarkdown(report) {
  const range = report.dateRange.start ? `${report.dateRange.start} to ${report.dateRange.end}` : 'No eligible sessions';
  const metrics = [
    ['Sessions', report.totals.sessions],
    ['User turns', report.totals.userMessages],
    ['Assistant turns', report.totals.assistantMessages],
    ['Tool calls', report.totals.toolCalls],
    ['Tool errors', report.totals.toolErrors],
    ['Turn failures', report.totals.turnFailures]
  ];
  const list = (items) => items.map((item) => `- **${item.title}:** ${item.detail}`).join('\n');
  const ranked = (items) => items.length ? items.map((item) => `- ${escapeMarkdown(item.name)}: ${number(item.count)}`).join('\n') : '- No data';
  return `# Agent Insight\n\n${range} · ${requestedWindowLabel(report)}\n\n## At a glance\n\n${metrics.map(([label, value]) => `- **${label}:** ${number(value)}`).join('\n')}\n\n## Agent coverage\n\n${sourceTable(report)}\n\n## Read coverage\n\n${projectFilterNote(report)} ${semanticFailureNote(report)}\n\n${coverageTable(report)}\n\n## Project areas\n\n${ranked(report.projects)}\n\n## Top tools\n\n${ranked(report.topTools)}\n\n## Providers\n\n${ranked(report.providers)}\n\n## Models\n\n${ranked(report.models)}\n\n## Evidence-backed observations\n\n${list(report.observations)}\n\n## Next moves\n\n${list(report.recommendations)}\n\n## Evidence policy\n\n${report.privacy.note}\n`;
}

export function renderAgentPrompt(report) {
  return `# Agent Insights narrative handoff\n\nRead \`report.md\` in this same directory, then give the user a concise personalized review.\n\nRules:\n\n- Treat every count as metadata, not proof of intent, satisfaction, or quality.\n- Clearly separate measured facts from your inference.\n- Representative quotations, project paths, and session identifiers in the report are intentional evidence labels; do not treat them as a complete transcript dump.\n- Check **Read coverage** first; do not compare or generalize from a partial, unavailable, root-only, or experimental source as if it were complete.\n- Prioritize 2–3 durable changes: project instructions, a reusable skill/command, or an environment/tooling fix.\n- Avoid vendor-specific advice unless the report shows that source.\n\nCurrent coverage: ${report.totals.sessions} sessions across ${Object.keys(report.sources).length} detected agent sources.\n`;
}

function evidence(ids, sessions = []) {
  if (!ids?.length) return '<p class="evidence missing">Evidence unavailable</p>';
  const labels = ids.map((id) => {
    const session = sessions.find((entry) => entry.id === id || entry.sessionId === id);
    if (!session) return id;
    return [session.sessionId ?? session.id, session.source, session.date, session.projectPath || session.projectLabel].filter(Boolean).join(' · ');
  });
  return `<p class="evidence">Evidence: ${labels.map(escapeHtml).join('; ')}</p>`;
}

function evidenceLabels(session) {
  const parts = [
    session.sessionId ?? session.id,
    session.source,
    session.date ?? 'unknown',
    session.projectPath || session.projectLabel || null
  ].filter(Boolean);
  return parts.map(escapeHtml).join(' · ');
}

function renderEvidenceQuotations(report) {
  const items = (report.parity?.evidenceContext?.sessions ?? []).flatMap((session) =>
    (session.grounding ?? [])
      .filter((item) => item.quotation)
      .map((item) => ({
        quotation: item.quotation,
        label: evidenceLabels({
          id: session.id,
          sessionId: item.sessionId ?? session.sessionId ?? session.id,
          source: session.source,
          date: session.date,
          projectPath: item.projectPath ?? session.projectPath
        })
      }))
  );
  if (!items.length) return '';
  return items.map((item) => `<article class="panel"><blockquote>${escapeHtml(item.quotation)}</blockquote><p class="evidence">${item.label}</p></article>`).join('');
}

function entries(value, order) {
  const items = Object.entries(value ?? {}).filter(([, count]) => Number(count) > 0);
  if (order) return order.flatMap((name) => value?.[name] ? [[name, value[name]]] : []);
  return items.sort(([, left], [, right]) => right - left).slice(0, 6);
}

function barChart(label, value, { order } = {}) {
  const items = Array.isArray(value) ? value : entries(value, order);
  const emptyLabel = { 'Response time distribution': 'No response time data', 'Time of day': 'No time data', 'Tool errors': 'No tool errors' }[label] ?? 'No data';
  if (!items.length) return `<div class="empty">${emptyLabel}</div><table class="sr-only" aria-label="${escapeHtml(label)} data"><tbody></tbody></table>`;
  const maximum = Math.max(1, ...items.map(([, count]) => Number(count)));
  return `<div class="bar-chart">${items.map(([name, count]) => `<div class="bar-row"><span>${escapeHtml(name)}</span><div class="bar-track"><i style="width:${Math.round((Number(count) / maximum) * 100)}%"></i></div><strong>${number(count)}</strong></div>`).join('')}</div><table class="sr-only" aria-label="${escapeHtml(label)} data"><thead><tr><th>Label</th><th>Count</th></tr></thead><tbody>${items.map(([name, count]) => `<tr><td>${escapeHtml(name)}</td><td>${number(count)}</td></tr>`).join('')}</tbody></table>`;
}

function responseTimeBuckets(values) {
  if (!values?.length) return [];
  const buckets = [
    ['2–10s', 2, 10], ['10–30s', 10, 30], ['30s–1m', 30, 60], ['1–2m', 60, 120],
    ['2–5m', 120, 300], ['5–15m', 300, 900], ['>15m', 900, Infinity]
  ];
  return buckets.map(([label, minimum, maximum]) => [label, (values ?? []).filter((value) => value >= minimum && value < maximum).length]);
}

function timeOfDayBuckets(messageHours) {
  const total = (minimum, maximum) => Object.entries(messageHours ?? {}).reduce((sum, [hour, count]) => {
    const value = Number(hour);
    return sum + (value >= minimum && value < maximum ? Number(count) : 0);
  }, 0);
  const buckets = [['Morning', total(6, 12)], ['Afternoon', total(12, 18)], ['Evening', total(18, 24)], ['Night', total(0, 6)]];
  return buckets.some(([, count]) => count > 0) ? buckets : [];
}

function proseCard(title, text) {
  return `<article class="prose-card"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text ?? 'Analysis unavailable.')}</p></article>`;
}

function sectionCards(items, renderer) {
  return items?.length ? `<div class="card-grid">${items.map(renderer).join('')}</div>` : '<div class="empty">This section is unavailable for the current coverage.</div>';
}

function renderHtmlLegacy(report) {
  const insights = report.insights ?? {};
  const semantic = report.semantic?.sections ?? {};
  const evidenceSessions = report.semantic?.sessions ?? [];
  const ev = (ids) => evidence(ids, evidenceSessions);
  const glance = semantic.at_a_glance ?? {};
  const projectAreas = semantic.project_areas?.areas ?? [];
  const interaction = semantic.interaction_style ?? {};
  const working = semantic.what_works ?? {};
  const friction = semantic.friction_analysis ?? {};
  const suggestions = semantic.suggestions ?? {};
  const horizon = semantic.on_the_horizon ?? {};
  const ending = semantic.fun_ending ?? {};
  const range = insights.dateRange?.start ? `${insights.dateRange.start} to ${insights.dateRange.end}` : 'No eligible sessions';
  const discoveredSuffix = (insights.totalSessionsScanned ?? 0) > (insights.totalSessions ?? 0) ? ` (${number(insights.totalSessionsScanned)} total)` : '';
  const subtitle = `${number(insights.totalMessages ?? 0)} messages across ${number(insights.totalSessions ?? 0)} sessions${discoveredSuffix} | ${range}`;
  const statCards = [
    ['Messages', insights.totalMessages ?? 0],
    ['Lines', `+${number(insights.totalLinesAdded ?? 0)}/-${number(insights.totalLinesRemoved ?? 0)}`],
    ['Files', insights.totalFilesModified ?? 0],
    ['Days', insights.daysActive ?? 0],
    ['Msgs/Day', insights.messagesPerDay ?? 0]
  ].map(([label, value]) => `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join('');
  const coverageRows = (report.coverage?.sourcesScanned ?? []).map((source) => `<tr><td>${escapeHtml(source.source)}</td><td>${escapeHtml(source.coverage)}</td><td>${coverageNumber(source.filesFound)}</td><td>${coverageNumber(source.filesSelected)}</td><td>${coverageNumber(source.filesLimited)}</td><td>${coverageNumber(source.filesPartial)}</td><td>${coverageNumber(source.filesSkipped)}</td><td>${escapeHtml(coverageNotes(source))}</td></tr>`).join('') || '<tr><td colspan="8">No source probes ran.</td></tr>';
  const outcomeOrder = ['not_achieved', 'partially_achieved', 'mostly_achieved', 'fully_achieved', 'unclear_from_transcript'];
  const satisfactionOrder = ['frustrated', 'dissatisfied', 'likely_satisfied', 'satisfied', 'happy', 'unsure'];
  const toc = `<nav class="toc" aria-label="Report sections"><a href="#what-you-work-on">What You Work On</a><a href="#how-you-use">How You Use CC</a><a href="#impressive-things">Impressive Things</a><a href="#where-things-go-wrong">Where Things Go Wrong</a><a href="#features-to-try">Features to Try</a><a href="#new-usage-patterns">New Usage Patterns</a><a href="#on-the-horizon">On the Horizon</a><span aria-disabled="true">Team Feedback</span></nav>`;
  const utcHours = JSON.stringify(insights.messageHours ?? {});
  const timeChart = `<label class="timezone">Timezone <select id="time-zone"><option value="-8">PT (UTC-8)</option><option value="-5">ET (UTC-5)</option><option value="0">London (UTC)</option><option value="1">CET (UTC+1)</option><option value="9">Tokyo (UTC+9)</option><option value="custom">Local / custom UTC offset</option></select></label><div id="time-chart" data-utc-hours="${escapeHtml(utcHours)}">${barChart('Time of day', timeOfDayBuckets(insights.messageHours))}</div>`;
  const timezoneScript = `<script>(()=>{const select=document.getElementById('time-zone');const root=document.getElementById('time-chart');if(!select||!root)return;const source=JSON.parse(root.dataset.utcHours||'{}');const rows=[...root.querySelectorAll('.bar-row')];const render=(offset)=>{const counts=[0,0,0,0];for(const [hour,count] of Object.entries(source)){const shifted=(Number(hour)+offset+24)%24;const index=shifted>=6&&shifted<12?0:shifted>=12&&shifted<18?1:shifted>=18?2:3;counts[index]+=Number(count)||0}const maximum=Math.max(1,...counts);rows.forEach((row,index)=>{row.querySelector('strong').textContent=String(counts[index]);row.querySelector('i').style.width=Math.round(counts[index]/maximum*100)+'%'})};const local=-new Date().getTimezoneOffset()/60;const exact=[...select.options].find((option)=>Number(option.value)===local);if(exact)select.value=exact.value;else select.value='custom';render(local);select.addEventListener('change',()=>{let offset=Number(select.value);if(select.value==='custom'){const answer=window.prompt('UTC offset in hours',String(local));offset=Number(answer);if(!Number.isFinite(offset)||offset< -12||offset>14){select.value=exact?.value??'custom';offset=local}}render(offset)})})();</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Claude Code Insights</title><style>:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#0d1118;color:#eef3fb;--panel:#151c27;--line:#273449;--muted:#91a0b6;--accent:#78a9ff}*{box-sizing:border-box}body{max-width:1160px;margin:0 auto;padding:48px 24px 80px;background:radial-gradient(circle at 92% 0,#183b68 0,transparent 32rem)}h1{font-size:46px;letter-spacing:-.055em;margin:0 0 8px}h2{margin:46px 0 16px;font-size:22px;letter-spacing:-.02em}h3{font-size:15px;margin:0 0 9px}.muted,.evidence{color:var(--muted)}.evidence{font-size:12px;margin-top:12px}.metrics{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:28px 0}.metric,.panel,.prose-card,.insight-card{background:var(--panel);border:1px solid var(--line);border-radius:15px;padding:18px}.metric span{display:block;color:var(--muted);font-size:12px}.metric strong{font-size:25px}.glance,.card-grid,.two-col{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.insight-card p,.prose-card p,.panel p{line-height:1.6;color:#cad4e3;margin:0}.panel-title{font-size:13px;color:var(--muted);margin-bottom:14px}.bar-row{display:grid;grid-template-columns:minmax(90px,1fr) 3fr auto;gap:12px;align-items:center;margin:10px 0;font-size:13px}.bar-track{height:8px;border-radius:99px;background:#243044;overflow:hidden}.bar-track i{display:block;height:100%;background:linear-gradient(90deg,#568ee8,#8fb8ff);border-radius:99px}.empty{padding:18px;color:var(--muted);border:1px dashed var(--line);border-radius:12px}.callout{padding:16px 18px;border-left:3px solid var(--accent);background:#132033;border-radius:0 12px 12px 0;margin:14px 0}.copy{font-family:ui-monospace,monospace;background:#0c121c;border:1px solid var(--line);padding:12px;border-radius:9px;white-space:pre-wrap}.table-wrap{overflow:auto;border-radius:14px}table:not(.sr-only){width:100%;border-collapse:collapse;background:var(--panel)}td,th{padding:11px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.status{display:inline-flex;padding:5px 9px;border-radius:99px;background:#172b24;color:#8be0ad;font-size:12px}.status.partial{background:#302817;color:#ffd675}.toc{display:flex;flex-wrap:wrap;gap:8px;margin:22px 0}.toc a,.toc span{color:#bfd6ff;background:#121b29;border:1px solid var(--line);padding:8px 10px;border-radius:9px;font-size:12px;text-decoration:none}.toc span{color:var(--muted)}.timezone{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px;margin-bottom:12px}.timezone select{background:#0c121c;color:#eef3fb;border:1px solid var(--line);border-radius:8px;padding:6px}@media(max-width:760px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.glance,.card-grid,.two-col{grid-template-columns:1fr}h1{font-size:36px}}</style></head><body><header><h1>Claude Code Insights</h1><p class="subtitle">${escapeHtml(subtitle)}</p><p class="muted">Analyzer ${escapeHtml(report.semantic?.analyzer?.host ?? 'local')} / ${escapeHtml(report.semantic?.analyzer?.model ?? 'unknown')}</p><span class="status ${report.parity?.structuralStatus === 'complete' ? '' : 'partial'}">${escapeHtml(report.parity?.structuralStatus ?? 'partial')} parity coverage</span></header>${toc}<section class="metrics">${statCards}</section><section><h2>At a Glance</h2><div class="glance">${proseCard("What's working", glance.whatsWorking)}${proseCard("What's hindering you", glance.whatsHindering)}${proseCard('Quick wins to try', glance.quickWins)}${proseCard('Ambitious workflows', glance.ambitiousWorkflows)}</div>${ev(glance.evidenceSessionIds)}</section><section id="what-you-work-on"><h2>What You Work On</h2>${sectionCards(projectAreas, (area) => `<article class="prose-card"><h3>${escapeHtml(area.name)}</h3><p>${escapeHtml(area.description)}</p><strong>${number(area.sessionCount)} sessions</strong>${ev(area.evidenceSessionIds)}</article>`)}</section><section><h2>What You Wanted</h2><div class="two-col"><div class="panel"><div class="panel-title">Goals</div>${barChart('Goal categories', insights.goalCategories)}</div><div class="panel"><div class="panel-title">Top Tools Used</div>${barChart('Top tools', insights.toolCounts)}</div></div></section><section><h2>Languages</h2><div class="two-col"><div class="panel">${barChart('Languages', insights.languages)}</div><div class="panel"><div class="panel-title">Session Types</div>${barChart('Session types', insights.sessionTypes)}</div></div></section><section id="how-you-use"><h2>How You Use Claude Code</h2><article class="panel"><p>${escapeHtml(interaction.narrative ?? 'Interaction analysis unavailable.')}</p><div class="callout"><strong>${escapeHtml(interaction.keyPattern ?? 'No key pattern available.')}</strong></div>${ev(interaction.evidenceSessionIds)}</article></section><section><h2>User Response Time Distribution</h2><div class="panel">${barChart('Response time distribution', responseTimeBuckets(insights.userResponseTimes))}<p class="muted">Median ${coverageNumber(insights.medianResponseTime)}s · Average ${coverageNumber(insights.averageResponseTime)}s</p></div></section><section><h2>Multi-Clauding (Parallel Sessions)</h2><div class="metrics">${[['Overlap pairs', insights.multiClauding?.overlapEvents ?? 0], ['Sessions involved', insights.multiClauding?.sessionsInvolved ?? 0], ['Messages during overlap', insights.multiClauding?.userMessagesDuring ?? 0]].map(([label, value]) => `<article class="metric"><span>${label}</span><strong>${number(value)}</strong></article>`).join('')}</div></section><section><h2>User Messages by Time of Day</h2><div class="two-col"><div class="panel">${timeChart}</div><div class="panel"><div class="panel-title">Tool Errors Encountered</div>${barChart('Tool errors', insights.toolErrorCategories)}</div></div></section><section id="impressive-things"><h2>Impressive Things You Did</h2><p class="muted">${escapeHtml(working.intro ?? '')}</p>${sectionCards(working.impressiveWorkflows, (workflow) => `<article class="prose-card"><h3>${escapeHtml(workflow.title)}</h3><p>${escapeHtml(workflow.description)}</p>${ev(workflow.evidenceSessionIds)}</article>`)}</section><section><h2>What Helped Most</h2><div class="two-col"><div class="panel">${barChart('Helpfulness', insights.helpfulness)}</div><div class="panel"><div class="panel-title">Outcomes</div>${barChart('Outcomes', insights.outcomes, { order: outcomeOrder })}</div></div></section><section id="where-things-go-wrong"><h2>Where Things Go Wrong</h2><p class="muted">${escapeHtml(friction.intro ?? '')}</p>${sectionCards(friction.categories, (category) => `<article class="prose-card"><h3>${escapeHtml(category.category)}</h3><p>${escapeHtml(category.description)}</p>${(category.examples ?? []).map((example) => `<div class="callout">${escapeHtml(example.text)}${ev(example.evidenceSessionIds)}</div>`).join('')}</article>`)}</section><section><h2>Primary Friction Types</h2><div class="two-col"><div class="panel">${barChart('Friction types', insights.friction)}</div><div class="panel"><div class="panel-title">Inferred Satisfaction</div>${barChart('Satisfaction', insights.satisfaction, { order: satisfactionOrder })}</div></div></section><section id="features-to-try"><h2>Existing CC Features to Try</h2><h3>Suggested CLAUDE.md Additions</h3>${sectionCards(suggestions.instructionAdditions, (item) => `<article class="prose-card"><p>${escapeHtml(item.addition)}</p><p class="muted">${escapeHtml(item.why)}</p><div class="copy">${escapeHtml(item.promptScaffold)}</div>${ev(item.evidenceSessionIds)}</article>`)}<h3>Features to Try</h3>${sectionCards(suggestions.featuresToTry, (item) => `<article class="prose-card"><h3>${escapeHtml(item.feature)}</h3><p>${escapeHtml(item.oneLiner)} ${escapeHtml(item.whyForYou)}</p><div class="copy">${escapeHtml(item.exampleCode)}</div>${ev(item.evidenceSessionIds)}</article>`)}</section><section id="new-usage-patterns"><h2>New Ways to Use Claude Code</h2>${sectionCards(suggestions.usagePatterns, (item) => `<article class="prose-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.suggestion)} ${escapeHtml(item.detail)}</p><div class="copy">${escapeHtml(item.copyablePrompt)}</div>${ev(item.evidenceSessionIds)}</article>`)}</section><section id="on-the-horizon"><h2>On the Horizon</h2><p class="muted">${escapeHtml(horizon.intro ?? '')}</p>${sectionCards(horizon.opportunities, (item) => `<article class="prose-card"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.whatsPossible)} ${escapeHtml(item.howToTry)}</p><div class="copy">${escapeHtml(item.copyablePrompt)}</div>${ev(item.evidenceSessionIds)}</article>`)}</section><section><h2>${escapeHtml(ending.headline ?? 'A memorable moment')}</h2><article class="panel"><p>${escapeHtml(ending.detail ?? 'No qualitative moment was available.')}</p>${ev(ending.evidenceSessionIds)}</article></section><section><h2>Read coverage</h2><p class="muted">${escapeHtml(projectFilterNote(report))}</p><div class="table-wrap"><table><thead><tr><th>Source</th><th>Coverage</th><th>Found</th><th>Selected</th><th>Limited</th><th>Partial</th><th>Skipped</th><th>Notes</th></tr></thead><tbody>${coverageRows}</tbody></table></div></section>${timezoneScript}</body></html>`;
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
  let html = renderHtmlLegacy(report);
  const structure = report.parity?.structuralStatus ?? 'partial';
  const data = report.parity?.dataStatus ?? 'partial';
  const overallComplete = structure === 'complete' && data === 'complete';
  const legacyBadge = `<span class="status ${structure === 'complete' ? '' : 'partial'}">${escapeHtml(structure)} parity coverage</span>`;
  const badge = `<span class="status ${overallComplete ? '' : 'partial'}">${overallComplete ? 'complete parity coverage' : `${escapeHtml(structure)} structure · ${escapeHtml(data)} data coverage`}</span>`;
  html = html.replace(legacyBadge, badge);
  if (!(report.insights?.multiClauding?.overlapEvents > 0)) {
    html = replaceSection(
      html,
      '<section><h2>Multi-Clauding (Parallel Sessions)</h2>',
      '<section><h2>User Messages by Time of Day</h2>',
      '<section><h2>Multi-Clauding (Parallel Sessions)</h2><div class="empty">No parallel session usage was detected; you typically work with one session at a time.</div></section>'
    );
  }
  const helped = `<section><h2>What Helped Most (Claude's Capabilities)</h2><div class="two-col"><div class="panel">${barChart('Primary successes', report.insights?.primarySuccesses)}</div><div class="panel"><div class="panel-title">Outcomes</div>${barChart('Outcomes', report.insights?.outcomes, { order: ['not_achieved', 'partially_achieved', 'mostly_achieved', 'fully_achieved', 'unclear_from_transcript'] })}</div></div></section>`;
  html = replaceSection(html, '<section><h2>What Helped Most</h2>', '<section id="where-things-go-wrong">', helped);
  const evidenceRows = (report.semantic?.sessions ?? []).map((session) => `<tr><td>${escapeHtml(session.sessionId ?? session.id)}</td><td>${escapeHtml(session.source)}</td><td>${escapeHtml(session.date ?? 'unknown')}</td><td>${escapeHtml(session.projectPath || session.projectLabel || '—')}</td></tr>`).join('');
  const evidenceIndex = `<section><h2>Evidence index</h2><div class="table-wrap"><table><thead><tr><th>Session</th><th>Agent</th><th>Date</th><th>Project</th></tr></thead><tbody>${evidenceRows || '<tr><td colspan="4">No semantic evidence sessions.</td></tr>'}</tbody></table></div>${renderEvidenceQuotations(report)}</section>`;
  html = html.replace('<section><h2>Read coverage</h2>', `${evidenceIndex}<section><h2>Read coverage</h2><p class="muted">${escapeHtml(semanticFailureNote(report))}</p>`);
  const headerClose = html.indexOf('</header>');
  const headerEnd = headerClose < 0 ? -1 : headerClose + '</header>'.length;
  const tocStart = html.indexOf('<nav class="toc"', headerEnd);
  const tocEnd = html.indexOf('</nav>', tocStart) + '</nav>'.length;
  const metricsStart = html.indexOf('<section class="metrics">', tocEnd);
  const metricsEnd = html.indexOf('</section>', metricsStart) + '</section>'.length;
  const glanceStart = html.indexOf('<section><h2>At a Glance</h2>', metricsEnd);
  const nextSection = html.indexOf('<section id="what-you-work-on">', glanceStart);
  if ([headerEnd, tocStart, tocEnd, metricsStart, metricsEnd, glanceStart, nextSection].some((index) => index < 0)) {
    throw new Error('The parity report layout could not be assembled.');
  }
  html = `${html.slice(0, headerEnd)}${html.slice(glanceStart, nextSection)}${html.slice(tocStart, tocEnd)}${html.slice(metricsStart, metricsEnd)}${html.slice(nextSection)}`;

  const sections = report.semantic?.sections ?? {};
  const semanticContracts = [
    ['At a Glance', 'at_a_glance', Boolean(sections.at_a_glance)],
    ['What You Work On', 'project_areas', Array.isArray(sections.project_areas?.areas)],
    ['How You Use Claude Code', 'interaction_style', Boolean(sections.interaction_style)],
    ['Impressive Things You Did', 'what_works', Array.isArray(sections.what_works?.impressiveWorkflows)],
    ['Where Things Go Wrong', 'friction_analysis', Array.isArray(sections.friction_analysis?.categories)],
    ['Existing CC Features to Try', 'suggestions', Array.isArray(sections.suggestions?.instructionAdditions) || Array.isArray(sections.suggestions?.featuresToTry)],
    ['New Ways to Use Claude Code', 'suggestions', Array.isArray(sections.suggestions?.usagePatterns)],
    ['On the Horizon', 'on_the_horizon', Array.isArray(sections.on_the_horizon?.opportunities)],
    [sections.fun_ending?.headline ?? 'A memorable moment', 'fun_ending', Boolean(sections.fun_ending)]
  ];
  for (const [heading, name, available] of semanticContracts) {
    html = available ? markSemanticSection(html, heading, name) : removeSectionByHeading(html, heading);
  }
  return html;
}

export async function writeReport(report, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const timestamp = new Date(report.generatedAt).toISOString().replace(/T/, '-').replace(/:/g, '').slice(0, 17);
  const files = {
    json: join(outputDirectory, 'report.json'),
    markdown: join(outputDirectory, 'report.md'),
    html: join(outputDirectory, 'report.html'),
    timestampedHtml: join(outputDirectory, `report-${timestamp}.html`),
    prompt: join(outputDirectory, 'agent-prompt.md')
  };
  const html = renderHtml(report);
  await Promise.all([
    writeFile(files.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(files.markdown, renderMarkdown(report), { mode: 0o600 }),
    writeFile(files.html, html, { mode: 0o600 }),
    writeFile(files.timestampedHtml, html, { mode: 0o600 }),
    writeFile(files.prompt, renderAgentPrompt(report), { mode: 0o600 })
  ]);
  await Promise.all(Object.values(files).map((file) => chmod(file, 0o600)));
  return files;
}

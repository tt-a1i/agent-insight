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
  if (!filter?.requested) return 'No project filter was requested.';
  return `A project filter was requested; ${number(filter.unknownProjectExcluded ?? 0)} session${filter.unknownProjectExcluded === 1 ? '' : 's'} without an identifiable project were excluded.`;
}

function sourceTable(report) {
  const rows = Object.entries(report.sources).map(([source, stats]) => `| ${source} | ${number(stats.sessions)} | ${number(stats.userMessages)} | ${number(stats.assistantMessages)} | ${number(stats.toolCalls)} | ${number(stats.toolErrors)} |`);
  return rows.length
    ? ['| Agent | Sessions | User turns | Assistant turns | Tool calls | Tool errors |', '| --- | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n')
    : '_No compatible local sessions were found._';
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
  return `# Agent Insight\n\n${range} · ${report.coverage.requestedDays === 'all available' ? 'all available local history' : `${report.coverage.requestedDays}-day window`}\n\n## At a glance\n\n${metrics.map(([label, value]) => `- **${label}:** ${number(value)}`).join('\n')}\n\n## Agent coverage\n\n${sourceTable(report)}\n\n## Read coverage\n\n${projectFilterNote(report)}\n\n${coverageTable(report)}\n\n## Project areas\n\n${ranked(report.projects)}\n\n## Top tools\n\n${ranked(report.topTools)}\n\n## Providers\n\n${ranked(report.providers)}\n\n## Models\n\n${ranked(report.models)}\n\n## Evidence-backed observations\n\n${list(report.observations)}\n\n## Next moves\n\n${list(report.recommendations)}\n\n## Privacy boundary\n\n${report.privacy.note}\n`;
}

export function renderAgentPrompt(report) {
  return `# Agent Insights narrative handoff\n\nRead \`report.md\` in this same directory, then give the user a concise personalized review.\n\nRules:\n\n- Treat every count as metadata, not proof of intent, satisfaction, or quality.\n- Clearly separate measured facts from your inference.\n- Do not claim to have read raw conversation text; this report deliberately does not contain it.\n- Check **Read coverage** first; do not compare or generalize from a partial, unavailable, root-only, or experimental source as if it were complete.\n- Prioritize 2–3 durable changes: project instructions, a reusable skill/command, or an environment/tooling fix.\n- Avoid vendor-specific advice unless the report shows that source.\n\nCurrent coverage: ${report.totals.sessions} sessions across ${Object.keys(report.sources).length} detected agent sources.\n`;
}

export function renderHtml(report) {
  const cards = [
    ['Sessions', report.totals.sessions],
    ['User turns', report.totals.userMessages],
    ['Assistant turns', report.totals.assistantMessages],
    ['Tool calls', report.totals.toolCalls],
    ['Tool errors', report.totals.toolErrors],
    ['Turn failures', report.totals.turnFailures]
  ].map(([label, value]) => `<article class="metric"><span>${escapeHtml(label)}</span><strong>${number(value)}</strong></article>`).join('');
  const rows = Object.entries(report.sources).map(([source, stats]) => `<tr><td>${escapeHtml(source)}</td><td>${number(stats.sessions)}</td><td>${number(stats.userMessages)}</td><td>${number(stats.assistantMessages)}</td><td>${number(stats.toolCalls)}</td><td>${number(stats.toolErrors)}</td></tr>`).join('') || '<tr><td colspan="6">No compatible local sessions were found.</td></tr>';
  const coverageRows = report.coverage.sourcesScanned.map((source) => `<tr><td>${escapeHtml(source.source)}</td><td>${escapeHtml(source.coverage)}</td><td>${coverageNumber(source.filesFound)}</td><td>${coverageNumber(source.filesWithinWindow)}</td><td>${coverageNumber(source.filesSelected)}</td><td>${coverageNumber(source.filesLimited)}</td><td>${coverageNumber(source.filesPartial)}</td><td>${coverageNumber(source.filesSkipped)}</td><td>${escapeHtml(coverageNotes(source))}</td></tr>`).join('') || '<tr><td colspan="9">No source probes ran.</td></tr>';
  const cardsList = (items) => items.map((item) => `<article class="note"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.detail)}</p></article>`).join('');
  const bars = (items) => items.length ? items.map((item) => `<li><span>${escapeHtml(item.name)}</span><strong>${number(item.count)}</strong></li>`).join('') : '<li><span>No data</span></li>';
  const range = report.dateRange.start ? `${report.dateRange.start} to ${report.dateRange.end}` : 'No eligible sessions';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Insight</title><style>:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#10151e;color:#e9eef9}body{max-width:1080px;margin:0 auto;padding:48px 24px 72px;background:radial-gradient(circle at top right,#1c355c 0,transparent 30rem)}h1{font-size:42px;letter-spacing:-.06em;margin:0 0 8px}h2{margin:38px 0 14px;font-size:20px}.muted{color:#9eacc2}.metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-top:28px}.metric,.note{background:#182130;border:1px solid #2b3a51;border-radius:14px;padding:18px}.metric span{display:block;color:#9eacc2;font-size:13px}.metric strong{font-size:28px;letter-spacing:-.04em}.table-wrap{overflow:auto;border-radius:14px}table{width:100%;border-collapse:collapse;background:#182130;border-radius:14px;overflow:hidden}td,th{padding:12px;text-align:left;border-bottom:1px solid #2b3a51;vertical-align:top}th{color:#9eacc2;font-weight:500;white-space:nowrap}.notes{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}.note h3{font-size:15px;margin:0 0 8px}.note p{margin:0;line-height:1.55;color:#c2cede}ul{list-style:none;padding:0;margin:0;background:#182130;border:1px solid #2b3a51;border-radius:14px}li{display:flex;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2b3a51}li:last-child{border:0}.privacy{font-size:13px;line-height:1.5;color:#9eacc2}@media(max-width:720px){.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:34px}}</style></head><body><header><p class="muted">${escapeHtml(range)} · local-first cross-agent report</p><h1>Agent Insight</h1><p class="muted">${escapeHtml(report.privacy.note)}</p></header><section class="metrics">${cards}</section><section><h2>Agent coverage</h2><div class="table-wrap"><table><thead><tr><th>Agent</th><th>Sessions</th><th>User</th><th>Assistant</th><th>Tools</th><th>Errors</th></tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>Read coverage</h2><p class="muted">${escapeHtml(projectFilterNote(report))}</p><div class="table-wrap"><table><thead><tr><th>Source</th><th>Coverage</th><th>Found</th><th>Window</th><th>Selected</th><th>Limited</th><th>Partial</th><th>Skipped</th><th>Notes</th></tr></thead><tbody>${coverageRows}</tbody></table></div></section><section><h2>Project areas</h2><ul>${bars(report.projects)}</ul></section><section><h2>Top tools</h2><ul>${bars(report.topTools)}</ul></section><section><h2>Providers</h2><ul>${bars(report.providers)}</ul></section><section><h2>Models</h2><ul>${bars(report.models)}</ul></section><section><h2>Evidence-backed observations</h2><div class="notes">${cardsList(report.observations)}</div></section><section><h2>Next moves</h2><div class="notes">${cardsList(report.recommendations)}</div></section></body></html>`;
}

export async function writeReport(report, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await chmod(outputDirectory, 0o700);
  const files = {
    json: join(outputDirectory, 'report.json'),
    markdown: join(outputDirectory, 'report.md'),
    html: join(outputDirectory, 'report.html'),
    prompt: join(outputDirectory, 'agent-prompt.md')
  };
  await Promise.all([
    writeFile(files.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(files.markdown, renderMarkdown(report), { mode: 0o600 }),
    writeFile(files.html, renderHtml(report), { mode: 0o600 }),
    writeFile(files.prompt, renderAgentPrompt(report), { mode: 0o600 })
  ]);
  await Promise.all(Object.values(files).map((file) => chmod(file, 0o600)));
  return files;
}

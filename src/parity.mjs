import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { AGGREGATE_TASKS } from './aggregate-protocol.mjs';

const DETERMINISTIC_FIELDS = [
  'totalSessions', 'totalSessionsScanned', 'sessionsWithFacets', 'dateRange', 'totalMessages',
  'totalDurationHours', 'totalInputTokens', 'totalOutputTokens', 'toolCounts', 'languages',
  'gitCommits', 'gitPushes', 'projects', 'goalCategories', 'outcomes', 'satisfaction', 'helpfulness',
  'sessionTypes', 'friction', 'primarySuccesses', 'totalInterruptions', 'totalToolErrors', 'toolErrorCategories',
  'userResponseTimes', 'medianResponseTime', 'averageResponseTime', 'sessionsUsingTaskAgent',
  'sessionsUsingMcp', 'sessionsUsingWebSearch', 'sessionsUsingWebFetch', 'totalLinesAdded',
  'totalLinesRemoved', 'totalFilesModified', 'daysActive', 'messagesPerDay', 'messageHours',
  'multiClauding'
];

const SECTION_FIELDS = {
  project_areas: ['areas'], interaction_style: ['narrative', 'keyPattern'],
  what_works: ['intro', 'impressiveWorkflows'], friction_analysis: ['intro', 'categories'],
  suggestions: ['instructionAdditions', 'featuresToTry', 'usagePatterns'],
  on_the_horizon: ['intro', 'opportunities'], fun_ending: ['headline', 'detail'],
  at_a_glance: ['whatsWorking', 'whatsHindering', 'quickWins', 'ambitiousWorkflows']
};

function hasOwn(object, key) {
  return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function score(matched, total) {
  return total === 0 ? 1 : Math.round((matched / total) * 10_000) / 10_000;
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

function decodeHtml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function tagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseHtmlDom(html) {
  if (typeof html !== 'string') return { error: 'artifact' };
  const root = { tag: '#document', attributes: {}, children: [], text: '', parent: null, start: -1 };
  const stack = [root];
  let cursor = 0;
  while (cursor < html.length) {
    if (html.startsWith('<!--', cursor)) {
      const end = html.indexOf('-->', cursor + 4);
      if (end < 0) return { error: 'unterminated-comment' };
      cursor = end + 3;
      continue;
    }
    if (html[cursor] !== '<') {
      const end = html.indexOf('<', cursor);
      stack.at(-1).text += html.slice(cursor, end < 0 ? html.length : end);
      cursor = end < 0 ? html.length : end;
      continue;
    }
    const end = tagEnd(html, cursor);
    if (end < 0) return { error: 'unterminated-tag' };
    const token = html.slice(cursor + 1, end).trim();
    if (/^!doctype\b/i.test(token)) {
      cursor = end + 1;
      continue;
    }
    const closing = /^\/\s*([A-Za-z][\w:-]*)\s*$/.exec(token);
    if (closing) {
      const name = closing[1].toLowerCase();
      if (stack.length === 1 || stack.at(-1).tag !== name) return { error: `misnested:${name}` };
      stack.pop();
      cursor = end + 1;
      continue;
    }
    const opening = /^([A-Za-z][\w:-]*)([\s\S]*)$/.exec(token);
    if (!opening) {
      stack.at(-1).text += '<';
      cursor += 1;
      continue;
    }
    const name = opening[1].toLowerCase();
    const selfClosing = /\/\s*$/.test(opening[2]) || VOID_ELEMENTS.has(name);
    const node = {
      tag: name,
      attributes: parseAttributes(opening[2].replace(/\/\s*$/, '')),
      children: [],
      text: '',
      parent: stack.at(-1),
      start: cursor
    };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
    cursor = end + 1;
  }
  if (stack.length !== 1) return { error: `unclosed:${stack.at(-1).tag}` };
  return { root };
}

function descendants(node, predicate, output = []) {
  for (const child of node?.children ?? []) {
    if (predicate(child)) output.push(child);
    descendants(child, predicate, output);
  }
  return output;
}

function textContent(node) {
  return decodeHtml(`${node?.text ?? ''}${(node?.children ?? []).map(textContent).join('')}`).replace(/\s+/g, ' ').trim();
}

function hasClass(node, name) {
  return String(node?.attributes?.class ?? '').split(/\s+/).includes(name);
}

function sectionWithHeading(body, heading) {
  return descendants(body, (node) => node.tag === 'section').find((section) => descendants(section, (node) => node.tag === 'h2').some((node) => textContent(node) === heading));
}

function expectedSubtitle(candidate) {
  const insights = candidate.insights ?? {};
  const range = insights.dateRange?.start ? `${insights.dateRange.start} to ${insights.dateRange.end}` : 'No eligible sessions';
  const total = Number(insights.totalSessions ?? 0);
  const scanned = Number(insights.totalSessionsScanned ?? total);
  return `${Number(insights.totalMessages ?? 0).toLocaleString('en-US')} messages across ${total.toLocaleString('en-US')} sessions${scanned > total ? ` (${scanned.toLocaleString('en-US')} total)` : ''} | ${range}`;
}

function htmlContractFailures(html, candidate) {
  const document = parseHtmlDom(html);
  if (document.error) return [`html.dom:${document.error}`];
  const failures = [];
  const htmlNode = document.root.children.find((node) => node.tag === 'html');
  const head = htmlNode?.children.find((node) => node.tag === 'head');
  const body = htmlNode?.children.find((node) => node.tag === 'body');
  if (!htmlNode || !head || !body) return ['html.dom:document-shell'];
  const title = descendants(head, (node) => node.tag === 'title')[0];
  if (textContent(title) !== 'Claude Code Insights') failures.push('html.title');
  const header = body.children.find((node) => node.tag === 'header');
  const h1 = descendants(header, (node) => node.tag === 'h1')[0];
  const subtitle = descendants(header, (node) => node.tag === 'p' && hasClass(node, 'subtitle'))[0];
  if (textContent(h1) !== 'Claude Code Insights') failures.push('html.heading');
  if (textContent(subtitle) !== expectedSubtitle(candidate)) failures.push('html.subtitle');

  const semantic = candidate.semantic?.sections ?? {};
  const semanticSections = [
    ['at_a_glance', 'At a Glance', Boolean(semantic.at_a_glance)],
    ['project_areas', 'What You Work On', Array.isArray(semantic.project_areas?.areas)],
    ['interaction_style', 'How You Use Claude Code', Boolean(semantic.interaction_style)],
    ['what_works', 'Impressive Things You Did', Array.isArray(semantic.what_works?.impressiveWorkflows)],
    ['friction_analysis', 'Where Things Go Wrong', Array.isArray(semantic.friction_analysis?.categories)],
    ['suggestions', 'Existing CC Features to Try', Array.isArray(semantic.suggestions?.instructionAdditions) || Array.isArray(semantic.suggestions?.featuresToTry)],
    ['suggestions', 'New Ways to Use Claude Code', Array.isArray(semantic.suggestions?.usagePatterns)],
    ['on_the_horizon', 'On the Horizon', Array.isArray(semantic.on_the_horizon?.opportunities)],
    ['fun_ending', semantic.fun_ending?.headline ?? 'A memorable moment', Boolean(semantic.fun_ending)]
  ];
  for (const [name, heading, available] of semanticSections) {
    const section = sectionWithHeading(body, heading);
    if ((!available && section) || (available && (!section || section.attributes['data-semantic-section'] !== name))) failures.push(`html.semantic:${name}`);
  }

  const toc = descendants(body, (node) => node.tag === 'nav' && hasClass(node, 'toc'))[0];
  const tocLabels = (toc?.children ?? []).filter((node) => node.tag === 'a' || node.tag === 'span').map(textContent);
  const expectedToc = ['What You Work On', 'How You Use CC', 'Impressive Things', 'Where Things Go Wrong', 'Features to Try', 'New Usage Patterns', 'On the Horizon', 'Team Feedback'];
  if (!isDeepStrictEqual(tocLabels, expectedToc)) failures.push('html.toc');

  const primaryMetrics = body.children.find((node) => node.tag === 'section' && hasClass(node, 'metrics'));
  const headerIndex = body.children.indexOf(header);
  const glanceIndex = body.children.findIndex((node) => node.attributes?.['data-semantic-section'] === 'at_a_glance');
  const tocIndex = body.children.indexOf(toc);
  const metricsIndex = body.children.indexOf(primaryMetrics);
  const expectedTopLevelOrder = semantic.at_a_glance
    ? headerIndex >= 0 && headerIndex < glanceIndex && glanceIndex < tocIndex && tocIndex < metricsIndex
    : headerIndex >= 0 && headerIndex < tocIndex && tocIndex < metricsIndex;
  if (!expectedTopLevelOrder) failures.push('html.order:glance-toc-metrics');
  const metricLabels = (primaryMetrics?.children ?? []).filter((node) => node.tag === 'article').map((article) => textContent(descendants(article, (node) => node.tag === 'span')[0]));
  if (!isDeepStrictEqual(metricLabels, ['Messages', 'Lines', 'Files', 'Days', 'Msgs/Day'])) failures.push('html.metrics');
  const lineCard = (primaryMetrics?.children ?? []).find((article) => textContent(descendants(article, (node) => node.tag === 'span')[0]) === 'Lines');
  const lineValue = textContent(descendants(lineCard, (node) => node.tag === 'strong')[0]);
  if (lineValue !== `+${Number(candidate.insights.totalLinesAdded ?? 0).toLocaleString('en-US')}/-${Number(candidate.insights.totalLinesRemoved ?? 0).toLocaleString('en-US')}`) failures.push('html.lines');

  const expectedHeadings = [
    ...(semantic.at_a_glance ? ['At a Glance'] : []),
    ...(Array.isArray(semantic.project_areas?.areas) ? ['What You Work On'] : []),
    'What You Wanted', 'Languages',
    ...(semantic.interaction_style ? ['How You Use Claude Code'] : []),
    'User Response Time Distribution', 'Multi-Clauding (Parallel Sessions)', 'User Messages by Time of Day',
    ...(Array.isArray(semantic.what_works?.impressiveWorkflows) ? ['Impressive Things You Did'] : []),
    "What Helped Most (Claude's Capabilities)",
    ...(Array.isArray(semantic.friction_analysis?.categories) ? ['Where Things Go Wrong'] : []),
    'Primary Friction Types',
    ...(Array.isArray(semantic.suggestions?.instructionAdditions) || Array.isArray(semantic.suggestions?.featuresToTry) ? ['Existing CC Features to Try'] : []),
    ...(Array.isArray(semantic.suggestions?.usagePatterns) ? ['New Ways to Use Claude Code'] : []),
    ...(Array.isArray(semantic.on_the_horizon?.opportunities) ? ['On the Horizon'] : []),
    ...(semantic.fun_ending ? [semantic.fun_ending.headline] : [])
  ];
  const headings = descendants(body, (node) => node.tag === 'h2');
  let previous = -1;
  for (const expected of expectedHeadings) {
    const node = headings.find((heading) => heading.start > previous && textContent(heading) === expected);
    if (!node) failures.push(`html.heading:${expected}`);
    else previous = node.start;
  }
  const actualHeadings = headings.map(textContent);
  const withTransparentCoverage = [...expectedHeadings, 'Evidence index', 'Read coverage'];
  if (!isDeepStrictEqual(actualHeadings, expectedHeadings) && !isDeepStrictEqual(actualHeadings, withTransparentCoverage)) failures.push('html.headings');

  if (!(candidate.insights.userResponseTimes?.length > 0) && !textContent(sectionWithHeading(body, 'User Response Time Distribution')).includes('No response time data')) failures.push('html.empty:response_time');
  if (!Object.values(candidate.insights.messageHours ?? {}).some((count) => Number(count) > 0) && !textContent(sectionWithHeading(body, 'User Messages by Time of Day')).includes('No time data')) failures.push('html.empty:time_of_day');
  if (!(candidate.insights.totalToolErrors > 0) && !textContent(sectionWithHeading(body, 'User Messages by Time of Day')).includes('No tool errors')) failures.push('html.empty:tool_errors');
  if (!(candidate.insights.multiClauding?.overlapEvents > 0) && !textContent(sectionWithHeading(body, 'Multi-Clauding (Parallel Sessions)')).includes('No parallel session usage was detected; you typically work with one session at a time.')) failures.push('html.empty:multi_clauding');
  return failures;
}

export function compareParityReports(reference, candidate, { candidateHtml, referenceFileHash, trustedReferenceFileHash } = {}) {
  if (!reference?.insights || !candidate?.insights) throw new Error('Parity comparison requires two Agent Insight report objects.');
  const structuralPaths = [
    'parity.target', 'parity.dataStatus', 'insights', 'semantic.sections',
    ...DETERMINISTIC_FIELDS.map((field) => `insights.${field}`),
    ...AGGREGATE_TASKS.flatMap((section) => [
      `semantic.sections.${section}`,
      ...SECTION_FIELDS[section].map((field) => `semantic.sections.${section}.${field}`)
    ])
  ];
  const missing = structuralPaths.filter((path) => {
    const parts = path.split('.');
    let value = candidate;
    for (const part of parts) {
      if (!hasOwn(value, part)) return true;
      value = value[part];
    }
    return false;
  });
  const mismatches = DETERMINISTIC_FIELDS.flatMap((field) => {
    const expected = reference.insights[field];
    const actual = candidate.insights[field];
    return isDeepStrictEqual(expected, actual) ? [] : [{ path: `insights.${field}`, reference: expected, candidate: actual }];
  });
  const htmlFailures = htmlContractFailures(candidateHtml, candidate);
  missing.push(...htmlFailures);
  const structuralTotal = structuralPaths.length + 1;
  const structuralPresent = structuralPaths.length - (missing.length - htmlFailures.length) + (htmlFailures.length ? 0 : 1);
  const structuralScore = score(structuralPresent, structuralTotal);
  const deterministicScore = score(DETERMINISTIC_FIELDS.length - mismatches.length, DETERMINISTIC_FIELDS.length);
  const fileHashVerified = /^[a-f0-9]{64}$/.test(referenceFileHash ?? '')
    && /^[a-f0-9]{64}$/.test(trustedReferenceFileHash ?? '')
    && referenceFileHash === trustedReferenceFileHash;
  const trustedReference = fileHashVerified
    && reference.parity?.provenance?.kind === 'claude-code'
    && reference.parity.provenance.version === '2.1.206'
    && typeof reference.parity.provenance.captureHash === 'string';
  return {
    schema: 'agent-insight/parity-comparison-v1',
    target: 'claude-code/2.1.206',
    reference: { trusted: trustedReference, fileHash: /^[a-f0-9]{64}$/.test(referenceFileHash ?? '') ? referenceFileHash : null, provenance: reference.parity?.provenance ?? null },
    structural: { required: structuralTotal, present: structuralPresent, score: structuralScore, missing },
    deterministic: { compared: DETERMINISTIC_FIELDS.length, matched: DETERMINISTIC_FIELDS.length - mismatches.length, score: deterministicScore, mismatches },
    semantic: { evaluation: 'blind_review_required', tieOrBetterThreshold: 0.8, sections: [...AGGREGATE_TASKS] },
    acceptance: {
      structuralParity: structuralScore === 1,
      deterministicCorrectness: deterministicScore === 1,
      trustedReference,
      semanticTieOrBetter: null,
      overall: false
    }
  };
}

function validatedEvidenceContext(report) {
  const context = report?.parity?.evidenceContext;
  if (!context || !Array.isArray(context.sessions) || context.sessions.length === 0) {
    throw new Error('Blind comparison requires a common evidence context.');
  }
  const semanticIds = new Set((report.semantic?.sessions ?? []).map((session) => session.id));
  const sessions = context.sessions.map((session) => {
    if (!session || typeof session.id !== 'string' || typeof session.source !== 'string' || typeof session.date !== 'string' || !semanticIds.has(session.id)) {
      throw new Error('Blind comparison common evidence context has an unknown session.');
    }
    if (!Array.isArray(session.grounding) || session.grounding.length === 0) throw new Error('Blind comparison common evidence context needs grounding evidence.');
    const grounding = session.grounding.map((item) => {
      if (!Array.isArray(item?.messageIndexes) || item.messageIndexes.length === 0 || item.messageIndexes.some((index) => !Number.isInteger(Number(index)))) {
        throw new Error('Blind comparison grounding needs message indexes.');
      }
      if (typeof item.description !== 'string' || !item.description.trim()) throw new Error('Blind comparison grounding needs a description.');
      return { messageIndexes: item.messageIndexes.map(Number), description: item.description.trim() };
    });
    return { id: session.id, source: session.source, date: session.date, grounding };
  });
  return { sessions };
}

function machineGates(comparison) {
  if (!comparison?.acceptance) return null;
  return {
    structuralParity: comparison.acceptance.structuralParity === true,
    deterministicCorrectness: comparison.acceptance.deterministicCorrectness === true,
    trustedReference: comparison.acceptance.trustedReference === true
  };
}

export function createBlindSemanticBundle(leftReport, rightReport, { seed = '', machineComparison = null } = {}) {
  if (!leftReport?.semantic?.sections || !rightReport?.semantic?.sections) throw new Error('Blind comparison requires semantic sections in both reports.');
  const leftContext = validatedEvidenceContext(leftReport);
  const rightContext = validatedEvidenceContext(rightReport);
  if (!isDeepStrictEqual(leftContext, rightContext)) throw new Error('Blind comparison requires identical common evidence context.');
  return {
    schema: 'agent-insight/blind-semantic-v1',
    target: 'claude-code/2.1.206',
    instructions: 'For each section choose A, B, or tie. Judge accuracy, usefulness, specificity, grounding, and personalization against the common evidence context without guessing origin.',
    evidenceContext: leftContext,
    machineGates: machineGates(machineComparison),
    items: AGGREGATE_TASKS.map((section) => {
      const swap = Number.parseInt(createHash('sha256').update(`${seed}\u0000${section}`).digest('hex').slice(0, 2), 16) % 2 === 1;
      const left = structuredClone(leftReport.semantic.sections[section]);
      const right = structuredClone(rightReport.semantic.sections[section]);
      return { section, A: swap ? right : left, B: swap ? left : right, rating: null };
    })
  };
}

export function evaluateBlindSemanticRatings(bundle, { seed = '' } = {}) {
  if (!Array.isArray(bundle?.items) || bundle.items.length !== AGGREGATE_TASKS.length) throw new Error('Invalid blind semantic review bundle.');
  let tieOrBetter = 0;
  const results = bundle.items.map((item) => {
    if (!['A', 'B', 'tie'].includes(item.rating)) throw new Error(`Missing blind rating for ${item.section}.`);
    const swap = Number.parseInt(createHash('sha256').update(`${seed}\u0000${item.section}`).digest('hex').slice(0, 2), 16) % 2 === 1;
    const candidateSide = swap ? 'A' : 'B';
    const passed = item.rating === 'tie' || item.rating === candidateSide;
    if (passed) tieOrBetter += 1;
    return { section: item.section, rating: item.rating, candidateSide, tieOrBetter: passed };
  });
  const rate = tieOrBetter / results.length;
  const passed = rate >= 0.8;
  const gates = bundle.machineGates ?? {};
  const acceptance = {
    structuralParity: gates.structuralParity === true,
    deterministicCorrectness: gates.deterministicCorrectness === true,
    trustedReference: gates.trustedReference === true,
    semanticTieOrBetter: passed,
    overall: gates.structuralParity === true && gates.deterministicCorrectness === true && gates.trustedReference === true && passed
  };
  return { schema: 'agent-insight/blind-semantic-result-v1', tieOrBetter, total: results.length, rate, passed, acceptance, results };
}

export { DETERMINISTIC_FIELDS };

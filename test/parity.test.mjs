import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareParityReports, createBlindSemanticBundle, evaluateBlindSemanticRatings } from '../src/parity.mjs';
import { main } from '../src/cli.mjs';

const sections = {
  project_areas: { areas: [] }, interaction_style: { narrative: 'n', keyPattern: 'k' },
  what_works: { intro: 'i', impressiveWorkflows: [] }, friction_analysis: { intro: 'i', categories: [] },
  suggestions: { instructionAdditions: [], featuresToTry: [], usagePatterns: [] },
  on_the_horizon: { intro: 'i', opportunities: [] }, fun_ending: { headline: 'h', detail: 'd' },
  at_a_glance: { whatsWorking: 'w', whatsHindering: 'h', quickWins: 'q', ambitiousWorkflows: 'a' }
};
const textOnlyImpostor = '<h2>At a Glance</h2><nav class="toc"></nav><section class="metrics"></section>What You Work On What You Wanted Languages How You Use User Response Time Distribution Parallel Sessions User Messages by Time of Day Impressive Things You Did What Helped Most Where Things Go Wrong Primary Friction Types Existing Agent Features to Try New Ways to Use Your Agent On the Horizon';
const contractHtml = `<!doctype html><html lang="en"><head><title>Claude Code Insights</title></head><body>
<header><h1>Claude Code Insights</h1><p class="subtitle">6 messages across 2 sessions | 2026-07-01 to 2026-07-02</p></header>
<section data-semantic-section="at_a_glance"><h2>At a Glance</h2></section>
<nav class="toc"><a>What You Work On</a><a>How You Use CC</a><a>Impressive Things</a><a>Where Things Go Wrong</a><a>Features to Try</a><a>New Usage Patterns</a><a>On the Horizon</a><span>Team Feedback</span></nav>
<section class="metrics"><article><span>Messages</span><strong>6</strong></article><article><span>Lines</span><strong>+3/-1</strong></article><article><span>Files</span><strong>1</strong></article><article><span>Days</span><strong>2</strong></article><article><span>Msgs/Day</span><strong>3</strong></article></section>
<section data-semantic-section="project_areas"><h2>What You Work On</h2></section>
<section><h2>What You Wanted</h2><div>Top Tools Used</div></section>
<section><h2>Languages</h2><div>Session Types</div></section>
<section data-semantic-section="interaction_style"><h2>How You Use Claude Code</h2></section>
<section><h2>User Response Time Distribution</h2></section>
<section><h2>Multi-Clauding (Parallel Sessions)</h2><div>No parallel session usage was detected; you typically work with one session at a time.</div></section>
<section><h2>User Messages by Time of Day</h2><div>Tool Errors Encountered</div></section>
<section data-semantic-section="what_works"><h2>Impressive Things You Did</h2></section>
<section><h2>What Helped Most (Claude's Capabilities)</h2><div>Outcomes</div></section>
<section data-semantic-section="friction_analysis"><h2>Where Things Go Wrong</h2></section>
<section><h2>Primary Friction Types</h2><div>Inferred Satisfaction</div></section>
<section data-semantic-section="suggestions"><h2>Existing CC Features to Try</h2><h3>Suggested CLAUDE.md Additions</h3></section>
<section data-semantic-section="suggestions"><h2>New Ways to Use Claude Code</h2></section>
<section data-semantic-section="on_the_horizon"><h2>On the Horizon</h2></section>
<section data-semantic-section="fun_ending"><h2>h</h2></section>
</body></html>`;

function report(overrides = {}) {
  return {
    parity: {
      target: 'claude-code/2.1.206', dataStatus: 'complete',
      provenance: { kind: 'claude-code', version: '2.1.206', captureHash: 'fixture-hash' },
      evidenceContext: {
        sessions: [{
          id: 'opaque-a', source: 'claude', date: '2026-07-01',
          grounding: [{ messageIndexes: [1], description: 'The session centers on a parser repair.' }]
        }]
      }
    },
    insights: {
      totalSessions: 2, totalSessionsScanned: 2, sessionsWithFacets: 2,
      dateRange: { start: '2026-07-01', end: '2026-07-02' }, totalMessages: 6,
      totalDurationHours: 1.5, totalInputTokens: 10, totalOutputTokens: 20,
      toolCounts: { Bash: 2 }, languages: { TypeScript: 1 }, gitCommits: 1, gitPushes: 1,
      projects: { demo: 2 }, goalCategories: { fix_bug: 2 }, outcomes: { fully_achieved: 2 },
      satisfaction: { satisfied: 2 }, helpfulness: { very_helpful: 2 }, sessionTypes: { single_task: 2 },
      friction: { tool_failed: 1 }, primarySuccesses: { good_debugging: 2 },
      totalInterruptions: 0, totalToolErrors: 1, toolErrorCategories: { 'Command Failed': 1 },
      userResponseTimes: [5], medianResponseTime: 5, averageResponseTime: 5,
      sessionsUsingTaskAgent: 1, sessionsUsingMcp: 0, sessionsUsingWebSearch: 1, sessionsUsingWebFetch: 0,
      totalLinesAdded: 3, totalLinesRemoved: 1, totalFilesModified: 1, daysActive: 2,
      messagesPerDay: 3, messageHours: { 9: 6 }, multiClauding: { overlapEvents: 0, sessionsInvolved: 0, userMessagesDuring: 0 },
      ...overrides
    },
    semantic: { sessions: [{ id: 'opaque-a', source: 'claude', date: '2026-07-01' }], sections: structuredClone(sections) }
  };
}

test('parity harness proves complete structure and exact deterministic metrics', () => {
  const result = compareParityReports(report(), report(), {
    candidateHtml: contractHtml,
    referenceFileHash: 'a'.repeat(64),
    trustedReferenceFileHash: 'a'.repeat(64)
  });
  assert.equal(result.structural.score, 1, JSON.stringify(result.structural));
  assert.equal(result.deterministic.score, 1);
  assert.equal(result.acceptance.structuralParity, true);
  assert.equal(result.acceptance.deterministicCorrectness, true);
  assert.equal(result.acceptance.trustedReference, true);
  assert.equal(result.acceptance.overall, false);
});

test('reference provenance requires an out-of-band verified file hash', () => {
  const selfAttested = compareParityReports(report(), report(), { candidateHtml: contractHtml });
  assert.equal(selfAttested.acceptance.trustedReference, false);

  const mismatch = compareParityReports(report(), report(), {
    candidateHtml: contractHtml,
    referenceFileHash: 'a'.repeat(64),
    trustedReferenceFileHash: 'b'.repeat(64)
  });
  assert.equal(mismatch.acceptance.trustedReference, false);

  const verified = compareParityReports(report(), report(), {
    candidateHtml: contractHtml,
    referenceFileHash: 'a'.repeat(64),
    trustedReferenceFileHash: 'a'.repeat(64)
  });
  assert.equal(verified.acceptance.trustedReference, true);
  assert.equal(verified.reference.fileHash, 'a'.repeat(64));
});

test('parity harness exposes missing sections and deterministic mismatches', () => {
  const candidate = report({ totalMessages: 7 });
  delete candidate.semantic.sections.fun_ending;
  const result = compareParityReports(report(), candidate, { candidateHtml: contractHtml });
  assert.equal(result.structural.missing.includes('semantic.sections.fun_ending'), true);
  assert.deepEqual(result.deterministic.mismatches[0], { path: 'insights.totalMessages', reference: 6, candidate: 7 });
  assert.equal(result.acceptance.structuralParity, false);
  assert.equal(result.acceptance.deterministicCorrectness, false);
});

test('structural parity rejects text that is not a valid nested report DOM', () => {
  const result = compareParityReports(report(), report(), { candidateHtml: textOnlyImpostor });
  assert.equal(result.acceptance.structuralParity, false);
  assert.ok(result.structural.missing.some((failure) => failure.startsWith('html.dom:')));
});

test('structural parity rejects a valid DOM whose glance, TOC, and metrics are reordered', () => {
  const toc = contractHtml.match(/<nav class="toc">[\s\S]*?<\/nav>/)[0];
  const reordered = contractHtml.replace(toc, '').replace('</section>\n<section data-semantic-section="project_areas">', `</section>\n${toc}\n<section data-semantic-section="project_areas">`);
  const result = compareParityReports(report(), report(), { candidateHtml: reordered });
  assert.equal(result.acceptance.structuralParity, false);
  assert.ok(result.structural.missing.includes('html.order:glance-toc-metrics'));
});

test('structural parity rejects an unmarked semantic section that should be absent', () => {
  const candidate = report();
  delete candidate.semantic.sections.at_a_glance;
  const unmarkedGlance = contractHtml.replace(' data-semantic-section="at_a_glance"', '');
  const result = compareParityReports(report(), candidate, { candidateHtml: unmarkedGlance });
  assert.equal(result.acceptance.structuralParity, false);
  assert.ok(result.structural.missing.includes('html.semantic:at_a_glance'));
});

test('structural parity rejects extra headings hidden alongside the expected structure', () => {
  const injected = contractHtml.replace('<section><h2>What You Wanted</h2>', '<section><h2>Wrong Heading</h2></section><section><h2>What You Wanted</h2>');
  const result = compareParityReports(report(), report(), { candidateHtml: injected });
  assert.equal(result.acceptance.structuralParity, false);
  assert.ok(result.structural.missing.includes('html.headings'));
});

test('extensions schema and audit HTML headings are excluded from Claude baseline parity scoring', () => {
  const withExtensions = report();
  withExtensions.extensions = {
    userAudit: {
      status: 'complete',
      protocolVersion: 'user-audit/v1',
      aggregate: {
        topThree: [{ pattern: 'Ship without a gate', severity: 'high', explanation: 'Done is undefined.', evidenceSessionIds: ['opaque-a'] }],
        remaining: [],
        selfDefeatingPatterns: [],
        strengths: [],
        automationCandidates: [],
        highestLeverageChange: { change: 'Name the gate first', rationale: 'Stops rework.' }
      }
    }
  };
  const divergentExtensions = structuredClone(withExtensions);
  divergentExtensions.extensions.userAudit.aggregate.highestLeverageChange.change = 'Totally different advice';

  const extensionTail = `
<section data-extension-section="user_audit"><h2>Three hard truths</h2></section>
<section data-extension-section="user_audit_all"><h2>All findings</h2></section>
<section data-extension-section="user_audit_self_defeating"><h2>Habits that undercut you</h2></section>
<section data-extension-section="user_audit_strengths"><h2>Habits worth keeping</h2></section>
<section data-extension-section="user_audit_automation"><h2>Automation candidates</h2></section>
<section data-extension-section="user_audit_leverage"><h2>One highest-leverage change</h2></section>
<section><h2>Evidence index</h2></section>
<section><h2>Read coverage</h2></section>
`;
  const htmlWithExtensions = contractHtml.replace('</body></html>', `${extensionTail}</body></html>`);
  const result = compareParityReports(report(), divergentExtensions, {
    candidateHtml: htmlWithExtensions,
    referenceFileHash: 'a'.repeat(64),
    trustedReferenceFileHash: 'a'.repeat(64)
  });
  assert.equal(result.structural.score, 1, JSON.stringify(result.structural));
  assert.equal(result.deterministic.score, 1);
  assert.equal(result.acceptance.structuralParity, true);
  assert.equal(result.acceptance.deterministicCorrectness, true);
  assert.deepEqual(result.excludedFromBaseline.schemaPaths, ['extensions']);
  assert.ok(result.excludedFromBaseline.htmlHeadings.includes('Three hard truths'));
  assert.equal(result.semantic.sections.includes('userAudit'), false);
  assert.equal(JSON.stringify(result).includes('Totally different advice'), false);

  const interleaved = contractHtml.replace(
    '<section><h2>What You Wanted</h2>',
    '<section><h2>Three hard truths</h2></section><section><h2>What You Wanted</h2>'
  );
  const interleavedResult = compareParityReports(report(), withExtensions, { candidateHtml: interleaved });
  assert.equal(interleavedResult.acceptance.structuralParity, false);
  assert.ok(interleavedResult.structural.missing.includes('html.headings'));
});

test('incomplete audit extension HTML still passes baseline structural parity gates', () => {
  const incomplete = report();
  incomplete.extensions = {
    userAudit: { status: 'incomplete', protocolVersion: 'user-audit/v1', failure: { reason: 'invalid_analyzer_response' }, sessions: {}, aggregate: null }
  };
  incomplete.parity.dataStatus = 'partial';
  const incompleteTail = `
<section data-extension-section="user_audit"><h2>Three hard truths</h2><div class="empty">User audit extension coverage is incomplete.</div></section>
<section><h2>Evidence index</h2></section>
<section><h2>Read coverage</h2></section>
`;
  const html = contractHtml.replace('</body></html>', `${incompleteTail}</body></html>`);
  const result = compareParityReports(report(), incomplete, { candidateHtml: html });
  assert.equal(result.acceptance.structuralParity, true, JSON.stringify(result.structural));
  assert.equal(result.acceptance.deterministicCorrectness, true);
});

test('blind semantic bundle hides candidate identity and covers all eight sections', () => {
  const left = report();
  left.extensions = { userAudit: { status: 'complete', aggregate: { topThree: [{ pattern: 'secret roast' }] } } };
  const right = report();
  right.extensions = { userAudit: { status: 'incomplete', failure: { reason: 'analyzer_failure' } } };
  const bundle = createBlindSemanticBundle(left, right, { seed: 'fixed' });
  assert.equal(bundle.items.length, 8);
  assert.equal(JSON.stringify(bundle).includes('reference'), false);
  assert.equal(JSON.stringify(bundle).includes('candidate'), false);
  assert.equal(JSON.stringify(bundle).includes('secret roast'), false);
  assert.equal(JSON.stringify(bundle).includes('userAudit'), false);
  assert.ok(bundle.items.every((item) => item.A && item.B && item.section));
  assert.deepEqual(bundle.evidenceContext.sessions[0], {
    id: 'opaque-a', source: 'claude', date: '2026-07-01',
    grounding: [{ messageIndexes: [1], description: 'The session centers on a parser repair.' }]
  });
});

test('blind semantic bundle rejects reports without identical common grounding', () => {
  const right = report();
  right.parity.evidenceContext.sessions[0].grounding[0].description = 'Different source context.';
  assert.throws(() => createBlindSemanticBundle(report(), right, { seed: 'fixed' }), /common evidence context/);
});

test('blind semantic ratings close the 80 percent acceptance gate', () => {
  const comparison = compareParityReports(report(), report(), {
    candidateHtml: contractHtml,
    referenceFileHash: 'a'.repeat(64),
    trustedReferenceFileHash: 'a'.repeat(64)
  });
  const bundle = createBlindSemanticBundle(report(), report(), { seed: 'fixed', machineComparison: comparison });
  for (const item of bundle.items) item.rating = 'tie';
  const result = evaluateBlindSemanticRatings(bundle, { seed: 'fixed' });
  assert.equal(result.rate, 1);
  assert.equal(result.passed, true);
  assert.deepEqual(result.acceptance, {
    structuralParity: true,
    deterministicCorrectness: true,
    trustedReference: true,
    semanticTieOrBetter: true,
    overall: true
  });
});

test('parity CLI writes machine-readable comparison and blind-review artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-parity-'));
  const left = join(root, 'left.json');
  const right = join(root, 'right.json');
  const output = join(root, 'comparison.json');
  const blind = join(root, 'blind.json');
  await writeFile(left, JSON.stringify(report()));
  await writeFile(right, JSON.stringify(report()));
  await writeFile(join(root, 'left.html'), contractHtml);
  await writeFile(join(root, 'right.html'), contractHtml);
  const result = await main(['parity', 'compare', '--reference', left, '--candidate', right, '--output', output, '--blind-output', blind], { quiet: true });
  assert.equal(result.acceptance.structuralParity, true);
  assert.equal(JSON.parse(await readFile(output, 'utf8')).deterministic.score, 1);
  assert.equal(JSON.parse(await readFile(blind, 'utf8')).items.length, 8);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeSessions } from '../src/analyze.mjs';
import { renderHtml } from '../src/report.mjs';
import { compareParityReports } from '../src/parity.mjs';

function session() {
  return {
    id: 'internal-a', source: 'claude', project: '/work/parser', startedAt: '2026-07-01T09:00:00.000Z', endedAt: '2026-07-01T09:10:00.000Z',
    userMessages: 3, assistantMessages: 4, toolCalls: 5, toolErrors: 1, turnFailures: 0, inputTokens: 100, outputTokens: 40,
    toolNames: { Edit: 2, Bash: 2, Read: 1 }, languages: { TypeScript: 2 }, gitCommits: 1, gitPushes: 1,
    userInterruptions: 1, userResponseTimes: [5, 45, 180], toolErrorCategories: { 'Command Failed': 1 },
    usesTaskAgent: true, usesMcp: false, usesWebSearch: true, usesWebFetch: false,
    linesAdded: 12, linesRemoved: 3, filesModified: 2, messageHours: { 9: 3 }, userMessageTimestamps: ['2026-07-01T09:00:00.000Z'],
    providers: { anthropic: 1 }, models: { sonnet: 1 }, partial: false, recordsRead: 10, hasBranches: false
  };
}

function semantic() {
  const evidenceSessionIds = ['opaque-a'];
  return {
    analyzer: { host: 'claude', model: 'current' },
    sessions: [{
      id: 'opaque-a',
      sessionId: 'claude-session-a',
      date: '2026-07-01',
      source: 'claude',
      projectPath: '/work/parser',
      projectLabel: 'parser',
      transcriptPath: '/tmp/claude-session-a.jsonl',
      reopenCommand: '/tmp/claude-session-a.jsonl',
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 5,
      toolErrors: 1,
      durationMinutes: 10,
      startedAt: '2026-07-01T09:00:00.000Z',
      endedAt: '2026-07-01T09:10:00.000Z',
      facet: {
        underlyingGoal: 'Fix a parser', briefSummary: 'Parser fixed', goalCategories: { fix_bug: 1 }, outcome: 'fully_achieved',
        userSatisfactionCounts: { satisfied: 1 }, agentHelpfulness: 'very_helpful', sessionType: 'single_task',
        frictionCounts: { tool_failed: 1 }, frictionDetail: 'A command failed.', primarySuccess: 'good_debugging',
        evidence: [{
          messageIndexes: [1],
          description: 'User requested a parser fix.',
          quotation: 'Please fix the parser now',
          sessionId: 'claude-session-a',
          projectPath: '/work/parser'
        }]
      }
    }],
    sections: {
      at_a_glance: { whatsWorking: 'Verification works.', whatsHindering: 'Tools sometimes fail.', quickWins: 'Create a skill.', ambitiousWorkflows: 'Automate releases.', evidenceSessionIds },
      project_areas: { areas: [{ name: 'Parser reliability', sessionCount: 1, description: 'Parser fixes and tests.', evidenceSessionIds }] },
      interaction_style: { narrative: 'You work in short verification loops.', keyPattern: 'Verify each change.', evidenceSessionIds },
      what_works: { intro: 'Focused checks work.', impressiveWorkflows: [{ title: 'Verification loop', description: 'You close the loop.', evidenceSessionIds }] },
      friction_analysis: { intro: 'Tooling causes friction.', categories: [{ category: 'Tool failures', description: 'Commands can fail.', examples: [{ text: 'One command failed.', evidenceSessionIds }] }] },
      suggestions: {
        instructionAdditions: [{ addition: 'Run tests.', why: 'It recurs.', promptScaffold: 'Add under Testing.', evidenceSessionIds }],
        featuresToTry: [{ feature: 'Custom Skills', oneLiner: 'Reuse workflows.', whyForYou: 'You repeat checks.', exampleCode: '/test', evidenceSessionIds }],
        usagePatterns: [{ title: 'State the gate', suggestion: 'Name checks.', detail: 'It clarifies done.', copyablePrompt: 'Finish after tests.', evidenceSessionIds }]
      },
      on_the_horizon: { intro: 'Larger loops are coming.', opportunities: [{ title: 'Release validation', whatsPossible: 'Autonomous checks.', howToTry: 'Start bounded.', copyablePrompt: 'Validate release.', evidenceSessionIds }] },
      fun_ending: { headline: 'The parser blinked first', detail: 'The stubborn failure became green.', evidenceSessionIds }
    }
  };
}

test('HTML follows the Claude 2.1.206 insights information architecture in order', () => {
  const report = summarizeSessions([session()], { semantic: semantic() });
  const html = renderHtml(report);
  assert.match(html, /<title>Claude Code Insights<\/title>/);
  assert.match(html, /<h1>Claude Code Insights<\/h1><p class="subtitle">3 messages across 1 sessions \| 2026-07-01 to 2026-07-01<\/p>/);
  assert.match(html, /<span>Lines<\/span><strong>\+12\/-3<\/strong>/);
  assert.ok(html.indexOf('<h2>At a Glance</h2>') < html.indexOf('<nav class="toc"'));
  assert.ok(html.indexOf('<nav class="toc"') < html.indexOf('<section class="metrics">'));
  assert.ok(html.indexOf('<section class="metrics">') < html.indexOf('<section id="what-you-work-on"'));
  const headings = [
    'At a Glance', 'What You Work On', 'What You Wanted', 'Languages', 'How You Use Claude Code',
    'User Response Time Distribution', 'Multi-Clauding (Parallel Sessions)', 'User Messages by Time of Day',
    'Impressive Things You Did', "What Helped Most (Claude's Capabilities)", 'Where Things Go Wrong',
    'Primary Friction Types', 'Existing CC Features to Try', 'New Ways to Use Claude Code',
    'On the Horizon', 'The parser blinked first'
  ];
  let previous = -1;
  for (const heading of headings) {
    const index = html.indexOf(`<h2>${heading}</h2>`);
    assert.ok(index > previous, `${heading} should appear in report order`);
    previous = index;
  }
  const toc = [
    'What You Work On', 'How You Use', 'Impressive Things', 'Where Things Go Wrong',
    'Features to Try', 'New Usage Patterns', 'On the Horizon', 'Team Feedback'
  ];
  assert.ok(toc.every((label) => html.includes(label)), 'fixed parity table of contents should be present');
  assert.match(html, />Team Feedback<\/span>/);
  assert.match(html, /Suggested CLAUDE\.md Additions/);
  assert.match(html, /id="time-zone"/);
  assert.match(html, /PT \(UTC-8\).*ET \(UTC-5\).*London \(UTC\).*CET \(UTC\+1\).*Tokyo \(UTC\+9\)/s);
  assert.match(html, /data-utc-hours=/);
  assert.match(html, /aria-label="Top tools data"/);
  assert.match(html, /2–10s/);
  assert.match(html, /Morning/);
  assert.match(html, /Evidence: claude-session-a · claude · 2026-07-01 · \/work\/parser/);
  assert.match(html, /Primary successes/);
  assert.match(html, /Evidence index/);
  assert.match(html, /Please fix the parser now/);
  assert.match(html, /<td>claude-session-a<\/td><td>claude<\/td><td>2026-07-01<\/td><td>\/work\/parser<\/td><td><code>\/tmp\/claude-session-a\.jsonl<\/code><\/td>/);
  // Optional font / Mermaid CDN links are allowed; report body must not invent external URLs.
  const bodyStart = html.indexOf('<body');
  const bodyHtml = bodyStart >= 0 ? html.slice(bodyStart) : html;
  assert.doesNotMatch(bodyHtml.replace(/https:\/\/cdn\.jsdelivr\.net\/[^"'>\s]+/g, ''), /https:\/\//);
  assert.equal(compareParityReports(report, report, { candidateHtml: html }).acceptance.structuralParity, true);
});

test('fused user-audit extension HTML remains outside Claude baseline parity scoring', () => {
  const finding = (accusation, severity = 'high') => ({
    category: 'acceptance_criteria',
    severity,
    evidencePosture: 'established_pattern',
    accusation,
    explanation: 'The ask jumps to a fix without stating the gate.',
    quotations: ['just fix it'],
    locators: [{ sessionId: 'claude-session-a', messageIndexes: [1] }],
    occurrenceCount: 1,
    betterAlternative: 'Name the failing case first.',
    copyablePrompt: 'Fix only the failing parser case; stop when the named test is green.',
    rootCause: accusation.toLowerCase()
  });
  const extensions = {
    userAudit: {
      status: 'complete',
      protocolVersion: 'user-audit/v1',
      sessions: {},
      aggregate: {
        topThree: [finding('You ship without a gate'), finding('You retry without diagnosis', 'medium'), finding('You imply the mission', 'low')],
        remaining: [finding('You skip the written done check', 'medium')],
        selfDefeatingPatterns: [{
          pattern: 'Just make it work',
          intent: 'avoid specifying done',
          explanation: 'Skips the acceptance gate.',
          quotations: [],
          locators: [{ sessionId: 'claude-session-a', messageIndexes: [1] }]
        }],
        strengths: [{
          habit: 'Ask for a failing case',
          explanation: 'Grounds the fix.',
          quotations: [],
          locators: [{ sessionId: 'claude-session-a', messageIndexes: [1] }]
        }],
        automationCandidates: [{
          type: 'Skill',
          name: 'parser-regression-gate',
          frequency: 'recurring',
          trigger: 'parser fix request',
          inputs: ['failing case'],
          outputs: ['green tests'],
          rationale: 'Repeats every session.',
          overAutomationRisk: 'May hide novel failures.',
          draftBody: '# parser-regression-gate\n\nRequire a failing case before edits.'
        }],
        highestLeverageChange: {
          change: 'Name the failing case first',
          rationale: 'Prevents rework.',
          copyablePrompt: 'Before edits: failing case is X; done when test Y is green.'
        }
      }
    }
  };
  const report = summarizeSessions([session()], { semantic: semantic(), extensions });
  const html = renderHtml(report);
  assert.match(html, /Three hard truths/);
  assert.match(html, /One highest-leverage change/);
  assert.match(html, /This run’s one change/);
  assert.match(html, /Try saying this next/);
  assert.match(html, /Before edits: failing case is X/);
  assert.match(html, /Estimated cost in cited sessions/);
  assert.match(html, /Reopen: \/tmp\/claude-session-a\.jsonl/);
  assert.match(html, /Copyable draft/);
  assert.match(html, /parser-regression-gate/);
  assert.match(html, /data-extension-toc/);
  assert.ok(html.indexOf('One highest-leverage change') < html.indexOf('Three hard truths'));
  assert.ok(html.indexOf('Three hard truths') > html.indexOf('The parser blinked first'));
  assert.ok(html.indexOf('This run’s one change') < html.indexOf('<nav class="toc"'));
  const result = compareParityReports(report, report, { candidateHtml: html });
  assert.equal(result.acceptance.structuralParity, true, JSON.stringify(result.structural));
  assert.equal(result.acceptance.deterministicCorrectness, true);
  assert.ok(result.excludedFromBaseline.htmlHeadings.includes('Three hard truths'));
});

test('partial source coverage plus incomplete audit still yields a usable Claude baseline', () => {
  const extensions = {
    userAudit: {
      status: 'incomplete',
      protocolVersion: 'user-audit/v1',
      failure: { reason: 'analyzer_failure' },
      sessions: {},
      aggregate: null
    }
  };
  const report = summarizeSessions([session()], {
    sourcesScanned: [{ source: 'claude', coverage: 'partial', filesFound: 4, filesSelected: 2, filesLimited: 2 }],
    semantic: semantic(),
    extensions
  });
  assert.equal(report.parity.structuralStatus, 'complete');
  assert.equal(report.parity.dataStatus, 'partial');
  assert.equal(report.coverage.extensionFailures[0].extension, 'userAudit');
  const html = renderHtml(report);
  assert.match(html, /At a Glance/);
  assert.match(html, /The parser blinked first/);
  assert.match(html, /Three hard truths/);
  assert.match(html, /User audit extension coverage is incomplete/);
  assert.match(html, /complete structure · partial data coverage/);
  assert.equal(compareParityReports(report, report, { candidateHtml: html }).acceptance.structuralParity, true);
});

test('HTML omits missing semantic sections while retaining deterministic charts and the fixed TOC', () => {
  const html = renderHtml(summarizeSessions([session()], {
    semantic: { analyzer: { host: 'claude', model: 'current' }, sessions: [], sections: {} }
  }));

  for (const semanticHeading of [
    'At a Glance', 'What You Work On', 'How You Use Claude Code', 'Impressive Things You Did',
    'Where Things Go Wrong', 'Existing CC Features to Try', 'New Ways to Use Claude Code',
    'On the Horizon', 'A memorable moment'
  ]) {
    assert.doesNotMatch(html, new RegExp(`<h2>${semanticHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h2>`));
  }
  for (const deterministicHeading of [
    'What You Wanted', 'Languages', 'User Response Time Distribution',
    'Multi-Clauding (Parallel Sessions)', 'User Messages by Time of Day',
    "What Helped Most (Claude's Capabilities)", 'Primary Friction Types'
  ]) {
    assert.ok(html.includes(`<h2>${deterministicHeading}</h2>`));
  }
  assert.match(html, /<nav class="toc"/);
  assert.match(html, />Team Feedback<\/span>/);
});

test('non-Claude default locale uses Agent Insight brand and Chinese chrome', () => {
  const report = summarizeSessions([{
    ...session(),
    id: 'cursor-a',
    source: 'cursor'
  }], {
    locale: 'zh',
    semantic: {
      analyzer: { host: 'cursor', model: 'composer' },
      sessions: [],
      sections: {
        interaction_style: { narrative: '短验证循环。', keyPattern: '先写验收。', evidenceSessionIds: [] }
      }
    }
  });
  assert.equal(report.locale, 'zh');
  const html = renderHtml(report);
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>Agent Insight<\/title>/);
  assert.match(html, /<h1>Agent Insight<\/h1>/);
  assert.doesNotMatch(html, /Claude Code Insights/);
  assert.match(html, /<h2>你如何使用 Agent<\/h2>/);
  assert.match(html, /<h2>并行会话<\/h2>/);
  assert.match(html, /<h2>最有帮助的能力<\/h2>/);
  assert.match(html, /可尝试的能力/);
});

test('HTML skin uses NewsLiquid editorial tokens', () => {
  const html = renderHtml(summarizeSessions([session()], { semantic: semantic() }));
  assert.match(html, /--bg:#FBFAF7/);
  assert.match(html, /font-family:var\(--serif\)/);
  assert.match(html, /header class="mast"/);
  assert.match(html, /class="eyebrow"/);
  assert.match(html, /nav class="toc"/);
  assert.match(html, /class="wordmark"/);
  assert.match(html, /\.mermaid\{/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/);
});

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
  assert.match(html, /<td>claude-session-a<\/td><td>claude<\/td><td>2026-07-01<\/td><td>\/work\/parser<\/td>/);
  assert.doesNotMatch(html, /https:\/\//);
  assert.equal(compareParityReports(report, report, { candidateHtml: html }).acceptance.structuralParity, true);
});

test('HTML omits missing semantic sections while retaining deterministic charts and the fixed TOC', () => {
  const html = renderHtml(summarizeSessions([session()]));

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

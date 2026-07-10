import assert from 'node:assert/strict';
import test from 'node:test';

import { summarizeSessions } from '../src/analyze.mjs';
import { renderHtml } from '../src/report.mjs';

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
    sessions: [{ id: 'opaque-a', date: '2026-07-01', facet: {
      underlyingGoal: 'Fix a parser', briefSummary: 'Parser fixed', goalCategories: { fix_bug: 1 }, outcome: 'fully_achieved',
      userSatisfactionCounts: { satisfied: 1 }, agentHelpfulness: 'very_helpful', sessionType: 'single_task',
      frictionCounts: { tool_failed: 1 }, frictionDetail: 'A command failed.', primarySuccess: 'good_debugging'
    } }],
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
  const html = renderHtml(summarizeSessions([session()], { semantic: semantic() }));
  const headings = [
    'At a Glance', 'What You Work On', 'What You Wanted', 'Languages', 'How You Use',
    'User Response Time Distribution', 'Parallel Sessions', 'User Messages by Time of Day',
    'Impressive Things You Did', 'What Helped Most', 'Where Things Go Wrong',
    'Primary Friction Types', 'Existing Agent Features to Try', 'New Ways to Use Your Agent',
    'On the Horizon', 'The parser blinked first'
  ];
  let previous = -1;
  for (const heading of headings) {
    const index = html.search(new RegExp(`<h2[^>]*>${heading}`));
    assert.ok(index > previous, `${heading} should appear in report order`);
    previous = index;
  }
  const toc = [
    'What You Work On', 'How You Use', 'Impressive Things', 'Where Things Go Wrong',
    'Features to Try', 'New Usage Patterns', 'On the Horizon', 'Team Feedback'
  ];
  assert.ok(toc.every((label) => html.includes(label)), 'fixed parity table of contents should be present');
  assert.match(html, /Team Feedback \(not generated\)/);
  assert.match(html, /id="time-zone"/);
  assert.match(html, /PT \(UTC-8\).*ET \(UTC-5\).*London \(UTC\).*CET \(UTC\+1\).*Tokyo \(UTC\+9\)/s);
  assert.match(html, /data-utc-hours=/);
  assert.match(html, /aria-label="Top tools data"/);
  assert.match(html, /2–10s/);
  assert.match(html, /Morning/);
  assert.match(html, /Evidence: opaque-a/);
  assert.doesNotMatch(html, /https:\/\//);
});

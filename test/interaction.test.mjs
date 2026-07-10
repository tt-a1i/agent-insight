import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveInsightRequest } from '../src/interaction.mjs';

test('interactive insights defaults to the current host and a 30-day window', async () => {
  const questions = [];
  const answers = ['current', '30'];
  const request = await resolveInsightRequest({ host: 'codex' }, {
    ask: async (question) => {
      questions.push(question);
      return answers.shift();
    }
  });

  assert.deepEqual(request, {
    host: 'codex',
    sources: ['codex'],
    scope: 'current',
    days: 30,
    start: null,
    end: null,
    semantic: true,
    fast: false
  });
  assert.equal(questions.length, 2);
  assert.match(questions[0], /current.*all.*select/i);
  assert.match(questions[1], /7.*30.*90.*all.*custom/i);
});

test('interactive insights can analyze every supported agent for seven days', async () => {
  const answers = ['all', '7'];
  const request = await resolveInsightRequest({ host: 'claude' }, {
    ask: async () => answers.shift()
  });

  assert.equal(request.scope, 'all');
  assert.equal(request.days, 7);
  assert.deepEqual(request.sources, ['claude', 'codex', 'cursor', 'opencode', 'pi']);
});

test('interactive insights can select specific agents for a 90-day window', async () => {
  const answers = ['select', 'claude, codex', '90'];
  const request = await resolveInsightRequest({ host: 'pi' }, {
    ask: async () => answers.shift()
  });

  assert.equal(request.scope, 'select');
  assert.equal(request.days, 90);
  assert.deepEqual(request.sources, ['claude', 'codex']);
});

test('interactive insights can include all available history', async () => {
  const answers = ['current', 'all'];
  const request = await resolveInsightRequest({ host: 'opencode' }, {
    ask: async () => answers.shift()
  });

  assert.equal(request.days, Infinity);
  assert.equal(request.start, null);
  assert.equal(request.end, null);
});

test('interactive insights accepts an explicit date range', async () => {
  const answers = ['current', 'custom', '2026-06-01', '2026-06-30'];
  const request = await resolveInsightRequest({ host: 'cursor' }, {
    ask: async () => answers.shift()
  });

  assert.equal(request.days, null);
  assert.equal(request.start, '2026-06-01');
  assert.equal(request.end, '2026-06-30');
});

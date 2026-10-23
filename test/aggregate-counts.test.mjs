import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateAggregateResult } from '../src/aggregate-protocol.mjs';
import { prepareSemanticRun, nextSemanticTask, ingestSemanticResult, getSemanticRun } from '../src/semantic-run.mjs';

const area = (count, ids = ['a']) => ({ areas: [{ name: 'Parser', description: 'Parser work.', session_count: count, evidence_session_ids: ids }] });

test('project area counts require native safe integers consistent with canonical citations and analyzed sessions', () => {
  const context = { sessions: [{ id: 'a', sessionId: 'alias-a' }, { id: 'b' }] };
  for (const count of [null, undefined, false, true, '', [], {}, '1', -1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3, 999999]) {
    assert.throws(() => validateAggregateResult('project_areas', area(count), context), /session_count/);
  }
  assert.throws(() => validateAggregateResult('project_areas', area(1, ['a', 'b']), context), /between 2 cited sessions and 2 analyzed sessions/);
  const result = validateAggregateResult('project_areas', area(1, ['a', 'alias-a', 'a']), context);
  assert.equal(result.areas[0].sessionCount, 1);
  assert.deepEqual(result.areas[0].evidenceSessionIds, ['a']);
  assert.equal(validateAggregateResult('project_areas', area(2), context).areas[0].sessionCount, 2);
  assert.deepEqual(validateAggregateResult('project_areas', { areas: [] }, context), { areas: [] });
});

test('chunked project counts keep the full analyzed bound when carry retains only representative sessions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-area-counts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidates = [];
  for (let index = 0; index < 25; index += 1) {
    const path = join(root, `source-${index}.jsonl`);
    await writeFile(path, [
      { type: 'user', sessionId: `parser-${index}`, timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: 'Please fix parser' } },
      { type: 'user', sessionId: `parser-${index}`, timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: 'Run tests' } }
    ].map(JSON.stringify).join('\n'));
    candidates.push({ source: 'claude', locator: { kind: 'file', path } });
  }
  const runsRoot = join(root, 'runs');
  const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: Infinity }, candidates, analyzer: { host: 'claude', model: 'test' } });
  const opts = { runsRoot, runId: prepared.id };
  let task = await nextSemanticTask(opts);
  while (task.kind === 'session_facet') {
    await ingestSemanticResult({ ...opts, taskId: task.id, result: {
      underlying_goal: 'Fix parser', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved', user_satisfaction_counts: {}, agent_helpfulness: 'very_helpful', session_type: 'single_task', friction_counts: {}, friction_detail: 'No friction observed.', primary_success: 'correct_code_edits', brief_summary: 'Parser fixed. '.repeat(70), evidence: [{ message_indexes: [1], description: 'Parser fix request.', quotation: 'Please fix parser' }]
    } });
    task = await nextSemanticTask(opts);
  }
  const completed = await getSemanticRun(opts);
  assert.equal(completed.sessions.filter((session) => session.status === 'complete').length, 25);
  let prior = [];
  let chunks = 0;
  while (task.kind === 'aggregate_chunk') {
    assert.equal(task.section, 'project_areas');
    const data = JSON.parse(task.request.prompt.split('<insights-data>\n')[1].split('\n</insights-data>')[0]);
    prior = [...new Set([...prior, ...data.sessions.map((session) => session.id).filter(Boolean)])].slice(-20);
    await ingestSemanticResult({ ...opts, taskId: task.id, result: { summary: 'All 25 analyzed sessions concern parser work; citations remain representative.', evidence_session_ids: prior } });
    chunks += 1;
    task = await nextSemanticTask(opts);
  }
  assert.ok(chunks > 1);
  assert.equal(prior.length, 20);
  assert.equal(task.id, 'aggregate:project_areas');
  const before = await readFile(prepared.manifestPath, 'utf8');
  await assert.rejects(ingestSemanticResult({ ...opts, taskId: task.id, result: area(26, [prior[0]]) }), /25 analyzed sessions/);
  assert.equal(await readFile(prepared.manifestPath, 'utf8'), before);
  assert.deepEqual(await nextSemanticTask(opts), task);
  const dropped = completed.sessions.find((session) => !prior.includes(session.id));
  await assert.rejects(ingestSemanticResult({ ...opts, taskId: task.id, result: area(25, [dropped.id]) }), /unknown evidence session/);
  const accepted = await ingestSemanticResult({ ...opts, taskId: task.id, result: area(25, [prior[0]]) });
  assert.equal(accepted.areas[0].sessionCount, 25);
  assert.equal(accepted.areas[0].evidenceSessionIds.length, 1);
});

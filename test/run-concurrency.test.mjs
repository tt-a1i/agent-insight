import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { failSemanticTask, finalizeSemanticRun, getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun, withSemanticRunTransaction } from '../src/semantic-run.mjs';

const moduleURL = new URL('../src/semantic-run.mjs', import.meta.url).href;
const workerCode = `
const job = JSON.parse(process.argv[1]);
const api = await import(job.moduleURL);
const wait = () => new Promise(resolve => process.once('message', resolve));
process.send({event:'ready'});
await wait();
try {
  const value = job.hold ? await api.withSemanticRunTransaction(job.context, async tx => {
    await tx.getRun();
    process.send({event:'locked'});
    await wait();
    return tx.ingest(job.result);
  }) : await api.ingestSemanticResult({...job.context,...job.result});
  process.send({event:'accepted',value}); process.exit(0);
} catch (error) { process.send({event:'rejected',code:error.code,message:error.message}); process.exit(1); }
`;

function worker(t, job) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', workerCode, JSON.stringify({ ...job, moduleURL })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const history = [];
  const listeners = [];
  child.on('message', (message) => {
    history.push(message);
    for (const listener of [...listeners]) if (listener.events.includes(message.event)) {
      listeners.splice(listeners.indexOf(listener), 1);
      listener.resolve(message);
    }
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return {
    send: () => child.send('go'), exited,
    wait: (...events) => history.some((message) => events.includes(message.event))
      ? Promise.resolve(history.find((message) => events.includes(message.event)))
      : new Promise((resolve) => listeners.push({ events, resolve }))
  };
}

async function seed(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = join(root, 'runs');
  const prepared = await prepareSemanticRun({
    runsRoot, request: { host: 'claude', sources: ['claude'], days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: new URL('./fixtures/claude-parity.jsonl', import.meta.url) } }],
    analyzer: { host: 'claude', model: 'test' }
  });
  const context = { runsRoot, runId: prepared.id };
  const first = await nextSemanticTask(context);
  await ingestSemanticResult({ ...context, taskId: first.id, result: {
    underlying_goal: 'Fix parser', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved',
    user_satisfaction_counts: {}, agent_helpfulness: 'very_helpful', session_type: 'single_task',
    friction_counts: {}, friction_detail: '', primary_success: 'good_debugging', brief_summary: 'Parser fixed.', evidence: []
  } });
  const batch = await nextSemanticTask(context);
  const run = await getSemanticRun(context);
  const evidence = { evidence_session_ids: [run.sessions[0].id] };
  return { context, batch, results: [
    { taskId: 'aggregate:project_areas', result: { areas: [{ name: 'Parser', session_count: 1, description: 'Parser work', ...evidence }] } },
    { taskId: 'aggregate:interaction_style', result: { narrative: 'You verify changes.', key_pattern: 'Verification', ...evidence } }
  ] };
}

test('an external run transaction excludes next, ingest, fail and finalize until cleanup completes', async (t) => {
  const { context, batch, results } = await seed(t);
  const owner = worker(t, { context, result: results[0], hold: true });
  await owner.wait('ready'); owner.send(); await owner.wait('locked');
  const submissionPath = batch.tasks.find((task) => task.id === results[1].taskId).submissionPath;
  await writeFile(submissionPath, JSON.stringify(results[1].result));
  for (const operation of [
    () => nextSemanticTask(context),
    () => ingestSemanticResult({ ...context, ...results[1] }),
    () => failSemanticTask({ ...context, taskId: results[1].taskId, reason: 'analyzer_failure' }),
    () => finalizeSemanticRun({ ...context, outputDirectory: join(context.runsRoot, 'report') })
  ]) await assert.rejects(operation(), { code: 'ERR_SEMANTIC_RUN_BUSY' });
  assert.deepEqual(JSON.parse(await readFile(submissionPath, 'utf8')), results[1].result);
  owner.send();
  assert.equal((await owner.wait('accepted', 'rejected')).event, 'accepted');
  await owner.exited;
  await ingestSemanticResult({ ...context, ...results[1] });
  const run = await getSemanticRun(context);
  assert.deepEqual(Object.keys(run.sections).sort(), ['interaction_style', 'project_areas']);
  assert.equal(run.aggregateBatch.ids.includes(results[0].taskId), false);
  assert.equal(run.aggregateBatch.ids.includes(results[1].taskId), false);
});

test('simultaneous real-process ingests never lose either accepted aggregate result', async (t) => {
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const { context, results } = await seed(t);
    const children = results.map((result) => worker(t, { context, result }));
    await Promise.all(children.map((child) => child.wait('ready')));
    children.forEach((child) => child.send());
    const outcomes = await Promise.all(children.map((child) => child.wait('accepted', 'rejected')));
    await Promise.all(children.map((child) => child.exited));
    const first = await getSemanticRun(context);
    for (let index = 0; index < outcomes.length; index += 1) {
      const section = results[index].taskId.split(':')[1];
      if (outcomes[index].event === 'accepted') assert.ok(first.sections[section]);
      else {
        assert.equal(outcomes[index].code, 'ERR_SEMANTIC_RUN_BUSY');
        await ingestSemanticResult({ ...context, ...results[index] });
      }
    }
    assert.deepEqual(Object.keys((await getSemanticRun(context)).sections).sort(), ['interaction_style', 'project_areas']);
  }
});

test('a transaction keeps its lock through an awaited callback and rejects escaped or overlapping methods', async (t) => {
  const { context } = await seed(t);
  let escaped;
  await withSemanticRunTransaction(context, async (transaction) => {
    escaped = transaction;
    const reading = transaction.getRun();
    assert.throws(() => transaction.next(), /still running/);
    await reading;
    await assert.rejects(nextSemanticTask(context), { code: 'ERR_SEMANTIC_RUN_BUSY' });
    assert.equal((await transaction.next()).kind, 'aggregate_batch');
  });
  assert.throws(() => escaped.next(), /already closed/);
  assert.equal((await nextSemanticTask(context)).kind, 'aggregate_batch');
});

test('accepted semantic results retain their value with a warning during persistent lock cleanup failures', async (t) => {
  const { context, results } = await seed(t);
  const original = fs.unlink;
  fs.unlink = async (path, ...args) => {
    if (String(path).includes('/.run-lock/owner-')) throw Object.assign(new Error('persistent lock release failure'), { code: 'EACCES' });
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const accepted = await ingestSemanticResult({ ...context, ...results[0] });
    assert.equal(accepted.areas[0].name, 'Parser');
    assert.equal(accepted.lockCleanupWarning.code, 'EACCES');
    assert.ok((await getSemanticRun(context)).sections.project_areas);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(nextSemanticTask(context), { code: 'ERR_DIRECTORY_LOCK_CLEANUP_PENDING', operationCompleted: false });
    }
    assert.ok((await getSemanticRun(context)).sections.project_areas);
  } finally {
    fs.unlink = original;
    syncBuiltinESMExports();
  }
  const next = await nextSemanticTask(context);
  assert.equal(next.tasks.some((task) => task.id === results[0].taskId), false);
  await ingestSemanticResult({ ...context, ...results[1] });
  assert.ok((await getSemanticRun(context)).sections.interaction_style);
});

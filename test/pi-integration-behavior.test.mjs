import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { installIntegration } from '../src/integrations.mjs';

const runId = 'abababab-abab-4bab-abab-abababababab';
const execFileAsync = promisify(execFile);

async function installedCommand(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-insight-pi-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = await installIntegration({ agent: 'pi', scope: 'project', cwd: directory, home: directory });
  const source = await readFile(target, 'utf8');
  // Remove only this extension's type annotations and import seams so the
  // installed .ts executes under the package's Node 20 minimum without Pi.
  const executable = source.replace(/^import .*;$/gm, '')
    .replace('const execFileAsync = promisify(execFile);', '')
    .replace('pi: ExtensionAPI', 'pi')
    .replace('value: string', 'value')
    .replace('const timeArgs: string[]', 'const timeArgs')
    .replace('let runId: string | undefined', 'let runId')
    .replace('export default function', 'return function');
  const events = [], calls = [], delivered = [], queued = [], runtimeErrors = [], notifications = [];
  const answers = [...(options.answers ?? ['Current agent', 'All history'])];
  let command;
  const pi = {
    registerCommand(name, registration) {
      assert.equal(name, 'agent-insights');
      command = registration;
    },
    sendUserMessage(content, delivery) {
      events.push('handoff');
      // Pi's extension binding returns void and routes asynchronous failures
      // to its runtime error channel rather than the command's catch block.
      Promise.resolve().then(() => {
        if (options.handoffFailure) throw new Error('host handoff failed');
        if (options.streaming) {
          if (delivery?.deliverAs !== 'followUp') throw new Error('streaming requires followUp');
          queued.push({ content, delivery });
        } else delivered.push({ content, delivery });
      }).catch((error) => runtimeErrors.push(error.message));
    }
  };
  new Function('execFileAsync', executable)(async (file, args, childOptions) => {
    calls.push({ file, args, options: childOptions });
    if (options.prepareFailure) throw new Error('prepare failed');
    return { stdout: options.stdout ?? JSON.stringify({ runId }), stderr: '' };
  })(pi);
  return {
    directory, events, calls, delivered, queued, runtimeErrors, notifications,
    async invoke() {
      await command.handler('', {
        cwd: directory, model: options.model === null ? undefined : { id: options.model ?? 'test-model' },
        isIdle: () => !options.streaming,
        abort: () => { throw new Error('the existing task must remain active'); },
        ui: {
          select: async () => answers.shift(), input: async () => answers.shift(),
          notify: (message, kind) => { events.push('notify'); notifications.push({ message, kind }); }
        }
      });
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
}

test('installed Pi entry delivers while idle and preserves model, source and time arguments', async (t) => {
  const selections = [
    { answers: ['Current agent', 'Last 7 days'], model: ' exact-model ', tail: ['pi', '--days', '7'], expectedModel: 'exact-model' },
    { answers: ['All agents', 'Last 30 days'], tail: ['claude,codex,cursor,opencode,pi', '--days', '30'] },
    { answers: ['Specific agents', ' CODEX,pi,pi ', 'Last 90 days'], tail: ['codex,pi', '--days', '90'] },
    { answers: ['Current agent', 'All history'], model: null, tail: ['pi', '--all'], expectedModel: 'unknown' },
    { answers: ['Current agent', 'Custom dates', '2026-10-01', '2026-10-22'], tail: ['pi', '--start', '2026-10-01', '--end', '2026-10-22'] }
  ];
  for (const selection of selections) {
    const entry = await installedCommand(t, selection);
    await entry.invoke();
    assert.equal(entry.calls.length, 1);
    assert.equal(entry.calls[0].file, 'agent-insight');
    assert.deepEqual(entry.calls[0].args, ['prepare', '--host', 'pi', '--model', selection.expectedModel ?? 'test-model', '--source', ...selection.tail]);
    assert.equal(entry.calls[0].options.cwd, entry.directory);
    assert.equal(entry.delivered.length, 1);
    assert.equal(entry.queued.length, 0);
    assert.deepEqual(entry.delivered[0].delivery, { deliverAs: 'followUp' });
    assert.ok(entry.delivered[0].content.includes(runId));
    assert.deepEqual(entry.events, ['notify', 'handoff']);
    assert.match(entry.notifications[0].message, /prepared; analysis pending/);
    assert.ok(entry.notifications[0].message.includes(`--model '${selection.expectedModel ?? 'test-model'}'`));
    assert.equal(entry.runtimeErrors.length, 0);
  }
});

test('installed Pi entry queues a follow-up while streaming without interrupting the existing task', async (t) => {
  const entry = await installedCommand(t, { streaming: true });
  await entry.invoke();
  assert.equal(entry.queued.length, 1);
  assert.equal(entry.delivered.length, 0);
  assert.equal(entry.runtimeErrors.length, 0);
  assert.deepEqual(entry.events, ['notify', 'handoff']);
  assert.ok(entry.notifications[0].message.includes(runId));
});

test('prepared run remains recoverable when the void handoff API later fails', async (t) => {
  const entry = await installedCommand(t, { handoffFailure: true });
  await entry.invoke();
  assert.deepEqual(entry.runtimeErrors, ['host handoff failed']);
  assert.equal(entry.delivered.length + entry.queued.length, 0);
  assert.equal(entry.notifications.length, 1);
  assert.equal(entry.notifications[0].kind, 'info');
  assert.ok(entry.notifications[0].message.includes(`semantic next --run '${runId}' --host pi --model 'test-model'`));
  assert.match(entry.notifications[0].message, /analysis pending/);
  assert.doesNotMatch(entry.notifications[0].message, /analysis complete|report generated/i);
});

test('cancelled selections and invalid agent selections do not prepare or hand off a run', async (t) => {
  for (const answers of [[undefined], ['Specific agents', undefined], ['Current agent', undefined], ['Current agent', 'Custom dates', undefined], ['Current agent', 'Custom dates', '2026-10-01', undefined], ['Specific agents', 'unsupported']]) {
    const entry = await installedCommand(t, { answers });
    await entry.invoke();
    assert.equal(entry.calls.length, 0);
    assert.equal(entry.delivered.length + entry.queued.length, 0);
    assert.ok(entry.notifications.every((notice) => notice.kind === 'error'));
  }
});

test('prepare failure or missing run ID reports an error without a pending-run claim', async (t) => {
  for (const options of [{ prepareFailure: true }, { stdout: 'not a run ID' }, ...[{}, 42, `${runId}; extra`, '-'.repeat(36)].map((id) => ({ stdout: JSON.stringify({ runId: id }) }))]) {
    const entry = await installedCommand(t, options);
    await entry.invoke();
    assert.equal(entry.calls.length, 1);
    assert.equal(entry.delivered.length + entry.queued.length, 0);
    assert.equal(entry.notifications.length, 1);
    assert.equal(entry.notifications[0].kind, 'error');
    assert.doesNotMatch(entry.notifications[0].message, /prepared; analysis pending/);
  }
});

async function captureCommandArgv(command, action) {
  const modelArg = command.slice(command.indexOf(' --model ') + ' --model '.length);
  // Validate the complete quote grammar before invoking a shell. Regressions
  // fail here instead of executing model-supplied expansion or shell syntax.
  assert.match(modelArg, /^'(?:[^']|'"'"')*'$/);
  const taskArgs = ['ingest', 'fail'].includes(action) ? ' --task <task-id>' : '';
  const reasonArgs = action === 'fail' ? ' --reason analyzer_failure' : '';
  assert.equal(command, `agent-insight semantic ${action} --run '${runId}'${taskArgs}${reasonArgs} --host pi --model ${modelArg}`);
  const approved = command.replace(/^agent-insight /, 'capture ').replace('<task-id>', "'synthetic-task'");
  const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', 'capture() { printf "%s\\0" "$@"; }\n' + approved], { env: {} });
  assert.equal(stderr, '');
  return stdout.split('\0').slice(0, -1);
}

test('all generated Pi commands preserve shell-sensitive model IDs as literal argv', async (t) => {
  for (const model of ['model variant', "vendor/model'variant", 'model $(not-a-command) `not-a-command`']) {
    const entry = await installedCommand(t, { model });
    await entry.invoke();
    assert.equal(entry.calls[0].args[4], model);
    const resume = entry.notifications[0].message.split('Resume with: ')[1];
    const handoff = entry.delivered[0].content.split('\n');
    const commands = [
      ['next', resume],
      ['next', handoff[1].slice('1. Run '.length).replace(/ and parse the JSON task\.$/, '')],
      ['ingest', handoff[3].slice('3. Ingest completed results one at a time with '.length).replace(/\.$/, '')],
      ['finalize', handoff[5].slice('5. Run '.length).split(', then open the fused report')[0]],
      ['fail', 'agent-insight semantic fail ' + handoff[6].split('run agent-insight semantic fail ')[1].split(', continue the loop')[0]]
    ];
    for (const [action, command] of commands) {
      const argv = await captureCommandArgv(command, action);
      assert.equal(argv[argv.indexOf('--model') + 1], model);
      assert.equal(argv[argv.indexOf('--run') + 1], runId);
      assert.equal(argv[argv.indexOf('--host') + 1], 'pi');
    }
  }
});

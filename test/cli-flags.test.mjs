import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { main, parseFlags } from '../src/cli.mjs';

const now = Date.parse('2026-07-04T12:00:00Z');

async function fixture(t, history = false) {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-flags-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
  t.after(() => {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
  });
  const context = { home, cwd: home, now, quiet: true };
  const project = join(home, 'projects', 'a=b=c');
  if (history) {
    const directory = join(home, '.claude', 'projects', 'synthetic');
    await mkdir(directory, { recursive: true });
    for (const [id, days] of [['recent', 0.5], ['older', 3], ['historical', 60]]) {
      const start = now - days * 86_400_000;
      const records = [0, 120_000].map((offset) => ({
        type: 'user', sessionId: id, cwd: project,
        timestamp: new Date(start + offset).toISOString(),
        message: { role: 'user', content: 'Check the parser regression.' }
      }));
      await writeFile(join(directory, `${id}.jsonl`), records.map(JSON.stringify).join('\n'));
    }
  }
  const prepare = async (options = []) => {
    const prepared = await main(['prepare', '--host', 'claude', '--source', 'claude', ...options], context);
    return JSON.parse(await readFile(prepared.manifestPath, 'utf8'));
  };
  return { home, project, context, prepare };
}

test('missing or blank values and unknown flags fail before prompts or output writes', async (t) => {
  const { home, context } = await fixture(t);
  for (const key of ['days', 'max-sessions', 'max-file-mb', 'max-discovery-files', 'model', 'source', 'host', 'project', 'output', 'input']) {
    for (const invalid of [[`--${key}`], [`--${key}=`], [`--${key}`, '   ']]) {
      await assert.rejects(main(['prepare', '--host', 'claude', ...invalid], context), new RegExp(`--${key} requires a non-empty`));
    }
  }
  let prompts = 0;
  await assert.rejects(main(['insights', '--host', 'claude', '--model'], { ...context, ask: async () => { prompts += 1; } }), /--model requires/);
  assert.equal(prompts, 0);
  await assert.rejects(main(['import', '--source', 'generic', '--from'], context), /--from requires/);
  await assert.rejects(main(['report', '--source', 'claude', '--ouput', join(home, 'wrong')], context), /Unknown option: --ouput/);
  await assert.rejects(access(join(home, '.agent-insight')), { code: 'ENOENT' });
});

test('boolean values keep false scope narrow and retain the omitted-model default', async (t) => {
  const { prepare } = await fixture(t, true);
  const normal = await prepare();
  assert.equal(normal.request.days, 30);
  assert.equal(normal.analyzer.model, 'unknown');
  assert.equal(normal.sessions.length, 2);
  for (const flags of [['--all=false'], ['--all', 'false']]) {
    const run = await prepare(flags);
    assert.equal(run.request.days, 30);
    assert.equal(run.sessions.length, 2);
  }
  for (const flags of [['--all'], ['--all=true'], ['--all', 'true']]) {
    const run = await prepare(flags);
    assert.equal(run.request.days, 'all');
    assert.equal(run.sessions.length, 3);
  }
});

test('false force values cannot authorize replacing an existing integration', async (t) => {
  const { home, context } = await fixture(t);
  const directory = join(home, '.claude', 'commands');
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'agent-insights.md');
  const original = Buffer.from('Keep the existing user integration.\n');
  await writeFile(target, original);
  for (const flags of [['--force=false'], ['--force', 'false']]) {
    await assert.rejects(main(['install', '--agent', 'claude', ...flags], context), /already exists/);
    assert.deepEqual(await readFile(target), original);
  }
  await assert.rejects(main(['install', '--agent', 'claude', '--force=not-a-boolean'], context), /--force requires true or false/);
  assert.deepEqual(await readFile(target), original);
  await main(['install', '--agent', 'claude', '--force', 'true'], context);
  assert.match(await readFile(target, 'utf8'), /current Claude model/);
});

test('inline project/model assignments preserve every equals sign through prepare and semantic ownership', async (t) => {
  const { project, context, prepare } = await fixture(t, true);
  const model = 'provider=variant=revision';
  const inline = await prepare(['--all', `--project=${project}`, `--model=${model}`]);
  const separate = await prepare(['--all', '--project', project, '--model', model]);
  for (const run of [inline, separate]) {
    assert.equal(run.request.project, project);
    assert.equal(run.analyzer.model, model);
    assert.equal(run.sessions.length, 3);
    const task = await main(['semantic', 'next', '--run', run.id, '--host', 'claude', '--model', model], context);
    assert.equal(task.kind, 'session_facet');
  }
});

test('shared parser supports every existing boolean form and preserves parity/import string payloads', () => {
  for (const key of ['all', 'fast', 'force', 'include-subagents', 'json']) {
    assert.equal(parseFlags([`--${key}`])[key], true);
    assert.equal(parseFlags([`--${key}=true`])[key], true);
    assert.equal(parseFlags([`--${key}`, 'true'])[key], true);
    assert.equal(parseFlags([`--${key}=false`])[key], false);
    assert.equal(parseFlags([`--${key}`, 'false'])[key], false);
    for (const invalid of ['', ' ', 'yes', '0', 'false=extra']) {
      assert.throws(() => parseFlags([`--${key}=${invalid}`]), /requires true or false/);
    }
    assert.throws(() => parseFlags([`--${key}`, 'yes']), /requires true or false/);
  }
  const flags = parseFlags(['compare', '--reference=a=b.json', '--reference-sha256', 'abc', '--candidate=c=d.json', '--candidate-html=c=d.html', '--blind-output=review=x.json', '--review=review=y.json', '--seed=secret=a=b', '--from=export=a=b.jsonl', '--input=one=a.jsonl', '--input', 'two=b.jsonl']);
  assert.deepEqual(flags._, ['compare']);
  assert.equal(flags.reference, 'a=b.json');
  assert.equal(flags['candidate-html'], 'c=d.html');
  assert.equal(flags['blind-output'], 'review=x.json');
  assert.equal(flags.review, 'review=y.json');
  assert.equal(flags.seed, 'secret=a=b');
  assert.equal(flags.from, 'export=a=b.jsonl');
  assert.deepEqual(flags.input, ['one=a.jsonl', 'two=b.jsonl']);
});

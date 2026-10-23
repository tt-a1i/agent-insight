import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getSemanticRun, nextSemanticTask, PROMPT_VERSION, RUN_SCHEMA } from '../src/semantic-run.mjs';

test('older evidence checkpoints cannot silently reuse unvalidated facets or changed chunk boundaries', async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'agent-insight-run-version-'));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const runId = '11111111-1111-1111-1111-111111111111';
  const directory = join(runsRoot, runId);
  await mkdir(directory);
  const manifestPath = join(directory, 'manifest.json');
  const reportPath = join(directory, 'report.html');
  await writeFile(reportPath, 'Existing report');
  for (const schema of ['agent-insight/semantic-run-v1', 'agent-insight/semantic-run-v2', 'agent-insight/semantic-run-v3', 'agent-insight/semantic-run-v4']) {
    const manifest = JSON.stringify({ schema, id: runId, sessions: [], sections: {} });
    await writeFile(manifestPath, manifest);
    for (const read of [getSemanticRun, nextSemanticTask]) {
      await assert.rejects(read({ runsRoot, runId }), /older evidence protocol.*prepare again.*preserved/);
    }
    assert.equal(await readFile(manifestPath, 'utf8'), manifest);
  }
  assert.equal(await readFile(reportPath, 'utf8'), 'Existing report');
  assert.equal(RUN_SCHEMA, 'agent-insight/semantic-run-v5');
  assert.equal(PROMPT_VERSION, 'session-facet-v5');
});

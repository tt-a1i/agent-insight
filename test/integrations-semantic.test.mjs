import assert from 'node:assert/strict';
import test from 'node:test';

import { renderIntegration } from '../src/integrations.mjs';

test('Markdown host commands orchestrate every run with the active host model', () => {
  const hosts = [
    ['claude', 'Claude', /claude\s+(?:-p|--print)/i],
    ['codex', 'Codex', /codex\s+exec/i],
    ['cursor', 'Cursor', /cursor-agent\s+(?:-p|--print)/i],
    ['opencode', 'OpenCode', /opencode\s+run/i]
  ];

  for (const [agent, label, childCommand] of hosts) {
    const command = renderIntegration(agent);
    assert.match(command, /every invocation/i);
    assert.match(command, /current agent.*all agents.*specific agents/is);
    assert.match(command, /7 days.*30 days.*90 days.*all history.*custom/is);
    assert.match(command, new RegExp(`agent-insight prepare --host ${agent} --source`));
    assert.match(command, /agent-insight semantic next --run/);
    assert.match(command, /submissionPath/);
    assert.match(command, /agent-insight semantic ingest --run.*--task/is);
    assert.match(command, /agent-insight semantic finalize --run/);
    assert.match(command, new RegExp(`current ${label} model`, 'i'));
    assert.doesNotMatch(command, childCommand);
  }
});

test('Pi command asks both choices in its UI before handing the run to the active model', () => {
  const extension = renderIntegration('pi');

  assert.match(extension, /ctx\.ui\.select\("Agent scope"/);
  assert.match(extension, /Current agent.*All agents.*Specific agents/is);
  assert.match(extension, /ctx\.ui\.select\("Time range"/);
  assert.match(extension, /Last 7 days.*Last 30 days.*Last 90 days.*All history.*Custom/is);
  assert.match(extension, /"prepare", "--host", "pi", "--source"/);
  assert.match(extension, /agent-insight semantic next --run/);
  assert.match(extension, /submissionPath/);
  assert.match(extension, /agent-insight semantic ingest --run.*--task/is);
  assert.match(extension, /agent-insight semantic finalize --run/);
  assert.match(extension, /current Pi model/i);
  assert.doesNotMatch(extension, /execFileAsync\("pi"|\bpi\s+(?:-p|--print)\b/i);
});

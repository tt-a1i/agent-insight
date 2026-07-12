import assert from 'node:assert/strict';
import test from 'node:test';

import { HELP } from '../src/cli.mjs';
import { AGENTS, renderIntegration } from '../src/integrations.mjs';

test('Markdown host commands orchestrate the fused one-shot loop with the active host model', () => {
  const hosts = [
    ['claude', 'Claude', /claude\s+(?:-p|--print)/i],
    ['codex', 'Codex', /codex\s+exec/i],
    ['cursor', 'Cursor', /cursor-agent\s+(?:-p|--print)/i],
    ['opencode', 'OpenCode', /opencode\s+run/i]
  ];

  for (const [agent, label, childCommand] of hosts) {
    const command = renderIntegration(agent);
    assert.match(command, /fused Agent Insights report/i);
    assert.match(command, /every invocation/i);
    assert.match(command, /current agent.*all agents.*specific agents/is);
    assert.match(command, /7 days.*30 days.*90 days.*all history.*custom/is);
    assert.match(command, /exact model ID/i);
    assert.match(command, /literal `unknown`/i);
    assert.match(command, new RegExp(`agent-insight prepare --host ${agent} --model <exact-model-id-or-unknown> --source`));
    assert.match(command, /agent-insight semantic next --run/);
    assert.match(command, /session_audit/);
    assert.match(command, /audit_aggregate/);
    assert.match(command, /aggregate_batch/);
    assert.match(command, /submissionPath/);
    assert.match(command, /agent-insight semantic ingest --run.*--task/is);
    assert.match(command, /agent-insight semantic fail --run.*--task/is);
    assert.match(command, /agent-insight semantic finalize --run/);
    assert.match(command, new RegExp(`current ${label} model`, 'i'));
    assert.match(command, /no cross-run cache command/i);
    assert.match(command, /highest-leverage change|hard truths/i);
    assert.match(command, /paste-ready rewrite/i);
    assert.doesNotMatch(command, /agent-insight\s+cache\b/i);
    assert.doesNotMatch(command, childCommand);
  }
});

test('Cursor and OpenCode integrations keep coverage limits explicit', () => {
  assert.match(renderIntegration('cursor'), /Cursor collection is experimental/i);
  assert.match(renderIntegration('opencode'), /root sessions only/i);
  assert.doesNotMatch(renderIntegration('claude'), /experimental/i);
  assert.doesNotMatch(renderIntegration('claude'), /root sessions only/i);
});

test('Pi command asks both choices in its UI before handing the fused run to the active model', () => {
  const extension = renderIntegration('pi');

  assert.match(extension, /ctx\.ui\.select\("Agent scope"/);
  assert.match(extension, /Current agent.*All agents.*Specific agents/is);
  assert.match(extension, /ctx\.ui\.select\("Time range"/);
  assert.match(extension, /Last 7 days.*Last 30 days.*Last 90 days.*All history.*Custom/is);
  assert.match(extension, /"prepare", "--host", "pi", "--model", modelId, "--source"/);
  assert.match(extension, /agent-insight semantic next --run/);
  assert.match(extension, /session_audit/);
  assert.match(extension, /audit_aggregate/);
  assert.match(extension, /submissionPath/);
  assert.match(extension, /agent-insight semantic ingest --run.*--task/is);
  assert.match(extension, /agent-insight semantic fail --run.*--task/is);
  assert.match(extension, /agent-insight semantic finalize --run/);
  assert.match(extension, /fused.*report/i);
  assert.match(extension, /current Pi model/i);
  assert.match(extension, /no cross-run cache command/i);
  assert.doesNotMatch(extension, /agent-insight\s+cache\b/i);
  assert.doesNotMatch(extension, /execFileAsync\("pi"|\bpi\s+(?:-p|--print)\b/i);
});

test('Pi passes the active model identity and an explicit unknown fallback to prepare', () => {
  const extension = renderIntegration('pi');

  assert.match(extension, /ctx\.model\??\.id/);
  assert.match(extension, /"unknown"/);
  assert.match(extension, /\["prepare", "--host", "pi", "--model", modelId, "--source", sources/);
});

test('Pi lets prepare finish without a hard timeout', () => {
  const extension = renderIntegration('pi');

  assert.doesNotMatch(extension, /\btimeout\s*:/);
});

test('CLI help describes the fused one-shot flow without cache commands', () => {
  assert.match(HELP, /fused/i);
  assert.match(HELP, /semantic next\|ingest\|fail\|finalize/);
  assert.match(HELP, /no cross-run cache/i);
  assert.match(HELP, /parity compare\|evaluate is optional developer compatibility tooling/i);
  assert.match(HELP, /acceptance\.overall is not a product ship gate/i);
  assert.match(HELP, /Cursor coverage is experimental/i);
  assert.match(HELP, /OpenCode is root-session-only/i);
  assert.match(HELP, /Groq is provider\/import-only/i);
  assert.doesNotMatch(HELP, /agent-insight\s+cache\b/i);
  assert.deepEqual(AGENTS, ['claude', 'codex', 'cursor', 'opencode', 'pi']);
});

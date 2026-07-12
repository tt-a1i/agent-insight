import assert from 'node:assert/strict';
import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { contentPrivacyEnabled } from '../src/privacy.mjs';
import { validateSessionFacet } from '../src/protocol.mjs';
import { extractAnalysisInput } from '../src/transcript.mjs';

test('content privacy filtering is disabled for evidence-bearing reports', () => {
  assert.equal(contentPrivacyEnabled(), false);
});

test('session facets may include verbatim quotations, absolute paths, and session identifiers', () => {
  const input = {
    source: 'claude',
    sessionId: 'claude-parity',
    opaqueId: 'abc123abc123abc123abc123',
    date: '2026-07-03',
    projectPath: '/Users/private/project',
    projectLabel: 'project',
    messages: [
      { index: 1, role: 'user', text: 'Fix the broken parser using sk-test_credential_shape_token' },
      { index: 2, role: 'assistant', text: 'Working on /Users/private/project/secret.ts' }
    ]
  };
  const facet = validateSessionFacet({
    underlying_goal: 'Repair the parser',
    goal_categories: { fix_bug: 1 },
    outcome: 'fully_achieved',
    user_satisfaction_counts: { satisfied: 1 },
    agent_helpfulness: 'very_helpful',
    session_type: 'single_task',
    friction_counts: {},
    friction_detail: 'Touched /Users/private/project/secret.ts',
    primary_success: 'good_debugging',
    brief_summary: 'User said Fix the broken parser using sk-test_credential_shape_token',
    evidence: [{
      message_indexes: [1],
      description: 'User asked to fix the parser in /Users/private/project',
      quotation: 'Fix the broken parser using sk-test_credential_shape_token'
    }]
  }, input);

  assert.equal(facet.evidence[0].quotation, 'Fix the broken parser using sk-test_credential_shape_token');
  assert.equal(facet.evidence[0].projectPath, '/Users/private/project');
  assert.equal(facet.evidence[0].sessionId, 'claude-parity');
  assert.match(facet.briefSummary, /sk-test_credential_shape_token/);
  assert.match(facet.frictionDetail, /\/Users\/private\/project\/secret\.ts/);
});

test('filesystem safety still refuses symbolic-link transcripts and oversized reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-insight-privacy-fs-'));
  const target = join(root, 'real.jsonl');
  const link = join(root, 'alias.jsonl');
  await writeFile(target, `${JSON.stringify({ type: 'user', timestamp: '2026-07-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } })}\n`);
  await symlink(target, link);
  await assert.rejects(extractAnalysisInput(link, 'claude'), /symbolic-link/);
  await assert.rejects(extractAnalysisInput(target, 'claude', { maxBytes: 32 }), /semantic byte limit/);
});

import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FacetCache } from '../src/cache.mjs';
import { failSemanticTask, finalizeSemanticRun, getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun, PROMPT_VERSION } from '../src/semantic-run.mjs';
import { extractAnalysisInput } from '../src/transcript.mjs';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('semantic run exposes transcript only in the next task and persists only a validated facet', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const run = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30, start: null, end: null, semantic: true, fast: false },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: 'test-model' }
  });

  assert.match(run.id, /^[a-f0-9-]{36}$/);
  const stored = await readFile(run.manifestPath, 'utf8');
  assert.equal(stored.includes('Fix the broken parser'), false);
  assert.equal(stored.includes('I will fix and verify it'), false);
  assert.equal(stored.includes('/work/parity'), false);
  assert.equal(JSON.parse(stored).sessions[0].metrics.userMessages, 2);
  assert.equal((await stat(run.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(run.manifestPath)).mode & 0o777, 0o600);

  const task = await nextSemanticTask({ runsRoot, cache, runId: run.id });
  assert.equal(task.kind, 'session_facet');
  assert.equal(task.request.task, 'session_facet');
  assert.equal(JSON.stringify(task.input).includes('Fix the broken parser'), true);
  await ingestSemanticResult({
    runsRoot,
    cache,
    runId: run.id,
    taskId: task.id,
    result: {
      underlying_goal: 'Fix a parser',
      goal_categories: { fix_bug: 1 },
      outcome: 'fully_achieved',
      user_satisfaction_counts: { unsure: 1 },
      claude_helpfulness: 'very_helpful',
      session_type: 'single_task',
      friction_counts: {},
      friction_detail: '',
      primary_success: 'correct_code_edits',
      brief_summary: 'The parser was inspected and fixed.',
      evidence: [{ message_indexes: [1], description: 'The user requested a parser fix.' }]
    }
  });

  const completed = await getSemanticRun({ runsRoot, runId: run.id });
  assert.equal(completed.sessions[0].status, 'complete');
  assert.equal(completed.sessions[0].facet.outcome, 'fully_achieved');
  assert.equal(JSON.stringify(completed).includes('Fix the broken parser'), false);
  assert.equal((await cache.status()).entries, 1);

  const aggregate = await nextSemanticTask({ runsRoot, cache, runId: run.id });
  assert.equal(aggregate.kind, 'aggregate_batch');
  const projectTask = aggregate.tasks.find((task) => task.section === 'project_areas');
  assert.equal(projectTask.request.task, 'project_areas');
  assert.match(projectTask.request.prompt, /"totalMessages":2/);
  assert.equal(JSON.stringify(aggregate).includes('Fix the broken parser'), false);
  await ingestSemanticResult({
    runsRoot,
    cache,
    runId: run.id,
    taskId: projectTask.id,
    result: {
      areas: [{
        name: 'Parser work',
        session_count: 1,
        description: 'The session focused on parser correctness.',
        evidence_session_ids: [completed.sessions[0].id]
      }]
    }
  });
  assert.equal((await getSemanticRun({ runsRoot, runId: run.id })).sections.project_areas.areas[0].name, 'Parser work');
});

test('parity eligibility visibly excludes sessions with fewer than two user messages', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-eligibility-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [
      { source: 'claude', locator: { kind: 'file', path: fixture('claude.jsonl') } },
      { source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }
    ],
    analyzer: { host: 'claude', model: null }
  });

  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.sessions.filter((session) => session.status === 'excluded').length, 1);
  assert.equal(run.sessions.find((session) => session.status === 'excluded').eligibilityReason, 'fewer_than_two_user_messages');
  assert.deepEqual(run.eligibility, { scanned: 2, eligible: 1, excluded: 1, reasons: { fewer_than_two_user_messages: 1 } });
  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'session_facet');
});

test('ingest validates against the frozen task shape even if the active transcript grows', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-active-'));
  const transcript = join(home, 'active.jsonl');
  await copyFile(fixture('claude-parity.jsonl'), transcript);
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: null }
  });
  const task = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:03:00.000Z', message: { role: 'assistant', content: 'new host activity' } })}\n`);

  await ingestSemanticResult({
    runsRoot,
    cache,
    runId: prepared.id,
    taskId: task.id,
    result: {
      underlying_goal: 'Fix a parser', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved',
      user_satisfaction_counts: { satisfied: 1 }, claude_helpfulness: 'very_helpful', session_type: 'single_task',
      friction_counts: {}, friction_detail: '', primary_success: 'good_debugging', brief_summary: 'Parser fixed.',
      evidence: [{ message_indexes: [1], description: 'The user asked for the parser fix.' }]
    }
  });
  assert.equal((await getSemanticRun({ runsRoot, runId: prepared.id })).sessions[0].status, 'complete');
  assert.equal((await cache.status()).entries, 0, 'unknown model identity must bypass reusable cache');
});

test('a transcript changed before its task is exposed is excluded instead of aborting the run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-changing-'));
  const transcript = join(home, 'changing.jsonl');
  await copyFile(fixture('claude-parity.jsonl'), transcript);
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: null }
  });
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:03:00.000Z', message: { role: 'assistant', content: 'prepare command completed' } })}\n`);

  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'complete');
  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.sessions[0].status, 'excluded');
  assert.equal(run.sessions[0].eligibilityReason, 'changed_after_prepare');
});

test('verbatim analyzer output is rejected before cache or manifest persistence', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-privacy-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: 'test-model' }
  });
  const task = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  await assert.rejects(ingestSemanticResult({
    runsRoot,
    cache,
    runId: prepared.id,
    taskId: task.id,
    result: {
      underlying_goal: 'Repair parsing', goal_categories: { fix_bug: 1 }, outcome: 'fully_achieved',
      user_satisfaction_counts: { satisfied: 1 }, claude_helpfulness: 'very_helpful', session_type: 'single_task',
      friction_counts: {}, friction_detail: '', primary_success: 'good_debugging', brief_summary: 'Fix the broken parser',
      evidence: [{ message_indexes: [1], description: 'The user requested a parsing repair.' }]
    }
  }), /verbatim transcript overlap/);
  assert.equal((await getSemanticRun({ runsRoot, runId: prepared.id })).sessions[0].status, 'pending');
  assert.equal((await cache.status()).entries, 0);
});

test('schema-invalid cached facets are evicted and re-analyzed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-invalid-cache-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const input = await extractAnalysisInput(fixture('claude-parity.jsonl'), 'claude');
  const key = {
    source: 'claude', opaqueSessionId: input.opaqueId, contentHash: input.contentHash,
    analyzerHost: 'claude', analyzerModel: 'test-model', promptVersion: PROMPT_VERSION
  };
  await cache.put(key, { protocolVersion: 'claude-insights-2.1.206/v1' });
  const prepared = await prepareSemanticRun({
    runsRoot,
    cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: 'test-model' }
  });
  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.sessions[0].status, 'pending');
  assert.equal(run.cache.invalid, 1);
  assert.equal((await cache.status()).entries, 0);
});

test('long session projections are summarized in bounded current-host chunks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-chunks-'));
  const transcript = join(home, 'long.jsonl');
  const records = [];
  for (let index = 0; index < 50; index += 1) {
    records.push(JSON.stringify({ type: 'user', timestamp: new Date(Date.UTC(2026, 6, 1, 9, index)).toISOString(), sessionId: 'long-session', message: { role: 'user', content: `Request ${index} ${'u'.repeat(490)}` } }));
    records.push(JSON.stringify({ type: 'assistant', timestamp: new Date(Date.UTC(2026, 6, 1, 9, index, 30)).toISOString(), sessionId: 'long-session', message: { role: 'assistant', content: `Response ${index} ${'a'.repeat(290)}` } }));
  }
  await writeFile(transcript, `${records.join('\n')}\n`);
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot, cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: 'test-model' }
  });
  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.sessions[0].analysisMode, 'chunked');
  const task = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  assert.equal(task.kind, 'session_chunk');
  assert.ok(task.request.prompt.length < 30_000);
  await assert.rejects(ingestSemanticResult({
    runsRoot, cache, runId: prepared.id, taskId: `session:${run.sessions[0].id}`,
    result: {
      underlying_goal: 'Handle many requests', goal_categories: { implement_feature: 1 }, outcome: 'partially_achieved',
      user_satisfaction_counts: { unsure: 1 }, claude_helpfulness: 'moderately_helpful', session_type: 'multi_task',
      friction_counts: {}, friction_detail: '', primary_success: 'multi_file_changes', brief_summary: 'Several requests were handled.',
      evidence: [{ message_indexes: [1], description: 'The session began with an implementation request.' }]
    }
  }), /most recently exposed|chunks must complete/);
  await ingestSemanticResult({
    runsRoot, cache, runId: prepared.id, taskId: task.id,
    result: { summary: 'The segment covers several implementation requests and responses.', evidence: [{ message_indexes: [1], description: 'A request starts this segment.' }] }
  });
  const next = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  assert.ok(['session_chunk', 'session_facet'].includes(next.kind));
  let current = next;
  while (current.kind === 'session_chunk') {
    const messageIndex = current.input.messages[0].index;
    await ingestSemanticResult({
      runsRoot, cache, runId: prepared.id, taskId: current.id,
      result: { summary: 'The cumulative synthesis preserves supported goals and outcomes.', evidence: [{ message_indexes: [messageIndex], description: 'This chunk adds a supported request.' }] }
    });
    current = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  }
  assert.equal(current.kind, 'session_facet');
  const beforeFacet = await getSemanticRun({ runsRoot, runId: prepared.id });
  const supported = new Set(beforeFacet.sessions[0].chunkResults.at(-1).evidence.flatMap((item) => item.messageIndexes));
  const unsupported = Array.from({ length: beforeFacet.sessions[0].messageCount }, (_, index) => index + 1).find((index) => !supported.has(index));
  const supportedIndex = [...supported][0];
  await assert.rejects(ingestSemanticResult({
    runsRoot, cache, runId: prepared.id, taskId: current.id,
    result: {
      underlying_goal: 'Handle many requests', goal_categories: { implement_feature: 1 }, outcome: 'partially_achieved',
      user_satisfaction_counts: { unsure: 1 }, claude_helpfulness: 'moderately_helpful', session_type: 'multi_task',
      friction_counts: {}, friction_detail: '', primary_success: 'multi_file_changes', brief_summary: `Request 0 ${'u'.repeat(40)}`,
      evidence: [{ message_indexes: [supportedIndex], description: 'A supported request underlies the synthesis.' }]
    }
  }), /verbatim transcript overlap/);
  await assert.rejects(ingestSemanticResult({
    runsRoot, cache, runId: prepared.id, taskId: current.id,
    result: {
      underlying_goal: 'Handle many requests', goal_categories: { implement_feature: 1 }, outcome: 'partially_achieved',
      user_satisfaction_counts: { unsure: 1 }, claude_helpfulness: 'moderately_helpful', session_type: 'multi_task',
      friction_counts: {}, friction_detail: '', primary_success: 'multi_file_changes', brief_summary: 'Several tasks were handled.',
      evidence: [{ message_indexes: [unsupported], description: 'An unsupported original index was invented.' }]
    }
  }), /unknown message index/);
});

test('an exposed task remains recoverable when its source changes before a repeated next', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-resume-change-'));
  const transcript = join(home, 'changing.jsonl');
  await copyFile(fixture('claude-parity.jsonl'), transcript);
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot, cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: transcript } }],
    analyzer: { host: 'claude', model: 'test-model' }
  });
  const exposed = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  await appendFile(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-07-03T09:05:00.000Z', message: { role: 'assistant', content: 'new activity' } })}\n`);
  const resumed = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  assert.equal(resumed.kind, 'source_changed');
  assert.equal(resumed.id, exposed.id);
  await failSemanticTask({ runsRoot, runId: prepared.id, taskId: exposed.id, reason: 'source_changed' });
  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'complete');
});

test('an analyzer failure becomes a visible partial report instead of a permanent pending run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-failure-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot, cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: fixture('claude-parity.jsonl') } }],
    analyzer: { host: 'claude', model: 'test-model' },
    diagnostics: [{ source: 'claude', coverage: 'available', filesFound: 1, filesSelected: 1 }]
  });
  const task = await nextSemanticTask({ runsRoot, cache, runId: prepared.id });
  await failSemanticTask({ runsRoot, runId: prepared.id, taskId: task.id, reason: 'invalid_analyzer_response' });
  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'complete');
  const final = await finalizeSemanticRun({ runsRoot, runId: prepared.id, outputDirectory: join(home, 'report') });
  assert.equal(final.report.parity.structuralStatus, 'partial');
  assert.equal(final.report.parity.dataStatus, 'partial');
  assert.equal(final.report.coverage.semanticFailures[0].reason, 'invalid_analyzer_response');
  assert.match(await readFile(final.files.markdown, 'utf8'), /Semantic coverage is partial: 1 invalid analyzer response/);
});

test('one unreadable semantic candidate is recorded without aborting run creation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-insight-run-prepare-failure-'));
  const runsRoot = join(home, 'runs');
  const cache = new FacetCache(join(home, 'facets'));
  const prepared = await prepareSemanticRun({
    runsRoot, cache,
    request: { host: 'claude', sources: ['claude'], scope: 'current', days: 30 },
    candidates: [{ source: 'claude', locator: { kind: 'file', path: join(home, 'missing.jsonl') } }],
    analyzer: { host: 'claude', model: 'test-model' },
    diagnostics: [{ source: 'claude', coverage: 'available', filesFound: 1, filesSelected: 1 }]
  });
  const run = await getSemanticRun({ runsRoot, runId: prepared.id });
  assert.equal(run.preparationFailures[0].reason, 'transcript_extraction_failed');
  assert.equal(run.diagnostics[0].coverage, 'partial');
  assert.equal((await nextSemanticTask({ runsRoot, cache, runId: prepared.id })).kind, 'complete');
  const final = await finalizeSemanticRun({ runsRoot, runId: prepared.id, outputDirectory: join(home, 'report') });
  assert.equal(final.report.parity.dataStatus, 'partial');
});

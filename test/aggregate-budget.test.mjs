import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAggregateChunkRequest, createAggregateRequest, legacySplitAggregateSections, legacySplitAggregateSessions, splitAggregateSections, splitAggregateSessions } from '../src/aggregate-protocol.mjs';
import { getSemanticRun, ingestSemanticResult, nextSemanticTask, prepareSemanticRun } from '../src/semantic-run.mjs';

const fill = (text, length) => text.repeat(Math.ceil(length / text.length)).slice(0, length);
const csv = (length) => fill('"",', length);
const prose = (length) => fill('Quoted "unit" checks 🙂; deployment still requires approval.\n', length);
const tail = fill('Do not deploy; the regression failed and approval remains required. ', 500).trim();

function payload(request, tag = 'insights-data') {
  return JSON.parse(request.prompt.split(`<${tag}>\n`)[1].split(`\n</${tag}>`)[0]);
}

function largeFacet() {
  return {
    underlying_goal: csv(1_000), goal_categories: { analyze_data: 1 }, outcome: 'not_achieved',
    user_satisfaction_counts: {}, agent_helpfulness: 'unhelpful', session_type: 'single_task',
    friction_counts: { tool_failed: 1 }, friction_detail: csv(2_000), primary_success: 'none', brief_summary: csv(1_000),
    user_instructions_to_agent: Array.from({ length: 10 }, () => csv(500)),
    evidence: Array.from({ length: 20 }, (_, index) => ({
      message_indexes: [1], description: `Evidence ${index + 1}: ${prose(450)}`,
      quotation: index === 19 ? tail : csv(500)
    }))
  };
}

function sectionResult(section, id) {
  const evidence = { evidence_session_ids: [id] };
  return {
    project_areas: { areas: [{ name: 'Quoted CSV checks', session_count: 1, description: prose(2_000), ...evidence }] },
    interaction_style: { narrative: prose(6_000), key_pattern: prose(2_000), ...evidence },
    what_works: { intro: prose(2_000), impressive_workflows: [{ title: prose(300), description: prose(6_000), ...evidence }] },
    friction_analysis: { intro: prose(2_000), categories: [{ category: 'Failed checks', description: prose(4_000), examples: [{ text: prose(4_000), ...evidence }] }] },
    suggestions: { claude_md_additions: [], features_to_try: [], usage_patterns: [] },
    on_the_horizon: { intro: prose(2_000), opportunities: [] },
    fun_ending: { headline: prose(200), detail: `${prose(3_000)}${tail}`, ...evidence },
    at_a_glance: { whats_working: prose(500), whats_hindering: prose(500), quick_wins: prose(500), ambitious_workflows: prose(500), ...evidence }
  }[section];
}

for (const escapedMetrics of [false, true]) {
  test(`validated large facets and sections complete all eight baseline tasks${escapedMetrics ? ' with large structured metrics' : ''}`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'agent-insight-aggregate-budget-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const path = join(home, 'session.jsonl');
    const records = [{ type: 'user', sessionId: 'quoted-csv', timestamp: '2026-07-01T09:00:00Z', message: { role: 'user', content: `${csv(2_000)}\n${tail}` } }];
    if (escapedMetrics) for (let index = 0; index < 32; index += 1) records.push({
      type: 'assistant', sessionId: 'quoted-csv', timestamp: '2026-07-01T09:01:00Z',
      message: { role: 'assistant', content: [{ type: 'tool_use', name: `tool-${index}-${'\u0001'.repeat(110)}`, input: {} }] }
    });
    records.push({ type: 'user', sessionId: 'quoted-csv', timestamp: '2026-07-01T09:03:00Z', message: { role: 'user', content: 'Analyze the CSV checks. Keep the acceptance constraint.' } });
    await writeFile(path, records.map(JSON.stringify).join('\n'));
    const runsRoot = join(home, 'runs');
    const prepared = await prepareSemanticRun({ runsRoot, request: { host: 'claude', sources: ['claude'], days: Infinity }, candidates: [{ source: 'claude', locator: { kind: 'file', path } }], analyzer: { host: 'claude', model: 'test' } });
    const context = { runsRoot, runId: prepared.id };
    const facet = largeFacet();
    let task = await nextSemanticTask(context);
    while (task.kind === 'session_chunk') {
      await ingestSemanticResult({ ...context, taskId: task.id, result: {
        summary: 'Keep all quoted CSV evidence and the explicit no-deployment constraint.',
        evidence: facet.evidence.map((item) => ({ ...item, description: 'Observed user evidence.' }))
      } });
      task = await nextSemanticTask(context);
    }
    assert.equal(task.kind, 'session_facet');
    await ingestSemanticResult({ ...context, taskId: task.id, result: facet });
    const accepted = await getSemanticRun(context);
    const id = accepted.sessions[0].id;
    assert.equal(accepted.sessions[0].facet.evidence.length, 20);
    const chunks = new Map();
    const metrics = [];
    const sections = new Map();
    const completed = [];
    task = await nextSemanticTask(context);
    while (task.kind === 'aggregate_chunk' || task.kind === 'aggregate') {
      assert.ok(task.request.prompt.length <= 30_000, `${task.id}: ${task.request.prompt.length}`);
      assert.deepEqual(await nextSemanticTask(context), task);
      if (task.kind === 'aggregate_chunk') {
        if (task.section === 'at_a_glance') {
          const fragments = payload(task.request, 'section-fragments');
          assert.ok(JSON.stringify(fragments).length <= 12_000);
          for (const fragment of fragments) {
            if (!sections.has(fragment.section)) sections.set(fragment.section, []);
            sections.get(fragment.section).push(fragment.fragment);
          }
        } else {
          const data = payload(task.request);
          const encoded = [
            ...data.sessions,
            ...(data.metrics_fragments ?? []).map((fragment) => ({ metrics_fragment: fragment }))
          ];
          assert.ok(JSON.stringify(encoded).length <= 12_000);
          if (task.section === 'project_areas') {
            for (const session of data.sessions) {
              assert.equal(session.id, id);
              if (!chunks.has(session.id)) chunks.set(session.id, []);
              chunks.get(session.id).push(session.session_fragment.text);
            }
            for (const fragment of data.metrics_fragments ?? []) metrics.push(fragment.text);
          }
        }
        await ingestSemanticResult({ ...context, taskId: task.id, result: {
          summary: '\u0000'.repeat(1_000), evidence_session_ids: [id]
        } });
      } else {
        completed.push(task.section);
        await ingestSemanticResult({ ...context, taskId: task.id, result: sectionResult(task.section, id) });
      }
      task = await nextSemanticTask(context);
    }
    assert.deepEqual(completed, ['project_areas', 'interaction_style', 'what_works', 'friction_analysis', 'suggestions', 'on_the_horizon', 'fun_ending', 'at_a_glance']);
    const reconstructed = JSON.parse(chunks.get(id).join(''));
    assert.equal(reconstructed.evidence.length, 20);
    assert.equal(reconstructed.evidence[19].quotation, tail);
    assert.deepEqual(reconstructed.user_instructions_to_agent, facet.user_instructions_to_agent);
    const latest = await getSemanticRun(context);
    for (const [section, parts] of sections) assert.deepEqual(JSON.parse(parts.join('')), latest.sections[section]);
    assert.equal(sections.size, 7);
    if (escapedMetrics) {
      const restored = JSON.parse(metrics.join(''));
      assert.equal(Object.keys(restored.toolCounts).length, 32);
      assert.equal(Object.values(restored.toolCounts).reduce((sum, value) => sum + value, 0), 32);
      assert.equal(JSON.stringify(restored).length > 8_000, true);
    } else assert.equal(metrics.length, 0);
    assert.deepEqual(latest.sectionFailures ?? {}, {});
  });
}

test('derived fragment encoding is lossless for escaping and Unicode while small paths remain stable', () => {
  const session = { id: 'canonical', source: 'claude', sessionId: 'native', facet: { underlyingGoal: 'Check', briefSummary: 'Small', evidence: [] } };
  const context = { sessions: [session], metrics: {}, sections: {} };
  assert.deepEqual(splitAggregateSessions([session]), [[session]]);
  const special = fill('🙂"\\\n\u0001', 40_000);
  const sections = { interaction_style: { narrative: special } };
  const groups = splitAggregateSections(sections);
  assert.ok(groups.every((group) => JSON.stringify(group).length <= 12_000));
  const fragments = groups.flat();
  assert.ok(fragments.every((part) => !/[\uD800-\uDBFF]$/.test(part.fragment) && !/^[\uDC00-\uDFFF]/.test(part.fragment)));
  assert.deepEqual(JSON.parse(fragments.map((part) => part.fragment).join('')), sections.interaction_style);
  const legacySession = { ...session, facet: { ...session.facet, evidence: Array.from({ length: 20 }, (_, index) => ({ messageIndexes: [1], description: `Evidence ${index}` })) } };
  const legacyContext = { ...context, sessions: [legacySession], legacyAggregatePlanning: true };
  assert.equal(payload(createAggregateRequest('project_areas', legacyContext)).sessions[0].evidence.length, 8);
  assert.equal(payload(createAggregateRequest('project_areas', { ...context, sessions: [legacySession] })).sessions[0].evidence.length, 20);
  assert.deepEqual(legacySplitAggregateSessions([session]), [[session]]);
  assert.equal(legacySplitAggregateSections(sections)[0][0].fragment.length, 12_000);
  const request = createAggregateChunkRequest('project_areas', context, [session], 0, 1);
  assert.equal(payload(request).sessions[0].id, 'canonical');
});

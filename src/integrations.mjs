import { chmod, lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const AGENTS = ['claude', 'codex', 'cursor', 'opencode', 'pi'];

export function integrationPath({ agent, scope = 'project', cwd = process.cwd(), home = homedir() }) {
  const project = resolve(cwd);
  const user = resolve(home);
  if (agent === 'groq') {
    throw new Error('Groq is a provider, not a slash-command host. Import an exported conversation instead.');
  }
  if (agent === 'cursor' && scope === 'user') {
    throw new Error('Cursor custom commands are project-scoped; use --scope project.');
  }
  const roots = {
    claude: scope === 'user' ? join(user, '.claude', 'commands') : join(project, '.claude', 'commands'),
    codex: scope === 'user' ? join(user, '.agents', 'skills', 'agent-insights') : join(project, '.agents', 'skills', 'agent-insights'),
    cursor: scope === 'user' ? join(user, '.cursor', 'commands') : join(project, '.cursor', 'commands'),
    opencode: scope === 'user' ? join(user, '.config', 'opencode', 'commands') : join(project, '.opencode', 'commands'),
    pi: scope === 'user' ? join(user, '.pi', 'agent', 'extensions') : join(project, '.pi', 'extensions')
  };
  if (!roots[agent]) throw new Error(`Unknown agent: ${agent}. Supported: ${AGENTS.join(', ')}`);
  return join(roots[agent], agent === 'codex' ? 'SKILL.md' : agent === 'pi' ? 'agent-insights.ts' : 'agent-insights.md');
}

const HOST_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  pi: 'Pi'
};

function coverageNote(agent) {
  if (agent === 'cursor') {
    return 'Coverage note: Cursor collection is experimental (local agent-transcript JSONL only). Private formats, remote/background chats, and nested subagent transcripts are not promised; treat Cursor coverage as explicit and incomplete when summarizing.\n\n';
  }
  if (agent === 'opencode') {
    return 'Coverage note: OpenCode covers root sessions only via the official session list/export. Forked and child sessions are outside this adapter; state that limit explicitly when summarizing.\n\n';
  }
  return '';
}

function commonBody(agent) {
  const host = HOST_LABELS[agent];
  return `Use the current ${host} model to run one fused Agent Insights report: Claude-compatible baseline sections plus sharp user-audit extensions. Never start another ${host} CLI process, switch providers, or hand semantic analysis to a different model. Fresh invocations always re-analyze; there is no cross-run cache command to consult or warm.

${coverageNote(agent)}On every invocation, ask the user these questions and wait for both answers. Do not reuse an answer from an earlier run:

1. Agent scope: current agent, all agents, or specific agents. If they choose specific agents, ask them to select from Claude, Codex, Cursor, OpenCode, and Pi.
2. Time range: last 7 days, last 30 days, last 90 days, all history, or a custom start and end date in YYYY-MM-DD form.

Translate the answers into command arguments:

- Current agent means \`--source ${agent}\`.
- All agents means \`--source claude,codex,cursor,opencode,pi\`.
- Specific agents means one comma-separated \`--source\` value.
- A 7, 30, or 90 day range means \`--days <number>\`; all history means \`--all\`; custom means \`--start <YYYY-MM-DD> --end <YYYY-MM-DD>\`.

Before preparing the run, determine the exact model ID of the current ${host} model. If the host does not expose it, use the literal \`unknown\`. Never omit \`--model\`.

Then perform this one-shot fused workflow from the project root:

1. Run \`agent-insight prepare --host ${agent} --model <exact-model-id-or-unknown> --source <comma-separated-sources> <time-range-arguments>\` and capture the returned run ID.
2. Run \`agent-insight semantic next --run <run-id> --host ${agent} --model <same-exact-model-id-or-unknown>\` and parse its JSON task.
3. If the task says the run is complete, continue to step 7. Task kinds include session facets, \`aggregate_batch\` (baseline aggregates), \`session_audit\`, and \`audit_aggregate\`. Audit tasks appear only after baseline aggregates finish. If the task is an \`aggregate_batch\`, analyze all listed task requests in parallel with the current ${host} model; otherwise analyze the single request. Follow every required JSON shape exactly and produce result objects without task envelopes or Markdown fences.
4. Write each result object as JSON to that task's exact, unique \`submissionPath\`. Never copy transcript text into another file.
5. Ingest completed results one at a time with \`agent-insight semantic ingest --run <run-id> --task <task-id> --host ${agent} --model <same-exact-model-id-or-unknown>\`.
6. Repeat from step 2 until the next task says the run is complete.
7. Run \`agent-insight semantic finalize --run <run-id> --host ${agent} --model <same-exact-model-id-or-unknown>\`, open the generated fused report, and give the user its location plus a concise evidence-backed summary that leads with: (1) the single highest-leverage change or At a Glance quick win, (2) the three hard truths when audit completed, and (3) one automation candidate only if relevant. Prefer the paste-ready rewrite over a long metric dump.

If \`semantic next\` returns \`source_changed\`, fail that frozen task with reason \`source_changed\` and continue. If a model call or schema validation fails, retry once when safe. If it still fails, run \`agent-insight semantic fail --run <run-id> --task <task-id> --reason analyzer_failure --host ${agent} --model <same-exact-model-id-or-unknown>\` (use \`invalid_analyzer_response\` for invalid JSON/schema), then continue so the final report exposes partial semantic or audit-extension coverage. If the user interrupts, leave the task pending and preserve the run ID for resumption. Never invent a completed result, silently skip a task, claim full coverage when the run is incomplete, or use any removed cache command.`;
}

export function renderIntegration(agent) {
  if (!AGENTS.includes(agent)) throw new Error(`Unknown host agent: ${agent}. Supported: ${AGENTS.join(', ')}`);
  if (agent === 'codex') {
    return `---\nname: agent-insights\ndescription: Generate a fused local-first Agent Insights report (baseline plus sharp user audit) with the current Codex model.\n---\n\n# Agent Insights\n\n${commonBody(agent)}\n`;
  }
  if (agent === 'pi') {
    return [
      'import { execFile } from "node:child_process";',
      'import { promisify } from "node:util";',
      'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
      '',
      'const execFileAsync = promisify(execFile);',
      '',
      'export default function (pi: ExtensionAPI) {',
      '  pi.registerCommand("agent-insights", {',
      '    description: "Generate one fused Agent Insights report (baseline plus sharp user audit) with the current Pi model",',
      '    handler: async (_args, ctx) => {',
      '      try {',
      '        const scope = await ctx.ui.select("Agent scope", ["Current agent", "All agents", "Specific agents"]);',
      '        if (!scope) return;',
      '        let sources = "pi";',
      '        if (scope === "All agents") sources = "claude,codex,cursor,opencode,pi";',
      '        if (scope === "Specific agents") {',
      '          const answer = await ctx.ui.input("Specific agents", "claude,codex,cursor,opencode,pi");',
      '          if (!answer) return;',
      '          const allowed = new Set(["claude", "codex", "cursor", "opencode", "pi"]);',
      '          const selected = [...new Set(answer.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))];',
      '          if (selected.length === 0 || selected.some((value) => !allowed.has(value))) {',
      '            ctx.ui.notify("Choose one or more of: claude, codex, cursor, opencode, pi", "error");',
      '            return;',
      '          }',
      '          sources = selected.join(",");',
      '        }',
      '',
      '        const range = await ctx.ui.select("Time range", ["Last 7 days", "Last 30 days", "Last 90 days", "All history", "Custom dates"]);',
      '        if (!range) return;',
      '        const timeArgs: string[] = [];',
      '        if (range === "Last 7 days") timeArgs.push("--days", "7");',
      '        if (range === "Last 30 days") timeArgs.push("--days", "30");',
      '        if (range === "Last 90 days") timeArgs.push("--days", "90");',
      '        if (range === "All history") timeArgs.push("--all");',
      '        if (range === "Custom dates") {',
      '          const start = await ctx.ui.input("Start date", "YYYY-MM-DD");',
      '          if (!start) return;',
      '          const end = await ctx.ui.input("End date", "YYYY-MM-DD");',
      '          if (!end) return;',
      '          timeArgs.push("--start", start, "--end", end);',
      '        }',
      '',
      '        const modelId = typeof ctx.model?.id === "string" && ctx.model.id.trim() ? ctx.model.id.trim() : "unknown";',
      '        const { stdout } = await execFileAsync("agent-insight", ["prepare", "--host", "pi", "--model", modelId, "--source", sources, ...timeArgs], {',
      '          cwd: ctx.cwd,',
      '          maxBuffer: 4 * 1024 * 1024,',
      '        });',
      '        let runId: string | undefined;',
      '        try {',
      '          const result = JSON.parse(stdout);',
      '          runId = result.runId ?? result.id;',
      '        } catch {',
      '          runId = stdout.match(/[a-f0-9-]{36}/)?.[0];',
      '        }',
      '        if (!runId) throw new Error("prepare did not return a semantic run ID");',
      '',
      '        pi.sendUserMessage([',
      '          `Continue the fused Agent Insights run ${runId} with the current Pi model. Do not start another Pi process, switch providers, or use another model. There is no cross-run cache command.`,',
      '          `1. Run agent-insight semantic next --run ${runId} --host pi --model ${modelId} and parse the JSON task.`,',
      '          "2. Task kinds include session facets, aggregate_batch (baseline), session_audit, and audit_aggregate. Audit tasks follow baseline aggregates. If it is aggregate_batch, analyze all listed requests in parallel with the current Pi model; otherwise analyze the single request. Write each required result JSON to its unique submissionPath. Do not copy transcript text elsewhere.",',
      '          `3. Ingest completed results one at a time with agent-insight semantic ingest --run ${runId} --task <task-id> --host pi --model ${modelId}.`,',
      '          "4. Repeat steps 1-3 until the next task says complete.",',
          '          `5. Run agent-insight semantic finalize --run ${runId} --host pi --model ${modelId}, then open the fused report and lead the summary with the one highest-leverage change (or quick win), the three hard truths, and at most one automation candidate.`,',
      '          `If next returns source_changed, fail that task with reason source_changed. If analysis or validation still fails after one retry, run agent-insight semantic fail --run ${runId} --task <task-id> --reason analyzer_failure --host pi --model ${modelId}, continue the loop, and let the report show partial coverage. On user interruption, preserve the pending run.`,',
      '        ].join("\\n"));',
      '      } catch (error) {',
      '        ctx.ui.notify("agent-insight failed: " + (error instanceof Error ? error.message : String(error)), "error");',
      '      }',
      '    },',
      '  });',
      '}',
      ''
    ].join('\n');
  }
  if (agent === 'opencode') {
    return `---\ndescription: Generate one fused Agent Insights report (baseline plus sharp user audit; root sessions only)\n---\n\n${commonBody(agent)}\n`;
  }
  return `# Agent Insights\n\n${commonBody(agent)}\n`;
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertNoSymlinkParents(base, target) {
  const root = resolve(base);
  const parent = dirname(resolve(target));
  const suffix = relative(root, parent);
  if (suffix.startsWith('..') || resolve(root, suffix) !== parent) throw new Error('Integration target escapes the requested scope.');
  let current = root;
  for (const component of suffix.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, component);
    const info = await pathInfo(current);
    if (!info) break;
    if (info.isSymbolicLink()) throw new Error(`${current} is a symbolic-link parent; refusing to install outside the requested scope.`);
    if (!info.isDirectory()) throw new Error(`${current} is not a directory.`);
  }
}

export async function installIntegration({ agent, scope, cwd, home, force = false }) {
  const target = integrationPath({ agent, scope, cwd, home });
  await assertNoSymlinkParents(scope === 'user' ? home : cwd, target);
  const existing = await pathInfo(target);
  if (existing?.isSymbolicLink()) throw new Error(`${target} is a symbolic link; refusing to follow or replace it.`);
  if (!force && existing) throw new Error(`${target} already exists. Pass --force to replace it.`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.agent-insights-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, renderIntegration(agent), { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

export { AGENTS };

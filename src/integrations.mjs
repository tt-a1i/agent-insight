import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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

function commonBody(agent) {
  const host = HOST_LABELS[agent];
  return `Use the current ${host} model to run the complete Agent Insights semantic workflow. Never start another ${host} CLI process or hand semantic analysis to a different model.

On every invocation, ask the user these questions and wait for both answers. Do not reuse an answer from an earlier run:

1. Agent scope: current agent, all agents, or specific agents. If they choose specific agents, ask them to select from Claude, Codex, Cursor, OpenCode, and Pi.
2. Time range: last 7 days, last 30 days, last 90 days, all history, or a custom start and end date in YYYY-MM-DD form.

Translate the answers into command arguments:

- Current agent means \`--source ${agent}\`.
- All agents means \`--source claude,codex,cursor,opencode,pi\`.
- Specific agents means one comma-separated \`--source\` value.
- A 7, 30, or 90 day range means \`--days <number>\`; all history means \`--all\`; custom means \`--start <YYYY-MM-DD> --end <YYYY-MM-DD>\`.

Then perform this workflow from the project root:

1. Run \`agent-insight prepare --host ${agent} --source <comma-separated-sources> <time-range-arguments>\` and capture the returned run ID.
2. Run \`agent-insight semantic next --run <run-id>\` and parse its JSON task.
3. If the task says the run is complete, continue to step 7. Otherwise analyze the task's request with the current ${host} model. Follow its required JSON shape exactly and produce the result object itself, without the task envelope or Markdown fences.
4. Write only that result object as JSON to the task's exact \`submissionPath\`. Never copy transcript text into another file.
5. Run \`agent-insight semantic ingest --run <run-id> --task <task-id>\`.
6. Repeat from step 2 until the next task says the run is complete.
7. Run \`agent-insight semantic finalize --run <run-id>\`, open the generated report, and give the user its location plus a concise evidence-backed summary.

If any command or schema validation fails, report the exact stage and preserve the run ID so the user can resume it. Never invent a completed result, silently skip a task, or claim full coverage when the run is incomplete.`;
}

export function renderIntegration(agent) {
  if (!AGENTS.includes(agent)) throw new Error(`Unknown host agent: ${agent}. Supported: ${AGENTS.join(', ')}`);
  if (agent === 'codex') {
    return `---\nname: agent-insights\ndescription: Generate a local-first cross-agent workflow report and interpret its metadata carefully.\n---\n\n# Agent Insights\n\n${commonBody(agent)}\n`;
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
      '    description: "Generate a complete semantic Agent Insights report with the current Pi model",',
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
      '        const { stdout } = await execFileAsync("agent-insight", ["prepare", "--host", "pi", "--source", sources, ...timeArgs], {',
      '          cwd: ctx.cwd,',
      '          timeout: 60_000,',
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
      '          `Continue Agent Insights semantic run ${runId} with the current Pi model. Do not start another Pi process or use another model.`,',
      '          `1. Run agent-insight semantic next --run ${runId} and parse the JSON task.`,',
      '          "2. If it is not complete, analyze its request, produce only the required result object, and write that JSON to its exact submissionPath. Do not copy transcript text elsewhere.",',
      '          `3. Run agent-insight semantic ingest --run ${runId} --task <task-id>.`,',
      '          "4. Repeat steps 1-3 until the next task says complete.",',
      '          `5. Run agent-insight semantic finalize --run ${runId}, then open and summarize the generated report.`,',
      '          "On failure, report the exact stage and preserve the run ID. Never silently skip a task.",',
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
    return `---\ndescription: Generate and interpret a local-first cross-agent workflow report\n---\n\n${commonBody(agent)}\n`;
  }
  return `# Agent Insights\n\n${commonBody(agent)}\n`;
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function installIntegration({ agent, scope, cwd, home, force = false }) {
  const target = integrationPath({ agent, scope, cwd, home });
  if (!force && await fileExists(target)) throw new Error(`${target} already exists. Pass --force to replace it.`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, renderIntegration(agent), { mode: 0o600 });
  return target;
}

export { AGENTS };

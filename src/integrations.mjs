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

function reportInvocation(agent) {
  if (agent === 'cursor') {
    return '`agent-insight report --source cursor` from the project root. Cursor local transcripts do not reliably carry a project working directory, so do not add `--project .`; explain this experimental, cross-workspace limitation to the user.';
  }
  return `\`agent-insight report --source ${agent} --project .\` from the project root.`;
}

function commonBody(agent) {
  return `When the user asks for agent insights, run ${reportInvocation(agent)} Then read \`~/.agent-insight/latest/report.md\` and \`~/.agent-insight/latest/agent-prompt.md\`. Give a concise review that separates measured facts from inference. Do not claim to have read raw transcript content, and do not expose private paths or content. If the report has no coverage for this agent, say so and explain the supported export/import route.`;
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
      '    description: "Generate and interpret a local-first cross-agent workflow report",',
      '    handler: async (_args, ctx) => {',
      '      try {',
      '        await execFileAsync("agent-insight", ["report", "--source", "pi", "--project", ctx.cwd], { cwd: ctx.cwd, timeout: 60_000 });',
      '        pi.sendUserMessage("Read ~/.agent-insight/latest/agent-prompt.md and report.md, then give me the evidence-backed agent-insights review described there.", { triggerTurn: true });',
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

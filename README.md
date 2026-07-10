# Agent Insight

Agent Insight is a local-first, cross-agent replacement for a vendor-specific
insights command. It reads allowlisted local session stores, normalizes
metadata, and writes a self-contained HTML, Markdown, and JSON report.

It deliberately separates two jobs:

~~~text
/agent-insights in the current host
              |
              v
       agent-insight report
              |
              v
  source adapters -> metadata-only report
              |
              v
current host agent reads agent-prompt.md and gives a narrative review
~~~

The CLI does deterministic local analysis. It does not call an LLM, upload
transcripts, send telemetry, or retain raw conversation content. The host agent
can turn the aggregate report into recommendations, with a clear
fact-versus-inference boundary.

## Install locally

Node 20 or newer is required. From this repository:

~~~bash
npm test
npm link
agent-insight doctor
~~~

The default report output is ~/.agent-insight/latest/:

~~~bash
agent-insight report
open ~/.agent-insight/latest/report.html
~~~

For a larger or older sample, opt in explicitly. Limits are visible in the
report's **Read coverage** table; the tool never silently claims full coverage.

~~~bash
agent-insight report --all --max-sessions 1000 --max-file-mb 128
agent-insight report --source codex,claude --project /path/to/repo
agent-insight report --source claude --include-subagents
~~~

## Host commands

Use /agent-insights rather than /insights: Claude Code already owns the latter,
and one shared name avoids a collision.

~~~bash
agent-insight install --agent claude   --scope project
agent-insight install --agent codex    --scope project
agent-insight install --agent cursor   --scope project
agent-insight install --agent opencode --scope project
agent-insight install --agent pi       --scope project
~~~

| Host | Installed surface | Invocation | Default bridge scope |
| --- | --- | --- | --- |
| Claude Code | .claude/commands/agent-insights.md | /agent-insights | Claude Code sessions in the current project |
| Codex | .agents/skills/agent-insights/SKILL.md | $agent-insights | Codex sessions in the current project |
| Cursor | .cursor/commands/agent-insights.md | /agent-insights | Cursor local transcripts across workspaces; its experimental JSONL does not reliably expose CWD |
| OpenCode | .opencode/commands/agent-insights.md | /agent-insights | OpenCode root sessions in the current project |
| Pi | .pi/extensions/agent-insights.ts | /agent-insights, then /reload if Pi is already open | Pi sessions in the current project |

The generated host bridge asks its agent to run the CLI, read:

~~~text
~/.agent-insight/latest/report.md
~/.agent-insight/latest/agent-prompt.md
~~~

and explain the report without claiming access to raw transcripts.

## Sources and coverage

| Source | Method | Status and boundary |
| --- | --- | --- |
| Claude Code | ~/.claude/projects/<project>/<session>.jsonl | Supported. Uses CLAUDE_CONFIG_DIR when set. Main sessions only by default; nested subagent journals are excluded to prevent double counts. |
| Codex | CODEX_HOME/sessions and archived_sessions | Supported. Defaults to ~/.codex; an explicit invalid CODEX_HOME is reported as unavailable rather than falling back. Very large bundles are streamed and bounded. |
| Pi | Pi session JSONL | Supported. Uses PI_CODING_AGENT_SESSION_DIR or PI_CODING_AGENT_DIR when set; an explicit override wins over all default roots. Stores provider/model metadata, so a Pi session using Groq appears as host pi, provider groq. |
| OpenCode | opencode session list and opencode export --sanitize --pure | Supported via OpenCode's public CLI. It reports **root-session-only** coverage because the list command intentionally excludes child/fork sessions. |
| Cursor | ~/.cursor/projects/**/agent-transcripts/**/*.jsonl | Experimental. Uses CURSOR_DATA_DIR when set. It reads local Agent transcripts only, excludes nested subagents by default, and does not promise compatibility with Cursor's private storage format or remote/background chats. |
| Groq | Generic import / provider metadata | Provider-only. Groq is an inference API, not a standard agent with a universal local transcript store. |

For an application built on Groq, import an explicit export instead of making
the tool guess a private directory:

~~~bash
agent-insight import --source groq --from exported-conversations.jsonl
agent-insight report --source groq
~~~

Generic imports accept .jsonl, .json, .md, and .markdown. `import` reads the
export once and writes a private, hashed **metadata snapshot**; it never copies
the raw export into `~/.agent-insight`. Use `--input <export-file>` on `report`
for a one-off, non-persistent analysis. Groq intentionally has no
`agent-insight install --agent groq` integration because it is a provider, not
a slash-command host.

## Privacy and safety contract

- The report never writes prompt text, assistant text, tool parameters, tool
  output, source code, absolute file paths, or session IDs.
- Imported exports are parsed ephemerally and retained only as anonymized,
  metadata-only snapshots (also 0600); raw import files are never copied.
- Session parsing is streaming for JSONL. Default per-source and per-file
  limits are 100 sessions and 16 MiB; partial/skipped files are surfaced in
  coverage, never hidden.
- Discovery examines up to 10,000 files per configured root by default. If
  that boundary is reached the source is marked partial; raise it explicitly
  with --max-discovery-files.
- A single JSONL event is bounded at 2 MiB and 100,000 events per file.
- Symlink transcripts are refused; discovery does not recursively scan $HOME
  and skips .git and node_modules.
- Report directory permissions are 0700; report files are 0600.
- The HTML is self-contained: it has no CDN, telemetry, network request, or
  external image.

This is intentionally more conservative than a semantic transcript analyzer.
If a future version offers raw-transcript semantic analysis, it should require
an explicit, separate opt-in and state exactly what leaves the machine.

## What the report means

The report's observations are rule-based. Counts are facts; recommendations are
suggestions based on those facts. In particular:

- A short session is not automatically a failed session.
- A tool failure may be a permission or environment problem, not a prompt
  problem.
- A Pi session with branches counts stored history, not necessarily only the
  active leaf.
- An OpenCode report is root-session coverage, not a claim that child/fork
  sessions were scanned.
- A partial source should not be compared as if it were complete.

## Development

~~~bash
npm test
npm run check
node bin/agent-insight.mjs doctor --json
node bin/agent-insight.mjs report --source codex,claude --max-sessions 5 --output /tmp/agent-insight-smoke
~~~

The test suite uses sanitized fixtures and covers transcript parsing, subagent
exclusion, resource limits, OpenCode's public CLI contract, report privacy,
and installation behavior.

## References

- [Claude Code commands](https://code.claude.com/docs/en/commands) and
  [session storage](https://code.claude.com/docs/en/sessions)
- [OpenCode commands](https://dev.opencode.ai/docs/commands) and
  [CLI reference](https://opencode.ai/docs/cli)
- [Cursor custom commands](https://docs.cursor.com/en/agent/chat/commands)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions)
  and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Groq coding integrations](https://console.groq.com/docs/coding-with-groq)

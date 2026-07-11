# Agent Insight

Agent Insight is a local-first, cross-agent implementation of an insights
command for coding agents. Its first goal is to align with the observable
behavior of **Claude Code 2.1.206 `/insights`**; its second goal is to exceed
that baseline transparently when a cross-agent workflow needs stronger
coverage, choice, and privacy boundaries.

The shared command is **`/agent-insights`**. It deliberately does not reuse
`/insights`, which Claude Code already owns.

> The compatibility baseline and every intentional difference are specified in
> [the Claude Code 2.1.206 parity contract](docs/parity/claude-2.1.206.md).

## What happens when you run it

Agent Insight has two modes:

1. **Semantic Insights** is the full workflow. It uses the *current host
   agent's configured model* to analyze selected local sessions and produce an
   evidence-backed report.
2. **Deterministic local report** is a no-model fallback. It aggregates local
   metadata only, runs fully locally, and never makes a model or network call.

Every Semantic Insights invocation asks two fresh questions; it never silently
reuses a prior choice:

1. **Agent scope** — current agent (default), all agents, or selected agents.
2. **Time range** — 7 days, 30 days (default), 90 days, all available history,
   or a custom inclusive start/end date.

Explicit CLI flags are the non-interactive equivalent of those choices.

```text
/agent-insights
      |
      +-- choose scope and time range
      |
      +-- prepare       discover selected sessions and create a resumable run
      |
      +-- semantic next request exactly one current-host-model task
      |
      +-- ingest        validate and persist its derived facet
      |       ^
      |       | repeat until all session and aggregate tasks are complete
      |
      +-- finalize      render timestamped HTML, report.html, Markdown, JSON
```

The invoking host owns semantic work. Claude Code uses its current Claude
model; Codex uses its current Codex model; Cursor uses its current Cursor
model; OpenCode uses its active provider/model; and Pi uses its active
provider/model. Agent Insight does not silently start another agent CLI or
switch providers to complete a semantic task.

## Installation

Node.js 20 or newer is required. From this repository:

```bash
npm test
npm link
agent-insight doctor
```

`agent-insight` must remain on the host agent's `PATH`: the installed host
command invokes it from the current project root.

Install the bridge you want to use. The command writes only that host's local
command/skill/extension file and refuses to overwrite an existing file unless
you pass `--force`.

```bash
agent-insight install --agent claude   --scope project
agent-insight install --agent codex    --scope project
agent-insight install --agent cursor   --scope project
agent-insight install --agent opencode --scope project
agent-insight install --agent pi       --scope project
```

`--scope user` is supported for Claude, Codex, OpenCode, and Pi. Cursor custom
commands are project-scoped. Pi loads a newly installed extension after
`/reload` (or a restart) when it is already open.

## Host and source support

| Host / source | Host command surface | Semantic model owner | Collection boundary |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/agent-insights.md` → `/agent-insights` | Current Claude Code model | Native Claude primary-session JSONL. `CLAUDE_CONFIG_DIR` is honored; nested subagent journals are excluded by default. |
| Codex | `.agents/skills/agent-insights/SKILL.md` → `$agent-insights` | Current Codex model | Native Codex session JSONL. `CODEX_HOME` is honored, including `archived_sessions`. |
| Cursor | `.cursor/commands/agent-insights.md` → `/agent-insights` | Current Cursor model | Experimental local Agent transcript JSONL only. Private storage formats and remote/background chats are not promised. |
| OpenCode | `.opencode/commands/agent-insights.md` → `/agent-insights` | Current OpenCode provider/model | Official `opencode session list` plus sanitized export. The public list is root-session-only. |
| Pi | `.pi/extensions/agent-insights.ts` → `/agent-insights` | Current Pi provider/model | Local Pi session JSONL. `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` are honored. |
| Groq | None | Not a slash-command host | Provider/import-only. Use an explicit export or view Groq as the provider behind a supported host such as Pi or OpenCode. |

Groq is intentionally not accepted by `agent-insight install --agent ...`:
it is an inference provider, not a general coding-agent command host.

## Run Semantic Insights

From a supported host, invoke its installed `/agent-insights` command. The
bridge asks the scope and time-range questions, then drives the resumable
workflow with that host's current model.

For a terminal-only flow, let the CLI ask the same questions:

```bash
agent-insight insights --host codex
```

For automation or a host integration, make the choices explicit:

```bash
# Current Codex sessions from the last 30 days.
agent-insight prepare --host codex --source codex --days 30

# Claude and Codex, 90 days.
agent-insight prepare --host codex --source claude,codex --days 90

# All supported agent sources, all available local history.
agent-insight prepare --host pi --source claude,codex,cursor,opencode,pi --all

# A selected scope with an explicit inclusive date range.
agent-insight prepare --host claude --source claude,cursor --start 2026-06-01 --end 2026-06-30
```

`prepare` prints a run ID. The current host model then completes one validated
task at a time:

```bash
agent-insight semantic next --run <run-id> --host <host> --model <exact-model-id-or-unknown>
# Analyze the returned request with the current host model. Write only its
# required JSON result to the returned submissionPath.
agent-insight semantic ingest --run <run-id> --task <task-id> --host <host> --model <same-model-id>

# Repeat next → host analysis → ingest until next returns kind: complete.
agent-insight semantic finalize --run <run-id> --host <host> --model <same-model-id>
```

`finalize` refuses incomplete runs. On success it prints a `file://` link to
the timestamped HTML report and also writes the stable `report.html`,
`report.md`, and `report.json` artifacts under `~/.agent-insight/usage-data/`
by default. Keep the run ID after an error: the same run can be resumed rather
than guessed, skipped, or silently re-analyzed by a different model.

## Derived-facet cache and transcript privacy

Semantic analysis needs transcript text transiently so the selected host model
can reason about goals, outcomes, friction, and evidence. That text is
provided only in the task sent to the invoking host; Agent Insight does not
write it into its reports, cache, or run manifest.

Instead, it caches validated **derived facets** under
`~/.agent-insight/cache/facets/`. A cache entry is keyed by opaque session
identity, transcript content hash, analyzer host/model, and protocol version.
It contains structured conclusions and short evidence paraphrases, never raw
prompts, assistant text, source code, tool arguments, or tool output. Cache
and report files are private (`0600`) in private directories (`0700`). Before
anything is persisted, a transcript-derived privacy guard rejects meaningful
verbatim spans, secret-like values, absolute paths, and credential-shaped
output. Cache hit, miss, invalid, stale, bypass, and write-failure counts are
recorded in the run and final report.

```bash
agent-insight cache status
agent-insight cache clear
agent-insight cache rebuild --host codex --model <exact-current-model-id> --source codex --days 30
```

`cache rebuild` clears only facets for the named host/model pair and prepares
a new resumable semantic run; complete it with the normal
`semantic next → ingest → finalize` loop.
When a host cannot expose its exact model ID, it passes `unknown` and Agent
Insight disables reusable caching for that run rather than risk cross-model
reuse.

Large sessions and aggregate evidence are processed through bounded derived
chunks (25,000-character session chunks; direct semantic prompts switch to
chunked processing above 30,000 characters). The chunks are analyzed by the
same current host model, and only validated derived summaries are persisted.

An imported Groq or generic export follows the same rule: it is parsed once
and reduced to an anonymized metadata snapshot. The raw export is never copied
into `~/.agent-insight`.

```bash
agent-insight import --source groq --from exported-conversations.jsonl
agent-insight report --source groq --all
```

## Deterministic local-only fallback

Use `report` when a semantic host-model pass is unavailable, unnecessary, or
not authorized. It is deterministic and local-only: it streams allowlisted
local transcript stores, derives aggregate metadata, and writes HTML,
Markdown, JSON, and a narrative handoff prompt without calling an LLM,
uploading data, sending telemetry, or retaining raw transcript content.

```bash
agent-insight report
agent-insight report --source codex,claude --project /path/to/repo --days 30
agent-insight report --source claude --include-subagents --all
agent-insight report --source cursor --max-sessions 500 --max-file-mb 64
```

The default output is `~/.agent-insight/latest/`:

```bash
open ~/.agent-insight/latest/report.html
```

Read coverage is part of every report. It distinguishes unavailable, empty,
partial, and available data, and exposes discovery caps, selection limits,
parse failures, and partial files rather than treating a bounded scan as full
history.

## Parity validation

The public parity harness compares all required report sections and the full
deterministic metric surface. It can also generate an identity-blinded A/B
bundle for the semantic acceptance gate (tie or better in at least 80% of
section judgments).

The reference input must be an independently captured and normalized Claude
Code 2.1.206 report carrying `claude-code` provenance, the exact version, and
a capture hash. Comparing Agent Insight with itself cannot certify parity.

```bash
agent-insight parity compare \
  --reference claude-reference/report.json \
  --reference-sha256 <independently-recorded-sha256> \
  --candidate ~/.agent-insight/usage-data/report.json \
  --output comparison.json \
  --blind-output semantic-review.json \
  --seed <private-random-seed>

# After an identity-blind reviewer fills each item.rating with A, B, or tie:
agent-insight parity evaluate \
  --review semantic-review.json \
  --seed <same-private-random-seed> \
  --output semantic-result.json
```

A passing machine comparison requires `structural.score: 1` and
`deterministic.score: 1`. Semantic quality remains a blind review rather than
being mislabeled as an exact string comparison. Overall acceptance is closed
until the trusted-reference, structural, deterministic, and semantic gates all
pass.

## Known limits and deliberate boundaries

- Claude Code parity is a compatibility target, not a claim that every vendor
  stores sessions in the same format. See the
  [parity contract](docs/parity/claude-2.1.206.md) for its exact 1:1 and
  transparent-exceed requirements.
- Cross-agent semantic analysis requires the active host to execute the
  `next → analyze → ingest` loop and produce the protocol's validated JSON.
  There is no hidden provider fallback or fabricated completion.
- Cursor collection is experimental and excludes unsupported private formats,
  remote/background chats, and nested subagent transcripts by default.
- OpenCode's public session list intentionally covers root sessions only;
  child/fork sessions are represented as a coverage limitation.
- Local retention policies, removed transcripts, read permissions, file-size
  caps, and explicit discovery/session limits can make a selected range
  incomplete. The report must show that state; do not compare it as if it were
  complete.
- Deterministic reports measure metadata, not intent, satisfaction, or code
  quality. Semantic reports separate measured metrics from model inference and
  use opaque source locators for evidence.
- Sending a semantic task to the current host model is still subject to that
  host and provider's own privacy, retention, and account policies. Agent
  Insight itself does not upload or persist the raw transcript.

## Development

```bash
npm test
npm run check
node bin/agent-insight.mjs doctor --json
node bin/agent-insight.mjs report --source codex,claude --max-sessions 5 --output /tmp/agent-insight-smoke
```

The suite includes transcript parsing, source-adapter boundaries, interaction
selection, semantic protocol validation, resumable runs, derived-facet caching,
report privacy, and host integration behavior.

## References

- [Claude Code 2.1.206 parity contract](docs/parity/claude-2.1.206.md)
- [Claude Code commands](https://code.claude.com/docs/en/commands) and
  [session storage](https://code.claude.com/docs/en/sessions)
- [OpenCode commands](https://opencode.ai/docs/commands) and
  [CLI reference](https://opencode.ai/docs/cli)
- [Cursor custom commands](https://docs.cursor.com/en/agent/chat/commands)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions)
  and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Groq coding integrations](https://console.groq.com/docs/coding-with-groq)

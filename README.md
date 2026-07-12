# Agent Insight

**One fused coding-agent report: Claude-compatible Insights plus a sharp, evidence-backed audit of how you work with agents.**

Agent Insight analyzes local session history from Claude Code, Codex, Cursor, OpenCode, and Pi.

Semantic work stays with the model already selected in the invoking host. Agent Insight never silently switches providers or starts another agent CLI.

The project has two goals:

1. Reproduce the observable Claude Code 2.1.206 `/insights` baseline.
2. Extend that baseline with cross-agent scope, explicit time ranges, honest coverage, resumable execution, and a user-audit extension.

The shared command is `/agent-insights`. Codex exposes the same workflow as `$agent-insights`. Agent Insight does not replace Claude Code's built-in `/insights` command.

> The exact baseline and every intentional extension are defined in the [Claude Code 2.1.206 parity contract](docs/parity/claude-2.1.206.md).

## Why Agent Insight

- **One report, not two tools:** Claude-compatible baseline sections and the user audit are generated in one run.
- **One workflow across agents:** analyze the current agent, selected agents, or every supported source.
- **Current-host model ownership:** no hidden provider fallback and no nested agent process.
- **Fresh analysis every invocation:** there is no cross-run semantic cache.
- **Concrete evidence:** findings may use verified quotations, project paths, dates, agent identity, and session locators.
- **Honest incomplete states:** unavailable sources, caps, changed transcripts, analyzer failures, and incomplete extensions remain visible.
- **Resumable checkpoints:** completed tasks in an active run are not repeated after interruption.
- **Bounded prompts:** long sessions and large aggregates use rolling derived chunks.

## What the fused report contains

### Claude-compatible baseline

- At a Glance
- What You Work On
- What You Wanted and Top Tools Used
- Languages and Session Types
- How You Use Claude Code
- Response-time and time-of-day patterns
- Multi-Clauding / parallel-session usage
- Impressive workflows and primary successes
- Friction, inferred satisfaction, and tool errors
- Existing features to try
- New usage patterns and longer-horizon opportunities

### Agent Insight user-audit extension

- **Three hard truths:** the highest-impact interaction habits to confront first.
- **All findings:** every remaining distinct issue, ordered by severity.
- **Habits that undercut you:** recurring self-defeating phrases and patterns, deduplicated by intent.
- **Habits worth keeping:** effective interaction habits supported by evidence.
- **Automation candidates:** repeated workflows that may deserve a Skill, command, prompt template, or automation.
- **One highest-leverage change:** one concrete improvement without streaks, trackers, or longitudinal homework.

The audit considers genuine user-authored messages only. System injections, tool results, and machine-generated markup are excluded before audit analysis.

Audit findings must cite real message indexes and known sessions. Claimed quotations must be verbatim substrings of the selected user messages.

The audit rejects medical, intelligence, moral, and unrelated personality judgments. Bold inferences are labelled and cannot use unsupported absolute certainty.

Automation candidates are advisory. Report generation never writes a Skill, command, prompt template, automation, or host configuration.

## Three-minute quick start

Requirements: Node.js 20 or newer and at least one supported coding agent.

```bash
git clone https://github.com/tt-a1i/agent-insight.git
cd agent-insight
npm test
npm link
agent-insight doctor
```

Install a bridge into the current project:

```bash
# Pick one or install several.
agent-insight install --agent claude   --scope project
agent-insight install --agent codex    --scope project
agent-insight install --agent cursor   --scope project
agent-insight install --agent opencode --scope project
agent-insight install --agent pi       --scope project
```

Invoke the installed command:

| Host | Command |
| --- | --- |
| Claude Code | `/agent-insights` |
| Codex | `$agent-insights` |
| Cursor | `/agent-insights` |
| OpenCode | `/agent-insights` |
| Pi | `/agent-insights` |

Every invocation asks for agent scope and time range. Answers are not reused from an earlier report, and no cost estimate is shown.

## Installation scopes

`--scope project` installs only into the current project. Existing files and symbolic-link targets are protected; replacement requires `--force`, and installation refuses symlink paths that escape the requested scope.

`--scope user` is supported for Claude Code, Codex, OpenCode, and Pi. Cursor custom commands are project-scoped.

Pi needs `/reload` or a restart after installation when it is already running. The `agent-insight` executable must remain available on the host agent's `PATH`.

## Host and source support

| Host / source | Installed surface | Semantic owner | Collection boundary |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/agent-insights.md` | Current Claude model | Primary local JSONL under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`; nested subagent journals excluded by default. |
| Codex | `.agents/skills/agent-insights/SKILL.md` | Current Codex model | Native sessions under `CODEX_HOME`, including `archived_sessions`. |
| Cursor | `.cursor/commands/agent-insights.md` | Current Cursor model | Experimental local Agent transcript JSONL; authorship filtering is best-effort and remote/background formats are not promised. |
| OpenCode | `.opencode/commands/agent-insights.md` | Active provider/model | Official `opencode session list` and sanitized export; public listing is root-session-only. |
| Pi | `.pi/extensions/agent-insights.ts` | Active provider/model | Local Pi JSONL; `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` are honored. |
| Groq | Import-only | Host using Groq | Groq is a provider, not a slash-command host. Use it behind OpenCode/Pi or import an explicit export. |

Groq is intentionally rejected by `agent-insight install --agent ...` because it is not a general coding-agent command host.

## How the fused run works

```text
/agent-insights
      |
      +-- ask scope and time range
      |
      +-- prepare
      |     discover sessions, freeze coverage, create run checkpoint
      |
      +-- session facets
      |     next -> current host model -> ingest|fail
      |     long sessions use rolling 25k-character chunks
      |
      +-- Claude baseline aggregates
      |     seven independent sections may be analyzed in parallel
      |     results are ingested one at a time
      |     At a Glance is synthesized after them
      |
      +-- per-session user audits
      |     genuine user-authored messages only
      |
      +-- cross-session audit aggregate
      |     hard truths, strengths, patterns, automation, leverage
      |
      +-- finalize
            one fused HTML + Markdown + JSON report
```

Every semantic step is bound to the host and model recorded during `prepare`. A different host or model cannot ingest into that run.

If a task fails after a safe retry, `semantic fail` records the failure and advances the state machine. A failed audit extension can still finalize a usable Claude baseline with explicit incomplete-extension coverage.

If a transcript changes after a task is exposed, the run preserves the frozen task boundary. The task can be failed as `source_changed`, after which the remaining work continues.

## Terminal and automation workflow

The installed host command is the normal entry point. A terminal-only invocation asks the same scope and time questions:

```bash
agent-insight insights --host codex
```

Automation should bind the run to a host and exact model:

```bash
agent-insight prepare \
  --host codex \
  --model <exact-model-id-or-unknown> \
  --source codex \
  --days 30

agent-insight prepare \
  --host codex \
  --model <exact-model-id-or-unknown> \
  --source claude,codex \
  --start 2026-06-01 \
  --end 2026-06-30
```

`prepare` returns a run ID. Continue with the same host/model identity:

```bash
agent-insight semantic next \
  --run <run-id> \
  --host <host> \
  --model <same-model-id>

# Analyze the returned request with the current host model and write its JSON
# result to the exact submissionPath. aggregate_batch tasks may be analyzed in
# parallel, but their results must be ingested one at a time.

agent-insight semantic ingest \
  --run <run-id> \
  --task <task-id> \
  --host <host> \
  --model <same-model-id>

agent-insight semantic finalize \
  --run <run-id> \
  --host <host> \
  --model <same-model-id>
```

Record an unrecoverable task and continue:

```bash
agent-insight semantic fail \
  --run <run-id> \
  --task <task-id> \
  --reason invalid_analyzer_response \
  --host <host> \
  --model <same-model-id>
```

Supported failure reasons are `analyzer_failure`, `invalid_analyzer_response`, `safety_limit`, and `source_changed`.

Reports default to `~/.agent-insight/usage-data/`. Keep the run ID after an interruption; `semantic next` returns the same frozen pending task when it is still safe to resume.

## Evidence and checkpoint policy

Semantic analysis requires selected transcript text to be sent transiently to the invoking host model.

> **Reports are evidence-bearing, not content-redacted.** They may persist representative user quotations, absolute project paths, agent identity, dates, and session identifiers. Review a report before sharing it.

Complete transcripts, tool arguments, and tool results are not copied into reports. Filesystem and parser safety remain enforced, but content-privacy filtering is intentionally disabled for evidence-bearing output.

Independent invocations always request fresh semantic analysis, even when corpus and model are unchanged. There is no cross-run facet cache and no cache command.

Within one active run, progress is checkpointed under `~/.agent-insight/runs/<run-id>/`. Completed tasks are not repeated, and an interrupted active task can be reconstructed by `semantic next`.

Run and report files use mode `0600` inside private `0700` directories. `finalize` removes transient submission files while retaining the run manifest and final report artifacts.

The invoking host/provider still applies its own privacy, retention, and account policies. Agent Insight does not independently upload transcripts to another service.

## Imported exports

A Groq or generic export is read once and reduced to an anonymized metadata snapshot. The raw export is not copied into `~/.agent-insight`.

```bash
agent-insight import --source groq --from exported-conversations.jsonl
agent-insight report --source groq --all
```

## Deterministic local-only report

Use `report` when semantic analysis is unavailable or not authorized. This mode reads allowlisted local sources and writes derived metadata without calling an LLM, uploading data, sending telemetry, or retaining raw transcript content.

```bash
agent-insight report
agent-insight report --source codex,claude --project /path/to/repo --days 30
agent-insight report --source claude --include-subagents --all
agent-insight report --source cursor --max-sessions 500 --max-file-mb 64
```

The default deterministic output is `~/.agent-insight/latest/`:

```bash
open ~/.agent-insight/latest/report.html
```

Every report distinguishes unavailable, empty, partial, and available sources. It also exposes discovery caps, parse failures, changed inputs, exclusions, analyzer failures, and extension failures.

## Claude Code 2.1.206 parity status

| Surface | In-repo status | What remains |
| --- | --- | --- |
| Baseline structural contract | Fixture-tested | A trusted independent Claude 2.1.206 reference is still required for live certification. |
| Deterministic metrics | Fixture-tested | Live score `1` cannot be claimed without the same trusted reference corpus. |
| Blind semantic baseline | Harness implemented | Tie-or-better in at least 80% of blinded sections remains blocked on the reference corpus. |
| User-audit extension | Implemented outside baseline scoring | Audit fields and trailing HTML sections are excluded from Claude baseline structural, deterministic, and blind-semantic scoring. |
| Host wiring | Isolated CLI smoke captured | Full in-host UI invocation remains outstanding across the five-host matrix. |

Fixture tests prove harness behavior; they are not live Claude parity certification. Self-comparing two Agent Insight reports is also not certification.

The current evidence and blockers are documented in [parity acceptance](docs/parity/acceptance.md).

```bash
agent-insight parity compare \
  --reference claude-reference/report.json \
  --reference-sha256 <independently-recorded-sha256> \
  --candidate ~/.agent-insight/usage-data/report.json \
  --candidate-html ~/.agent-insight/usage-data/report.html \
  --output comparison.json \
  --blind-output semantic-review.json \
  --seed <private-random-seed>

# After an identity-blind reviewer fills each rating with A, B, or tie:
agent-insight parity evaluate \
  --review semantic-review.json \
  --seed <same-private-random-seed> \
  --output semantic-result.json
```

Machine acceptance requires a trusted reference hash, `structural.score: 1`, and `deterministic.score: 1`. Semantic acceptance requires tie-or-better in at least 80% of baseline sections.

## Known limits

- Cursor collection and authorship filtering are experimental; unsupported private formats and remote/background chats are excluded.
- OpenCode's public session list covers root sessions; child/fork coverage is reported as limited.
- Removed transcripts, permissions, retention policies, and explicit safety limits can make a selected range incomplete.
- Very large inputs use bounded rolling summaries. An input that cannot fit the safety envelope fails visibly instead of being silently sampled.
- Semantic reports intentionally retain representative evidence and must be reviewed before external sharing.
- Deterministic metadata cannot prove intent, satisfaction, or code quality; those claims require semantic analysis and evidence.
- Full live acceptance still needs an independent Claude 2.1.206 reference and in-host UI smoke across all supported hosts.

## Troubleshooting

### `agent-insight: command not found`

Run `npm link` in this repository and ensure npm's global binary directory is on the host agent's `PATH`.

### A run was interrupted

Keep its run ID and invoke `semantic next` with the same host/model identity. The pending task is reconstructed when safe.

### A transcript changed mid-run

Fail the frozen task with reason `source_changed`, then continue the run. The final report will disclose the incomplete state.

### Pi does not show `/agent-insights`

Run `/reload` or restart Pi after installing the extension.

### Coverage is partial

Open the report's Read coverage section. It names unavailable sources, safety limits, parse failures, changed transcripts, exclusions, analyzer failures, and extension failures.

## Development

```bash
npm test
npm run check
node bin/agent-insight.mjs doctor --json
node bin/agent-insight.mjs report \
  --source codex,claude \
  --max-sessions 5 \
  --output /tmp/agent-insight-smoke
```

The suite covers parsing, source boundaries, authorship filtering, Claude branch selection, deterministic metrics, baseline and audit protocols, evidence validation, resumable checkpoints, parity exclusions, and installation safety.

## References

- [Claude Code 2.1.206 parity contract](docs/parity/claude-2.1.206.md)
- [Parity acceptance and live-smoke status](docs/parity/acceptance.md)
- [Claude Code commands](https://code.claude.com/docs/en/commands) and [session storage](https://code.claude.com/docs/en/sessions)
- [OpenCode commands](https://opencode.ai/docs/commands) and [CLI reference](https://opencode.ai/docs/cli)
- [Cursor custom commands](https://docs.cursor.com/en/agent/chat/commands)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Groq coding integrations](https://console.groq.com/docs/coding-with-groq)

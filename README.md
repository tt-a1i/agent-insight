# Agent Insight

**One fused coding-agent report: Claude-compatible Insights plus a sharp, evidence-backed audit of how you work with agents.**

Agent Insight analyzes local session history from Claude Code, Codex, Cursor, OpenCode, and Pi.

Semantic work stays with the model already selected in the invoking host. Agent Insight never silently switches providers or starts another agent CLI.

The project has two goals:

1. Implement a Claude-compatible `/insights` baseline as a fixture-protected compatibility profile (observable Claude Code 2.1.206 behavior as design reference — not an official Claude certification claim).
2. Extend that baseline across agents: Host/Source decoupling, explicit time ranges, honest coverage, resumable execution, and a user-audit extension.

**Product model:** any available Host + that Host's current Model + any selected local Source corpus → one fused Agent Insight report.

Feature implementation is complete under that model. Agent Insight does **not** claim official Claude parity certification.

The shared command is `/agent-insights`. Codex exposes the same workflow as `$agent-insights`. Agent Insight does not replace Claude Code's built-in `/insights` command.

**Default report language is Simplified Chinese** (`--locale zh`): HTML chrome (section titles, empty states, audit headings) and model-generated prose. The product title stays English `Agent Insight`. Pass `--locale en` for English chrome and prose. On Claude host, the HTML shell remains English `Claude Code Insights` for the compatibility profile regardless of locale; use `--locale en` when you also want English model prose.

> The compatibility profile and every intentional extension are defined in the [Claude Code 2.1.206 compatibility contract](docs/parity/claude-2.1.206.md).

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

## Host, Model, Source, and Compatibility Profile

These four concepts are independent:

| Concept | Meaning |
| --- | --- |
| **Host** | The coding agent that runs semantic analysis (Claude Code, Codex, Cursor, OpenCode, or Pi). |
| **Model** | The model currently selected in that Host — the only semantic owner for the run. |
| **Source** | Local session data being scanned (Claude, Codex, Cursor, OpenCode, Pi, or an import). May differ from the Host. |
| **Compatibility Profile** | The Claude Code 2.1.206 observable baseline shape, protected by in-repo fixtures. Internal regression evidence — not official Claude certification. |

**Host and Source are orthogonal.** A Codex Host can analyze Claude sessions; a Pi, OpenCode, Cursor, or Claude Host can analyze any other supported Source. Analysis of Claude sessions requires readable local session files only — not a working Claude CLI, Claude login, or Claude authentication. If a Source agent's CLI is missing or logged out, that only blocks that agent as a **Host** entry point; other Hosts can still analyze its local history when the files are present.

| Host / source | Installed surface | Semantic owner | Collection boundary |
| --- | --- | --- | --- |
| Claude Code | `.claude/commands/agent-insights.md` | Current Claude model | Primary local JSONL under `${CLAUDE_CONFIG_DIR:-~/.claude}/projects`; nested subagent journals excluded by default. |
| Codex | `.agents/skills/agent-insights/SKILL.md` | Current Codex model | Native sessions under `CODEX_HOME`, including `archived_sessions`. |
| Cursor | `.cursor/commands/agent-insights.md` | Current Cursor model | Experimental local Agent transcript JSONL; authorship filtering is best-effort and remote/background formats are not promised. |
| OpenCode | `.opencode/commands/agent-insights.md` | Active provider/model | Official `opencode session list` and sanitized export; public listing is root-session-only. |
| Pi | `.pi/extensions/agent-insights.ts` | Active provider/model | Local Pi JSONL; `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` are honored. |
| Groq | Import-only | Host using Groq | Groq is a provider / import source, not a slash-command host. Use it behind OpenCode/Pi or import an explicit export. |

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

## Product completion

Product completion depends on supported session discovery, current-Host model analysis, fused reports, user audit, bounded prompts, the frozen-task recovery state machine, coverage honesty, and failure states — **not** on live Claude reference capture, blind semantic review, five-host in-host UI smoke, or Claude CLI login.

Missing Claude CLI availability or authentication does **not** mean Agent Insight is incomplete.

## Compatibility profile status

| Surface | In-repo status | Notes |
| --- | --- | --- |
| Baseline structural contract | Fixture-tested | Internal regression evidence for the Claude-compatible profile. |
| Deterministic metrics | Fixture-tested | Same; not a live Claude certification claim. |
| Blind semantic harness | Implemented | Optional developer tool for research comparisons. |
| User-audit extension | Implemented outside baseline scoring | Audit fields and trailing HTML are excluded from Claude baseline scoring. |
| Host wiring | Isolated CLI install + frozen-task resume smoke captured | Development wiring evidence; in-host UI slash smoke is optional and non-blocking. |

Fixture tests protect the compatibility profile. They are not official Claude certification. Self-comparing two Agent Insight reports is also not certification.

Optional developer tooling (`parity compare` / `parity evaluate`) and `acceptance.overall` record one optional compatibility evaluation. They do **not** gate whether Agent Insight is complete or shippable. Details: [compatibility evaluation notes](docs/parity/acceptance.md).

```bash
# Optional — developer compatibility tooling only:
agent-insight parity compare \
  --reference claude-reference/report.json \
  --reference-sha256 <independently-recorded-sha256> \
  --candidate ~/.agent-insight/usage-data/report.json \
  --candidate-html ~/.agent-insight/usage-data/report.html \
  --output comparison.json \
  --blind-output semantic-review.json \
  --seed <private-random-seed>

agent-insight parity evaluate \
  --review semantic-review.json \
  --seed <same-private-random-seed> \
  --output semantic-result.json
```

## Known limits

- Cursor collection and authorship filtering are experimental; unsupported private formats and remote/background chats are excluded.
- OpenCode's public session list covers root sessions; child/fork coverage is reported as limited.
- Removed transcripts, permissions, retention policies, and explicit safety limits can make a selected range incomplete.
- Very large inputs use bounded rolling summaries. An input that cannot fit the safety envelope fails visibly instead of being silently sampled.
- Semantic reports intentionally retain representative evidence and must be reviewed before external sharing.
- Deterministic metadata cannot prove intent, satisfaction, or code quality; those claims require semantic analysis and evidence.

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

- [Claude Code 2.1.206 compatibility contract](docs/parity/claude-2.1.206.md)
- [Compatibility evaluation notes (optional developer tooling)](docs/parity/acceptance.md)
- [Claude Code commands](https://code.claude.com/docs/en/commands) and [session storage](https://code.claude.com/docs/en/sessions)
- [OpenCode commands](https://opencode.ai/docs/commands) and [CLI reference](https://opencode.ai/docs/cli)
- [Cursor custom commands](https://docs.cursor.com/en/agent/chat/commands)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Groq coding integrations](https://console.groq.com/docs/coding-with-groq)

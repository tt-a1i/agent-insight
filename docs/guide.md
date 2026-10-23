# Agent Insight — detailed guide

[← Back to the overview](../README.md)

**One fused coding-agent report: Claude-compatible Insights plus a sharp, evidence-backed audit of how you work with agents.**

Agent Insight analyzes local session history from Claude Code, Codex, Cursor, OpenCode, and Pi.

Semantic work stays with the model already selected in the invoking host. Agent Insight never silently switches providers or starts another agent CLI.

The project has two goals:

1. Implement a Claude-compatible `/insights` baseline as a fixture-protected compatibility profile (observable Claude Code 2.1.206 behavior as design reference — not an official Claude certification claim).
2. Extend that baseline across agents: Host/Source decoupling, explicit time ranges, honest coverage, resumable execution, and a user-audit extension.

**Product model:** any available Host + that Host's current Model + any selected local Source corpus → one fused Agent Insight report.

Agent Insight does **not** claim official Claude parity certification. Test coverage and known limitations are documented below.

The shared command is `/agent-insights`. Codex exposes the same workflow as `$agent-insights`. Agent Insight does not replace Claude Code's built-in `/insights` command.

**Default report language is Simplified Chinese** (`--locale zh`): HTML chrome (section titles, empty states, audit headings) and model-generated prose. The product title stays English `Agent Insight`. Pass `--locale en` for English chrome and prose. On Claude host, the HTML shell remains English `Claude Code Insights` for the compatibility profile regardless of locale; use `--locale en` when you also want English model prose.

> The compatibility profile and every intentional extension are defined in the [Claude Code 2.1.206 compatibility contract](parity/claude-2.1.206.md).

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

- **Priority findings:** up to three supported interaction issues to address first, with inferences distinguished from established patterns.
- **All findings:** every remaining distinct issue, ordered by severity.
- **Habits that undercut you:** recurring self-defeating phrases and patterns, deduplicated by intent.
- **Habits worth keeping:** effective interaction habits supported by evidence.
- **Automation candidates:** repeated workflows that may deserve a Skill, command, prompt template, or automation.
- **One highest-leverage change:** one evidence-supported improvement, or no change when none is justified, without streaks, trackers, or longitudinal homework.

Evidence determines the number of items: sparse or successful sessions do not have to produce a fixed quota of problems, workflows, or suggestions. Effective habits travel through the analysis independently of findings, so a report can preserve what worked even when no problem is found. Durable instruction-file suggestions require evidence from at least two distinct sessions.

The audit targets user-authored behavior. Source metadata and recognized machine envelopes exclude system injections, tool results, and generated continuation text from eligible user evidence. Role-labeled assistant dialogue and sanitized tool/agent execution status remain available as context, including in long-session chunks, so an assistant ignoring a clear instruction or a failed tool is not automatically blamed on the user. Baseline assessments and carried summaries remain derived judgments, not proof of causality. Ordinary references to instruction files and quoted code remain available, with their original internal whitespace. Text-only authorship detection is heuristic: a human can write the same complete wrapper as a platform injection, so authorship cannot be guaranteed from text alone.

Audit context also survives the handoff from a session to the final synthesis. A bounded assessment summary can retain why a finding was absent or withdrawn, new information that justified a change, counterevidence and resolved misunderstandings—even with no findings or strengths. It is derived analysis, never an additional source of quotable user text. Legacy results without this summary explicitly have unknown assessment context; that does not prohibit directly supported observations, but it cannot establish causes or complete coverage. Effective corrections belong among strengths. Titles and recommendations must respect the same evidence limits as their explanations; a cautious paragraph does not justify an overstated headline.

Neutral workflow evidence travels separately from findings and strengths. A retained record describes a multi-step request, its task boundary, and verified quotations with original message locators. This lets later synthesis consider a workflow without first calling it a problem or an effective habit. Records describe requests, not verified execution. Rephrasing or correcting the same task and discussing quoted examples do not establish independent repetitions; missing records do not establish that no workflows occurred. Automation recommendations must identify separate requests or episodes and preserve their scope and approval boundaries in the draft.

Audit findings must cite real user-message indexes in the cited session. Claimed quotations must be verbatim substrings of those exact messages. Baseline quotations are likewise checked against their cited dialogue messages. Later chunk summaries may only reuse quotations with their validated original locators.

Every cited audit message must match a supplied quotation; unrelated indexes cannot inflate support. Findings distinguish a directly observed instance from an inference and a repeated pattern. Repeated patterns require at least two distinct quoted user messages; the report displays how many messages and sessions support an item, without presenting those counts as a real-world occurrence rate. A single-session observation cannot establish a cross-session habit. Severity determines priority, so adding references cannot promote a low-severity issue above a critical one. Fast summaries and the agent handoff retain evidence posture, explanation, quotations, and locators. An incomplete audit does not turn arbitrary overview prose into a prescribed change.

When the model assigns compatible findings or patterns the same root cause or intent, deduplication retains their combined verified quotations and session locators. Counts are recomputed from distinct canonical session/message pairs. Combining support does not itself increase severity or change an observation into an established pattern; deciding whether interpretations are compatible remains a semantic judgment.

Strengths and the highest-leverage change also require quotations and matching message locators. Automation candidates need evidence from at least two distinct user messages; frequency is reported as cited messages and sessions, not an invented daily or weekly rate. These checks establish provenance, not the correctness of the model's interpretation.

Both HTML and Markdown deliver the semantic report, including explanations, quotations, locators, recommendations, and copyable prompts. A completed section with no supported items is distinguished from a section that could not be analyzed. The agent handoff reads the Markdown report and retains these evidence boundaries.

Failed analysis sections remain visible with an unavailable state and reason. Read coverage names the affected sections, so a missing analysis cannot be mistaken for a completed analysis with no findings; successfully completed sections remain usable.

Report citations link to the retained evidence in the same document. Baseline citations identify a supporting session; they do not invent a claim-to-message mapping. Exact audit locators link to matching retained evidence when available, and otherwise remain readable locators. Canonical session identities keep sources separate even when native session IDs collide; ambiguous or missing references never link to an arbitrary session. The evidence index preserves structured descriptions without turning them into quotations, and says when a session has no retained message evidence. Following a citation helps inspect the basis for a conclusion; it does not certify the model's interpretation.

The audit rejects medical, intelligence, moral, and unrelated personality judgments. Bold inferences are labelled and cannot use unsupported absolute certainty.

Deterministic metadata signals remain separate from audit findings. Short messages, correction keywords, tool concentration, and tool-name checks are review cues only; they cannot establish unclear goals, direction churn, or missing verification. These signals never inject unvalidated accusations or task-spec advice into the audit. Existing JSON metric keys remain stable.

Baseline analysis can distinguish tool calls from results using tool identity and structured execution status. Tool arguments and output bodies remain excluded. When a source supplies no reliable result status, it stays unknown; tool execution success does not prove that the user's goal or acceptance criteria were met. Pi and OpenCode assistant failures or cancellations remain visible as structured events even when there is no assistant text, without including error bodies. Pi analysis follows the active parent-linked conversation branch, and OpenCode synthetic or ignored text parts are excluded from user-authored evidence.

Token coverage is reported separately from transcript coverage. Input, output, cache-read, and cache-write counters retain recorded subtotals and distinguish an explicit zero from a missing field. A complete total is available only when every selected session has all four buckets and its transcript is complete; otherwise the total is unknown. Pi uses its native four disjoint buckets on the active branch; reasoning and one-hour cache-write subsets are not added again. These local records are not account-wide billing or a measure of collaboration efficiency. Legacy numeric JSON counters remain compatible; use `coverage.tokenUsage` (also passed to aggregate analysis as `tokenUsageCoverage`) to interpret them. Old imports and merged subagent metadata without field-presence information remain unknown.

Project-area session counts are model grouping estimates, not an independently verified membership list. Counts must be native safe integers, no smaller than the distinct cited sessions and no larger than the completed sessions analyzed in this run. Representative citations may cover only part of that group. Cited-session context resolves canonical identities before unique aliases; ambiguous references never borrow another session’s statistics. Missing metrics remain unknown, partial metrics show their coverage, and whole-session totals do not establish the cost of a particular habit.

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

When invoked while Pi is processing another turn, the prepared analysis is queued as a follow-up. The command displays the run ID and a resume command before handing it to the model. This confirms preparation only; the report is ready after the semantic loop and finalization finish.

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
      |     user evidence with role-labeled interaction context
      |
      +-- cross-session audit aggregate
      |     priority findings, strengths, patterns, automation, leverage
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

CLI options that take a value reject missing or blank values before work starts.
Boolean options accept a bare flag or explicit `true`/`false`, so `--all=false`
keeps the default time range and `--force=false` preserves existing installation
files. Unknown options fail explicitly. Inline values retain everything after
the first `=`, including further `=` characters in paths or model IDs.

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

`prepare`, `insights`, and `report` accept `--project <path>` to include that directory and its descendants. Relative paths resolve from the invoking working directory; sessions with unknown projects are excluded. A session that switches between projects inside and outside the requested scope is excluded as a whole, with a visible count; switching to a subdirectory within the scope is allowed. Preparation checks the scope again before exposing analysis tasks. The normalized scope and exclusions remain in the checkpoint and report. Discovery and file caps apply before project and date filtering, so a capped scan can miss matching sessions; coverage retains that limitation. Semantic runs reject `--include-subagents` until a complete merged transcript projection is supported. Metadata collection can merge those records, with an explicit semantic exclusion and partial coverage.

Time filters select whole sessions by their last recorded timestamp; they do not trim individual messages. Rolling windows include both boundaries and end at collection time. All-history selection also excludes records dated after that time. Custom start/end dates cover complete UTC calendar days. New CLI runs retain the collection time as `request.selectedAt`, carried into `coverage.selectedAt` in the report; resumed finalization never moves this anchor. Older runs without it explicitly have an unknown rolling-window anchor. The report distinguishes the requested window from the start dates of the selected sessions. Preparation rechecks the frozen window and rejects a source that moved outside it, with visible partial coverage.

Duplicate records within one source/native session identity are analyzed once. A complete readable copy takes precedence over an incomplete copy; the unread remainder of an incomplete copy still appears in coverage. Under a project filter, complete copies whose own metadata establishes that scope take precedence over copies with unknown project metadata. Known project paths from duplicate copies remain part of scope checking, and conflicting project metadata is reported instead of disappearing when a representative copy is chosen. The same native ID in different sources remains separate. Preparation also rejects transcripts that become incomplete after collection, rather than analyzing their surviving prefix as complete history.

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

Aggregate batches account for the serialized input, prior synthesis, and prompt instructions. Oversized baseline session data, statistics, and completed report sections can travel as ordered derived fragments; splitting a session does not create another session or an independent occurrence. New runs make all validated baseline evidence available to aggregation; older runs retain their original projection and grouping so pending tasks do not change meaning. Audit batches keep findings, strengths, workflow records, and their verified quotations intact, with the original session and message identities. Their batch boundaries adapt to the prior synthesis and are frozen before exposure. A later batch can cite its exposed evidence and the quotations retained in the prior synthesis, not unseen parts of the original session. Inputs that still cannot fit the safety limit remain visibly unavailable; stored analysis is retained.

State-changing semantic commands are exclusive per run, including submission reading and cleanup. A competing command returns `ERR_SEMANTIC_RUN_BUSY` without consuming its submission; retry that command after the active command finishes. Analysis of independent aggregate tasks may still run in parallel, but submit results one at a time. A lock left by a process confirmed dead on the same machine can be recovered automatically; a live or unverifiable owner is never displaced just because time has passed. If a result is accepted but submission cleanup fails, the CLI returns the accepted result with `submissionCleanupWarning`; continue with `semantic next` instead of resubmitting it. A lock-release failure after completion likewise preserves the successful result or report paths with `lockCleanupWarning`. Resolve the filesystem error before continuing; the same process retries its unfinished lock cleanup and refuses new work while cleanup remains blocked.

While a baseline task awaits a result, its bounded exposed text is held in the private checkpoint so quotations can be checked against exactly what the model saw. That pending text is removed when the task is ingested or failed. Completed audit data retains indexed representative excerpts and validated quotations rather than the complete user-message corpus.

Run and report files use mode `0600` inside private `0700` directories. `finalize` removes transient submission files while retaining the run manifest and final report artifacts.

Report publication prepares all formats before replacing the latest files, keeps backups until the replacement completes, and restores them if publication fails. An interrupted replacement is recovered on the next publication attempt. If restoration also fails, `ERR_REPORT_RECOVERY_REQUIRED` preserves the journal and backups for retry after resolving the filesystem error. Competing publishers to the same output directory receive `ERR_REPORT_OUTPUT_BUSY`. Historical HTML filenames include a unique suffix so reports created in the same second remain separate. The individual latest files retain their familiar paths; an external reader opening several files during replacement does not get a guaranteed atomic snapshot of the entire set.

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

Optional developer tooling (`parity compare` / `parity evaluate`) and `acceptance.overall` record one optional compatibility evaluation. They do **not** gate whether Agent Insight is complete or shippable. Details: [compatibility evaluation notes](parity/acceptance.md).

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
- Long messages retain their full text and original evidence indexes across bounded chunks, including constraints or outcomes at the end. Very large inputs use bounded rolling summaries. An input that cannot fit the safety envelope fails visibly instead of being silently sampled.
- Semantic reports intentionally retain representative evidence and must be reviewed before external sharing.
- Deterministic metadata cannot prove intent, satisfaction, or code quality; those claims require semantic analysis and evidence.

## Troubleshooting

### `agent-insight: command not found`

Run `npm link` in this repository and ensure npm's global binary directory is on the host agent's `PATH`.

### A run was interrupted

Keep its run ID and invoke `semantic next` with the same host/model identity. The pending task is reconstructed when safe.

Current checkpoints use `semantic-run-v5` and user-audit protocol v3. Checkpoints from the older `semantic-run-v1` through `semantic-run-v4` evidence protocols cannot resume under the current interaction-context and evidence checks. Run `prepare` again to create a new analysis. Existing checkpoints and reports are preserved; completed results are not silently reused as newly validated evidence.

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

- [Claude Code 2.1.206 compatibility contract](parity/claude-2.1.206.md)
- [Compatibility evaluation notes (optional developer tooling)](parity/acceptance.md)
- [Claude Code commands](https://code.claude.com/docs/en/commands) and [session storage](https://code.claude.com/docs/en/sessions)
- [OpenCode commands](https://opencode.ai/docs/commands) and [CLI reference](https://opencode.ai/docs/cli)
- [Cursor custom commands](https://docs.cursor.com/en/agent/chat/commands)
- [Pi sessions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md#sessions) and [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Groq coding integrations](https://console.groq.com/docs/coding-with-groq)

# Claude Code `/insights` parity contract

- Status: implemented compatibility contract; acceptance requires the parity gates below
- Reference: Claude Code `2.1.206`
- Reference build: `2026-07-09T01:39:20Z`
- Reference Git SHA: `edc8ebf7f852d3abffad32a5bf8e49e439f92afb`
- Agent Insight command: `/agent-insights`

This document is both a compatibility specification and a product boundary.
Every requirement is labelled as one of:

- **[1:1]**: reproduce the observable Claude Code 2.1.206 behavior in the
  parity profile and its fixtures, including quirks that affect snapshots.
- **[Transparent exceed]**: intentionally improve on Claude without allowing
  that improvement to hide a missing parity capability. These behaviors are
  the Agent Insight default where they conflict with an unsafe or misleading
  Claude behavior.

Cross-agent support is not evidence of Claude parity. The Claude profile must
pass its own structural, factual, and semantic gates first.

## 1. Invocation and model ownership

### Claude 2.1.206 reference flow

**[1:1]** `/insights` is a built-in prompt command with:

- description: `Generate a report analyzing your Claude Code sessions`;
- progress message: `analyzing your sessions`;
- no arguments, scope picker, time picker, cost estimate, or confirmation;
- local-primary-session collection only (`collectRemote=false`);
- the currently selected Claude Code model for all semantic calls;
- no MCP tools and no subagents in those semantic calls.

The reference pipeline is:

```text
/insights
  -> discover primary local session JSONL files
  -> load or compute deterministic session metadata
  -> load or compute per-session semantic facets
  -> run seven aggregate semantic section calls in parallel
  -> run one At a Glance synthesis call
  -> render timestamped HTML plus report.html
  -> ask the host model to return the report link verbatim
```

The final visible response is equivalent to:

```text
Your shareable insights report is ready:
file://<timestamped-report>

Want to dig into any section or try one of the suggestions?
```

The timestamped report, not `report.html`, is linked.

### Agent Insight default interaction

**[Transparent exceed]** every invocation first asks:

1. Agent scope: current agent (default), all agents, or selected agents.
2. Time range: 7 days, 30 days (default), 90 days, all history, or a custom
   start/end date.

It asks every time and does not persist either choice. It does not show a
cost, token, or duration estimate. Explicit CLI flags may answer the prompts,
but must resolve to the same public run-request contract.

Semantic execution belongs to the invoking host and the user's configured
provider:

- Claude Code uses Claude Code;
- Codex uses Codex;
- OpenCode uses OpenCode and its active provider;
- Pi uses Pi and its active provider;
- Cursor uses its host model capability when available; otherwise the report
  marks semantic analysis unavailable and offers an explicitly configured
  compatible host. It must not silently switch providers.

The selected time range is complete by default. Fast or sampled modes must be
explicit and must display their exact coverage. There is no silent sampling.

## 2. Discovery, branch selection, and eligibility

### Reference discovery

**[1:1]** the Claude root is:

```text
${CLAUDE_CONFIG_DIR:-~/.claude}/projects
```

The reference implementation:

1. enumerates direct child project directories;
2. enumerates direct child `*.jsonl` files in each project directory;
3. accepts only filenames that pass Claude's internal session-ID validator;
4. does not traverse `<session>/subagents/`;
5. records path, mtime, birthtime, and size;
6. sorts discovered primary files by mtime descending.

A primary transcript can contain multiple leaf branches. Claude loads all
leaves, then deduplicates by `session_id`. The winning branch has the greater
`user_message_count`; ties are broken by greater `duration_minutes`.

**[1:1]** a session is eligible for the semantic report only when:

- it has at least two user messages;
- its rounded duration is at least one minute; and
- its facet is not solely `goal_categories.warmup_minimal > 0`.

The reference has no date filter. Its effective history is bounded by the
transcripts still present on disk; Claude's default transcript cleanup period
is 30 days unless the user changes `cleanupPeriodDays`.

### Reference hidden limits

These limits are part of the parity fixture, not acceptable default product
behavior:

| Stage | Claude 2.1.206 behavior |
| --- | --- |
| Discovery/meta scan batch | 50 files |
| Missing session-meta recomputation | at most 200 per run |
| Stale session-meta recomputation | at most 200 per run |
| Transcript load batch | 10 files |
| New semantic facets | at most 50 per run |
| Facet execution batch | up to 50 concurrent calls |
| Aggregate session summaries | first 50 facets |
| Aggregate friction details | first 20 non-empty details |
| Aggregate repeated instructions | first 15 entries |
| Per-session facet output | at most 4,096 tokens |
| Each aggregate section output | at most 8,192 tokens |

Reference consequences:

- missing meta beyond 200 is silently omitted for that run;
- stale meta beyond 200 remains in use;
- only 50 newly loaded eligible transcripts receive facets;
- a session that receives meta but misses the 50-facet budget can become a
  permanent facet hole, because later runs regard its meta as fresh and no
  longer load the transcript needed for facet extraction;
- report prose can be based on fewer semantic facets than the displayed
  session total without disclosing that difference.

**[Transparent exceed]** Agent Insight must walk every selected source within
the chosen time range, expose discovered/selected/read/parsed/analyzed/failed
counts per source, and preserve every incomplete state. A safety limit may
stop work, but the report must say which limit fired and which sessions remain.

## 3. Deterministic per-session metadata

### Metadata schema

**[1:1]** the normalized Claude session-meta object contains:

```text
session_id
project_path
start_time
duration_minutes
user_message_count
assistant_message_count
tool_counts
languages
git_commits
git_pushes
input_tokens
output_tokens
first_prompt
summary
user_interruptions
user_response_times
tool_errors
tool_error_categories
uses_task_agent
uses_mcp
uses_web_search
uses_web_fetch
lines_added
lines_removed
files_modified
message_hours
user_message_timestamps
transcript_mtime
```

### Exact metric definitions

**[1:1]**:

- `duration_minutes` is the created-to-modified difference, rounded to the
  nearest whole minute.
- A user message counts when its content is a non-empty string or it contains
  at least one text block. Tool-result-only user records do not count.
- Every assistant record counts toward `assistant_message_count`.
- Input and output tokens are sums of `message.usage.input_tokens` and
  `message.usage.output_tokens` on assistant records.
- Each assistant `tool_use` block increments `tool_counts[tool_name]`.
- `uses_task_agent` is true when a Task/Agent tool is used.
- `uses_mcp` is true when a tool name begins with `mcp__`.
- `uses_web_search` and `uses_web_fetch` reflect `WebSearch` and `WebFetch`.
- A tool input command containing the substring `git commit` or `git push`
  increments that counter. This is a substring test, not a parsed Git action.
- Any tool input with `file_path` contributes one language occurrence when
  the extension is recognized; reads can therefore count as language use.
- `files_modified` is the number of distinct `file_path` values passed to
  Edit or Write in that session. The aggregate sums per-session counts, so the
  same file edited in multiple sessions is counted multiple times.
- Edit line counts come from a diff of `old_string` and `new_string`.
- Write adds the number of newline characters in `content`, plus one.
- A user interruption is text containing `[Request interrupted by user`.

Recognized language extensions are:

| Extensions | Label |
| --- | --- |
| `.ts`, `.tsx` | TypeScript |
| `.js`, `.jsx` | JavaScript |
| `.py` | Python |
| `.rb` | Ruby |
| `.go` | Go |
| `.rs` | Rust |
| `.java` | Java |
| `.c`, `.h` | C |
| `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx`, `.ipp` | C++ |
| `.md` | Markdown |
| `.json` | JSON |
| `.yaml`, `.yml` | YAML |
| `.sh` | Shell |
| `.css` | CSS |
| `.html` | HTML |

Tool errors are user `tool_result` blocks with `is_error=true`. String content
is lower-cased and matched in this order:

| Match | Category |
| --- | --- |
| `exit code` | Command Failed |
| `rejected` or `doesn't want` | User Rejected |
| `string to replace not found` or `no changes` | Edit Failed |
| `modified since read` | File Changed |
| `exceeds maximum` or `too large` | File Too Large |
| `file not found` or `does not exist` | File Not Found |
| anything else, including non-string content | Other |

User response time is the number of seconds between the last assistant record
timestamp and the next valid user text timestamp. Values at or below 2 seconds
and at or above 3,600 seconds are discarded. Median is the sorted value at
`floor(length / 2)`, so an even sample uses the upper middle value rather than
the average of the two middle values.

## 4. Reference transcript projection and semantic facets

### Content sent to the analyzer

**[1:1]** Claude projects a session into:

- session ID prefix (eight characters), date, raw project path, and duration;
- every user text truncated to 500 characters;
- every assistant text truncated to 300 characters;
- tool names only, without tool input or tool result content.

If this projection exceeds 30,000 characters, Claude slices it into 25,000
character chunks. Each chunk is summarized in parallel in at most 500 output
tokens, then the summaries are passed to facet extraction. Chunk summaries are
not persisted separately.

**[Transparent exceed]** raw transcript content may be sent to the invoking
host model, as explicitly accepted by the user. Final reports may persist
representative user quotations, absolute project paths, agent identity, dates,
and session identifiers. Complete transcripts, tool arguments, and tool results
are not copied into the report. Content-privacy filters that rejected verbatim
overlap, absolute paths, or credential-shaped prose are not used.

### Per-session facet schema

**[1:1]** the requested model result is:

```json
{
  "underlying_goal": "string",
  "goal_categories": {"category_name": 1},
  "outcome": "fully_achieved | mostly_achieved | partially_achieved | not_achieved | unclear_from_transcript",
  "user_satisfaction_counts": {"level": 1},
  "claude_helpfulness": "unhelpful | slightly_helpful | moderately_helpful | very_helpful | essential",
  "session_type": "single_task | multi_task | iterative_refinement | exploration | quick_question",
  "friction_counts": {"friction_type": 1},
  "friction_detail": "string or empty",
  "primary_success": "none | fast_accurate_search | correct_code_edits | good_explanations | proactive_help | multi_file_changes | good_debugging",
  "brief_summary": "string"
}
```

Claude adds `session_id` after extraction. Its prompt requires goals to count
only explicit user requests, satisfaction to rely only on explicit user
signals, friction to state what went wrong, and very short warmups to use
`warmup_minimal`.

The aggregate stage also looks for an optional
`user_instructions_to_claude` array and takes its first 15 items, but the
2.1.206 facet prompt neither requests nor validates that field. It is normally
absent unless an older or externally produced facet cache contains it.

The reference validator is deliberately weak. It requires only:

- string `underlying_goal`, `outcome`, and `brief_summary`;
- object `goal_categories`, `user_satisfaction_counts`, and
  `friction_counts`.

It does not enforce enum values or require the other fields. The compatibility
reader accepts this weak shape. **[Transparent exceed]** the versioned Agent
Insight protocol additionally records schema violations and retries or marks
the facet incomplete; it never fabricates missing values and present them as
measured facts.

Reference display vocabularies include:

- goals: debug/investigate, implement feature, fix bug, write script/tool,
  refactor, configure, create PR/commit, analyze data, understand codebase,
  write tests, write docs, deploy/infra, and warmup/minimal;
- friction: misunderstood request, wrong approach, buggy code, rejected
  action, blocked, stopped early, wrong file/location, excessive changes,
  slow/verbose, tool failure, unclear user request, and external issue;
- session types: single task, multi task, iterative refinement, exploration,
  and quick question;
- satisfaction: frustrated, dissatisfied, likely satisfied, satisfied, happy,
  and unsure;
- outcomes and primary successes as enumerated in the schema above.

## 5. Deterministic aggregate schema

**[1:1]** the aggregate object contains:

```text
total_sessions
total_sessions_scanned
sessions_with_facets
date_range.start
date_range.end
total_messages
total_duration_hours
total_input_tokens
total_output_tokens
tool_counts
languages
git_commits
git_pushes
projects
goal_categories
outcomes
satisfaction
helpfulness
session_types
friction
success
session_summaries
total_interruptions
total_tool_errors
tool_error_categories
user_response_times
median_response_time
avg_response_time
sessions_using_task_agent
sessions_using_mcp
sessions_using_web_search
sessions_using_web_fetch
total_lines_added
total_lines_removed
total_files_modified
days_active
messages_per_day
message_hours
multi_clauding.overlap_events
multi_clauding.sessions_involved
multi_clauding.user_messages_during
```

Exact aggregate semantics:

- `total_messages` is user messages only, despite the generic label.
- `date_range` uses session start dates, not individual message dates.
- `days_active` is the number of distinct session start dates.
- `messages_per_day` is user messages divided by active days, rounded to one
  decimal place.
- `session_summaries` contains at most 50 entries: session ID prefix, date,
  transcript summary or first 100 characters of first prompt, and underlying
  goal.
- Projects are counted by raw project path.
- Duration hours are the sum of rounded per-session minutes divided by 60.

Multi-clauding detection sorts all user timestamps and looks for messages from
different sessions inside a rolling 30-minute window:

- `overlap_events` is the number of unique unordered session pairs;
- `sessions_involved` is the number of unique sessions in those pairs;
- `user_messages_during` is the deduplicated set of participating messages;
- the displayed percentage is
  `round(100 * user_messages_during / total_messages)`.

Several deterministic fields are retained in aggregate data but not rendered
as dedicated HTML metrics or charts: duration, input/output tokens, Git
commits and pushes, raw project counts, helpfulness, interruption total, total
tool errors, and Task/MCP/WebSearch/WebFetch adoption. They may influence
semantic generation, but structural parity must not invent native cards for
them.

## 6. Aggregate semantic sections

Claude sends aggregate counts plus at most 50 brief summaries, 20 friction
details, and 15 repeated instructions to seven independent section calls.
The shared semantic input envelope contains:

```text
sessions
analyzed
date_range
messages
hours (rounded)
commits
top_tools (top 8)
top_goals (top 8)
outcomes
satisfaction
friction
success
languages
SESSION SUMMARIES (first 50)
FRICTION DETAILS (first 20 non-empty)
USER INSTRUCTIONS TO CLAUDE (first 15, usually absent)
```

The deterministic HTML charts independently use a top-six limit; the top-eight
semantic envelope is not the chart contract.

### `project_areas`

**[1:1]** four or five items:

```json
{
  "areas": [
    {"name": "string", "session_count": 0, "description": "string"}
  ]
}
```

### `interaction_style`

```json
{
  "narrative": "two or three paragraphs",
  "key_pattern": "string"
}
```

It analyzes quick iteration versus detailed upfront specifications, whether
the user interrupts or lets Claude run, and includes concrete examples.

### `what_works`

**[1:1]** exactly three requested workflows:

```json
{
  "intro": "string",
  "impressive_workflows": [
    {"title": "string", "description": "string"}
  ]
}
```

### `friction_analysis`

**[1:1]** three requested categories with two requested examples each:

```json
{
  "intro": "string",
  "categories": [
    {
      "category": "string",
      "description": "string",
      "examples": ["string", "string"]
    }
  ]
}
```

### `suggestions`

```json
{
  "claude_md_additions": [
    {
      "addition": "string",
      "why": "string",
      "prompt_scaffold": "string"
    }
  ],
  "features_to_try": [
    {
      "feature": "string",
      "one_liner": "string",
      "why_for_you": "string",
      "example_code": "string"
    }
  ],
  "usage_patterns": [
    {
      "title": "string",
      "suggestion": "string",
      "detail": "string",
      "copyable_prompt": "string"
    }
  ]
}
```

Claude asks for two or three items per category. Durable instructions repeated
across sessions take priority for CLAUDE.md additions. The fixed feature
reference is MCP Servers, Custom Skills, Hooks, Headless Mode, and Task Agents.

### `on_the_horizon`

**[1:1]** three requested opportunities:

```json
{
  "intro": "string",
  "opportunities": [
    {
      "title": "string",
      "whats_possible": "string",
      "how_to_try": "string",
      "copyable_prompt": "string"
    }
  ]
}
```

### `fun_ending`

```json
{
  "headline": "a qualitative memorable moment, not a statistic",
  "detail": "string"
}
```

### `at_a_glance`

After the seven calls complete, Claude makes an eighth synthesis call:

```json
{
  "whats_working": "string",
  "whats_hindering": "string",
  "quick_wins": "string",
  "ambitious_workflows": "string"
}
```

Each field is requested as two or three sentences. `whats_hindering` separates
Claude-side misunderstandings, wrong approaches, and bugs from user-side
context or environment friction.

**[Transparent exceed]** every aggregate claim carries source agent, date,
and concrete session locators. Representative user quotations and project paths
may appear when grounded in validated evidence. A finding is a recurring pattern
only with at least two supporting sessions; one-session findings are labelled
examples.

## 7. HTML report contract

### Exact reference order

**[1:1]** the rendered document order is:

1. `Claude Code Insights` heading and subtitle.
2. At a Glance.
3. Fixed table of contents.
4. Stats row: Messages, Lines, Files, Days, Msgs/Day.
5. What You Work On.
6. What You Wanted / Top Tools Used.
7. Languages / Session Types.
8. How You Use Claude Code.
9. User Response Time Distribution.
10. Multi-Clauding (Parallel Sessions).
11. User Messages by Time of Day / Tool Errors Encountered.
12. Impressive Things You Did.
13. What Helped Most (Claude's Capabilities) / Outcomes.
14. Where Things Go Wrong.
15. Primary Friction Types / Inferred Satisfaction (model-estimated).
16. Existing CC Features to Try, including Suggested CLAUDE.md Additions and
    feature cards.
17. New Ways to Use Claude Code.
18. On the Horizon.
19. A qualitative fun ending.
20. A disabled feedback scaffold, when present.

The subtitle format is:

```text
<user-message-count> messages across <eligible-session-count> sessions
(<discovered-session-count> total, only when larger) | <start> to <end>
```

The Lines stat is rendered as `+<added>/-<removed>`.

Semantic sections are conditional and disappear when their object or list is
missing. Deterministic charts remain and show a specific empty state.

The fixed table of contents contains:

```text
What You Work On
How You Use CC
Impressive Things
Where Things Go Wrong
Features to Try
New Usage Patterns
On the Horizon
Team Feedback
```

### Chart behavior

**[1:1]** ordinary categorical bar charts show at most the six highest counts,
normalize bar width against the chart maximum, and show no axis. Outcome order
is fixed as:

```text
not achieved -> partially achieved -> mostly achieved -> fully achieved
-> unclear from transcript
```

Satisfaction display order is:

```text
frustrated -> dissatisfied -> likely satisfied -> satisfied -> happy -> unsure
```

Response-time buckets are:

```text
2-10s, 10-30s, 30s-1m, 1-2m, 2-5m, 5-15m, >15m
```

Time-of-day buckets are:

```text
Morning 6-12, Afternoon 12-18, Evening 18-24, Night 0-6
```

The reference timezone selector has PT (UTC-8), ET (UTC-5), London (UTC), CET
(UTC+1), Tokyo (UTC+9), and a custom UTC offset.

Reference empty states are exact enough to snapshot:

- an empty categorical chart says `No data`;
- response time says `No response time data`;
- time of day says `No time data`;
- tool errors says `No tool errors`;
- zero multi-clauding reports that no parallel session usage was detected and
  that the user typically works with one session at a time.

**[Transparent exceed]** every chart has an accessible text/table equivalent,
coverage context, and explicit no-data versus unavailable versus partial
states. Agent Insight uses the user's selected timezone and records it in the
report.

## 8. Cache and output contract

### Claude reference paths

**[1:1]** all paths are relative to
`${CLAUDE_CONFIG_DIR:-~/.claude}`:

```text
usage-data/session-meta/<session-id>.json
usage-data/facets/<session-id>.json
usage-data/report-YYYY-MM-DD-HHMMSS.html
usage-data/report.html
```

Cache and HTML files are written with mode `0600`. `report.html` is overwritten
as the latest report; the timestamped report remains and is returned.

Session-meta freshness uses `transcript_mtime`. A cached meta object with no
`transcript_mtime` is treated as fresh for backward compatibility; otherwise
the cache is fresh when its recorded value is greater than or equal to the
current file mtime. A stale transcript that cannot be reloaded can fall back
to stale meta.

Facet cache files are keyed only by session ID. They do not contain a content
hash, transcript mtime, prompt version, protocol version, or model identity.
Invalid facet cache objects are deleted. Chunk summaries are not cached.

The normal command writes no JSON export, although the binary contains an
internal export helper. The HTML links Google Fonts, so opening it can make a
font request even though the report file is local.

### Agent Insight run checkpoints

**[Transparent exceed]** Agent Insight does not retain a reusable cross-run
facet cache. Each new report invocation requests fresh semantic analysis for
the selected corpus and model.

Within one active run, the semantic manifest:

- checkpoints completed session facets and aggregate sections so they are not
  redone after interruption;
- freezes the active task so `semantic next` can resume it;
- uses directory mode `0700` and file mode `0600` for run state;
- cleans transient submission and projection files on finalize while retaining
  `manifest.json` and the final HTML/MD/JSON report artifacts.

Analyzer failures remain explicit: an active task that cannot complete yields a
partial or failed report state rather than silent healthy coverage.

Agent Insight writes to its own data root rather than overwriting Claude's
native `usage-data`. Its parity renderer must still match the reference HTML
information architecture and snapshot contract.

## 9. Empty states, failure states, and recovery

### Claude reference behavior

**[1:1]**:

- an absent or unreadable projects root becomes an empty scan, not a hard
  error;
- unreadable project directories, stat failures, and malformed session files
  are logged and skipped;
- malformed session-meta is treated as a cache miss;
- missing optional session-meta fields normalize to empty maps, empty arrays,
  or zero;
- a facet failing the weak validator is deleted and may be regenerated;
- facet model or JSON extraction failure omits that facet and continues;
- aggregate section failure omits that section and continues;
- cache write failure is logged and does not abort report generation;
- final HTML write failure aborts the command;
- an empty scan still proceeds toward an empty report and semantic section
  generation.

Claude extracts model JSON using a greedy first-`{` to last-`}` match and then
parses it. Aggregate section objects do not receive a complete schema
validation.

**[Transparent exceed]** Agent Insight must preserve partial results but never
silently convert a failure into healthy-looking output. Reports distinguish:

- no matching data;
- unsupported or unavailable source;
- parse failure;
- safety-limit truncation;
- incomplete semantic coverage;
- analyzer failure;
- invalid analyzer response;
- interrupted but resumable work.

## 10. Known Claude 2.1.206 quirks

These are snapshot fixtures for the parity profile and explicit correction
targets for the default Agent Insight profile:

| Reference behavior | Compatibility | Default Agent Insight behavior |
| --- | --- | --- |
| `Messages` counts user messages only | Preserve label/value in parity snapshot | Label the measure precisely while retaining a parity view |
| No date selection | All-history compatibility fixture | Ask for a range every run |
| 200 meta / 50 facet silent caps | Reproduce in limit fixtures | Analyze selected range completely or expose truncation |
| Facet cache ignores transcript changes | Test stale-facet behavior | Content-hash invalidation |
| Displayed sessions can exceed faceted sessions | Preserve reference aggregate | Display semantic coverage prominently |
| Warmup facets are excluded from totals but the aggregate summary call receives the unfiltered facet map | Preserve with a targeted fixture | Filter semantic evidence and totals consistently |
| Aggregate reads `user_instructions_to_claude`, but the facet prompt does not request it | Preserve compatibility with legacy cache fields | Make repeated instructions a versioned, validated field |
| Raw project paths enter meta and model prompts | Preserve fixture with synthetic paths | Persist concrete project paths and session identifiers as evidence labels |
| Neutral/delighted satisfaction may aggregate but not appear in fixed chart | Preserve fixed chart order | Show unmapped values or schema warnings |
| TOC always contains Team Feedback while its generators are disabled | Preserve dangling anchor in strict snapshot | Remove dangling links or mark unavailable |
| Initial time buckets use local `Date.getHours()` but offset `0` is labelled PT | Preserve under fixed test timezone | Correct timezone conversion and disclose timezone |
| Empty data can still produce model prose | Preserve empty reference fixture | Do not present unsupported prose as evidence |
| Missing semantic sections disappear | Preserve conditional DOM | Render an explicit incomplete state |
| Report says “shareable” but returns a local `file://` URL | Preserve visible response in compatibility profile | Describe local/public status accurately |

Anthropic's public changelog confirms important historical recovery surfaces:

- 2.1.101 fixed occasional omission of the report file link;
- 2.1.113 fixed `/insights` crashing with `EBUSY` on Windows;
- 2.1.136 fixed malformed tool-call input crashes;
- 2.1.149 fixed missing optional session-meta field crashes.

## 11. Public test seams

Tests observe behavior only through these boundaries:

1. command interaction and resolved run request;
2. source collection and normalized session metadata;
3. versioned per-session analyzer input/output protocol;
4. aggregate semantic section protocol;
5. report JSON, Markdown, and HTML contracts;
6. run checkpoint resume, finalize cleanup, and partial failure behavior;
7. Claude parity harness comparing reference and candidate reports.

The required parity fixture set includes:

- empty data;
- one filtered short session;
- multiple leaves for one session;
- malformed tool input and non-string tool error output;
- response-time bucket boundaries;
- timezone-fixed message-hour data;
- parallel sessions inside and outside 30 minutes;
- exactly 200/201 missing meta sessions and 50/51 new facets;
- stale meta and stale facet cases;
- missing optional cache fields;
- partial facet and aggregate section failures;
- every semantic section populated;
- the disabled Team Feedback anchor behavior.

Model processes are replaced by deterministic public-interface runners in
tests; private implementation functions are not mocked.

## 12. Acceptance gates

Parity is complete only when all gates pass:

1. **Structural parity, 100%:** every Claude 2.1.206 command state, report
   section, metric, chart, empty state, and recoverable error has a
   corresponding implementation or explicit compatibility fixture.
2. **Factual correctness, 100%:** every deterministic value recomputes from
   fixtures and every semantic example resolves to source evidence. Fabricated
   evidence is a release blocker.
3. **Blind semantic quality:** for the same Claude sessions, at least 80% of
   hidden pairwise evaluations rate Agent Insight tied with or better than
   Claude on accuracy, specificity, usefulness, and personalization.

Transparent-exceed capabilities are evaluated only after these gates pass.
They cannot compensate for a missing Claude capability.

## 13. Evidence sources

Official sources:

- [Claude Code built-in commands](https://code.claude.com/docs/en/commands)
- [Claude directory and application data](https://code.claude.com/docs/en/claude-directory)
- [Claude Code data usage](https://code.claude.com/docs/en/data-usage)
- [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)

The exact 2.1.206 implementation contract was extracted read-only from the
installed binary. Reproducible evidence commands:

```bash
claude --version
file "$(command -v claude)"
```

```bash
strings -a -n 4 \
  /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
  | rg 'generateUsageReport|extractToolStats|aggregateData|session-meta|facets|friction_counts|At a Glance|Time of Day'
```

```bash
curl -sS https://r.jina.ai/https://code.claude.com/docs/en/commands \
  | rg -n -C 5 '/insights'
```

```bash
gh api repos/anthropics/claude-code/contents/CHANGELOG.md --jq .content \
  | base64 -d \
  | awk 'BEGIN{v=""} /^## /{v=$0} /\/insights/{print v " :: " NR ":" $0}'
```

# Claude Code `/insights` compatibility contract

- Status: implemented compatibility profile; fixture-protected; optional evaluation tools exist (not product release gates)
- Reference: Claude Code `2.1.206` (observable-behavior design reference)
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

Product completion is Host/Source functional acceptance (any available Host
model analyzing any supported Source). That product goal does not require
live Claude certification.

In an **optional** live or reference compatibility comparison only: passing
cross-agent Host/Source support is not by itself evidence of Claude profile
parity. Use the fixture suite and optional evaluation tools below when
comparing against a Claude baseline capture.

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

Value-taking CLI flags reject missing or blank values before source discovery
or output writes. Boolean flags accept bare activation or explicit true/false;
false does not authorize replacement or enable all-history selection. Unknown
flags are rejected, and inline values preserve characters after the first `=`.
Omitting the model on legacy prepare/insights calls retains the unknown fallback;
an explicitly missing or blank model value is an error.

The Pi command shows the prepared run ID, pending-analysis state and resume
command before handoff. It delivers the analysis as a follow-up when Pi is busy,
preserving the current turn. Preparation and queuing are separate from completed
semantic analysis and report publication.

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

**[extension]** Agent Insight additionally tracks field-presence coverage for
input, output, cache-read, and cache-write usage. Numeric legacy counters remain
observed subtotals; absent usage is unknown, not a measured zero. The report's
`coverage.tokenUsage` and aggregate model's `tokenUsageCoverage` retain these
limits independently of transcript discovery coverage. A complete total requires
all four buckets across every selected, untruncated session. Old imports and
merged subagent metadata without presence information cannot establish a total.
Pi native `input`, `output`, `cacheRead`, and `cacheWrite` are disjoint buckets on
the active branch; `reasoning` and `cacheWrite1h` are subsets and are not added
again. This scope does not represent all stored branches or account billing.

**[extension]** `totalSessionsScanned` uses selected files, not every discovered
candidate. Explicit project filters apply consistently to report and semantic
runs, resolve relative paths from the invoking directory, include descendants,
and exclude unknown-project records. The normalized filter survives checkpoints
and finalization. All known project paths in a session must be within the scope;
sessions crossing that boundary are excluded with a visible count, and semantic
preparation checks the current source again before exposing analysis tasks.
File caps precede filtering and retain partial-coverage notes;
they do not silently imply exhaustive coverage of a selected project.

Duplicate source/native session identities retain one representative, preferring
a complete readable copy, while incomplete-copy coverage and all known project
paths remain visible. Conflicting project metadata is diagnosed and participates
in scope exclusion. Scoped selection prefers a complete copy whose own metadata
proves that project scope, rather than attributing another copy's paths to it.
Different sources never share a canonical identity merely
because their native IDs match.

Time selection uses the session's last recorded timestamp and includes the whole
session. Rolling windows and all-history selection end at the frozen collection
time; custom dates use inclusive UTC calendar days. New CLI runs retain that
time as `request.selectedAt` and `coverage.selectedAt`, independently of report
generation time. Legacy missing anchors remain unknown. Semantic preparation
rechecks both current parse completeness and the known time scope before
exposing a task; newly incomplete or out-of-scope sources produce explicit
partial coverage. A file exactly at its record limit is complete when no extra
nonempty record exists, with or without a final newline.

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

**[Transparent exceed]** Agent Insight preserves complete dialogue text in
bounded chunks, including original internal whitespace and late constraints.
New aggregate plans also partition oversized derived session data, metrics,
and completed sections using their serialized envelope size. Session identity
is preserved across fragments, and baseline aggregation retains every validated
facet evidence item. Audit aggregation partitions complete records and exposed
excerpts, preserves assessment context, and budgets each batch together with
the prior synthesis. Frozen boundaries and original quote/message identities
remain stable across continuation and ingestion. Fragment counts do not measure
session counts or repeated behavior. An indivisible input or carry that still
exceeds the prompt limit is reported as unavailable with its stored analysis
retained, rather than silently shortened.
Its baseline projection distinguishes tool calls from results and may include
the tool name, call identifier, and explicit structured execution status.
It does not include tool arguments or output bodies. A missing reliable status
remains `unknown`; a successful tool execution is not proof of task completion
or user acceptance. User-audit input continues to exclude tool records entirely.
Native Pi sessions use the active parent-linked branch; OpenCode synthetic and
ignored text parts do not become user-authored audit evidence.
Pi and OpenCode assistant failures and cancellations with no text are retained
as separate `agent_event` status records, without error bodies. Tool and agent
events can ground a described observation but cannot become dialogue quotations.

Authorship filtering uses source metadata and recognized boundary envelopes.
Natural-language mentions of instruction files, quoted examples, and code
whitespace are preserved. Text-only wrappers remain an authorship heuristic,
not proof that a human could not have written an identical wrapper.
Only a leading standalone transport timestamp in a Cursor user message can
supply a missing clock; quoted timestamps and assistant examples cannot change
the analysis time window. Explicit JSON timestamps always take precedence.

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

**[Transparent exceed]** Claude requests four or five items; Agent Insight returns zero to five evidence-supported areas, preserving the same object shape:

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

**[Transparent exceed]** Claude requests exactly three workflows; Agent Insight accepts zero to three evidence-supported workflows:

```json
{
  "intro": "string",
  "impressive_workflows": [
    {"title": "string", "description": "string"}
  ]
}
```

### `friction_analysis`

**[Transparent exceed]** Claude requests three categories with two examples each; Agent Insight accepts zero to three observed categories with one or two evidenced examples each. A smooth session may return `categories: []`; `intro` distinguishes no observed friction from insufficient evidence:

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

Claude asks for two or three items per category. **[Transparent exceed]** Agent Insight accepts zero to three items per category; a single-session sample cannot establish repeated guidance and must leave `claude_md_additions` empty. Durable instructions repeated
across sessions take priority for CLAUDE.md additions. The fixed feature
reference is MCP Servers, Custom Skills, Hooks, Headless Mode, and Task Agents.

### `on_the_horizon`

**[Transparent exceed]** Claude requests three opportunities; Agent Insight accepts zero to three justified opportunities and states evidence limits in `intro`:

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

**[Transparent exceed]** numerical quotas never justify invented strengths, problems, examples, or recommendations. Empty arrays retain the section schema; required prose states no observation or insufficient evidence explicitly. Single-session observations do not establish recurring habits. Durable instruction additions require evidence from at least two distinct sessions. Canonical session IDs take precedence over source aliases, and ambiguous aliases are rejected. At a Glance may state that no improvement is justified; the final host summary presents up to three supported hard truths and may have no change to recommend.

**[Transparent exceed]** every aggregate claim carries source agent, date,
and concrete session locators. Representative user quotations and project paths
may appear when grounded in validated evidence. A repeated observation requires
at least two distinct quoted user messages; a cross-session habit requires
support from at least two distinct sessions. A single direct observation uses
`observed_instance`; uncertain interpretations use `bold_inference`. Every cited
message must match a supplied quotation. Message/session coverage counts are
computed from canonical, deduplicated locators and do not establish real-world
event frequency or the correctness of an interpretation. Severity determines
priority independently of citation volume.

The user audit retains role-labeled assistant dialogue and sanitized tool/agent
execution status as context in direct and chunked requests. Only genuine user
messages may be quoted as user evidence. Derived baseline outcome/friction
assessments are identified as derived, and do not themselves prove causality.
Short summaries and the final host handoff preserve evidence posture,
explanations, quotations and locators. Missing or incomplete audits do not
promote arbitrary At a Glance prose into a prescribed action.

Session audits also retain optional `assessmentContext`: a bounded derived
summary of counterevidence, resolved misunderstandings, justified changes and
reasons for absent or withdrawn findings. It survives direct/chunked session
analysis and rolling aggregation independently of findings and strengths. An
older chunk's cumulative summary can supply this derived context; an explicit
`unknown` is never promoted to `assessed`. Missing direct-session context stays
unknown. Assessed means that a summary was supplied, not complete coverage or
independent confirmation. This channel cannot authorize new user quotations or
message locators. Identical summary text is serialized only once per carry.

Optional `workflowEvidence` retains bounded neutral observations independently
of findings and strengths. Each record contains a description, task boundary,
and verified user quotations with original locators. It follows both session
chunks and rolling aggregation, including requests beyond representative early
message samples. Missing records mean unknown retention, not proof that no
workflow occurred. A record establishes a request, not execution or frequency.
Automation candidates require separate requests or episodes; corrections and
restatements of one task, and quoted examples, do not establish repetition.
Generated drafts must preserve the source scope and approval boundaries.

Root-cause and intent deduplication combines verified support from compatible
model-grouped items, deduplicates canonical session/message pairs, and recomputes
evidence coverage. It retains the selected representative's severity and
evidence posture. More references alone neither raise priority nor establish a
pattern; provenance validation cannot decide semantic compatibility.

Effective corrections are strengths; `correction_quality` findings require an
observed defect. Each title and recommendation must independently respect the
available evidence—qualifications in an explanation cannot repair a stronger
headline. When present, the final assessment summary appears as analysis context
in HTML, Markdown and the narrative handoff, separate from source quotations.

## 7. HTML report contract

### Exact reference order

**[1:1]** the rendered document order is:

1. `Claude Code Insights` heading and subtitle.

> **Agent Insight default (non-Claude hosts):** HTML chrome uses the English brand
> title `Agent Insight` with Simplified Chinese section labels by default
> (`--locale zh`). Claude-host / `parityProfile: claude-2.1.206` reports keep the
> English `Claude Code Insights` shell below for 1:1 parity.
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

**[Transparent exceed]** HTML and Markdown citations navigate to retained
session evidence within the report. Baseline session references do not imply
that every retained message supports that particular conclusion. Exact audit
locators link only to matching retained evidence; otherwise their original
message indexes stay visible. Canonical identities take precedence over native
aliases, and ambiguous or missing aliases do not choose an arbitrary source.
Sessions without retained message evidence have an explicit empty state.
Structured descriptions with no quotation remain descriptions. These links
make the evidence inspectable without asserting that interpretation or causal
attribution has been independently verified.

Failed semantic sections retain a named unavailable placeholder in HTML and
Markdown. Read coverage identifies the affected sections and recorded reasons;
completed empty sections still mean no supported items were found, rather than
analysis failure. Message locators use projected-message indexes, not JSONL line
numbers. The sticky navigation has a shared scroll offset for section and
evidence targets.

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

State mutations are exclusive per run. Overlapping commands fail explicitly as
busy without consuming an unaccepted submission; independent model analysis can
still run in parallel. Recovery never expires a live owner's lock by elapsed
time. CLI submission cleanup remains inside the transaction, and a cleanup
failure after acceptance is reported as a warning on the accepted result.
Lock-release failures similarly preserve successful results with a cleanup
warning; they do not turn completed work into an unqualified failure. A process
can retry cleanup of its completed transaction before starting another.

Report output uses a separate directory transaction with staged formats and
recoverable backups. Publication failure restores the previous latest files;
an interrupted replacement is recovered before the next publication. Unfinished
recovery retains its journal and reports an explicit error. This is recovery
and writer exclusion, not a group-atomic snapshot for external readers.
Agent Insight's historical HTML name adds a UUID to the reference timestamp
shape, so separate publications cannot overwrite one another within a second.

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

## 12. Optional compatibility evaluation

These checks protect and optionally score the Claude compatibility profile.
They are **not** product ship gates. Fixture coverage of structural and
deterministic behavior is the in-repo regression bar. Live reference compare
and blind review remain optional developer tools.

1. **Structural coverage (fixtures / optional compare):** every Claude 2.1.206
   command state, report section, metric, chart, empty state, and recoverable
   error has a corresponding implementation or explicit compatibility fixture.
2. **Factual correctness:** every deterministic value recomputes from fixtures
   and every semantic example resolves to source evidence. Fabricated evidence
   is a release blocker for report quality (independent of live Claude
   certification).
3. **Blind semantic quality (optional):** when running a blind compare against
   a trusted Claude capture of the same sessions, at least 80% of hidden
   pairwise evaluations should rate Agent Insight tied with or better than
   Claude on accuracy, specificity, usefulness, and personalization.

Transparent-exceed capabilities must not hide a missing Claude baseline
capability in the compatibility profile. They do not require a live Claude
certification pass before the product may ship.

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

## Project-area estimates and cited-session context

The project-area JSON shape remains unchanged. `session_count` must now be a native safe integer between the distinct canonical citation count and the completed analyzed session count; coerced strings, booleans, nulls, fractions, and impossible totals are rejected. HTML and Markdown label these values as model estimates and explain that citations are representative rather than complete membership. This is an intentional validation and presentation extension, not an exact Claude wording claim.

Audit context metrics resolve canonical IDs before unique aliases, deduplicate matched sessions, and expose unresolved references. Missing metrics remain unknown and partial subtotals disclose recorded coverage. These whole-session totals do not establish causal cost.

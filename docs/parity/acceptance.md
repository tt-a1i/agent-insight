# Compatibility evaluation notes

## Product decision (overrides older certification goals)

Agent Insight product completion is **Host + Model + Source** functional acceptance:

- supported session discovery for each Source
- semantic analysis owned by the current Host model
- fused Claude-compatible baseline + user-audit report
- sharp user-audit with quotation/locator evidence
- bounded prompts and single-run frozen-task recovery
- honest coverage and failure states

**Non-goals for product release (explicit user decision):**

- live Claude Code 2.1.206 independent reference capture
- out-of-band SHA-256 / live structural or deterministic score `1`
- blind semantic review against Claude
- five-host in-host UI / REPL slash-command smoke
- Claude CLI availability, login, or authentication

Historical Issue #8 asked for reference / blind / live certification. That requirement is **superseded**: those items are optional developer or research tooling, not product blockers. Claude unavailable or unauthenticated does **not** mean Agent Insight is incomplete. The project may state feature implementation is complete without claiming official Claude certification.

| Kind | What it proves | Product role |
| --- | --- | --- |
| Gate / fixture tests (`npm test`) | Extension schema and HTML headings excluded from baseline scoring; partial source/extension failure still yields a usable baseline | **Product regression** — internal evidence, not official Claude certification |
| Self-comparison of two Agent Insight reports | Harness wiring and HTML contract checks | Developer check only; forbidden as “Claude certification” |
| Trusted independent reference compare | Optional structural + deterministic scores vs a captured Claude report | **Optional** compatibility evaluation |
| Blind semantic evaluate | Optional `acceptance.overall` when machine gates + blind ratings pass | **Optional**; `acceptance.overall` is not a ship/release flag |
| Isolated CLI host smoke | Install + frozen-task resume wiring under disposable `HOME` | **Development wiring evidence**, not a product certificate |
| In-host UI slash smoke | Invoke `/agent-insights` inside each host UI/REPL | **Optional**; non-blocking |

## Baseline scoring exclusions (always in code)

`compareParityReports` scores only the Claude baseline surface:

- Required structural paths: `parity.*` baseline fields, `insights.*` deterministic metrics, and `semantic.sections.*` aggregate sections.
- Deterministic field equality under `insights.*`.
- HTML contract for Claude headings, TOC, metrics, and section order.

Explicitly **excluded** from baseline scoring:

- Report schema path `extensions` (including `extensions.userAudit` and any peer extension).
- Trailing Agent Insight HTML headings: Priority findings, All findings, Habits that undercut you, Habits worth keeping, Automation candidates, One highest-leverage change, Evidence index, Read coverage.

Those headings may appear only as a suffix after the Claude baseline `h2` sequence. Interleaving them into the baseline order fails structural parity.

Blind semantic review bundles cover the eight Claude aggregate sections only. Extension audit content must not appear in the blinded payload.

## Gate tests (fixture-labeled compatibility profile)

```bash
npm run check
npm test
```

Parity gate coverage lives in:

- `test/parity.test.mjs` — extension schema/HTML exclusion; incomplete-extension baseline still scores structural/deterministic pass on fixtures
- `test/report-html-parity.test.mjs` — rendered fused HTML keeps baseline order; partial source + incomplete audit remains usable
- `test/semantic-run-complete.test.mjs` — end-to-end audit failure still finalizes Claude baseline sections

These tests protect the compatibility profile. They must never be summarized as “official Claude parity score 1” or as a product incompleteness claim when a live reference is absent.

## Optional: independent Claude Code 2.1.206 reference compare

For researchers who want a live structural/deterministic comparison against a captured Claude `/insights` report. **Not required for product completion.**

### Prerequisites (when running this optional tool)

1. An **independently captured** Claude Code **2.1.206** `/insights` report, normalized into Agent Insight report JSON shape (or captured via the documented normalization path).
2. Provenance on the reference object:

   ```json
   {
     "parity": {
       "provenance": {
         "kind": "claude-code",
         "version": "2.1.206",
         "captureHash": "<capture-id>"
       }
     }
   }
   ```

3. An **out-of-band** SHA-256 of the reference file bytes (recorded outside the JSON itself — commit note, release artifact digest, or signed manifest). Self-hashing the same file you just wrote is not trusted provenance.
4. A candidate Agent Insight report + HTML produced from the **same** Claude session corpus (or an agreed shared fixture corpus).

### Commands

```bash
# Record the out-of-band digest once at capture time (example):
shasum -a 256 /path/to/claude-2.1.206-reference/report.json

agent-insight parity compare \
  --reference /path/to/claude-2.1.206-reference/report.json \
  --reference-sha256 <independently-recorded-sha256> \
  --candidate ~/.agent-insight/usage-data/report.json \
  --candidate-html ~/.agent-insight/usage-data/report.html \
  --output docs/parity/artifacts/comparison.json \
  --blind-output docs/parity/artifacts/semantic-review.json \
  --seed <private-random-seed>

# After a human fills each item.rating with A, B, or tie:
agent-insight parity evaluate \
  --review docs/parity/artifacts/semantic-review.json \
  --seed <same-private-random-seed> \
  --output docs/parity/artifacts/semantic-result.json
```

An optional compatibility evaluation may report:

- `acceptance.trustedReference === true`
- `acceptance.structuralParity === true` (`structural.score === 1`)
- `acceptance.deterministicCorrectness === true` (`deterministic.score === 1`)
- Blind semantic tie-or-better ≥ 0.8 (`parity evaluate`)

`acceptance.overall === true` means **that optional evaluation** passed. It does **not** mean Agent Insight is complete or shippable, and `false` / absence of a reference does **not** mean the product is incomplete.

Store comparison JSON under `docs/parity/artifacts/` only when produced from a trusted reference. Do not commit fabricated reference JSON. Do not invent reference HTML/JSON to “green” an optional evaluation.

Local Claude CLI version, login state, and whether a 2.1.206 reference exists on a given machine are **not** project blockers.

## Development wiring smoke (isolated temp project/home)

Use disposable directories so user integration files are never overwritten. This proves install + CLI resume wiring; it is not a product certification certificate.

```bash
ROOT="$(mktemp -d /tmp/agent-insight-smoke-XXXX)"
export HOME="$ROOT/home"
mkdir -p "$HOME" "$ROOT/project"
cd "$ROOT/project"
git init -q

# Install into the isolated home/project only (scope flags as supported):
npm link   # or: node /path/to/insight/bin/agent-insight.mjs install --agent <host> ...

# For each host: Claude Code, Codex, Cursor, OpenCode, Pi
# 1) install slash command / skill into $ROOT only
# 2) drive prepare → semantic next → fail/continue → finalize via CLI
# 3) leave the exposed task without ingest/fail; call semantic next again and confirm the same frozen task resumes
# 4) confirm timestamped HTML + report.json under the isolated data root
```

Evidence to retain per host (when available):

- install path under `$ROOT` (not `~/.claude`, `~/.codex`, etc. of the real user)
- invocation transcript or command log
- frozen-task resume proof: two consecutive `semantic next` calls return the same task id before ingest/fail
- final `report.html` / `report.json` paths and `parity.dataStatus` / `extensions.userAudit.status`

### Captured wiring evidence (2026-07-12)

Evidence: [`docs/parity/artifacts/2026-07-12-isolated-smoke/`](artifacts/2026-07-12-isolated-smoke/).

- Installed fused bridges for all five hosts into an isolated project root (`claude`, `codex`, `cursor`, `opencode`, `pi`).
- Under the same isolated `HOME`, proved **frozen-task resume**: `semantic next` exposed task A, a second `semantic next` with no ingest/fail returned the same task A, then `semantic fail` → `semantic next` continue → `semantic finalize`.
- Final report landed only under `$HOME/.agent-insight/usage-data/` inside the temp tree.

In-host UI / REPL slash invoke across the five hosts remains an **optional** manual check. It is not a release gate.

## Summary

**Done for product (code / fixtures / wiring):**

- Claude-compatible baseline + cross-agent Host/Source analysis + user audit.
- Extension fields and trailing audit HTML headings excluded from Claude baseline scoring.
- Partial source coverage and incomplete audit extensions still produce a usable baseline with honest coverage notes.
- Isolated five-host **install** + isolated CLI **frozen-task resume** / fail / finalize evidence under `docs/parity/artifacts/2026-07-12-isolated-smoke/`.

**Optional (not product incomplete if skipped):**

- Independently captured Claude Code 2.1.206 reference with out-of-band SHA-256.
- Live structural/deterministic score 1 and blind semantic evaluate against that reference.
- Live five-host in-host UI slash-command invoke matrix.


### Evidence-first sparse samples (intentional semantic difference)

Agent Insight preserves the eight aggregate section shapes while replacing Claude's
minimum item quotas with evidence-supported upper bounds: project areas 0–5,
impressive workflows 0–3, friction categories 0–3 (each present category needs
1–2 real examples), each suggestions array 0–3, and opportunities 0–3.
No observed friction is a valid `categories: []` result. Required prose must
distinguish no observed issue from insufficient evidence; a single successful
session must not acquire invented problems or recommendations to fill a quota.
Durable instruction additions require at least two distinct evidence sessions,
so a one-session sample leaves that array empty. At a Glance and the host summary
can explicitly say no improvement is justified. The host summary reports up to
three supported findings, with no requirement to create one. Their evidence
posture and limitations remain visible in summaries and the host handoff.

Validation still rejects missing/non-array fields, excess items, empty examples
inside a claimed friction category, missing/unknown evidence, and malformed
prose. Evidence references resolve canonical IDs first; ambiguous source-session
aliases fail rather than silently citing another session. These changes do not
relax host/model isolation, section completeness, or evidence verification.

### Native source evidence boundaries

`test/authorship.test.mjs` preserves ordinary instruction-file references,
quoted machine tags, skill drafts, and authored whitespace while excluding
recognized machine envelopes and metadata. Its quotation regression rejects
the whitespace-normalized text that the previous filter invented.

`test/source-projection.test.mjs` covers native tool call/result identity and
status without payloads; Pi session headers, active branches, and terminal
assistant events; OpenCode synthetic/ignored parts and terminal events; and
Cursor timestamp transport boundaries. `test/tool-context-protocol.test.mjs`
checks direct/chunk prompt propagation, metadata allowlists, user-evidence exclusion,
and refusal to treat machine events as dialogue quotations.

Report delivery tests retain described evidence even without a quotation,
so a failed execution record and a conflicting assistant claim can both be
inspected at their own message indexes. These regressions establish source and
delivery behavior, not that a model's interpretation is always correct.

### Audit interpretation and evidence coverage

User-audit v3 and semantic-run v5 retain role-labeled interaction context for
direct and chunked audits while permitting only genuine user messages as audit
quotations. `test/audit-context.test.mjs` checks long assistant chunks, bounded
prompts, stable resume, sanitized tool status, and derived baseline attribution.

`test/audit-evidence-counts.test.mjs` checks bidirectional quote/locator support,
deduplicated message/session counts, one-instance versus repeated-pattern
postures, and severity ordering independent of reference volume. Recurrence
cannot be established by adding unrelated indexes or reusing one message's
chunks. Filler-only source messages retain their non-workflow eligibility
through retained excerpts and rolling summaries; quotation provenance remains
separate from the correctness of a model's interpretation.

Report delivery checks cover no manufactured action card for an incomplete
audit, qualified summaries and handoffs, and evidence coverage counts rather
than model-supplied real-world frequency. Conservative language checks for
absolute claims are heuristics, not a semantic correctness guarantee.

### Navigable evidence and incomplete sections

`test/report-evidence.test.mjs` checks HTML and Markdown citations against
retained session evidence, including canonical/native identity conflicts,
ambiguous aliases, missing references, empty grounding and descriptions with no
quotation. Each generated target is unique and each link resolves. Baseline
citations navigate to session evidence without inventing a claim-to-message
mapping; an audit citation only links directly when a retained quotation and
message locator match. Message indexes refer to projected conversation messages,
not physical JSONL line numbers.

The same delivery regressions check failed-section placeholders and coverage
labels, separate from completed sections with zero supported findings. A failed
overview does not manufacture a priority action. These tests establish report
navigation and state presentation, not browser layout acceptance or semantic
correctness of the generated conclusions.

### Preserving assessment context

`test/audit-assessment-context.test.mjs` checks that histories with different
causal context remain distinguishable after session validation and aggregation,
including when findings and strengths are empty. It covers bounded summaries,
legacy chunk-summary fallback, explicit unknown state, final-session inheritance,
and rolling aggregate carry without reopening source text. Context-only text
cannot supply a new user quotation. Runtime checks exercise long interactions,
the existing 30,000-character prompt limit and stable resume boundaries.

Report delivery tests retain an assessed final summary as analysis context,
without a quotation block or invented message link; unknown or absent context
does not manufacture an explanation or a priority change. These are information
preservation checks. Semantic review must separately assess whether titles,
explanations and recommendations each stay within the source evidence, including
the difference between assistant claims and verified execution consequences.

### Neutral workflow evidence and combined support

`test/audit-workflow-evidence.test.mjs` checks that late multi-step requests can
reach automation analysis with no findings or strengths, including real direct
and chunked session ingestion and rolling aggregate evidence validation. It
rejects assistant text, derived summaries, unexposed fragments and uncarried
quotations as user evidence. Near-limit neutral channels remain within prompt
budgets; oversized channels fail explicitly instead of truncating quotations.
Repeated fragments of one source message cannot count as separate messages.

`test/audit-evidence-merge.test.mjs` checks that root-cause and intent deduplication
preserve support from multiple sessions, including more than five distinct
quotations. Canonical aliases and duplicate citations do not inflate coverage;
combining evidence does not upgrade severity or evidence posture. These checks
do not establish that two model-assigned equivalence keys describe the same
behavior.

Semantic acceptance must separately contrast independent task requests with
corrections or restatements of one task and quoted examples. It must inspect
both the recommendation and its copyable draft for scope, approval boundaries,
and the difference between requested work and verified execution. Controlled
model probes support conclusions about their supplied examples only, not real
user recurrence or native host integration.

### CLI arguments and host handoff

`test/cli-flags.test.mjs` exercises the public CLI with isolated local data:
missing or blank values and unknown options fail before side effects; explicit
false does not broaden the selected history or authorize replacing an installed
bridge. Inline paths and model identities containing `=` remain intact through
preparation and owner checks. Copyable continuation commands must preserve the
exact argument values under shell parsing. `test/cli-next-command.test.mjs`
executes the printed continuation command with space, quote and equals-sign
model identities and verifies that the same run owner is accepted.

`test/pi-integration-behavior.test.mjs` installs and executes the generated Pi
entry against a controlled Extension API. It covers idle delivery, follow-up
queuing during an active turn, cancellation, preparation failures, and a void
handoff API whose asynchronous failure bypasses the command's catch block. The
prepared run ID and pending state must be visible before handoff. These tests
run without an installed Pi package or a live model and retain the Node 20
minimum; local official-runtime probes provide additional API evidence without
claiming a full native-host report run.

### Concurrent commands and recoverable output

`test/run-lock.test.mjs` and `test/run-concurrency.test.mjs` exercise real child
processes, live-owner exclusion, crash recovery, competing reapers, initialized
owner publication, and accepted aggregate results surviving concurrent submits.
Busy submissions remain available for retry. These checks use local disposable
files, not real user history or a distributed filesystem.

`test/cli-semantic-transaction.test.mjs` checks that exclusion covers the CLI's
submission read, acceptance, and cleanup, and that cleanup failures do not hide
an accepted result. `test/report-publication.test.mjs` covers preparation and
commit failures, repeated recovery failures, partial backup cleanup after a
completed rollback, interrupted child processes, competing publishers, and
independent historical HTML files created in the same second.

Report transactions provide writer exclusion and recovery on the next
publication attempt. They do not promise a group-atomic read across the latest
files, distributed locking, or power-loss durability through filesystem sync.

### Source selection and current read coverage

`test/session-deduplication.test.mjs` checks complete-copy preference, retained
partial-copy coverage, duplicate project metadata, repeated explicit paths, and
separate identities across sources. `test/parse-record-boundaries.test.mjs`
checks exact-limit files with and without a final newline, trailing whitespace,
the first excess record, UTF-8/chunk boundaries, and existing byte/record limits.

`test/semantic-scope.test.mjs` exercises sources becoming incomplete or moving
outside the requested dates after collection, inclusive rolling boundaries,
future timestamps, custom UTC dates, and the selection anchor surviving resumed
finalization. `test/report-time-scope.test.mjs` checks that HTML and Markdown
distinguish requested scope from observed session dates and do not invent an
anchor for legacy reports. These checks use synthetic local records; they do
not establish comprehensive native-host or semantic-model acceptance.

### Large derived inputs and aggregate recovery

`test/aggregate-budget.test.mjs` checks that large validated session facets,
all twenty evidence items, escaped metrics, and completed report sections can
reach all eight baseline sections through bounded requests. It reconstructs
the derived data from the serialized fragments, checks Unicode boundaries,
and exercises accepted carry, repeated `next`, and real result ingestion.
Metric fragments retain the canonical session evidence already carried;
they do not create session identities.

`test/audit-aggregate-budget.test.mjs` exercises oversized session audits and
carry-dependent batches, using frozen plans across `next`, resume, ingestion,
and failure. The evidence checks distinguish current fragments and retained
carry from unseen quotations, including different excerpts of the same message.
They also preserve original message eligibility and assessment context.
Indivisible metadata or carry that cannot fit remains an explicit failure,
with stored analysis available and the remaining report still finalizable.

`test/semantic-run-complete.test.mjs` follows twenty distinct validated audit
findings through multiple batches into a completed fused report and checks that
their evidence still represents one source session. Legacy checkpoints keep
their original aggregate projection and grouping. These synthetic protocol
and runtime checks establish bounded data handling and recovery, not general
semantic accuracy or native-host acceptance.

## Session-count and context-metric validation

Project-area counts are native safe integers bounded below by distinct canonical citations and above by all completed analyzed sessions. The bound survives rolling synthesis even when its representative citation list retains fewer sessions. `test/aggregate-counts.test.mjs` covers invalid types, impossible counts, canonical alias deduplication, and a 25-session pipeline with only 20 retained references; rejected submissions preserve the pending task.

`test/report-context-counts.test.mjs` covers canonical/native-ID collisions, ambiguous and missing references, unknown and partially recorded metrics, explicit zero, timestamp fallback, and model-estimate labels in HTML/Markdown across both locales and the Claude profile. Whole-session context is not attributed as the cost of an individual habit. These checks validate numeric and identity boundaries, not the model’s semantic grouping.

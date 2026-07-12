# Claude baseline parity acceptance

This document records how to certify that Agent Insight fused extensions do
**not** break Claude Code 2.1.206 baseline parity, and how to collect live-host
smoke evidence. It deliberately separates:

| Kind | What it proves | What it does **not** prove |
| --- | --- | --- |
| Gate / fixture tests (`npm test`) | Extension schema and HTML headings are excluded from baseline scoring; partial source/extension failure still yields a usable baseline with honest coverage | Live parity against Claude Code |
| Self-comparison of two Agent Insight reports | Harness wiring and HTML contract checks | Real Claude parity (forbidden as certification) |
| Trusted independent reference compare | Structural + deterministic gates against Claude 2.1.206 | Semantic quality (still needs blind review) |
| Live host smoke | Install / invoke / interrupt / finalize on real hosts | Score `1` without a trusted reference |

## Baseline scoring exclusions (always in code)

`compareParityReports` scores only the Claude baseline surface:

- Required structural paths: `parity.*` baseline fields, `insights.*` deterministic metrics, and `semantic.sections.*` aggregate sections.
- Deterministic field equality under `insights.*`.
- HTML contract for Claude headings, TOC, metrics, and section order.

Explicitly **excluded** from baseline scoring:

- Report schema path `extensions` (including `extensions.userAudit` and any peer extension).
- Trailing Agent Insight HTML headings: Three hard truths, All findings, Habits that undercut you, Habits worth keeping, Automation candidates, One highest-leverage change, Evidence index, Read coverage.

Those headings may appear only as a suffix after the Claude baseline `h2` sequence. Interleaving them into the baseline order fails structural parity.

Blind semantic review bundles cover the eight Claude aggregate sections only. Extension audit content must not appear in the blinded payload.

## Gate tests (fixture-labeled, not live certification)

```bash
npm run check
npm test
```

Parity gate coverage lives in:

- `test/parity.test.mjs` — extension schema/HTML exclusion; incomplete-extension baseline still scores structural/deterministic pass on fixtures
- `test/report-html-parity.test.mjs` — rendered fused HTML keeps baseline order; partial source + incomplete audit remains usable
- `test/semantic-run-complete.test.mjs` — end-to-end audit failure still finalizes Claude baseline sections

These tests must never be summarized as “parity score 1 against Claude.”

## Independent Claude Code 2.1.206 reference (required for live structural/deterministic certification)

### Prerequisites

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

### Commands (when the reference exists)

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

Machine acceptance requires:

- `acceptance.trustedReference === true`
- `acceptance.structuralParity === true` (`structural.score === 1`)
- `acceptance.deterministicCorrectness === true` (`deterministic.score === 1`)
- Blind semantic tie-or-better ≥ 0.8 (`parity evaluate`)

Store comparison JSON under `docs/parity/artifacts/` only when produced from a trusted reference. Do not commit fabricated reference JSON.

### Current blocker (recorded 2026-07-12)

| Check | Result |
| --- | --- |
| In-repo independent Claude 2.1.206 reference artifact | **Absent** — no provenance-bearing `report.json` / digest under the repository |
| Local `claude --version` | **2.1.207** (not 2.1.206) |
| Out-of-band SHA-256 for a 2.1.206 capture | **Unavailable** |
| Trusted structural + deterministic live scores | **Blocked** — cannot claim score 1 |
| Blind semantic live review | **Blocked** on the same prerequisite |

Until a 2.1.206 reference with an out-of-band digest is obtained, keep the exclusion code and gate tests; do not invent reference HTML/JSON.

## Live host smoke (isolated temp project/home)

Use disposable directories so user integration files are never overwritten.

```bash
ROOT="$(mktemp -d /tmp/agent-insight-smoke-XXXX)"
export HOME="$ROOT/home"
mkdir -p "$HOME" "$ROOT/project"
cd "$ROOT/project"
git init -q

# Install into the isolated home/project only (scope flags as supported):
npm link   # or: node /path/to/insight/bin/agent-insight.mjs install --host <host> ...

# For each host: Claude Code, Codex, Cursor, OpenCode, Pi
# 1) install slash command / skill into $ROOT only
# 2) invoke /agent-insights (or host equivalent)
# 3) interrupt mid-run; resume with semantic next
# 4) finalize and confirm timestamped HTML + report.json under the isolated data root
```

Evidence to retain per host (when available):

- install path under `$ROOT` (not `~/.claude`, `~/.codex`, etc. of the real user)
- invocation transcript or command log
- interruption + resume run id
- final `report.html` / `report.json` paths and `parity.dataStatus` / `extensions.userAudit.status`

### Current blocker (recorded 2026-07-12)

Hosts present on this machine (`claude`, `codex`, `opencode`, `pi`, `cursor`) were **not** exercised for Issue #8 smoke because:

1. No trusted Claude 2.1.206 reference corpus is available to pair with live reports for certification.
2. Live `/insights` or fused `/agent-insights` runs would write semantic model output and must not be claimed as parity evidence without the reference gate above.
3. Smoke must use isolated `HOME`/project roots; a full five-host matrix was deferred rather than risk mutating the operator’s real integration files.

When unblocked, append dated command logs and artifact paths under `docs/parity/artifacts/` and link them from this section without rewriting history of earlier blockers.

## Honest summary for Issue #8

**Certified in-repo (gate tests):**

- Extension fields and trailing audit HTML headings are excluded from Claude baseline structural / deterministic / blind-semantic scoring.
- Extension headings must not break required Claude HTML order.
- Partial source coverage and incomplete audit extensions still produce a usable baseline report with honest coverage notes.

**Not certified (blocked):**

- Independently captured Claude Code 2.1.206 reference with out-of-band SHA-256.
- Live structural/deterministic score 1 against that reference.
- Blind semantic tie-or-better against that reference.
- Live five-host install/invoke/interrupt/finalize smoke matrix.

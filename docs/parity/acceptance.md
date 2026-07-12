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
- Trailing Agent Insight HTML headings: Three hard truths, All findings, Habits that undercut you, Habits worth keeping, Automation candidates, One highest-leverage change, Evidence index, Read coverage.

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

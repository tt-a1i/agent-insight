# Isolated CLI smoke evidence — 2026-07-12

## Role

Development and host-wiring evidence only. This artifact is **not** a product
certification certificate and is **not** required to claim Agent Insight feature
completion.

## Scope

- Isolated ROOT: `/tmp/agent-insight-smoke-s5dS` (temp; not retained after capture)
- `HOME` pointed at `$ROOT/home` so no real user integration files were written.
- Host slash-command UI invoke was **not** exercised (optional, non-blocking).
- This artifact covers isolated five-host **install** plus isolated CLI **frozen-task resume**, then fail/continue/finalize.

## Five-host install paths (project)

```text
$ROOT/project/.agents/skills/agent-insights/SKILL.md
$ROOT/project/.claude/commands/agent-insights.md
$ROOT/project/.cursor/commands/agent-insights.md
$ROOT/project/.opencode/commands/agent-insights.md
$ROOT/project/.pi/extensions/agent-insights.ts
```

## Frozen-task resume (required shape)

```text
prepare
→ semantic next          # expose task A
→ semantic next          # no ingest/fail; must return the same frozen task A
→ semantic fail          # after resume proof
→ semantic next          # continue/degrade
→ semantic finalize
```

Observed:

- prepare runId: `36c74e72-477a-4a3a-b17a-32a088acf2a7`
- next #1 exposed `session:471d24e3901bacbbe6aea609` (`session_facet`)
- next #2 returned the **same** id/kind with `resumed: true` (no ingest/fail between calls)
- fail reason after resume proof: `analyzer_failure`
- next after fail: `kind: complete`
- finalize HTML: `$HOME/.agent-insight/usage-data/report-2026-07-12-052341.html`

## report.json status excerpt

```json
{
  "parity": {
    "dataStatus": "partial",
    "structuralStatus": "partial"
  },
  "extensions": {
    "userAudit": {
      "status": "incomplete",
      "failureReason": "no_semantic_evidence"
    }
  }
}
```

## Explicit non-claims

- Not Claude 2.1.206 reference parity (optional research tooling, not a product gate).
- Not in-host UI `/agent-insights` invoke for all five hosts (optional; non-blocking for product completion).
- Earlier mislabeled `fail → complete` path is **not** what this resume section proves; resume proof is the repeated `next` returning the same frozen task.

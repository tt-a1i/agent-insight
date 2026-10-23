# Task Spec Skeleton

Use this optional template when a task needs explicit scope, context, or acceptance criteria. Choose the fields that help the task; short messages or keyword counts alone do not show that a specification is missing.

## Skeleton

```
Goal: <one sentence — what the agent must deliver>

Current state:
  - Branch: <branch> @ <commit> (<commit subject>)
  - Dirty: <list files already changed, do not rewrite>
  - Already done: <what is complete and should not be touched>

Gaps (not yet done):
  - <gap 1>
  - <gap 2>

Execution order:
  1. <first step>
  2. <second step>
  3. <third step>

Completion criteria:
  - [ ] <observable check 1>
  - [ ] <observable check 2>
  - [ ] <observable check 3>

Constraints:
  - <what not to do>
  - <what not to change>
  - <style/convention to follow>
```

## Why each field matters

| Field | What it clarifies |
|------|------------------------------|
| Goal | The expected endpoint |
| Current state | What is already complete |
| Gaps | What remains to do |
| Execution order | Dependencies or an intentional order |
| Completion criteria | What evidence will establish completion |
| Constraints | Boundaries the agent should respect |

## Usage tips

- Keep the goal to one sentence. If you need three, split the task.
- Current state should list exact file paths — the agent will re-read them anyway.
- Execution order does not need to be exhaustive; 3-7 steps is enough for most tasks.
- Completion criteria must be observable: a test passes, a grep returns zero, a file exists, a command exits 0.
- Constraints are negative space: "don't push", "don't change the visual skin", "don't add dependencies".

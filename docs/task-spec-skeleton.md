# Task Spec Skeleton

A high-spec task spec reduces clarification density and correction rate — the two most common efficiency signals flagged by Agent Insight. Fill this skeleton before handing a task to any coding agent.

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

| Field | Efficiency signal it prevents |
|------|------------------------------|
| Goal | `clarification_density` — agent knows the endpoint |
| Current state | `correction_rate` — agent does not redo finished work |
| Gaps | `clarification_density` — agent knows what remains |
| Execution order | `direction_churn` — agent follows a path, not guessing |
| Completion criteria | `verification_gap` — agent has a checklist to verify against |
| Constraints | `correction_rate` — agent avoids forbidden actions |

## Usage tips

- Keep the goal to one sentence. If you need three, split the task.
- Current state should list exact file paths — the agent will re-read them anyway.
- Execution order does not need to be exhaustive; 3-7 steps is enough for most tasks.
- Completion criteria must be observable: a test passes, a grep returns zero, a file exists, a command exits 0.
- Constraints are negative space: "don't push", "don't change the visual skin", "don't add dependencies".

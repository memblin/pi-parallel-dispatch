---
name: team-dispatch
description: Coordinate multiple pi worker agents (a "team") for parallel work — research, review, implementation of independent pieces. Use when a task benefits from several agents working concurrently with separate contexts (e.g. parallel code review, competing hypotheses, independent modules). Not for sequential or same-file work.
---

# Team dispatch

You can run a **team** of worker agents. Each worker is a full pi session with
its own context window. In tmux you see each worker in its own pane and can
click into a pane to talk to it directly. Outside tmux workers run as
background processes with log files.

Workers do **not** see your conversation. Every task must be self-contained:
paths, context, constraints, and the expected deliverable.

## When to use a team

Good: independent research angles, parallel review (security/perf/tests),
separate modules, competing hypotheses, fan-out search.
Bad: sequential steps, edits to the same files, tightly coupled work — do
those yourself or with one worker.

Size: 2–5 workers is the sweet spot. Split the work so each worker owns
different files/parts and they cannot conflict.

## Workflow

1. **Decompose** the work into independent pieces.
2. **Spawn** each piece with `team_spawn`:
   - pick a short unique `name` (e.g. `security-review`, `fix-auth`).
   - write a complete `task` (the worker sees only this + project context).
   - set `model` per task: a cheaper/faster model for search, reading, and
     narrow mechanical work; the lead's model (omit `model`) or a stronger
     one for implementation, design, and debugging.
3. **Let workers run.** You are woken automatically when a worker goes idle,
   finishes (`team_done`), or asks something. Answer questions with
   `team_send`; give new instructions the same way.
4. **Check** with `team_status` (roster) and `team_log` (worker output) when
   you need to look at progress.
5. **Collect** with `team_collect` (optionally `wait` seconds). Synthesize
   the results for the user.
6. **Clean up**: `team_dismiss` for stuck/finished workers you no longer
   need, `team_cleanup` at the end of the team's life.

## Model choice guide

- Reading/searching/listing/counting, log triage → cheap fast model
  (e.g. a haiku-class model) with low thinking.
- Implementation, refactoring, debugging, design, security review →
  inherit the lead's model (omit `model`) or an explicit stronger model.
- Use `thinking` to tune depth (e.g. `low` for mechanical, `high` for hard
  debugging) only when the task clearly warrants it.

## Rules

- Never spawn more workers than `team_spawn` allows — dismiss first.
- One team per session. Workers cannot spawn their own teams.
- If a worker fails or stalls: check `team_log`, either `team_send` a
  correction (pane workers) or `team_dismiss` it and respawn.
- When the user asks for results, `team_collect` and synthesize — do not
  just report worker states.

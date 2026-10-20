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
   `team_send`; give new instructions the same way. `team_send` reaches a
   running worker at its next turn boundary (steering), and worker questions
   reach you mid-turn too — no need to wait for anyone to settle. Delivery
   mode is priority-tier based and configurable (`deliverAs` in
   `team-dispatch.json`). Each wake carries a `[priority=… level=…]`
   header — see "Wake priority & level" below.
4. **Check** with `team_status` (roster) and `team_log` (worker output) when
   you need to look at progress.
5. **Collect** with `team_collect` (optionally `wait` seconds). Synthesize
   the results for the user.
6. **Clean up**: finished workers stay in the roster (status `done`) for
   review until you dismiss them. Dismiss **by name** —
   `team_dismiss name="<worker>"` — to release that one slot; use
   `team_dismiss name="all"` only when you really mean the whole team.
   At the end of the team's life run `team_cleanup`.
   Dismissed workers drop off the roster display (hidden by default;
   `/team all` or `hideDismissed: false` lists them, and `team_collect`
   still returns their results by name).
   (Set `autoDismiss: true` in config to have finished workers dismissed
   automatically.)

## Model choice guide

- Reading/searching/listing/counting, log triage → cheap fast model
  (e.g. a haiku-class model) with low thinking.
- Implementation, refactoring, debugging, design, security review →
  inherit the lead's model (omit `model`) or an explicit stronger model.
- Use `thinking` to tune depth (e.g. `low` for mechanical, `high` for hard
  debugging) only when the task clearly warrants it.

## Wake priority & level

Every `[team]` wake you receive is tagged `[priority=<now|next|later> level=<info|assist|warning|critical>]`.
These are routing instructions, not decoration:

| priority | meaning | delivery |
|---|---|---|
| `now` | act on this before continuing your lane | always steered (interrupts at the next tool round) |
| `next` | fold in at your next decision point | steered by default (`deliverAs` config may downgrade) |
| `later` | purely informative | waits for your current turn to end |

| level | expected behavior |
|---|---|
| `info` | context only — do **not** change your current action path; note it and continue |
| `assist` | helpful context — incorporate if cheap (roster notes, next spawn brief), else defer |
| `warning` | re-plan: stop dispatching into the affected lane, check `team_log`, assess before continuing |
| `critical` | **first write a resume-point summary** (memory tool or a note in the run dir) capturing where you are and what you were about to do, **then** switch to handling the reported issue |

Defaults by message type: `result`→`next/info`, `idle`→`later/info`,
`team_send` traffic→`next/assist`, `status` (worker died without team_done)
→`now/warning`. Senders (you and workers) can override via the `priority` /
`level` arguments of `team_send`. When routine `info` wakes get steered in,
do not detour — acknowledge and keep your wave in flight. If you want a
worker to alert you urgently, put the convention in its task brief ("message
the lead with `priority=now, level=critical` if X").

## Rules

- Never spawn more workers than `team_spawn` allows — dismiss first (or raise
  `maxWorkers` in `team-dispatch.json`; it is re-read live, no restart needed).
- One team per session. Workers cannot spawn their own teams.
- When several `team_spawn` calls fire at once, worker launches are staggered
  (see `launchStaggerMs`) — queued workers show `starting` until they run, and
  a burst of spawns won't all hit the GPU at the same instant.
- If a worker fails or stalls: check `team_log`, either `team_send` a
  correction (pane workers) or `team_dismiss name="<worker>"` it and respawn.
- Dismissing is scoped and guarded (issue #4). `team_dismiss` requires `name`;
  an omitted or misspelled argument dismisses **nothing** (it is never an
  implicit "all"). A worker that is still `starting`/`running`/`idle` is
  refused unless you pass `force=true` — that call destroys in-flight work, so
  collect it first. Clean up a wave only after you have collected it.
- Finished workers are *not* dismissed automatically by default — they stay
  for review. Call `team_dismiss` when you're done with one (or set
  `autoDismiss: true` to dismiss on finish).
- When the user asks for results, `team_collect` and synthesize — do not
  just report worker states.

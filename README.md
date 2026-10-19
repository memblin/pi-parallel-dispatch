# pi-parallel-dispatch

Agent **teams** for [pi](https://pi.dev): let a lead pi session spawn multiple
**named worker agents** that run in parallel, each with its own context window
and model, and coordinate through an inbox-based messaging system.

Inspired by (and mechanically modeled on) Claude Code's agent-teams feature.

## What you get

- `team_spawn name task [model]` — spawn a worker for a self-contained task.
  Workers appear **in tmux panes next to you** when pi runs inside tmux
  (splits in your own window), in a **dedicated "swarm" tmux session** when pi
  runs outside tmux but tmux is available (attach with the printed
  `tmux -L pi-team-<runId> attach -t pi-team`), and as **background processes
  with log files** when tmux isn't available.
- **Per-worker model choice** at spawn time (defaults to the lead's current
  model). No automatic routing — the lead decides.
- **Messaging**: lead ↔ worker messages via JSONL inboxes. Workers are woken
  by new messages; the lead is woken when a worker finishes, goes idle, or asks
  a question. `team_send` for live instructions, `team_inbox` on the worker side.
- **Live roster**: a widget under the editor plus `/team` and `team_status`
  showing each worker's state (running / idle / done / failed / dismissed),
  model, and last activity.
- **Result collection**: `team_collect` waits for workers and returns their
  `team_done` summaries (or last output as fallback).
- **Observability**: `team_log` / `/team-log <name>` shows a pane capture (tmux
  workers) or rendered event stream (process workers).
- **Persistence**: worker sessions are stored under the run directory
  (`~/.pi/agent/teams/<runId>/sessions/`) so they can be inspected or resumed.
  A restarted lead session re-attaches to its live team.
- **No nested teams**: workers cannot spawn teams (the lead extension
  activates only in lead sessions).
- `team_dismiss` to stop a worker, `team_cleanup` to remove the run.

## Install

```bash
# GitHub
pi install git:github.com/memblin/pi-parallel-dispatch

# TKC Labs Internal
pi install git:git.tkclabs.io/memblin/pi-parallel-dispatch

# or from a local clone:
pi install /path/to/pi-parallel-dispatch
```

The package contributes one skill (`team-dispatch`) that teaches the lead when
and how to use teams; the lead does not need to memorize the tools.

## Usage

Just ask:

```
Spin up a team: two security reviewers for the auth code in src/auth/,
and one researcher to find usages of the old token API. Use a cheap model
for the researcher.
```

The lead decomposes the work, calls `team_spawn` per piece with a self-contained
task and a fitting model, then `team_collect`s the results and synthesizes
them. You can also drive it directly:

- **You**: `/team` — roster, backend, run dir
- **You**: `/team-log researcher` — worker output
- **You**: click into a worker's tmux pane to talk to it directly (it's a
  full pi session)
- **Lead tools**: `team_spawn`, `team_status`, `team_send`, `team_collect`,
  `team_log`, `team_dismiss`, `team_cleanup`
- **Worker tools**: `team_inbox`, `team_send`, `team_done`

## Tmux modes

| Mode | When | What you see |
|---|---|---|
| Lead window | pi runs inside tmux, `backend: auto/tmux` | Workers split into panes in your window; lead pane keeps `leadPanePct` width |
| Swarm session | pi runs outside tmux (or `backend: swarm`), tmux installed | Dedicated `pi-team` session on a **private per-run socket**, `team-view` window; attach hint printed |
| Background | no tmux, or `backend: process` | Detached `pi --mode json -p` processes; logs under `<runDir>/logs/` |

Pane layout follows Claude Code: the first worker splits the lead pane
horizontally (70/30), further workers split existing worker panes
alternating direction, then the layout is rebalanced. Crashed workers leave an
inspectable pane (`remain-on-exit failed`) instead of vanishing.

Task text is **never put on the tmux command line** — it lives in a task file
the worker reads, which avoids the shell-escaping bugs that plague naive
`tmux send-keys` approaches.

## Tmux safety (shared machines)

Teams never touch tmux state that doesn't belong to the team:

- **Every tmux invocation is socket-scoped.** In-window mode always uses
  `-S <socket from the lead's own $TMUX>`; swarm mode always uses `-L
  pi-team-<runId>` (a private socket ⇒ a separate tmux server). The lead's
  socket is never guessed: if it can't be derived from `$TMUX`, the backend
  **fails closed** instead of falling back to the default socket, so unrelated
  sessions (including other users' work on shared machines) are unreachable.
- **Swarm sockets are per run**, not per user default: each run gets its own
  tmux server; a stale swarm from an old run can't be picked up by a new one.
  tmux creates the socket file `0700`, so other local users cannot connect to
  it at all.
- **Pane kills are ownership-checked and process-based.** The window a pane
  was created in is stored in the run state; before stopping a worker the
  backend re-resolves the pane's current window and refuses on mismatch
  (guard against pane-id recycling after a tmux server restart). The worker
  is then stopped by killing the pane's **process** (same user, always
  permitted) and letting tmux reap the pane normally — never `kill-pane`.
- **No `capture-pane`, no pane titles.** Worker output (`team_log`,
  `/team-log`) is read from the worker's **persisted pi session file**, not
  from a terminal capture. Worker panes are labeled via per-pane border
  options — never `select-pane` — so spawning a worker doesn't change the
  active pane of your window.
- **Background workers don't inherit `$TMUX`/`$TMUX_PANE`**, so a worker's
  incidental `tmux` commands can't reach the lead's server through the
  inherited socket.

### Known tmux server crash bug (and how this package avoids it)

Some distro tmux builds (e.g. the `3.3a/next-3.4` snapshot shipped by
AlmaLinux/RHEL 10: `tmux-3.3a-13.20230918gitb202a2f.el10`) have a heap
bug: specific server-side commands **abort the entire tmux server**, killing
*every* session on it — including sessions of other programs and users:

- `capture-pane -p` (reproducible, 100% of calls),
- `kill-pane` on a pane that was started via `respawn-pane` or is dead,
- `kill-session`.

Each crash produces a core dump (`coredumpctl list` → `tmux: server`,
stack in `cmd_capture_pane_exec` / `free` → glibc abort). Because of this,
the package deliberately does **not** issue `capture-pane` or `kill-pane` at
all: logs come from session files, workers are stopped by process signals,
and the only `kill-session` that can occur targets `pi-team` on a run's
private socket (contained even on a broken build).

Known trade-off of the lead-window mode (inherited from Claude Code's design):
spawning workers **re-lays out the lead's own window** (splits, main-vertical,
lead-pane resize). If your window contains other manual panes you don't want
rearranged, use `"backend": "swarm"` or `"process"` — those leave the lead's
window untouched. A tmux server crash of any kind (by any program) kills all
sessions on that server — that is tmux architecture, not something a client
can protect against; keeping worker work on the lead's server to a minimum
(the commands above are read-only or pane-scoped) is the mitigation.

## Configuration

`~/.pi/agent/team-dispatch.json` (global) and `<project>/.pi/team-dispatch.json`
(project override):

```jsonc
{
  "backend": "auto",          // auto | tmux | swarm | process
  "maxWorkers": 4,            // 1..16
  "leadPanePct": 30,          // lead pane width in with-leader layout (10..70)
  "workerCommand": null,      // e.g. "/opt/pi" — pi binary for workers
  "killWorkersOnExit": true,  // kill workers + remove run when the lead session ends
  "staleAfterSec": 120,
  "logTailLines": 40,
  "pollMs": 2000
}
```

Run state lives in `~/.pi/agent/teams/<runId>/`:

```
config.json     # members + backends + panes/pids (the lead's view)
inboxes/        # one JSONL file per member
logs/           # process-worker JSONL streams + stderr
prompts/        # task file + filled bootstrap per worker
sessions/       # persisted pi sessions of the workers
```

## Development

```bash
npm install
npm test        # tsx --test test/*.test.ts
npm run typecheck
```

Manual smoke test (no tmux needed):

```bash
pi -e ./extensions/index.ts --approve -p \
  "Use team_spawn to spawn a worker 'calc' with the task: what is 6*7, answer with one number. Then team_collect with wait 120 and report the result."
```

## Design notes

- **Status is derived, not stored.** A worker is *done* when a `result`
  message reaches the lead inbox; *failed* when its pane or pid disappears
  without a result; *idle* after its last output; *running* otherwise.
- **Inboxes are append-only JSONL** with byte-cursor reads: no lost or
  duplicated messages across the 2s polls.
- **Workers are full pi sessions** (`--name <worker> --session-dir <runDir>/sessions`),
  loaded with a bootstrap system prompt and a small worker extension that
  provides `team_inbox`/`team_send`/`team_done` and injects inbox messages.
- **Model precedence**: explicit `model` at spawn → lead's current model.

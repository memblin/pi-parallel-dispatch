import type { ExecFn, ExecResult } from "./exec.js";
import { isNoSpaceError } from "./exec.js";
import { pidAlive } from "./process.js";
import { tmuxColor } from "./names.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Signal a process and, when possible, its whole process group.
 * Pane processes are same-user, so this is always permitted. A negative
 * pid targets the group (kills the worker's children too); if the pid is
 * not a group leader we fall back to signalling the process itself.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ESRCH" || code === "EPERM" || code === "EINVAL") {
			try {
				process.kill(pid, signal);
			} catch {
				/* already gone */
			}
		}
	}
}

/**
 * Tmux backend — a port of Claude Code's agent-team TmuxBackend.
 *
 * Two targeting modes:
 *
 *  1. "with-leader" (lead is inside tmux): worker panes are split into the
 *     lead's own window on the user's tmux server. All commands carry
 *     `-S <user-socket>` (the socket encoded in $TMUX) so we can never
 *     touch a different tmux server by accident.
 *
 *  2. "external swarm" (lead not inside tmux, or backend forced): a
 *     dedicated tmux session `pi-team` in a window `team-view`, running on
 *     a private per-run socket `pi-team-<runId>` (`-L`). A private socket
 *     means a separate tmux server that ignores the user's tmux config
 *     entirely, and each run gets its own server. The user views it with:
 *       tmux -L pi-team-<runId> attach -t pi-team
 *
 * Pane lifecycle (the trick that makes this robust):
 *  - panes are created running `cat` (a harmless placeholder),
 *  - the real worker command is started later via
 *      set-option -p -t <pane> remain-on-exit failed
 *      respawn-pane -k -t <pane> -- <command>
 *    so a crashed worker leaves an inspectable pane instead of vanishing,
 *    and the (long) worker command never passes through pane creation.
 *
 * Layout:
 *  - with-leader: first worker splits the lead pane horizontally (-h -l
 *    70%); further workers split the middle worker pane, alternating
 *    -v/-h by parity; after each spawn the window is rebalanced to
 *    main-vertical with the lead pane resized to `leadPanePct`%.
 *  - external: the first worker reuses the session's initial pane; further
 *    workers split by parity; the window is rebalanced to `tiled`.
 */

export const SWARM_SESSION = "pi-team";
export const SWARM_WINDOW = "team-view";

/**
 * Private tmux socket name for the external swarm session.
 *
 * Scoped per RUN (not per pid): the socket is unique per team run, so
 *  - a restarted lead process re-attaching to the same run finds the same
 *    socket and can see its still-running workers, and
 *  - a stale swarm left behind by an old run can never be picked up by a
 *    new run (new run id -> new socket -> new server).
 * The socket file is created by tmux with 0700 permissions, so other users
 * on the same machine cannot connect to it.
 */
export function swarmSocketName(runId: string): string {
	return `pi-team-${runId}`;
}

export function swarmAttachHint(runId: string): string {
	return `tmux -L ${swarmSocketName(runId)} attach -t ${SWARM_SESSION}`;
}

/**
 * Pure tmux argument builders. Targets are bare pane ids (%N) or
 * session:window targets — never session-qualified pane specs.
 */
type Args = readonly string[];
export const tmuxArgs = {
	hasSession: (session: string): Args => ["has-session", "-t", session],
	newSwarmSession: (session: string, window: string): Args => [
		"new-session",
		"-d",
		"-s",
		session,
		"-n",
		window,
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"cat",
	],
	listWindows: (session: string): Args => ["list-windows", "-t", session, "-F", "#{window_name}"],
	newSwarmWindow: (session: string, window: string): Args => [
		"new-window",
		"-t",
		session,
		"-n",
		window,
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"cat",
	],
	listPanes: (windowTarget: string): Args => ["list-panes", "-t", windowTarget, "-F", "#{pane_id}"],
	/** First worker: split lead pane horizontally, new pane takes 70% width. */
	splitFirstFromLead: (leadPaneId: string): Args => [
		"split-window",
		"-d",
		"-t",
		leadPaneId,
		"-h",
		"-l",
		"70%",
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"cat",
	],
	splitFromPane: (paneId: string, vertical: boolean): Args => [
		"split-window",
		"-d",
		"-t",
		paneId,
		vertical ? "-v" : "-h",
		"-P",
		"-F",
		"#{pane_id}",
		"--",
		"cat",
	],
	selectLayout: (windowTarget: string, layout: "main-vertical" | "tiled"): Args => [
		"select-layout",
		"-t",
		windowTarget,
		layout,
	],
	resizeLeadPane: (leadPaneId: string, pct: number): Args => [
		"resize-pane",
		"-t",
		leadPaneId,
		"-x",
		`${pct}%`,
	],
	setRemainOnExit: (paneId: string): Args => [
		"set-option",
		"-p",
		"-t",
		paneId,
		"remain-on-exit",
		"failed",
	],
	respawnPane: (paneId: string, command: string): Args => [
		"respawn-pane",
		"-k",
		"-t",
		paneId,
		"--",
		command,
	],
	paneBorderColor: (paneId: string, color: string): Args[] => [
		["set-option", "-p", "-t", paneId, "window-style", `bg=default,fg=${color}`],
		["set-option", "-p", "-t", paneId, "pane-border-style", `fg=${color}`],
		["set-option", "-p", "-t", paneId, "pane-active-border-style", `fg=${color}`],
	],
	/**
	 * Worker label rendered in the pane border. Uses a literal label (the
	 * worker name) rather than select-pane -T / #{pane_title}, because
	 * select-pane would make the worker pane the window's *active* pane —
	 * a visible side effect on the user's own window.
	 */
	paneBorderFormat: (paneId: string, color: string, label: string): Args => [
		"set-option",
		"-p",
		"-t",
		paneId,
		"pane-border-format",
		`#[fg=${color},bold] ${label} #[default]`,
	],
	enablePaneBorderStatus: (windowTarget: string): Args => [
		"set-option",
		"-w",
		"-t",
		windowTarget,
		"pane-border-status",
		"top",
	],
	// NOTE: intentionally no kill-pane / capture-pane builders.
	// On some tmux builds both commands corrupt the server heap (kill-pane
	// on respawned/dead panes; capture-pane -p), aborting the whole server
	// and every session on it. Workers are stopped via their process
	// (stopWorker) and viewed via their session files (src/transcript.ts).
	killSession: (session: string): Args => ["kill-session", "-t", session],
	paneIdOf: (paneTarget?: string): Args =>
		paneTarget
			? ["display-message", "-t", paneTarget, "-p", "#{pane_id}"]
			: ["display-message", "-p", "#{pane_id}"],
	paneDead: (paneId: string): Args => ["display-message", "-t", paneId, "-p", "#{pane_dead}"],
	panePid: (paneId: string): Args => ["display-message", "-t", paneId, "-p", "#{pane_pid}"],
	windowIdOf: (paneTarget?: string): Args =>
		paneTarget
			? ["display-message", "-t", paneTarget, "-p", "#{window_id}"]
			: ["display-message", "-p", "#{window_id}"],
};

export interface TmuxDetect {
	inside: boolean;
	/** tmux socket of the lead's server, from $TMUX ("path,pid" -> "path"). */
	userSocket?: string;
	/** Lead's pane id (%N). */
	leadPaneId?: string;
	/** Lead's window id (@N). */
	leadWindowId?: string;
}

export type SpawnResult = { ok: true; paneId: string; windowId?: string } | { ok: false; error: string };

const CONTROL_RE = /[\p{Cc}]/u;

export class TmuxBackend {
	/** Lead window id is stable for the life of the session; cache it. */
	private cachedLeadWindowId?: string;
	/** External swarm: initial pane gets the first worker. */
	private firstPaneUsedForExternal = false;

	/**
	 * @param runId team run id; names the private swarm socket so each run
	 *   gets its own tmux server and can never touch another run's swarm.
	 */
	constructor(
		private exec: ExecFn,
		private env: Record<string, string | undefined> = process.env,
		private leadPanePct = 30,
		private runId = "run",
	) {}

	/* ------------------------------------------------------------------ */
	/* Detection                                                          */
	/* ------------------------------------------------------------------ */

	private userSocket(): string | undefined {
		const tmuxEnv = this.env.TMUX;
		if (!tmuxEnv) return undefined;
		return tmuxEnv.split(",")[0] || undefined;
	}

	/** Socket flags for a command: user server (-S) or swarm server (-L). */
	private socketArgs(inside: boolean): string[] {
		if (inside) {
			const sock = this.userSocket();
			// Fail closed: never fall back to the default socket. A bare
			// `tmux` (no -S/-L) would address the user's default server and
			// could modify sessions/panes that have nothing to do with this
			// team — on a shared machine that is other people's work.
			if (!sock) {
				throw new Error("inside tmux but no tmux socket found in $TMUX; refusing to use the default socket");
			}
			return ["-S", sock];
		}
		return ["-L", swarmSocketName(this.runId)];
	}

	private run(inside: boolean, args: readonly string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
		return this.exec("tmux", [...this.socketArgs(inside), ...args], opts);
	}

	async isAvailable(): Promise<boolean> {
		const r = await this.exec("tmux", ["-V"]);
		return r.code === 0;
	}

	async detect(): Promise<TmuxDetect> {
		const inside = Boolean(this.env.TMUX);
		const detect: TmuxDetect = { inside, userSocket: this.userSocket() };
		if (!inside) return detect;
		detect.leadPaneId = this.env.TMUX_PANE || undefined;
		if (!detect.leadPaneId) {
			const r = await this.run(true, tmuxArgs.paneIdOf());
			if (r.code !== 0) return detect;
			detect.leadPaneId = r.stdout.trim() || undefined;
		}
		if (!this.cachedLeadWindowId && detect.leadPaneId) {
			const r = await this.run(true, tmuxArgs.windowIdOf(detect.leadPaneId));
			if (r.code === 0 && r.stdout.trim()) this.cachedLeadWindowId = r.stdout.trim();
		}
		detect.leadWindowId = this.cachedLeadWindowId;
		return detect;
	}

	/** The lead window may have been closed/recreated; drop the cache. */
	invalidateWindowCache(): void {
		this.cachedLeadWindowId = undefined;
	}

	/* ------------------------------------------------------------------ */
	/* Pane creation                                                      */
	/* ------------------------------------------------------------------ */

	private async paneIds(inside: boolean, windowTarget: string): Promise<string[] | null> {
		const r = await this.run(inside, tmuxArgs.listPanes(windowTarget));
		if (r.code !== 0) {
			if (windowTarget === this.cachedLeadWindowId) this.invalidateWindowCache();
			return null;
		}
		return r.stdout
			.trim()
			.split("\n")
			.filter(Boolean);
	}

	private splitError(stderr: string): string {
		const base = `failed to create worker pane: ${stderr.trim() || "unknown error"}`;
		return isNoSpaceError(stderr)
			? `${base} — no room for another tmux split. Spawn fewer concurrent workers, enlarge the terminal, or spawn with backend "process".`
			: base;
	}

	/**
	 * Spawn a worker pane in the lead's window (with-leader mode).
	 * Returns the new pane id.
	 */
	async spawnInside(): Promise<SpawnResult> {
		const detect = await this.detect();
		if (!detect.leadPaneId || !detect.leadWindowId) {
			return { ok: false, error: "could not determine the lead's tmux pane/window (is pi running inside tmux?)" };
		}
		const panes = await this.paneIds(true, detect.leadWindowId);
		if (!panes) return { ok: false, error: `could not list panes in window ${detect.leadWindowId}` };

		let r: ExecResult;
		if (panes.length === 1) {
			r = await this.run(true, tmuxArgs.splitFirstFromLead(detect.leadPaneId));
		} else {
			// Workers = all panes after the lead. Split the middle one,
			// alternating -v/-h by worker-count parity (Claude Code parity).
			const workers = panes.slice(1);
			const n = workers.length;
			const pick = workers[Math.floor((n - 1) / 2)] ?? workers[workers.length - 1];
			r = await this.run(true, tmuxArgs.splitFromPane(pick, n % 2 === 1));
		}
		if (r.code !== 0) {
			this.invalidateWindowCache();
			return { ok: false, error: this.splitError(r.stderr) };
		}
		const paneId = r.stdout.trim();
		if (!paneId) return { ok: false, error: "tmux split-window did not report a pane id" };

		// Rebalance: main-vertical with the lead at leadPanePct width.
		// Skipped while only 2 panes exist — the -l 70% split already sized them.
		const after = await this.paneIds(true, detect.leadWindowId);
		if (after && after.length > 2) {
			await this.run(true, tmuxArgs.selectLayout(detect.leadWindowId, "main-vertical"));
			await this.run(true, tmuxArgs.resizeLeadPane(detect.leadPaneId, this.leadPanePct));
		}
		return { ok: true, paneId, windowId: detect.leadWindowId };
	}

	/**
	 * Ensure the external swarm session/window exists.
	 */
	private async ensureSwarmWindow(): Promise<{ windowTarget: string; paneId: string }> {
		const windowTarget = `${SWARM_SESSION}:${SWARM_WINDOW}`;
		const has = await this.run(false, tmuxArgs.hasSession(SWARM_SESSION));
		if (has.code !== 0) {
			const r = await this.run(false, tmuxArgs.newSwarmSession(SWARM_SESSION, SWARM_WINDOW));
			if (r.code !== 0) {
				throw new Error(`failed to create swarm session: ${r.stderr.trim() || "unknown error"}`);
			}
			this.firstPaneUsedForExternal = false;
			return { windowTarget, paneId: r.stdout.trim() };
		}
		const windows = (await this.run(false, tmuxArgs.listWindows(SWARM_SESSION)))
			.stdout.trim()
			.split("\n")
			.filter(Boolean);
		if (windows.includes(SWARM_WINDOW)) {
			const panes = (await this.paneIds(false, windowTarget)) ?? [];
			return { windowTarget, paneId: panes[0] ?? "" };
		}
		const r = await this.run(false, tmuxArgs.newSwarmWindow(SWARM_SESSION, SWARM_WINDOW));
		if (r.code !== 0) throw new Error(`failed to create swarm window: ${r.stderr.trim() || "unknown error"}`);
		this.firstPaneUsedForExternal = false;
		return { windowTarget, paneId: r.stdout.trim() };
	}

	/**
	 * Spawn a worker pane in the external swarm window.
	 * The first worker reuses the window's initial pane.
	 */
	async spawnExternal(): Promise<SpawnResult> {
		let win: { windowTarget: string; paneId: string };
		try {
			win = await this.ensureSwarmWindow();
		} catch (e) {
			return { ok: false, error: (e as Error).message };
		}
		const panes = await this.paneIds(false, win.windowTarget);
		if (!panes) return { ok: false, error: `could not list panes in ${win.windowTarget}` };

		let paneId: string;
		if (!this.firstPaneUsedForExternal && panes.length === 1) {
			paneId = win.paneId || panes[0];
			this.firstPaneUsedForExternal = true;
			await this.run(false, tmuxArgs.enablePaneBorderStatus(win.windowTarget));
		} else {
			const f = panes.length;
			const pick = panes[Math.floor((f - 1) / 2)] ?? panes[panes.length - 1];
			const r = await this.run(false, tmuxArgs.splitFromPane(pick, f % 2 === 1));
			if (r.code !== 0) return { ok: false, error: this.splitError(r.stderr) };
			paneId = r.stdout.trim();
			if (!paneId) return { ok: false, error: "tmux split-window did not report a pane id" };
		}
		await this.run(false, tmuxArgs.selectLayout(win.windowTarget, "tiled"));
		const wid = await this.run(false, tmuxArgs.windowIdOf(win.windowTarget));
		return { ok: true, paneId, windowId: wid.code === 0 ? wid.stdout.trim() || undefined : undefined };
	}

	/* ------------------------------------------------------------------ */
	/* Worker lifecycle                                                   */
	/* ------------------------------------------------------------------ */

	/**
	 * Decorate a worker pane: border color + literal worker name in the
	 * border. Best-effort: cosmetics must never fail a spawn.
	 *
	 * Deliberately avoids `select-pane -T` (pane title): it would make the
	 * worker pane the active pane of the window — a focus change in the
	 * user's own window. The name goes into a per-pane border format
	 * instead.
	 */
	async decorate(paneId: string, name: string, color: string, inside: boolean): Promise<void> {
		const c = tmuxColor(color);
		for (const args of tmuxArgs.paneBorderColor(paneId, c)) await this.run(inside, args);
		await this.run(inside, tmuxArgs.paneBorderFormat(paneId, c, name));
	}

	/**
	 * Start the real worker command in a `cat`-running pane.
	 * The command is a single argv element; tmux executes it through the
	 * user's default shell, so embedded values must already be shell-quoted
	 * (see launch.ts).
	 */
	async startWorker(paneId: string, command: string, inside: boolean): Promise<void> {
		if (CONTROL_RE.test(command)) {
			throw new Error("refusing to send a command containing control characters to a terminal pane");
		}
		await this.run(inside, tmuxArgs.setRemainOnExit(paneId));
		const r = await this.run(inside, tmuxArgs.respawnPane(paneId, command));
		if (r.code !== 0) {
			throw new Error(`failed to start worker in pane ${paneId}: ${r.stderr.trim() || "unknown error"}`);
		}
	}

	/**
	 * Stop a worker in its pane WITHOUT calling kill-pane.
	 *
	 * Why: on some tmux builds (e.g. the 3.3a/next-3.4 distro snapshot on
	 * Alma/RHEL10) `kill-pane` on a respawned or dead pane corrupts the
	 * server heap and aborts the *entire* tmux server — killing every
	 * session on it, including unrelated ones. Instead we kill the pane's
	 * process (same user, so always permitted) and let tmux reap the pane
	 * the normal way — a plain process exit never crashes the server.
	 *
	 * Guarded: when `expectedWindowId` is given, the pane's current window
	 * must match before anything is killed (pane ids can be recycled after
	 * a server restart). Returns true when the pane is gone.
	 */
	async stopWorker(
		paneId: string,
		inside: boolean,
		expectedWindowId?: string,
	): Promise<boolean> {
		if (expectedWindowId) {
			const w = await this.run(inside, tmuxArgs.windowIdOf(paneId));
			if (w.code !== 0) return true; // pane already gone
			if (w.stdout.trim() !== expectedWindowId) {
				// The id now points at a different window — not ours. Leave it.
				return false;
			}
		}
		// Kill the pane's process tree (up to 2 rounds: when a wrapper
		// process dies, tmux promotes the child to pane_pid).
		for (let round = 0; round < 2; round++) {
			const pr = await this.run(inside, tmuxArgs.panePid(paneId));
			if (pr.code !== 0) break; // pane gone
			const pid = Number.parseInt(pr.stdout.trim(), 10);
			if (Number.isFinite(pid) && pid > 0 && pidAlive(pid)) {
				killProcessTree(pid, "SIGTERM");
				await sleep(2500);
				if (pidAlive(pid)) killProcessTree(pid, "SIGKILL");
			}
			await sleep(500);
		}
		const gone = await this.run(inside, tmuxArgs.paneDead(paneId));
		return gone.code !== 0; // pane gone
	}

	/**
	 * Whether a worker pane is still ALIVE (exists and its process runs).
	 * A pane left behind by `remain-on-exit failed` (crashed worker) counts
	 * as dead — a live process behind it is what "running" means.
	 * Used for status derivation; capture() still works on dead panes.
	 */
	async paneExists(paneId: string, inside: boolean): Promise<boolean> {
		const r = await this.run(inside, tmuxArgs.paneDead(paneId));
		if (r.code !== 0) return false; // pane gone
		return r.stdout.trim() !== "1";
	}

	/** Kill the whole external swarm session (cleanup). */
	async killSwarmSession(): Promise<void> {
		// Kill the session's pane processes first so the session ends
		// naturally (a clean server exit). kill-session is only a last
		// resort: some tmux builds abort the server on kill-session (heap
		// corruption) — harmless on our private socket, but a clean exit
		// also stops running workers properly.
		const panes = await this.run(false, tmuxArgs.listPanes(`${SWARM_SESSION}:${SWARM_WINDOW}`));
		if (panes.code === 0) {
			const ids = panes.stdout.trim().split("\n").filter(Boolean);
			for (const id of ids) await this.stopWorker(id, false).catch(() => {});
			await sleep(1000);
		}
		const check = await this.run(false, tmuxArgs.hasSession(SWARM_SESSION));
		if (check.code === 0) await this.run(false, tmuxArgs.killSession(SWARM_SESSION));
	}

	/** True when this run's swarm session still exists on its private socket. */
	async swarmSessionExists(): Promise<boolean> {
		const r = await this.run(false, tmuxArgs.hasSession(SWARM_SESSION));
		return r.code === 0;
	}
}

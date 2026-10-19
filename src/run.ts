import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pidAlive } from "./process.js";

/**
 * Run ("team") state: one directory per team run.
 *
 *   <teamDir>/<runId>/
 *     config.json          # RunState, written by the lead only
 *     inboxes/<name>.jsonl # messaging (see messaging.ts)
 *     logs/<name>.jsonl    # background worker: pi --mode json event stream
 *     logs/<name>.err      # background worker: stderr
 *     prompts/<name>.md    # task file
 *     prompts/<name>.bootstrap.md  # per-worker system prompt
 *     sessions/            # worker session storage (--session-dir)
 *
 * config.json members are the source of truth for who is in the team;
 * liveness is derived (pane existence / pid liveness / result messages).
 */

export type MemberBackend = "tmux-lead" | "tmux-swarm" | "process";

export interface Member {
	name: string;
	color: string;
	backend: MemberBackend;
	/** Resolved model (provider/id) actually launched, if any. */
	model?: string;
	thinking?: string;
	cwd: string;
	/** tmux pane id (%N) for pane backends. */
	paneId?: string;
	/** Window id (@N) the pane was created in; guards kill-pane. */
	windowId?: string;
	/** pid for process backend. */
	pid?: number;
	joinedAt: string;
	/** ISO ts of last known activity (spawn, inbox traffic, idle report). */
	lastActivity: string;
	dismissed?: boolean;
	/** True while the worker is queued for a staggered launch (not started yet). */
	starting?: boolean;
	/** Set by the lead when the worker's pane vanished without a result. */
	failed?: boolean;
}

export interface RunState {
	runId: string;
	createdAt: string;
	cwd: string;
	members: Member[];
}

export interface RunPaths {
	base: string;
	inboxes: string;
	logs: string;
	prompts: string;
	sessions: string;
}

export function runIdNow(): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	const ts =
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6);
	return `${ts}-${rand}`;
}

export function runPaths(base: string): RunPaths {
	return {
		base,
		inboxes: join(base, "inboxes"),
		logs: join(base, "logs"),
		prompts: join(base, "prompts"),
		sessions: join(base, "sessions"),
	};
}

export function createRun(teamDir: string, cwd: string, runId?: string): { runId: string; dir: string } {
	const id = runId ?? runIdNow();
	const dir = join(teamDir, id);
	mkdirSync(join(dir, "inboxes"), { recursive: true });
	mkdirSync(join(dir, "logs"), { recursive: true });
	mkdirSync(join(dir, "prompts"), { recursive: true });
	mkdirSync(join(dir, "sessions"), { recursive: true });
	const state: RunState = {
		runId: id,
		createdAt: new Date().toISOString(),
		cwd,
		members: [],
	};
	writeJson(join(dir, "config.json"), state);
	// A brand-new directory has no contender: claim it directly.
	writeLeadLock(dir);
	return { runId: id, dir };
}

export function configPath(runDir: string): string {
	return join(runDir, "config.json");
}

/* ---------------------------------------------------------------------- */
/* Lead ownership (one live lead per run)                                 */
/* ---------------------------------------------------------------------- */

/**
 * Ownership record for a run: which lead process currently owns it.
 *
 * teamDir is shared by every pi session of the user, so without ownership
 * a second lead session would re-attach to the first one's run and the two
 * sessions would merge their teams (same roster, same inboxes, same panes).
 * The lock ties a run to a lead PROCESS: a restarted lead (new pid, old pid
 * dead) may re-attach to its run; a different, still-alive lead session may
 * not — it gets its own run.
 */
export interface LeadLock {
	pid: number;
	/** ISO timestamp of the claim. */
	at: string;
}

export function leadLockPath(runDir: string): string {
	return join(runDir, "lead.lock");
}

export function readLeadLock(runDir: string): LeadLock | null {
	try {
		if (!existsSync(leadLockPath(runDir))) return null;
		const raw = JSON.parse(readFileSync(leadLockPath(runDir), "utf8")) as LeadLock;
		if (!raw || typeof raw.pid !== "number") return null;
		return raw;
	} catch {
		return null;
	}
}

/** Write the ownership lock for this process (non-atomic; fresh dirs only). */
export function writeLeadLock(runDir: string): void {
	writeJson(leadLockPath(runDir), {
		pid: process.pid,
		at: new Date().toISOString(),
	} satisfies LeadLock);
}

/**
 * Atomically claim a run's ownership lock for this process.
 *
 * Refuses when the lock is held by a LIVE process (another live lead owns
 * the run). A missing or dead-owner lock is claimed via O_EXCL so two leads
 * racing on the same stale run can't both claim it.
 */
export function claimLeadLock(runDir: string): boolean {
	let lock = readLeadLock(runDir);
	if (lock && pidAlive(lock.pid)) return false;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const fd = openSync(leadLockPath(runDir), "wx");
			writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n");
			closeSync(fd);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") return false;
			lock = readLeadLock(runDir);
			if (lock && pidAlive(lock.pid)) return false;
			// Stale (dead owner): remove and retry the atomic claim.
			rmSync(leadLockPath(runDir), { force: true });
		}
	}
	return false;
}

/**
 * Newest run this process may attach to: it still has live members and its
 * ownership lock is absent (legacy run — claimable) or held by a dead pid
 * (a restarted lead). Runs locked by a live pid are skipped — they belong
 * to another live lead session.
 */
export function attachableRunDir(teamDir: string, skip: Set<string> = new Set()): string | null {
	for (const id of listRuns(teamDir)) {
		if (skip.has(id)) continue;
		const dir = join(teamDir, id);
		const run = readRun(dir);
		if (!run || !run.members.some((m) => !m.dismissed)) continue;
		const lock = readLeadLock(dir);
		if (lock && pidAlive(lock.pid)) continue;
		return dir;
	}
	return null;
}

export function readRun(runDir: string): RunState | null {
	try {
		if (!existsSync(configPath(runDir))) return null;
		const raw = JSON.parse(readFileSync(configPath(runDir), "utf8")) as RunState;
		if (!raw || typeof raw.runId !== "string" || !Array.isArray(raw.members)) return null;
		return raw;
	} catch {
		return null;
	}
}

export function writeRun(runDir: string, state: RunState): void {
	writeJson(configPath(runDir), state);
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

export function findMember(run: RunState, name: string): Member | undefined {
	return run.members.find((m) => m.name === name);
}

export function addMember(run: RunState, member: Member): void {
	run.members = run.members.filter((m) => m.name !== member.name);
	run.members.push(member);
}

export function memberNames(run: RunState): string[] {
	return run.members.map((m) => m.name);
}

export function memberColors(run: RunState): string[] {
	return run.members.map((m) => m.color);
}

/** Remove a member from state (after its process/pane is gone). */
export function removeMember(run: RunState, name: string): void {
	run.members = run.members.filter((m) => m.name !== name);
}

/**
 * Find the most recent run directory under teamDir (by directory mtime).
 * Used to re-attach after a lead session restart.
 */
export function latestRunDir(teamDir: string): string | null {
	try {
		if (!existsSync(teamDir)) return null;
		const dirs = readdirSync(teamDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => join(teamDir, e.name))
			.filter((p) => existsSync(configPath(p)))
			.map((p) => ({ p, m: statSync(p).mtimeMs }))
			.sort((a, b) => b.m - a.m || (a.p < b.p ? 1 : -1));
		return dirs.length ? dirs[0].p : null;
	} catch {
		return null;
	}
}

/** Remove a whole run directory. */
export function removeRun(teamDir: string, runId: string): void {
	rmSync(join(teamDir, runId), { recursive: true, force: true });
}

/** All run ids under teamDir, newest first. */
export function listRuns(teamDir: string): string[] {
	try {
		if (!existsSync(teamDir)) return [];
		return readdirSync(teamDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

/**
 * Format seconds as a compact duration: 12s, 3m, 1h4m.
 */
export function fmtAge(sec: number): string {
	if (sec < 60) return `${Math.max(0, Math.floor(sec))}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	const h = Math.floor(sec / 3600);
	const mm = Math.floor((sec % 3600) / 60);
	return mm ? `${h}h${mm}m` : `${h}h`;
}

/** Seconds between an ISO ts and now (0 when invalid). */
export function ageSec(ts: string | undefined, now = Date.now()): number {
	if (!ts) return 0;
	const t = Date.parse(ts);
	if (Number.isNaN(t)) return 0;
	return Math.max(0, Math.floor((now - t) / 1000));
}

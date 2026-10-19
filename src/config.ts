import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MSG_TYPES, type TeamMessageType } from "./messaging.js";

/**
 * Team dispatch configuration.
 *
 * Global:   ~/.pi/agent/team-dispatch.json
 * Project:  <cwd>/.pi/team-dispatch.json   (overrides global, field by field)
 */

export type TeamBackend = "auto" | "tmux" | "swarm" | "process";

/**
 * How an inbox message is injected into the receiving pi session:
 * - "steer":    queued while the receiver's agent is running; delivered
 *               after the in-flight tool calls finish, before the next LLM
 *               call (i.e. mid-run, at the next turn boundary).
 * - "followUp": delivered only once the receiver's agent has fully finished.
 * When the receiver is idle both behave like a normal prompt (new turn).
 */
export type DeliverAs = "steer" | "followUp";

/** Delivery mode per message type; the "default" key is the fallback. */
export type DeliverPolicy = Partial<Record<TeamMessageType | "default", DeliverAs>>;

/** Default for worker sessions: lead/peer instructions and dismissals arrive
 * mid-run (steer); idle chatter waits until the worker settles. */
export const DEFAULT_DELIVER_WORKER: DeliverPolicy = {
	default: "steer",
	idle: "followUp",
};

/** Default for the lead session: worker questions and interim findings steer
 * into the lead's in-flight turn; result/idle/status notifications wait for
 * the lead to settle (avoiding mid-turn noise every time a worker idles). */
export const DEFAULT_DELIVER_LEAD: DeliverPolicy = {
	default: "steer",
	result: "followUp",
	idle: "followUp",
	status: "followUp",
};

/** Resolve the delivery mode for a message type under a policy. */
export function resolveDeliverAs(
	policy: DeliverPolicy | undefined,
	type: TeamMessageType,
): DeliverAs {
	return policy?.[type] ?? policy?.default ?? "steer";
}

/**
 * - auto:    inside tmux -> split panes in the lead's window; otherwise background processes
 * - tmux:    inside tmux -> lead's window; otherwise a dedicated external "swarm" tmux session
 * - swarm:   always a dedicated external "swarm" tmux session (works with or without $TMUX)
 * - process: always detached background processes with log files
 */
export interface TeamConfig {
	/** Root directory for run state. Default ~/.pi/agent/teams */
	teamDir: string;
	/** Hard cap on concurrent workers per team. */
	maxWorkers: number;
	/** Lead pane width (percent of window) in with-leader tmux layout. */
	leadPanePct: number;
	/** Pane/backend selection. See TeamBackend. */
	backend: TeamBackend;
	/**
	 * Minimum gap between consecutive worker launches, ms. Workers started
	 * at the same moment all fire their first LLM request together — a burst
	 * that can saturate a shared GPU. Launches are queued and staggered by
	 * this much (0 disables staggering). A lone spawn while idle is never
	 * delayed.
	 */
	launchStaggerMs: number;
	/**
	 * Override for the pi command used to launch workers.
	 * Default: the pi binary of the running process (or `pi` on PATH).
	 * May be a plain command name or an absolute path.
	 */
	workerCommand: string | null;
	/**
	 * Lean worker startup (default true): workers launched without the
	 * lead's extension/skill/theme/prompt-template discovery, MCP servers,
	 * and AGENTS.md/CLAUDE.md context files. Cuts minutes off team startup
	 * when many workers spawn at once. Set false to let workers inherit the
	 * lead's full plugin surface.
	 */
	workerLeanStartup: boolean;
	/** Kill workers and remove the run dir when the lead session ends. */
	killWorkersOnExit: boolean;
	/**
	 * Automatically dismiss (stop pane/process + free the slot) a worker as
	 * soon as its result arrives. Default false: finished workers stay in the
	 * roster (status "done") so the lead can keep them around for review, and
	 * are dismissed explicitly with team_dismiss.
	 */
	autoDismiss: boolean;
	/**
	 * Hide dismissed workers from the roster widget, team_status, and /team
	 * (default true): once a worker is dismissed its work is done with, and
	 * long-lived teams otherwise accumulate a wall of "· dismissed" lines.
	 * The entries stay in the run file (team_collect can still fetch their
	 * results by name) until team_cleanup removes the run. Use `/team all`
	 * or set this to false to list dismissed workers again.
	 */
	hideDismissed: boolean;
	/** Workers with no inbox activity for this long are shown as "stale". */
	staleAfterSec: number;
	/** How many lines team_log tails by default. */
	logTailLines: number;
	/** Poll interval for inbox watchers, ms. */
	pollMs: number;
	/**
	 * Delivery mode per message type when injecting inbox messages into
	 * worker sessions (see DeliverAs). Config "deliverAs": a plain string
	 * ("steer"|"followUp") forces one mode for every type on both sides;
	 * { worker: {...}, lead: {...} } merges per-type overrides (keys:
	 * message types or "default") over the built-in policies below.
	 */
	deliverAsWorker: DeliverPolicy;
	/** Delivery mode per message type when injecting worker messages into the lead session. */
	deliverAsLead: DeliverPolicy;
}

export const DEFAULT_CONFIG: TeamConfig = {
	teamDir: join(homedir(), ".pi", "agent", "teams"),
	maxWorkers: 3,
	leadPanePct: 30,
	backend: "auto",
	workerCommand: null,
	workerLeanStartup: true,
	launchStaggerMs: 15000,
	killWorkersOnExit: true,
	autoDismiss: false,
	hideDismissed: true,
	staleAfterSec: 120,
	logTailLines: 40,
	pollMs: 2000,
	deliverAsWorker: { ...DEFAULT_DELIVER_WORKER },
	deliverAsLead: { ...DEFAULT_DELIVER_LEAD },
};

function readJson(path: string): Record<string, unknown> | null {
	try {
		if (!existsSync(path)) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function clampNum(v: unknown, def: number, lo: number, hi: number): number {
	const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : def;
	return Math.max(lo, Math.min(hi, n));
}

function strOrNull(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

function bool(v: unknown, def: boolean): boolean {
	return typeof v === "boolean" ? v : def;
}

/**
 * Merge a raw deliverAs value over a base policy. A plain string ("steer" /
 * "followUp") replaces the policy outright (forces one mode for all types);
 * an object merges per type, keeping unlisted entries from the base.
 */
function mergeDeliver(raw: unknown, base: DeliverPolicy): DeliverPolicy {
	if (typeof raw === "string") {
		return raw === "steer" || raw === "followUp" ? { default: raw } : { ...base };
	}
	const out: DeliverPolicy = { ...base };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
	for (const [k, v] of Object.entries(raw)) {
		if (k !== "default" && !MSG_TYPES.has(k)) continue; // unknown key ignored
		if (v === "steer" || v === "followUp") out[k as keyof DeliverPolicy] = v;
	}
	return out;
}

const BACKENDS: TeamBackend[] = ["auto", "tmux", "swarm", "process"];

/** Merge raw JSON objects over defaults with light validation. */
export function mergeConfig(
	bases: Array<Record<string, unknown> | null>,
): TeamConfig {
	const cfg: TeamConfig = { ...DEFAULT_CONFIG };
	for (const raw of bases) {
		if (!raw) continue;
		if (typeof raw.teamDir === "string" && raw.teamDir.trim()) cfg.teamDir = raw.teamDir.trim();
		cfg.maxWorkers = clampNum(raw.maxWorkers, cfg.maxWorkers, 1, 16);
		cfg.leadPanePct = clampNum(raw.leadPanePct, cfg.leadPanePct, 10, 70);
		cfg.launchStaggerMs = clampNum(raw.launchStaggerMs, cfg.launchStaggerMs, 0, 600000);
		if (BACKENDS.includes(raw.backend as TeamBackend)) cfg.backend = raw.backend as TeamBackend;
		const wc = strOrNull(raw.workerCommand);
		if (wc) cfg.workerCommand = wc;
		cfg.workerLeanStartup = bool(raw.workerLeanStartup, cfg.workerLeanStartup);
		cfg.killWorkersOnExit = bool(raw.killWorkersOnExit, cfg.killWorkersOnExit);
		cfg.autoDismiss = bool(raw.autoDismiss, cfg.autoDismiss);
		cfg.hideDismissed = bool(raw.hideDismissed, cfg.hideDismissed);
		cfg.staleAfterSec = clampNum(raw.staleAfterSec, cfg.staleAfterSec, 5, 3600);
		cfg.logTailLines = clampNum(raw.logTailLines, cfg.logTailLines, 5, 500);
		cfg.pollMs = clampNum(raw.pollMs, cfg.pollMs, 250, 30000);
		if (typeof raw.deliverAs === "string") {
			cfg.deliverAsWorker = mergeDeliver(raw.deliverAs, cfg.deliverAsWorker);
			cfg.deliverAsLead = mergeDeliver(raw.deliverAs, cfg.deliverAsLead);
		} else if (raw.deliverAs && typeof raw.deliverAs === "object" && !Array.isArray(raw.deliverAs)) {
			const da = raw.deliverAs as Record<string, unknown>;
			cfg.deliverAsWorker = mergeDeliver(da.worker, cfg.deliverAsWorker);
			cfg.deliverAsLead = mergeDeliver(da.lead, cfg.deliverAsLead);
		}
	}
	return cfg;
}

/** Load merged config for the given working directory. */
export function loadConfig(cwd: string): TeamConfig {
	const globalPath = join(homedir(), ".pi", "agent", "team-dispatch.json");
	const projectPath = join(cwd, ".pi", "team-dispatch.json");
	return mergeConfig([readJson(globalPath), readJson(projectPath)]);
}

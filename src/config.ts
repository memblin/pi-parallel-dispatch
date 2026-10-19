import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Team dispatch configuration.
 *
 * Global:   ~/.pi/agent/team-dispatch.json
 * Project:  <cwd>/.pi/team-dispatch.json   (overrides global, field by field)
 */

export type TeamBackend = "auto" | "tmux" | "swarm" | "process";

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
	/** Kill workers and remove the run dir when the lead session ends. */
	killWorkersOnExit: boolean;
	/**
	 * Automatically dismiss (stop pane/process + free the slot) a worker as
	 * soon as its result arrives. Default false: finished workers stay in the
	 * roster (status "done") so the lead can keep them around for review, and
	 * are dismissed explicitly with team_dismiss.
	 */
	autoDismiss: boolean;
	/** Workers with no inbox activity for this long are shown as "stale". */
	staleAfterSec: number;
	/** How many lines team_log tails by default. */
	logTailLines: number;
	/** Poll interval for inbox watchers, ms. */
	pollMs: number;
}

export const DEFAULT_CONFIG: TeamConfig = {
	teamDir: join(homedir(), ".pi", "agent", "teams"),
	maxWorkers: 3,
	leadPanePct: 30,
	backend: "auto",
	workerCommand: null,
	launchStaggerMs: 15000,
	killWorkersOnExit: true,
	autoDismiss: false,
	staleAfterSec: 120,
	logTailLines: 40,
	pollMs: 2000,
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
		cfg.killWorkersOnExit = bool(raw.killWorkersOnExit, cfg.killWorkersOnExit);
		cfg.autoDismiss = bool(raw.autoDismiss, cfg.autoDismiss);
		cfg.staleAfterSec = clampNum(raw.staleAfterSec, cfg.staleAfterSec, 5, 3600);
		cfg.logTailLines = clampNum(raw.logTailLines, cfg.logTailLines, 5, 500);
		cfg.pollMs = clampNum(raw.pollMs, cfg.pollMs, 250, 30000);
	}
	return cfg;
}

/** Load merged config for the given working directory. */
export function loadConfig(cwd: string): TeamConfig {
	const globalPath = join(homedir(), ".pi", "agent", "team-dispatch.json");
	const projectPath = join(cwd, ".pi", "team-dispatch.json");
	return mergeConfig([readJson(globalPath), readJson(projectPath)]);
}

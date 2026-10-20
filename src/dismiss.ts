import type { Member } from "./run.js";
import type { WorkerStatus } from "./status.js";
import { ageSec } from "./run.js";

/**
 * Dismiss target resolution (issue #4).
 *
 * `team_dismiss` is the one destructive tool in this package: it stops panes
 * and kills processes. A missing or misspelled argument must never turn a
 * targeted cleanup into "kill the whole wave", so the contract is:
 *
 *  - `name` is required. Omitted/blank resolves to an error that lists the
 *    roster, never to "all". `"all"` is the only way to dismiss everyone.
 *  - Non-terminal workers (`starting`/`running`/`idle`) hold in-flight work.
 *    They are refused unless `force: true` is passed explicitly. Dismissing a
 *    `done`/`failed` worker is cleanup; dismissing a live one is destruction.
 */

/** Statuses whose worker may still be producing work. */
export const LIVE_STATUSES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
	"starting",
	"running",
	"idle",
]);

export function isLiveStatus(status: WorkerStatus | undefined): boolean {
	return status !== undefined && LIVE_STATUSES.has(status);
}

export interface DismissInput {
	/** Roster as recorded in the run state. */
	members: Member[];
	/** The `name` argument exactly as received (may be missing/blank). */
	name?: string;
	/** Opt out of the live-worker guard. */
	force?: boolean;
	/** Derived status lookup (from `deriveMembers`). */
	statusOf?: (name: string) => WorkerStatus | undefined;
	/** Seconds since the member's last activity. */
	ageOf?: (name: string) => number;
}

export type DismissDecision =
	| {
			ok: true;
			/** Workers to stop, in roster order. */
			targets: Member[];
			/** True when the caller asked for the whole team. */
			all: boolean;
			/** Live members included because `force` was set. */
			forced: Member[];
	  }
	| { ok: false; error: string };

/** One-line roster summary: `a (running), b (done)`. */
function rosterSummary(
	members: Member[],
	statusOf?: (name: string) => WorkerStatus | undefined,
): string {
	const live = members.filter((m) => !m.dismissed);
	if (live.length === 0) return "(no workers yet)";
	return live.map((m) => `${m.name} (${statusOf?.(m.name) ?? "unknown"})`).join(", ");
}

/**
 * Decide which members a dismiss call targets, refusing the destructive
 * interpretations of a missing/misspelled argument.
 */
export function decideDismiss(input: DismissInput): DismissDecision {
	const { members, statusOf, ageOf } = input;
	const wanted = (input.name ?? "").trim();
	const force = input.force === true;

	if (!wanted) {
		return {
			ok: false,
			error:
				`team_dismiss needs an explicit target: pass name="<worker>", or ` +
				`name="all" to dismiss every worker. Roster: ${rosterSummary(members, statusOf)}. ` +
				`Nothing was dismissed.`,
		};
	}

	const all = wanted.toLowerCase() === "all";
	let targets: Member[];
	if (all) {
		targets = members.filter((m) => !m.dismissed);
		if (targets.length === 0) {
			return { ok: false, error: "no workers to dismiss (every member is already dismissed)" };
		}
	} else {
		const hit = members.find((m) => m.name === wanted);
		if (!hit) {
			return {
				ok: false,
				error:
					`unknown worker "${wanted}". Roster: ${rosterSummary(members, statusOf)}. ` +
					`Pass one of those names, or name="all" for the whole team. Nothing was dismissed.`,
			};
		}
		if (hit.dismissed) {
			return { ok: false, error: `worker "${wanted}" is already dismissed` };
		}
		targets = [hit];
	}

	const live = targets.filter((m) => isLiveStatus(statusOf?.(m.name)));
	if (live.length > 0 && !force) {
		const describe = (m: Member): string => {
			const status = statusOf?.(m.name) ?? "unknown";
			const age = ageOf ? ageOf(m.name) : ageSec(m.lastActivity);
			return `  - ${m.name} (${status}, active ${age}s ago)`;
		};
		return {
			ok: false,
			error:
				`team_dismiss refused: ${live.length} of ${targets.length} target(s) are still live ` +
				`(in-flight work would be lost):\n${live.map(describe).join("\n")}\n` +
				`Collect their results first (team_collect), dismiss only finished workers, or pass ` +
				`force=true to stop them anyway. Nothing was dismissed.`,
		};
	}

	return { ok: true, targets, all, forced: force ? live : [] };
}

/**
 * Result line for a completed dismiss. Says how many workers went and warns
 * when live ones were killed by `force` — a one-word "Dismissed: a, b, c"
 * used to hide a wave-killer.
 */
export function renderDismissResult(
	targets: Member[],
	extra?: { all?: boolean; forced?: Member[]; remaining?: number },
): string {
	const names = targets.map((m) => m.name);
	const n = names.length;
	const head =
		n === 1
			? `Dismissed 1 worker: ${names[0]}.`
			: extra?.all
				? `Dismissed ${n} workers — the WHOLE TEAM: ${names.join(", ")}.`
				: `Dismissed ${n} workers: ${names.join(", ")}.`;
	const notes: string[] = [head];
	const forced = extra?.forced ?? [];
	if (forced.length > 0) {
		notes.push(
			`WARNING: ${forced.length} of them were still live and were stopped mid-task: ` +
				`${forced.map((m) => m.name).join(", ")}.`,
		);
	}
	if (n > 1) {
		notes.push(
			"If you only meant one worker, re-spawn the others with team_spawn " +
				"(their transcripts are still in the run dir for team_log).",
		);
	}
	const remaining = extra?.remaining ?? 0;
	if (remaining > 0) notes.push(`${remaining} worker(s) still on the roster.`);
	notes.push("Use team_cleanup to remove the run directory.");
	return notes.join("\n");
}

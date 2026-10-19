/**
 * Team member naming: validation, sanitization, reserved names, colors.
 *
 * Mirrors Claude Code's agent-team identity rules:
 *  - names must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
 *  - reserved names: lead, team-lead, user, system, main
 *  - duplicate names get a -2, -3, ... suffix
 *  - a fixed 8-color palette is assigned round-robin
 */

export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const RESERVED_NAMES = new Set([
	"lead",
	"team-lead",
	"team_lead",
	"user",
	"system",
	"main",
]);

/** Lead's address inside a team. */
export const LEAD_NAME = "lead";

/**
 * Colors assignable to workers. Values are the *user-facing* names;
 * `tmuxColor()` maps them to tmux color strings.
 */
export const WORKER_COLORS = [
	"blue",
	"green",
	"yellow",
	"cyan",
	"magenta",
	"orange",
	"red",
	"pink",
] as const;

export type WorkerColor = (typeof WORKER_COLORS)[number];

const TMUX_COLORS: Record<string, string> = {
	red: "red",
	blue: "blue",
	green: "green",
	yellow: "yellow",
	purple: "magenta",
	magenta: "magenta",
	orange: "colour208",
	pink: "colour205",
	cyan: "cyan",
};

export function tmuxColor(color: string): string {
	return TMUX_COLORS[color] ?? "blue";
}

export type NameCheck = { ok: true; name: string } | { ok: false; error: string };

/** Validate a single name (no dedup). */
export function checkName(raw: string): NameCheck {
	const name = (raw ?? "").trim();
	if (!NAME_RE.test(name)) {
		return {
			ok: false,
			error:
				`invalid name "${raw}": must start with a letter or digit and contain only ` +
				`letters, digits, underscores, or hyphens (max 64 chars)`,
		};
	}
	if (RESERVED_NAMES.has(name.toLowerCase())) {
		return { ok: false, error: `"${name}" is a reserved team name — choose another` };
	}
	return { ok: true, name };
}

/**
 * Return a unique name for `raw` given already-taken names.
 * Tries raw, then raw-2, raw-3, ... up to 100.
 */
export function uniqueName(raw: string, taken: string[]): string {
	const base = raw;
	const takenSet = new Set(taken.map((n: string) => n.toLowerCase()));
	if (!takenSet.has(base.toLowerCase())) return base;
	for (let i = 2; i < 102; i++) {
		const candidate = `${base}-${i}`;
		if (NAME_RE.test(candidate) && !takenSet.has(candidate.toLowerCase())) return candidate;
	}
	return `${base}-${Date.now().toString(36)}`;
}

/** Pick the next free color, or fall back to a stable hash pick. */
export function nextColor(used: Iterable<string>): WorkerColor {
	const usedSet = new Set(used);
	for (const c of WORKER_COLORS) if (!usedSet.has(c)) return c;
	return WORKER_COLORS[usedSet.size % WORKER_COLORS.length];
}

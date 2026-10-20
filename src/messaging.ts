import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Inbox messaging: one append-only JSONL file per member.
 *
 *   <runDir>/inboxes/<name>.jsonl
 *   each line: {"from","to","type","ts","body"}
 *
 * Appends are single write(2) calls; a single JSON line well under the
 * OS page size is atomic enough for our lead<->worker traffic.
 * Readers track a byte cursor so concurrent appends never lose or
 * duplicate messages.
 */

export type TeamMessageType =
	| "task"
	| "status"
	| "question"
	| "answer"
	| "result"
	| "idle"
	| "dismiss"
	| "info";

export interface TeamMessage {
	from: string;
	to: string;
	type: TeamMessageType;
	ts: string;
	body: string;
	/** Urgency tier; default derived from `type` (see TYPE_DEFAULTS). */
	priority?: TeamPriority;
	/** Kind of attention requested; default derived from `type`. */
	level?: TeamLevel;
}

/**
 * Urgency tiers (borrowed from Claude Code's main-thread queue vocabulary):
 * - now:   act immediately — always delivered by steering (interrupts at the
 *          next tool-round boundary, even when the receiver session runs a
 *          long continuous turn).
 * - next:  fold in at the next decision point — steered by default
 *          (receiver's per-type `deliverAs` policy may downgrade to followUp).
 * - later: purely informative — waits for the end of the current turn
 *          (followUp) so it never churns the receiver.
 */
export type TeamPriority = "now" | "next" | "later";

/**
 * Attention kinds (behavioral contract lives in the team-dispatch skill):
 * - info:     context only; do not change the current action path.
 * - assist:   helpful context; incorporate if cheap, else defer.
 * - warning:  re-plan: assess before dispatching more work into the lane.
 * - critical: write a resume-point summary (memory/notes) FIRST, then switch
 *             to handling the reported issue.
 */
export type TeamLevel = "info" | "assist" | "warning" | "critical";

/** How a wake enters a mid-turn session (pi-core delivery modes). */
export type DeliveryMode = "steer" | "followUp";

export interface TeamAttrs {
	priority?: TeamPriority;
	level?: TeamLevel;
}

const TYPE_DEFAULTS: Record<TeamMessageType, Required<TeamAttrs>> = {
	task: { priority: "next", level: "assist" },
	status: { priority: "now", level: "warning" }, // session died without team_done
	question: { priority: "next", level: "assist" },
	answer: { priority: "next", level: "assist" },
	result: { priority: "next", level: "info" },
	idle: { priority: "later", level: "info" },
	dismiss: { priority: "next", level: "warning" },
	info: { priority: "next", level: "assist" }, // team_send traffic
};

const PRIORITIES = new Set<string>(["now", "next", "later"]);
const LEVELS = new Set<string>(["info", "assist", "warning", "critical"]);

/** Effective priority of a message (explicit value or per-type default). */
export function priorityOf(m: Pick<TeamMessage, "type" | "priority">): TeamPriority {
	return m.priority ?? TYPE_DEFAULTS[m.type].priority;
}

/** Effective level of a message (explicit value or per-type default). */
export function levelOf(m: Pick<TeamMessage, "type" | "level">): TeamLevel {
	return m.level ?? TYPE_DEFAULTS[m.type].level;
}

/** Render the routing header, e.g. `[priority=next level=info]`. */
export function formatPriorityHeader(m: Pick<TeamMessage, "type" | "priority" | "level">): string {
	return `[priority=${priorityOf(m)} level=${levelOf(m)}]`;
}

/**
 * Map a priority tier to a pi delivery mode. `now` always steers and `later`
 * always waits for the turn to end (so urgency cannot be misconfigured away);
 * `next` follows the receiver's configured default.
 */
export function wakeDelivery(priority: TeamPriority, defaultMode: DeliveryMode): DeliveryMode {
	if (priority === "now") return "steer";
	if (priority === "later") return "followUp";
	return defaultMode;
}

export const MSG_TYPES = new Set<string>([
	"task",
	"status",
	"question",
	"answer",
	"result",
	"idle",
	"dismiss",
	"info",
]);

export function inboxesDir(runDir: string): string {
	return join(runDir, "inboxes");
}

export function inboxPath(runDir: string, name: string): string {
	return join(inboxesDir(runDir), `${name}.jsonl`);
}

export function makeMessage(
	from: string,
	to: string,
	type: TeamMessageType,
	body: string,
	attrs?: TeamAttrs,
): TeamMessage {
	const msg: TeamMessage = { from, to, type, ts: new Date().toISOString(), body: String(body ?? "") };
	if (attrs?.priority && PRIORITIES.has(attrs.priority)) msg.priority = attrs.priority;
	if (attrs?.level && LEVELS.has(attrs.level)) msg.level = attrs.level;
	return msg;
}

/** Append one message to the named inbox (creates dirs as needed). */
export function appendMessage(runDir: string, msg: TeamMessage): string {
	const path = inboxPath(runDir, msg.to);
	mkdirSync(inboxesDir(runDir), { recursive: true });
	const line = JSON.stringify(msg) + "\n";
	const fd = openSync(path, "a");
	try {
		writeFileSync(fd, line);
	} finally {
		try {
			closeSync(fd);
		} catch {
			/* already closed */
		}
	}
	return path;
}

/** Convenience: append from->to with a type and body. */
export function send(
	runDir: string,
	from: string,
	to: string,
	type: TeamMessageType,
	body: string,
	attrs?: TeamAttrs,
): string {
	return appendMessage(runDir, makeMessage(from, to, type, body, attrs));
}

export interface InboxRead {
	messages: TeamMessage[];
	/** New byte cursor to persist for the next read. */
	cursor: number;
}

/**
 * Read complete messages from a byte cursor onward out of the named inbox.
 * A trailing partial line (writer mid-append) is left for the next read.
 * Unparseable or malformed lines are skipped (cursor advances past them).
 */
export function readInbox(runDir: string, name: string, cursor = 0): InboxRead {
	const path = inboxPath(runDir, name);
	if (!existsSync(path)) return { messages: [], cursor: 0 };
	const size = statSync(path).size;
	if (size <= cursor) return { messages: [], cursor: size };
	const buf = readFileSync(path);
	const messages: TeamMessage[] = [];

	// Walk complete lines (0x0a-terminated) by byte offset. A trailing
	// partial line (writer mid-append) is left for the next read.
	let lineStart = 0;
	let lastCompleteEnd = 0;
	while (true) {
		const nl = buf.indexOf(0x0a, lineStart); // \n
		if (nl === -1) break;
		const lineEnd = nl + 1;
		lastCompleteEnd = lineEnd;
		if (lineStart >= cursor) {
			const line = buf.subarray(lineStart, nl).toString("utf8");
			if (line.trim()) {
				try {
					const m = JSON.parse(line) as TeamMessage;
					if (
						m &&
						typeof m.from === "string" &&
						typeof m.to === "string" &&
						typeof m.body === "string" &&
						MSG_TYPES.has(m.type)
					) {
						// Drop unknown priority/level values so defaults apply.
						if (typeof m.priority !== "string" || !PRIORITIES.has(m.priority)) delete m.priority;
						if (typeof m.level !== "string" || !LEVELS.has(m.level)) delete m.level;
						messages.push(m);
					}
				} catch {
					// skip malformed line
				}
			}
		}
		lineStart = lineEnd;
	}
	return { messages, cursor: lastCompleteEnd };
}

/** Size of an inbox file in bytes (0 when absent) — a safe initial cursor. */
export function inboxSize(runDir: string, name: string): number {
	try {
		const path = inboxPath(runDir, name);
		return existsSync(path) ? statSync(path).size : 0;
	} catch {
		return 0;
	}
}

/** Remove one member's inbox file (cleanup). */
export function removeInbox(runDir: string, name: string): void {
	try {
		const path = inboxPath(runDir, name);
		if (existsSync(path)) unlinkSync(path);
	} catch {
		/* best effort */
	}
}

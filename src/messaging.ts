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
): TeamMessage {
	return { from, to, type, ts: new Date().toISOString(), body: String(body ?? "") };
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
): string {
	return appendMessage(runDir, makeMessage(from, to, type, body));
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

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";

/**
 * Background ("process") backend: detached one-shot pi workers.
 *
 * Each worker runs:
 *   pi --mode json -p --approve ... > logs/<name>.jsonl 2> logs/<name>.err
 *
 * The JSONL event stream is the worker's transcript; the final assistant
 * message is the result. Workers are detached and unref'd: they outlive
 * tool calls and the lead session can be killed independently.
 */

export interface ProcessSpawnOpts {
	argv: string[];
	env: Record<string, string>;
	cwd: string;
	logPath: string;
	errPath: string;
	/**
	 * Base environment (default: process.env). Team dispatch passes a copy
	 * with TMUX/TMUX_PANE removed so a background worker's incidental `tmux`
	 * commands cannot reach the lead's tmux server via the $TMUX socket.
	 */
	envBase?: Record<string, string | undefined>;
}

export interface ProcessHandle {
	pid: number;
}

/** Spawn a detached worker; returns its pid. */
export function spawnWorkerProcess(opts: ProcessSpawnOpts): ProcessHandle {
	const out = openSync(opts.logPath, "a");
	const err = openSync(opts.errPath, "a");
	const base = opts.envBase ?? process.env;
	const child = spawn(opts.argv[0], opts.argv.slice(1), {
		cwd: opts.cwd,
		env: { ...base, ...opts.env },
		stdio: ["ignore", out, err],
		detached: true,
	});
	// A failed spawn (ENOENT, bad cwd, ...) emits 'error' asynchronously;
	// without a listener it would crash the lead process. Record it where
	// the user is looking (the worker's stderr log).
	child.on("error", (e) => {
		try {
			appendFileSync(opts.errPath, `spawn error: ${e.message}\n`);
		} catch {
			/* ignore */
		}
	});
	child.unref();
	return { pid: child.pid ?? -1 };
}

export function pidAlive(pid: number | undefined): boolean {
	if (!pid || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM means it exists but we can't signal it.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Last `lines` lines of a text file ("" when missing). */
export function tailFile(path: string, lines: number): string {
	try {
		if (!existsSync(path)) return "";
		const raw = readFileSync(path, "utf8");
		const all = raw.split("\n");
		if (all.length > 0 && all[all.length - 1] === "") all.pop();
		return all.slice(-lines).join("\n");
	} catch {
		return "";
	}
}

interface JsonlEvent {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
}

/**
 * Extract the final assistant text from a pi --mode json event stream.
 * Scans for the last message_end with an assistant message; falls back to
 * the last assistant message of any event type.
 */
export function finalAssistantText(logPath: string): string {
	try {
		if (!existsSync(logPath)) return "";
		const raw = readFileSync(logPath, "utf8");
		let final = "";
		let lastAssistant = "";
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let ev: JsonlEvent;
			try {
				ev = JSON.parse(line);
			} catch {
				continue;
			}
			const msg = ev.message;
			if (!msg) continue;
			if (msg.role === "assistant" && Array.isArray(msg.content)) {
				const text = (msg.content as { type?: string; text?: string }[])
					.filter((c) => c.type === "text" && typeof c.text === "string")
					.map((c) => c.text!)
					.join("\n");
				if (text.trim()) lastAssistant = text;
				if (ev.type === "message_end") final = text;
			}
		}
		return final || lastAssistant;
	} catch {
		return "";
	}
}

/**
 * Compact one-line rendering of a JSONL event for team_log.
 * Returns null for events not worth showing.
 */
export function renderJsonlLine(line: string): string | null {
	let ev: JsonlEvent & {
		name?: string;
		args?: Record<string, unknown>;
		status?: string;
	};
	try {
		ev = JSON.parse(line);
	} catch {
		return null;
	}
	const t = ev.type;
	if (!t) return null;
	switch (t) {
		case "tool_execution_start":
		case "tool_execution_update": {
			const args = ev.args ?? {};
			let preview = "";
			if (typeof args.command === "string") preview = `$ ${args.command}`;
			else if (typeof args.file_path === "string") preview = args.file_path;
			else if (typeof args.path === "string") preview = args.path;
			else if (typeof args.pattern === "string") preview = args.pattern;
			preview = preview.length > 90 ? `${preview.slice(0, 90)}…` : preview;
			return `${t === "tool_execution_start" ? "▶" : "…"} ${ev.name ?? "tool"} ${preview}`.trim();
		}
		case "message_end": {
			const msg = ev.message;
			if (msg?.role === "assistant" && Array.isArray(msg.content)) {
				const text = (msg.content as { type?: string; text?: string }[])
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("")
					.replace(/\s+/g, " ")
					.trim();
				if (text) return `◆ ${text.length > 120 ? `${text.slice(0, 120)}…` : text}`;
			}
			return null;
		}
		case "agent_settled":
			return "■ settled";
		case "run_start":
			return "— run start";
		default:
			return null;
	}
}

/**
 * Render the last `lines` interesting lines from a JSONL log.
 */
export function renderJsonlTail(logPath: string, lines: number): string {
	const raw = tailFile(logPath, 400);
	if (!raw.trim()) return "";
	const rendered = raw
		.split("\n")
		.map(renderJsonlLine)
		.filter((l): l is string => l !== null);
	return rendered.slice(-lines).join("\n");
}

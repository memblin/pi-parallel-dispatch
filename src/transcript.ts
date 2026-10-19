/**
 * Worker transcript rendering from persisted pi session files.
 *
 * Used for `team_log` on pane workers instead of tmux `capture-pane -p`,
 * which on some tmux builds (e.g. the Alma/RHEL10 3.3a/next-3.4 snapshot)
 * corrupts the server heap and aborts the ENTIRE tmux server — killing
 * every session on it. The worker's session file is the canonical record
 * of its activity and needs no tmux at all (it also works after the pane
 * is closed).
 */
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Find the most recent session file in <runDir>/sessions whose
 * `session_info` name matches `name`. Workers are launched with
 * `--name <name> --session-dir <runDir>/sessions`.
 */
export function findWorkerSessionFile(runDir: string, name: string): string | undefined {
	const dir = join(runDir, "sessions");
	if (!existsSync(dir)) return undefined;
	let best: { file: string; mtime: number } | undefined;
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	for (const f of entries) {
		if (!f.endsWith(".jsonl")) continue;
		const file = join(dir, f);
		const head = readHead(file, 8192);
		// The name appears in the early "session_info" line.
		if (!head || !head.includes(`"name":"${name}"`)) continue;
		let mtime = 0;
		try {
			mtime = statSync(file).mtimeMs;
		} catch {
			continue;
		}
		if (!best || mtime > best.mtime) best = { file, mtime };
	}
	return best?.file;
}

/** Read the first `n` bytes of a file ("" on error). */
function readHead(path: string, n: number): string {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buf = Buffer.alloc(n);
		const bytes = readSync(fd, buf, 0, n, 0);
		return buf.subarray(0, bytes).toString("utf8");
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
}

interface SessionLine {
	type?: string;
	name?: string;
	provider?: string;
	modelId?: string;
	message?: {
		role?: string;
		content?: { type?: string; text?: string; name?: string; arguments?: Record<string, unknown> }[];
	};
}

/** Compact one-line rendering of a session-file line (null = skip). */
export function renderSessionLine(line: string): string | null {
	let ev: SessionLine;
	try {
		ev = JSON.parse(line);
	} catch {
		return null;
	}
	switch (ev.type) {
		case "session_info":
			return ev.name ? `· session "${ev.name}"` : null;
		case "model_change":
			return ev.modelId ? `· model: ${ev.provider ?? ""}/${ev.modelId}`.replace("//", "/") : null;
		case "message": {
			const msg = ev.message;
			if (!msg || !Array.isArray(msg.content)) return null;
			if (msg.role === "user") {
				const text = msg.content
					.filter((c) => c.type === "text" && typeof c.text === "string")
					.map((c) => c.text!)
					.join(" ")
					.replace(/\s+/g, " ")
					.trim();
				if (!text) return null;
				// Team messages arrive as user messages; keep them visible.
				const t = text.length > 160 ? `${text.slice(0, 160)}…` : text;
				return `▸ user: ${t}`;
			}
			if (msg.role !== "assistant") return null;
			const parts: string[] = [];
			for (const c of msg.content) {
				if (c.type === "text" && typeof c.text === "string") {
					const t = c.text.replace(/\s+/g, " ").trim();
					if (t) parts.push(`◆ ${t.length > 120 ? `${t.slice(0, 120)}…` : t}`);
				} else if (c.type === "toolCall" && typeof c.name === "string") {
					const preview = toolPreview(c.arguments ?? {});
					parts.push(`▶ ${c.name} ${preview}`.trim());
				}
			}
			return parts.length ? parts.join(" | ") : null;
		}
		default:
			return null;
	}
}

function toolPreview(args: Record<string, unknown>): string {
	let preview = "";
	if (typeof args.command === "string") preview = `$ ${args.command}`;
	else if (typeof args.file_path === "string") preview = args.file_path;
	else if (typeof args.path === "string") preview = args.path;
	else if (typeof args.pattern === "string") preview = args.pattern;
	return preview.length > 90 ? `${preview.slice(0, 90)}…` : preview;
}

/** Render the last `lines` interesting lines of a session file. */
export function renderSessionTail(sessionFile: string, lines: number): string {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return "";
	}
	const all = raw.split("\n");
	const rendered = all
		.map(renderSessionLine)
		.filter((l): l is string => l !== null);
	return rendered.slice(-lines).join("\n");
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findWorkerSessionFile,
	renderSessionLine,
	renderSessionTail,
} from "../src/transcript.js";

function tmpRun(): string {
	const dir = mkdtempSync(join(tmpdir(), "team-transcript-"));
	mkdirSync(join(dir, "sessions"), { recursive: true });
	return dir;
}

function sessionFile(dir: string, name: string, name2?: string, body = ""): string {
	const f = join(dir, "sessions", `2025-01-01T00-00-00-000Z_${name}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/w" }),
		JSON.stringify({ type: "session_info", name: name2 ?? name }),
		JSON.stringify({ type: "model_change", provider: "deepseek", modelId: "flash" }),
		JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "do the task" }] } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "/w/a.ts" } }] } }),
		JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done: 42" }] } }),
		...body.split("\n").filter(Boolean).map((l) => l),
	];
	writeFileSync(f, lines.join("\n") + "\n");
	return f;
}

test("findWorkerSessionFile matches the session_info name", () => {
	const dir = tmpRun();
	try {
		sessionFile(dir, "file-a", "alpha");
		sessionFile(dir, "file-b", "beta");
		assert.equal(findWorkerSessionFile(dir, "alpha")?.endsWith("file-a.jsonl"), true);
		assert.equal(findWorkerSessionFile(dir, "beta")?.endsWith("file-b.jsonl"), true);
		assert.equal(findWorkerSessionFile(dir, "gamma"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("renderSessionLine renders the interesting events", () => {
	assert.equal(renderSessionLine(JSON.stringify({ type: "session_info", name: "calc" })), '· session "calc"');
	assert.equal(renderSessionLine(JSON.stringify({ type: "model_change", provider: "deepseek", modelId: "flash" })), "· model: deepseek/flash");
	const user = renderSessionLine(JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi there" }] } }));
	assert.equal(user, "▸ user: hi there");
	const tool = renderSessionLine(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls -la" } }] } }));
	assert.ok(tool!.startsWith("▶ bash $ ls -la"));
	const text = renderSessionLine(JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done: 42" }] } }));
	assert.equal(text, "◆ done: 42");
	assert.equal(renderSessionLine("garbage"), null);
	assert.equal(renderSessionLine(JSON.stringify({ type: "session" })), null);
});

test("renderSessionTail shows a compact transcript", () => {
	const dir = tmpRun();
	try {
		const f = sessionFile(dir, "calc");
		const out = renderSessionTail(f, 10).split("\n");
		assert.ok(out.includes('· session "calc"'));
		assert.ok(out.some((l) => l.startsWith("▶ read")));
		assert.ok(out[out.length - 1].includes("done: 42"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	finalAssistantText,
	pidAlive,
	renderJsonlLine,
	renderJsonlTail,
	spawnWorkerProcess,
	tailFile,
} from "../src/process.js";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "team-proc-"));
}

test("finalAssistantText picks the last assistant message_end, else last assistant", () => {
	const dir = tmp();
	try {
		const log = join(dir, "w.jsonl");
		writeFileSync(
			log,
			[
				JSON.stringify({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
				JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "interim answer" }] } }),
				JSON.stringify({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "q" }] } }),
				JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } }),
			].join("\n") + "\n",
		);
		assert.equal(finalAssistantText(log), "final answer");

		// no message_end for the last assistant -> fall back to last assistant text
		const log2 = join(dir, "w2.jsonl");
		writeFileSync(
			log2,
			JSON.stringify({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }) + "\n",
		);
		assert.equal(finalAssistantText(log2), "partial");

		assert.equal(finalAssistantText(join(dir, "missing.jsonl")), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("renderJsonlLine renders the interesting events", () => {
	const tool = renderJsonlLine(
		JSON.stringify({
			type: "tool_execution_start",
			name: "bash",
			args: { command: "ls -la /tmp" },
		}),
	);
	assert.ok(tool!.startsWith("▶ bash"));
	assert.ok(tool!.includes("$ ls -la /tmp"));

	const msg = renderJsonlLine(
		JSON.stringify({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done here" }] },
		}),
	);
	assert.equal(msg, "◆ done here");

	assert.equal(renderJsonlLine(JSON.stringify({ type: "agent_settled" })), "■ settled");
	assert.equal(renderJsonlLine(JSON.stringify({ type: "run_start" })), "— run start");
	assert.equal(renderJsonlLine("garbage"), null);
	assert.equal(renderJsonlLine(JSON.stringify({ type: "something_else" })), null);
});

test("renderJsonlTail shows a compact tail", () => {
	const dir = tmp();
	try {
		const log = join(dir, "w.jsonl");
		const lines: string[] = [];
		for (let i = 0; i < 50; i++) {
			lines.push(JSON.stringify({ type: "tool_execution_start", name: "bash", args: { command: `step ${i}` } }));
		}
		lines.push(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "finished" }] } }));
		writeFileSync(log, lines.join("\n") + "\n");

		const out = renderJsonlTail(log, 5).split("\n");
		assert.equal(out.length, 5);
		assert.ok(out[0].includes("step 46"));
		assert.equal(out[4], "◆ finished");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("tailFile returns last N lines", () => {
	const dir = tmp();
	try {
		const f = join(dir, "x.txt");
		writeFileSync(f, "a\nb\nc\nd\ne\n");
		assert.equal(tailFile(f, 2), "d\ne");
		assert.equal(tailFile(join(dir, "nope.txt"), 2), "");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spawnWorkerProcess envBase can strip inherited tmux vars", async () => {
	const dir = tmp();
	try {
		const logPath = join(dir, "w.jsonl");
		const errPath = join(dir, "w.err");
		// Simulate a lead that IS inside tmux, then apply the same strip
		// the lead extension performs before spawning background workers.
		const leadEnv = { ...process.env, TMUX: "/inherited/tmux-socket,42,0.1", TMUX_PANE: "%1" };
		const envBase = { ...leadEnv, TMUX: undefined, TMUX_PANE: undefined };
		const handle = spawnWorkerProcess({
			argv: [
				process.execPath,
				"-e",
				"console.log('TMUX=' + (process.env.TMUX ?? 'EMPTY') + ' NAME=' + (process.env.PI_TEAM_NAME ?? 'NONE'))",
			],
			env: { PI_TEAM_NAME: "w" },
			cwd: dir,
			logPath,
			errPath,
			envBase,
		});
		assert.ok(handle.pid > 0);
		// wait for the child to exit and write its output
		for (let i = 0; i < 100; i++) {
			await new Promise((r) => setTimeout(r, 50));
			if (existsSync(logPath) && tailFile(logPath, 5).includes("TMUX=")) break;
		}
		const out = tailFile(logPath, 5);
		assert.ok(out.includes("TMUX=EMPTY"), `expected TMUX stripped, got: ${out}`);
		assert.ok(out.includes("NAME=w"), `expected merged env, got: ${out}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("pidAlive", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(undefined), false);
	assert.equal(pidAlive(-1), false);
	// 999999 is almost certainly unused
	assert.equal(pidAlive(999999), false);
});

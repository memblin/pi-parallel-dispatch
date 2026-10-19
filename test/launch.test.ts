import { test } from "node:test";
import assert from "node:assert/strict";
import { shellQuote, buildWorkerLaunch, kickoffPrompt, resolvePiCommand } from "../src/launch.js";
import { DEFAULT_CONFIG } from "../src/config.js";

test("shellQuote leaves safe strings bare and quotes the rest", () => {
	assert.equal(shellQuote(""), "''");
	assert.equal(shellQuote("plain"), "plain");
	assert.equal(shellQuote("/tmp/x-y_1.2"), "/tmp/x-y_1.2");
	assert.equal(shellQuote("with space"), "'with space'");
	assert.equal(shellQuote("a'b"), "'a'\\''b'");
	assert.equal(shellQuote("$(rm -rf)"), "'$(rm -rf)'");
	assert.equal(shellQuote("semi;colon"), "'semi;colon'");
});

test("pane command cds to cwd, sets team env, and never inlines the task", () => {
	const launch = buildWorkerLaunch({ command: "pi", prefix: [] }, {
		cwd: "/work/project",
		name: "worker a",
		runId: "run1",
		runDir: "/runs/run1",
		workerExtPath: "/pkg/extensions/worker.ts",
		bootstrapPath: "/runs/run1/prompts/worker a.bootstrap.md",
		taskFile: "/runs/run1/prompts/worker a.md",
		model: "anthropic/claude-sonnet",
		mode: "pane",
	});
	assert.ok(launch.paneCommand.startsWith("cd /work/project && env "));
	assert.ok(launch.paneCommand.includes("PI_TEAM_RUN=run1"));
	assert.ok(launch.paneCommand.includes("PI_TEAM_NAME='worker a'"));
	assert.ok(launch.paneCommand.includes("PI_TEAM_ROLE=worker"));
	assert.ok(launch.paneCommand.includes("PI_TEAM_MODE=pane"));
	assert.ok(launch.paneCommand.includes("--model anthropic/claude-sonnet"));
	assert.ok(launch.paneCommand.includes("-e /pkg/extensions/worker.ts"));
	assert.ok(launch.paneCommand.includes("--append-system-prompt '/runs/run1/prompts/worker a.bootstrap.md'"));
	// pane mode: no prompt on the command line (the extension kicks off)
	assert.ok(!launch.paneCommand.includes("--mode json"));
	assert.ok(!/\s-p\b/.test(launch.paneCommand));
});

test("process mode argv has command first, json mode, and kickoff prompt", () => {
	const launch = buildWorkerLaunch({ command: "pi", prefix: [] }, {
		cwd: "/work",
		name: "w",
		runId: "run1",
		runDir: "/runs/run1",
		workerExtPath: "/e/worker.ts",
		bootstrapPath: "/runs/run1/prompts/w.bootstrap.md",
		taskFile: "/runs/run1/prompts/w.md",
		mode: "process",
	});
	assert.equal(launch.argv[0], "pi");
	assert.ok(launch.argv.includes("--name"));
	assert.equal(launch.argv[launch.argv.indexOf("--name") + 1], "w");
	assert.ok(launch.argv.includes("--session-dir"));
	assert.equal(launch.argv[launch.argv.indexOf("--session-dir") + 1], "/runs/run1/sessions");
	const modeIdx = launch.argv.indexOf("--mode");
	assert.ok(modeIdx > -1);
	assert.equal(launch.argv[modeIdx + 1], "json");
	assert.ok(launch.argv.includes("-p"));
	assert.ok(launch.argv.includes("--approve"));
	assert.equal(launch.argv[launch.argv.length - 1], kickoffPrompt("/runs/run1/prompts/w.md"));
	assert.deepEqual(launch.env.PI_TEAM_MODE, "process");
});

test("thinking level is passed through", () => {
	const launch = buildWorkerLaunch({ command: "pi", prefix: [] }, {
		cwd: "/work",
		name: "w",
		runId: "run1",
		runDir: "/runs/run1",
		workerExtPath: "/e/worker.ts",
		bootstrapPath: "/b.md",
		taskFile: "/t.md",
		thinking: "high",
		mode: "process",
	});
	const i = launch.argv.indexOf("--thinking");
	assert.ok(i > -1);
	assert.equal(launch.argv[i + 1], "high");
});

test("resolvePiCommand honors config.workerCommand", () => {
	const cfg = { ...DEFAULT_CONFIG, workerCommand: "/opt/pi/bin/pi --no-telemetry" };
	const pi = resolvePiCommand(cfg);
	assert.equal(pi.command, "/opt/pi/bin/pi");
	assert.deepEqual(pi.prefix, ["--no-telemetry"]);
});

test("resolvePiCommand falls back to PATH pi for node hosts", () => {
	const cfg = { ...DEFAULT_CONFIG, workerCommand: null };
	const pi = resolvePiCommand(cfg, { execPath: "/usr/bin/node", argv1: "/usr/bin/node" });
	assert.equal(pi.command, "pi");
	assert.deepEqual(pi.prefix, []);
});

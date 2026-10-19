import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeConfig, DEFAULT_CONFIG } from "../src/config.js";

test("mergeConfig with no bases returns defaults", () => {
	const cfg = mergeConfig([]);
	assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("mergeConfig applies overrides in order", () => {
	const cfg = mergeConfig([
		{ backend: "swarm", maxWorkers: 6 },
		{ maxWorkers: 3, leadPanePct: 40 },
	]);
	assert.equal(cfg.backend, "swarm");
	assert.equal(cfg.maxWorkers, 3);
	assert.equal(cfg.leadPanePct, 40);
	// untouched fields keep defaults
	assert.equal(cfg.pollMs, DEFAULT_CONFIG.pollMs);
});

test("mergeConfig clamps numbers and ignores invalid values", () => {
	const cfg = mergeConfig([
		{
			maxWorkers: 999,
			leadPanePct: 5,
			staleAfterSec: 1,
			logTailLines: 10000,
			pollMs: 1,
			backend: "bogus",
			workerCommand: "",
			killWorkersOnExit: "yes",
			teamDir: "   ",
		},
	]);
	assert.equal(cfg.maxWorkers, 16); // clamped to hi
	assert.equal(cfg.leadPanePct, 10); // clamped to lo
	assert.equal(cfg.staleAfterSec, 5); // clamped to lo
	assert.equal(cfg.logTailLines, 500); // clamped to hi
	assert.equal(cfg.pollMs, 250); // clamped to lo
	assert.equal(cfg.backend, "auto"); // invalid ignored
	assert.equal(cfg.workerCommand, null); // empty string ignored
	assert.equal(cfg.killWorkersOnExit, true); // non-bool ignored -> default
	assert.equal(cfg.teamDir, DEFAULT_CONFIG.teamDir); // blank ignored
});

test("mergeConfig accepts valid strings/booleans", () => {
	const cfg = mergeConfig([
		{
			teamDir: "/custom/teams",
			workerCommand: "/opt/pi",
			killWorkersOnExit: false,
			autoDismiss: true,
		},
	]);
	assert.equal(cfg.teamDir, "/custom/teams");
	assert.equal(cfg.workerCommand, "/opt/pi");
	assert.equal(cfg.killWorkersOnExit, false);
	assert.equal(cfg.autoDismiss, true);
});

test("autoDismiss defaults to false and ignores non-boolean", () => {
	const def = mergeConfig([]);
	assert.equal(def.autoDismiss, false);
	const bad = mergeConfig([{ autoDismiss: "yes" }]);
	assert.equal(bad.autoDismiss, false);
});

test("workerLeanStartup defaults true and can be turned off", () => {
	const def = mergeConfig([]);
	assert.equal(def.workerLeanStartup, true);
	assert.equal(mergeConfig([{ workerLeanStartup: false }]).workerLeanStartup, false);
	assert.equal(mergeConfig([{ workerLeanStartup: "no" }]).workerLeanStartup, true); // non-bool ignored
});

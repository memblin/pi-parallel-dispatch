import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRun,
	readRun,
	writeRun,
	addMember,
	findMember,
	memberNames,
	removeMember,
	latestRunDir,
	listRuns,
	removeRun,
	runPaths,
	fmtAge,
	ageSec,
	type Member,
} from "../src/run.js";

function tmpTeam(): string {
	return mkdtempSync(join(tmpdir(), "team-run-"));
}

function sampleMember(name: string): Member {
	return {
		name,
		color: "blue",
		backend: "process",
		cwd: "/tmp",
		joinedAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
	};
}

test("createRun makes the run directory layout and state", () => {
	const teamDir = tmpTeam();
	try {
		const { runId, dir } = createRun(teamDir, "/work");
		assert.ok(existsSync(join(dir, "inboxes")));
		assert.ok(existsSync(join(dir, "logs")));
		assert.ok(existsSync(join(dir, "prompts")));
		assert.ok(existsSync(join(dir, "sessions")));
		const run = readRun(dir);
		assert.ok(run);
		assert.equal(run!.runId, runId);
		assert.equal(run!.cwd, "/work");
		assert.deepEqual(run!.members, []);
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("readRun/writeRun round-trips members", () => {
	const teamDir = tmpTeam();
	try {
		const { dir } = createRun(teamDir, "/work");
		let run = readRun(dir)!;
		addMember(run, { ...sampleMember("a"), model: "anthropic/claude-sonnet" });
		addMember(run, sampleMember("b"));
		writeRun(dir, run);

		run = readRun(dir)!;
		assert.equal(run.members.length, 2);
		assert.equal(findMember(run, "b")!.backend, "process");
		assert.equal(findMember(run, "a")!.model, "anthropic/claude-sonnet");
		assert.equal(memberNames(run).sort().join(","), "a,b");

		removeMember(run, "a");
		writeRun(dir, run);
		assert.equal(readRun(dir)!.members.length, 1);
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("latestRunDir returns the most recent run", () => {
	const teamDir = tmpTeam();
	try {
		const a = createRun(teamDir, "/work", "20250101-000000-aaa");
		const b = createRun(teamDir, "/work", "20250101-000001-bbb");
		assert.equal(latestRunDir(teamDir), b.dir);
		assert.deepEqual(listRuns(teamDir).sort(), [a.runId, b.runId]);
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("removeRun removes the run directory", () => {
	const teamDir = tmpTeam();
	try {
		const { runId, dir } = createRun(teamDir, "/work");
		assert.ok(existsSync(dir));
		removeRun(teamDir, runId);
		assert.ok(!existsSync(dir));
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("readRun returns null on missing/invalid state", () => {
	const teamDir = tmpTeam();
	try {
		assert.equal(readRun(join(teamDir, "nope")), null);
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("runPaths exposes the four subdirs", () => {
	const p = runPaths("/base");
	assert.equal(p.inboxes, join("/base", "inboxes"));
	assert.equal(p.logs, join("/base", "logs"));
	assert.equal(p.prompts, join("/base", "prompts"));
	assert.equal(p.sessions, join("/base", "sessions"));
});

test("fmtAge and ageSec", () => {
	assert.equal(fmtAge(30), "30s");
	assert.equal(fmtAge(125), "2m");
	assert.equal(fmtAge(3600), "1h");
	const now = Date.now();
	assert.equal(ageSec(new Date(now - 5000).toISOString(), now), 5);
	assert.equal(ageSec(undefined, now), 0);
});

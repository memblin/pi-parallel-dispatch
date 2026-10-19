import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	attachableRunDir,
	claimLeadLock,
	createRun,
	leadLockPath,
	readLeadLock,
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

/* ---------------------------------------------------------------------- */
/* Lead ownership: one live lead per run                                  */
/* ---------------------------------------------------------------------- */

function makeLiveMemberRun(teamDir: string, runId: string): string {
	const { dir } = createRun(teamDir, "/work", runId);
	const run = readRun(dir)!;
	addMember(run, sampleMember("w1"));
	writeRun(dir, run);
	return dir;
}

function deadPid(): number {
	const r = spawnSync("true");
	assert.ok(r.pid && r.pid > 0);
	return r.pid;
}

test("createRun claims ownership via lead.lock", () => {
	const teamDir = tmpTeam();
	try {
		const { dir } = createRun(teamDir, "/work");
		const lock = readLeadLock(dir);
		assert.ok(lock);
		assert.equal(lock!.pid, process.pid);
		assert.ok(lock!.at);
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("attachableRunDir skips a run owned by another LIVE lead", () => {
	const teamDir = tmpTeam();
	try {
		// Newest run: owned by a different live process (another lead).
		const foreign = makeLiveMemberRun(teamDir, "20250101-000001-foreign");
		const other = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		other.unref();
		writeFileSync(
			leadLockPath(foreign),
			JSON.stringify({ pid: other.pid, at: new Date().toISOString() }) + "\n",
		);
		// Older run: owned by a dead pid (a restarted lead).
		const mine = makeLiveMemberRun(teamDir, "20250101-000000-mine");
		writeFileSync(
			leadLockPath(mine),
			JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }) + "\n",
		);

		// The newest (foreign, live-locked) run must be skipped; the
		// stale-locked one is attachable.
		assert.equal(attachableRunDir(teamDir), mine);

		// Claiming: stale lock succeeds (and is rewritten), live one refused.
		assert.equal(claimLeadLock(mine), true);
		assert.equal(readLeadLock(mine)!.pid, process.pid);
		assert.equal(claimLeadLock(foreign), false);
		// A run locked by a live process — even ourselves — is not
		// claimable: refusal is holder-agnostic (no re-attach race).
		assert.equal(claimLeadLock(mine), false);

		other.kill("SIGKILL");
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("attachableRunDir handles legacy (lockless) and fully-dismissed runs", () => {
	const teamDir = tmpTeam();
	try {
		// Legacy run: members but no lead.lock (created before the lock).
		const legacy = makeLiveMemberRun(teamDir, "20250101-000000-legacy");
		rmSync(leadLockPath(legacy), { force: true });

		// Fully dismissed run with a live lock: not attachable.
		const done = makeLiveMemberRun(teamDir, "20250101-000001-done");
		const doneRun = readRun(done)!;
		for (const m of doneRun.members) m.dismissed = true;
		writeRun(done, doneRun);

		assert.equal(attachableRunDir(teamDir), legacy);
		assert.equal(claimLeadLock(legacy), true);
		// `done` was created by this process, so its lock is held by a live
		// pid (ours) — not claimable.
		assert.equal(claimLeadLock(done), false);
		// ...and it is never attachable (no live members):
		assert.equal(attachableRunDir(teamDir, new Set([legacy])), null);
	} finally {
		rmSync(teamDir, { recursive: true, force: true });
	}
});

test("fmtAge and ageSec", () => {
	assert.equal(fmtAge(30), "30s");
	assert.equal(fmtAge(125), "2m");
	assert.equal(fmtAge(3600), "1h");
	const now = Date.now();
	assert.equal(ageSec(new Date(now - 5000).toISOString(), now), 5);
	assert.equal(ageSec(undefined, now), 0);
});

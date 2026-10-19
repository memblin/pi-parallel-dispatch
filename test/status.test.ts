import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { send } from "../src/messaging.js";
import type { Member, RunState } from "../src/run.js";
import { deriveMembers } from "../src/status.js";

function tmpTeam(): string {
	return mkdtempSync(join(tmpdir(), "team-status-"));
}

const NOW = Date.parse("2025-01-01T00:00:00Z");

function member(partial: Partial<Member>): Member {
	return {
		name: "w1",
		color: "blue",
		backend: "process",
		cwd: "/tmp",
		pid: process.pid, // alive
		joinedAt: new Date(NOW).toISOString(),
		lastActivity: new Date(NOW).toISOString(),
		...partial,
	};
}

function runWith(...members: Member[]): RunState {
	return {
		runId: "r1",
		createdAt: new Date(NOW).toISOString(),
		cwd: "/tmp",
		members,
	};
}

test("a queued (starting) worker is reported as starting, not running/failed", async () => {
	// No run dir needed: a starting worker has no messages yet.
	const run = runWith(
		member({ name: "w1", backend: "tmux-lead", paneId: "%1", starting: true }),
	);
	const derived = await deriveMembers("/nonexistent-run-dir", run, {
		paneExists: async () => true,
		now: NOW,
	});
	assert.equal(derived[0].status, "starting");
});

test("a persisted failure stays failed even if the placeholder pane is alive", async () => {
	const run = runWith(
		member({ name: "w1", backend: "tmux-lead", paneId: "%1", failed: true }),
	);
	const derived = await deriveMembers("/nonexistent-run-dir", run, {
		paneExists: async () => true,
		now: NOW,
	});
	assert.equal(derived[0].status, "failed");
});

test("live pane, no result, no failure -> running", async () => {
	const run = runWith(member({ name: "w1", backend: "tmux-lead", paneId: "%1" }));
	const derived = await deriveMembers("/nonexistent-run-dir", run, {
		paneExists: async () => true,
		now: NOW,
	});
	assert.equal(derived[0].status, "running");
});

test("gone pane without a result -> failed (and persisted on the member)", async () => {
	const m = member({ name: "w1", backend: "tmux-lead", paneId: "%1" });
	const run = runWith(m);
	const derived = await deriveMembers("/nonexistent-run-dir", run, {
		paneExists: async () => false,
		now: NOW,
	});
	assert.equal(derived[0].status, "failed");
	assert.equal(m.failed, true);
});

test("idle after an idle report; done after a result (even with a dead pane)", async () => {
	const dir = tmpTeam();
	try {
		send(dir, "w1", "lead", "idle", "turn complete");
		const idleRun = runWith(member({ name: "w1", backend: "process" }));
		const idleDerived = await deriveMembers(dir, idleRun, { now: NOW });
		assert.equal(idleDerived[0].status, "idle");

		send(dir, "w1", "lead", "result", "the answer is 42");
		const doneRun = runWith(member({ name: "w1", backend: "process", pid: 4194304 }));
		const doneDerived = await deriveMembers(dir, doneRun, { now: NOW });
		assert.equal(doneDerived[0].status, "done");
		assert.equal(doneDerived[0].result, "the answer is 42");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

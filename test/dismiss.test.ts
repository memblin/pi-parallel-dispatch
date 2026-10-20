import { test } from "node:test";
import assert from "node:assert/strict";
import type { Member } from "../src/run.js";
import type { WorkerStatus } from "../src/status.js";
import { decideDismiss, isLiveStatus, renderDismissResult } from "../src/dismiss.js";

/**
 * Issue #4: `team_dismiss` used to treat an omitted (or misspelled, so
 * effectively omitted) `name` as "dismiss everyone" and kill live workers.
 * These tests pin the refusal contract.
 */

const TS = new Date("2026-01-01T00:00:00Z").toISOString();

function m(name: string, extra: Partial<Member> = {}): Member {
	return {
		name,
		color: "blue",
		backend: "process",
		cwd: "/tmp",
		pid: 1234,
		joinedAt: TS,
		lastActivity: TS,
		...extra,
	};
}

/** Status/age map helper from [name, status] pairs. */
function statuses(...pairs: [string, WorkerStatus][]) {
	const map = new Map<string, WorkerStatus>(pairs);
	return {
		statusOf: (n: string) => map.get(n),
		ageOf: (n: string) => (map.get(n) === undefined ? 0 : 30),
	};
}

test("an omitted name dismisses nothing and lists the roster", () => {
	const members = [m("tui-impl"), m("as-audit")];
	const d = decideDismiss({ members, name: undefined, ...statuses(["tui-impl", "running"], ["as-audit", "done"]) });
	assert.equal(d.ok, false);
	if (!d.ok) {
		assert.match(d.error, /needs an explicit target/);
		assert.match(d.error, /tui-impl \(running\)/);
		assert.match(d.error, /as-audit \(done\)/);
		assert.match(d.error, /Nothing was dismissed/);
	}
});

test("a whitespace name is the same refusal as an omitted one", () => {
	const d = decideDismiss({ members: [m("w1")], name: "   " });
	assert.equal(d.ok, false);
});

test('"all" is the only way to dismiss the whole team', () => {
	const members = [m("w1"), m("w2", { dismissed: true })];
	const d = decideDismiss({ members, name: "all", force: true, ...statuses(["w1", "running"]) });
	assert.equal(d.ok, true);
	if (d.ok) {
		assert.equal(d.all, true);
		assert.deepEqual(d.targets.map((t) => t.name), ["w1"]);
	}
});

test('"ALL" is matched case-insensitively', () => {
	const d = decideDismiss({ members: [m("w1")], name: "ALL", force: true, ...statuses(["w1", "idle"]) });
	assert.equal(d.ok, true);
});

test("an unknown worker name refuses with the live roster", () => {
	const d = decideDismiss({ members: [m("merge-review")], name: "as-audit", ...statuses(["merge-review", "done"]) });
	assert.equal(d.ok, false);
	if (!d.ok) {
		assert.match(d.error, /unknown worker "as-audit"/);
		assert.match(d.error, /merge-review \(done\)/);
	}
});

test("a live worker is refused without force, naming it and its age", () => {
	const d = decideDismiss({ members: [m("as-audit")], name: "as-audit", ...statuses(["as-audit", "running"]) });
	assert.equal(d.ok, false);
	if (!d.ok) {
		assert.match(d.error, /refused/);
		assert.match(d.error, /as-audit \(running, active 30s ago\)/);
		assert.match(d.error, /force=true/);
	}
});

test("starting and idle are live; done and failed are not", () => {
	for (const s of ["starting", "running", "idle"] as WorkerStatus[]) {
		assert.equal(isLiveStatus(s), true, `${s} must count as live`);
		const d = decideDismiss({ members: [m("w1")], name: "w1", ...statuses(["w1", s]) });
		assert.equal(d.ok, false, `dismiss of a ${s} worker must be refused`);
	}
	for (const s of ["done", "failed"] as WorkerStatus[]) {
		assert.equal(isLiveStatus(s), false, `${s} must not count as live`);
		const d = decideDismiss({ members: [m("w1")], name: "w1", ...statuses(["w1", s]) });
		assert.equal(d.ok, true, `dismiss of a ${s} worker is plain cleanup`);
	}
});

test("force=true lets a live worker through and records it as forced", () => {
	const members = [m("as-audit"), m("merge-review")];
	const d = decideDismiss({
		members,
		name: "all",
		force: true,
		...statuses(["as-audit", "running"], ["merge-review", "done"]),
	});
	assert.equal(d.ok, true);
	if (d.ok) {
		assert.deepEqual(d.forced.map((x) => x.name), ["as-audit"]);
		assert.equal(d.targets.length, 2);
	}
});

test("already-dismissed workers are not targets", () => {
	const d = decideDismiss({ members: [m("w1", { dismissed: true })], name: "w1" });
	assert.equal(d.ok, false);
	if (!d.ok) assert.match(d.error, /already dismissed/);
	const all = decideDismiss({ members: [m("w1", { dismissed: true })], name: "all" });
	assert.equal(all.ok, false);
	if (!all.ok) assert.match(all.error, /no workers to dismiss/);
});

test("one target is reported as one worker", () => {
	const text = renderDismissResult([m("w1")], { all: false, forced: [], remaining: 1 });
	assert.match(text, /^Dismissed 1 worker: w1\./);
	assert.match(text, /1 worker\(s\) still on the roster/);
});

test("a multi-worker dismiss says how many and offers recovery", () => {
	const text = renderDismissResult([m("a"), m("b"), m("c")], { all: true, forced: [], remaining: 0 });
	assert.match(text, /Dismissed 3 workers — the WHOLE TEAM: a, b, c/);
	assert.match(text, /If you only meant one worker/);
});

test("killing live workers with force is announced in the result", () => {
	const text = renderDismissResult([m("a"), m("b")], { all: true, forced: [m("a")], remaining: 0 });
	assert.match(text, /WARNING: 1 of them were still live and were stopped mid-task: a/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { TmuxBackend } from "../src/tmux.js";
import type { ExecFn, ExecResult } from "../src/exec.js";

/**
 * A tiny in-memory tmux: tracks pane geometry so split-window behaves
 * like the real thing (a -h split puts the new pane to the RIGHT of the
 * target; a -v split puts it BELOW). The lead is %5 in window @3.
 */
interface FakePane {
	id: string;
	left: number;
	top: number;
}

function makeFakeTmux(initial: FakePane[], swarm = false) {
	const panes = [...initial];
	let nextId = 100;
	let sessionExists = false;
	const splits: { args: string[] }[] = [];
	const exec: ExecFn = async (_cmd, args): Promise<ExecResult> => {
		const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
		if (args.includes("display-message") && args.includes("#{pane_id}"))
			return ok(panes[0]!.id + "\n");
		if (args.includes("display-message") && args.includes("#{window_id}")) return ok("@3\n");
		if (args.includes("has-session"))
			return swarm && sessionExists ? ok() : { code: 1, stdout: "", stderr: "" };
		if (args.includes("new-session")) {
			sessionExists = true;
			return ok(panes[0]!.id + "\n");
		}
		if (args.includes("list-windows")) return ok(swarm ? "team-view\n" : "\n");
		if (args.includes("list-panes")) {
			const geom = args.some((a) => a.includes("#{pane_left}"));
			return ok(
				panes.map((p) => (geom ? `${p.id}\t${p.left}\t${p.top}` : p.id)).join("\n") + "\n",
			);
		}
		if (args.includes("split-window")) {
			splits.push({ args });
			const t = args[args.indexOf("-t") + 1]!;
			const target = panes.find((p) => p.id === t)!;
			const id = `%${nextId++}`;
			// horizontal split -> new pane right of target; vertical -> below
			if (args.includes("-h")) panes.push({ id, left: target.left + 71, top: 0 });
			else panes.push({ id, left: target.left, top: target.top + 24 });
			return ok(id + "\n");
		}
		return ok();
	};
	return { exec, panes, splits };
}

const leadEnv = { TMUX: "/tmp/tmux-sock,1,0.0", TMUX_PANE: "%5" };

test("with-leader: exactly one horizontal split; later workers stack -v in the column", async () => {
	const { exec, splits } = makeFakeTmux([{ id: "%5", left: 0, top: 0 }]);
	const be = new TmuxBackend(exec, leadEnv, 30, "r1");
	for (let i = 0; i < 3; i++) {
		const r = await be.spawnInside();
		assert.ok(r.ok, JSON.stringify(r));
	}
	const h = splits.filter((s) => s.args.includes("-h"));
	const v = splits.filter((s) => s.args.includes("-v"));
	assert.equal(h.length, 1, "the lead pane must be split horizontally exactly once");
	assert.equal(v.length, 2, "further workers must stack with vertical splits");
	// the vertical splits never target the lead pane
	for (const s of v) assert.notEqual(s.args[s.args.indexOf("-t") + 1], "%5");
});

test("with-leader: concurrent spawns are serialized — a burst still produces ONE -h split", async () => {
	const { exec, splits } = makeFakeTmux([{ id: "%5", left: 0, top: 0 }]);
	const be = new TmuxBackend(exec, leadEnv, 30, "r1");
	// simulate pi running three team_spawn tool calls concurrently
	const results = await Promise.all([be.spawnInside(), be.spawnInside(), be.spawnInside()]);
	for (const r of results) assert.ok(r.ok, JSON.stringify(r));
	const h = splits.filter((s) => s.args.includes("-h"));
	assert.equal(h.length, 1, "burst must not carve the lead pane once per worker");
	assert.equal(splits.length, 3);
	assert.deepEqual(
		splits.map((s) => (s.args.includes("-h") ? "h" : "v")),
		["h", "v", "v"],
		"first split horizontal, rest vertical",
	);
});

test("with-leader: a window that already has a right-hand pane never gets another -h split", async () => {
	// lead already shares its window with a pane to the right (user's own
	// layout, or workers spawned before a pi restart)
	const { exec, splits } = makeFakeTmux([
		{ id: "%5", left: 0, top: 0 },
		{ id: "%9", left: 71, top: 0 },
	]);
	const be = new TmuxBackend(exec, leadEnv, 30, "r1");
	const r = await be.spawnInside();
	assert.ok(r.ok, JSON.stringify(r));
	assert.equal(splits.length, 1);
	assert.ok(splits[0]!.args.includes("-v"), "must stack, not split the lead again");
	assert.equal(splits[0]!.args[splits[0]!.args.indexOf("-t") + 1], "%9");
});

test("with-leader: stacks below the BOTTOM-most column pane, not the newest index", async () => {
	const { exec, splits } = makeFakeTmux([
		{ id: "%5", left: 0, top: 0 },
		{ id: "%6", left: 71, top: 0 },
		{ id: "%7", left: 71, top: 24 },
	]);
	const be = new TmuxBackend(exec, leadEnv, 30, "r1");
	const r = await be.spawnInside();
	assert.ok(r.ok, JSON.stringify(r));
	const t = splits[0]!.args[splits[0]!.args.indexOf("-t") + 1];
	assert.equal(t, "%7", "newest pane goes under the column tail");
});

test("external swarm: concurrent spawns are serialized too", async () => {
	const { exec, panes, splits } = makeFakeTmux([{ id: "%5", left: 0, top: 0 }], true);
	const be = new TmuxBackend(exec, {}, 30, "r1");
	// burst of three concurrent team_spawn calls against the external swarm
	const results = await Promise.all([be.spawnExternal(), be.spawnExternal(), be.spawnExternal()]);
	for (const r of results) assert.ok(r.ok, JSON.stringify(r));
	// first worker reuses the initial pane; the other two create splits, no throw
	assert.equal(panes.length, 3);
	assert.equal(splits.length, 2);
});

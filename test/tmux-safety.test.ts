import { test } from "node:test";
import assert from "node:assert/strict";
import { TmuxBackend, swarmSocketName } from "../src/tmux.js";
import type { ExecFn } from "../src/exec.js";

interface Call {
	cmd: string;
	args: string[];
}

type Response = { code: number; stdout: string; stderr: string };

function makeBackend(
	env: Record<string, string | undefined>,
	calls: Call[],
	responder?: (args: string[]) => Response,
	runId = "run1",
) {
	const exec: ExecFn = async (cmd, args, _opts) => {
		calls.push({ cmd, args });
		if (responder) return responder(args);
		return { code: 0, stdout: "", stderr: "" };
	};
	return new TmuxBackend(exec, env, 30, runId);
}

test("every inside-mode command is scoped to the lead's own socket (-S)", async () => {
	const socket = "/tmp/tmux-1000/default";
	const calls: Call[] = [];
	const responder = (args: string[]): Response => {
		// detect
		if (args.includes("display-message") && args.includes("#{pane_id}"))
			return { code: 0, stdout: "%5\n", stderr: "" };
		if (args.includes("display-message") && args.includes("#{window_id}"))
			return { code: 0, stdout: "@3\n", stderr: "" };
		// first split: only the lead pane exists
		if (args.includes("list-panes")) return { code: 0, stdout: "%5\n", stderr: "" };
		if (args.includes("split-window")) return { code: 0, stdout: "%6\n", stderr: "" };
		return { code: 0, stdout: "", stderr: "" };
	};
	const b = makeBackend({ TMUX: `${socket},123,0.0`, TMUX_PANE: "%5" }, calls, responder);
	const res = await b.spawnInside();
	assert.ok(res.ok, JSON.stringify(res));
	assert.equal(res.ok && res.paneId, "%6");

	assert.ok(calls.length > 0);
	for (const c of calls) {
		assert.equal(c.cmd, "tmux");
		// socket flag must come first and point at the lead's server
		assert.equal(c.args[0], "-S");
		assert.equal(c.args[1], socket);
	}
});

test("refuses to run any command when inside tmux but the socket is unknown (fail closed)", async () => {
	const calls: Call[] = [];
	// TMUX is set (so we consider ourselves inside) but the socket path is empty.
	const b = makeBackend({ TMUX: ",123,0.0", TMUX_PANE: "%5" }, calls);
	await assert.rejects(
		b.spawnInside(),
		/(socket|refus)/i,
	);
	// No command may ever hit the default socket.
	assert.equal(calls.length, 0);
});

test("swarm cleanup only touches the run's private socket (-L)", async () => {
	const calls: Call[] = [];
	// Session is gone: listPanes fails, has-session fails -> no kill-session.
	const b = makeBackend({}, calls, (args) =>
		args.includes("has-session")
			? { code: 1, stdout: "", stderr: "no session" }
			: { code: 1, stdout: "", stderr: "no window" },
	);
	await b.killSwarmSession();
	assert.ok(calls.length >= 1);
	for (const c of calls) {
		assert.equal(c.args[0], "-L");
		assert.equal(c.args[1], swarmSocketName("run1"));
	}
	assert.ok(!calls.some((c) => c.args.includes("kill-session")));

	// Session still exists: it gets killed, but on the private socket only.
	const calls2: Call[] = [];
	const b2 = makeBackend({}, calls2, (args) =>
		args.includes("has-session")
			? { code: 0, stdout: "", stderr: "" }
			: { code: 1, stdout: "", stderr: "no window" },
	);
	await b2.killSwarmSession();
	for (const c of calls2) {
		assert.equal(c.args[0], "-L");
		assert.equal(c.args[1], swarmSocketName("run1"));
	}
	const kill = calls2.find((c) => c.args.includes("kill-session"));
	assert.ok(kill);
	assert.equal(kill!.args[kill!.args.indexOf("kill-session") + 1], "-t");
	assert.equal(kill!.args[kill!.args.indexOf("kill-session") + 2], "pi-team");
});

test("stopWorker refuses a pane that no longer lives in our window", async () => {
	const calls: Call[] = [];
	// The pane id now resolves to a different window (@9) than the one we
	// recorded at spawn (@7).
	const b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, (args) =>
		args.includes("display-message") && args.includes("#{window_id}")
			? { code: 0, stdout: "@9\n", stderr: "" }
			: { code: 0, stdout: "", stderr: "" },
	);
	const ok = await b.stopWorker("%9", true, "@7");
	assert.equal(ok, false);
	assert.ok(
		!calls.some((c) => c.args.includes("kill-pane")),
		"kill-pane must never be issued",
	);
	assert.ok(
		!calls.some((c) => c.args.includes("#{pane_pid}")),
		"must not even resolve the pane pid on ownership mismatch",
	);
});

test("stopWorker kills the pane process (no kill-pane) and reports the pane gone", async () => {
	const { spawn } = await import("node:child_process");
	const sleep = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	sleep.unref();
	const pid = sleep.pid!;
	let killCount = 0;
	const calls: Call[] = [];
	const b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, (args) => {
		if (args.includes("display-message")) {
			if (args.includes("#{window_id}")) return { code: 0, stdout: "@7\n", stderr: "" };
			if (args.includes("#{pane_pid}")) {
				// After the kill round, tmux reports an empty pane_pid (gone).
				killCount++;
				return killCount < 3
					? { code: 0, stdout: `${pid}\n`, stderr: "" }
					: { code: 0, stdout: "", stderr: "" };
			}
			if (args.includes("#{pane_dead}")) return { code: 1, stdout: "", stderr: "can't find pane" };
		}
		return { code: 0, stdout: "", stderr: "" };
	});
	const ok = await b.stopWorker("%9", true, "@7");
	assert.equal(ok, true);
	assert.ok(!calls.some((c) => c.args.includes("kill-pane")));
	// give the signal a moment
	await new Promise((r) => setTimeout(r, 300));
	const { pidAlive } = await import("../src/process.js");
	assert.equal(pidAlive(pid), false, "pane process must be dead");
});

test("stopWorker returns true immediately when the pane is already gone", async () => {
	const calls: Call[] = [];
	const b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, () => ({
		code: 1,
		stdout: "",
		stderr: "can't find pane: %9",
	}));
	const ok = await b.stopWorker("%9", true, "@7");
	assert.equal(ok, true);
	assert.equal(calls.length, 1); // only the window check
});

test("stopWorker in swarm mode skips the window check and uses the private socket", async () => {
	const calls: Call[] = [];
	let pidCount = 0;
	const b = makeBackend({}, calls, (args) => {
		if (args.includes("#{pane_pid}")) {
			pidCount++;
			return pidCount < 3
				? { code: 0, stdout: "999999\n", stderr: "" }
				: { code: 0, stdout: "", stderr: "" };
		}
		if (args.includes("#{pane_dead}")) return { code: 1, stdout: "", stderr: "gone" };
		return { code: 0, stdout: "", stderr: "" };
	});
	const ok = await b.stopWorker("%4", false);
	assert.equal(ok, true);
	assert.ok(!calls.some((c) => c.args.includes("#{window_id}")));
	for (const c of calls) assert.equal(c.args[0], "-L");
});

test("startWorker rejects commands with control characters", async () => {
	const calls: Call[] = [];
	const b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls);
	await assert.rejects(
		b.startWorker("%9", "evil\r\n$(rm -rf /)", true),
		/control characters/,
	);
	assert.equal(calls.length, 0);
});

test("stopWorker clears remain-on-exit and reaps a lingering dead pane with a zero-exit respawn", async () => {
	const { spawnSync } = await import("node:child_process");
	const deadPid = spawnSync("true").pid!; // definitely exited
	let respawned = false;
	const calls: Call[] = [];
	const b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, (args) => {
		if (args.includes("display-message")) {
			if (args.includes("#{window_id}")) return { code: 0, stdout: "@7\n", stderr: "" };
			if (args.includes("#{pane_pid}")) {
				// Before the reap it is the dead (crashed) worker's stale pid;
				// after the zero-exit respawn the pane is gone (empty pid).
				return respawned
					? { code: 0, stdout: "", stderr: "" }
					: { code: 0, stdout: `${deadPid}\n`, stderr: "" };
			}
			if (args.includes("#{pane_dead}"))
				return respawned
					? { code: 1, stdout: "", stderr: "gone" }
					: { code: 0, stdout: "1\n", stderr: "" };
		}
		if (args.includes("respawn-pane")) respawned = true;
		return { code: 0, stdout: "", stderr: "" };
	});
	const ok = await b.stopWorker("%9", true, "@7");
	assert.equal(ok, true);
	// remain-on-exit must be cleared before the kill, so the pane does not
	// survive as a dead remnant on an intentional stop.
	const offIdx = calls.findIndex(
		(c) => c.args.includes("remain-on-exit") && c.args[c.args.length - 1] === "off",
	);
	assert.ok(offIdx > 0, "remain-on-exit off must be issued");
	// The lingering corpse is reaped with a zero-exit no-op — never kill-pane.
	const respawn = calls.find((c) => c.args.includes("respawn-pane"));
	assert.ok(respawn, "respawn-pane must be issued for the corpse");
	assert.equal(respawn!.args[respawn!.args.length - 1], "true");
	assert.ok(!calls.some((c) => c.args.includes("kill-pane")));
});

test("paneExists: alive pane true, dead (remain-on-exit) pane false, gone pane false", async () => {
	// alive
	let calls: Call[] = [];
	let b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, () => ({ code: 0, stdout: "0\n", stderr: "" }));
	assert.equal(await b.paneExists("%1", true), true);

	// dead pane (crashed worker left by remain-on-exit failed)
	calls = [];
	b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, () => ({ code: 0, stdout: "1\n", stderr: "" }));
	assert.equal(await b.paneExists("%2", true), false);

	// pane gone (server restarted / pane closed)
	calls = [];
	b = makeBackend({ TMUX: "/tmp/s,1,0.0" }, calls, () => ({ code: 1, stdout: "", stderr: "can't find pane" }));
	assert.equal(await b.paneExists("%3", true), false);
});

test("swarmSessionExists reflects has-session on the private socket", async () => {
	let calls: Call[] = [];
	let b = makeBackend({}, calls, () => ({ code: 0, stdout: "", stderr: "" }));
	assert.equal(await b.swarmSessionExists(), true);
	calls = [];
	b = makeBackend({}, calls, () => ({ code: 1, stdout: "", stderr: "no session" }));
	assert.equal(await b.swarmSessionExists(), false);
	assert.ok(calls[0].args[0] === "-L");
});

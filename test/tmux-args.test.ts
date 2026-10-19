import { test } from "node:test";
import assert from "node:assert/strict";
import { tmuxArgs, swarmSocketName, swarmAttachHint, SWARM_SESSION, SWARM_WINDOW } from "../src/tmux.js";

test("swarm session/window/socket naming", () => {
	assert.equal(SWARM_SESSION, "pi-team");
	assert.equal(SWARM_WINDOW, "team-view");
	assert.equal(swarmSocketName("20250101-000000-abc"), "pi-team-20250101-000000-abc");
	assert.equal(swarmAttachHint("r1"), "tmux -L pi-team-r1 attach -t pi-team");
});

test("newSwarmSession creates a detached window with cat placeholder", () => {
	assert.deepEqual(tmuxArgs.newSwarmSession("pi-team", "team-view"), [
		"new-session", "-d", "-s", "pi-team", "-n", "team-view",
		"-P", "-F", "#{pane_id}", "--", "cat",
	]);
});

test("splitFirstFromLead targets the bare lead pane id with 70% width", () => {
	assert.deepEqual(tmuxArgs.splitFirstFromLead("%7"), [
		"split-window", "-d", "-t", "%7", "-h", "-l", "70%",
		"-P", "-F", "#{pane_id}", "--", "cat",
	]);
});

test("splitFromPane alternates vertical/horizontal", () => {
	assert.deepEqual(tmuxArgs.splitFromPane("%8", true), [
		"split-window", "-d", "-t", "%8", "-v", "-P", "-F", "#{pane_id}", "--", "cat",
	]);
	assert.deepEqual(tmuxArgs.splitFromPane("%8", false), [
		"split-window", "-d", "-t", "%8", "-h", "-P", "-F", "#{pane_id}", "--", "cat",
	]);
});

test("layout helpers target window/pane ids", () => {
	assert.deepEqual(tmuxArgs.selectLayout("@3", "main-vertical"), ["select-layout", "-t", "@3", "main-vertical"]);
	assert.deepEqual(tmuxArgs.selectLayout("pi-team:0", "tiled"), ["select-layout", "-t", "pi-team:0", "tiled"]);
	assert.deepEqual(tmuxArgs.resizeLeadPane("%7", 30), ["resize-pane", "-t", "%7", "-x", "30%"]);
});

test("start-worker sequence: remain-on-exit then respawn with -- <cmd>", () => {
	assert.deepEqual(tmuxArgs.setRemainOnExit("%9"), [
		"set-option", "-p", "-t", "%9", "remain-on-exit", "failed",
	]);
	assert.deepEqual(tmuxArgs.respawnPane("%9", "cd /x && env A=b pi"), [
		"respawn-pane", "-k", "-t", "%9", "--", "cd /x && env A=b pi",
	]);
});

test("decoration commands (no select-pane: must not change the active pane)", () => {
	assert.deepEqual(tmuxArgs.paneBorderColor("%9", "red")[0], [
		"set-option", "-p", "-t", "%9", "window-style", "bg=default,fg=red",
	]);
	assert.deepEqual(tmuxArgs.paneBorderFormat("%9", "blue", "researcher"), [
		"set-option", "-p", "-t", "%9", "pane-border-format",
		"#[fg=blue,bold] researcher #[default]",
	]);
	// no command builder may use select-pane (it activates the pane)
	const all = Object.values(tmuxArgs);
	for (const fn of all) {
		const out = (fn as (...a: unknown[]) => unknown)("%9", "x", "y");
		const lists: unknown[] = Array.isArray(out) ? [out] : (out as unknown[]);
		for (const l of lists) {
			assert.ok(
				!(l as string[]).includes("select-pane"),
				"select-pane would activate the worker pane in the user's window",
			);
		}
	}
});

test("kill-session exists but kill-pane and capture-pane builders are gone", () => {
	assert.deepEqual(tmuxArgs.killSession("pi-team"), ["kill-session", "-t", "pi-team"]);
	// These commands abort the tmux server on some builds; the package
	// must not have builders that make them easy to call.
	assert.equal("killPane" in tmuxArgs, false);
	assert.equal("capturePane" in tmuxArgs, false);
});

test("pane_pid / pane_dead resolution helpers", () => {
	assert.deepEqual(tmuxArgs.panePid("%9"), ["display-message", "-t", "%9", "-p", "#{pane_pid}"]);
	assert.deepEqual(tmuxArgs.paneDead("%9"), ["display-message", "-t", "%9", "-p", "#{pane_dead}"]);
});

test("display-message helpers target the lead's own pane by default", () => {
	assert.deepEqual(tmuxArgs.paneIdOf(), ["display-message", "-p", "#{pane_id}"]);
	assert.deepEqual(tmuxArgs.windowIdOf("%5"), ["display-message", "-t", "%5", "-p", "#{window_id}"]);
});

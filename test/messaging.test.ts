import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	send,
	readInbox,
	inboxSize,
	inboxPath,
	priorityOf,
	levelOf,
	formatPriorityHeader,
	wakeDelivery,
} from "../src/messaging.js";

function tmpRun(): string {
	const dir = mkdtempSync(join(tmpdir(), "team-msg-"));
	return dir;
}

test("send appends to recipient inbox; readInbox reads with cursor", () => {
	const runDir = tmpRun();
	try {
		send(runDir, "lead", "worker-a", "task", "do the thing");
		send(runDir, "lead", "worker-a", "info", "a hint");
		send(runDir, "lead", "worker-b", "task", "other thing");

		const all = readInbox(runDir, "worker-a", 0);
		assert.equal(all.messages.length, 2);
		assert.equal(all.messages[0].from, "lead");
		assert.equal(all.messages[0].type, "task");
		assert.equal(all.messages[1].body, "a hint");

		// cursor-based: nothing new
		const none = readInbox(runDir, "worker-a", all.cursor);
		assert.equal(none.messages.length, 0);
		assert.equal(none.cursor, all.cursor);

		// one more message -> exactly one new
		send(runDir, "worker-b", "worker-a", "info", "ping");
		const one = readInbox(runDir, "worker-a", all.cursor);
		assert.equal(one.messages.length, 1);
		assert.equal(one.messages[0].from, "worker-b");

		// other member's inbox unaffected (one task + nothing else)
		const b = readInbox(runDir, "worker-b", 0);
		assert.equal(b.messages.length, 1);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("readInbox skips malformed lines", () => {
	const runDir = tmpRun();
	try {
		const p = inboxPath(runDir, "worker-a");
		mkdirSync(join(runDir, "inboxes"), { recursive: true });
		writeFileSync(
			p,
			'{"id":"x1","from":"lead","to":"worker-a","type":"info","ts":"2025-01-01T00:00:00.000Z","body":"one"}\n' +
				"not-json\n" +
				'{"id":"x2","from":"lead","to":"worker-a","type":"info","ts":"2025-01-01T00:00:01.000Z","body":"two"}\n',
		);
		const { messages, cursor } = readInbox(runDir, "worker-a", 0);
		assert.equal(messages.length, 2);
		assert.equal(messages[1].body, "two");
		assert.ok(cursor > 0);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("inboxSize returns file size or 0", () => {
	const runDir = tmpRun();
	try {
		assert.equal(inboxSize(runDir, "worker-a"), 0);
		send(runDir, "lead", "worker-a", "info", "hello");
		assert.ok(inboxSize(runDir, "worker-a") > 0);
		assert.ok(existsSync(inboxPath(runDir, "worker-a")));
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("readInbox on missing inbox returns empty", () => {
	const runDir = tmpRun();
	try {
		const r = readInbox(runDir, "nobody", 0);
		assert.equal(r.messages.length, 0);
		assert.equal(r.cursor, 0);
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("priority/level defaults derive from message type", () => {
	assert.equal(priorityOf({ type: "result" }), "next");
	assert.equal(levelOf({ type: "result" }), "info");
	assert.equal(priorityOf({ type: "idle" }), "later");
	assert.equal(priorityOf({ type: "status" }), "now");
	assert.equal(levelOf({ type: "status" }), "warning");
	assert.equal(levelOf({ type: "info" }), "assist");
	assert.equal(priorityOf({ type: "dismiss" }), "next");
});

test("send carries explicit priority/level; readInbox round-trips them", () => {
	const runDir = tmpRun();
	try {
		send(runDir, "worker-a", "lead", "info", "GPU is on fire", {
			priority: "now",
			level: "critical",
		});
		const { messages } = readInbox(runDir, "lead", 0);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].priority, "now");
		assert.equal(messages[0].level, "critical");
		assert.equal(formatPriorityHeader(messages[0]), "[priority=now level=critical]");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("readInbox drops unknown priority/level values so defaults apply", () => {
	const runDir = tmpRun();
	try {
		const p = inboxPath(runDir, "worker-a");
		mkdirSync(join(runDir, "inboxes"), { recursive: true });
		writeFileSync(
			p,
			'{"from":"lead","to":"worker-a","type":"result","ts":"2025-01-01T00:00:00.000Z","body":"ok","priority":"urgent","level":"yell"}\n',
		);
		const { messages } = readInbox(runDir, "worker-a", 0);
		assert.equal(messages.length, 1);
		assert.equal(messages[0].priority, undefined);
		assert.equal(priorityOf(messages[0]), "next"); // default for result
		assert.equal(formatPriorityHeader(messages[0]), "[priority=next level=info]");
	} finally {
		rmSync(runDir, { recursive: true, force: true });
	}
});

test("wakeDelivery maps priority tiers to pi modes", () => {
	assert.equal(wakeDelivery("now", "followUp"), "steer"); // urgency cannot be configured away
	assert.equal(wakeDelivery("next", "followUp"), "followUp"); // config controls the middle tier
	assert.equal(wakeDelivery("next", "steer"), "steer");
	assert.equal(wakeDelivery("later", "steer"), "followUp"); // informative never interrupts
});

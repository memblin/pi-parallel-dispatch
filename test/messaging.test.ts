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

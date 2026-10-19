import { test } from "node:test";
import assert from "node:assert/strict";
import { LaunchQueue } from "../src/launchqueue.js";

const T0 = 1_000_000;

interface Ctx {
	now: number;
	started: Array<{ id: string; at: number }>;
	delays: number[];
	/** Called per item; may throw. */
	start: (item: { id: string }) => Promise<void>;
}

function makeCtx(overrides?: Partial<Ctx>): Ctx {
	return {
		now: T0,
		started: [],
		delays: [],
		start: async () => {},
		...overrides,
	};
}

function makeQueue(ctx: Ctx, staggerMs: number): LaunchQueue<{ id: string }> {
	return new LaunchQueue<{ id: string }>({
		staggerMs,
		now: () => ctx.now,
		delay: async (ms) => {
			ctx.delays.push(ms);
			ctx.now += ms;
		},
		start: async (item) => {
			ctx.started.push({ id: item.id, at: ctx.now });
			await ctx.start(item);
		},
	});
}

/** The fake delay never really waits, so the pump finishes in a tick. */
async function settle(q: LaunchQueue<{ id: string }>): Promise<void> {
	for (let i = 0; i < 20 && q.pending > 0; i++) {
		await new Promise((r) => setTimeout(r, 2));
	}
	await new Promise((r) => setTimeout(r, 10));
}

test("a burst of 4 starts at 0 / stagger / 2*stagger / 3*stagger", async () => {
	const ctx = makeCtx();
	const q = makeQueue(ctx, 15000);
	for (const id of ["a", "b", "c", "d"]) q.enq({ id });
	await settle(q);
	assert.deepEqual(ctx.started.map((s) => s.id), ["a", "b", "c", "d"]);
	assert.deepEqual(
		ctx.started.map((s) => s.at - T0),
		[0, 15000, 30000, 45000],
	);
});

test("a lone spawn while idle is never delayed", async () => {
	const ctx = makeCtx();
	const q = makeQueue(ctx, 15000);
	q.enq({ id: "solo" });
	await settle(q);
	assert.equal(ctx.started.length, 1);
	assert.equal(ctx.started[0].at, T0);
	assert.deepEqual(ctx.delays, []);
});

test("a spawn 10s after the last start waits the remaining stagger", async () => {
	const ctx = makeCtx();
	const q = makeQueue(ctx, 15000);
	q.enq({ id: "first" });
	await settle(q);
	ctx.now = T0 + 10000;
	q.enq({ id: "second" });
	await settle(q);
	assert.equal(ctx.started[1].at, T0 + 15000);
});

test("a spawn longer than the stagger after the last start is immediate", async () => {
	const ctx = makeCtx();
	const q = makeQueue(ctx, 15000);
	q.enq({ id: "first" });
	await settle(q);
	ctx.now = T0 + 20000;
	q.enq({ id: "second" });
	await settle(q);
	assert.equal(ctx.started[1].at, T0 + 20000);
	assert.deepEqual(ctx.delays, []);
});

test("staggerMs 0 disables staggering (back-to-back starts)", async () => {
	const ctx = makeCtx();
	const q = makeQueue(ctx, 0);
	for (const id of ["a", "b", "c"]) q.enq({ id });
	await settle(q);
	assert.equal(ctx.started.length, 3);
	assert.deepEqual(ctx.delays, []);
	assert.equal(ctx.started[2].at, T0);
});

test("a failing start does not stop the queue", async () => {
	const ctx = makeCtx({
		start: async (item) => {
			if (item.id === "bad") throw new Error("boom");
		},
	});
	const q = makeQueue(ctx, 15000);
	q.enq({ id: "bad" });
	q.enq({ id: "good" });
	await settle(q);
	assert.deepEqual(
		ctx.started.map((s) => s.id),
		["bad", "good"],
	);
});

test("staggerMs is live-tunable", async () => {
	const ctx = makeCtx();
	const q = makeQueue(ctx, 15000);
	q.enq({ id: "a" });
	q.enq({ id: "b" });
	// User lowered the stagger before the queue ran: b starts back-to-back.
	q.staggerMs = 0;
	await settle(q);
	assert.deepEqual(
		ctx.started.map((s) => s.at),
		[T0, T0],
	);
});

test("drain drops pending items (a start already in flight completes)", async () => {
	// Gate the first start so the pump sits mid-start while we drain:
	// `a` is already in flight, `b` is still pending.
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const ctx = makeCtx({
		start: async (item) => {
			if (item.id === "a") await gate;
		},
	});
	const q = makeQueue(ctx, 15000);
	q.enq({ id: "a" });
	await new Promise((r) => setTimeout(r, 10)); // let the pump reach the gate
	assert.equal(ctx.started.length, 1); // a has started but is held at the gate
	assert.equal(ctx.started[0].id, "a");
	q.enq({ id: "b" });
	assert.equal(q.pending, 1); // b is waiting
	q.drain();
	assert.equal(q.pending, 0);
	release();
	await settle(q);
	assert.deepEqual(
		ctx.started.map((s) => s.id),
		["a"],
	);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONFIG,
	DEFAULT_DELIVER_LEAD,
	DEFAULT_DELIVER_WORKER,
	mergeConfig,
	resolveDeliverAs,
} from "../src/config.js";
import { wakeDelivery } from "../src/messaging.js";

test("mergeConfig with no bases returns defaults", () => {
	const cfg = mergeConfig([]);
	assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("mergeConfig applies overrides in order", () => {
	const cfg = mergeConfig([
		{ backend: "swarm", maxWorkers: 6 },
		{ maxWorkers: 3, leadPanePct: 40 },
	]);
	assert.equal(cfg.backend, "swarm");
	assert.equal(cfg.maxWorkers, 3);
	assert.equal(cfg.leadPanePct, 40);
	// untouched fields keep defaults
	assert.equal(cfg.pollMs, DEFAULT_CONFIG.pollMs);
});

test("mergeConfig clamps numbers and ignores invalid values", () => {
	const cfg = mergeConfig([
		{
			maxWorkers: 999,
			leadPanePct: 5,
			staleAfterSec: 1,
			logTailLines: 10000,
			pollMs: 1,
			backend: "bogus",
			workerCommand: "",
			killWorkersOnExit: "yes",
			teamDir: "   ",
		},
	]);
	assert.equal(cfg.maxWorkers, 16); // clamped to hi
	assert.equal(cfg.leadPanePct, 10); // clamped to lo
	assert.equal(cfg.staleAfterSec, 5); // clamped to lo
	assert.equal(cfg.logTailLines, 500); // clamped to hi
	assert.equal(cfg.pollMs, 250); // clamped to lo
	assert.equal(cfg.backend, "auto"); // invalid ignored
	assert.equal(cfg.workerCommand, null); // empty string ignored
	assert.equal(cfg.killWorkersOnExit, true); // non-bool ignored -> default
	assert.equal(cfg.teamDir, DEFAULT_CONFIG.teamDir); // blank ignored
});

test("mergeConfig accepts valid strings/booleans", () => {
	const cfg = mergeConfig([
		{
			teamDir: "/custom/teams",
			workerCommand: "/opt/pi",
			killWorkersOnExit: false,
			autoDismiss: true,
		},
	]);
	assert.equal(cfg.teamDir, "/custom/teams");
	assert.equal(cfg.workerCommand, "/opt/pi");
	assert.equal(cfg.killWorkersOnExit, false);
	assert.equal(cfg.autoDismiss, true);
});

test("autoDismiss defaults to false and ignores non-boolean", () => {
	const def = mergeConfig([]);
	assert.equal(def.autoDismiss, false);
	const bad = mergeConfig([{ autoDismiss: "yes" }]);
	assert.equal(bad.autoDismiss, false);
});

test("workerLeanStartup defaults true and can be turned off", () => {
	const def = mergeConfig([]);
	assert.equal(def.workerLeanStartup, true);
	assert.equal(mergeConfig([{ workerLeanStartup: false }]).workerLeanStartup, false);
	assert.equal(mergeConfig([{ workerLeanStartup: "no" }]).workerLeanStartup, true); // non-bool ignored
});

test("deliverAs defaults: next tier steers; politeness comes from priority tiers", () => {
	const cfg = mergeConfig([]);
	assert.deepEqual(cfg.deliverAsWorker, DEFAULT_DELIVER_WORKER);
	assert.deepEqual(cfg.deliverAsLead, DEFAULT_DELIVER_LEAD);
	// Issue #3: all next-tier types (info/task/dismiss/question/answer/result)
	// steer into a mid-turn receiver; result must not stall behind the lead's
	// long continuous turn.
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "info"), "steer");
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "dismiss"), "steer");
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "info"), "steer");
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "result"), "steer");
	// wakeDelivery() overrides per message priority: now->steer and
	// later->followUp no matter what the policy says (see messaging tests).
	assert.equal(wakeDelivery("later", resolveDeliverAs(cfg.deliverAsLead, "idle")), "followUp");
	assert.equal(wakeDelivery("now", resolveDeliverAs(cfg.deliverAsLead, "result")), "steer");
});

test("deliverAs shorthand string forces one mode for all types", () => {
	const cfg = mergeConfig([{ deliverAs: "followUp" }]);
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "info"), "followUp");
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "idle"), "followUp");
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "result"), "followUp");
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "idle"), "followUp");
	const steerAll = mergeConfig([{ deliverAs: "steer" }]);
	assert.equal(resolveDeliverAs(steerAll.deliverAsLead, "result"), "steer");
	assert.equal(resolveDeliverAs(steerAll.deliverAsLead, "idle"), "steer");
	assert.equal(resolveDeliverAs(steerAll.deliverAsWorker, "dismiss"), "steer");
});

test("deliverAs per-side per-type maps merge over defaults; invalid ignored", () => {
	const cfg = mergeConfig([{
		deliverAs: {
			worker: { default: "followUp", dismiss: "steer" },
			lead: { result: "steer", bogus: "steer", idle: "maybe" },
		},
	}]);
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "info"), "followUp"); // default overridden
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "dismiss"), "steer"); // per-type kept
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "idle"), "followUp"); // from new default
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "result"), "steer");
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "idle"), "steer"); // invalid value ignored -> default kept (steer; wakeDelivery pins idle=later->followUp anyway)
	assert.equal((cfg.deliverAsLead as Record<string, unknown>).bogus, undefined); // invalid key ignored
});

test("deliverAs project config overrides global field-by-field", () => {
	const cfg = mergeConfig([
		{ deliverAs: { lead: { result: "steer" } } },
		{ deliverAs: { worker: { default: "followUp" } } },
	]);
	assert.equal(resolveDeliverAs(cfg.deliverAsLead, "result"), "steer"); // global kept
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "info"), "followUp"); // project applied
	assert.equal(resolveDeliverAs(cfg.deliverAsWorker, "idle"), "followUp");
});

test("resolveDeliverAs falls back to steer for empty policy", () => {
	assert.equal(resolveDeliverAs({}, "task"), "steer");
	assert.equal(resolveDeliverAs(undefined, "task"), "steer");
	assert.equal(resolveDeliverAs({ default: "followUp" }, "task"), "followUp");
});

test("hideDismissed defaults to true and can be turned off", () => {
	const def = mergeConfig([]);
	assert.equal(def.hideDismissed, true);
	assert.equal(mergeConfig([{ hideDismissed: false }]).hideDismissed, false);
	assert.equal(mergeConfig([{ hideDismissed: "yes" }]).hideDismissed, true); // non-bool ignored
});

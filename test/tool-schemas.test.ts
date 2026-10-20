import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import teamDispatch from "../extensions/index.js";
import teamWorker from "../extensions/worker.js";

/**
 * Issue #4: a misspelled argument (`{"id": "as-audit"}` instead of
 * `{"name": "as-audit"}`) used to reach the tool as an empty object and be
 * read as "dismiss everyone". Unknown keys must be rejected at the schema
 * boundary, before any tool code runs — pi core validates against the tool
 * schema with TypeBox, so every team tool has to declare
 * `additionalProperties: false` for that to happen.
 */

type Registered = {
	name: string;
	parameters: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<unknown>;
};

function stubApi(tools: Map<string, Registered>): ExtensionAPI {
	const noop = () => {};
	return {
		registerTool: (t: Registered) => tools.set(t.name, t),
		registerCommand: noop,
		registerShortcut: noop,
		on: noop,
		sendUserMessage: async () => {},
	} as unknown as ExtensionAPI;
}

function loadLeadTools(): Map<string, Registered> {
	delete process.env.PI_TEAM_ROLE;
	const tools = new Map<string, Registered>();
	teamDispatch(stubApi(tools));
	return tools;
}

function loadWorkerTools(): Map<string, Registered> {
	const dir = mkdtempSync(join(tmpdir(), "team-worker-schema-"));
	mkdirSync(join(dir, "inboxes"), { recursive: true });
	const tools = new Map<string, Registered>();
	const prev: Record<string, string | undefined> = {
		PI_TEAM_RUN: process.env.PI_TEAM_RUN,
		PI_TEAM_NAME: process.env.PI_TEAM_NAME,
		PI_TEAM_DIR: process.env.PI_TEAM_DIR,
	};
	process.env.PI_TEAM_RUN = "r1";
	process.env.PI_TEAM_NAME = "w1";
	process.env.PI_TEAM_DIR = dir;
	try {
		teamWorker(stubApi(tools));
	} finally {
		for (const [k, v] of Object.entries(prev)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	}
	return tools;
}

function check(tool: Registered) {
	return Compile(tool.parameters as never);
}

const LEAD_TOOLS = [
	"team_spawn",
	"team_status",
	"team_send",
	"team_collect",
	"team_log",
	"team_dismiss",
	"team_cleanup",
];

test("every lead team tool rejects unknown arguments at the schema boundary", () => {
	const tools = loadLeadTools();
	for (const name of LEAD_TOOLS) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} must be registered`);
		assert.equal(
			(tool!.parameters as { additionalProperties?: unknown }).additionalProperties,
			false,
			`${name} must set additionalProperties: false`,
		);
		const v = check(tool!);
		assert.equal(v.Check({ notAParam: 1 }), false, `${name} must reject an unknown key`);
		const required = (tool!.parameters as { required?: string[] }).required ?? [];
		if (required.length === 0) {
			assert.equal(v.Check({}), true, `${name} must accept an empty call`);
		} else {
			assert.equal(v.Check({}), false, `${name} must require ${required.join(", ")}`);
		}
	}
});

test('the old footgun call {"id": "as-audit"} now fails validation', () => {
	const v = check(loadLeadTools().get("team_dismiss")!);
	assert.equal(v.Check({ id: "as-audit" }), false);
	const messages = [...v.Errors({ id: "as-audit" })].map((e) => e.message);
	assert.ok(
		messages.some((m) => m.includes("additional properties")),
		`expected an additional-properties error, got ${JSON.stringify(messages)}`,
	);
});

test("team_dismiss takes an explicit name (or all) plus force", () => {
	const v = check(loadLeadTools().get("team_dismiss")!);
	assert.equal(v.Check({ name: "as-audit" }), true);
	assert.equal(v.Check({ name: "all", force: true }), true);
});

test("worker team tools also reject unknown arguments", () => {
	const tools = loadWorkerTools();
	for (const name of ["team_inbox", "team_send", "team_done"]) {
		const tool = tools.get(name);
		assert.ok(tool, `${name} must be registered for workers`);
		assert.equal(
			(tool!.parameters as { additionalProperties?: unknown }).additionalProperties,
			false,
			`${name} must set additionalProperties: false`,
		);
		assert.equal(check(tool!).Check({ workerName: "w1" }), false, `${name} must reject an unknown key`);
	}
});

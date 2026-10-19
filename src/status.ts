import { join } from "node:path";
import type { TeamMessage } from "./messaging.js";
import { readInbox } from "./messaging.js";
import { LEAD_NAME } from "./names.js";
import { ageSec, type Member, type RunState } from "./run.js";
import { finalAssistantText, pidAlive } from "./process.js";

/**
 * Worker status derivation.
 *
 * config.json is the lead's view; true liveness comes from the outside:
 *  - pane backends: does the tmux pane still exist?
 *  - process backend: is the pid alive?
 *  - a "result" message in the lead inbox means the work is done
 *    regardless of process state.
 */

export type WorkerStatus = "running" | "idle" | "done" | "failed" | "dismissed";

export interface MemberDerived {
	member: Member;
	status: WorkerStatus;
	/** Seconds since last observed activity (spawn or inbox traffic). */
	age: number;
	/** Final result text, when available (result message or JSONL fallback). */
	result?: string;
}

export interface StatusChecks {
	/** Pane existence for tmux backends. */
	paneExists?: (paneId: string, inside: boolean) => Promise<boolean>;
	now?: number;
}

/** Read the last `n` messages in the lead inbox from one worker. */
export function latestWorkerMessages(
	runDir: string,
	worker: string,
	n = 5,
): TeamMessage[] {
	const { messages } = readInbox(runDir, LEAD_NAME);
	const mine = messages.filter((m) => m.from === worker);
	return mine.slice(-n);
}

/** Result text for a worker: result message first, JSONL fallback. */
export function workerResultText(runDir: string, member: Member): string | undefined {
	const msgs = latestWorkerMessages(runDir, member.name, 20);
	const result = [...msgs].reverse().find((m) => m.type === "result");
	if (result) return result.body;
	if (member.backend === "process") {
		const log = join(runDir, "logs", `${member.name}.jsonl`);
		const text = finalAssistantText(log);
		if (text.trim()) return text;
	}
	return undefined;
}

/**
 * Derive status for all members of a run.
 */
export async function deriveMembers(
	runDir: string,
	run: RunState,
	checks: StatusChecks = {},
): Promise<MemberDerived[]> {
	const now = checks.now ?? Date.now();
	const out: MemberDerived[] = [];
	for (const m of run.members) {
		const derived: MemberDerived = {
			member: m,
			status: "running",
			age: ageSec(m.lastActivity, now),
			result: workerResultText(runDir, m),
		};
		if (m.dismissed) {
			derived.status = "dismissed";
			out.push(derived);
			continue;
		}
		if (derived.result) {
			derived.status = "done";
			out.push(derived);
			continue;
		}
		switch (m.backend) {
			case "tmux-lead":
			case "tmux-swarm": {
				if (m.paneId && checks.paneExists) {
					const alive = await checks.paneExists(
						m.paneId,
						m.backend === "tmux-lead",
					);
					if (!alive) {
						derived.status = "failed";
						// Pane gone without a result: the worker exited.
						// Mark failed so repeated status calls are stable.
						m.failed = true;
					}
				}
				break;
			}
			case "process": {
				if (!pidAlive(m.pid)) {
					derived.status = "failed";
					m.failed = true;
				}
				break;
			}
		}
		// Alive but last message was an idle report -> waiting for input.
		if (derived.status === "running") {
			const msgs = latestWorkerMessages(runDir, m.name, 3);
			const last = msgs[msgs.length - 1];
			if (last && last.type === "idle") derived.status = "idle";
		}
		out.push(derived);
	}
	return out;
}

/** Compact roster rendering for tools/commands. */
export function renderRoster(
	runId: string,
	members: MemberDerived[],
	extra?: { attachHint?: string; cwd?: string },
): string {
	if (members.length === 0) return `team ${runId}: no workers`;
	const lines: string[] = [`team ${runId}: ${members.length} worker(s)`];
	const ICON: Record<WorkerStatus, string> = {
		running: "●",
		idle: "○",
		done: "✓",
		failed: "✗",
		dismissed: "·",
	};
	for (const d of members) {
		const model = d.member.model ? ` ${d.member.model}` : "";
		lines.push(
			`  ${ICON[d.status]} ${d.member.name.padEnd(16)} ${d.status.padEnd(9)}${model}  (${d.age}s)`,
		);
	}
	if (extra?.attachHint) lines.push(`  swarm view: ${extra.attachHint}`);
	if (extra?.cwd) lines.push(`  cwd: ${extra.cwd}`);
	return lines.join("\n");
}

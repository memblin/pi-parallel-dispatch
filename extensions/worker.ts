/**
 * Worker-side extension (loaded via `pi -e` in each spawned worker).
 *
 * Active only when PI_TEAM_RUN / PI_TEAM_NAME / PI_TEAM_DIR are set.
 * Registers the worker's team tools, auto-delivers inbox messages as user
 * messages, and reports idle/result state back to the lead.
 *
 * In pane mode the extension sends the kickoff prompt at session_start
 * (the worker opens with an empty prompt). In process mode the kickoff is
 * a CLI argument, so the extension stays quiet about it.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatPriorityHeader,
	inboxSize,
	priorityOf,
	readInbox,
	send,
	wakeDelivery,
	type TeamMessage,
} from "../src/messaging.js";
import { LEAD_NAME } from "../src/names.js";
import { loadConfig, resolveDeliverAs } from "../src/config.js";

const DEFAULT_POLL_MS = 2000;
const TEAM_PREFIX = "[team]";

export default function (pi: ExtensionAPI) {
	const rawRun = process.env.PI_TEAM_RUN;
	const rawName = process.env.PI_TEAM_NAME;
	const rawDir = process.env.PI_TEAM_DIR;
	if (!rawRun || !rawName || !rawDir || !existsSync(rawDir)) return;
	const runId: string = rawRun;
	const name: string = rawName;
	const runDir: string = rawDir;

	const mode = process.env.PI_TEAM_MODE === "process" ? "process" : "pane";
	let cursor = inboxSize(runDir, name); // skip pre-spawn messages (task)
	let done = false;
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastIdleSent = "";

	function members(): string[] {
		try {
			const dir = join(runDir, "inboxes");
			if (!existsSync(dir)) return [LEAD_NAME];
			return readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => f.slice(0, -".jsonl".length));
		} catch {
			return [LEAD_NAME];
		}
	}

	function lastAssistantText(ctx: ExtensionContext): string {
		try {
			const branch = ctx.sessionManager.getBranch() as unknown as {
				role?: string;
				content?: { type?: string; text?: string }[];
			}[];
			for (let i = branch.length - 1; i >= 0; i--) {
				const m = branch[i];
				if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
				const text = m.content
					.filter((c) => c.type === "text" && typeof c.text === "string")
					.map((c) => c.text!)
					.join("\n")
					.trim();
				if (text) return text;
			}
		} catch {
			/* best effort */
		}
		return "";
	}

	pi.on("session_start", async (_event, ctx) => {
		// Pane mode: the worker opened with no prompt; kick it off.
		if (mode === "pane") {
			const { messages } = readInbox(runDir, name, 0);
			const task = [...messages].reverse().find((m) => m.type === "task");
			const taskFile = join(runDir, "prompts", `${name}.md`);
			const kickoff =
				`Begin: your task is described in ${taskFile}. Read it, then complete the work. ` +
				`When finished, report your final result with the team_done tool.` +
				(task ? ` Task summary: ${task.body.slice(0, 200)}` : "");
			try {
				await pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
			} catch (e) {
				ctx.ui.notify(`team: kickoff failed: ${(e as Error).message}`, "error");
			}
		}
		const pollMs = loadConfig(process.cwd()).pollMs || DEFAULT_POLL_MS;
		timer = setInterval(() => {
			void pumpInbox();
		}, pollMs);
		timer.unref?.();
	});

	async function pumpInbox() {
		if (done) return;
		try {
			const { messages, cursor: next } = readInbox(runDir, name, cursor);
			cursor = next;
			if (messages.length === 0) return;
			// Re-read config each pump so deliverAs is live-tunable.
			const cfg = loadConfig(process.cwd());
			for (const m of messages) {
				if (m.from === name) continue;
				const header = formatPriorityHeader(m);
				const body = m.type === "dismiss"
					? `${TEAM_PREFIX} ${m.from} dismissed you ${header}: ${m.body} Stop working now; no further output is needed.`
					: `${TEAM_PREFIX} message from ${m.from} (${m.type}) ${header}: ${m.body}`;
				try {
					// Priority tier picks the mode: `now` always steers (a
					// dismissal must land mid-run), `later` waits for the turn
					// to end; the `next` tier follows the per-type worker policy
					// (config deliverAs.worker, default steer).
					await pi.sendUserMessage(body, {
						deliverAs: wakeDelivery(
								priorityOf(m),
								resolveDeliverAs(cfg.deliverAsWorker, m.type),
							),
					});
				} catch {
					/* session may be ending; ignore */
				}
			}
		} catch {
			/* ignore transient read errors */
		}
	}

	pi.on("agent_settled", async (event, ctx) => {
		if (event.aborted || done) return;
		const text = lastAssistantText(ctx);
		if (!text || text === lastIdleSent) return;
		lastIdleSent = text;
		const tail = text.length > 400 ? `…${text.slice(-400)}` : text;
		send(runDir, name, LEAD_NAME, "idle", `turn complete: ${tail}`);
		ctx.ui.notify?.(`[team:${name}] idle`, "info");
	});

	pi.on("session_shutdown", () => {
		if (timer) clearInterval(timer);
		if (!done) {
			try {
				send(runDir, name, LEAD_NAME, "status", "worker session ended without team_done");
			} catch {
				/* best effort */
			}
		}
	});

	/* ------------------------------------------------------------------ */
	/* Tools                                                               */
	/* ------------------------------------------------------------------ */

	pi.registerTool({
		name: "team_inbox",
		label: "Team inbox",
		description:
			"Read recent messages in your team inbox (from the lead or other workers). " +
			"New messages are also delivered to you automatically as user messages.",
		parameters: Type.Object({
			limit: Type.Optional(
				Type.Number({ description: "How many recent messages to show (default 10)" }),
			),
		}),
		execute: async (_id, params) => {
			const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
			const { messages } = readInbox(runDir, name, 0);
			const recent = messages.slice(-limit);
			if (recent.length === 0) {
				return {
					content: [{ type: "text", text: "No messages in your inbox." }],
					details: undefined,
				};
			}
			const text = recent
				.map((m: TeamMessage) => `--- ${m.from} (${m.type}, ${m.ts})\n${m.body}`)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "team_send",
		label: "Team send",
		description:
			"Send a message to the lead ('lead') or another worker by name. " +
			"Use for questions, blockers, and interim findings. Keep messages short. " +
			"Raise priority to 'now' (with level 'warning'/'critical') if the lead must react " +
			"mid-turn; 'later' marks the message purely informative.",
		parameters: Type.Object({
			to: Type.String({ description: "Recipient name: 'lead' or a worker name" }),
			text: Type.String({ description: "Message body" }),
			priority: Type.Optional(
				Type.Union(
					[Type.Literal("now"), Type.Literal("next"), Type.Literal("later")],
					{ description: "Urgency tier override (default by type: next)" },
				),
			),
			level: Type.Optional(
				Type.Union(
					[
						Type.Literal("info"),
						Type.Literal("assist"),
						Type.Literal("warning"),
						Type.Literal("critical"),
					],
					{ description: "Attention kind override (default by type: assist)" },
				),
			),
		}),
		execute: async (_id, params) => {
			const to = params.to.trim();
			if (!to) throw new Error("team_send: 'to' is required");
			send(runDir, name, to, "info", params.text, {
				priority: params.priority,
				level: params.level,
			});
			return {
				content: [{ type: "text", text: `Message sent to ${to}.` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "team_done",
		label: "Team done",
		description:
			"Report that your task is complete. The summary is delivered to the lead as your " +
			"final answer. Call exactly once, at the end, with a concise but complete summary " +
			"(what you did, key findings, files changed).",
		parameters: Type.Object({
			summary: Type.String({ description: "Final result summary for the lead" }),
		}),
		execute: async (_id, params) => {
			done = true;
			if (timer) clearInterval(timer);
			send(runDir, name, LEAD_NAME, "result", params.summary);
			return {
				content: [
					{
						type: "text",
						text: "Result delivered to the lead. You are done — no further output is needed.",
					},
				],
				details: undefined,
			};
		},
	});

	void members;
}

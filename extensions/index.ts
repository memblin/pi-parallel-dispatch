/**
 * Lead-side extension: team_* tools, roster widget, /team commands,
 * inbox watcher that auto-delivers worker messages to the lead.
 *
 * This file is loaded in every pi session (it ships in the package), but
 * only activates for lead sessions: worker sessions set PI_TEAM_ROLE=worker
 * and are handled by extensions/worker.ts instead. That is also what keeps
 * workers from spawning nested teams.
 */
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadConfig, resolveDeliverAs, type TeamConfig } from "../src/config.js";
import { makeExec } from "../src/exec.js";
import { LEAD_NAME, checkName, nextColor, uniqueName } from "../src/names.js";
import {
	readInbox,
	send,
	type TeamMessage,
} from "../src/messaging.js";
import {
	addMember,
	attachableRunDir,
	claimLeadLock,
	createRun,
	findMember,
	listRuns,
	memberNames,
	readRun,
	removeRun,
	runPaths,
	writeRun,
	type Member,
	type MemberBackend,
	type RunState,
} from "../src/run.js";
import { TmuxBackend, swarmAttachHint } from "../src/tmux.js";
import {
	buildWorkerLaunch,
	kickoffPrompt,
	resolvePiCommand,
} from "../src/launch.js";
import { LaunchQueue, type QueueItem } from "../src/launchqueue.js";
import {
	pidAlive,
	renderJsonlTail,
	spawnWorkerProcess,
	tailFile,
} from "../src/process.js";
import {
	findWorkerSessionFile,
	renderSessionTail,
} from "../src/transcript.js";
import { writeBootstrap } from "../src/bootstrap.js";
import {
	deriveMembers,
	renderRoster,
	type MemberDerived,
	type WorkerStatus,
} from "../src/status.js";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(THIS_DIR);
const WORKER_EXT = join(PACKAGE_DIR, "extensions", "worker.ts");
const WIDGET_KEY = "team-dispatch";
const PER_RESULT_CAP = 50 * 1024;

interface ActiveRun {
	runId: string;
	dir: string;
	cwd: string;
	cfg: TeamConfig;
	run: RunState;
	tmux?: TmuxBackend;
	leadInside: boolean;
	/** Staggered launch queue for worker starts (see src/launchqueue.ts). */
	queue?: LaunchQueue<StartItem>;
	/** In-memory start specs for queued workers (name -> spec). */
	starts: Map<string, StartSpec>;
}

/** One entry in the launch queue. */
interface StartItem extends QueueItem {
	name: string;
}

/** Everything needed to actually start a queued worker. */
interface StartSpec {
	/** Pane backend: the full shell command for respawn-pane. */
	paneCommand?: string;
	/** Process backend: argv + env for child_process.spawn. */
	argv?: string[];
	env?: Record<string, string>;
	cwd?: string;
	logPath?: string;
	errPath?: string;
}

export default function (pi: ExtensionAPI) {
	// Worker sessions are handled by extensions/worker.ts.
	if (process.env.PI_TEAM_ROLE === "worker") return;

	const exec = makeExec();
	let active: ActiveRun | null = null;
	let leadCursor = 0;
	let inboxTimer: ReturnType<typeof setInterval> | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let lastCtx: ExtensionContext | null = null;
	let lastDerived: MemberDerived[] = [];
	let shuttingDown = false;

	/* ------------------------------------------------------------------ */
	/* Run management                                                      */
	/* ------------------------------------------------------------------ */

	function getRun(ctx: ExtensionContext): ActiveRun {
		if (active) return active;
		const cfg = loadConfig(ctx.cwd);
		// Re-attach to the newest run THIS process may own: one that still
		// has members and whose lead lock is free (missing/stale). A run
		// locked by another LIVE lead is skipped — attaching to it would
		// merge two lead sessions' teams (shared roster/inboxes/panes).
		const skip = new Set<string>();
		let candidate = attachableRunDir(cfg.teamDir, skip);
		while (candidate) {
			const run = readRun(candidate);
			if (run && run.members.some((m) => !m.dismissed) && claimLeadLock(candidate)) {
				// Workers that were queued for a staggered launch when this
				// lead process died can never start — their queue is gone.
				// Mark them failed instead of "starting" forever.
				for (const m of run.members) {
					if (m.starting && !m.dismissed) {
						m.starting = false;
						m.failed = true;
					}
				}
				active = {
					runId: run.runId,
					dir: candidate,
					cwd: run.cwd,
					cfg,
					run,
					leadInside: Boolean(process.env.TMUX),
					starts: new Map(),
				};
				leadCursor = inboxSizeNow();
				startInboxWatcher();
				return active;
			}
			skip.add(candidate);
			candidate = attachableRunDir(cfg.teamDir, skip);
		}
		const { runId, dir } = createRun(cfg.teamDir, ctx.cwd);
		const run = readRun(dir);
		if (!run) throw new Error("failed to create team run state");
		active = {
			runId,
			dir,
			cwd: ctx.cwd,
			cfg,
			run,
			leadInside: Boolean(process.env.TMUX),
			starts: new Map(),
		};
		leadCursor = inboxSizeNow();
		startInboxWatcher();
		return active;
	}

	function inboxSizeNow(): number {
		if (!active) return 0;
		try {
			const { statSync } = require("node:fs") as typeof import("node:fs");
			const p = join(active.dir, "inboxes", `${LEAD_NAME}.jsonl`);
			return existsSync(p) ? statSync(p).size : 0;
		} catch {
			return 0;
		}
	}

	function getTmux(st: ActiveRun): TmuxBackend {
		if (!st.tmux) st.tmux = new TmuxBackend(exec, process.env, st.cfg.leadPanePct, st.runId);
		return st.tmux;
	}

	/**
	 * Re-read the team-dispatch config so user edits take effect WITHOUT a
	 * pi restart (maxWorkers, launchStaggerMs, backend, leadPanePct, ...).
	 * Called on spawn / status / /team / shutdown — two small file reads,
	 * negligible cost.
	 */
	function refreshCfg(st: ActiveRun): void {
		st.cfg = loadConfig(st.cwd);
		if (st.queue) st.queue.staggerMs = st.cfg.launchStaggerMs;
		if (st.tmux && st.tmux.leadPanePct !== st.cfg.leadPanePct) {
			// Layout width changed: rebuild the backend (drops the cached
			// window id — costs one display-message at most, next spawn).
			st.tmux = new TmuxBackend(exec, process.env, st.cfg.leadPanePct, st.runId);
		}
	}

	function ensureQueue(st: ActiveRun): LaunchQueue<StartItem> {
		if (!st.queue) {
			st.queue = new LaunchQueue<StartItem>({
				staggerMs: st.cfg.launchStaggerMs,
				start: async (item) => {
					await startQueuedWorker(st, item.name);
				},
			});
		}
		return st.queue;
	}

	function paneExistsFor(st: ActiveRun) {
		return (paneId: string, inside: boolean) => getTmux(st).paneExists(paneId, inside);
	}

	/** Pane backend implied by config + environment (null => process). */
	function wantedPaneBackend(cfg: TeamConfig, inside: boolean): Exclude<MemberBackend, "process"> | null {
		switch (cfg.backend) {
			case "auto":
				return inside ? "tmux-lead" : null;
			case "tmux":
				return inside ? "tmux-lead" : "tmux-swarm";
			case "swarm":
				return "tmux-swarm";
			case "process":
				return null;
		}
	}

	async function resolveModel(ctx: ExtensionContext, explicit?: string): Promise<string | undefined> {
		if (explicit && explicit.trim()) return explicit.trim();
		if (ctx.model) return `${ctx.model.provider}/${ctx.model.id}`;
		return undefined;
	}

	/* ------------------------------------------------------------------ */
	/* UI                                                                  */
	/* ------------------------------------------------------------------ */

	const STATUS_ICON: Record<WorkerStatus, string> = {
		starting: "◌",
		running: "●",
		idle: "○",
		done: "✓",
		failed: "✗",
		dismissed: "·",
	};

	function updateWidget() {
		const ctx = lastCtx;
		if (!ctx || ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!active) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const allEntries: Array<{ member: Member; status: WorkerStatus }> = lastDerived.length
			? lastDerived
			: active.run.members.map((m) => ({
					member: m,
					status: (m.dismissed ? "dismissed" : "running") as WorkerStatus,
				}));
		// Dismissed workers are hidden by default so the widget does not grow
		// without bound; hideDismissed=false (or /team all) shows them again.
		const hide = active.cfg.hideDismissed;
		const entries = hide
			? allEntries.filter((d) => d.status !== "dismissed")
			: allEntries;
		const hiddenCount = allEntries.length - entries.length;
		const lines: string[] = [
			`team ${active.runId} — ${entries.length} worker(s)  [/team]`,
		];
		for (const d of entries) {
			const member = d.member;
			const status = d.status;
			const model = member.model ? ` ${member.model}` : "";
			lines.push(`  ${STATUS_ICON[status]} ${member.name.padEnd(16)} ${status.padEnd(9)}${model}`);
		}
		if (hiddenCount > 0) {
			lines.push(`  · ${hiddenCount} dismissed (hidden)`);
		}
		ctx.ui.setWidget(WIDGET_KEY, lines);
	}

	async function refreshDerived() {
		if (!active) return;
		try {
			lastDerived = await deriveMembers(active.dir, active.run, {
				paneExists: paneExistsFor(active),
			});
			writeRun(active.dir, active.run);
		} catch {
			/* ignore */
		}
		updateWidget();
	}

	function startRefreshTimer() {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			if (!active || shuttingDown) return;
			const anyLive = active.run.members.some((m) => !m.dismissed && !m.failed);
			if (!anyLive) {
				void refreshDerived();
				if (refreshTimer) clearInterval(refreshTimer);
				refreshTimer = null;
				return;
			}
			void refreshDerived();
		}, 5000);
		refreshTimer.unref?.();
	}

	function stopTimers() {
		if (inboxTimer) {
			clearInterval(inboxTimer);
			inboxTimer = null;
		}
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	}

	/* ------------------------------------------------------------------ */
	/* Lead inbox watcher: auto-deliver worker messages to the lead model */
	/* ------------------------------------------------------------------ */

	function startInboxWatcher() {
		if (inboxTimer) return;
		inboxTimer = setInterval(() => {
			void pumpLeadInbox();
		}, active?.cfg.pollMs ?? 2000);
		inboxTimer.unref?.();
	}

	async function pumpLeadInbox() {
		if (!active) return;
		let read: { messages: TeamMessage[]; cursor: number };
		try {
			read = readInbox(active.dir, LEAD_NAME, leadCursor);
		} catch {
			return;
		}
		leadCursor = read.cursor;
		for (const m of read.messages) {
			const member = findMember(active.run, m.from);
			if (member && !member.dismissed) {
				member.lastActivity = m.ts;
				writeRun(active.dir, active.run);
			}
			const body = m.body.length > 2000 ? `${m.body.slice(0, 2000)}…` : m.body;
			const label =
				m.type === "result" ? "finished" : m.type === "idle" ? "idle" : m.type;

			// When autoDismiss is on, a finished worker is dismissed as soon as
			// its result arrives, closing its pane/process and freeing the slot.
			// Otherwise the worker stays in the roster (status "done") for
			// review and the lead dismisses it explicitly with team_dismiss.
			let hint = "";
			if (m.type === "result" && member && !member.dismissed) {
				if (active.cfg.autoDismiss) {
					try {
						await dismissWorker(active, member);
					} catch {
						/* dismiss is best effort; the worker already finished */
					}
				} else {
					hint = " (done; team_dismiss to free its slot when you're ready)";
				}
			}

			try {
				// Delivery mode per message type (config: deliverAs.lead):
				// questions/findings steer into a mid-turn lead; result/idle/
				// status wait for the lead to settle so they never interrupt.
				// followUp also avoids throwing "Agent is already processing".
				await pi.sendUserMessage(`[team] ${m.from} (${label}): ${body}${hint}`, {
					deliverAs: resolveDeliverAs(active.cfg.deliverAsLead, m.type),
				});
			} catch {
				/* session may be ending */
			}
			lastCtx?.ui.notify?.(`[team] ${m.from}: ${label}`, "info");
		}
	}

	/* ------------------------------------------------------------------ */
	/* Spawn                                                               */
	/* ------------------------------------------------------------------ */

	async function doSpawn(
		ctx: ExtensionContext,
		params: {
			name: string;
			task: string;
			model?: string;
			thinking?: string;
			cwd?: string;
		},
	): Promise<string> {
		const st = getRun(ctx);
		refreshCfg(st); // live config: e.g. a raised maxWorkers takes effect now
		const cfg = st.cfg;
		const live = st.run.members.filter((m) => !m.dismissed);
		if (live.length >= cfg.maxWorkers) {
			const globalCfg = join(homedir(), ".pi", "agent", "team-dispatch.json");
			const projCfg = join(ctx.cwd, ".pi", "team-dispatch.json");
			throw new Error(
				`max workers reached (${cfg.maxWorkers}). To raise it without restarting pi, edit ` +
					`${globalCfg} (or ${projCfg} for this project) — e.g. {"maxWorkers": 5} — and spawn again; ` +
					"config is re-read on every spawn. Or dismiss some with team_dismiss first.",
				);
		}

		// Name + color
		const check = checkName(params.name);
		if (!check.ok) throw new Error(check.error);
		const name = uniqueName(check.name, memberNames(st.run));
		const color = nextColor(live.map((m) => m.color));

		// Backend
		const paneBackend = live.find((m) => m.backend.startsWith("tmux-"))?.backend as
			| Exclude<MemberBackend, "process">
			| undefined;
		const want = wantedPaneBackend(cfg, st.leadInside);
		let backend: MemberBackend = paneBackend ?? want ?? "process";
		const auto = cfg.backend === "auto";

		// Model
		const model = await resolveModel(ctx, params.model);
		const thinking = params.thinking?.trim() || undefined;

		// Task file + bootstrap
		const p = runPaths(st.dir);
		const cwd = params.cwd?.trim() || st.cwd;
		const taskFile = join(p.prompts, `${name}.md`);
		writeFileSync(
			taskFile,
			`# Task for ${name}\n\nRun: ${st.runId}\n\n${params.task.trim()}\n`,
		);
		const bootstrapPath = writeBootstrap(st.dir, p.prompts, {
			packageDir: PACKAGE_DIR,
			name,
			runId: st.runId,
			cwd,
			taskFile,
		});

		const piCmd = resolvePiCommand(cfg);
		const lean = cfg.workerLeanStartup;
		const launch =
			backend === "process"
				? buildWorkerLaunch(piCmd, {
						cwd,
						name,
						runId: st.runId,
						runDir: st.dir,
						workerExtPath: WORKER_EXT,
						bootstrapPath,
						taskFile,
						model,
						thinking,
						mode: "process",
						lean,
					})
				: buildWorkerLaunch(piCmd, {
						cwd,
						name,
						runId: st.runId,
						runDir: st.dir,
						workerExtPath: WORKER_EXT,
						bootstrapPath,
						taskFile,
						model,
						thinking,
						mode: "pane",
						lean,
					});

		// Task message for the worker inbox (readable via team_inbox)
		send(st.dir, LEAD_NAME, name, "task", params.task.trim());

		let paneId: string | undefined;
		let windowId: string | undefined;
		let fallbackNote = "";
		if (backend !== "process") {
			const tmux = getTmux(st);
			const inside = backend === "tmux-lead";
			const res = inside ? await tmux.spawnInside() : await tmux.spawnExternal();
			if (!res.ok) {
				if (auto) {
					fallbackNote = ` (pane spawn failed: ${res.error}; fell back to background process)`;
					backend = "process";
				} else {
					throw new Error(res.error);
				}
			} else {
				paneId = res.paneId;
				windowId = res.windowId;
				await tmux.decorate(paneId, name, color, inside).catch(() => {});
			}
		}

		const attachHint = backend === "tmux-swarm" ? swarmAttachHint(st.runId) : undefined;

		// Register the member BEFORE queueing: the slot is reserved now (the
		// maxWorkers check stays honest under a burst of spawns) and the
		// roster shows the worker immediately (status "starting").
		const member: Member = {
			name,
			color,
			backend,
			model,
			thinking,
			cwd,
			paneId,
			windowId,
			joinedAt: new Date().toISOString(),
			lastActivity: new Date().toISOString(),
			starting: true,
		};
		addMember(st.run, member);
		writeRun(st.dir, st.run);

		// The actual worker start goes through the staggered launch queue so
		// a burst of team_spawn calls (all prompts ready at once) can't fire
		// N first LLM requests at the same GPU at the same second.
		st.starts.set(
			name,
			backend === "process"
				? {
						argv: launch.argv,
					env: launch.env,
					cwd,
					logPath: join(p.logs, `${name}.jsonl`),
					errPath: join(p.logs, `${name}.err`),
				}
				: { paneCommand: launch.paneCommand },
		);
		const q = ensureQueue(st);
		q.enq({ id: name, name });
		const position = q.pending; // this item's queue position (1 = next up)

		void refreshDerived();
		startRefreshTimer();

		const where =
			backend === "tmux-lead"
				? `tmux pane ${paneId} (lead's window)`
				: backend === "tmux-swarm"
					? `tmux pane ${paneId} in swarm session`
					: `background process`;
		const modelNote = model ? ` model: ${model}` : "";
		const staggerNote =
			position > 1 && cfg.launchStaggerMs > 0
				? ` Starting is staggered (~${Math.round(cfg.launchStaggerMs / 1000)}s between launches) to avoid a GPU burst; it starts next in line.`
				: "";
		return (
			`Spawned ${name}${modelNote} in ${where}.${attachHint ? ` View: ${attachHint}` : ""}` +
			`${staggerNote}${fallbackNote} Worker reports results via team_collect / the roster; you will also be woken when it finishes.`
		);
	}

	/**
	 * Start one queued worker (invoked by the staggered launch queue).
	 * Failures are reported here — member marked failed and the lead woken —
	 * so a bad launch can't vanish into the queue.
	 */
	async function startQueuedWorker(st: ActiveRun, name: string): Promise<void> {
		const m = findMember(st.run, name);
		const spec = st.starts.get(name);
		if (!m || !spec) return;
		if (shuttingDown || m.dismissed) {
			// Dismissed while queued: the pane/process was already stopped.
			m.starting = false;
			st.starts.delete(name);
			return;
		}
		try {
			if (m.backend === "process") {
				const handle = spawnWorkerProcess({
					argv: spec.argv!,
					env: spec.env!,
					cwd: spec.cwd!,
					logPath: spec.logPath!,
					errPath: spec.errPath!,
					// Background workers must not be able to reach the lead's
					// tmux server through an inherited $TMUX socket.
					envBase: { ...process.env, TMUX: undefined, TMUX_PANE: undefined },
				});
				m.pid = handle.pid;
			} else if (m.paneId && spec.paneCommand) {
				// Start the worker in the pane (respawn the cat placeholder).
				await getTmux(st).startWorker(m.paneId, spec.paneCommand, m.backend === "tmux-lead");
			}
			m.starting = false;
			st.starts.delete(name);
			writeRun(st.dir, st.run);
			lastCtx?.ui.notify?.(`team: ${name} started`, "info");
		} catch (e) {
			m.starting = false;
			m.failed = true;
			st.starts.delete(name);
			writeRun(st.dir, st.run);
			const msg = (e as Error).message || "unknown error";
			try {
				await pi.sendUserMessage(
					`[team] ${name} failed to start: ${msg}. team_dismiss it and re-spawn if needed.`,
					{ deliverAs: "followUp" },
				);
			} catch {
				/* session may be ending */
			}
			lastCtx?.ui.notify?.(`[team] ${name}: start failed`, "error");
		}
		void refreshDerived();
	}

	/** Recent output for a worker, for team_log and /team-log.
	 *
	 * Uses the worker's persisted session transcript (never tmux
	 * capture-pane, which can crash the tmux server on some builds). For
	 * process workers the JSONL event stream is used directly.
	 */
	function workerLogText(st: ActiveRun, m: Member, lines: number): string {
		const p = runPaths(st.dir);
		if (m.backend === "process") {
			const rendered = renderJsonlTail(join(p.logs, `${m.name}.jsonl`), lines);
			const err = tailFile(join(p.logs, `${m.name}.err`), 10).trim();
			let text = rendered || "(no output yet)";
			if (err) text += `\n\nstderr:\n${err}`;
			return text;
		}
		const sessionFile = findWorkerSessionFile(st.dir, m.name);
		if (sessionFile) {
			const rendered = renderSessionTail(sessionFile, lines);
			if (rendered.trim()) return rendered;
		}
		return "(no output yet)";
	}

	/**
	 * Stop and mark a single worker dismissed: send a dismiss notice, kill its
	 * pane/process, and flag the member. Used by team_dismiss and by the inbox
	 * watcher to auto-dismiss workers that just finished (frees a slot).
	 */
	async function dismissWorker(st: ActiveRun, m: Member, note = "The lead dismissed this worker. Stop now."): Promise<void> {
		const tmux = getTmux(st);
		try {
			send(st.dir, LEAD_NAME, m.name, "dismiss", note);
		} catch {
			/* best effort */
		}
		if (m.backend === "process" && m.pid) {
			try {
				process.kill(m.pid, "SIGTERM");
				await new Promise((r) => setTimeout(r, 1500));
				if (pidAlive(m.pid)) process.kill(m.pid, "SIGKILL");
			} catch {
				/* already gone */
			}
		} else if (m.paneId && m.backend.startsWith("tmux-")) {
			await tmux
				.stopWorker(m.paneId, m.backend === "tmux-lead", m.windowId)
				.catch(() => {});
		}
		m.dismissed = true;
		writeRun(st.dir, st.run);
	}

	/* ------------------------------------------------------------------ */
	/* Tools                                                               */
	/* ------------------------------------------------------------------ */

	pi.registerTool({
		name: "team_spawn",
		label: "Team spawn",
		description:
			"Spawn a named worker agent for a task. Workers run in a tmux pane (when pi runs " +
			"inside tmux) or as a background process with a log file. The worker picks its own " +
			"model from the 'model' argument, defaulting to the lead's current model. Use " +
			"team_status/team_collect to track and gather results. Max workers per team is limited.",
		parameters: Type.Object({
			name: Type.String({
				description:
					"Unique worker name: letters/digits/_/- , max 64 chars (e.g. 'researcher', 'fix-auth')",
			}),
			task: Type.String({
				description:
					"Self-contained task description. The worker does NOT see your conversation — " +
					"include all relevant context, paths, and the expected deliverable.",
			}),
			model: Type.Optional(
				Type.String({
					description:
						"Model for this worker (provider/id or fuzzy match, e.g. 'sonnet:high'). " +
						"Default: the lead's current model.",
				}),
			),
			thinking: Type.Optional(
				Type.String({
					description:
						"Thinking level override: off|minimal|low|medium|high|xhigh|max",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "Working directory for the worker (default: lead's cwd)" }),
			),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			try {
				const text = await doSpawn(ctx, params);
				ctx.ui.notify?.("team: " + params.name + " spawned", "info");
				return { content: [{ type: "text", text }], details: undefined };
			} catch (e) {
				throw e;
			}
		},
	});

	pi.registerTool({
		name: "team_status",
		label: "Team status",
		description:
			"Show the current team roster: each worker's state (running/idle/done/failed), " +
			"model, and last activity. Dismissed workers are hidden by default (count shown in a " +
			"footer; set hideDismissed=false in the config to list them). Also shows the swarm " +
			"attach command when workers are in a separate tmux session.",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!active) {
				const cfg = loadConfig(ctx.cwd);
				return {
					content: [{ type: "text", text: "No active team. Call team_spawn to create one." }],
					details: undefined,
				};
			}
			const st = active;
			refreshCfg(st); // live config for the roster footer
			const derived = await deriveMembers(st.dir, st.run, {
				paneExists: paneExistsFor(st),
			});
			lastDerived = derived;
			writeRun(st.dir, st.run);
			updateWidget();
			const hasSwarm = derived.some((d) => d.member.backend === "tmux-swarm");
			const attachHint =
				hasSwarm && (await getTmux(st).swarmSessionExists())
					? swarmAttachHint(st.runId)
					: undefined;
			return {
				content: [
					{
						type: "text",
						text: renderRoster(st.runId, derived, {
							attachHint,
							cwd: active.cwd,
							hideDismissed: st.cfg.hideDismissed,
						}),
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "team_send",
		label: "Team send",
		description:
			"Send a message to a running worker (answer a question, give new instructions). " +
			"Only works for workers in a tmux pane; background one-shot workers cannot receive " +
			"messages mid-run.",
		parameters: Type.Object({
			name: Type.String({ description: "Worker name" }),
			text: Type.String({ description: "Message body" }),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!active) throw new Error("no active team");
			const m = findMember(active.run, params.name);
			if (!m) throw new Error(`unknown worker "${params.name}" (see team_status)`);
			if (m.dismissed) throw new Error(`worker "${params.name}" was dismissed`);
			if (m.backend === "process") {
				return {
					content: [
						{
							type: "text",
							text: `Worker "${params.name}" is a background one-shot process and cannot receive live messages. Wait for it with team_collect.`,
						},
					],
					details: undefined,
				};
			}
			send(active.dir, LEAD_NAME, params.name, "info", params.text);
			m.lastActivity = new Date().toISOString();
			writeRun(active.dir, active.run);
			return {
				content: [{ type: "text", text: `Message sent to ${params.name}.` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "team_collect",
		label: "Team collect",
		description:
			"Collect results from workers. Optionally wait up to 'wait' seconds for them to finish. " +
			"Returns each worker's state and final result (its team_done summary, or its last " +
			"assistant output).",
		parameters: Type.Object({
			names: Type.Optional(
				Type.Array(Type.String(), {
					description: "Worker names to collect (default: all workers)",
				}),
			),
			wait: Type.Optional(
				Type.Number({
					description: "Seconds to wait for running workers (default 0, max 900)",
				}),
			),
		}),
		execute: async (_id, params, signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!active) throw new Error("no active team");
			const st = active;
			const targets = params.names
				? params.names
						.map((n) => n.trim())
						.filter(Boolean)
						.map((n) => {
							const m = findMember(st.run, n);
							if (!m) throw new Error(`unknown worker "${n}"`);
							return m;
						})
				: [...st.run.members];
			const waitSec = Math.max(0, Math.min(900, Math.floor(params.wait ?? 0)));
			const deadline = Date.now() + waitSec * 1000;

			const isFinished = (d: MemberDerived) =>
				d.status === "done" || d.status === "failed" || d.status === "dismissed";

			let derived = await deriveMembers(st.dir, st.run, {
				paneExists: paneExistsFor(st),
			});
			while (
				waitSec > 0 &&
				Date.now() < deadline &&
				derived.some((d) => !isFinished(d)) &&
				!signal?.aborted
			) {
				await new Promise((r) => setTimeout(r, 2000));
				void pumpLeadInbox();
				derived = await deriveMembers(st.dir, st.run, {
					paneExists: paneExistsFor(st),
				});
			}
			lastDerived = derived;
			updateWidget();

			const sections: string[] = [];
			let budget = 0;
			for (const d of derived) {
				if (!targets.some((t) => t.name === d.member.name)) continue;
				const head = `## ${d.member.name} — ${d.status}${d.member.model ? ` (${d.member.model})` : ""}`;
				let body = d.result?.trim() ?? "(no result)";
				const cap = Math.max(2000, PER_RESULT_CAP - budget);
				if (body.length > cap) body = `${body.slice(0, cap)}\n…(truncated)`;
				budget += body.length;
				sections.push(`${head}\n\n${body}`);
			}
			const pending = derived.filter(
				(d) => targets.some((t) => t.name === d.member.name) && !isFinished(d),
			);
			const note = pending.length
				? `\n\nStill running: ${pending.map((d) => d.member.name).join(", ")} — call team_collect again.`
				: "";
			return {
				content: [
					{ type: "text", text: sections.join("\n\n") + note || "no results" },
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "team_log",
		label: "Team log",
		description:
			"Show recent output from a worker (its session transcript: prompts, tool calls, " +
			"assistant text). Works for tmux-pane and background workers alike. Omit name for " +
			"the most recently active worker.",
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "Worker name" })),
			lines: Type.Optional(Type.Number({ description: "Lines to show (default from config)" })),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!active) throw new Error("no active team");
			const st = active;
			const lines = Math.max(5, Math.min(300, Math.floor(params.lines ?? st.cfg.logTailLines)));
			let m = params.name ? findMember(st.run, params.name) : undefined;
			if (params.name && !m) throw new Error(`unknown worker "${params.name}"`);
			if (!m) {
				const live = [...st.run.members]
					.filter((x) => !x.dismissed)
					.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
				m = live[0] ?? st.run.members[0];
				if (!m) throw new Error("no workers in this team");
			}
			const text = workerLogText(st, m, lines);
			return {
				content: [{ type: "text", text: `--- ${m.name} (${m.backend}) ---\n${text}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "team_dismiss",
		label: "Team dismiss",
		description:
			"Stop and remove a worker (or all workers when 'name' is 'all' or omitted). " +
			"Kills the tmux pane or background process and marks the worker dismissed. " +
			"Dismissed workers are hidden from the roster by default (hideDismissed). " +
			"Use when a worker is stuck, failed, or its work is no longer needed. " +
			"Finished workers stay in the roster for review until dismissed; with " +
			"autoDismiss set they are dismissed automatically on finish.",
		parameters: Type.Object({
			name: Type.Optional(
				Type.String({ description: "Worker name, or 'all' to dismiss everyone" }),
			),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!active) throw new Error("no active team");
			const st = active;
			const all = !params.name || params.name === "all";
			const targets = all
				? st.run.members.filter((m) => !m.dismissed)
				: [findMember(st.run, params.name as string)].filter((m): m is Member => !!m);
			if (targets.length === 0) {
				throw new Error(
					all ? "no active workers" : `unknown worker "${params.name}"`,
				);
			}
			const tmux = getTmux(st);
			const names: string[] = [];
			for (const m of targets) {
				await dismissWorker(st, m);
				names.push(m.name);
			}
			writeRun(st.dir, st.run);
			if (all && st.run.members.every((m) => m.dismissed)) {
				await tmux.killSwarmSession().catch(() => {});
			}
			void refreshDerived();
			return {
				content: [
					{ type: "text", text: `Dismissed: ${names.join(", ")}. Use team_cleanup to remove the run directory.` },
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "team_cleanup",
		label: "Team cleanup",
		description:
			"Remove the team run directory (inboxes, logs, prompts, sessions). Refuses while workers " +
			"are still active unless force=true.",
		parameters: Type.Object({
			force: Type.Optional(
				Type.Boolean({
					description: "Remove the run directory even if workers are still active",
				}),
			),
		}),
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			lastCtx = ctx;
			if (!active) {
				return {
					content: [{ type: "text", text: "No active team to clean up." }],
					details: undefined,
				};
			}
			const live = active.run.members.filter((m) => !m.dismissed);
			if (live.length > 0 && !params.force) {
				throw new Error(
					`${live.length} worker(s) still active (${live.map((m) => m.name).join(", ")}). ` +
						"Dismiss them first or pass force=true.",
				);
			}
			const st = active;
			const cfg = active.cfg;
			const runId = active.runId;
			if (live.length > 0) {
				// force: stop the still-running workers before removing state.
				const tmux = getTmux(st);
				for (const m of live) {
					if (m.backend === "process" && m.pid) {
						try {
							process.kill(m.pid, "SIGTERM");
						} catch {
							/* gone */
						}
					} else if (m.paneId && m.backend.startsWith("tmux-")) {
						await tmux.stopWorker(m.paneId, m.backend === "tmux-lead", m.windowId).catch(() => {});
					}
				}
				await tmux.killSwarmSession().catch(() => {});
			}
			removeRun(cfg.teamDir, runId);
			stopTimers();
			active = null;
			lastDerived = [];
			updateWidget();
			return {
				content: [{ type: "text", text: `Removed team ${runId}.` }],
				details: undefined,
			};
		},
	});

	/* ------------------------------------------------------------------ */
	/* Commands                                                            */
	/* ------------------------------------------------------------------ */

	pi.registerCommand("team", {
		description: "Show the team roster, backend, and config. `/team all` also lists dismissed workers",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			if (!active) {
				ctx.ui.notify("No active team (team_spawn creates one).", "info");
				return;
			}
			const st = active;
			refreshCfg(st); // live config for the footer line
			const derived = await deriveMembers(st.dir, st.run, {
				paneExists: paneExistsFor(st),
			});
			lastDerived = derived;
			updateWidget();
			const cfg = st.cfg;
			const hasSwarm = derived.some((d) => d.member.backend === "tmux-swarm");
			const attachHint =
				hasSwarm && (await getTmux(st).swarmSessionExists())
					? swarmAttachHint(st.runId)
					: undefined;
			const showAll = args.trim().toLowerCase() === "all";
			const text =
				renderRoster(st.runId, derived, {
					attachHint,
					cwd: st.cwd,
					hideDismissed: cfg.hideDismissed && !showAll,
				}) +
				`\n\nbackend: ${cfg.backend}  maxWorkers: ${cfg.maxWorkers}  leadPanePct: ${cfg.leadPanePct}` +
				`\nrun dir: ${st.dir}` +
				`\nruns: ${listRuns(cfg.teamDir).slice(0, 5).join(", ") || "none"}`;
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("team-log", {
		description: "Open a log view for a worker: /team-log [name]",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			if (!active) {
				ctx.ui.notify("No active team.", "warning");
				return;
			}
			const name = args.trim() || undefined;
			let m = name ? findMember(active.run, name) : undefined;
			if (name && !m) {
				ctx.ui.notify(`Unknown worker "${name}".`, "error");
				return;
			}
			if (!m) {
				const live = [...active.run.members]
					.filter((x) => !x.dismissed)
					.sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1));
				m = live[0] ?? active.run.members[0];
			}
			if (!m) {
				ctx.ui.notify("No workers in this team.", "warning");
				return;
			}
			const lines = active.cfg.logTailLines * 2;
			const text = workerLogText(active, m, lines);
			ctx.ui.custom<string | null>((_tui, theme, _kb, done) => {
				const body = new Text(`${m.name} — ${m.backend}\n\n${text}`, 1, 0);
				const footer = new Text(theme.fg("muted", "  esc / q to close"), 1, 0);
				return {
					render: (w: number): string[] => [
						...body.render(w),
						...footer.render(w),
					],
					handleInput: (data: string) => {
						if (data === "\x1b" || data === "q" || data === "Q") done(null);
					},
					invalidate: () => {
						body.invalidate();
						footer.invalidate();
					},
				};
			}, { overlay: true });
		},
	});

	/* ------------------------------------------------------------------ */
	/* Lifecycle                                                           */
	/* ------------------------------------------------------------------ */

	pi.on("session_shutdown", async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		stopTimers();
		const st = active;
		if (!st) return;
		try {
			// Queued (not yet started) workers can't run after the lead is
			// gone: drop them. If killWorkersOnExit is set their placeholder
			// panes die with the teardown below; otherwise a re-attaching lead
			// marks them failed on pickup.
			st.queue?.drain();
			if (st.cfg.killWorkersOnExit) {
				const tmux = getTmux(st);
				for (const m of st.run.members.filter((x) => !x.dismissed)) {
					if (m.backend === "process" && m.pid) {
						try {
							process.kill(m.pid, "SIGTERM");
						} catch {
							/* gone */
						}
					} else if (m.paneId && m.backend.startsWith("tmux-")) {
						await tmux.stopWorker(m.paneId, m.backend === "tmux-lead", m.windowId).catch(() => {});
					}
				}
				await tmux.killSwarmSession().catch(() => {});
				removeRun(st.cfg.teamDir, st.runId);
			}
		} catch {
			/* best effort */
		}
	});
}

export { kickoffPrompt as _kickoffPrompt };

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { TeamConfig } from "./config.js";

/**
 * Building worker invocations.
 *
 * Two shapes:
 *  - pane mode: a shell command string for tmux `respawn-pane -- <cmd>`.
 *    tmux runs it through the user's default shell, so every embedded
 *    value is single-quote escaped. The task itself is never in the
 *    command — the worker reads a task file (see bootstrap prompt).
 *  - process mode: a plain argv array for child_process.spawn (no shell),
 *    with env passed directly.
 */

/** Minimal safe-char fast path; everything else gets single-quoted. */
const SAFE_RE = /^[A-Za-z0-9_\-.,/=@%+]+$/;

export function shellQuote(s: string): string {
	if (s.length === 0) return "''";
	if (SAFE_RE.test(s)) return s;
	return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface PiCommand {
	command: string;
	/** Fixed args before pi's own options (e.g. [cli.js] when pinning a build). */
	prefix: string[];
}

/**
 * Resolve the pi command used to launch workers.
 *
 * Honors config.workerCommand (may contain fixed args), otherwise pins
 * the running pi build (same behavior as pi's subagent example), falling
 * back to `pi` on PATH.
 */
export function resolvePiCommand(
	config: TeamConfig,
	opts?: { execPath?: string; argv1?: string },
): PiCommand {
	if (config.workerCommand) {
		const parts = config.workerCommand.trim().split(/\s+/).filter(Boolean);
		return { command: parts[0], prefix: parts.slice(1) };
	}
	const execPath = opts?.execPath ?? process.execPath;
	const argv1 = opts?.argv1 ?? process.argv[1];
	if (argv1 && !argv1.startsWith("/$bunfs/root/") && existsSync(argv1)) {
		return { command: execPath, prefix: [argv1] };
	}
	const execName = basename(execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: execPath, prefix: [] };
	}
	return { command: "pi", prefix: [] };
}

export interface WorkerLaunchOpts {
	cwd: string;
	name: string;
	runId: string;
	runDir: string;
	/** Absolute path to the worker extension (loaded with -e). */
	workerExtPath: string;
	/** Absolute path to the filled worker bootstrap prompt. */
	bootstrapPath: string;
	/** Absolute path to the task file. */
	taskFile: string;
	model?: string;
	thinking?: string;
	mode: "pane" | "process";
}

export interface WorkerLaunch {
	/** Full argv for child_process.spawn in process mode (includes prefix). */
	argv: string[];
	/** Shell command string for tmux respawn-pane in pane mode. */
	paneCommand: string;
	/** Extra env for the worker process. */
	env: Record<string, string>;
	/** Kickoff prompt (CLI arg in process mode; extension-sent in pane mode). */
	kickoff: string;
}

/** The kickoff prompt: identical text in both modes. */
export function kickoffPrompt(taskFile: string): string {
	return `Begin: your task is described in ${taskFile}. Read it, then complete the work. When finished, report your final result with the team_done tool.`;
}

export function buildWorkerLaunch(pi: PiCommand, o: WorkerLaunchOpts): WorkerLaunch {
	const args: string[] = [...pi.prefix];
	args.push("--name", o.name);
	args.push("--session-dir", join(o.runDir, "sessions"));
	if (o.model) args.push("--model", o.model);
	if (o.thinking) args.push("--thinking", o.thinking);
	args.push("--append-system-prompt", o.bootstrapPath);
	args.push("-e", o.workerExtPath);

	const env: Record<string, string> = {
		PI_TEAM_RUN: o.runId,
		PI_TEAM_NAME: o.name,
		PI_TEAM_DIR: o.runDir,
		PI_TEAM_ROLE: "worker",
		PI_TEAM_MODE: o.mode,
	};

	if (o.mode === "process") {
		args.push("--mode", "json", "-p");
		// Workers run in the lead's project; auto-approve so a one-shot
		// background worker can't hang on a project-trust prompt.
		args.push("--approve");
		args.push(kickoffPrompt(o.taskFile));
	}

	const cmd = `${shellQuote(pi.command)} ${args.map(shellQuote).join(" ")}`;
	const envStr = Object.entries(env)
		.map(([k, v]) => `${k}=${shellQuote(v)}`)
		.join(" ");
	const paneCommand = `cd ${shellQuote(o.cwd)} && env ${envStr} ${cmd}`;

	return { argv: [pi.command, ...args], paneCommand, env, kickoff: kickoffPrompt(o.taskFile) };
}

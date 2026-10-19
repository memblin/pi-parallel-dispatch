import { execFile } from "node:child_process";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
	killed?: boolean;
}

export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: { timeoutMs?: number; cwd?: string },
) => Promise<ExecResult>;

/** Default executor: execFile (no shell), bounded buffer. */
export function makeExec(): ExecFn {
	return (cmd, args, opts) =>
		new Promise<ExecResult>((resolve) => {
			execFile(
				cmd,
				args,
				{
					timeout: opts?.timeoutMs ?? 15000,
					maxBuffer: 1024 * 1024,
					cwd: opts?.cwd,
					// Never let a hung command resolve the promise.
					killSignal: "SIGKILL",
				},
				(err, stdout, stderr) => {
					resolve({
						code: typeof (err as { code?: number })?.code === "number" ? (err as { code: number }).code : err ? 1 : 0,
						stdout: String(stdout ?? ""),
						stderr: String(stderr ?? ""),
						killed: Boolean((err as { killed?: boolean })?.killed),
					});
				},
			);
		});
}

/** True when tmux reports the pane/window is too small to split. */
export function isNoSpaceError(stderr: string): boolean {
	const s = (stderr ?? "").toLowerCase();
	return s.includes("no space") || s.includes("too small") || s.includes("pane too small");
}

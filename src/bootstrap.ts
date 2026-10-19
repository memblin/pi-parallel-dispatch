/**
 * Fill the worker bootstrap template for one worker.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";

export interface BootstrapInput {
	packageDir: string;
	name: string;
	runId: string;
	cwd: string;
	taskFile: string;
}

export function renderBootstrap(input: BootstrapInput): string {
	const tpl = readFileSync(join(input.packageDir, "prompts", "worker-bootstrap.md"), "utf8");
	return tpl
		.replaceAll("{{name}}", input.name)
		.replaceAll("{{runId}}", input.runId)
		.replaceAll("{{cwd}}", input.cwd)
		.replaceAll("{{taskFile}}", input.taskFile);
}

/** Write the filled bootstrap next to the task file; returns its path. */
export function writeBootstrap(
	runDir: string,
	promptsDir: string,
	input: BootstrapInput,
): string {
	mkdirSync(promptsDir, { recursive: true });
	const path = join(promptsDir, `${input.name}.bootstrap.md`);
	writeFileSync(path, renderBootstrap(input));
	return path;
}

export { join, dirname };

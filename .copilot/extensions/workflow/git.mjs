/**
 * @module git
 *
 * Low-level `git` subprocess helper shared by the read-only harness runner (`hostio`) and the
 * worktree manager (`worktree`). Spawns asynchronously so a slow command never blocks the extension's
 * event loop, and **never rejects**: a spawn failure or non-zero exit is reported as a
 * `{ code, stdout, stderr }` result (a spawn error surfaces as code 127 with the message on stderr).
 * Output is bounded so a runaway command can't buffer without limit. Callers layer their own
 * read-only guards / throwing on top.
 *
 * Pure Node built-ins only, so it stays unit-testable under plain `node --test`.
 */
import { spawn } from "node:child_process";

import { appendBounded } from "./text-buffer.mjs";

/** @typedef {{ code: number, stdout: string, stderr: string }} GitResult */

const DEFAULT_MAX_OUTPUT_CHARS = 64_000;

/**
 * Run `git args` in `cwd`, capturing bounded stdout/stderr. Resolves (never rejects) with the exit
 * code and captured streams.
 * @param {string[]} args @param {string} cwd @param {number} [maxChars]
 * @returns {Promise<GitResult>}
 */
export function spawnGit(args, cwd, maxChars = DEFAULT_MAX_OUTPUT_CHARS) {
	return new Promise((res) => {
		const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (c) => (stdout = appendBounded(stdout, c, maxChars)));
		child.stderr.setEncoding("utf8").on("data", (c) => (stderr = appendBounded(stderr, c, maxChars)));
		child.on("error", (e) => res({ code: 127, stdout: "", stderr: String(e?.message || e) }));
		child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
	});
}

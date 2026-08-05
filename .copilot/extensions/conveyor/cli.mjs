/** @module cli — process-backed `copilot -p` agent transport. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import {
	childEnv,
	CLI_BACKEND,
	errMsg,
	reduceAgentEvent,
	resolveCopilotBin,
	runWithLifecycle,
} from "./agent.mjs";
import { appendBounded } from "./text-buffer.mjs";

/** @typedef {import("./agent.mjs").AgentSpec} AgentSpec */

const POSIX = process.platform !== "win32";
const MAX_STDERR_CHARS = 64_000;

/** @param {{ cliBin?: string }} [defaults] */
export function createCliBackend(defaults = {}) {
	return {
		kind: CLI_BACKEND,
		openRun() {
			return { kind: CLI_BACKEND, run: (/** @type {AgentSpec} */ spec, opts = {}) => runAgent(spec, { ...defaults, ...opts }), abort() {}, async close() {} };
		},
	};
}

/** @param {{ cliBin?: string }} [defaults] */
export function createCliRunBackend(defaults = {}) {
	return createCliBackend(defaults).openRun();
}

/** @param {AgentSpec} spec @param {string} [bin] @param {string|null} [sessionId] */
export function buildArgv(spec, bin = resolveCopilotBin(), sessionId = null) {
	const argv = [bin, "-p", spec.prompt, "--output-format", "json", "--no-ask-user", "--no-color", "--no-auto-update", "--no-remote-export"];
	if (spec.allowAllTools !== false) argv.push("--allow-all-tools");
	if (spec.allowAllUrls) argv.push("--allow-all-urls");
	if (spec.autopilot) argv.push("--autopilot");
	if (!spec.enableMcp) argv.push("--disable-builtin-mcps");
	/** @type {[string, string|null|undefined][]} */
	const scalarFlags = [
		["--resume", spec.resume],
		["--session-id", spec.resume ? null : sessionId],
		["--model", spec.model],
		["--agent", spec.agentType],
		["--effort", spec.effort],
		["--context", spec.context],
		["-C", spec.cwd],
	];
	for (const [flag, value] of scalarFlags) if (value) argv.push(flag, value);
	/** @type {[string, string[]|null|undefined][]} */
	const listFlags = [
		["--allow-tool", spec.allow],
		["--deny-tool", spec.deny],
		["--allow-url", spec.allowUrl],
		["--deny-url", spec.denyUrl],
		["--available-tools", spec.availableTools],
		["--excluded-tools", spec.excludedTools],
		["--add-dir", spec.addDir],
	];
	for (const [flag, values] of listFlags) for (const value of values || []) argv.push(flag, value);
	return argv;
}

/** @param {AgentSpec} input @param {{ bin?: string, cliBin?: string, signal?: AbortSignal }} [opts] */
export async function runAgent(input, opts = {}) {
	const spec = input;
	const sessionId = spec.resume ? null : randomUUID();
	const bin = resolveCopilotBin(opts.bin ?? opts.cliBin);
	return runWithLifecycle(spec, { ...opts, sessionId }, async ({ acc, onStop, terminated, complete }) => {
		const group = POSIX;
		let child;
		try {
			child = spawn(bin, buildArgv(spec, bin, sessionId).slice(1), {
				cwd: spec.cwd || undefined,
				env: childEnv(),
				detached: group,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			return { exitCode: 127, error: `failed to spawn ${bin}: ${errMsg(error)}` };
		}
		const lines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
		let stderr = "";
		/** @type {string|null} */
		let spawnError = null;
		const exited = new Promise((resolve) => {
			child.once("error", (error) => {
				spawnError = errMsg(error);
				resolve(127);
			});
			child.once("exit", (code) => resolve(code ?? (terminated() ? 143 : 1)));
		});
		onStop(() => {
			lines?.close();
			killChild(child, group);
		});
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS);
		});
		try {
			if (lines) for await (const line of lines) reduceAgentEvent(acc, tryParse(line));
		} catch {
			// Exit state reports stream failures.
		}
		const exitCode = await exited;
		complete();
		if (spawnError) return { exitCode: 127, error: `failed to spawn ${bin}: ${spawnError}` };
		return { exitCode, stderr };
	});
}

/** @param {import("node:child_process").ChildProcess} child @param {boolean} group */
function killChild(child, group) {
	try {
		if (group && POSIX && child.pid) process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		// Already exited.
	} finally {
		child.stdout?.destroy();
		child.stderr?.destroy();
	}
}

/** @param {string} line */
function tryParse(line) {
	try {
		return line.trim() ? JSON.parse(line) : null;
	} catch {
		return null;
	}
}

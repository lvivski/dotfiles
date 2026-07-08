/**
 * @module agent
 *
 * Spawn one `copilot -p` subagent and reduce its JSONL event stream to an {@link AgentResult}.
 * Pure Node built-ins only (no SDK import) so the engine is unit-testable under plain `node`
 * with a fake `copilot` binary (see `fixtures/fake-copilot.mjs`, selected via `CWF_COPILOT_BIN`).
 *
 * AIC/token accounting reads the child's own session log — written by `copilot` to
 * `$COPILOT_HOME/session-state/<childSessionId>/events.jsonl` — and pulls the `session.shutdown`
 * record's `totalNanoAiu` + per-model `ShutdownModelMetricUsage` token breakdown.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const POSIX = process.platform !== "win32";

/**
 * A subagent launch spec. Only `prompt` is required; everything else tunes the `copilot` argv.
 * @typedef {object} AgentSpec
 * @property {string} prompt
 * @property {string|null} [model]        `--model`
 * @property {string|null} [agentType]    `--agent <persona>`
 * @property {string|null} [effort]       `--effort none|low|medium|high|xhigh|max`
 * @property {string|null} [context]      `--context default|long_context`
 * @property {string|null} [cwd]          `-C <dir>` and the subprocess cwd (normalized absolute)
 * @property {string[]|null} [allow]      extra `--allow-tool` values
 * @property {string[]|null} [deny]       `--deny-tool` values (precedence over allow)
 * @property {string[]|null} [allowUrl]   `--allow-url` values
 * @property {string[]|null} [denyUrl]    `--deny-url` values
 * @property {string[]|null} [addDir]     `--add-dir` values
 * @property {string|null} [mcp]          `--additional-mcp-config` (inline JSON or a file path prefixed with '@')
 * @property {boolean} [enableMcp]        keep built-in MCP servers (omit `--disable-builtin-mcps`)
 * @property {boolean} [allowAllTools]    blanket pre-auth (`--allow-all-tools`); off for quarantine
 * @property {string|null} [resume]       session id to resume (follow-up turns)
 * @property {number|null} [timeout]      seconds; kills the process tree if exceeded
 * @property {string|null} [label]        human label for logs/progress
 * @property {string[]|null} [extraArgs]
 */

/**
 * Structured outcome of a subagent run. Field names match the migration plan's agent-result shape.
 * @typedef {object} AgentResult
 * @property {string} content
 * @property {boolean} ok
 * @property {string|null} error
 * @property {string|null} sessionId
 * @property {string|null} model
 * @property {boolean} cached      true when served from a resumed run's checkpoint
 * @property {boolean} skipped     true when budget-skipped / aborted (not a failure)
 * @property {string|null} label
 * @property {number} nanoAiu
 * @property {number} aic          `nanoAiu / 1e9`
 * @property {number} outputTokens
 * @property {number} inputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} reasoningTokens
 * @property {number} durationMs
 * @property {number} exitCode
 * @property {string[]|null} warnings
 */

/** @returns {string} the copilot binary/path (override with `CWF_COPILOT_BIN`). */
export const copilotBin = () => process.env.CWF_COPILOT_BIN || "copilot";

/** @returns {string} `$COPILOT_HOME` or `~/.copilot`. */
const copilotHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

/** @param {unknown} x @returns {number} defensive integer cast (never throws). */
const toInt = (x) => {
	const n = Number(x);
	return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * Translate an {@link AgentSpec} into a `copilot` argv (no shell).
 * @param {AgentSpec} spec
 * @param {string} [bin]
 * @returns {string[]}
 */
export function buildArgv(spec, bin = copilotBin()) {
	// Always-on flags for ephemeral headless subagents: never prompt, no ANSI, never self-update
	// mid-fan-out (avoids network races / version skew), and never mirror the session to
	// GitHub web/mobile (`remoteExport` defaults on) or accept remote control.
	const argv = [bin, "-p", spec.prompt, "--output-format", "json", "--no-ask-user", "--no-color", "--no-auto-update", "--no-remote-export"];
	if (spec.allowAllTools !== false) argv.push("--allow-all-tools");
	if (!spec.enableMcp) argv.push("--disable-builtin-mcps");
	/** @type {[string, string|null|undefined][]} */
	const singles = [
		["--resume", spec.resume],
		["--model", spec.model],
		["--agent", spec.agentType],
		["--effort", spec.effort],
		["--context", spec.context],
		["--additional-mcp-config", spec.mcp],
		["-C", spec.cwd],
	];
	for (const [flag, value] of singles) if (value) argv.push(flag, value);
	/** @type {[string, string[]|null|undefined][]} */
	const repeats = [
		["--allow-tool", spec.allow],
		["--deny-tool", spec.deny],
		["--allow-url", spec.allowUrl],
		["--deny-url", spec.denyUrl],
		["--add-dir", spec.addDir],
	];
	for (const [flag, values] of repeats) for (const v of values || []) argv.push(flag, v);
	return argv.concat(spec.extraArgs || []);
}

/**
 * Child env: increment `CWF_DEPTH` and stamp recursion-guard vars so a spawned subagent cannot
 * accidentally launch more workflows (the extension refuses to register `run_workflow` when
 * `CWF_DISABLE_WORKFLOW_TOOLS=1`).
 * @param {NodeJS.ProcessEnv} [base]
 * @param {{ runId?: string|null, agentId?: string|null }} [guard]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(base = process.env, guard = {}) {
	const env = { ...base };
	env.CWF_DEPTH = String(toInt(env.CWF_DEPTH) + 1);
	env.CWF_DISABLE_WORKFLOW_TOOLS = "1";
	if (guard.runId) env.CWF_PARENT_RUN_ID = guard.runId;
	if (guard.agentId) env.CWF_PARENT_AGENT_ID = guard.agentId;
	return env;
}

// --- live-subprocess registry: reap children on interrupt/timeout so none orphan (keep spending).
/** @type {Set<{ child: import("node:child_process").ChildProcess, group: boolean }>} */
const LIVE = new Set();

/** @param {import("node:child_process").ChildProcess} child @param {boolean} group */
function killChild(child, group) {
	try {
		if (group && POSIX && child.pid) process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		/* already exited / no such group */
	}
}

/** Kill every still-running subagent. Best-effort, idempotent (called on run abort). */
export function killAllAgents() {
	for (const entry of [...LIVE]) killChild(entry.child, entry.group);
}

/**
 * Read the child session's `session.shutdown` record and extract AIC + token usage.
 * @param {string|null} sessionId
 * @returns {Promise<{ nanoAiu: number, tokens: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number } }>}
 */
async function readShutdownUsage(sessionId) {
	const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	if (!sessionId) return { nanoAiu: 0, tokens: empty };
	const path = join(copilotHome(), "session-state", sessionId, "events.jsonl");
	if (!existsSync(path)) return { nanoAiu: 0, tokens: empty };
	/** @type {any} */
	let shutdown = null;
	try {
		for await (const line of readLines(path)) {
			const rec = tryParse(line);
			// Mirror Python: take the first shutdown that carries a totalNanoAiu.
			if (rec && rec.type === "session.shutdown" && rec.data?.totalNanoAiu != null) {
				shutdown = rec;
				break;
			}
		}
	} catch {
		return { nanoAiu: 0, tokens: empty }; // log deleted/unreadable after existsSync — match Python's OSError -> 0
	}
	const data = shutdown?.data;
	if (!data) return { nanoAiu: 0, tokens: empty };
	const tokens = { ...empty };
	for (const metric of Object.values(data.modelMetrics || {})) {
		const u = /** @type {any} */ (metric)?.usage;
		if (!u) continue;
		tokens.inputTokens += toInt(u.inputTokens);
		tokens.outputTokens += toInt(u.outputTokens);
		tokens.cacheReadTokens += toInt(u.cacheReadTokens);
		tokens.cacheWriteTokens += toInt(u.cacheWriteTokens);
		tokens.reasoningTokens += toInt(u.reasoningTokens);
	}
	return { nanoAiu: toInt(data.totalNanoAiu), tokens };
}

/** @param {string} path @returns {AsyncIterable<string>} */
function readLines(path) {
	return createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
}

/** @param {string} line @returns {any} parsed JSON or null. */
function tryParse(line) {
	const s = line.trim();
	if (!s) return null;
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

/**
 * Run one subagent to completion and return a structured {@link AgentResult}.
 * Never rejects for ordinary subagent failure (returns `ok:false`); rejects only for
 * programmer errors. `signal` (from the runtime's abort controller) kills the child if fired.
 *
 * @param {AgentSpec} spec
 * @param {{ bin?: string, signal?: AbortSignal, guard?: { runId?: string|null, agentId?: string|null } }} [opts]
 * @returns {Promise<AgentResult>}
 */
export async function runAgent(spec, opts = {}) {
	const bin = opts.bin || copilotBin();
	const started = Date.now();
	const model = spec.model ?? null;

	if (spec.cwd && (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory())) {
		return result(spec, { started, model, error: `working directory not found: ${spec.cwd}`, exitCode: 1 });
	}

	// Timeout agents get their own process group so one kill takes down the whole tree.
	const group = POSIX && !!spec.timeout;
	/** @type {import("node:child_process").ChildProcess} */
	let child;
	try {
		child = spawn(bin, buildArgv(spec, bin).slice(1), {
			cwd: spec.cwd || undefined,
			env: childEnv(process.env, opts.guard),
			detached: group,
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (e) {
		return result(spec, { started, model, error: `failed to spawn ${bin}: ${errMsg(e)}`, exitCode: 127 });
	}

	const entry = { child, group };
	LIVE.add(entry);

	const acc = { content: /** @type {string|null} */ (null), outputTokens: 0, sessionId: /** @type {string|null} */ (null), model, sessionErrors: /** @type {string[]} */ ([]) };
	let killed = false;
	const stderr = /** @type {string[]} */ ([]);

	// Attach exit listeners immediately: an async spawn error (ENOENT) or an early close must not slip
	// through unobserved, and an unhandled `error` event would otherwise crash the process. A spawn
	// error is classified like Python's FileNotFoundError -> 127.
	let spawnError = /** @type {Error|null} */ (null);
	const exited = new Promise((resolve) => {
		child.once("error", (e) => {
			spawnError = e instanceof Error ? e : new Error(String(e));
			resolve(127);
		});
		child.once("close", (code) => resolve(code ?? (killed ? 143 : 1)));
	});

	const onAbort = () => killChild(child, group);
	if (opts.signal) {
		if (opts.signal.aborted) onAbort();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	let timer = null;
	if (spec.timeout) {
		timer = setTimeout(() => {
			killed = true;
			killChild(child, group);
		}, Math.max(1, spec.timeout * 1000));
		timer.unref?.();
	}

	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		if (stderr.length < 200) stderr.push(chunk);
	});

	try {
		if (child.stdout) {
			for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
				reduce(acc, tryParse(line));
			}
		}
	} catch {
		/* stdout read error — the exit code / kill state below reports it */
	}

	const exitCode = await exited;

	if (timer) clearTimeout(timer);
	if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
	LIVE.delete(entry);

	if (spawnError) return result(spec, { started, model, error: `failed to spawn ${bin}: ${spawnError.message}`, exitCode: 127 });

	const usage = await readShutdownUsage(acc.sessionId);
	return result(spec, {
		started,
		model: acc.model,
		content: acc.content,
		sessionId: acc.sessionId,
		outputTokens: acc.outputTokens || usage.tokens.outputTokens,
		usage,
		exitCode,
		killed,
		stderr: stderr.join(""),
		sessionErrors: acc.sessionErrors,
	});
}

/**
 * Fold one JSONL event into the running accumulator (last non-empty assistant content wins).
 * @param {{ content: string|null, outputTokens: number, sessionId: string|null, model: string|null, sessionErrors: string[] }} acc
 * @param {any} obj
 */
function reduce(acc, obj) {
	if (!obj) return;
	if (obj.type === "assistant.message") {
		const data = obj.data || {};
		acc.content = data.content || acc.content;
		acc.outputTokens += toInt(data.outputTokens);
		acc.model = data.model || acc.model;
	} else if (obj.type === "result") {
		acc.sessionId = obj.sessionId ?? acc.sessionId;
	} else if (obj.type === "session.error") {
		acc.sessionErrors.push(formatSessionError(obj.data || {}));
	}
}

/**
 * Assemble the final {@link AgentResult} and classify ok/error.
 * @param {AgentSpec} spec
 * @param {{ started: number, model: string|null, content?: string|null, sessionId?: string|null, outputTokens?: number, usage?: { nanoAiu: number, tokens: any }, exitCode: number, killed?: boolean, stderr?: string, sessionErrors?: string[], error?: string|null }} p
 * @returns {AgentResult}
 */
function result(spec, p) {
	const content = p.content ?? "";
	const sessionErrors = p.sessionErrors || [];
	let error = p.error ?? null;
	if (error == null) {
		if (p.killed) error = `timed out after ${spec.timeout}s`;
		else if (p.exitCode !== 0) error = (p.stderr || "").trim() || `exited with code ${p.exitCode}`;
		else if (sessionErrors.length && !content.trim()) error = sessionErrors.join("; ");
		else if (p.content == null) error = "no assistant message in output";
	}
	const nanoAiu = p.usage?.nanoAiu ?? 0;
	const tokens = p.usage?.tokens ?? { inputTokens: 0, outputTokens: p.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	return {
		content,
		ok: p.exitCode === 0 && p.content != null && !p.killed && error == null,
		error,
		sessionId: p.sessionId ?? null,
		model: p.model,
		cached: false,
		skipped: false,
		label: spec.label ?? null,
		nanoAiu,
		aic: nanoAiu / 1_000_000_000,
		outputTokens: p.outputTokens ?? tokens.outputTokens ?? 0,
		inputTokens: tokens.inputTokens ?? 0,
		cacheReadTokens: tokens.cacheReadTokens ?? 0,
		cacheWriteTokens: tokens.cacheWriteTokens ?? 0,
		reasoningTokens: tokens.reasoningTokens ?? 0,
		durationMs: Date.now() - p.started,
		exitCode: p.exitCode,
		warnings: sessionErrors.length ? sessionErrors : null,
	};
}

/**
 * Format a `session.error` record, mirroring Python's `_format_session_error` fallbacks:
 * `errorType|type` + `message|error|reason`.
 * @param {any} d @returns {string}
 */
export function formatSessionError(d) {
	const errType = d.errorType || d.type;
	const message = d.message || d.error || d.reason;
	if (errType && message) return `${errType}: ${message}`;
	return String(message || errType || "session.error");
}

/** @param {unknown} e @returns {string} */
function errMsg(e) {
	return e instanceof Error ? e.message : String(e);
}

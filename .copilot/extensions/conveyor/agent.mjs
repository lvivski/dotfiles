/**
 * @module agent
 *
 * Transport-neutral agent contract and lifecycle, plus run-level CLI/SDK backend selection.
 */
import { createInterface } from "node:readline";
import { createReadStream, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CLI_BACKEND = "cli";
export const SDK_STDIO_BACKEND = "sdk";

/**
 * @typedef {object} AgentSpec
 * @property {string} prompt
 * @property {string|null} [model]
 * @property {string|null} [agentType]
 * @property {string|null} [effort]
 * @property {string|null} [context]
 * @property {string|null} [cwd]
 * @property {string[]|null} [allow]
 * @property {string[]|null} [deny]
 * @property {string[]|null} [allowUrl]
 * @property {string[]|null} [denyUrl]
 * @property {string[]|null} [availableTools]
 * @property {string[]|null} [excludedTools]
 * @property {boolean} [enableMcp]
 * @property {boolean} [allowAllTools]
 * @property {boolean} [allowAllUrls]
 * @property {string[]|null} [addDir]
 * @property {"off"|"on"|"auto"} [permissionMode]
 * @property {boolean} [autopilot]
 * @property {string|null} [resume]
 * @property {number|null} [timeout]
 * @property {string|null} [label]
 * @property {string|null} [cacheCwd]
 */

/**
 * @typedef {object} AgentResult
 * @property {"agent"} kind
 * @property {unknown} value
 * @property {string} content
 * @property {boolean} ok
 * @property {string|null} error
 * @property {string|null} sessionId
 * @property {string|null} model
 * @property {boolean} cached
 * @property {boolean} skipped
 * @property {string|null} label
 * @property {number|null} nanoAiu
 * @property {number|null} aic
 * @property {boolean} usageUnknown
 * @property {number} outputTokens
 * @property {number} inputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} reasoningTokens
 * @property {number} durationMs
 * @property {number} exitCode
 * @property {string[]|null} warnings
 */

/** @typedef {{ content: string|null, outputTokens: number, sessionId: string|null, model: string|null, sessionErrors: string[] }} AgentAccumulator */
/** @typedef {{ exitCode: number, stderr?: string, error?: string|null }} BackendOutcome */
/** @typedef {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number }} TokenUsage */
/** @typedef {{ found: boolean, nanoAiu: number, tokens: TokenUsage }} UsageSnapshot */

const CHILD_ENV_EXACT = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
	"LANG", "TERM", "NO_COLOR", "FORCE_COLOR",
	"COPILOT_HOME", "COPILOT_MODEL",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"GH_TOKEN", "GITHUB_TOKEN",
]);
const CHILD_ENV_PREFIXES = ["LC_", "COPILOT_PROVIDER_", "CONVEYOR_FAKE_"];
/** @type {Set<{ terminate: () => void }>} */
const LIVE = new Set();

/** Environment override wins over configured executable, preserving test and operator control. */
/** @param {string} [configured] */
export const resolveCopilotBin = (configured) => process.env.CONVEYOR_COPILOT_BIN || configured || "copilot";

/** @param {NodeJS.ProcessEnv} [base] */
export function childEnv(base = process.env) {
	const extra = new Set(String(base.CONVEYOR_CHILD_ENV_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
	/** @type {NodeJS.ProcessEnv} */
	const env = {};
	for (const [name, value] of Object.entries(base)) {
		if (value !== undefined && (CHILD_ENV_EXACT.has(name) || extra.has(name) || CHILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)))) {
			env[name] = value;
		}
	}
	env.CONVEYOR_DEPTH = String(toInt(base.CONVEYOR_DEPTH) + 1);
	env.CONVEYOR_DISABLE_TOOLS = "1";
	return env;
}

/** Synchronous emergency stop used by process exit and signal handlers. */
export function abortAllAgentTurns() {
	for (const entry of [...LIVE]) entry.terminate();
}

/**
 * @param {AgentSpec} spec
 * @param {{ signal?: AbortSignal, sessionId?: string|null }} opts
 * @param {(ctx: { acc: AgentAccumulator, onStop: (stop: () => void) => void, terminated: () => "timeout"|"aborted"|null, complete: () => void }) => Promise<BackendOutcome>} execute
 * @returns {Promise<AgentResult>}
 */
export async function runWithLifecycle(spec, opts, execute) {
	const started = Date.now();
	const model = spec.model ?? null;
	const usageBefore = await readShutdownUsage(spec.resume ?? null);
	if (spec.cwd && (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory())) {
		return agentResult(spec, { started, model, error: `working directory not found: ${spec.cwd}`, exitCode: 1 });
	}

	/** @type {AgentAccumulator} */
	const acc = { content: null, outputTokens: 0, sessionId: spec.resume ?? opts.sessionId ?? null, model, sessionErrors: [] };
	/** @type {"timeout"|"aborted"|null} */
	let termination = null;
	let completed = false;
	/** @type {(() => void)|null} */
	let stop = null;
	const terminate = (/** @type {"timeout"|"aborted"} */ reason) => {
		if (completed) return;
		termination ??= reason;
		stop?.();
	};
	const entry = { terminate: () => terminate("aborted") };
	LIVE.add(entry);
	const onAbort = () => terminate("aborted");
	if (opts.signal) {
		if (opts.signal.aborted) onAbort();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	let timer = null;
	if (spec.timeout) {
		timer = setTimeout(() => terminate("timeout"), Math.max(1, spec.timeout * 1000));
		timer.unref?.();
	}

	/** @type {BackendOutcome} */
	let outcome;
	try {
		outcome = termination
			? { exitCode: 143 }
			: await execute({
				acc,
				onStop(fn) {
					stop = fn;
					if (termination) fn();
				},
				terminated: () => termination,
				complete: () => {
					completed = true;
				},
			});
	} finally {
		if (timer) clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		LIVE.delete(entry);
	}

	const usage = usageDelta(await readShutdownUsage(acc.sessionId ?? spec.resume ?? null), usageBefore);
	return agentResult(spec, {
		started,
		model: acc.model,
		content: acc.content,
		sessionId: acc.sessionId,
		outputTokens: acc.outputTokens || usage?.tokens.outputTokens || 0,
		usage,
		exitCode: outcome.exitCode,
		timedOut: termination === "timeout",
		aborted: termination === "aborted",
		stderr: outcome.stderr,
		error: outcome.error,
		sessionErrors: acc.sessionErrors,
	});
}

/** @param {AgentAccumulator} acc @param {any} obj */
export function reduceAgentEvent(acc, obj) {
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

/** @param {AgentAccumulator} acc @param {any} obj */
export function reduceAgentResponse(acc, obj) {
	if (obj?.type === "assistant.message") {
		const data = obj.data || {};
		if (acc.content === data.content && acc.model === (data.model || acc.model)) return;
	}
	reduceAgentEvent(acc, obj);
}

/** @param {AgentSpec} spec @param {any} p @returns {AgentResult} */
export function agentResult(spec, p) {
	const content = p.content ?? "";
	const sessionErrors = p.sessionErrors || [];
	let error = p.error ?? null;
	if (error == null) {
		if (p.timedOut) error = `timed out after ${spec.timeout}s`;
		else if (p.aborted) error = "aborted";
		else if (p.exitCode !== 0) error = (p.stderr || "").trim() || `exited with code ${p.exitCode}`;
		else if (sessionErrors.length && !content.trim()) error = sessionErrors.join("; ");
		else if (p.content == null) error = "no assistant message in output";
	}
	const usageUnknown = p.usage == null;
	const nanoAiu = p.usage?.nanoAiu ?? null;
	const tokens = p.usage?.tokens ?? { inputTokens: 0, outputTokens: p.outputTokens ?? 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	if (usageUnknown && p.exitCode !== 127) sessionErrors.push("usage unavailable: child session metrics were not persisted");
	return {
		kind: "agent",
		value: content,
		content,
		ok: p.exitCode === 0 && p.content != null && !p.timedOut && !p.aborted && error == null,
		error,
		sessionId: p.sessionId ?? null,
		model: p.model,
		cached: false,
		skipped: false,
		label: spec.label ?? null,
		nanoAiu,
		aic: nanoAiu == null ? null : nanoAiu / 1_000_000_000,
		usageUnknown,
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

/** @param {any} d */
export function formatSessionError(d) {
	const errType = d.errorType || d.type;
	const message = d.message || d.error || d.reason;
	if (errType && message) return `${errType}: ${message}`;
	return String(message || errType || "session.error");
}

/** @param {unknown} e */
export const errMsg = (e) => e instanceof Error ? e.message : String(e);

/** @param {string|null} sessionId @returns {Promise<UsageSnapshot>} */
async function readShutdownUsage(sessionId) {
	/** @type {TokenUsage} */
	const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	if (!sessionId) return { found: false, nanoAiu: 0, tokens: empty };
	const path = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "session-state", sessionId, "events.jsonl");
	if (!existsSync(path)) return { found: false, nanoAiu: 0, tokens: empty };
	let shutdown = null;
	try {
		for await (const line of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
			const rec = tryParse(line);
			if (rec?.type === "session.shutdown" && rec.data?.totalNanoAiu != null) shutdown = rec;
		}
	} catch {
		return { found: false, nanoAiu: 0, tokens: empty };
	}
	if (!shutdown?.data) return { found: false, nanoAiu: 0, tokens: empty };
	/** @type {TokenUsage} */
	const tokens = { ...empty };
	for (const metric of /** @type {any[]} */ (Object.values(shutdown.data.modelMetrics || {}))) {
		const usage = metric?.usage;
		if (!usage) continue;
		for (const key of /** @type {(keyof TokenUsage)[]} */ (Object.keys(tokens))) tokens[key] += toInt(usage[key]);
	}
	return { found: true, nanoAiu: toInt(shutdown.data.totalNanoAiu), tokens };
}

/** @param {UsageSnapshot} after @param {UsageSnapshot} before */
function usageDelta(after, before) {
	if (!after.found || (before.found && after.nanoAiu < before.nanoAiu)) return null;
	/** @param {number} a @param {number} b */
	const sub = (a, b) => Math.max(0, a - b);
	return {
		nanoAiu: sub(after.nanoAiu, before.found ? before.nanoAiu : 0),
		tokens: Object.fromEntries(
			/** @type {(keyof TokenUsage)[]} */ (Object.keys(after.tokens))
				.map((key) => [key, sub(after.tokens[key], before.found ? before.tokens[key] : 0)]),
		),
	};
}

/** @param {string} line */
function tryParse(line) {
	try {
		return line.trim() ? JSON.parse(line) : null;
	} catch {
		return null;
	}
}

/** @param {unknown} value */
function toInt(value) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.trunc(number) : 0;
}

/**
 * @param {{
 *   backend?: "cli"|"sdk",
 *   cli: { kind: string, openRun: Function },
 *   sdk?: { kind: string, openRun: Function, shutdown?: Function }|null,
 * }} options
 */
export function createAgentBackend(options) {
	const { cli, sdk = null } = options;
	const override = options.backend ?? process.env.CONVEYOR_AGENT_BACKEND;
	const select = () => {
		if (override === CLI_BACKEND) return cli;
		if (override === SDK_STDIO_BACKEND) {
			if (!sdk) throw new Error("SDK agent backend was requested but the Copilot SDK is unavailable");
			return sdk;
		}
		return sdk ?? cli;
	};
	return {
		kindFor: () => select().kind,
		openRun: () => select().openRun(),
		emergencyAbort: abortAllAgentTurns,
		async shutdown() {
			abortAllAgentTurns();
			await sdk?.shutdown?.();
		},
	};
}

/** @param {unknown} value */
export function normalizeBackend(value) {
	return String(value ?? CLI_BACKEND);
}

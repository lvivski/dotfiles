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
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { appendBounded } from "./text-buffer.mjs";

const POSIX = process.platform !== "win32";
const MAX_STDERR_CHARS = 64_000;

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
 * @property {string[]|null} [availableTools] `--available-tools`
 * @property {string[]|null} [excludedTools]  `--excluded-tools`
 * @property {boolean} [enableMcp]        keep built-in MCP servers (omit `--disable-builtin-mcps`)
 * @property {boolean} [allowAllTools]    blanket pre-auth (`--allow-all-tools`); off for locked-down profiles
 * @property {boolean} [allowAllUrls]     blanket URL pre-auth (`--allow-all-urls`)
 * @property {string[]|null} [addDir]      trusted parent-approved directories (`--add-dir`)
 * @property {"off"|"on"|"auto"} [permissionMode] inherited parent permission mode
 * @property {boolean} [autopilot]         inherit parent autopilot interaction mode
 * @property {string|null} [resume]       session id to resume (follow-up turns)
 * @property {number|null} [timeout]      seconds; kills the process tree if exceeded
 * @property {string|null} [label]        human label for logs/progress
 * @property {string|null} [cacheCwd]     logical cwd identity used only for checkpoint keys
 */

/**
 * Structured outcome of a subagent run. Field names match the migration plan's agent-result shape.
 * @typedef {object} AgentResult
 * @property {"agent"} kind
 * @property {unknown} value
 * @property {string} content
 * @property {boolean} ok
 * @property {string|null} error
 * @property {string|null} sessionId
 * @property {string|null} model
 * @property {boolean} cached      true when served from a resumed run's checkpoint
 * @property {boolean} skipped     true when budget-skipped / aborted (not a failure)
 * @property {string|null} label
 * @property {number|null} nanoAiu
 * @property {number|null} aic     `nanoAiu / 1e9`, null when usage is unavailable
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
	if (spec.allowAllUrls) argv.push("--allow-all-urls");
	if (spec.autopilot) argv.push("--autopilot");
	if (!spec.enableMcp) argv.push("--disable-builtin-mcps");
	/** @type {[string, string|null|undefined][]} */
	const singles = [
		["--resume", spec.resume],
		["--model", spec.model],
		["--agent", spec.agentType],
		["--effort", spec.effort],
		["--context", spec.context],
		["-C", spec.cwd],
	];
	for (const [flag, value] of singles) if (value) argv.push(flag, value);
	/** @type {[string, string[]|null|undefined][]} */
	const repeats = [
		["--allow-tool", spec.allow],
		["--deny-tool", spec.deny],
		["--allow-url", spec.allowUrl],
		["--deny-url", spec.denyUrl],
		["--available-tools", spec.availableTools],
		["--excluded-tools", spec.excludedTools],
		["--add-dir", spec.addDir],
	];
	for (const [flag, values] of repeats) for (const v of values || []) argv.push(flag, v);
	return argv;
}

const CHILD_ENV_EXACT = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
	"LANG", "TERM", "NO_COLOR", "FORCE_COLOR",
	"COPILOT_HOME", "COPILOT_MODEL",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"GH_TOKEN", "GITHUB_TOKEN",
]);
const CHILD_ENV_PREFIXES = ["LC_", "COPILOT_PROVIDER_", "CWF_FAKE_"];

/** @param {string} name @param {Set<string>} extra */
function childEnvAllowed(name, extra) {
	return CHILD_ENV_EXACT.has(name) || extra.has(name) || CHILD_ENV_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Child env: increment `CWF_DEPTH` and disable workflow tools so a spawned subagent cannot
 * accidentally launch more workflows. Only provider/runtime variables required by the child are
 * forwarded; arbitrary parent secrets do not leak into every workflow agent.
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function childEnv(base = process.env) {
	const extra = new Set(String(base.CWF_CHILD_ENV_ALLOW || "").split(",").map((s) => s.trim()).filter(Boolean));
	/** @type {NodeJS.ProcessEnv} */
	const env = {};
	for (const [name, value] of Object.entries(base)) if (value !== undefined && childEnvAllowed(name, extra)) env[name] = value;
	env.CWF_DEPTH = String(toInt(base.CWF_DEPTH) + 1);
	env.CWF_DISABLE_WORKFLOW_TOOLS = "1";
	return env;
}

// --- live-subprocess registry: reap children on interrupt/timeout so none orphan (keep spending).
/** @type {Set<{ terminate: () => void }>} */
const LIVE = new Set();

/** @param {import("node:child_process").ChildProcess} child @param {boolean} group */
function killChild(child, group) {
	try {
		if (group && POSIX && child.pid) process.kill(-child.pid, "SIGKILL");
		else child.kill("SIGKILL");
	} catch {
		/* already exited / no such group */
	} finally {
		// Descendants can inherit these pipes and keep the async readers open after the direct child
		// exits. Closing our ends guarantees cancellation can settle even if a platform cannot reap
		// the full process tree.
		child.stdout?.destroy();
		child.stderr?.destroy();
	}
}

/** Kill every still-running subagent. Best-effort, idempotent (called on run abort). */
export function killAllAgents() {
	for (const entry of [...LIVE]) entry.terminate();
}

/**
 * Read the child session's `session.shutdown` record and extract AIC + token usage.
 * @param {string|null} sessionId
 * @returns {Promise<{ found: boolean, nanoAiu: number, tokens: { inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number } }>}
 */
async function readShutdownUsage(sessionId) {
	const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
	if (!sessionId) return { found: false, nanoAiu: 0, tokens: empty };
	const path = join(copilotHome(), "session-state", sessionId, "events.jsonl");
	if (!existsSync(path)) return { found: false, nanoAiu: 0, tokens: empty };
	/** @type {any} */
	let shutdown = null;
	try {
		for await (const line of readLines(path)) {
			const rec = tryParse(line);
			// The latest shutdown is the cumulative session total, including resumed turns.
			if (rec && rec.type === "session.shutdown" && rec.data?.totalNanoAiu != null) {
				shutdown = rec;
			}
		}
	} catch {
		return { found: false, nanoAiu: 0, tokens: empty };
	}
	const data = shutdown?.data;
	if (!data) return { found: false, nanoAiu: 0, tokens: empty };
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
	return { found: true, nanoAiu: toInt(data.totalNanoAiu), tokens };
}

/** @param {Awaited<ReturnType<typeof readShutdownUsage>>} after @param {Awaited<ReturnType<typeof readShutdownUsage>>} before */
function usageDelta(after, before) {
	if (!after.found || (before.found && after.nanoAiu < before.nanoAiu)) return null;
	const sub = (/** @type {number} */ a, /** @type {number} */ b) => Math.max(0, a - b);
	return {
		found: true,
		nanoAiu: sub(after.nanoAiu, before.found ? before.nanoAiu : 0),
		tokens: {
			inputTokens: sub(after.tokens.inputTokens, before.found ? before.tokens.inputTokens : 0),
			outputTokens: sub(after.tokens.outputTokens, before.found ? before.tokens.outputTokens : 0),
			cacheReadTokens: sub(after.tokens.cacheReadTokens, before.found ? before.tokens.cacheReadTokens : 0),
			cacheWriteTokens: sub(after.tokens.cacheWriteTokens, before.found ? before.tokens.cacheWriteTokens : 0),
			reasoningTokens: sub(after.tokens.reasoningTokens, before.found ? before.tokens.reasoningTokens : 0),
		},
	};
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
 * @param {{ bin?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<AgentResult>}
 */
/**
 * Mutable state both backends accumulate from their event stream.
 * @typedef {object} AgentAccumulator
 * @property {string|null} content
 * @property {number} outputTokens
 * @property {string|null} sessionId
 * @property {string|null} model
 * @property {string[]} sessionErrors
 */

/**
 * Raw outcome a backend reports; {@link result} turns it into an {@link AgentResult}.
 * @typedef {{ exitCode: number, stderr?: string, error?: string|null }} BackendOutcome
 */

/**
 * Shared lifecycle around a backend's execution: usage snapshots either side of the run, cwd
 * validation, the {@link LIVE} entry teardown uses to reap the agent, abort/timeout wiring, and
 * assembly of the final {@link AgentResult}.
 *
 * `execute` supplies the strategy: start the work, hand back a stopper via `onStop`, return the raw
 * exit shape. A termination that already happened short-circuits `execute`; one that lands during
 * startup is replayed into the stopper when it registers.
 *
 * @param {AgentSpec} spec
 * @param {{ signal?: AbortSignal }} opts
 * @param {(ctx: { acc: AgentAccumulator, onStop: (stop: () => void) => void, terminated: () => "timeout"|"aborted"|null }) => Promise<BackendOutcome>} execute
 * @returns {Promise<AgentResult>}
 */
async function runWithLifecycle(spec, opts, execute) {
	const started = Date.now();
	const model = spec.model ?? null;
	const usageBefore = await readShutdownUsage(spec.resume ?? null);

	if (spec.cwd && (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory())) {
		return result(spec, { started, model, error: `working directory not found: ${spec.cwd}`, exitCode: 1 });
	}

	/** @type {AgentAccumulator} */
	const acc = { content: null, outputTokens: 0, sessionId: spec.resume ?? null, model, sessionErrors: [] };
	/** @type {"timeout"|"aborted"|null} */
	let termination = null;
	/** @type {(() => void)|null} */
	let stop = null;

	/** @param {"timeout"|"aborted"} reason */
	const terminate = (reason) => {
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
		// A termination before startup has no child to reap, and spawning one here would leave nothing
		// to report its exit, so the run would never settle.
		if (termination) {
			outcome = { exitCode: 143 };
		} else {
			outcome = await execute({
				acc,
				onStop: (fn) => {
					stop = fn;
					if (termination) fn();
				},
				terminated: () => termination,
			});
		}
	} finally {
		if (timer) clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
		LIVE.delete(entry);
	}

	const usageAfter = await readShutdownUsage(acc.sessionId ?? spec.resume ?? null);
	const usage = usageDelta(usageAfter, usageBefore);
	return result(spec, {
		started,
		model: acc.model,
		content: acc.content,
		sessionId: acc.sessionId,
		// Fall back to the session log's token count only when the stream reported none.
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

/**
 * Run one subagent as a `copilot -p` child process, reducing its JSONL stdout into an
 * {@link AgentResult}. Default path: one exec, no session negotiation.
 * @param {AgentSpec} spec
 * @param {{ bin?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<AgentResult>}
 */
export async function runAgent(spec, opts = {}) {
	const bin = opts.bin || copilotBin();

	return runWithLifecycle(spec, opts, async ({ acc, onStop, terminated }) => {
		// Every POSIX agent gets its own process group: run-level aborts and extension teardown must
		// reap tool subprocesses too, not only the top-level `copilot` process.
		const group = POSIX;
		/** @type {import("node:child_process").ChildProcess} */
		let child;
		try {
			child = spawn(bin, buildArgv(spec, bin).slice(1), {
				cwd: spec.cwd || undefined,
				env: childEnv(),
				detached: group,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			return { exitCode: 127, error: `failed to spawn ${bin}: ${errMsg(e)}` };
		}

		const stdoutLines = child.stdout ? createInterface({ input: child.stdout, crlfDelay: Infinity }) : null;
		let stderr = "";

		// Attach exit listeners immediately so async spawn errors and early exits are observed. Use
		// `exit`, not `close`: descendants may inherit stdio and delay/withhold `close` indefinitely.
		let spawnError = /** @type {Error|null} */ (null);
		const exited = new Promise((resolve) => {
			child.once("error", (e) => {
				spawnError = e instanceof Error ? e : new Error(String(e));
				resolve(127);
			});
			child.once("exit", (code) => resolve(code ?? (terminated() ? 143 : 1)));
		});

		onStop(() => {
			stdoutLines?.close();
			killChild(child, group);
		});

		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk) => {
			stderr = appendBounded(stderr, chunk, MAX_STDERR_CHARS);
		});

		try {
			if (stdoutLines) {
				for await (const line of stdoutLines) reduce(acc, tryParse(line));
			}
		} catch {
			/* stdout read error — the exit code / kill state below reports it */
		}

		const exitCode = await exited;
		if (spawnError) return { exitCode: 127, error: `failed to spawn ${bin}: ${spawnError.message}` };
		return { exitCode, stderr };
	});
}

/**
 * Build the live agent executor used by the extension. Ordinary `on`/`off` permission modes keep
 * the low-overhead CLI path; `auto` uses the SDK so the child session can enable Copilot's native
 * auto-approval judge before its first turn.
 * @param {{ CopilotClient: new (options?: any) => any, RuntimeConnection: { forStdio: (options?: any) => any } }} sdk
 * @param {{ bin?: string, resolveAgent?: (name: string, enableMcp: boolean) => Promise<any>|any }} [defaults]
 */
export function createAgentRunner(sdk, defaults = {}) {
	if (typeof sdk?.CopilotClient !== "function" || typeof sdk?.RuntimeConnection?.forStdio !== "function") {
		throw new TypeError("createAgentRunner requires CopilotClient and RuntimeConnection");
	}
	return {
		kind: "cli",
		run(
			/** @type {AgentSpec} */ spec,
			/** @type {{ bin?: string, signal?: AbortSignal, resolveAgent?: (name: string, enableMcp: boolean) => Promise<any>|any }} */ opts = {},
		) {
			return spec.permissionMode === "auto" ? runAgentWithSdk(spec, { ...defaults, ...opts }, sdk) : runAgent(spec, opts);
		},
	};
}

/**
 * Apply profile denials before respecting an auto-approval recommendation.
 * @param {AgentSpec} spec
 * @param {any} request
 * @returns {{ kind: string, feedback?: string }}
 */
export function autoPermissionDecision(spec, request) {
	const permissionRequest = request?.permissionRequest ?? request;
	const promptRequest = request?.promptRequest ?? request;
	const denied = deniedPermission(spec, permissionRequest);
	if (denied) return { kind: "reject", feedback: denied };
	if (permissionRequest?.kind === "url" && (permissionRequest.requestSandboxBypass || promptRequest?.requestSandboxBypass)) {
		return { kind: "reject", feedback: "Workflow agents cannot auto-approve sandbox bypass requests." };
	}
	const recommendation = promptRequest?.autoApproval?.recommendation;
	if (recommendation === "approve") return { kind: "approve-once" };
	const reason = promptRequest?.autoApproval?.reason;
	return {
		kind: "reject",
		feedback: reason
			? `Copilot auto approval requires confirmation: ${reason}`
			: `Copilot auto approval returned ${recommendation || "no recommendation"}; interactive confirmation is unavailable in workflow agents.`,
	};
}

/**
 * SDK-backed execution for inherited `allow-all auto`. The SDK is injected by `extension.mjs` so
 * this module remains loadable under plain Node tests without resolving the Copilot SDK package.
 * @param {AgentSpec} spec
 * @param {{ bin?: string, signal?: AbortSignal, resolveAgent?: (name: string, enableMcp: boolean) => Promise<any>|any }} opts
 * @param {{ CopilotClient: new (options?: any) => any, RuntimeConnection: { forStdio: (options?: any) => any } }} sdk
 * @returns {Promise<AgentResult>}
 */
async function runAgentWithSdk(spec, opts, sdk) {
	const bin = opts.bin || copilotBin();

	return runWithLifecycle(spec, opts, async ({ acc, onStop, terminated }) => {
		/** @type {any} */
		let client = null;
		/** @type {any} */
		let session = null;
		let executionError = /** @type {string|null} */ (null);
		const permissionPrompts = new Map();

		// Registered before the client exists: the closure reads the live bindings, so a mid-startup
		// abort tears down whatever has been created by then.
		onStop(() => {
			Promise.resolve(session?.abort?.())
				.catch(() => {})
				.finally(() => Promise.resolve(client?.forceStop?.()).catch(() => {}));
		});

		try {
			const customAgent = spec.agentType && opts.resolveAgent ? await opts.resolveAgent(spec.agentType, !!spec.enableMcp) : null;
			if (terminated()) throw new Error(terminated() ?? "aborted");
			const connectionArgs = ["--no-auto-update", "--no-remote-export", "--no-color"];
			if (!spec.enableMcp) connectionArgs.push("--disable-builtin-mcps");
			const connection = sdk.RuntimeConnection.forStdio({
				path: bin,
				args: connectionArgs,
				env: /** @type {Record<string, string>} */ (childEnv()),
			});
			client = new sdk.CopilotClient({
				connection,
				workingDirectory: spec.cwd || process.cwd(),
				mode: "copilot-cli",
				logLevel: "error",
			});
			const excludedTools = [...new Set([...(spec.excludedTools || []), ...(!spec.enableMcp ? ["mcp:*"] : [])])];
			const config = {
				clientName: "workflow-extension",
				model: spec.model || undefined,
				reasoningEffort: spec.effort || undefined,
				contextTier: spec.context || undefined,
				availableTools: spec.availableTools || undefined,
				excludedTools: excludedTools.length ? excludedTools : undefined,
				enableConfigDiscovery: !!spec.enableMcp,
				customAgents: customAgent ? [customAgent] : undefined,
				onPermissionRequest: async (/** @type {any} */ request) => {
					await Promise.resolve();
					const toolCallId = request?.toolCallId;
					const promptRequest = toolCallId ? permissionPrompts.get(toolCallId) : null;
					if (toolCallId) permissionPrompts.delete(toolCallId);
					return autoPermissionDecision(spec, { permissionRequest: request, promptRequest });
				},
			};
			session = spec.resume ? await client.resumeSession(spec.resume, config) : await client.createSession(config);
			acc.sessionId = session.sessionId || acc.sessionId;
			session.on((/** @type {any} */ event) => {
				if (event?.type === "permission.requested") {
					const toolCallId = event.data?.permissionRequest?.toolCallId;
					if (toolCallId && event.data?.promptRequest) permissionPrompts.set(toolCallId, event.data.promptRequest);
				}
				reduce(acc, event);
			});
			for (const directory of spec.addDir || []) {
				// A parent-approved directory can vanish (or be replaced by a file) after the session
				// started. Granting it is best-effort: losing one extra root must not fail the agent.
				if (directory === spec.cwd) continue;
				try {
					if (!isDirectory(directory)) continue;
					await session.rpc.permissions.paths.add({ path: directory });
				} catch (error) {
					if (isDirectory(directory)) throw error;
				}
			}
			if (spec.agentType) await session.rpc.agent.select({ name: spec.agentType });
			if (spec.autopilot) await session.rpc.mode.set({ mode: "autopilot" });
			const permission = await session.rpc.permissions.setAllowAll({ mode: "auto", source: "rpc" });
			if (permission?.mode !== "auto") throw new Error("child session refused inherited allow-all auto mode");
			const deniedRules = permissionRules(spec);
			if (deniedRules.length) {
				const configured = await session.rpc.permissions.configure({ rules: { approved: [], denied: deniedRules } });
				if (configured?.success === false) throw new Error("child session refused workflow profile permission denials");
			}
			if (terminated()) throw new Error(terminated() ?? "aborted");
			const response = await session.sendAndWait({ prompt: spec.prompt }, 24 * 60 * 60 * 1000);
			reduce(acc, response);
		} catch (e) {
			executionError = errMsg(e);
		} finally {
			if (client && !terminated()) {
				try {
					const errors = await client.stop();
					for (const error of errors || []) acc.sessionErrors.push(`SDK shutdown: ${errMsg(error)}`);
				} catch (e) {
					acc.sessionErrors.push(`SDK shutdown: ${errMsg(e)}`);
				}
			}
		}

		return { exitCode: executionError && !terminated() ? 1 : 0, stderr: executionError ?? "" };
	});
}

/** Leading `---` YAML frontmatter block; the parent session already parsed it into `info`. */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[^\n]*(\r?\n|$)/;

/**
 * Convert one parent-session file agent into an SDK child-session config without enabling config
 * discovery. Parent metadata supplies parsed frontmatter; only the prompt body is read from disk.
 * @param {any} info
 * @param {{ enableMcp?: boolean }} [opts]
 */
export function loadCustomAgentConfig(info, opts = {}) {
	if (!info || typeof info.name !== "string" || typeof info.path !== "string" || !existsSync(info.path)) return null;
	const prompt = readFileSync(info.path, "utf8").replace(FRONTMATTER, "").trim();
	if (!prompt) throw new Error(`custom agent '${info.name}' has an empty prompt`);
	return {
		name: info.name,
		displayName: info.displayName,
		description: info.description,
		tools: info.tools,
		prompt,
		...(info.skills ? { skills: info.skills } : {}),
		...(info.model ? { model: info.model } : {}),
		...(opts.enableMcp && info.mcpServers ? { mcpServers: info.mcpServers } : {}),
	};
}

/** @param {string} path @returns {boolean} true only if `path` is currently a directory. */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** @param {AgentSpec} spec */
function permissionRules(spec) {
	return [
		...(spec.deny || []).map((pattern) => parsePermissionRule(pattern)),
		...(spec.denyUrl || []).map((pattern) => ({ kind: "url", argument: String(pattern) })),
	].filter(Boolean);
}

/** @param {unknown} pattern @returns {{ kind: string, argument: string|null }|null} */
function parsePermissionRule(pattern) {
	const text = String(pattern || "").trim();
	if (!text) return null;
	const match = /^([^()]+?)(?:\((.*)\))?$/.exec(text);
	if (!match) return { kind: text.toLowerCase(), argument: null };
	return {
		kind: match[1].trim().toLowerCase(),
		argument: match[2] == null || match[2] === "" ? null : match[2],
	};
}

/** @param {AgentSpec} spec @param {any} request @returns {string|null} */
function deniedPermission(spec, request) {
	if (request?.kind === "url" && (spec.denyUrl || []).some((pattern) => urlMatches(pattern, request.url))) {
		return `URL '${request.url}' is denied by the workflow agent profile.`;
	}
	for (const pattern of spec.deny || []) {
		const kind = String(pattern).split("(", 1)[0].trim().toLowerCase();
		if (
			(kind === "shell" && (request?.kind === "commands" || (request?.kind === "path" && request.accessKind === "shell"))) ||
			(kind === "write" && (request?.kind === "write" || (request?.kind === "path" && request.accessKind === "write"))) ||
			(kind === "read" && (request?.kind === "read" || (request?.kind === "path" && request.accessKind === "read"))) ||
			kind === String(request?.kind || "").toLowerCase() ||
			(request?.kind === "mcp" && kind === String(request.serverName || "").toLowerCase()) ||
			(request?.kind === "custom-tool" && kind === String(request.toolName || "").toLowerCase())
		) {
			return `Permission '${pattern}' is denied by the workflow agent profile.`;
		}
	}
	return null;
}

/** @param {unknown} pattern @param {unknown} requested */
function urlMatches(pattern, requested) {
	const rule = String(pattern || "").trim().toLowerCase();
	const value = String(requested || "").trim().toLowerCase();
	if (!rule || !value) return false;
	if (rule === "*") return true;
	if (rule.includes("://")) return value === rule || value.startsWith(`${rule.replace(/\/+$/, "")}/`);
	try {
		const host = new URL(value).hostname.toLowerCase();
		return host === rule || host.endsWith(`.${rule}`);
	} catch {
		return value.includes(rule);
	}
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
 * @param {{ started: number, model: string|null, content?: string|null, sessionId?: string|null, outputTokens?: number, usage?: { nanoAiu: number, tokens: any }|null, exitCode: number, timedOut?: boolean, aborted?: boolean, stderr?: string, sessionErrors?: string[], error?: string|null }} p
 * @returns {AgentResult}
 */
function result(spec, p) {
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

/**
 * Format a `session.error` record from the available type/message fields.
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

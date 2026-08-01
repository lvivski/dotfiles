/**
 * @module sdk
 *
 * SDK-backed workflow agents. One run backend lazily owns one Copilot client per cwd/MCP
 * combination; every turn is still an isolated session and is shut down after completion so usage
 * is persisted without stopping the shared stdio server.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";

import {
	agentResult,
	childEnv,
	errMsg,
	reduceAgentEvent,
	reduceAgentResponse,
	resolveCopilotBin,
	runWithLifecycle,
	SDK_STDIO_BACKEND,
} from "./agent.mjs";
import { deleteSessions, keepSessions } from "./sessions.mjs";

/** @typedef {import("./agent.mjs").AgentSpec} AgentSpec */
/** @typedef {{ CopilotClient: new (options?: any) => any, RuntimeConnection: { forStdio: (options?: any) => any } }} Sdk */
/** @typedef {{ sdkBin?: string, cwd?: string, resolveAgent?: (name: string, enableMcp: boolean) => Promise<any>|any }} SdkDefaults */

/** @type {Set<any>} */
const LIVE = new Set();

/** @param {Sdk} sdk @param {SdkDefaults} [defaults] */
export function createSdkBackend(sdk, defaults = {}) {
	assertSdk(sdk);
	return {
		kind: SDK_STDIO_BACKEND,
		openRun: () => createSdkRunBackend(sdk, defaults),
		shutdown: shutdownSdkAgents,
	};
}

/** Create one lazy persistent SDK backend owned by a workflow run. */
/** @param {Sdk} sdk @param {SdkDefaults} [defaults] @returns {any} */
export function createSdkRunBackend(sdk, defaults = {}) {
	assertSdk(sdk);
	/** @type {Map<string, Promise<any>>} */
	const clients = new Map();
	/** @type {Set<{ promise: Promise<any>, abort: () => void }>} */
	const turns = new Set();
	/** @type {Map<string, Promise<any>>} */
	const agents = new Map();
	let accepting = true;
	let closePromise = null;

	const backend = {
		kind: SDK_STDIO_BACKEND,
		async run(/** @type {AgentSpec} */ input, /** @type {{ signal?: AbortSignal }} */ opts = {}) {
			const spec = input;
			if (!accepting) return agentResult(spec, failedStart(spec, "workflow SDK backend is closed"));
			/** @type {(() => void)|null} */
			let abort = null;
			let abortRequested = false;
			const turn = {
				promise: runSession(spec, opts, () => clientFor(spec), resolveAgent, (stop) => {
					abort = stop;
					if (abortRequested) stop();
				}),
				abort: () => {
					if (abort) abort();
					else abortRequested = true;
				},
			};
			turns.add(turn);
			try {
				return await turn.promise;
			} finally {
				turns.delete(turn);
			}
		},
		abort() {
			for (const turn of turns) turn.abort();
		},
		close() {
			return closePromise ??= closeBackend();
		},
	};
	LIVE.add(backend);
	return backend;

	async function closeBackend() {
		accepting = false;
		try {
			backend.abort();
			let drained = await settleWithin(Promise.allSettled([...turns].map((turn) => turn.promise)), 2000);
			const settled = await Promise.allSettled(clients.values());
			await Promise.allSettled(settled.flatMap((item) => {
				if (item.status !== "fulfilled") return [];
				return [drained ? stopClient(item.value) : Promise.resolve(item.value.forceStop?.()).catch(() => {})];
			}));
			if (!drained) drained = await settleWithin(Promise.allSettled([...turns].map((turn) => turn.promise)), 2000);
			if (!drained) throw new Error("SDK backend closed with unsettled agent turns");
			clients.clear();
			agents.clear();
		} finally {
			LIVE.delete(backend);
		}
	}

	/** @param {AgentSpec} spec */
	function clientFor(spec) {
		const cwd = canonical(spec.cwd || process.cwd());
		const key = `${cwd}\u0000${spec.enableMcp ? "mcp" : "plain"}`;
		let pending = clients.get(key);
		if (!pending) {
			pending = Promise.resolve().then(() => {
				const args = ["--no-auto-update", "--no-remote-export", "--no-color"];
				if (!spec.enableMcp) args.push("--disable-builtin-mcps");
				return new sdk.CopilotClient({
					connection: sdk.RuntimeConnection.forStdio({
						path: resolveCopilotBin(defaults.sdkBin),
						args,
						env: childEnv(),
					}),
					workingDirectory: cwd,
					mode: "copilot-cli",
					logLevel: "error",
				});
			}).catch((error) => {
				clients.delete(key);
				throw error;
			});
			clients.set(key, pending);
		}
		return pending;
	}

	/** @param {string} name @param {boolean} enableMcp */
	function resolveAgent(name, enableMcp) {
		if (!defaults.resolveAgent) return Promise.resolve(null);
		const key = `${name}\u0000${enableMcp ? "mcp" : "plain"}`;
		let pending = agents.get(key);
		if (!pending) {
			pending = Promise.resolve(defaults.resolveAgent(name, enableMcp)).catch((error) => {
				agents.delete(key);
				throw error;
			});
			agents.set(key, pending);
		}
		return pending;
	}
}

/** Abort and close all persistent SDK backends owned by this extension process. */
export async function shutdownSdkAgents() {
	for (const backend of LIVE) backend.abort();
	await Promise.allSettled([...LIVE].map((backend) => backend.close()));
}

/** Apply a compiled deny-wins permission policy. */
/** @param {AgentSpec} spec @param {any} request */
export function permissionDecision(spec, request) {
	return createPermissionPolicy(spec).decide(request?.permissionRequest ?? request);
}

/** Convert parent-session custom-agent metadata into SDK session configuration. */
/** @param {any} info @param {{ enableMcp?: boolean }} [opts] */
export function loadCustomAgentConfig(info, opts = {}) {
	if (!info || typeof info.name !== "string" || typeof info.path !== "string" || !existsSync(info.path)) return null;
	const prompt = readFileSync(info.path, "utf8").replace(/^---\r?\n[\s\S]*?\r?\n---[^\n]*(\r?\n|$)/, "").trim();
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

/**
 * @param {AgentSpec} spec
 * @param {{ signal?: AbortSignal }} opts
 * @param {() => Promise<any>} getClient
 * @param {(name: string, enableMcp: boolean) => Promise<any>} resolveAgent
 * @param {(abort: () => void) => void} setAbort
 */
async function runSession(spec, opts, getClient, resolveAgent, setAbort) {
	return runWithLifecycle(spec, opts, async ({ acc, onStop, terminated, complete }) => {
		/** @type {any} */
		let session = null;
		/** @type {string|null} */
		let error = null;
		/** @type {(error: Error) => void} */
		let cancel = () => {};
		const cancelled = new Promise((_, reject) => {
			cancel = reject;
		});
		let stopped = false;
		const stop = () => {
			if (stopped) return;
			stopped = true;
			Promise.resolve(session?.abort?.()).catch(() => {});
			cancel(new Error(terminated() || "aborted"));
		};
		onStop(stop);
		setAbort(stop);
		const cancellable = (/** @type {Promise<unknown>|unknown} */ operation) =>
			Promise.race([Promise.resolve(operation), cancelled]);
		try {
			const policy = createPermissionPolicy(spec);
			const customAgent = spec.agentType
				? await cancellable(resolveAgent(spec.agentType, !!spec.enableMcp))
				: null;
			throwIfTerminated(terminated);
			const client = await cancellable(getClient());
			throwIfTerminated(terminated);
			const creating = Promise.resolve(spec.resume
				? client.resumeSession(spec.resume, sessionConfig(spec, customAgent, policy))
				: client.createSession(sessionConfig(spec, customAgent, policy)));
			creating.then((lateSession) => {
				if (stopped && lateSession !== session) cleanupLateSession(lateSession, terminated() || "aborted").catch(() => {});
			}).catch(() => {});
			session = await cancellable(creating);
			acc.sessionId = session.sessionId || acc.sessionId;
			session.on((/** @type {any} */ event) => {
				reduceAgentEvent(acc, event);
			});
			await configureSession(session, spec, policy, cancellable);
			throwIfTerminated(terminated);
			const response = await cancellable(session.sendAndWait({ prompt: spec.prompt }, 24 * 60 * 60 * 1000));
			reduceAgentResponse(acc, response);
			complete();
		} catch (caught) {
			error = errMsg(caught);
		} finally {
			if (session) {
				await settleWithin(finalizeSession(session, error, acc.sessionErrors), 1500);
			}
		}
		return { exitCode: error && !terminated() ? 1 : 0, stderr: error || "" };
	});
}

/** @param {any} session @param {string|null} reason */
async function cleanupLateSession(session, reason) {
	await settleWithin(finalizeSession(session, reason, []), 1500);
	if (!keepSessions() && session?.sessionId) await deleteSessions([session.sessionId]);
}

/** @param {AgentSpec} spec @param {any} customAgent @param {ReturnType<typeof createPermissionPolicy>} policy */
function sessionConfig(spec, customAgent, policy) {
	const excluded = [...new Set([...(spec.excludedTools || []), ...(!spec.enableMcp ? ["mcp:*"] : [])])];
	return {
		clientName: "workflow-extension",
		model: spec.model || undefined,
		reasoningEffort: spec.effort || undefined,
		contextTier: spec.context || undefined,
		availableTools: spec.availableTools || undefined,
		excludedTools: excluded.length ? excluded : undefined,
		enableConfigDiscovery: !!spec.enableMcp,
		customAgents: customAgent ? [customAgent] : undefined,
		onPermissionRequest: async (/** @type {any} */ request) => policy.decide(request),
	};
}

/** @param {any} session @param {AgentSpec} spec @param {ReturnType<typeof createPermissionPolicy>} policy @param {(operation: Promise<unknown>|unknown) => Promise<unknown>} cancellable */
async function configureSession(session, spec, policy, cancellable) {
	for (const directory of spec.addDir || []) {
		if (directory === spec.cwd || !isDirectory(directory)) continue;
		try {
			await cancellable(session.rpc.permissions.paths.add({ path: directory }));
		} catch (error) {
			if (isDirectory(directory)) throw error;
		}
	}
	if (spec.agentType) await cancellable(session.rpc.agent.select({ name: spec.agentType }));
	if (spec.autopilot) await cancellable(session.rpc.mode.set({ mode: "autopilot" }));
	// SDK allow-all covers tools, paths, and URLs together. Keep it off and express the workflow's
	// independent tool/URL policy through granular rules and the request callback.
	const mode = "off";
	const permission = /** @type {any} */ (await cancellable(session.rpc.permissions.setAllowAll({ mode, source: "rpc" })));
	if (permission?.mode && permission.mode !== mode) throw new Error(`child session refused inherited allow-all ${mode} mode`);
	const rules = policy.rules;
	if (rules.approved.length || rules.denied.length) {
		const configured = /** @type {any} */ (await cancellable(session.rpc.permissions.configure({ rules })));
		if (configured?.success === false) throw new Error("child session refused workflow profile permission rules");
	}
}

/** @param {any} session @param {string|null} error @param {string[]} warnings */
async function finalizeSession(session, error, warnings) {
	try {
		await session.rpc?.shutdown?.({ type: error ? "error" : "normal", ...(error ? { reason: error } : {}) });
	} catch (caught) {
		warnings.push(`SDK session shutdown: ${errMsg(caught)}`);
	}
	try {
		await session.disconnect?.();
	} catch (caught) {
		warnings.push(`SDK session disconnect: ${errMsg(caught)}`);
	}
}

/** @param {any} client */
async function stopClient(client) {
	/** @type {NodeJS.Timeout|undefined} */
	let timer;
	try {
		await Promise.race([
			Promise.resolve(client.stop()),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("SDK client shutdown timed out")), 2000);
				timer.unref?.();
			}),
		]);
	} catch {
		await Promise.resolve(client.forceStop?.()).catch(() => {});
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** @param {Promise<unknown>} promise @param {number} timeoutMs */
async function settleWithin(promise, timeoutMs) {
	let timer;
	try {
		return await Promise.race([
			promise.then(() => true),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** @param {AgentSpec} spec */
function createPermissionPolicy(spec) {
	const approved = [
		...(spec.allow || []).map(parsePermissionRule).filter(isPermissionRule),
		...(spec.allowUrl || []).map((/** @type {unknown} */ pattern) => ({ kind: "url", argument: String(pattern) })),
		...(spec.allowAllUrls ? [{ kind: "url", argument: "*" }] : []),
	];
	const denied = [
		...(spec.deny || []).map(parsePermissionRule).filter(isPermissionRule),
		...(spec.denyUrl || []).map((/** @type {unknown} */ pattern) => ({ kind: "url", argument: String(pattern) })),
	];
	return {
		rules: { approved, denied },
		decide(/** @type {any} */ request) {
			const deniedRule = denied.find((rule) => permissionRuleMatches(rule, request));
			if (deniedRule) return { kind: "reject", feedback: `Permission '${formatPermissionRule(deniedRule)}' is denied by the workflow agent profile.` };
			if (request?.kind === "url" && request.requestSandboxBypass) {
				return { kind: "reject", feedback: "Workflow agents cannot auto-approve sandbox bypass requests." };
			}
			const allowed = request?.kind === "url"
				? approved.some((rule) => permissionRuleMatches(rule, request))
				: spec.allowAllTools !== false || approved.some((rule) => permissionRuleMatches(rule, request));
			return allowed
				? { kind: "approve-once" }
				: { kind: "reject", feedback: "Permission is not approved by the workflow agent profile." };
		},
	};
}

/** @param {unknown} pattern */
function parsePermissionRule(pattern) {
	const match = /^([^()]+?)(?:\((.*)\))?$/.exec(String(pattern).trim());
	return match ? { kind: match[1].trim().toLowerCase(), argument: match[2] || null } : null;
}

/** @param {{ kind: string, argument: string|null }|null} rule @returns {rule is { kind: string, argument: string|null }} */
function isPermissionRule(rule) {
	return rule !== null;
}

/** @param {{ kind: string, argument: string|null }} rule @param {any} request */
function permissionRuleMatches(rule, request) {
	const requested = String(request?.kind || "").toLowerCase();
	if (rule.kind === "url" && requested === "url") return urlMatches(rule.argument, request?.url);
	const kindMatches =
		rule.kind === requested ||
		(rule.kind === "shell" && (requested === "commands" || request?.accessKind === "shell")) ||
		(rule.kind === "write" && (requested === "write" || request?.accessKind === "write")) ||
		(rule.kind === "read" && (requested === "read" || request?.accessKind === "read")) ||
		(requested === "mcp" && rule.kind === String(request.serverName || "").toLowerCase()) ||
		(requested === "custom-tool" && rule.kind === String(request.toolName || "").toLowerCase());
	if (!kindMatches) return false;
	if (rule.argument == null || rule.argument === "*") return true;
	const argument = request?.url ?? request?.fileName ?? request?.path ?? request?.command ?? request?.commands ?? request?.argument;
	return Array.isArray(argument)
		? argument.some((value) => wildcardMatches(rule.argument, value))
		: wildcardMatches(rule.argument, argument);
}

/** @param {{ kind: string, argument: string|null }} rule */
function formatPermissionRule(rule) {
	return rule.argument == null ? rule.kind : `${rule.kind}(${rule.argument})`;
}

/** @param {unknown} pattern @param {unknown} value */
function wildcardMatches(pattern, value) {
	const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "i").test(String(value ?? ""));
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

/** @param {string} path */
function canonical(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** @param {string} path */
function isDirectory(path) {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** @param {AgentSpec} spec @param {string} error */
function failedStart(spec, error) {
	return { started: Date.now(), model: spec.model ?? null, exitCode: 127, error };
}

/** @param {Sdk} sdk */
function assertSdk(sdk) {
	if (typeof sdk?.CopilotClient !== "function" || typeof sdk?.RuntimeConnection?.forStdio !== "function") {
		throw new TypeError("SDK backend requires CopilotClient and RuntimeConnection");
	}
}

/** @param {() => string|null} terminated */
function throwIfTerminated(terminated) {
	const reason = terminated();
	if (reason) throw new Error(reason);
}

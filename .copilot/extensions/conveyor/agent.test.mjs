/** @module agent.test — subagent driver: spawn, JSONL reduce, AIC/token accounting, argv, env. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	abortAllAgentTurns,
	childEnv,
	CLI_BACKEND,
	createAgentBackend,
	formatSessionError,
	resolveCopilotBin,
	SDK_STDIO_BACKEND,
} from "./agent.mjs";
import { buildArgv, createCliBackend, runAgent } from "./cli.mjs";
import { createSdkBackend, createSdkRunBackend, loadCustomAgentConfig, permissionDecision } from "./sdk.mjs";
import { withFakeEnv, tmpDir, waitFor, within } from "./fixtures/support.mjs";

/** @param {any} [options] */
function createTestAgentBackend(options = {}) {
	return createAgentBackend({
		backend: options.backend,
		cli: createCliBackend({ cliBin: options.cliBin }),
		sdk: options.sdk
			? createSdkBackend(options.sdk, { sdkBin: options.sdkBin, resolveAgent: options.resolveAgent })
			: null,
	});
}

/** @param {number} pid */
function processIsAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
	}
}

test("formatSessionError falls back through type/error/reason", () => {
	assert.equal(formatSessionError({ errorType: "RateLimit", message: "slow" }), "RateLimit: slow");
	assert.equal(formatSessionError({ type: "X", reason: "R" }), "X: R");
	assert.equal(formatSessionError({ error: "boom" }), "boom");
	assert.equal(formatSessionError({ type: "OnlyType" }), "OnlyType");
	assert.equal(formatSessionError({}), "session.error");
});

test("AIC reads the latest cumulative session.shutdown", () =>
	withFakeEnv({ CONVEYOR_FAKE_NANO_AIU: "500000000", CONVEYOR_FAKE_NANO_AIU_2: "999000000" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.nanoAiu, 999_000_000);
		assert.equal(r.aic, 0.999);
	}));

test("a sub-second timeout is honored, not clamped up to 1s", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "hang" }, async () => {
		const start = Date.now();
		const r = await runAgent({ prompt: "hi", timeout: 0.3 });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /timed out after 0\.3s/);
		assert.ok(Date.now() - start < 2000, "fired near 300ms, not a 1s+ clamp");
	}));

test("ok run returns content, AIC, and token details from session.shutdown", () =>
	withFakeEnv({}, async () => {
		const r = await runAgent({ prompt: "hi", label: "a", model: "m1" });
		assert.equal(r.ok, true);
		assert.equal(r.content, "ECHO: hi");
		assert.equal(r.nanoAiu, 500_000_000);
		assert.equal(r.aic, 0.5);
		assert.equal(r.inputTokens, 100);
		assert.equal(r.outputTokens, 42);
		assert.equal(r.cacheReadTokens, 10);
		assert.equal(r.cacheWriteTokens, 5);
		assert.equal(r.reasoningTokens, 7);
		assert.equal(r.usageUnknown, false);
		assert.equal(r.label, "a");
		assert.ok(r.sessionId);
		assert.ok(r.durationMs >= 0);
	}));

test("nonzero exit -> ok:false with stderr message", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "fail" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, 1);
		assert.match(r.error ?? "", /simulated failure/);
		assert.equal(r.aic, null);
		assert.equal(r.usageUnknown, true);
		assert.match(r.warnings?.join("; ") ?? "", /usage unavailable/);
	}));

test("resumed turns charge only their cumulative usage delta", () =>
	withFakeEnv({ CONVEYOR_FAKE_NANO_AIU: "500000000" }, async () => {
		const first = await runAgent({ prompt: "first" });
		assert.equal(first.aic, 0.5);
		process.env.CONVEYOR_FAKE_NANO_AIU = "250000000";
		const second = await runAgent({ prompt: "second", resume: first.sessionId });
		assert.equal(second.sessionId, first.sessionId);
		assert.equal(second.nanoAiu, 250_000_000);
		assert.equal(second.aic, 0.25);
		assert.equal(second.inputTokens, 100);
		assert.equal(second.outputTokens, 42);
	}));

test("successful output with missing usage is explicit, never zero-shaped", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "nousage" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, true);
		assert.equal(r.aic, null);
		assert.equal(r.nanoAiu, null);
		assert.equal(r.usageUnknown, true);
		assert.match(r.warnings?.join("; ") ?? "", /usage unavailable/);
	}));

test("stderr is bounded by a tail buffer", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "fail", CONVEYOR_FAKE_STDERR: "a".repeat(80_000) }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.ok((r.error ?? "").length < 70_000);
	}));

test("no assistant message -> ok:false", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "nojson" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /no assistant message/);
	}));

test("malformed JSONL lines are ignored, good events still parsed", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "malformed", CONVEYOR_FAKE_CONTENT: "kept" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, true);
		assert.equal(r.content, "kept");
	}));

test("session.error with empty content surfaces as error", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "sessionerror", CONVEYOR_FAKE_CONTENT: "" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /RateLimit: slow down/);
	}));

test("timeout kills the subprocess and reports a timeout error", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "hang" }, async () => {
		const r = await runAgent({ prompt: "hi", timeout: 1 });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /timed out after 1s/);
	}));

test("missing cwd -> failure without spawning", () =>
	withFakeEnv({}, async () => {
		const r = await runAgent({ prompt: "hi", cwd: "/no/such/dir/conveyor" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /working directory not found/);
	}));

test("a missing copilot binary -> ok:false (exit 127), never an unhandled crash", () =>
	withFakeEnv({ CONVEYOR_COPILOT_BIN: "/no/such/copilot-binary-xyz" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, 127);
		assert.match(r.error ?? "", /failed to spawn/);
	}));

test("buildArgv: deny wins layout + core flags", () => {
	const argv = buildArgv({ prompt: "P", model: "m", deny: ["shell"], denyUrl: ["*"], enableMcp: false }, "copilot");
	assert.deepEqual(argv.slice(0, 7), ["copilot", "-p", "P", "--output-format", "json", "--no-ask-user", "--no-color"]);
	assert.ok(argv.includes("--no-auto-update"), "headless subagents must not self-update mid-fan-out");
	assert.ok(argv.includes("--no-remote-export"), "headless subagents must not mirror to GitHub web/mobile");
	assert.ok(argv.includes("--allow-all-tools"));
	assert.ok(argv.includes("--disable-builtin-mcps"));
	assert.ok(["--deny-tool", "shell"].every((x) => argv.includes(x)));
	assert.ok(["--deny-url", "*"].every((x) => argv.includes(x)));
});

test("buildArgv: enableMcp omits --disable-builtin-mcps; allowAllTools:false drops --allow-all-tools", () => {
	const withMcp = buildArgv({ prompt: "P", enableMcp: true }, "copilot");
	assert.ok(!withMcp.includes("--disable-builtin-mcps"));
	const locked = buildArgv({ prompt: "P", allowAllTools: false }, "copilot");
	assert.ok(!locked.includes("--allow-all-tools"));
});

test("buildArgv inherits allow-all URL, autopilot, and parent-approved directory flags", () => {
	const argv = buildArgv({ prompt: "P", allowAllUrls: true, autopilot: true, addDir: ["/one", "/two"] }, "copilot");
	assert.ok(argv.includes("--allow-all-urls"));
	assert.ok(argv.includes("--autopilot"));
	assert.deepEqual(argv.filter((value) => value === "--add-dir").length, 2);
	assert.ok(argv.includes("/one") && argv.includes("/two"));
});

test("buildArgv assigns the child session id up front, but never alongside --resume", () => {
	const fresh = buildArgv({ prompt: "P" }, "copilot", "abc-123");
	assert.deepEqual(fresh.slice(fresh.indexOf("--session-id"), fresh.indexOf("--session-id") + 2), ["--session-id", "abc-123"]);
	const resumed = buildArgv({ prompt: "P", resume: "old-1" }, "copilot", "abc-123");
	assert.ok(!resumed.includes("--session-id"), "a resumed agent keeps the session it continues");
	assert.ok(["--resume", "old-1"].every((x) => resumed.includes(x)));
	assert.ok(!buildArgv({ prompt: "P" }, "copilot").includes("--session-id"));
});

test("a killed agent still reports the session id the run assigned it", async () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "hang" }, async () => {
		const res = await runAgent({ prompt: "P", timeout: 0.05 });
		assert.equal(res.ok, false);
		assert.match(String(res.sessionId), /^[0-9a-f-]{36}$/, "cleanup can still find the session of an agent that never answered");
	}));

test("childEnv: increments CONVEYOR_DEPTH and disables nested conveyor tools", () => {
	const e1 = childEnv({});
	assert.equal(e1.CONVEYOR_DEPTH, "1");
	assert.equal(e1.CONVEYOR_DISABLE_TOOLS, "1");
	assert.equal(childEnv({ CONVEYOR_DEPTH: "2" }).CONVEYOR_DEPTH, "3");
});

test("buildArgv: every argv element is a string", () => {
	const argv = buildArgv({ prompt: "P", model: "m", timeout: 5, allow: ["read"] }, "copilot");
	assert.ok(argv.every((x) => typeof x === "string"), "no non-string argv elements");
});

test("buildArgv cannot append raw flags or arbitrary MCP configuration", () => {
	const argv = buildArgv(
		/** @type {any} */ ({
			prompt: "P",
			extraArgs: ["--allow-all", "--add-dir", "/"],
			mcp: '{"servers":{"evil":{"command":"sh"}}}',
		}),
		"copilot",
	);
	assert.equal(argv.includes("--allow-all"), false);
	assert.equal(argv.includes("--additional-mcp-config"), false);
});

test("SDK permission decisions apply independent tool and URL allowlists with deny precedence", () => {
	const spec = /** @type {any} */ ({ permissionMode: "auto", allowAllTools: true, deny: ["shell", "write"], denyUrl: ["blocked.example"] });
	assert.equal(permissionDecision(spec, { kind: "commands", autoApproval: { recommendation: "approve" } }).kind, "reject");
	assert.equal(permissionDecision(spec, { kind: "url", url: "https://blocked.example/x", autoApproval: { recommendation: "approve" } }).kind, "reject");
	assert.equal(permissionDecision(spec, { kind: "url", url: "https://safe.example", requestSandboxBypass: true, autoApproval: { recommendation: "approve" } }).kind, "reject");
	assert.equal(permissionDecision(spec, { kind: "read", autoApproval: { recommendation: "approve" } }).kind, "approve-once");
	assert.equal(permissionDecision(spec, { kind: "read", autoApproval: { recommendation: "requireApproval", reason: "sensitive" } }).kind, "approve-once");
	assert.equal(permissionDecision(spec, {
		permissionRequest: { kind: "read", toolCallId: "read-1" },
		promptRequest: { kind: "read", toolCallId: "read-1", autoApproval: { recommendation: "approve" } },
	}).kind, "approve-once");
	assert.equal(permissionDecision({ ...spec, allowAllTools: false }, { kind: "read", autoApproval: { recommendation: "approve" } }).kind, "reject");
	const granular = /** @type {any} */ ({
		allowAllTools: false,
		allowAllUrls: false,
		allow: ["read", "shell(git status)"],
		allowUrl: ["safe.example"],
		deny: ["shell(rm *)"],
		denyUrl: ["blocked.safe.example"],
	});
	assert.equal(permissionDecision(granular, { kind: "read" }).kind, "approve-once");
	assert.equal(permissionDecision(granular, { kind: "commands", commands: ["git status"] }).kind, "approve-once");
	assert.equal(permissionDecision(granular, { kind: "commands", commands: ["rm -rf tmp"] }).kind, "reject");
	assert.equal(permissionDecision(granular, { kind: "url", url: "https://safe.example/docs" }).kind, "approve-once");
	assert.equal(permissionDecision(granular, { kind: "url", url: "https://blocked.safe.example" }).kind, "reject");
	assert.equal(permissionDecision({ ...granular, allowAllUrls: true }, { kind: "url", url: "https://other.example" }).kind, "approve-once");
});

test("agent abstraction routes inherited auto mode through SDK", async () => {
	/** @type {any[][]} */
	const calls = [];
	/** @type {any} */
	let config = null;
	/** @type {(event: any) => void} */
	let handler = () => {};
	const session = {
		sessionId: "sdk-session",
		rpc: {
			permissions: {
				paths: { add: async (/** @type {{ path: string }} */ { path }) => calls.push(["path", path]) },
				setAllowAll: async (/** @type {{ mode: string }} */ { mode }) => (calls.push(["permission", mode]), { mode }),
				configure: async (/** @type {{ rules: any }} */ { rules }) => (calls.push(["rules", rules]), { success: true }),
			},
			agent: { select: async (/** @type {{ name: string }} */ { name }) => calls.push(["agent", name]) },
			mode: { set: async (/** @type {{ mode: string }} */ { mode }) => calls.push(["mode", mode]) },
		},
		on(/** @type {(event: any) => void} */ fn) {
			handler = fn;
		},
		async sendAndWait(/** @type {{ prompt: string }} */ { prompt }) {
			const event = { type: "assistant.message", data: { content: `SDK: ${prompt}`, model: "sdk-model", outputTokens: 4 } };
			handler(event);
			return event;
		},
		async abort() {},
	};
	class FakeClient {
		constructor(/** @type {any} */ options) {
			calls.push(["client", options.workingDirectory]);
		}
		async createSession(/** @type {any} */ value) {
			config = value;
			return session;
		}
		async resumeSession() {
			return session;
		}
		async stop() {
			return [];
		}
		async forceStop() {}
	}
	const RuntimeConnection = {
		forStdio(/** @type {any} */ options) {
			calls.push(["connection", options.path]);
			return {};
		},
	};
	const cwd = tmpDir();
	const runner = createTestAgentBackend({
		sdk: { CopilotClient: FakeClient, RuntimeConnection },
			sdkBin: "/absolute/copilot",
			resolveAgent: () => ({ name: "worker", prompt: "worker prompt" }),
	});
	const run = runner.openRun();
	const approved = tmpDir();
	const result = await run.run({
		prompt: "hello",
		cwd,
		permissionMode: "auto",
		autopilot: true,
		agentType: "worker",
		// The middle entry no longer exists: a stale parent-approved directory must be skipped, not
		// fail the agent.
		addDir: [cwd, join(tmpDir(), "deleted-since-session-start"), approved],
		enableMcp: false,
		allow: ["read"],
		allowUrl: ["safe.example"],
		deny: ["write"],
		denyUrl: ["blocked.example"],
	});
	await run.close();
	assert.equal(result.ok, true);
	assert.equal(result.content, "SDK: hello");
	assert.equal(config.clientName, "conveyor-extension");
	assert.deepEqual(config.customAgents, [{ name: "worker", prompt: "worker prompt" }]);
	assert.deepEqual(calls.find(([kind]) => kind === "connection"), ["connection", "/absolute/copilot"]);
	assert.equal((await config.onPermissionRequest({ kind: "write", autoApproval: { recommendation: "approve" } })).kind, "reject");
	assert.deepEqual(calls.filter(([kind]) => ["permission", "mode", "agent", "path", "rules"].includes(kind)), [
		["path", approved],
		["agent", "worker"],
		["mode", "autopilot"],
		["permission", "off"],
		["rules", {
			approved: [
				{ kind: "read", argument: null },
				{ kind: "url", argument: "safe.example" },
			],
			denied: [
				{ kind: "write", argument: null },
				{ kind: "url", argument: "blocked.example" },
			],
		}],
	]);
});

test("agent abstraction selects backend identities", () => {
	class FakeClient {}
	const sdk = { CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
	const saved = process.env.CONVEYOR_AGENT_BACKEND;
	try {
		delete process.env.CONVEYOR_AGENT_BACKEND;
		const backend = createTestAgentBackend({ sdk });
		assert.equal(backend.kindFor(), SDK_STDIO_BACKEND);
		process.env.CONVEYOR_AGENT_BACKEND = "cli";
		assert.equal(createTestAgentBackend({ sdk }).kindFor(), CLI_BACKEND);
		delete process.env.CONVEYOR_AGENT_BACKEND;
		assert.equal(createTestAgentBackend().kindFor(), CLI_BACKEND);
	} finally {
		if (saved === undefined) delete process.env.CONVEYOR_AGENT_BACKEND;
		else process.env.CONVEYOR_AGENT_BACKEND = saved;
	}
});

test("backend selection is stable and transport identities remain distinct", async () => {
	class FakeClient {}
	const backend = createTestAgentBackend({
		sdk: { CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } },
		backend: "sdk",
	});
	assert.equal(backend.kindFor(), SDK_STDIO_BACKEND);
	const run = backend.openRun();
	assert.equal(run.kind, SDK_STDIO_BACKEND);
	await run.close();
	assert.notEqual(CLI_BACKEND, SDK_STDIO_BACKEND);
});

test("CONVEYOR_COPILOT_BIN takes precedence over configured transport executables", () =>
	withFakeEnv({ CONVEYOR_COPILOT_BIN: "/operator/copilot" }, () => {
		assert.equal(resolveCopilotBin("/extension/copilot"), "/operator/copilot");
	}));

test("run-scoped SDK backend reuses clients by cwd and closes them once", async () => {
	/** @type {any[][]} */
	const calls = [];
	let nextSession = 0;
	const makeSession = () => {
		/** @type {(event: any) => void} */
		let handler = () => {};
		return {
			sessionId: `sdk-${++nextSession}`,
			rpc: {
				permissions: {
					paths: { add: async () => {} },
					setAllowAll: async (/** @type {any} */ value) => (calls.push(["permission", value.mode]), value),
					configure: async () => ({ success: true }),
				},
				agent: { select: async () => {} },
				mode: { set: async () => {} },
				shutdown: async () => calls.push(["shutdown"]),
			},
			on(/** @type {(event: any) => void} */ fn) {
				handler = fn;
			},
			async sendAndWait(/** @type {{ prompt: string }} */ { prompt }) {
				const event = { type: "assistant.message", data: { content: `SDK: ${prompt}`, outputTokens: 3, model: "sdk" } };
				handler(event);
				return event;
			},
			async abort() {},
			async disconnect() {
				calls.push(["disconnect"]);
			},
		};
	};
	class FakeClient {
		constructor(/** @type {any} */ options) {
			this.cwd = options.workingDirectory;
			calls.push(["client", this.cwd]);
		}
		async createSession() {
			return makeSession();
		}
		async resumeSession() {
			return makeSession();
		}
		async stop() {
			calls.push(["stop", this.cwd]);
			return [];
		}
		async forceStop() {}
	}
	const backend = createSdkRunBackend(
		{ CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } },
		{ sdkBin: "/absolute/copilot" },
	);
	const cwd = tmpDir();
	const [a, b] = await Promise.all([
		backend.run({ prompt: "a", cwd, permissionMode: "off" }),
		backend.run({ prompt: "b", cwd, permissionMode: "on" }),
	]);
	assert.equal(a.content, "SDK: a");
	assert.equal(b.content, "SDK: b");
	assert.equal(a.outputTokens, 3, "the returned terminal event is not counted twice");
	assert.equal(calls.filter(([kind]) => kind === "client").length, 1);
	assert.deepEqual(calls.filter(([kind]) => kind === "permission").map(([, mode]) => mode), ["off", "off"]);
	assert.equal(calls.filter(([kind]) => kind === "shutdown").length, 2);
	assert.equal(calls.filter(([kind]) => kind === "disconnect").length, 2);
	await backend.close();
	await backend.close();
	assert.equal(calls.filter(([kind]) => kind === "stop").length, 1);
});

test("run-scoped SDK backend separates MCP startup capability", async () => {
	/** @type {string[][]} */
	const args = [];
	class FakeClient {
		constructor() {}
		async createSession() {
			return {
				sessionId: `test-${Math.random().toString(16).slice(2)}`,
				rpc: {
					permissions: { paths: { add: async () => {} }, setAllowAll: async (/** @type {any} */ value) => value, configure: async () => ({ success: true }) },
					agent: { select: async () => {} },
					mode: { set: async () => {} },
				},
				on() {},
				async sendAndWait() {
					return { type: "assistant.message", data: { content: "ok" } };
				},
				async abort() {},
			};
		}
		async stop() {
			return [];
		}
		async forceStop() {}
	}
	const backend = createSdkRunBackend({
		CopilotClient: FakeClient,
		RuntimeConnection: { forStdio: (/** @type {any} */ options) => (args.push(options.args), {}) },
	});
	const cwd = tmpDir();
	await backend.run({ prompt: "plain", cwd, enableMcp: false, permissionMode: "off" });
	await backend.run({ prompt: "mcp", cwd, enableMcp: true, permissionMode: "off" });
	assert.equal(args.length, 2);
	assert.equal(args[0].includes("--disable-builtin-mcps"), true);
	assert.equal(args[1].includes("--disable-builtin-mcps"), false);
	await backend.close();
});

test("run-scoped SDK backend shuts down each session before reading usage", () =>
	withFakeEnv({}, async () => {
		const sessionId = "sdk-usage";
		class FakeClient {
			constructor() {}
			async createSession() {
				return {
					sessionId,
					rpc: {
						permissions: { paths: { add: async () => {} }, setAllowAll: async (/** @type {any} */ value) => value, configure: async () => ({ success: true }) },
						agent: { select: async () => {} },
						mode: { set: async () => {} },
						shutdown: async () => {
							const dir = join(String(process.env.COPILOT_HOME), "session-state", sessionId);
							mkdirSync(dir, { recursive: true });
							writeFileSync(join(dir, "events.jsonl"), JSON.stringify({
								type: "session.shutdown",
								sessionId,
								data: {
									totalNanoAiu: 500_000_000,
									modelMetrics: {
										sdk: {
											usage: {
												inputTokens: 10,
												outputTokens: 2,
												cacheReadTokens: 1,
												cacheWriteTokens: 0,
												reasoningTokens: 3,
											},
										},
									},
								},
							}) + "\n");
						},
					},
					on() {},
					async sendAndWait() {
						return { type: "assistant.message", data: { content: "ok", outputTokens: 2, model: "sdk" } };
					},
					async abort() {},
					async disconnect() {},
				};
			}
			async stop() {
				return [];
			}
			async forceStop() {}
		}
		const backend = createSdkRunBackend({ CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } });
		const result = await backend.run({ prompt: "usage", cwd: tmpDir(), permissionMode: "off" });
		assert.equal(result.usageUnknown, false);
		assert.equal(result.aic, 0.5);
		assert.equal(result.inputTokens, 10);
		assert.equal(result.outputTokens, 2);
		await backend.close();
	}));

test("run-scoped SDK backend cancels a hung session creation", async () => {
	class FakeClient {
		constructor() {}
		createSession() {
			return new Promise(() => {});
		}
		async stop() {
			return [];
		}
		async forceStop() {}
	}
	const backend = createSdkRunBackend({ CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } });
	const result = await within(backend.run({ prompt: "hang", cwd: tmpDir(), permissionMode: "off", timeout: 0.05 }), 500);
	assert.match(result.error ?? "", /timed out/);
	await within(backend.close(), 500);
});

test("run-scoped SDK backend drains aborted turns before stopping its client", async () => {
	/** @type {string[]} */
	const calls = [];
	/** @type {(error: Error) => void} */
	let rejectTurn = () => {};
	class FakeClient {
		constructor() {}
		async createSession() {
			return {
				sessionId: "drain",
				rpc: {
					permissions: { paths: { add: async () => {} }, setAllowAll: async (/** @type {any} */ value) => value, configure: async () => ({ success: true }) },
					agent: { select: async () => {} },
					mode: { set: async () => {} },
					shutdown: async () => calls.push("shutdown"),
				},
				on() {},
				sendAndWait() {
					return new Promise((_, reject) => {
						rejectTurn = reject;
					});
				},
				async abort() {
					calls.push("abort");
					rejectTurn(new Error("aborted"));
				},
				async disconnect() {},
			};
		}
		async stop() {
			calls.push("stop");
			return [];
		}
		async forceStop() {
			calls.push("force");
		}
	}
	const backend = createSdkRunBackend({ CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } });
	const turn = backend.run({ prompt: "hang", cwd: tmpDir(), permissionMode: "off" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	await within(backend.close(), 500);
	await within(turn, 500);
	assert.deepEqual(calls.filter((call) => ["abort", "shutdown", "stop"].includes(call)), ["abort", "shutdown", "stop"]);
	assert.equal(calls.includes("force"), false);
});

test("loadCustomAgentConfig clones prompt metadata without MCP when disabled", () => {
	const path = join(tmpDir(), "worker.md");
	writeFileSync(path, `---\nname: worker\ndescription: worker\n---\n\nDo focused work.\n`);
	const config = loadCustomAgentConfig({
		name: "worker",
		displayName: "Worker",
		description: "worker",
		path,
		tools: ["*"],
		model: "gpt-5-mini",
		skills: ["conveyor"],
		mcpServers: { unsafe: { command: "sh" } },
	});
	assert.deepEqual(config, {
		name: "worker",
		displayName: "Worker",
		description: "worker",
		tools: ["*"],
		prompt: "Do focused work.",
		skills: ["conveyor"],
		model: "gpt-5-mini",
	});
});

test("auto-mode abort during custom agent resolution never starts an SDK client", async () => {
	/** @type {string[]} */
	const calls = [];
	class FakeClient {
		constructor() {
			calls.push("client");
		}
	}
	const RuntimeConnection = {
		forStdio() {
			calls.push("connection");
			return {};
		},
	};
	const runner = createTestAgentBackend({
		sdk: { CopilotClient: FakeClient, RuntimeConnection },
			sdkBin: "/absolute/copilot",
			resolveAgent: () => new Promise((resolve) => setTimeout(() => resolve({ name: "worker", prompt: "worker" }), 50)),
	});
	const run = runner.openRun();
	const abort = new AbortController();
	const pending = run.run({ prompt: "hello", permissionMode: "auto", agentType: "worker" }, { signal: abort.signal });
	setTimeout(() => abort.abort(), 10);
	const result = await pending;
	await run.close();
	assert.equal(result.error, "aborted");
	assert.deepEqual(calls, []);
});

test("childEnv: a non-integer CONVEYOR_DEPTH resets to 0 before incrementing", () => {
	assert.equal(childEnv({ CONVEYOR_DEPTH: "not-a-number" }).CONVEYOR_DEPTH, "1");
});

test("childEnv allow-lists runtime/provider variables and drops arbitrary secrets", () => {
	const env = childEnv({
		PATH: "/bin",
		COPILOT_HOME: "/tmp/copilot",
		COPILOT_PROVIDER_API_KEY: "provider-secret",
		LC_ALL: "C",
		UNRELATED_SECRET: "must-not-leak",
		CONVEYOR_CHILD_ENV_ALLOW: "EXPLICIT_VALUE",
		EXPLICIT_VALUE: "forwarded",
	});
	assert.equal(env.PATH, "/bin");
	assert.equal(env.COPILOT_HOME, "/tmp/copilot");
	assert.equal(env.COPILOT_PROVIDER_API_KEY, "provider-secret");
	assert.equal(env.LC_ALL, "C");
	assert.equal(env.EXPLICIT_VALUE, "forwarded");
	assert.equal(env.UNRELATED_SECRET, undefined);
	assert.equal(env.CONVEYOR_CHILD_ENV_ALLOW, undefined);
});

test("abortAllAgentTurns: safe no-op when no agents are live", () => {
	assert.doesNotThrow(() => abortAllAgentTurns());
});

test("abortAllAgentTurns: reaps an in-flight subagent", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "hang" }, async () => {
		const p = runAgent({ prompt: "hi" });
		await new Promise((r) => setTimeout(r, 250)); // let it spawn + register
		abortAllAgentTurns();
		const r = await p;
		assert.equal(r.ok, false);
	}));

test("abort signal kills an in-flight subagent", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "hang" }, async () => {
		const ac = new AbortController();
		const p = runAgent({ prompt: "hi" }, { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 250));
		ac.abort();
		const r = await p;
		assert.equal(r.ok, false);
		assert.equal(r.error, "aborted");
	}));

test(
	"abort kills descendants that inherit the agent's stdio",
	{ skip: process.platform === "win32" },
	() =>
		withFakeEnv({}, async () => {
			const dir = tmpDir();
			const pidFile = join(dir, "leaf.pid");
			process.env.CONVEYOR_FAKE_MODE = "treehang";
			process.env.CONVEYOR_FAKE_PID_FILE = pidFile;
			let leafPid = 0;
			try {
				const ac = new AbortController();
				const pending = runAgent({ prompt: "hi" }, { signal: ac.signal });
				await waitFor(() => existsSync(pidFile));
				leafPid = Number(readFileSync(pidFile, "utf8"));
				assert.equal(processIsAlive(leafPid), true);

				ac.abort();
				const r = await within(pending, 2000);
				assert.equal(r.error, "aborted");
				await waitFor(() => !processIsAlive(leafPid));
			} finally {
				if (leafPid && processIsAlive(leafPid)) process.kill(leafPid, "SIGKILL");
				rmSync(dir, { recursive: true, force: true });
			}
		}),
);

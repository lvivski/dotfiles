/** @module agent.test — subagent driver: spawn, JSONL reduce, AIC/token accounting, argv, env. */
import test from "node:test";
import assert from "node:assert/strict";

import { runAgent, buildArgv, childEnv, killAllAgents, formatSessionError } from "./agent.mjs";
import { withFakeEnv } from "./fixtures/support.mjs";

test("formatSessionError falls back through type/error/reason", () => {
	assert.equal(formatSessionError({ errorType: "RateLimit", message: "slow" }), "RateLimit: slow");
	assert.equal(formatSessionError({ type: "X", reason: "R" }), "X: R");
	assert.equal(formatSessionError({ error: "boom" }), "boom");
	assert.equal(formatSessionError({ type: "OnlyType" }), "OnlyType");
	assert.equal(formatSessionError({}), "session.error");
});

test("AIC reads the first session.shutdown carrying totalNanoAiu", () =>
	withFakeEnv({ CWF_FAKE_NANO_AIU: "500000000", CWF_FAKE_NANO_AIU_2: "999000000" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.nanoAiu, 500_000_000); // the first shutdown, not the later 999e6
		assert.equal(r.aic, 0.5);
	}));

test("a sub-second timeout is honored, not clamped up to 1s", () =>
	withFakeEnv({ CWF_FAKE_MODE: "hang" }, async () => {
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
		assert.equal(r.label, "a");
		assert.ok(r.sessionId);
		assert.ok(r.durationMs >= 0);
	}));

test("nonzero exit -> ok:false with stderr message", () =>
	withFakeEnv({ CWF_FAKE_MODE: "fail" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.equal(r.exitCode, 1);
		assert.match(r.error ?? "", /simulated failure/);
		assert.equal(r.aic, 0);
	}));

test("stderr is bounded by a tail buffer", () =>
	withFakeEnv({ CWF_FAKE_MODE: "fail", CWF_FAKE_STDERR: "a".repeat(80_000) }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.ok((r.error ?? "").length < 70_000);
	}));

test("no assistant message -> ok:false", () =>
	withFakeEnv({ CWF_FAKE_MODE: "nojson" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /no assistant message/);
	}));

test("malformed JSONL lines are ignored, good events still parsed", () =>
	withFakeEnv({ CWF_FAKE_MODE: "malformed", CWF_FAKE_CONTENT: "kept" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, true);
		assert.equal(r.content, "kept");
	}));

test("session.error with empty content surfaces as error", () =>
	withFakeEnv({ CWF_FAKE_MODE: "sessionerror", CWF_FAKE_CONTENT: "" }, async () => {
		const r = await runAgent({ prompt: "hi" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /RateLimit: slow down/);
	}));

test("timeout kills the subprocess and reports a timeout error", () =>
	withFakeEnv({ CWF_FAKE_MODE: "hang" }, async () => {
		const r = await runAgent({ prompt: "hi", timeout: 1 });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /timed out after 1s/);
	}));

test("missing cwd -> failure without spawning", () =>
	withFakeEnv({}, async () => {
		const r = await runAgent({ prompt: "hi", cwd: "/no/such/dir/cwf" });
		assert.equal(r.ok, false);
		assert.match(r.error ?? "", /working directory not found/);
	}));

test("a missing copilot binary -> ok:false (exit 127), never an unhandled crash", () =>
	withFakeEnv({ CWF_COPILOT_BIN: "/no/such/copilot-binary-xyz" }, async () => {
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

test("buildArgv: enableMcp omits --disable-builtin-mcps; quarantine drops --allow-all-tools", () => {
	const withMcp = buildArgv({ prompt: "P", enableMcp: true }, "copilot");
	assert.ok(!withMcp.includes("--disable-builtin-mcps"));
	const quarantined = buildArgv({ prompt: "P", allowAllTools: false }, "copilot");
	assert.ok(!quarantined.includes("--allow-all-tools"));
});

test("childEnv: increments CWF_DEPTH and disables nested workflow tools", () => {
	const e1 = childEnv({}, { runId: "r1", agentId: "g1" });
	assert.equal(e1.CWF_DEPTH, "1");
	assert.equal(e1.CWF_DISABLE_WORKFLOW_TOOLS, "1");
	assert.equal(e1.CWF_PARENT_RUN_ID, "r1");
	assert.equal(e1.CWF_PARENT_AGENT_ID, "g1");
	assert.equal(childEnv({ CWF_DEPTH: "2" }).CWF_DEPTH, "3");
});

test("buildArgv: every argv element is a string", () => {
	const argv = buildArgv({ prompt: "P", model: "m", timeout: 5, allow: ["read"] }, "copilot");
	assert.ok(argv.every((x) => typeof x === "string"), "no non-string argv elements");
});

test("childEnv: a non-integer CWF_DEPTH resets to 0 before incrementing", () => {
	assert.equal(childEnv({ CWF_DEPTH: "not-a-number" }).CWF_DEPTH, "1");
});

test("killAllAgents: safe no-op when no agents are live", () => {
	assert.doesNotThrow(() => killAllAgents());
});

test("killAllAgents: reaps an in-flight subagent", () =>
	withFakeEnv({ CWF_FAKE_MODE: "hang" }, async () => {
		const p = runAgent({ prompt: "hi" });
		await new Promise((r) => setTimeout(r, 250)); // let it spawn + register
		killAllAgents();
		const r = await p;
		assert.equal(r.ok, false);
	}));

test("abort signal kills an in-flight subagent", () =>
	withFakeEnv({ CWF_FAKE_MODE: "hang" }, async () => {
		const ac = new AbortController();
		const p = runAgent({ prompt: "hi" }, { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 250));
		ac.abort();
		const r = await p;
		assert.equal(r.ok, false);
	}));

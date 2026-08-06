/** @module tools.test — conveyor run/list/result handlers via an injected fake ctx. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	abortRun,
	buildCommands,
	buildTools,
	controlConveyorRun,
	formatBackgroundCompletion,
	isNested,
	MAX_TIMEOUT_SEC,
	parseInvalidations,
	resolveTimeout,
	resolveSource,
	runConveyor,
} from "./tools.mjs";
import { executeConveyor } from "./executor.mjs";
import { MAX_RESULT_CHUNK_CHARS, listConveyorRuns, conveyorCommand } from "./runs.mjs";
import { mkResult, withFakeEnv, tmpDir, waitFor } from "./fixtures/support.mjs";

/**
 * @typedef {import("./tools.mjs").ToolCtx & {
 *   logs: string[],
 *   metas: ({ ephemeral?: boolean }|undefined)[],
 *   sends: string[]
 * }} FakeToolCtx
 */

/** A fake {@link import("./tools.mjs").ToolCtx} that captures logs/sends. @param {string} cwd @returns {FakeToolCtx} */
function fakeCtx(cwd) {
	const logs = /** @type {string[]} */ ([]);
	const metas = /** @type {({ ephemeral?: boolean }|undefined)[]} */ ([]);
	const sends = /** @type {string[]} */ ([]);
	return /** @type {FakeToolCtx} */ ({
		logs,
		metas,
		sends,
		log: (/** @type {string} */ m, /** @type {boolean|undefined} */ ephemeral) => (logs.push(String(m)), metas.push({ ephemeral })),
		send: (/** @type {string} */ p) => sends.push(String(p)),
		getWorkspaceCwd: async () => cwd,
	});
}

/**
 * Run a tool-handler body with temp runs/conveyors dirs + the fake backend.
 * @param {(dirs: { runs: string, wf: string }) => Promise<void> | void} fn
 * @param {Record<string, string>} [extraEnv]
 */
function withTool(fn, extraEnv = {}) {
	const runs = tmpDir();
	const wf = tmpDir();
	return withFakeEnv({ CONVEYOR_RUNS_DIR: runs, CONVEYOR_DIR: wf, CONVEYOR_PLANS_DIR: join(wf, ".plans"), ...extraEnv }, () => fn({ runs, wf }));
}

test("foreground inline run returns the conveyor result", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ script: `export const meta = { name: "test", description: "test conveyor" };
return (await agent("hi")).content;`, runId: "untimed-foreground", background: false, budget: 1 }, ctx);
		assert.equal(typeof out, "string");
		assert.match(/** @type {string} */ (out), /conveyor result/);
		assert.match(/** @type {string} */ (out), /ECHO: hi/);
		assert.ok(ctx.logs.some((l) => /┌─ conveyor:/.test(l)), "default progress emits dashboard snapshots");
		assert.ok(ctx.metas.some((m) => m?.ephemeral === false), "final summary is durable");
		assert.equal(JSON.parse(readFileSync(join(runs, "untimed-foreground", "manifest.json"), "utf8")).declaredLimits.timeoutSeconds, undefined);
	}));

test("abortRun returns false for an unknown run id", () => {
	assert.equal(abortRun("no-such-run"), false);
});

test("conveyor run timeouts are opt-in and bounded", () => {
	assert.equal(resolveTimeout(undefined), null);
	assert.equal(resolveTimeout(null), null);
	assert.equal(resolveTimeout(30), 30);
	assert.equal(resolveTimeout(MAX_TIMEOUT_SEC + 1), MAX_TIMEOUT_SEC);
	assert.throws(() => resolveTimeout(0), /timeoutSec must be a number >= 1/);
});

test("declared timeout limit arms the first attempt", () =>
	withTool(
		async ({ runs }) => {
			const ctx = fakeCtx(tmpDir());
			await runConveyor({
				script: `export const meta = { name: "declared-timeout", limits: { timeoutSeconds: 0.05, maxAiCredits: 1 } };
await agent("hang"); return "unreached";`,
				runId: "declared-timeout",
				background: true,
			}, ctx);
			await waitFor(() => existsSync(join(runs, "declared-timeout", "run.json")), 2000, 20);
			assert.equal(JSON.parse(readFileSync(join(runs, "declared-timeout", "run.json"), "utf8")).status, "timeout");
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("xtreme plans bind the preview session model and reject launch-time preset mutation", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		let parentModel = "gpt-5.6-sol";
		ctx.getModelContext = async () => ({
			modelId: parentModel,
			models: [
				{ id: "gpt-5.6-sol", supportedReasoningEfforts: ["xhigh"] },
				{ id: "claude-opus-5", supportedReasoningEfforts: ["xhigh"] },
			],
		});
		/** @type {import("./agent.mjs").AgentSpec[]} */
		const specs = [];
		ctx.agentBackend = {
			kindFor: () => "cli",
			openRun: () => ({
				kind: "cli",
				run: async (/** @type {import("./agent.mjs").AgentSpec} */ spec) => (specs.push(spec), mkResult({ content: "ok", value: "ok" })),
				async close() {},
			}),
		};
		const preview = await runConveyor({
			script: `export const meta = { name: "xtreme-plan", description: "test conveyor" };
return (await agent("work")).content;`,
			dryRun: true,
			preset: "xtreme",
		}, ctx);
		assert.match(String(preview), /model: gpt-5\.6-sol/);
		const planId = String(preview).match(/planId: (\S+)/)?.[1];
		parentModel = "claude-opus-5";
		const launched = await runConveyor({ planId, runId: "xtreme-bound", background: false }, ctx);
		assert.match(String(launched), /model: gpt-5\.6-sol/);
		assert.equal(specs[0].model, "gpt-5.6-sol");
		assert.equal(specs[0].effort, "xhigh");
		assert.equal(specs[0].context, "long_context");
		const manifest = JSON.parse(readFileSync(join(runs, "xtreme-bound", "manifest.json"), "utf8"));
		assert.equal(manifest.model, "gpt-5.6-sol");
		const conflicting = await runConveyor({ planId, preset: "xtreme", runId: "xtreme-conflict" }, ctx);
		assert.match(JSON.stringify(conflicting), /planId cannot be combined.*preset/);
	}));

test("abortRun aborts a live background run and clears it once settled", () =>
	withTool(
		async ({ wf }) => {
			const ctx = fakeCtx(tmpDir());
			const path = join(wf, "h.mjs");
			writeFileSync(path, `export const meta = { name: "test", description: "test conveyor" };
await agent("x"); return "done";`);
			const out = await runConveyor({ scriptPath: path, runId: "abort-me", budget: 1, timeoutSec: 30 }, ctx);
			assert.match(String(out), /started in background/);
			assert.equal(abortRun("abort-me"), true); // registered while running
			await waitFor(() => !abortRun("abort-me"), 3000);
			assert.equal(abortRun("abort-me"), false); // aborted run settled + deregistered
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("duplicate live run ids are rejected without replacing the active run", () =>
	withTool(
		async ({ wf }) => {
			const ctx = fakeCtx(tmpDir());
			const path = join(wf, "h.mjs");
			writeFileSync(path, `export const meta = { name: "test", description: "test conveyor" };
await agent("x"); return "done";`);
			await runConveyor({ scriptPath: path, runId: "same-id", budget: 1, timeoutSec: 30 }, ctx);
			const duplicate = await runConveyor({ scriptPath: path, runId: "same-id", budget: 1, timeoutSec: 30 }, ctx);
			assert.match(JSON.stringify(duplicate), /already active/);
			assert.equal(abortRun("same-id"), true);
			await waitFor(() => !abortRun("same-id"), 2000);
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("dryRun returns a plan and spends nothing", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ script: `export const meta = { name: "test", description: "test conveyor" };
await pipeline([1,2], (n) => agent("x"+n)); return "z";`, dryRun: true }, ctx);
		assert.match(/** @type {string} */ (out), /dry-run complete/);
		assert.match(/** @type {string} */ (out), /AIC used: 0\.0/);
		assert.match(/** @type {string} */ (out), /planId: plan-/);
	}));

test("planId launches the bound source and enforces the previewed agent ceiling", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const preview = await runConveyor(
			{
				script: `export const meta = { name: "planned", description: "test conveyor" };
const items = context.dryRun ? [1] : [1,2,3,4,5]; await pipeline(items, (n) => agent("x" + n)); return "done";`,
				dryRun: true,
				budget: 10,
			},
			ctx,
		);
		const planId = String(preview).match(/planId: (\S+)/)?.[1];
		assert.ok(planId);
		const launched = await runConveyor({ planId, background: false }, ctx);
		assert.match(JSON.stringify(launched), /agent cap exceeded/);
	}));

test("resume replays the persisted plan ceiling from the manifest", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		const source = `export const meta = { name: "resume-plan", description: "test conveyor" };
const items = context.dryRun ? [1] : [1,2,3,4,5]; await pipeline(items, (n) => agent("x" + n)); return "done";`;
		const preview = await runConveyor({ script: source, dryRun: true, budget: 5 }, ctx);
		const planId = String(preview).match(/planId: (\S+)/)?.[1];
		const first = await runConveyor({ planId, runId: "resume-plan-run", background: false }, ctx);
		assert.match(JSON.stringify(first), /agent cap exceeded/);

		// Resume takes every setting from the manifest, so the plan's ceiling still applies.
		await controlConveyorRun({ runId: "resume-plan-run", action: "resume" }, ctx);
		await waitFor(() => existsSync(join(runs, "resume-plan-run", "run.json")) && JSON.parse(readFileSync(join(runs, "resume-plan-run", "run.json"), "utf8")).status !== "running", 5000);
		const record = JSON.parse(readFileSync(join(runs, "resume-plan-run", "run.json"), "utf8"));
		assert.match(String(record.error ?? ""), /agent cap exceeded/);
	}));

test("branch invalidation paths are canonicalized and ancestor-reduced", () => {
	assert.deepEqual(parseInvalidations(["/2/1", "/0/3", "/0", "/2/1"]), [[0], [2, 1]]);
	assert.deepEqual(parseInvalidations(["/", "/3"]), [[]]);
	assert.throws(() => parseInvalidations(["0/1"]), /invalid branch path/);
});

test("run_conveyor surfaces a failure when its manifest cannot be persisted", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		mkdirSync(join(runs, "artifact-fail", "manifest.json"), { recursive: true });
		const out = await runConveyor({
			script: `export const meta = { name: "artifact-fail", description: "test conveyor" };\nreturn "done";`,
			runId: "artifact-fail",
			background: false,
			budget: 1,
			args: { important: "input" },
		}, ctx);
		assert.match(JSON.stringify(out), /internal conveyor extension error/);
		assert.ok(!existsSync(join(runs, "artifact-fail", "run.json")), "a failed launch leaves no terminal artifact");
	}));

test("foreground runs and foreground resumes return inline and never enqueue a completion notice", () =>
	withTool(async ({ wf }) => {
		const ctx = fakeCtx(tmpDir());
		const path = join(wf, "quiet.mjs");
		writeFileSync(path, `export const meta = { name: "quiet", description: "test conveyor" };
await pipeline([0,1], (n) => agent("q" + n)); return "done";`);

		const first = await runConveyor({ scriptPath: path, runId: "quiet-run", background: false, budget: 10 }, ctx);
		assert.match(String(first), /done/);
		assert.deepEqual(ctx.sends, [], "a foreground run must not enqueue a notice");

		const resumed = await controlConveyorRun({ runId: "quiet-run", action: "resume", background: false }, ctx);
		assert.match(String(resumed), /done/);
		assert.deepEqual(ctx.sends, [], "a foreground resume must not enqueue a notice either");
	}));

test("implicit default budget remains declared and enforced on ordinary resume", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		const source = `export const meta = { name: "defaults", description: "default limits" };
return (await agent("one")).content;`;
		const first = await runConveyor({ script: source, runId: "default-resume", background: false }, ctx);
		assert.match(String(first), /complete/);
		const manifest = JSON.parse(readFileSync(join(runs, "default-resume", "manifest.json"), "utf8"));
		assert.equal(manifest.declaredLimits.maxAiCredits, 10_000);
		const resumed = await controlConveyorRun({ runId: "default-resume", action: "resume", background: false }, ctx);
		assert.match(String(resumed), /complete/);
		assert.equal(existsSync(join(runs, "default-resume", "run.json")), true);
		const ledger = readFileSync(join(runs, "default-resume", "ledger.jsonl"), "utf8");
		assert.match(ledger, /"maxAiCredits":10000/);
	}));

test("meta maxAiCredits is not weakened by the default budget", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		await runConveyor({
			script: `export const meta = { name: "meta-budget", limits: { maxAiCredits: 20 } }; return "done";`,
			runId: "meta-budget",
			background: false,
		}, ctx);
		const manifest = JSON.parse(readFileSync(join(runs, "meta-budget", "manifest.json"), "utf8"));
		assert.equal(manifest.declaredLimits.maxAiCredits, 20);
		const approvals = readFileSync(join(runs, "meta-budget", "ledger.jsonl"), "utf8");
		assert.match(approvals, /"maxAiCredits":20/);
		assert.doesNotMatch(approvals, /"maxAiCredits":10000/);
	}));

test("resume selectively invalidates requested branches", () =>
	withTool(async ({ wf, runs }) => {
		const ctx = fakeCtx(tmpDir());
		const path = join(wf, "selective.mjs");
		writeFileSync(path, `export const meta = { name: "selective", description: "test conveyor" };
await pipeline([0,1], (n) => agent("b" + n)); return "done";`);
		await runConveyor({ scriptPath: path, runId: "selective-run", background: false, budget: 10 }, ctx);
		const priorRevision = JSON.parse(readFileSync(join(runs, "selective-run", "run.json"), "utf8")).revision;
		await controlConveyorRun({ runId: "selective-run", action: "resume", invalidate: ["/0"] }, ctx);
		await waitFor(() => existsSync(join(runs, "selective-run", "run.json")) && JSON.parse(readFileSync(join(runs, "selective-run", "run.json"), "utf8")).revision > priorRevision, 5000);
		const record = JSON.parse(readFileSync(join(runs, "selective-run", "run.json"), "utf8"));
		assert.equal(record.counts.done, 1);
		assert.equal(record.counts.cached, 1);
		const controls = readFileSync(join(runs, "selective-run", "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "branches_invalidated");
		assert.deepEqual(controls.map((record) => record.branches), [[[0]]]);
	}));

test("plan previews preserve worst-case content-dependent fan-out", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const source = `export const meta = { name: "pattern-plan", description: "test conveyor" };
const kept = await pipeline(["a","b","c","d","e","f","g","h"], (p) => agent(p), (r) => verify(r, "good")); return String(kept.length);`;
		const preview = await runConveyor({ script: source, dryRun: true, budget: 20 }, ctx);
		const planId = String(preview).match(/planId: (\S+)/)?.[1];
		const launched = await runConveyor({ planId, background: false }, ctx);
		assert.doesNotMatch(JSON.stringify(launched), /agent cap exceeded/);
	}));

test("run_conveyor applies a user-approved budget increase and persists it", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		let approvals = 0;
		ctx.requestLimitApproval = async () => {
			approvals++;
			return true;
		};
		const out = await runConveyor({
			script: `export const meta = { name: "budget-approval", description: "test conveyor" };
await agent("one"); await agent("two"); return "done";`,
			runId: "budget-approval",
			background: false,
			budget: 0.4,
		}, ctx);
		assert.match(String(out), /conveyor run complete/);
		assert.equal(approvals, 1);
		const run = JSON.parse(readFileSync(join(runs, "budget-approval", "run.json"), "utf8"));
		assert.ok(run.budget.total > 1);
		const controls = readFileSync(join(runs, "budget-approval", "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "limits_approved" && record.limits.maxAiCredits > 0.4);
		assert.equal(controls.length, 1);
	}));

test("run_conveyor inherits parent auto and autopilot posture into agents and provenance", () =>
	withTool(async ({ runs }) => {
		const cwd = tmpDir();
		const ctx = fakeCtx(cwd);
		/** @type {import("./agent.mjs").AgentSpec[]} */
		const specs = [];
		ctx.getPermissionContext = async () => ({ allowAll: false, mode: "auto", sessionMode: "autopilot", directories: [cwd] });
		ctx.agentBackend = {
			kindFor: () => "cli",
			openRun: () => ({
				kind: "cli",
				run: async (/** @type {import("./agent.mjs").AgentSpec} */ spec) => (specs.push(spec), mkResult({ content: "ok", value: "ok" })),
				async close() {},
			}),
		};
		await runConveyor({
			script: `export const meta = { name: "permission-auto", description: "test conveyor" };
return (await agent("research", { profile: "research" })).content;`,
			runId: "permission-auto",
			background: false,
			budget: 10,
		}, ctx);
		assert.equal(specs[0].permissionMode, "auto");
		assert.equal(specs[0].autopilot, true);
		assert.deepEqual(specs[0].deny, ["shell", "write"]);
		const manifest = JSON.parse(readFileSync(join(runs, "permission-auto", "manifest.json"), "utf8"));
		assert.equal(manifest.parentPermissionMode, "auto");
		assert.equal(manifest.parentSessionMode, "autopilot");
		assert.equal(manifest.permissionMode, "parent-auto-profile-narrowed");
		assert.equal(manifest.permissionInheritance.fineGrainedRules, "not-exposed-by-parent-sdk");
	}));

test("resume never exceeds the original or current parent permission posture", () =>
	withTool(async ({ wf }) => {
		const cwd = tmpDir();
		const ctx = fakeCtx(cwd);
		/** @type {"on"|"auto"} */
		let mode = "on";
		ctx.getPermissionContext = async () => ({ allowAll: mode === "on", mode, sessionMode: "interactive", directories: [cwd] });
		const path = join(wf, "permission-resume.mjs");
		writeFileSync(path, `export const meta = { name: "permission-resume", description: "test conveyor" };
return "done";`);
		await runConveyor({ scriptPath: path, runId: "permission-resume", background: false, budget: 1 }, ctx);
		mode = "auto";
		const resumed = await controlConveyorRun({ runId: "permission-resume", action: "resume" }, ctx);
		assert.match(JSON.stringify(resumed), /requires parent permission mode 'on'/);
	}));

test("resume of a nonexistent run id is refused", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await controlConveyorRun({ runId: "does-not-exist", action: "resume" }, ctx);
		assert.match(JSON.stringify(out), /has no manifest/);
	}));

test("validation: exactly one source, and a positive budget for non-dry", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const both = await runConveyor({ script: "export const meta = { name: \"test\", description: \"test conveyor\" };\nreturn 1;", name: "x", background: false }, ctx);
		assert.match(JSON.stringify(both), /EXACTLY ONE/);
		const none = await runConveyor({ background: false }, ctx);
		assert.match(JSON.stringify(none), /EXACTLY ONE/);
		const badBudget = await runConveyor({ script: "export const meta = { name: \"test\", description: \"test conveyor\" };\nreturn 1;", background: false, budget: 0 }, ctx);
		assert.match(JSON.stringify(badBudget), /budget must be a positive/);
	}));

test("invalid declared phase and limit metadata is surfaced", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const badLimit = await runConveyor({
			script: `export const meta = { name: "bad", limits: { typoLimit: 1 } }; return "x";`,
			background: false,
		}, ctx);
		assert.match(JSON.stringify(badLimit), /invalid Conveyor metadata.*unknown Conveyor limit/);
		const badPhase = await runConveyor({
			script: `export const meta = { name: "bad", phases: ["same", "same"] }; return "x";`,
			background: false,
		}, ctx);
		assert.match(JSON.stringify(badPhase), /invalid Conveyor metadata.*declared more than once/);
	}));

test("saved .mjs conveyor resolves and runs by name", () =>
	withTool(async ({ wf }) => {
		writeFileSync(join(wf, "greet.mjs"), `export const meta = { name: "greet", description: "test conveyor" };
return (await agent("named")).content;`, "utf8");
		const { source, label } = resolveSource({ name: "greet" });
		assert.match(source, /agent\("named"\)/);
		assert.equal(label, "greet");
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ name: "greet", background: false, budget: 1 }, ctx);
		assert.match(/** @type {string} */ (out), /ECHO: named/);
	}));

test("generated run ids remain retrievable when a script filename contains dot runs", () =>
	withTool(async ({ wf }) => {
		const path = join(wf, "audit..v2.mjs");
		writeFileSync(path, `export const meta = { name: "audit-v2", description: "test conveyor" };
return "retrievable";`, "utf8");
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ scriptPath: path, background: false, budget: 1 }, ctx);
		const runId = /** @type {string} */ (out).match(/runId: (\S+)/)?.[1];
		assert.ok(runId);
		assert.match(runId, /^audit\.\.v2\.mjs-/);

		const get = buildTools(ctx).find((tool) => tool.name === "get_conveyor_result");
		const result = JSON.parse(await get.handler({ runId }));
		assert.equal(result.resultAvailable, true);
		assert.equal(result.result, "retrievable");
	}));

test("saved conveyor automatically loads its sibling host sidecar", () =>
	withTool(async ({ wf }) => {
		writeFileSync(join(wf, "hosted.mjs"), `export const meta = { name: "hosted", description: "test conveyor" };
return (await host.ping({ value: "PONG" })).value;`, "utf8");
		writeFileSync(join(wf, "hosted.host.mjs"), `export async function ping(input) { return input; }`, "utf8");
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ name: "hosted", background: false, budget: 1 }, ctx);
		assert.match(/** @type {string} */ (out), /PONG/);
	}));

test("scriptPath must point to a .mjs conveyor", () =>
	withTool(async ({ wf }) => {
		const path = join(wf, "plain.js");
		writeFileSync(path, "return 1;", "utf8");
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ scriptPath: path, background: false, budget: 1 }, ctx);
		assert.match(JSON.stringify(out), /scriptPath must point to a .mjs conveyor/);
	}));

test("only .mjs conveyor sources are accepted", () =>
	withTool(async ({ wf }) => {
		const path = join(wf, "old.py");
		writeFileSync(path, "print('x')", "utf8");
		const ctx = fakeCtx(tmpDir());
		const byPath = await runConveyor({ scriptPath: path, background: false, budget: 1 }, ctx);
		assert.match(JSON.stringify(byPath), /must point to a \.mjs conveyor/);
		const named = await runConveyor({ name: "old", background: false, budget: 1 }, ctx);
		assert.match(JSON.stringify(named), /no saved conveyor named 'old'/);
	}));

test("unknown saved conveyor name errors clearly", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ name: "does-not-exist", background: false }, ctx);
		assert.match(JSON.stringify(out), /no saved conveyor named/);
	}));

test("list_conveyor_runs reads persisted artifacts newest-first", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		await runConveyor({ script: `export const meta = { name: "test", description: "test conveyor" };
return (await agent("hi")).content;`, background: false, budget: 1, name: undefined }, ctx);
		const listing = listConveyorRuns();
		assert.match(listing, /RUN ID/);
		assert.match(listing, /complete/);
	}));

test("list_conveyor_runs names runs recovered from ledger replay alone", () =>
	withTool(({ runs }) => {
		const dir = join(runs, "replay-only-run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ conveyor: { name: "deep-audit" }, createdAt: "2026-01-01T00:00:00.000Z" }));
		writeFileSync(join(dir, "ledger.jsonl"), [
			JSON.stringify({ type: "progress", revision: 1, recordedAt: 1, record: { ev: "run_start", meta: { name: "deep-audit" } } }),
			JSON.stringify({ type: "progress", revision: 2, recordedAt: 2, record: { ev: "run_end", status: "complete", agents: 1, launched: 1, cached: 0, skipped: 0, failed: 0, nanoAiu: 500_000_000, t: Date.parse("2026-01-01T00:00:00.000Z") } }),
		].join("\n") + "\n");
		const listing = listConveyorRuns();
		assert.match(listing, /replay-only-run/);
		assert.match(listing, /deep-audit/);
		assert.match(listing, /\s+0\.5\s+/);
	}));

test("list_conveyor_runs caps output to newest runs before parsing metadata", () =>
	withTool(async ({ runs }) => {
		for (let i = 0; i < 55; i++) {
			const id = `run-${String(i).padStart(2, "0")}`;
			const dir = join(runs, id);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ conveyor: { name: id }, createdAt: `2024-01-01T00:00:${String(i).padStart(2, "0")}Z` }));
		}
		const listing = listConveyorRuns();
		assert.match(listing, /showing newest 50 of 55 runs/);
		assert.doesNotMatch(listing, /run-00/);
	}));

test("background run returns immediately and wakes the agent on completion", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		const out = await runConveyor({ script: `export const meta = { name: "test", description: "test conveyor" };
return (await agent("bg")).content;`, background: true, budget: 1 }, ctx);
		assert.match(/** @type {string} */ (out), /started in background/);
		assert.match(/** @type {string} */ (out), /inspect_conveyor_run/);
		assert.match(/** @type {string} */ (out), /get_conveyor_result/);
		assert.doesNotMatch(/** @type {string} */ (out), /state\.json/);
		await waitFor(() => ctx.sends.length > 0, 2000, 40);
		assert.equal(ctx.sends.length, 1);
		assert.match(ctx.sends[0], /complete/);
		assert.match(ctx.sends[0], /complete conveyor result is included below/);
		const block = ctx.sends[0].match(/BEGIN CONVEYOR RESULT ([0-9a-f]{8})\n([\s\S]*?)\nEND CONVEYOR RESULT \1/);
		assert.ok(block);
		assert.match(block[2], /ECHO: bg/);
		const completionLog = ctx.logs.find((line) => /^conveyor .* complete:/.test(line));
		assert.ok(completionLog);
		assert.doesNotMatch(completionLog, /ECHO: bg/);
	}));

test("background launch logging failure releases Work ownership", () =>
	withTool(async ({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		ctx.log = () => {
			throw new Error("log failed");
		};
		const out = await runConveyor({
			script: `export const meta = { name: "log-failure", description: "test conveyor" };
return "unreached";`,
			runId: "log-failure",
			background: true,
			budget: 1,
		}, ctx);
		assert.match(JSON.stringify(out), /log failed/);
		assert.equal(existsSync(join(runs, "log-failure", ".lock")), false);
		assert.equal(abortRun("log-failure"), false);
	}));

test("background completion truncates oversized results with a retrieval-tool fallback", () => {
	const runDir = join(tmpDir(), "large");
	const notice = formatBackgroundCompletion(
		{
			runId: "large",
			status: "complete",
			aic: 1,
			counts: { done: 1, failed: 0, skipped: 0, dropped: 0 },
			result: "x".repeat(MAX_RESULT_CHUNK_CHARS + 17),
		},
		runDir,
	);
	const block = notice.prompt.match(/BEGIN CONVEYOR RESULT ([0-9a-f]{8})\n([\s\S]*?)\nEND CONVEYOR RESULT \1/);
	assert.ok(block);
	assert.equal(block[2].length, MAX_RESULT_CHUNK_CHARS);
	assert.match(notice.prompt, /Inline result truncated by 17 characters/);
	assert.match(notice.prompt, /get_conveyor_result\(\{ "runId": "large" \}\)/);
	assert.doesNotMatch(notice.prompt, /read .*result\.json/i);
	assert.doesNotMatch(notice.logLine, /x{100}/);
});

test("background completion surfaces partial errors and preserved results", () => {
	const runDir = join(tmpDir(), "partial");
	const notice = formatBackgroundCompletion(
		{
			runId: "partial",
			status: "partial",
			error: "agent failed\nwith details",
			aic: 2,
			counts: { done: 2, failed: 1, skipped: 0, dropped: 0 },
			result: "usable partial answer",
		},
		runDir,
	);
	assert.match(notice.prompt, /warning: conveyor status is partial; any result below may be incomplete/);
	assert.match(notice.prompt, /error: agent failed with details/);
	assert.match(notice.prompt, /usable partial answer/);
});

test("background completion identifies an empty conveyor result", () => {
	const notice = formatBackgroundCompletion(
		{
			runId: "empty",
			status: "complete",
			aic: 0,
			counts: { done: 0, failed: 0, skipped: 0, dropped: 0 },
			result: " \n ",
		},
		join(tmpDir(), "empty"),
	);
	assert.match(notice.prompt, /conveyor result: \(empty\)/);
	assert.doesNotMatch(notice.prompt, /BEGIN CONVEYOR RESULT/);
});

test("background run timeout settles, persists timeout, and clears the live registry", () =>
	withTool(
		async ({ runs }) => {
			const ctx = fakeCtx(tmpDir());
			const out = await runConveyor({
				script: `export const meta = { name: "test", description: "test conveyor" };
await agent("hang"); return "unreached";`,
				runId: "timer-timeout",
				background: true,
				budget: 1,
				timeoutSec: 1,
			}, ctx);
			assert.match(/** @type {string} */ (out), /started in background/);

			await waitFor(() => ctx.sends.length > 0, 3000, 30);
			assert.equal(ctx.sends.length, 1);
			assert.match(ctx.sends[0], /timer-timeout timeout/);
			assert.equal(abortRun("timer-timeout"), false);

			const resultPath = join(runs, "timer-timeout", "run.json");
			assert.equal(existsSync(resultPath), true);
			assert.equal(JSON.parse(readFileSync(resultPath, "utf8")).status, "timeout");
			assert.equal(JSON.parse(readFileSync(join(runs, "timer-timeout", "manifest.json"), "utf8")).declaredLimits.timeoutSeconds, 1);

			const resumed = await controlConveyorRun({ runId: "timer-timeout", action: "resume" }, ctx);
			assert.match(JSON.stringify(resumed), /exhausted its cumulative timeoutSeconds limit/);
			assert.equal(ctx.sends.length, 1);
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("aborting one concurrent conveyor does not terminate another run's agent", () =>
	withTool(
		async ({ runs }) => {
			const pidDir = tmpDir();
			const firstPid = join(pidDir, "first.pid");
			const secondPid = join(pidDir, "second.pid");
			const firstCtx = fakeCtx(tmpDir());
			const secondCtx = fakeCtx(tmpDir());
			try {
				process.env.CONVEYOR_FAKE_PID_FILE = firstPid;
				await runConveyor({
					script: `export const meta = { name: "test", description: "test conveyor" };
const r = await agent("hang"); if (!r.ok) throw new Error(r.error); return r.content;`,
					runId: "isolation-first",
					background: true,
					budget: 1,
					timeoutSec: 30,
				}, firstCtx);
				await waitFor(() => existsSync(firstPid));

				process.env.CONVEYOR_FAKE_MODE = "ok";
				process.env.CONVEYOR_FAKE_DELAY_MS = "500";
				process.env.CONVEYOR_FAKE_PID_FILE = secondPid;
				await runConveyor({
					script: `export const meta = { name: "test", description: "test conveyor" };
const r = await agent("healthy"); if (!r.ok) throw new Error(r.error); return r.content;`,
					runId: "isolation-second",
					background: true,
					budget: 1,
					timeoutSec: 30,
				}, secondCtx);
				await waitFor(() => existsSync(secondPid));

				assert.equal(abortRun("isolation-first"), true);
				await waitFor(() => firstCtx.sends.some((line) => /isolation-first cancelled/.test(line)));
				await waitFor(() => secondCtx.sends.some((line) => /isolation-second complete/.test(line)));

				assert.equal(JSON.parse(readFileSync(join(runs, "isolation-first", "run.json"), "utf8")).status, "cancelled");
				assert.equal(JSON.parse(readFileSync(join(runs, "isolation-second", "run.json"), "utf8")).status, "complete");
				assert.equal(abortRun("isolation-second"), false);
			} finally {
				abortRun("isolation-first");
				abortRun("isolation-second");
				rmSync(pidDir, { recursive: true, force: true });
			}
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("buildTools registers conveyor run/control/list/inspect/result tools with valid schemas", () => {
	const tools = buildTools(fakeCtx("/"));
	assert.deepEqual(tools.map((t) => t.name).sort(), ["control_conveyor_run", "get_conveyor_agent_content", "get_conveyor_progress", "get_conveyor_result", "inspect_conveyor_agent", "inspect_conveyor_run", "list_conveyor_runs", "run_conveyor"]);
	const rw = tools.find((t) => t.name === "run_conveyor");
	assert.equal(rw.defer, "never");
	assert.equal(rw.parameters.type, "object");
	assert.ok(rw.parameters.properties.script && rw.parameters.properties.budget && rw.parameters.properties.dryRun && rw.parameters.properties.progress);
	assert.equal(typeof rw.handler, "function");
	const get = tools.find((t) => t.name === "get_conveyor_result");
	assert.equal(get.skipPermission, true);
	assert.deepEqual(get.parameters.required, ["runId"]);
	assert.equal(get.parameters.properties.limit.maximum, 32_000);
	const list = tools.find((t) => t.name === "list_conveyor_runs");
	assert.equal(list.skipPermission, true);
	const inspect = tools.find((t) => t.name === "inspect_conveyor_run");
	assert.equal(inspect.skipPermission, true);
	assert.deepEqual(inspect.parameters.required, ["runId"]);
	const control = tools.find((t) => t.name === "control_conveyor_run");
	assert.equal(control.skipPermission, true);
	assert.deepEqual(control.parameters.required, ["runId", "action"]);
});

test("get_conveyor_result tool returns JSON chunks and structured validation failures", () =>
	withTool(async ({ runs }) => {
		const dir = join(runs, "tool-run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "tool-run", status: "complete", aic: 1, result: "hello" }));
		const get = buildTools(fakeCtx("/")).find((t) => t.name === "get_conveyor_result");
		const result = JSON.parse(await get.handler({ runId: "tool-run", format: "text", limit: 2 }));
		assert.equal(result.result, "he");
		assert.equal(result.nextOffset, 2);

		const invalid = await get.handler({ runId: "../outside" });
		assert.equal(invalid.resultType, "failure");
		assert.match(invalid.textResultForLlm, /bare conveyor run id/);
	}));

test("inspect_conveyor_run tool returns bounded status and structured validation failures", () =>
	withTool(async ({ runs }) => {
		const dir = join(runs, "inspect-tool-run");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "inspect-tool-run", status: "complete", result: "hidden", counts: {} }));
		const inspect = buildTools(fakeCtx("/")).find((t) => t.name === "inspect_conveyor_run");
		const result = JSON.parse(await inspect.handler({ runId: "inspect-tool-run" }));
		assert.equal(result.status, "complete");
		assert.equal(result.result.available, true);
		assert.doesNotMatch(JSON.stringify(result), /hidden/);

		const invalid = await inspect.handler({ runId: "../outside" });
		assert.equal(invalid.resultType, "failure");
	}));

test("recursion guard: nested subagents get no run_conveyor tool", () => {
	const saved = process.env.CONVEYOR_DISABLE_TOOLS;
	process.env.CONVEYOR_DISABLE_TOOLS = "1";
	try {
		assert.equal(isNested(), true);
		assert.deepEqual(buildTools(fakeCtx("/")).map((t) => t.name), ["get_conveyor_result", "list_conveyor_runs", "inspect_conveyor_run", "inspect_conveyor_agent"]);
	} finally {
		if (saved === undefined) delete process.env.CONVEYOR_DISABLE_TOOLS;
		else process.env.CONVEYOR_DISABLE_TOOLS = saved;
	}
});

test("control_conveyor_run pauses and resumes a run through durable replay", () =>
	withTool(
		async ({ runs }) => {
			const ctx = fakeCtx(tmpDir());
			process.env.CONVEYOR_FAKE_MODE = "hang";
			await runConveyor({
				script: `export const meta = { name: "controlled", description: "test conveyor" };
const result = await agent("controlled"); return result.content;`,
				runId: "paused-run",
				background: true,
				budget: 2,
				timeoutSec: 30,
			}, ctx);
			const pause = JSON.parse(/** @type {string} */ (await controlConveyorRun({ runId: "paused-run", action: "pause" }, ctx)));
			assert.equal(pause.status, "pausing");
			await waitFor(() => existsSync(join(runs, "paused-run", "run.json")) && JSON.parse(readFileSync(join(runs, "paused-run", "run.json"), "utf8")).status === "paused", 3000);

			process.env.CONVEYOR_FAKE_MODE = "ok";
			const resumed = await controlConveyorRun({ runId: "paused-run", action: "resume" }, ctx);
			assert.match(String(resumed), /started in background/);
			await waitFor(() => existsSync(join(runs, "paused-run", "run.json")) && JSON.parse(readFileSync(join(runs, "paused-run", "run.json"), "utf8")).status === "complete", 4000);
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("control_conveyor_run cancels a run owned by another extension instance", () =>
	withTool(
		async ({ runs }) => {
			const nonce = `${Date.now()}-${Math.random()}`;
			const ownerModule = await import(`./work.mjs?owner=${nonce}`);
			const remoteCtx = fakeCtx(tmpDir());
			const runDir = join(runs, "remote-control");
			const ownerWork = ownerModule.Work.open({
				runId: "remote-control",
				runDir,
				controlPollMs: 20,
				heartbeatIntervalMs: 20,
			});
			const execution = executeConveyor({
				source: `export const meta = { name: "remote-control", description: "test conveyor" };
await agent("hang"); return "unreached";`,
				runId: "remote-control",
				runDir,
				cwd: tmpDir(),
				budget: 1,
				work: ownerWork,
			}).finally(() => ownerWork.close());
			try {
				await waitFor(() => existsSync(join(runs, "remote-control", ".lock", "owner.json")), 3000);
				const pause = JSON.parse(/** @type {string} */ (await controlConveyorRun({
					runId: "remote-control",
					action: "pause",
				}, remoteCtx)));
				const response = JSON.parse(/** @type {string} */ (await controlConveyorRun({
					runId: "remote-control",
					action: "cancel",
				}, remoteCtx)));
				assert.equal(pause.queued, true);
				assert.equal(response.accepted, true);
				assert.equal(response.queued, true);
				assert.equal(response.durable, true);
				const record = await execution;
				assert.equal(record.status, "cancelled");
				assert.equal(JSON.parse(readFileSync(join(runs, "remote-control", "run.json"), "utf8")).status, "cancelled");
			} finally {
				ownerWork.request("cancel");
				ownerWork.close();
			}
		},
		{ CONVEYOR_FAKE_MODE: "hang" },
	));

test("/conveyor slash command: inspection dispatches (runs/latest/result/artifacts/unknown)", () =>
	withTool(async () => {
		const ctx = fakeCtx(tmpDir());
		conveyorCommand("", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /no conveyor runs yet/);

		const out = await runConveyor({ script: `export const meta = { name: "test", description: "test conveyor" };
return (await agent("hi")).content;`, background: false, budget: 1 }, ctx);
		const runId = /** @type {string} */ (out).match(/runId: (\S+)/)?.[1];
		assert.ok(runId);

		conveyorCommand("runs", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /RUN ID/);

		conveyorCommand("latest", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /┌─ conveyor:/);

		conveyorCommand(runId, ctx);
		assert.match(ctx.logs.at(-1) ?? "", new RegExp(`inspect: /conveyor ${runId}`));

		conveyorCommand(`result ${runId}`, ctx);
		assert.equal(ctx.logs.at(-1), "ECHO: hi");

		conveyorCommand(`artifacts ${runId}`, ctx);
		assert.match(ctx.logs.at(-1) ?? "", /run\.json/);

		conveyorCommand("no-such-run", ctx);
		assert.match(ctx.logs.at(-1) ?? "", /no run found/);
	}));

test("/conveyor falls back to summary when state.json is absent", () =>
	withTool(({ runs }) => {
		const ctx = fakeCtx(tmpDir());
		const runId = "summary-only";
		const dir = join(runs, runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "run.json"), JSON.stringify({ status: "complete", counts: { agents: 1, done: 1, cached: 0, skipped: 0, failed: 0 }, aic: 0.5 }));
		conveyorCommand(runId, ctx);
		assert.match(ctx.logs.at(-1) ?? "", /conveyor run summary-only/);
	}));

test("buildCommands registers the 'conveyor' command", () => {
	const cmds = buildCommands(fakeCtx("/"));
	assert.deepEqual(cmds.map((c) => c.name), ["conveyor"]);
	assert.equal(typeof cmds[0].handler, "function");
	assert.match(cmds[0].description, /\/conveyor/);
});

test("recursion guard: nested by CONVEYOR_DEPTH >= CONVEYOR_MAX_DEPTH", () => {
	const saved = { d: process.env.CONVEYOR_DEPTH, m: process.env.CONVEYOR_MAX_DEPTH, x: process.env.CONVEYOR_DISABLE_TOOLS };
	delete process.env.CONVEYOR_DISABLE_TOOLS;
	process.env.CONVEYOR_DEPTH = "1";
	process.env.CONVEYOR_MAX_DEPTH = "1";
	try {
		assert.equal(isNested(), true);
		process.env.CONVEYOR_MAX_DEPTH = "2";
		assert.equal(isNested(), false);
	} finally {
		const restore = (/** @type {string} */ k, /** @type {string|undefined} */ v) => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("CONVEYOR_DEPTH", saved.d);
		restore("CONVEYOR_MAX_DEPTH", saved.m);
		restore("CONVEYOR_DISABLE_TOOLS", saved.x);
	}
});

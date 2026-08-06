/** @module runtime.test — engine + run driver: execute, cache/resume, budget, caps, dry-run, keys. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Runtime as RuntimeImpl, applyRunSettings, fingerprint } from "./runtime.mjs";
import { executeConveyor as executeRawConveyor, extractMeta, stripExports } from "./executor.mjs";
import { getConveyorProgress, loadConveyorResult } from "./runs.mjs";
import { Ledger } from "./ledger.mjs";
import { mkResult, withFakeEnv, tmpDir } from "./fixtures/support.mjs";

class Runtime extends RuntimeImpl {
	constructor(options = {}) {
		super({
			...options,
			limits: {
				...(options.concurrency != null ? { maxConcurrentAgents: options.concurrency } : {}),
				...(options.budget != null ? { maxAiCredits: options.budget } : {}),
				...(options.limits || {}),
			},
		});
	}
}

const executeConveyor = (config) => executeRawConveyor({
	...config,
	limits: {
		...(config.concurrency != null ? { maxConcurrentAgents: config.concurrency } : {}),
		...(config.budget != null ? { maxAiCredits: config.budget } : {}),
		...(config.declaredLimits || {}),
		...(config.limits || {}),
	},
	attemptTimeoutSeconds: config.timeoutSec ?? config.attemptTimeoutSeconds,
});

/**
 * Run a conveyor source end-to-end against the fake backend into a temp run dir.
 * @param {string} source
 * @param {Partial<import("./executor.mjs").ExecuteConfig>} [over]
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ record: any, runDir: string }>}
 */
function runWf(source, over = {}, env = {}) {
	return withFakeEnv(env, async () => {
		const runDir = tmpDir();
		const record = await executeConveyor({ source, runId: "test-run", runDir, budget: 10, ...over, onLine: () => {} });
		return { record, runDir };
	});
}

test("inline conveyor executes without Python and persists all artifacts", async () => {
	const src = `
const a = await agent("one", { label: "a1" });
const b = await agent("two", { label: "a2" });
return a.content + " | " + b.content;`;
	const { record, runDir } = await runWf(src);
	assert.equal(record.status, "complete");
	assert.equal(record.result, "ECHO: one | ECHO: two");
	assert.equal(record.counts.done, 2);
	assert.equal(record.aic, 1.0);
	for (const f of ["manifest.json", "script.js", "run.json", "state.json", "ledger.jsonl"]) {
		assert.ok(existsSync(join(runDir, f)), `expected artifact ${f}`);
	}
	const lean = JSON.parse(readFileSync(join(runDir, "run.json"), "utf8"));
	assert.equal(lean.result, "ECHO: one | ECHO: two");
	assert.equal(lean.status, "complete");
});

test("pipeline runs every item and returns ordered results", async () => {
	const { record } = await runWf(`
const rs = await pipeline([1,2,3], (n) => agent("n=" + n, { label: "f" + n }));
return "count:" + rs.length + " ok:" + rs.filter(r => r.ok).length;`);
	assert.equal(record.result, "count:3 ok:3");
	assert.equal(record.counts.done, 3);
});

test("parallel onFailure:'drop' preserves siblings but marks the run partial", async () => {
	const { record } = await runWf(`
const rs = await parallel([() => { throw new Error("boom"); }, () => 42], { onFailure: "drop" });
return JSON.stringify(rs);`);
	assert.equal(record.status, "partial");
	assert.equal(record.result, "[null,42]");
	assert.equal(record.counts.dropped, 1);
	assert.match(record.error ?? "", /1 dropped item/);
});

test("pipeline defaults onFailure:'raise' — a throwing item aborts the run", async () => {
	const { record } = await runWf(`
await pipeline([1,2], (n) => { if (n === 1) throw new Error("boom"); return n; });
return "unreached";`);
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /boom/);
});

test("a fire-and-forget (un-awaited) agent is still drained + counted before finalize", async () => {
	const { record } = await runWf(`
agent("orphan", { label: "orphan" }); // deliberately NOT awaited
return "done";`);
	assert.equal(record.result, "done");
	assert.equal(record.counts.done, 1, "the orphaned agent was awaited + counted, not left running");
	assert.equal(record.aic, 0.5);
});

test("conveyor source cannot mutate the launch-time budget", async () => {
	const { record } = await runWf(`budget.set(123); await agent("x"); return "ok";`);
	assert.equal(record.status, "error");
	assert.equal(record.budget.total, 10);
	assert.match(record.error ?? "", /budget is not defined|budget\.set/);
});

test("restricted mode still lets a real run write memory (the runtime owns the I/O)", async () => {
	const memPath = join(tmpDir(), "mem.txt");
	await runWf(`context.memory.append("noted"); return "ok";`, { restricted: true, memoryPath: memPath });
	assert.equal(readFileSync(memPath, "utf8"), "noted\n");
});

test("resume reuses completed results (cached, no double-charge)", async () => {
	const src = `export const meta = { name: "test", description: "test conveyor" };
await agent("one", { label: "a1" }); await agent("two", { label: "a2" }); return "done";`;
	await withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const first = await executeConveyor({ source: src, runId: "r", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.counts.done, 2);
		assert.equal(first.aic, 1.0);
		const second = await executeConveyor({ source: src, runId: "r", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(second.counts.cached, 2);
		assert.equal(second.counts.launched, 0);
		assert.equal(second.aic, 1.0);
		const progress = readFileSync(join(runDir, "ledger.jsonl"), "utf8").trim().split("\n").map(JSON.parse).filter((record) => record.type === "progress").map((record) => record.record);
		assert.equal(progress.filter((event) => event.ev === "run_start").length, 2);
		assert.equal(progress.at(-1).ev, "run_end");
	});
});

test("selective resume reruns invalidated branches while retaining sibling checkpoints", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "selective", description: "test conveyor" };
const rows = await pipeline([0,1], (n) => agent("branch-" + n, { label: "b" + n })); return rows.map((row) => row.content).join("|");`;
		const first = await executeConveyor({ source, runId: "selective", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.counts.done, 2);

		const resumed = await executeConveyor({
			source,
			runId: "selective",
			runDir,
			budget: 10,
			resume: true,
			invalidatedBranches: [[0]],
			onLine: () => {},
		});
		assert.equal(resumed.counts.done, 1);
		assert.equal(resumed.counts.cached, 1);
		assert.equal(resumed.counts.launched, 1);

		const replayed = await executeConveyor({ source, runId: "selective", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(replayed.counts.cached, 2);
		assert.equal(replayed.counts.launched, 0);
		const invalidations = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "branches_invalidated");
		assert.deepEqual(invalidations.map((record) => record.branches), [[[0]]]);
	}));

test("sequential groups receive distinct branch paths for selective resume", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "distinct-groups", description: "test conveyor" };
const first = await pipeline([0,1], (n) => agent("first-" + n, { label: "first-" + n }));
const second = await pipeline([0,1], (n) => agent("second-" + n, { label: "second-" + n }));
return [...first, ...second].map((row) => row.content).join("|");`;
		const first = await executeConveyor({ source, runId: "distinct-groups", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.counts.done, 4);
		const started = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "agent_started");
		assert.deepEqual(started.map((record) => record.branch), [[0], [1], [2], [3]]);

		const resumed = await executeConveyor({
			source,
			runId: "distinct-groups",
			runDir,
			budget: 10,
			resume: true,
			invalidatedBranches: [[0]],
			onLine: () => {},
		});
		assert.equal(resumed.counts.done, 1);
		assert.equal(resumed.counts.cached, 3);
		assert.equal(resumed.counts.launched, 1);
	}));

test("parallel() keeps sibling group branch paths stable when items finish out of order", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "stable-groups", description: "test conveyor" };
await parallel([
	() => agent("gate", { label: "gate" }).then(() => pipeline([1,2], (n) => agent("A" + n, { label: "A" + n }))),
	() => pipeline([1,2], (n) => agent("B" + n, { label: "B" + n })),
]);
return "done";`;
		const first = await executeConveyor({ source, runId: "stable-groups", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.counts.done, 5);

		const resumed = await executeConveyor({ source, runId: "stable-groups", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.counts.cached, 5);
		assert.equal(resumed.counts.launched, 0);
	}));

test("concurrently created sibling groups keep distinct branch paths", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "sibling-groups", description: "test conveyor" };
const first = pipeline([1,2], (n) => agent("A" + n));
const second = pipeline([1,2], (n) => agent("B" + n));
await Promise.all([first, second]);
return "done";`;
		const first = await executeConveyor({ source, runId: "audit (v2)", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.status, "complete");
		assert.equal(first.counts.done, 4);

		const resumed = await executeConveyor({ source, runId: "audit (v2)", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.counts.cached, 4);
		assert.equal(resumed.counts.launched, 0);
	}));

test("groups created from one shared helper retain JavaScript Promise.all compatibility", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "same-call-site", description: "test conveyor" };
const helper = (tag) => pipeline([1,2], (n) => agent(tag + n));
await Promise.all(["A","B","C"].map(helper));
return "done";`;
		const first = await executeConveyor({ source, runId: "same-call-site", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.status, "complete");
		assert.equal(first.counts.done, 6);

		const resumed = await executeConveyor({ source, runId: "same-call-site", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.counts.cached, 6);
		assert.equal(resumed.counts.launched, 0);
	}));

test("moving a group in the harness keeps its branches and its cache", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const firstSource = `export const meta = { name: "source-motion", description: "test conveyor" };
const rows = await pipeline([1,2], (n) => agent("item-" + n));
return rows.map((row) => row.content).join("|");`;
		const first = await executeConveyor({ source: firstSource, runId: "source-motion", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.counts.done, 2);

		// Group identity is the text of the calling line, not its number, so inserting a comment
		// above a group must not move it onto fresh branches.
		const movedSource = `export const meta = { name: "source-motion", description: "test conveyor" };
// A comment shifts the pipeline call down one line.
const rows = await pipeline([1,2], (n) => agent("item-" + n));
return rows.map((row) => row.content).join("|");`;
		const resumed = await executeConveyor({ source: movedSource, runId: "source-motion", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.counts.cached, 2);
		assert.equal(resumed.counts.launched, 0);
		assert.equal(resumed.result, first.result);
	}));

test("reordering two same-shaped groups never hands one the other's branches", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const hostPath = join(tmpDir(), "counter.host.mjs");
		writeFileSync(hostPath, `let n = 0;\nexport async function next() { return ++n; }\nnext.mutates = true;\n`);
		const first = await executeConveyor({
			source: `export const meta = { name: "reorder", description: "test conveyor" };
const a = await pipeline([1], () => host.next()); // group A
const b = await pipeline([1], () => host.next()); // group B
return JSON.stringify({ a: a[0], b: b[0] });`,
			runId: "reorder",
			runDir,
			hostPath,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(first.result, JSON.stringify({ a: 1, b: 2 }));

		const resumed = await executeConveyor({
			source: `export const meta = { name: "reorder", description: "test conveyor" };
const b = await pipeline([1], () => host.next()); // group B
const a = await pipeline([1], () => host.next()); // group A
return JSON.stringify({ a: a[0], b: b[0] });`,
			runId: "reorder",
			runDir,
			hostPath,
			budget: 10,
			resume: true,
			onLine: () => {},
		});
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.result, first.result);
	}));

test("resizing a group leaves its sibling's branches alone", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const hostPath = join(tmpDir(), "counter.host.mjs");
		writeFileSync(hostPath, `let n = 0;\nexport async function next() { return ++n; }\nnext.mutates = true;\n`);
		const build = (/** @type {string} */ firstItems) =>
			`export const meta = { name: "resize", description: "test conveyor" };
const a = await pipeline(${firstItems}, () => host.next()); // group A
const b = await pipeline([1], () => host.next()); // group B
return JSON.stringify({ a: a[0], b: b[0] });`;

		const first = await executeConveyor({ source: build("[1]"), runId: "resize", runDir, hostPath, budget: 10, onLine: () => {} });
		const bBefore = JSON.parse(first.result).b;

		const resumed = await executeConveyor({ source: build("[1,2]"), runId: "resize", runDir, hostPath, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(JSON.parse(resumed.result).b, bBefore, "group B must keep its own cached effect value");
	}));

test("async-gated sibling groups keep their own cached host effects across resume", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const hostPath = join(tmpDir(), "counter.host.mjs");
		writeFileSync(hostPath, `let n = 0;\nexport async function next() { return ++n; }\nnext.mutates = true;\n`);
		const source = `export const meta = { name: "gated-siblings", description: "test conveyor" };
const slow = agent("gate", { label: "gate" }).then(() => pipeline([1], () => host.next()));
const fast = Promise.resolve().then(() => pipeline([1], () => host.next()));
const [a, b] = await Promise.all([slow, fast]);
return JSON.stringify({ slow: a[0], fast: b[0] });`;

		const first = await executeConveyor({ source, runId: "gated-siblings", runDir, hostPath, budget: 10, onLine: () => {} });
		assert.equal(first.status, "complete");

		// On resume the gate agent is cached, so the two pipelines start in the opposite order.
		// Durable call-site branch blocks must still give each sibling its own effect result.
		const resumed = await executeConveyor({ source, runId: "gated-siblings", runDir, hostPath, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.result, first.result);
		assert.equal(resumed.counts.launched, 0);
	}));

test("resume preserves prior terminal artifacts until replacement is durable", async () => {
	const runs = tmpDir();
	await withFakeEnv({ CONVEYOR_RUNS_DIR: runs }, async () => {
		const runDir = join(runs, "r");
		await executeConveyor({
			source: `export const meta = { name: "test", description: "test conveyor" };
return (await agent("old")).content;`,
			runId: "r",
			runDir,
			budget: 10,
			onLine: () => {},
		});

		process.env.CONVEYOR_FAKE_MODE = "hang";
		const ac = new AbortController();
		const resumed = executeConveyor({
			source: `export const meta = { name: "test", description: "test conveyor" };
return (await agent("new")).content;`,
			runId: "r",
			runDir,
			budget: 10,
			resume: true,
			signal: ac.signal,
			onLine: () => {},
		});

		for (let i = 0; i < 50 && !existsSync(join(runDir, "state.json")); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.equal(existsSync(join(runDir, "run.json")), true);
		assert.equal(existsSync(join(runDir, "run.json")), true);
		assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).status, "running");
		assert.equal(loadConveyorResult("r").resultAvailable, false);

		ac.abort();
		assert.equal((await resumed).status, "timeout");
	});
});

test("soft budget preserves partial output but cannot report complete", async () => {
	const { record } = await runWf(`
const out = [];
for (const n of [1,2,3]) out.push(await agent("n" + n, { label: "b" + n }));
return "skipped:" + out.filter(r => r.skipped).length;`, { budget: 0.6 });
	assert.equal(record.status, "partial");
	assert.equal(record.budget.hit, true);
	assert.equal(record.counts.skipped, 1);
	assert.equal(record.counts.done, 2);
	assert.match(record.error ?? "", /skipped agent.*budget boundary/s);
});

test("soft-budget skips inside pipeline preserve the harness result", async () => {
	const { record } = await runWf(
		`const rows = await pipeline([1,2,3], (n) => agent("x" + n), { concurrency: 1 }); return JSON.stringify(rows.map((row) => row.skipped ? "skipped" : "done"));`,
		{ budget: 0.6 },
	);
	assert.equal(record.status, "partial");
	assert.match(record.result, /skipped/);
	assert.equal(record.counts.skipped, 1);
});

test("budget boundary requests a host-approved increase and continues queued agents", async () => {
	let approvals = 0;
	const backend = { kind: "test", run: async () => mkResult({ aic: 0.5, nanoAiu: 500_000_000 }) };
	const rt = new Runtime({
		parentPermissionMode: "on",
		budget: 0.4,
		agentBackend: backend,
		requestLimitApproval: () => {
			approvals++;
			return true;
		},
	});
	const context = /** @type {any} */ (rt.buildApi(null)).context;
	const first = await rt.agent("one");
	const second = await rt.agent("two");
	assert.equal(first.ok, true);
	assert.equal(second.ok, true);
	assert.equal(approvals, 1);
	assert.ok((rt.budget.total ?? 0) > 1);
	assert.equal(rt.budget.spent(), 1);
	assert.equal(context.limits.approved.maxAiCredits, rt.budget.total);
});

test("each exhausted ceiling asks again; a refusal stops the asking", async () => {
	const backend = { kind: "test", run: async () => mkResult({ aic: 0.5, nanoAiu: 500_000_000 }) };
	/** @type {number[]} */
	const asked = [];
	const rt = new Runtime({
		parentPermissionMode: "on",
		budget: 0.4,
		agentBackend: backend,
		// Approve the first two boundaries, refuse the third.
		requestLimitApproval: ({ current }) => {
			asked.push(current.maxAiCredits);
			return asked.length <= 2;
		},
	});
	const outcomes = [];
	for (let i = 0; i < 8; i++) outcomes.push(await rt.agent("a" + i));

	assert.equal(asked.length, 3, "asked once per exhausted ceiling, then stopped at the refusal");
	assert.ok(asked[1] > asked[0], "each request starts from the previously approved ceiling");
	assert.ok(outcomes.filter((r) => !r.skipped).length > 3, "approved headroom let more agents run");
	assert.ok(outcomes.at(-1)?.skipped, "work after the refusal is skipped, not re-prompted");

	// A refusal latches: further boundaries never ask again.
	const before = asked.length;
	await rt.agent("after-refusal");
	assert.equal(asked.length, before);
});

test("declined budget increase skips queued agents and does not ask twice", async () => {
	let approvals = 0;
	const rt = new Runtime({
		parentPermissionMode: "on",
		budget: 0.4,
		agentBackend: { kind: "test", run: async () => mkResult({ aic: 0.5, nanoAiu: 500_000_000 }) },
		requestLimitApproval: () => {
			approvals++;
			return false;
		},
	});

	await rt.agent("one");
	const second = await rt.agent("two");
	const third = await rt.agent("three");
	assert.equal(second.skipped, true);
	assert.equal(third.skipped, true);
	assert.equal(approvals, 1);
});

test("approved budget increment remains valid while in-flight agents continue spending", async () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	let approvals = 0;
	const rt = new Runtime({
		parentPermissionMode: "on",
		budget: 100,
		concurrency: 8,
		ledger,
		agentBackend: {
			kind: "test",
			run: async () => {
				await new Promise((resolve) => setTimeout(resolve, 50));
				return mkResult({ aic: 20, nanoAiu: 20_000_000_000 });
			},
		},
		requestLimitApproval: async () => {
			approvals++;
			await new Promise((resolve) => setTimeout(resolve, 200));
			return true;
		},
	});
	const results = await rt.parallel(Array.from({ length: 16 }, (_, index) => () => rt.agent(`agent-${index}`)), { onFailure: "keep" });
	assert.equal(approvals, 1);
	assert.ok(results.some((result) => result.ok));
	const controls = readFileSync(join(dir, "ledger.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((record) => record.type === "limits_approved");
	assert.equal(controls.length, 1);
	assert.ok(controls[0].limits.maxAiCredits > 1);
});

test("a resumed run restores the approved ceiling and may ask for more", async () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.recordUsage("prior", mkResult({ aic: 4, nanoAiu: 4_000_000_000 }));
	ledger.approve({ maxAiCredits: 1 }, { maxAiCredits: 4 });
	let approvals = 0;
	const rt = new Runtime({
		budget: 1,
		ledger: new Ledger(dir),
		agentBackend: { kind: "test", run: async () => mkResult() },
		requestLimitApproval: () => (approvals++, true),
	});
	assert.equal(rt.budget.total, 4, "the newest approved ceiling is restored, not the launch budget");
	const result = await rt.agent("past-the-restored-ceiling");
	assert.equal(result.skipped, false, "prior approval is not a reason to stop working");
	assert.equal(approvals, 1, "the restored ceiling was already spent, so it asks once more");
});

test("a resumed run never re-asks after the host declined", async () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.recordUsage("prior", mkResult({ aic: 4, nanoAiu: 4_000_000_000 }));
	ledger.approve({ maxAiCredits: 1 }, { maxAiCredits: 4 });
	ledger.declineLimits({ maxAiCredits: 8 });
	let approvals = 0;
	const rt = new Runtime({
		budget: 1,
		ledger: new Ledger(dir),
		agentBackend: { kind: "test", run: async () => mkResult() },
		requestLimitApproval: () => (approvals++, true),
	});
	const result = await rt.agent("after-decline");
	assert.equal(result.skipped, true);
	assert.equal(approvals, 0, "a refusal latches across resume");
});

test("strict budget aborts the run once the cap is observed", async () => {
	const { record } = await runWf(`
for (const n of [1,2,3]) await agent("n" + n, { label: "s" + n });
return "unreached";`, { budget: 0.6, strictBudget: true });
	assert.equal(record.status, "failed");
	assert.notEqual(record.result, "unreached"); // The limit error stopped the harness.
	assert.equal(record.budget.hit, true);
	assert.match(record.error ?? "", /maxAiCredits/);
});

test("failed agents preserve rich outcomes even when usage is unavailable", async () => {
	const { record } = await runWf(`const r = await agent("x"); return "handled:" + r.ok;`, {}, { CONVEYOR_FAKE_MODE: "fail" });
	assert.equal(record.status, "partial");
	assert.equal(record.result, "handled:false");
	assert.equal(record.counts.failed, 1);
});

test("pipeline over the cap is a fatal error", async () => {
	const { record } = await runWf(`await pipeline([1,2,3], (n) => agent("x" + n)); return "nope";`, {}, { CONVEYOR_MAX_GROUP_ITEMS: "2" });
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /pipeline item cap exceeded/);
});

test("agent cap errors always propagate through onFailure-tolerant groups", async () => {
	const { record } = await runWf(
		`const kept = await pipeline(["a","b","c","d"], (p) => agent(p), { onFailure: "keep" }); return "kept " + kept.length;`,
		{},
		{ CONVEYOR_MAX_AGENTS: "2" },
	);
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /agent cap exceeded/);
});

test("dryRun spends no AIC, launches no subagents, returns a plan, writes no run.json", async () => {
	const { record, runDir } = await runWf(`await pipeline([1,2,3], (n) => agent("x" + n)); return "ignored";`, { dryRun: true });
	assert.equal(record.aic, 0);
	assert.match(record.result, /dry-run plan: 3 agent/);
	assert.ok(!existsSync(join(runDir, "run.json")));
});

test("dryRun reports dropped planning branches as partial", async () => {
	const { record } = await runWf(
		`const rows = await parallel([() => { throw new Error("preview branch"); }, () => 1], { onFailure: "drop" }); return JSON.stringify(rows);`,
		{ dryRun: true },
	);
	assert.equal(record.status, "partial");
	assert.equal(record.counts.dropped, 1);
	assert.match(record.error ?? "", /preview incomplete/);
});

test("a harness crash persists an error status (does not reject)", async () => {
	const { record, runDir } = await runWf(`throw new Error("boom");`);
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /boom/);
	assert.ok(existsSync(join(runDir, "script.js")), "failed run still leaves script.js");
	assert.ok(existsSync(join(runDir, "run.json")));
});

test("restricted mode rejects tool-escalation options", async () => {
	const { record } = await runWf(`return (await agent("x", { profile: "research" })).content;`, { restricted: true });
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /restricted mode forbids agent profile/);
});

test("aborted runtime skips new agents without spawning", async () => {
	const ac = new AbortController();
	ac.abort();
	const rt = new Runtime({ abortController: ac, budget: 10 });
	const res = await rt.agent("x", { label: "aborted" });
	assert.equal(res.skipped, true);
	assert.equal(res.ok, false);
	assert.match(res.error ?? "", /run aborting/);
	assert.equal(rt.stats().counts.skipped, 1);
});

test("followUp requires a resumable agent result", async () => {
	const rt = new Runtime({ budget: null });
	await assert.rejects(() => rt.followUp(/** @type {any} */ ({ sessionId: null }), "next"), /no sessionId/);
});

test("Runtime.parallel / pipeline work over the fake backend", () =>
	withFakeEnv({}, async () => {
		const rt = new Runtime({ budget: null });
		const par = await rt.parallel([() => rt.agent("a"), () => rt.agent("b")]);
		assert.equal(par.length, 2);
		assert.ok(par.every((r) => r.ok));

		const piped = await rt.pipeline([1, 2], (n) => rt.agent("n=" + n), (prev) => prev.content.toUpperCase());
		assert.deepEqual(piped, ["ECHO: N=1", "ECHO: N=2"]);
	}));

test("cache keys: identical prompts in different pipeline branches do not collide", () =>
	withFakeEnv({}, async () => {
		const dir = tmpDir();
		// Two branches each run the SAME prompt; both must execute and be cached under distinct keys.
		const rec = await executeConveyor({
			source: `export const meta = { name: "test", description: "test conveyor" };
await pipeline([1,2], () => agent("same prompt")); return "ok";`,
			runId: "k",
			runDir: dir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.counts.done, 2);
		const keys = readFileSync(join(dir, "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "result")
			.map((record) => record.key);
		assert.equal(new Set(keys).size, 2, "two distinct branch-scoped keys");
	}));

test("cache keys: auto agent keys keep the journal-compatible tuple shape", () =>
	withFakeEnv({}, async () => {
		const dir = tmpDir();
		await executeConveyor({
			source: `export const meta = { name: "test", description: "test conveyor" };
await pipeline([1,2], () => agent("same prompt")); return "ok";`,
			runId: "k",
			runDir: dir,
			budget: 10,
			onLine: () => {},
		});
		const keys = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((rec) => rec.type === "result").map((rec) => JSON.parse(rec.key)).sort((a, b) => a[1][0] - b[1][0]);
		assert.deepEqual(keys.map((key) => [key[0], key[1], key[2], key[4]]), [["a", [0], 0, 0], ["a", [1], 0, 0]]);
		assert.match(keys[0][3], /^[0-9a-f]{64}$/);
		assert.equal(keys[0][3], keys[1][3]);
	}));

test("cache keys: an explicit key can't collide with a branch-scoped key (structured, not concatenated)", async () => {
	// Explicit top-level keys and branch-scoped keys must stay distinct.
	const src = `
const top = await agent("top", { key: "b0-foo", label: "top" });
const inner = await pipeline([0], () => agent("inner", { key: "foo", label: "inner" }));
return top.content + "|" + inner[0].content;`;
	const { record, runDir } = await runWf(src);
	assert.equal(record.result, "ECHO: top|ECHO: inner"); // no false cache hit swapping inner for top
	assert.equal(record.counts.done, 2);
	const keys = readFileSync(join(runDir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((rec) => rec.type === "result").map((rec) => rec.key);
	assert.equal(new Set(keys).size, 2, "distinct structured keys");
});

test("cache keys: explicit agent keys keep the journal-compatible tuple shape", async () => {
	const src = `
await agent("top", { key: "b0-foo", label: "top" });
await pipeline([0], () => agent("inner", { key: "foo", label: "inner" }));
return "ok";`;
	const { runDir } = await runWf(src);
	const keys = readFileSync(join(runDir, "ledger.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((rec) => rec.type === "result").map((rec) => rec.key);
	const parsed = keys.map((key) => JSON.parse(key));
	assert.deepEqual(parsed.map((key) => key.slice(0, 4)), [["e", [], 0, "b0-foo"], ["e", [0], 0, "foo"]]);
	assert.ok(parsed.every((key) => /^[0-9a-f]{64}$/.test(key[4])));
});

test("extractMeta parses a literal meta block; ignores non-literal", () => {
	const meta = extractMeta(`export const meta = { name: 'audit', description: 'x', phases: [{ title: 'Scan' }] }\nawait agent('go')`);
	assert.equal(meta.name, "audit");
	assert.equal(meta.description, "x");
	assert.equal(meta.phases?.length, 1);
	assert.deepEqual(extractMeta(`const meta = { name: someVar }`), {});
	assert.deepEqual(extractMeta(`await agent('no meta here')`), {});
});

test("stripExports removes export keywords for VM script text", () => {
	assert.equal(stripExports("export const meta = {}").trim(), "const meta = {}");
	assert.equal(stripExports("export default foo").trim(), "foo");
	assert.equal(stripExports("const x = 1").trim(), "const x = 1");
});

test("pattern helpers are wired into the harness API (structured end-to-end)", () =>
	withFakeEnv({ CONVEYOR_FAKE_CONTENT: '{"n":5}' }, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `export const meta = { name: "test", description: "test conveyor" };
const s = await agent("give a number", { schema: { type:"object", properties:{ n:{ type:"integer" } }, required:["n"] } }); return s.ok ? ("n=" + s.value.n) : ("fail:" + s.error);`,
			runId: "p",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.result, "n=5");
	}));

test("verify() is reachable from a harness and returns a verdict", () =>
	withFakeEnv({ CONVEYOR_FAKE_CONTENT: '{"passed":true,"score":1,"reasons":"ok"}' }, async () => {
		const runDir = tmpDir();
		const rec = await executeConveyor({
			source: `export const meta = { name: "test", description: "test conveyor" };
const v = await verify("work", "rubric"); return v.passed ? "PASS" : "FAIL";`,
			runId: "v",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.result, "PASS");
	}));

test("budget accessors expose immutable total/spent/remaining/hit", () =>
	withFakeEnv({}, async () => {
		const rt = new Runtime({ budget: 0.4 });
		assert.equal(rt.budget.total, 0.4);
		assert.equal(rt.budget.spent(), 0);
		assert.equal(rt.budget.remaining(), 0.4);
		assert.equal(rt.budget.hit, false);
		await rt.agent("x"); // fake backend spends 0.5 AIC -> over the cap
		assert.equal(rt.budget.hit, true);
		assert.equal(rt.budget.remaining(), 0);
		assert.equal("set" in rt.budget, false);
		assert.equal(rt.budget.total, 0.4);
	}));

test("run settings fill agent model/effort/context only when unset (per-agent wins)", () => {
	const defaults = { model: "m1", effort: "e1", context: "c1" };
	const inherited = applyRunSettings({ prompt: "x" }, defaults);
	assert.equal(inherited.model, "m1");
	assert.equal(inherited.effort, "e1");
	assert.equal(inherited.context, "c1");
	const overridden = applyRunSettings({ prompt: "x", model: "m2" }, defaults);
	assert.equal(overridden.model, "m2");
	assert.equal(overridden.effort, "e1"); // still inherited
	assert.throws(() => applyRunSettings({ prompt: "x", model: "auto" }, defaults), /cannot be combined with reasoning effort/);
});

test("explicit per-agent phase is recorded without a lexical phase", () =>
	withFakeEnv({}, async () => {
		const events = /** @type {any[]} */ ([]);
		const rt = new Runtime({ budget: 10, progress: (e) => events.push(e) });
		await rt.agent("x", { phase: "explicit", label: "a" });
		await rt.agent("y", { label: "b" });
		const ends = events.filter((e) => e.ev === "end");
		assert.equal(ends[0].phase, "explicit");
		assert.equal(ends[1].phase, null);
	}));

test("cache keys: same spec shares a fingerprint; model changes it; label is excluded", () => {
	const a = fingerprint(applyRunSettings({ prompt: "p", label: "L1" }));
	const b = fingerprint(applyRunSettings({ prompt: "p", label: "L2" })); // label not in the key
	const c = fingerprint(applyRunSettings({ prompt: "p", model: "m2" })); // model is in the key
	assert.equal(a, b);
	assert.equal(a, "e69c2422882934bc48173746fdd5ef2e93644f3305a3233dcebaedc23109c936");
	assert.notEqual(a, c);
});

test("cache keys canonicalize set-like permission fields", () => {
	const a = fingerprint(applyRunSettings({ prompt: "p", deny: ["write", "shell", "write"], denyUrl: ["b", "a"] }));
	const b = fingerprint(applyRunSettings({ prompt: "p", deny: ["shell", "write"], denyUrl: ["a", "b"] }));
	assert.equal(a, b);
});

test("agent options cannot expand MCP, argv, directories, or cwd outside approved roots", async () => {
	const root = tmpDir();
	const outside = tmpDir();
	const rt = new Runtime({ cwd: root, allowedDirs: [root] });
	await assert.rejects(rt.agent("x", { cwd: outside }), /outside the parent-approved directories/);
	for (const opts of [
		{ extraArgs: ["--allow-all"] },
		{ mcp: '{"servers":{}}' },
		{ addDir: [outside] },
		{ allowAllTools: true },
	]) {
		await assert.rejects(rt.agent("x", opts), /removed agent option|arbitrary MCP configuration/);
	}
});

test("the harness API exposes only the simplified orchestration surface", () => {
	const rt = new Runtime({});
	const api = rt.buildApi({ target: "x" });
	assert.deepEqual(Object.keys(api).sort(), ["agent", "context", "host", "log", "parallel", "phase", "pipeline", "step", "verify", "workspace"]);
	assert.deepEqual(Object.keys(/** @type {any} */ (api).context).sort(), ["args", "budget", "capabilities", "dryRun", "limits", "memory", "runId", "signal"]);
	assert.equal(typeof /** @type {any} */ (api).agent.followUp, "function");
	assert.equal("fanOut" in api, false);
	assert.equal("patterns" in api, false);
	assert.equal("structured" in api, false);
	assert.equal("budget" in api, false);
});

test("API V2 lexical phase returns callback values and scopes concurrent agents", () =>
	withFakeEnv({}, async () => {
		const events = /** @type {any[]} */ ([]);
		const rt = new Runtime({ budget: null, progress: (event) => events.push(event) });
		const api = /** @type {any} */ (rt.buildApi(null));
		const value = await api.phase("verify", async () => {
			await Promise.all([api.agent("a"), api.agent("b")]);
			return 42;
		});
		assert.equal(value, 42);
		assert.deepEqual(events.filter((event) => event.ev === "end").map((event) => event.phase), ["verify", "verify"]);
		assert.throws(() => api.phase("bad"), /requires a callback/);
	}));

test("real phase-filtered progress includes agent starts and completions", () =>
	(() => {
		const runs = tmpDir();
		return withFakeEnv({ CONVEYOR_RUNS_DIR: runs }, async () => {
		const runDir = join(runs, "phase-run");
		const source = `export const meta = { name: "phase-progress", phases: ["review"] };
await phase("review", () => agent("a")); return "done";`;
		await executeConveyor({ source, runId: "phase-run", runDir, budget: 10, onLine: () => {} });
		const page = JSON.parse(getConveyorProgress({ runId: "phase-run", phaseId: "phase:0" }));
		assert.ok(page.records.some((record) => record.ev === "start"));
		assert.ok(page.records.some((record) => record.ev === "end"));
		});
	})());

test("API V2 agent schema returns a validated value on AgentOutcome", () =>
	withFakeEnv({ CONVEYOR_FAKE_CONTENT: '{"passed":true}' }, async () => {
		const rt = new Runtime({ budget: 10 });
		const api = /** @type {any} */ (rt.buildApi(null));
		const result = await api.agent("return verdict", {
			schema: { type: "object", properties: { passed: { type: "boolean" } }, required: ["passed"], additionalProperties: false },
		});
		assert.equal(result.kind, "agent");
		assert.equal(result.ok, true);
		assert.deepEqual(result.value, { passed: true });
		assert.equal(typeof result.content, "string");
	}));

test("dry-run structured output reserves retry headroom in the approved agent ceiling", () =>
	withFakeEnv({}, async () => {
		const { record } = await runWf(
			`await agent("schema", { schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } }); return "done";`,
			{ dryRun: true },
		);
		assert.equal(record.counts.agents, 1);
		assert.ok(record.plannedMaxAgents >= 3);
	}));

test("API V2 group onFailure handles failed outcomes and callback exceptions uniformly", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "fail" }, async () => {
		const rt = new Runtime({ budget: null });
		const api = /** @type {any} */ (rt.buildApi(null));
		const kept = await api.parallel([() => api.agent("x"), () => {
			throw new Error("callback boom");
		}], { onFailure: "keep" });
		assert.equal(kept[0].ok, false);
		assert.equal(kept[1].ok, false);
		assert.match(kept[1].error, /callback boom/);
		await assert.rejects(() => api.parallel([() => api.agent("x")]), /simulated failure/);
	}));

test("accounting failures propagate through tolerant groups", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "nousage" }, async () => {
		const rt = new Runtime({ budget: 10 });
		const api = /** @type {any} */ (rt.buildApi(null));
		await assert.rejects(
			() => api.parallel([() => api.agent("x")], { onFailure: "keep" }),
			/accounting was unavailable/,
		);
	}));

test("concurrent identical durable steps share one producer", async () => {
	const ledger = new Ledger(tmpDir());
	const api = /** @type {any} */ (new Runtime({ ledger }).buildApi(null));
	let calls = 0;
	const producer = async () => {
		calls++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { value: calls };
	};
	const values = await Promise.all([
		api.step("same", producer, { input: { x: 1 } }),
		api.step("same", producer, { input: { x: 1 } }),
	]);
	assert.equal(calls, 1);
	assert.deepEqual(values, [{ value: 1 }, { value: 1 }]);
});

test("V2 mcp:'inherit' honors the launch default and restricted mode permits mcp:'off'", async () => {
	/** @type {import("./agent.mjs").AgentSpec[]} */
	const specs = [];
	const backend = {
		kind: "capture",
		async run(/** @type {import("./agent.mjs").AgentSpec} */ spec) {
			specs.push(spec);
			return mkResult({ content: "ok", value: "ok" });
		},
	};
	const rt = new Runtime({ parentPermissionMode: "on", defaultEnableMcp: false, agentBackend: backend });
	await rt.agent("inherit");
	await rt.agent("research", { profile: "research" });
	assert.deepEqual(specs.map((spec) => spec.enableMcp), [false, false]);
	const restricted = new Runtime({ restricted: true, parentPermissionMode: "on", agentBackend: backend });
	await assert.doesNotReject(() => restricted.agent("off", { profile: "read-only", mcp: "off" }));
});

test("V2 profiles inherit parent on/auto and autopilot posture while preserving denials", async () => {
	const root = tmpDir();
	/** @type {import("./agent.mjs").AgentSpec[]} */
	const specs = [];
	const backend = { kind: "capture", run: async (/** @type {import("./agent.mjs").AgentSpec} */ spec) => (specs.push(spec), mkResult()) };
	const automatic = new Runtime({
		parentPermissionMode: "auto",
		parentSessionMode: "autopilot",
		cwd: root,
		allowedDirs: [root],
		agentBackend: backend,
	});
	await automatic.agent("research", { profile: "research" });
	assert.equal(specs[0].permissionMode, "auto");
	assert.equal(specs[0].allowAllTools, false);
	assert.equal(specs[0].allowAllUrls, false);
	assert.equal(specs[0].autopilot, true);
	assert.deepEqual(specs[0].deny, ["shell", "write"]);
	assert.deepEqual(specs[0].addDir, [root]);

	const allowed = new Runtime({ parentPermissionMode: "on", cwd: root, allowedDirs: [root], agentBackend: backend });
	await allowed.agent("inherit");
	assert.equal(specs[1].permissionMode, "on");
	assert.equal(specs[1].allowAllTools, true);
	assert.equal(specs[1].allowAllUrls, true);

	const coarse = new Runtime({ parentPermissionMode: "off", cwd: root, agentBackend: backend });
	await assert.rejects(() => coarse.agent("read", { profile: "read-only" }), /requires parent allow-all 'on' or 'auto'/);
});

test("dry-run can preview tool-using profiles without parent allow-all", async () => {
	const rt = new Runtime({ dryRun: true, parentPermissionMode: "off" });
	const result = await /** @type {any} */ (rt.buildApi(null)).agent("preview", { profile: "read-only" });
	assert.equal(result.ok, true);
	assert.match(result.content, /dry-run/);
});

test("V2 log emits structured fields and permission paths narrow cwd", async () => {
	/** @type {{ message: string, level: string|undefined }[]} */
	const lines = [];
	const root = tmpDir();
	const child = join(root, "child");
	mkdirSync(child);
	/** @type {import("./agent.mjs").AgentSpec[]} */
	const specs = [];
	const rt = new Runtime({
		parentPermissionMode: "on",
		cwd: root,
		allowedDirs: [root],
		log: (message, level) => lines.push({ message, level }),
		agentBackend: { kind: "capture", run: async (/** @type {import("./agent.mjs").AgentSpec} */ spec) => (specs.push(spec), mkResult()) },
	});
	const api = /** @type {any} */ (rt.buildApi(null));
	api.log("scan", { level: "warning", fields: { files: 2 } });
	await api.agent("x", { profile: "read-only", permissions: { paths: ["child"] } });
	assert.deepEqual(lines, [{ message: 'scan {"files":2}', level: "warning" }]);
	assert.equal(specs[0].cwd, child);
	assert.deepEqual(specs[0].addDir, [child]);
});

test("V2 scalar permission and tool restrictions remain whole narrowing rules", async () => {
	const cwd = tmpDir();
	/** @type {import("./agent.mjs").AgentSpec[]} */
	const specs = [];
	const rt = new Runtime({
		parentPermissionMode: "on",
		cwd,
		allowedDirs: [cwd],
		agentBackend: { kind: "capture", run: async (/** @type {import("./agent.mjs").AgentSpec} */ spec) => (specs.push(spec), mkResult()) },
	});
	const api = /** @type {any} */ (rt.buildApi(null));
	await api.agent("x", {
		profile: "inherit",
		permissions: { deny: "shell", denyUrls: "evil.example" },
		tools: { available: "view", excluded: "bash" },
	});
	assert.deepEqual(specs[0].deny, ["shell"]);
	assert.deepEqual(specs[0].denyUrl, ["evil.example"]);
	assert.deepEqual(specs[0].availableTools, ["view"]);
	assert.deepEqual(specs[0].excludedTools, ["bash", "mcp:*"]);

	await api.agent("locked", { profile: "none", tools: { excluded: "bash" } });
	assert.deepEqual(specs[1].excludedTools, ["builtin:*", "mcp:*", "custom:*", "bash"]);

	await api.agent("wildcards", { profile: "inherit", tools: { available: "*", excluded: "*" } });
	assert.deepEqual(specs[2].availableTools, ["builtin:*", "mcp:*", "custom:*"]);
	assert.deepEqual(specs[2].excludedTools, ["builtin:*", "mcp:*", "custom:*"]);
});

test("V2 memory reads replay their original value after external state changes", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const memoryPath = join(tmpDir(), "memory.txt");
		writeFileSync(memoryPath, "first");
		const source = `export const meta = { name: "memory-replay", description: "test conveyor" };
return context.memory.read();`;
		const first = await executeConveyor({ source, runId: "memory", runDir, memoryPath, budget: 10, onLine: () => {} });
		assert.equal(first.result, "first");
		writeFileSync(memoryPath, "second");
		const resumed = await executeConveyor({ source, runId: "memory", runDir, memoryPath, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.result, "first");
	}));

test("successful unknown-usage agents fail closed once and replay from checkpoint", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "nousage" }, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "unknown-usage", description: "test conveyor" };
return (await agent("unknown")).content;`;
		const first = await executeConveyor({ source, runId: "unknown", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.status, "error");
		assert.equal(first.failure.type, "durable_failure");
		const resumed = await executeConveyor({ source, runId: "unknown", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.counts.unknownUsage, 1);
		const admissions = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "agent_admitted");
		assert.equal(admissions.length, 1);
	}));

test("historical unknown usage does not make a successful resume partial", () =>
	withFakeEnv({ CONVEYOR_FAKE_MODE: "fail" }, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "unknown-usage-retry", description: "test conveyor" };
return (await agent("retry")).content;`;
		const first = await executeConveyor({ source, runId: "unknown-retry", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.status, "partial");
		assert.equal(first.counts.unknownUsage, 1);

		process.env.CONVEYOR_FAKE_MODE = "ok";
		const resumed = await executeConveyor({ source, runId: "unknown-retry", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(resumed.status, "complete");
		assert.equal(resumed.counts.done, 1);
		assert.equal(resumed.counts.unknownUsage, 1);
	}));

test("mutating host effects advance the branch epoch for later agent cache keys", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const ledger = new Ledger(runDir);
		const rt = new Runtime({ parentPermissionMode: "on", ledger, cwd: tmpDir(), budget: 10 });
		const mutate = async () => ({ ok: true });
		mutate.mutates = true;
		rt.setHost({ fns: new Map([["mutate", mutate]]), mutates: new Set(["mutate"]), names: ["mutate"], hash: "host" });
		const api = /** @type {any} */ (rt.buildApi(null));
		await api.agent("same");
		await api.host.mutate({});
		await api.agent("same");
		const keys = readFileSync(join(runDir, "ledger.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((record) => record.type === "result" && String(record.key).startsWith('["a"'))
			.map((record) => JSON.parse(record.key));
		assert.deepEqual(keys.map((key) => key[2]), [0, 1]);
	}));

test("cumulative spawned-agent limits ignore cache hits and stop invalidated work", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const source = `export const meta = { name: "total", limits: { maxTotalAgents: 1 } };\nreturn (await agent("one")).content;`;
		const first = await executeConveyor({ source, runId: "total", runDir, budget: 10, declaredLimits: { maxTotalAgents: 1, maxAiCredits: 10 }, onLine: () => {} });
		assert.equal(first.status, "complete");
		const cached = await executeConveyor({ source, runId: "total", runDir, budget: 10, declaredLimits: { maxTotalAgents: 1, maxAiCredits: 10 }, resume: true, onLine: () => {} });
		assert.equal(cached.status, "complete");
		const rerun = await executeConveyor({ source, runId: "total", runDir, budget: 10, declaredLimits: { maxTotalAgents: 1, maxAiCredits: 10 }, resume: true, invalidatedBranches: [[]], onLine: () => {} });
		assert.equal(rerun.status, "failed");
		assert.equal(rerun.failure.kind, "maxTotalAgents");
		assert.deepEqual(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).running, []);
	}));

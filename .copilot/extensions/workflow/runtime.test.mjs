/** @module runtime.test — engine + run driver: execute, cache/resume, budget, caps, dry-run, keys. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Runtime, applyRunSettings, fingerprint } from "./runtime.mjs";
import { executeWorkflow, extractMeta, stripExports } from "./executor.mjs";
import { withFakeEnv, tmpDir } from "./fixtures/support.mjs";

/**
 * Run a workflow source end-to-end against the fake backend into a temp run dir.
 * @param {string} source
 * @param {Partial<import("./executor.mjs").ExecuteConfig>} [over]
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ record: any, runDir: string }>}
 */
function runWf(source, over = {}, env = {}) {
	return withFakeEnv(env, async () => {
		const runDir = tmpDir();
		const record = await executeWorkflow({ source, runId: "test-run", runDir, budget: 10, ...over, onLine: () => {} });
		return { record, runDir };
	});
}

test("inline workflow executes without Python and persists all artifacts", async () => {
	const src = `
const a = await agent("one", { label: "a1" });
const b = await agent("two", { label: "a2" });
return a.content + " | " + b.content;`;
	const { record, runDir } = await runWf(src);
	assert.equal(record.status, "complete");
	assert.equal(record.result, "ECHO: one | ECHO: two");
	assert.equal(record.counts.done, 2);
	assert.equal(record.aic, 1.0);
	for (const f of ["script.js", "meta.json", "run.json", "result.json", "state.json", "progress.jsonl", "journal.jsonl"]) {
		assert.ok(existsSync(join(runDir, f)), `expected artifact ${f}`);
	}
	const lean = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
	assert.equal(lean.result, "ECHO: one | ECHO: two");
	assert.equal(lean.status, "complete");
});

test("fanOut runs every item and returns ordered results", async () => {
	const { record } = await runWf(`
const rs = await fanOut([1,2,3], (n) => agent("n=" + n, { label: "f" + n }));
return "count:" + rs.length + " ok:" + rs.filter(r => r.ok).length;`);
	assert.equal(record.result, "count:3 ok:3");
	assert.equal(record.counts.done, 3);
});

test("parallel defaults errors:'drop' — a throwing thunk preserves siblings but marks the run partial", async () => {
	const { record } = await runWf(`
const rs = await parallel([() => { throw new Error("boom"); }, () => 42]);
return JSON.stringify(rs);`);
	assert.equal(record.status, "partial");
	assert.equal(record.result, "[null,42]");
	assert.equal(record.counts.dropped, 1);
	assert.match(record.error ?? "", /1 dropped item/);
});

test("fanOut defaults errors:'raise' — a throwing item aborts the run", async () => {
	const { record } = await runWf(`
await fanOut([1,2], (n) => { if (n === 1) throw new Error("boom"); return n; });
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

test("budget.set() is reflected in the finalized record.budget.total", async () => {
	const { record } = await runWf(`budget.set(123); await agent("x"); return "ok";`);
	assert.equal(record.budget.total, 123);
});

test("restricted mode still lets a real run write memory (the runtime owns the I/O)", async () => {
	const memPath = join(tmpDir(), "mem.txt");
	await runWf(`memory.append("noted"); return "ok";`, { restricted: true, memoryPath: memPath });
	assert.equal(readFileSync(memPath, "utf8"), "noted\n");
});

test("resume reuses completed results (cached, no double-charge)", async () => {
	const src = `await agent("one", { label: "a1" }); await agent("two", { label: "a2" }); return "done";`;
	await withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const first = await executeWorkflow({ source: src, runId: "r", runDir, budget: 10, onLine: () => {} });
		assert.equal(first.counts.done, 2);
		assert.equal(first.aic, 1.0);
		const second = await executeWorkflow({ source: src, runId: "r", runDir, budget: 10, resume: true, onLine: () => {} });
		assert.equal(second.counts.cached, 2);
		assert.equal(second.counts.launched, 0);
		assert.equal(second.aic, 1.0);
		const progress = readFileSync(join(runDir, "progress.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(progress.filter((event) => event.ev === "run_start").length, 1);
		assert.equal(progress.at(-1).ev, "run_end");
	});
});

test("resume replaces stale terminal artifacts before new work completes", async () => {
	await withFakeEnv({}, async () => {
		const runDir = tmpDir();
		await executeWorkflow({
			source: `return (await agent("old")).content;`,
			runId: "r",
			runDir,
			budget: 10,
			onLine: () => {},
		});

		process.env.CWF_FAKE_MODE = "hang";
		const ac = new AbortController();
		const resumed = executeWorkflow({
			source: `return (await agent("new")).content;`,
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
		assert.equal(existsSync(join(runDir, "run.json")), false);
		assert.equal(existsSync(join(runDir, "result.json")), false);
		assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).status, "running");

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

test("strict budget aborts the run once the cap is observed", async () => {
	const { record } = await runWf(`
for (const n of [1,2,3]) await agent("n" + n, { label: "s" + n });
return "unreached";`, { budget: 0.6, strictBudget: true });
	assert.equal(record.status, "failed");
	assert.notEqual(record.result, "unreached"); // BudgetExceeded stopped the harness
	assert.equal(record.budget.hit, true);
	assert.match(record.error ?? "", /budget/);
});

test("a handled agent failure preserves its result with partial status", async () => {
	const { record } = await runWf(`const r = await agent("x"); return "handled:" + r.ok;`, {}, { CWF_FAKE_MODE: "fail" });
	assert.equal(record.status, "partial");
	assert.equal(record.result, "handled:false");
	assert.equal(record.counts.failed, 1);
});

test("fanOut over the cap is a fatal error", async () => {
	const { record } = await runWf(`await fanOut([1,2,3], (n) => agent("x" + n)); return "nope";`, {}, { CWF_MAX_FANOUT: "2" });
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /fanOut item cap exceeded/);
});

test("dryRun spends no AIC, launches no subagents, returns a plan, writes no run.json", async () => {
	const { record, runDir } = await runWf(`await fanOut([1,2,3], (n) => agent("x" + n)); return "ignored";`, { dryRun: true });
	assert.equal(record.aic, 0);
	assert.match(record.result, /dry-run plan: 3 agent/);
	assert.ok(!existsSync(join(runDir, "run.json")));
});

test("dryRun reports dropped planning branches as partial", async () => {
	const { record } = await runWf(
		`const rows = await parallel([() => { throw new Error("preview branch"); }, () => 1]); return JSON.stringify(rows);`,
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
	const { record } = await runWf(`return (await agent("x", { allowAllTools: true })).content;`, { restricted: true });
	assert.equal(record.status, "error");
	assert.match(record.error ?? "", /restricted mode forbids tool-escalation/);
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
	const rt = new Runtime({ budget: 10 });
	await assert.rejects(() => rt.followUp(/** @type {any} */ ({ sessionId: null }), "next"), /no sessionId/);
});

test("Runtime.parallel / pipeline / loopUntil / quarantine work over the fake backend", () =>
	withFakeEnv({}, async () => {
		const rt = new Runtime({ budget: 10 });
		const par = await rt.parallel([() => rt.agent("a"), () => rt.agent("b")]);
		assert.equal(par.length, 2);
		assert.ok(par.every((r) => r.ok));

		const piped = await rt.pipeline([1, 2], (n) => rt.agent("n=" + n), (prev) => prev.content.toUpperCase());
		assert.deepEqual(piped, ["ECHO: N=1", "ECHO: N=2"]);

		const hist = await rt.loopUntil((i) => i, (r) => r >= 2);
		assert.deepEqual(hist, [0, 1, 2]);

		const q = rt.quarantine();
		assert.deepEqual(q.deny, ["shell", "write"]);
		assert.deepEqual(q.denyUrl, ["*"]);
		assert.equal(q.enableMcp, false);
		// extra options pass through
		const q2 = rt.quarantine({ allowAllTools: false, label: "x" });
		assert.equal(q2.allowAllTools, false);
		assert.equal(q2.label, "x");
	}));

test("cache keys: identical prompts in different fanOut branches do not collide", () =>
	withFakeEnv({}, async () => {
		const dir = tmpDir();
		// Two branches each run the SAME prompt; both must execute and be cached under distinct keys.
		const rec = await executeWorkflow({
			source: `await fanOut([1,2], () => agent("same prompt")); return "ok";`,
			runId: "k",
			runDir: dir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.counts.done, 2);
		const keys = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).key);
		assert.equal(new Set(keys).size, 2, "two distinct branch-scoped keys");
	}));

test("cache keys: auto agent keys keep the journal-compatible tuple shape", () =>
	withFakeEnv({}, async () => {
		const dir = tmpDir();
		await executeWorkflow({
			source: `await fanOut([1,2], () => agent("same prompt")); return "ok";`,
			runId: "k",
			runDir: dir,
			budget: 10,
			onLine: () => {},
		});
		const fp = fingerprint(applyRunSettings({ prompt: "same prompt" }, { cwd: process.cwd() }));
		const keys = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).key).sort();
		assert.deepEqual(keys, [JSON.stringify(["a", [0], fp, 0]), JSON.stringify(["a", [1], fp, 0])].sort());
	}));

test("cache keys: an explicit key can't collide with a branch-scoped key (structured, not concatenated)", async () => {
	// Explicit top-level keys and branch-scoped keys must stay distinct.
	const src = `
const top = await agent("top", { key: "b0-foo", label: "top" });
const inner = await fanOut([0], () => agent("inner", { key: "foo", label: "inner" }));
return top.content + "|" + inner[0].content;`;
	const { record, runDir } = await runWf(src);
	assert.equal(record.result, "ECHO: top|ECHO: inner"); // no false cache hit swapping inner for top
	assert.equal(record.counts.done, 2);
	const keys = readFileSync(join(runDir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).key);
	assert.equal(new Set(keys).size, 2, "distinct structured keys");
});

test("cache keys: explicit agent keys keep the journal-compatible tuple shape", async () => {
	const src = `
await agent("top", { key: "b0-foo", label: "top" });
await fanOut([0], () => agent("inner", { key: "foo", label: "inner" }));
return "ok";`;
	const { runDir } = await runWf(src);
	const keys = readFileSync(join(runDir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).key);
	assert.deepEqual(keys, [JSON.stringify(["e", [], "b0-foo"]), JSON.stringify(["e", [0], "foo"])]);
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
	withFakeEnv({ CWF_FAKE_CONTENT: '{"n":5}' }, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
			source: `const s = await structured("give a number", { type:"object", properties:{ n:{ type:"integer" } }, required:["n"] }); return s.ok ? ("n=" + s.value.n) : ("fail:" + s.error);`,
			runId: "p",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.result, "n=5");
	}));

test("verify() is reachable from a harness and returns a verdict", () =>
	withFakeEnv({ CWF_FAKE_CONTENT: '{"passed":true,"score":1,"reasons":"ok"}' }, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
			source: `const v = await verify("work", "rubric"); return v.passed ? "PASS" : "FAIL";`,
			runId: "v",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.result, "PASS");
	}));

test("budget accessors expose total/spent/remaining/hit and a setter", () =>
	withFakeEnv({}, async () => {
		const rt = new Runtime({ budget: 0.4 });
		assert.equal(rt.budget.total, 0.4);
		assert.equal(rt.budget.spent(), 0);
		assert.equal(rt.budget.remaining(), 0.4);
		assert.equal(rt.budget.hit, false);
		await rt.agent("x"); // fake backend spends 0.5 AIC -> over the cap
		assert.equal(rt.budget.hit, true);
		assert.equal(rt.budget.remaining(), 0);
		rt.budget.set(100);
		assert.equal(rt.budget.total, 100);
		assert.equal(rt.budget.remaining(), 99.5);
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
});

test("explicit per-agent phase wins over the current phase", () =>
	withFakeEnv({}, async () => {
		const events = /** @type {any[]} */ ([]);
		const rt = new Runtime({ budget: 10, progress: (e) => events.push(e) });
		rt.phase("current");
		await rt.agent("x", { phase: "explicit", label: "a" });
		await rt.agent("y", { label: "b" });
		const ends = events.filter((e) => e.ev === "end");
		assert.equal(ends[0].phase, "explicit");
		assert.equal(ends[1].phase, "current");
	}));

test("cache keys: same spec shares a fingerprint; model changes it; label is excluded", () => {
	const a = fingerprint(applyRunSettings({ prompt: "p", label: "L1" }));
	const b = fingerprint(applyRunSettings({ prompt: "p", label: "L2" })); // label not in the key
	const c = fingerprint(applyRunSettings({ prompt: "p", model: "m2" })); // model is in the key
	assert.equal(a, b);
	assert.equal(a, "4dfea83d430fa9ba774283446de12eaa291e176bf5b373dc3f7f392415d5436e");
	assert.notEqual(a, c);
});

test("loopUntil stops at maxIters and returns the full history", async () => {
	const rt = new Runtime({});
	assert.deepEqual(await rt.loopUntil((i) => i, () => false, { maxIters: 3 }), [0, 1, 2]);
	assert.deepEqual(await rt.loopUntil((i) => i, (r) => r >= 1), [0, 1]);
});

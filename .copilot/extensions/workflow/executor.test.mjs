/** @module executor.test — workflow execution lifecycle and harness source helpers. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { executeWorkflow, extractMeta, stripExports } from "./executor.mjs";
import { withFakeEnv, tmpDir, within } from "./fixtures/support.mjs";

test("stripExports removes ESM exports while leaving plain source alone", () => {
	assert.equal(stripExports("export const meta = {}").trim(), "const meta = {}");
	assert.equal(stripExports("export async function main() {}").trim(), "async function main() {}");
	assert.equal(stripExports("export default answer").trim(), "answer");
	assert.equal(stripExports("const x = 1;").trim(), "const x = 1;");
});

test("extractMeta reads a literal meta block and ignores dynamic/non-object values", () => {
	const meta = extractMeta(`export const meta = { name: "audit", description: "scan", phases: ["plan"] }\nreturn "ok";`);
	assert.equal(meta.name, "audit");
	assert.equal(meta.description, "scan");
	assert.deepEqual([.../** @type {any[]} */ (meta.phases)], ["plan"]);
	assert.deepEqual(extractMeta(`const meta = { name: someVar }`), {});
	assert.deepEqual(extractMeta(`const meta = null`), {});
	assert.deepEqual(extractMeta(`return "no meta";`), {});
});

test("dry-run executes the harness plan without writing run artifacts or spending AIC", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
			source: `export const meta = { name: "preview" };\nawait fanOut([1,2,3], (n) => agent("x" + n)); return "ignored";`,
			runId: "dry",
			runDir,
			budget: 10,
			dryRun: true,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.equal(rec.aic, 0);
		assert.match(rec.result, /dry-run plan: 3 agent call\(s\) — preview/);
		assert.equal(existsSync(join(runDir, "run.json")), false);
		assert.equal(existsSync(join(runDir, "journal.jsonl")), false);
	}));

test("real run persists execution artifacts and a lean result file", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
			source: `export const meta = { name: "persist" };\nreturn (await agent("hi")).content;`,
			runId: "real",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.status, "complete");
		assert.equal(rec.result, "ECHO: hi");
		for (const file of ["script.js", "meta.json", "state.json", "progress.jsonl", "journal.jsonl", "run.json", "result.json"]) {
			assert.ok(existsSync(join(runDir, file)), `expected ${file}`);
		}
		const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
		assert.equal(meta.workflow.name, "persist");
		const result = JSON.parse(readFileSync(join(runDir, "result.json"), "utf8"));
		assert.deepEqual(Object.keys(result).sort(), ["aic", "result", "runId", "status"]);
		assert.equal(result.result, "ECHO: hi");
	}));

test("harness failure is persisted as an error record instead of rejecting", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		const rec = await executeWorkflow({
			source: `throw new Error("boom");`,
			runId: "fail",
			runDir,
			budget: 10,
			onLine: () => {},
		});
		assert.equal(rec.status, "error");
		assert.match(rec.error ?? "", /boom/);
		assert.ok(existsSync(join(runDir, "script.js")));
		assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "error");
		assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "error");
		const progress = readFileSync(join(runDir, "progress.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(progress.at(-1).ev, "run_end");
		assert.equal(progress.at(-1).status, "error");
	}));

test("a synchronous runaway harness is bounded and persisted as an error", async () => {
	const runDir = tmpDir();
	const rec = await executeWorkflow({
		source: `while (true) {}`,
		runId: "runaway",
		runDir,
		budget: 10,
		harnessSyncTimeoutMs: 25,
		onLine: () => {},
	});
	assert.equal(rec.status, "error");
	assert.match(rec.error ?? "", /Script execution timed out after 25ms/);
	assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "error");
	assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "error");
});

test("reporter closes even when final logging throws", () =>
	withFakeEnv({}, async () => {
		const runDir = tmpDir();
		await assert.rejects(
			executeWorkflow({
				source: `return (await agent("hi")).content;`,
				runId: "log-fail",
				runDir,
				budget: 10,
				onLine: (line) => {
					if (line.startsWith("— workflow:")) throw new Error("log failed");
				},
			}),
			/log failed/,
		);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).status, "complete");
	}));

test("abort finalizes a harness that never resolves", async () => {
	const runDir = tmpDir();
	const ac = new AbortController();
	const pending = executeWorkflow({
		source: `await new Promise(() => {}); return "unreached";`,
		runId: "never",
		runDir,
		budget: 10,
		signal: ac.signal,
		onLine: () => {},
	});
	setTimeout(() => ac.abort(), 50);

	const rec = await within(pending, 1500);
	assert.equal(rec.status, "timeout");
	assert.equal(JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status, "timeout");
	assert.equal(JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")).status, "timeout");
});

test("an already-aborted run consumes a later harness rejection", async () => {
	const runDir = tmpDir();
	const ac = new AbortController();
	ac.abort();
	const rec = await executeWorkflow({
		source: `await Promise.resolve(); throw new Error("late harness failure");`,
		runId: "already-aborted",
		runDir,
		budget: 10,
		signal: ac.signal,
		onLine: () => {},
	});
	assert.equal(rec.status, "timeout");
	await new Promise((resolve) => setImmediate(resolve));
});

test("abort during fire-and-forget drain records timeout, not complete", () =>
	withFakeEnv({ CWF_FAKE_MODE: "hang" }, async () => {
		const runDir = tmpDir();
		const ac = new AbortController();
		const pending = executeWorkflow({
			source: `agent("orphan", { label: "orphan" }); return "done";`,
			runId: "drain-timeout",
			runDir,
			budget: 10,
			signal: ac.signal,
			onLine: () => {},
		});

		for (let i = 0; i < 100; i++) {
			if (existsSync(join(runDir, "progress.jsonl")) && readFileSync(join(runDir, "progress.jsonl"), "utf8").includes('"ev":"start"')) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		ac.abort();

		const rec = await within(pending, 2000);
		assert.equal(rec.status, "timeout");
		assert.equal(rec.result, "done");
		assert.equal(JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")).status, "timeout");
	}));

/** @module runs.test — persisted run inspection: listing, replay, and slash-command rendering. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listWorkflowRuns, runsDir, workflowCommand } from "./runs.mjs";
import { tmpDir } from "./fixtures/support.mjs";

/** @template T @param {(runs: string) => T} fn @returns {T} */
function withRuns(fn) {
	const saved = process.env.CWF_RUNS_DIR;
	const runs = tmpDir();
	process.env.CWF_RUNS_DIR = runs;
	try {
		return fn(runs);
	} finally {
		if (saved === undefined) delete process.env.CWF_RUNS_DIR;
		else process.env.CWF_RUNS_DIR = saved;
	}
}

/** @param {string} runs @param {string} id */
function runDir(runs, id) {
	const dir = join(runs, id);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("runsDir follows CWF_RUNS_DIR and listWorkflowRuns reports an empty directory", () =>
	withRuns((runs) => {
		assert.equal(runsDir(), runs);
		assert.match(listWorkflowRuns(), new RegExp(`No workflow runs in ${runs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	}));

test("listWorkflowRuns prefers persisted records and falls back to progress replay", () =>
	withRuns((runs) => {
		const complete = runDir(runs, "complete-run");
		writeFileSync(join(complete, "meta.json"), JSON.stringify({ workflow: { name: "full" }, updatedAt: "2026-01-01T00:00:01Z" }));
		writeFileSync(join(complete, "run.json"), JSON.stringify({ status: "complete", workflow: { name: "full" }, aic: 1.25, finishedAt: "2026-01-01T00:00:01Z" }));

		const replayed = runDir(runs, "replayed-run");
		writeFileSync(join(replayed, "progress.jsonl"), [
			JSON.stringify({ ev: "run_start", harness: "/tmp/legacy.cwf.py", meta: {} }),
			JSON.stringify({ ev: "run_end", agents: 2, launched: 2, done: 2, failed: 0, cached: 0, skipped: 0, nano_aiu: 500_000_000, t: 1783308171 }),
			"",
		].join("\n"));

		const errored = runDir(runs, "errored-run");
		writeFileSync(join(errored, "progress.jsonl"), [
			JSON.stringify({ ev: "run_start", meta: { name: "errored" } }),
			JSON.stringify({ ev: "run_end", status: "error", error: "boom", agents: 0, launched: 0, done: 0, failed: 0, cached: 0, skipped: 0, nanoAiu: 0, t: Date.parse("2026-07-09T19:00:00.000Z") }),
			"",
		].join("\n"));

		const listing = listWorkflowRuns();
		assert.match(listing, /complete-run\s+complete\s+full\s+1\.3/);
		assert.match(listing, /replayed-run\s+complete\s+legacy\s+0\.5/);
		assert.match(listing, /errored-run\s+error\s+errored\s+0\.0\s+2026-07-09T19:00:00\.000Z/);
	}));

test("listWorkflowRuns sorts timestamps chronologically across fractional precision", () =>
	withRuns((runs) => {
		const older = runDir(runs, "older-run");
		writeFileSync(join(older, "state.json"), JSON.stringify({ status: "running", updatedAt: "2026-01-01T00:00:00Z" }));
		const newer = runDir(runs, "newer-run");
		writeFileSync(join(newer, "state.json"), JSON.stringify({ status: "running", updatedAt: "2026-01-01T00:00:00.500Z" }));

		const listing = listWorkflowRuns();
		assert.ok(listing.indexOf("newer-run") < listing.indexOf("older-run"));
	}));

test("workflowCommand renders latest dashboard, result, artifacts, and summary fallback", () =>
	withRuns((runs) => {
		const logs = /** @type {string[]} */ ([]);
		const ctx = { log: (/** @type {string} */ message) => logs.push(message) };
		workflowCommand("", ctx);
		assert.match(logs.at(-1) ?? "", /no workflow runs yet/);

		const full = runDir(runs, "full-run");
		writeFileSync(join(full, "state.json"), JSON.stringify({
			runId: "full-run",
			title: "demo",
			status: "complete",
			startedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:01Z",
			counts: { launched: 1, done: 1, failed: 0, cached: 0, skipped: 0 },
			aic: 0.5,
			running: [],
			recent: [],
			errors: [],
		}));
		writeFileSync(join(full, "result.json"), JSON.stringify({ result: "hello" }));

		workflowCommand("latest", ctx);
		assert.match(logs.at(-1) ?? "", /workflow: demo/);
		workflowCommand("result full-run", ctx);
		assert.equal(logs.at(-1), "hello");
		workflowCommand("artifacts full-run", ctx);
		assert.match(logs.at(-1) ?? "", /result\.json/);

		const summary = runDir(runs, "summary-run");
		writeFileSync(join(summary, "run.json"), JSON.stringify({ status: "complete", counts: { agents: 1, done: 1, cached: 0, skipped: 0, failed: 0 }, aic: 0.5 }));
		workflowCommand("summary-run", ctx);
		assert.match(logs.at(-1) ?? "", /workflow run summary-run/);
	}));

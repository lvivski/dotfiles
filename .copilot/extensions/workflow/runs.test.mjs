/** @module runs.test — persisted run inspection: listing, replay, and slash-command rendering. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	MAX_RESULT_CHUNK_CHARS,
	WorkflowResultError,
	getWorkflowResult,
	inspectWorkflowAgent,
	inspectWorkflowRun,
	listWorkflowRuns,
	runsDir,
	workflowCommand,
} from "./runs.mjs";
import { PROCESS_INSTANCE_ID } from "./progress.mjs";
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

/** @param {string} dir @param {string} [token] */
function writeLiveOwner(dir, token = "live-owner") {
	mkdirSync(join(dir, ".lock"), { recursive: true });
	writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({
		token,
		generation: 1,
		pid: process.pid,
	}));
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
			JSON.stringify({ ev: "run_start", meta: { name: "replayed" } }),
			JSON.stringify({ ev: "run_end", agents: 2, launched: 2, done: 2, failed: 0, cached: 0, skipped: 0, nanoAiu: 500_000_000, t: Date.parse("2026-07-09T18:00:00.000Z") }),
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
		assert.match(listing, /replayed-run\s+complete\s+replayed\s+0\.5/);
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

test("getWorkflowResult paginates results and includes terminal error metadata", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "paged-run");
		writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "paged-run", status: "partial", error: "one worker failed", aic: 1.25 }));
		writeFileSync(join(dir, "result.json"), JSON.stringify({ runId: "paged-run", status: "partial", aic: 1.25, result: "A😀B🧪C" }));

		const first = JSON.parse(getWorkflowResult({ runId: "paged-run", limit: 3 }));
		assert.deepEqual(
			{
				status: first.status,
				error: first.error,
				resultAvailable: first.resultAvailable,
				nextOffset: first.nextOffset,
				result: first.result,
			},
			{
				status: "partial",
				error: "one worker failed",
				resultAvailable: true,
				nextOffset: 3,
				result: "A😀",
			},
		);
		const second = JSON.parse(getWorkflowResult({ runId: "paged-run", offset: first.nextOffset, limit: 3 }));
		const third = JSON.parse(getWorkflowResult({ runId: "paged-run", offset: second.nextOffset, limit: 3 }));
		assert.equal(first.result + second.result + third.result, "A😀B🧪C");
		assert.equal(third.nextOffset, null);
	}));

test("getWorkflowResult handles empty results and offsets past the end", () =>
	withRuns((runs) => {
		const empty = runDir(runs, "empty-run");
		writeFileSync(join(empty, "result.json"), JSON.stringify({ runId: "empty-run", status: "complete", aic: 0, result: "" }));
		const emptyResult = JSON.parse(getWorkflowResult({ runId: "empty-run", offset: 99 }));
		assert.equal(emptyResult.resultAvailable, true);
		assert.equal(emptyResult.nextOffset, null);
		assert.equal(emptyResult.result, "");

		const short = runDir(runs, "short-run");
		writeFileSync(join(short, "result.json"), JSON.stringify({ runId: "short-run", status: "complete", aic: 0, result: "abc" }));
		const pastEnd = JSON.parse(getWorkflowResult({ runId: "short-run", offset: 50, limit: 2 }));
		assert.equal(pastEnd.offset, 50);
		assert.equal(pastEnd.nextOffset, null);
		assert.equal(pastEnd.result, "");
	}));

test("getWorkflowResult distinguishes running from terminal resultless runs", () =>
	withRuns((runs) => {
		const now = new Date().toISOString();
		const running = runDir(runs, "running-run");
		writeFileSync(
			join(running, "state.json"),
			JSON.stringify({
				status: "running",
				ownerPid: process.pid,
				ownerInstanceId: PROCESS_INSTANCE_ID,
				updatedAt: now,
				aic: 0.5,
			}),
		);
		writeLiveOwner(running);
		const pending = JSON.parse(getWorkflowResult({ runId: "running-run" }));
		assert.equal(pending.resultAvailable, false);
		assert.equal(pending.status, "running");
		assert.match(pending.guidance, /Wait for the workflow completion notification; do not poll/);

		const interrupted = runDir(runs, "interrupted-run");
		writeFileSync(
			join(interrupted, "state.json"),
			JSON.stringify({
				status: "running",
				ownerPid: 2_147_483_647,
				ownerInstanceId: "dead-instance",
				updatedAt: now,
			}),
		);
		const terminal = JSON.parse(getWorkflowResult({ runId: "interrupted-run" }));
		assert.equal(terminal.resultAvailable, false);
		assert.equal(terminal.status, "interrupted");
		assert.match(terminal.guidance, /Waiting will not produce one/);
		assert.match(terminal.error, /host process exited/);
	}));

test("getWorkflowResult rejects unsafe inputs and malformed artifacts", () =>
	withRuns((runs) => {
		assert.throws(() => getWorkflowResult({ runId: "../outside" }), WorkflowResultError);
		assert.throws(() => getWorkflowResult({ runId: ".." }), WorkflowResultError);
		assert.throws(() => getWorkflowResult({ runId: "bad\nid" }), /bare workflow run id/);
		assert.throws(() => getWorkflowResult({ runId: "missing" }), /Use list_workflow_runs/);
		assert.throws(() => getWorkflowResult({ runId: "missing", offset: -1 }), /offset must be/);
		assert.throws(() => getWorkflowResult({ runId: "missing", limit: MAX_RESULT_CHUNK_CHARS + 1 }), /limit must be between/);

		const malformed = runDir(runs, "malformed-run");
		writeFileSync(join(malformed, "result.json"), "{not json");
		assert.throws(() => getWorkflowResult({ runId: "malformed-run" }), /malformed JSON/);

		const primitive = runDir(runs, "primitive-run");
		writeFileSync(join(primitive, "result.json"), "false");
		assert.throws(() => getWorkflowResult({ runId: "primitive-run" }), /must be a JSON object/);

		const invalid = runDir(runs, "invalid-run");
		writeFileSync(join(invalid, "result.json"), JSON.stringify({ runId: "invalid-run", status: "complete", result: { text: "no" } }));
		assert.throws(() => getWorkflowResult({ runId: "invalid-run" }), /non-string result/);

		const logs = /** @type {string[]} */ ([]);
		workflowCommand("result ../outside", { log: (message) => logs.push(message) });
		assert.match(logs.at(-1) ?? "", /no run found/);
	}));

test("inspectWorkflowRun returns bounded running metadata without result text or args", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "running-inspect");
		const huge = "x".repeat(5000);
		writeFileSync(join(dir, "meta.json"), JSON.stringify({ workflow: { name: huge }, updatedAt: "2026-01-01T00:00:00Z" }));
		writeFileSync(
			join(dir, "state.json"),
			JSON.stringify({
				runId: "running-inspect",
				title: huge,
				status: "running",
				ownerPid: process.pid,
				ownerInstanceId: PROCESS_INSTANCE_ID,
				startedAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:01Z",
				phase: huge,
				counts: { launched: 1, done: 0, failed: 0, cached: 0, skipped: 0, dropped: 0 },
				running: [{ seq: 1, label: huge, model: huge, phase: huge, branchPath: "/0/2" }],
				groups: [{ gid: 1, kind: huge, phase: huge, n: 1 }],
				recent: [{ label: huge, status: "done", aic: 0.5, error: huge }],
				errors: [{ label: huge, error: huge }],
			}),
		);
		writeLiveOwner(dir);

		const inspected = JSON.parse(inspectWorkflowRun({ runId: "running-inspect" }));
		assert.equal(inspected.status, "running");
		assert.equal(inspected.running.length, 1);
		assert.equal(inspected.running[0].branchPath, "/0/2");
		assert.ok(inspected.running[0].label.length <= 500);
		assert.ok(inspected.errors[0].error.length <= 2000);
		assert.equal(inspected.result.available, false);
		assert.equal("args" in inspected, false);
		assert.equal("resultText" in inspected, false);
	}));

test("inspectWorkflowRun prefers terminal records, suppresses phantom running agents, and validates results", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "terminal-inspect");
		writeFileSync(
			join(dir, "state.json"),
			JSON.stringify({
				status: "running",
				ownerPid: process.pid,
				ownerInstanceId: PROCESS_INSTANCE_ID,
				running: [{ seq: 1, label: "phantom" }],
				groups: [{ gid: 1, kind: "parallel", n: 1 }],
				recent: [],
				errors: [],
			}),
		);
		writeFileSync(
			join(dir, "run.json"),
			JSON.stringify({
				runId: "terminal-inspect",
				status: "complete",
				workflow: { name: "terminal" },
				args: { secret: "must-not-leak" },
				result: "must-not-leak",
				counts: { agents: 1, launched: 1, done: 1, failed: 0, cached: 0, skipped: 0, dropped: 0 },
				preservedWorktrees: Array.from({ length: 80 }, (_, i) => `/tmp/${i}/${"p".repeat(3000)}`),
			}),
		);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({
				persistenceVersion: 3,
				parentPermissionMode: "auto",
				parentSessionMode: "autopilot",
				permissionMode: "parent-auto-profile-narrowed",
				permissionInheritance: { fineGrainedRules: "not-exposed-by-parent-sdk" },
			}),
		);
		writeFileSync(join(dir, "result.json"), JSON.stringify({ runId: "terminal-inspect", status: "complete", aic: 1, result: "must-not-leak" }));

		const text = inspectWorkflowRun({ runId: "terminal-inspect" });
		const inspected = JSON.parse(text);
		assert.equal(inspected.status, "complete");
		assert.deepEqual(inspected.running, []);
		assert.deepEqual(inspected.groups, []);
		assert.equal(inspected.result.available, true);
		assert.equal(inspected.parentPermissionMode, "auto");
		assert.equal(inspected.parentSessionMode, "autopilot");
		assert.equal(inspected.permissionInheritance.fineGrainedRules, "not-exposed-by-parent-sdk");
		assert.equal(inspected.preservedWorktrees.length, 50);
		assert.ok(inspected.preservedWorktrees.every((/** @type {string} */ p) => p.length <= 2000));
		assert.doesNotMatch(text, /must-not-leak/);
	}));

test("inspectWorkflowRun replays progress and surfaces malformed result artifacts", () =>
	withRuns((runs) => {
		const replayed = runDir(runs, "legacy-inspect");
		writeFileSync(
			join(replayed, "progress.jsonl"),
			[
				JSON.stringify({ ev: "run_start", meta: { name: "replayed" } }),
				JSON.stringify({ ev: "run_end", status: "partial", error: "legacy failure", agents: 2, launched: 2, done: 1, failed: 1, cached: 0, skipped: 0, nanoAiu: 500_000_000 }),
				"",
			].join("\n"),
		);
		writeFileSync(join(replayed, "result.json"), "{not json");

		const inspected = JSON.parse(inspectWorkflowRun({ runId: "legacy-inspect" }));
		assert.equal(inspected.status, "partial");
		assert.equal(inspected.workflow, "replayed");
		assert.equal(inspected.counts.failed, 1);
		assert.equal(inspected.result.available, false);
		assert.match(inspected.result.error, /malformed JSON/);
	}));

test("inspectWorkflowRun rejects unsafe and missing run ids", () =>
	withRuns(() => {
		assert.throws(() => inspectWorkflowRun({ runId: "../outside" }), WorkflowResultError);
		assert.throws(() => inspectWorkflowRun({ runId: "missing" }), /Use list_workflow_runs/);
	}));

test("inspectWorkflowAgent returns bounded summary, prompt, result, events, and usage", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "agent-run");
		const key = '["a",[],0,"fp",0]';
		writeFileSync(
			join(dir, "journal.jsonl"),
			[
				JSON.stringify({ v: 3, type: "control", action: "branches_invalidated", generation: 1, branches: [[0]], invalidatedAt: "2026-01-01T00:00:00Z" }),
				JSON.stringify({ v: 3, type: "agent_started", key, branch: [0, 2], branchPath: "/0/2", label: "reviewer", prompt: "review this file", model: "m" }),
				JSON.stringify({ v: 3, type: "usage", key, label: "reviewer", sessionId: "session-1", model: "m", outcome: "ok", aic: 0.5, usageUnknown: false }),
				JSON.stringify({ v: 3, type: "result", key, result: { label: "reviewer", sessionId: "session-1", model: "m", ok: true, content: "long result" } }),
				"",
			].join("\n"),
		);
		writeFileSync(join(dir, "progress.jsonl"), JSON.stringify({ ev: "end", label: "reviewer", ok: true }) + "\n");
		const summary = JSON.parse(inspectWorkflowAgent({ runId: "agent-run", agent: "session-1" }));
		assert.equal(summary.label, "reviewer");
		assert.equal(summary.branchPath, "/0/2");
		assert.equal(summary.aic, 0.5);
		assert.equal(summary.hasPrompt, true);
		assert.equal(JSON.parse(inspectWorkflowAgent({ runId: "agent-run", agent: "reviewer", section: "prompt", limit: 6 })).text, "review");
		assert.equal(JSON.parse(inspectWorkflowAgent({ runId: "agent-run", agent: key, section: "result", offset: 5 })).text, "result");
		assert.match(JSON.parse(inspectWorkflowAgent({ runId: "agent-run", agent: "reviewer", section: "events" })).text, /"ev":"end"/);
		assert.equal(JSON.parse(inspectWorkflowAgent({ runId: "agent-run", agent: "reviewer", section: "usage" })).usage.length, 1);
		assert.throws(() => inspectWorkflowAgent({ runId: "agent-run", agent: "missing" }), /no workflow agent matched/);
	}));

test("a dead owner renders interrupted while a live owner stays running", () =>
	withRuns((runs) => {
		const now = new Date().toISOString();
		const old = new Date(Date.now() - 60_000).toISOString();
		const dead = runDir(runs, "dead-owner");
		writeFileSync(join(dead, "state.json"), JSON.stringify({
			runId: "dead-owner",
			title: "dead",
			status: "running",
			ownerPid: 2_147_483_647,
			ownerInstanceId: "dead-instance",
			startedAt: now,
			updatedAt: now,
			counts: {},
			running: [],
			recent: [],
			errors: [],
		}));
		const live = runDir(runs, "live-owner");
		writeFileSync(join(live, "state.json"), JSON.stringify({
			status: "running",
			ownerPid: process.pid,
			ownerInstanceId: PROCESS_INSTANCE_ID,
			updatedAt: now,
		}));
		writeLiveOwner(live);
		const legacy = runDir(runs, "legacy-stale");
		writeFileSync(join(legacy, "state.json"), JSON.stringify({
			status: "running",
			updatedAt: old,
		}));
		const locked = runDir(runs, "legacy-locked");
		writeFileSync(join(locked, "state.json"), JSON.stringify({
			status: "running",
			updatedAt: old,
		}));
		mkdirSync(join(locked, ".lock"));
		writeFileSync(join(locked, ".lock", "owner.json"), JSON.stringify({
			token: "live",
			generation: 1,
			pid: process.pid,
		}));
		const listing = listWorkflowRuns();
		assert.match(listing, /dead-owner\s+interrupted/);
		assert.match(listing, /live-owner\s+running/);
		assert.match(listing, /legacy-stale\s+interrupted/);
		assert.match(listing, /legacy-locked\s+running/);

		const logs = /** @type {string[]} */ ([]);
		workflowCommand("dead-owner", { log: (message) => logs.push(message) });
		assert.match(logs.at(-1) ?? "", /interrupted/);
		const inspected = JSON.parse(inspectWorkflowRun({ runId: "dead-owner" }));
		assert.equal(inspected.status, "interrupted");
		assert.deepEqual(inspected.running, []);
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

/** @module runs.test — persisted run inspection: listing, replay, and slash-command rendering. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	MAX_RESULT_CHUNK_CHARS,
	ConveyorResultError,
	getConveyorAgentContent,
	getConveyorProgress,
	getConveyorResult,
	getConveyorRunActivity,
	inspectConveyorAgent,
	inspectConveyorRun,
	listConveyorRuns,
	loadConveyorResult,
	loadConveyorRunForImport,
	runsDir,
	conveyorCommand,
} from "./runs.mjs";
import { PROCESS_INSTANCE_ID } from "./progress.mjs";
import { tmpDir } from "./fixtures/support.mjs";
import { Ledger } from "./ledger.mjs";
import { snapshotHost } from "./snapshot.mjs";

/** @template T @param {(runs: string) => T} fn @returns {T} */
function withRuns(fn) {
	const saved = process.env.CONVEYOR_RUNS_DIR;
	const runs = tmpDir();
	process.env.CONVEYOR_RUNS_DIR = runs;
	try {
		return fn(runs);
	} finally {
		if (saved === undefined) delete process.env.CONVEYOR_RUNS_DIR;
		else process.env.CONVEYOR_RUNS_DIR = saved;
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

test("runsDir follows CONVEYOR_RUNS_DIR and listConveyorRuns reports an empty directory", () =>
	withRuns((runs) => {
		assert.equal(runsDir(), runs);
		assert.match(listConveyorRuns(), new RegExp(`No conveyor runs in ${runs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	}));

test("listConveyorRuns prefers persisted records and falls back to progress replay", () =>
	withRuns((runs) => {
		const complete = runDir(runs, "complete-run");
		writeFileSync(join(complete, "manifest.json"), JSON.stringify({ conveyor: { name: "full" }, createdAt: "2026-01-01T00:00:01Z" }));
		writeFileSync(join(complete, "run.json"), JSON.stringify({ status: "complete", conveyor: { name: "full" }, aic: 1.25, finishedAt: "2026-01-01T00:00:01Z" }));

		const replayed = runDir(runs, "replayed-run");
		writeFileSync(join(replayed, "ledger.jsonl"), [
			JSON.stringify({ type: "progress", revision: 1, recordedAt: Date.parse("2026-07-09T18:00:00.000Z"), record: { ev: "run_start", meta: { name: "replayed" } } }),
			JSON.stringify({ type: "progress", revision: 2, recordedAt: Date.parse("2026-07-09T18:00:00.000Z"), record: { ev: "run_end", status: "complete", agents: 2, launched: 2, done: 2, failed: 0, cached: 0, skipped: 0, nanoAiu: 500_000_000, t: Date.parse("2026-07-09T18:00:00.000Z") } }),
			"",
		].join("\n"));

		const errored = runDir(runs, "errored-run");
		writeFileSync(join(errored, "ledger.jsonl"), [
			JSON.stringify({ type: "progress", revision: 1, recordedAt: Date.parse("2026-07-09T19:00:00.000Z"), record: { ev: "run_start", meta: { name: "errored" } } }),
			JSON.stringify({ type: "progress", revision: 2, recordedAt: Date.parse("2026-07-09T19:00:00.000Z"), record: { ev: "run_end", status: "error", error: "boom", agents: 0, launched: 0, done: 0, failed: 0, cached: 0, skipped: 0, nanoAiu: 0, t: Date.parse("2026-07-09T19:00:00.000Z") } }),
			"",
		].join("\n"));

		const listing = listConveyorRuns();
		assert.match(listing, /complete-run\s+complete\s+full\s+1\.3/);
		assert.match(listing, /replayed-run\s+complete\s+replayed\s+0\.5/);
		assert.match(listing, /errored-run\s+error\s+errored\s+0\.0\s+2026-07-09T19:00:00\.000Z/);
	}));

test("listConveyorRuns sorts timestamps chronologically across fractional precision", () =>
	withRuns((runs) => {
		const older = runDir(runs, "older-run");
		writeFileSync(join(older, "state.json"), JSON.stringify({ status: "running", updatedAt: "2026-01-01T00:00:00Z" }));
		const newer = runDir(runs, "newer-run");
		writeFileSync(join(newer, "state.json"), JSON.stringify({ status: "running", updatedAt: "2026-01-01T00:00:00.500Z" }));

		const listing = listConveyorRuns();
		assert.ok(listing.indexOf("newer-run") < listing.indexOf("older-run"));
	}));

test("getConveyorResult paginates results and includes terminal error metadata", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "paged-run");
		writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "paged-run", status: "partial", error: "one worker failed", aic: 1.25, result: "A😀B🧪C" }));

		const first = JSON.parse(getConveyorResult({ runId: "paged-run", format: "text", limit: 3 }));
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
		const second = JSON.parse(getConveyorResult({ runId: "paged-run", format: "text", offset: first.nextOffset, limit: 3 }));
		const third = JSON.parse(getConveyorResult({ runId: "paged-run", format: "text", offset: second.nextOffset, limit: 3 }));
		assert.equal(first.result + second.result + third.result, "A😀B🧪C");
		assert.equal(third.nextOffset, null);
	}));

test("loadConveyorRunForImport returns source and argument identity", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "import-run");
		const args = { z: 1, a: ["x"] };
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({
				runId: "import-run",
				restricted: true,
				enableMcp: false,
				strictBudget: true,
				model: null,
				effort: null,
				context: null,
				planId: "preview-plan",
				progressMode: "dashboard",
				maxAgents: 15,
				declaredLimits: {
					maxConcurrentAgents: 2,
					maxTotalAgents: 8,
					timeoutSeconds: 300,
					maxAiCredits: 30,
				},
				conveyor: { name: "mobius-plan" },
				args,
			}),
		);
		writeFileSync(join(dir, "script.js"), "return { ok: true };\n");
		writeFileSync(
			join(dir, "run.json"),
			JSON.stringify({
				runId: "import-run",
				status: "complete",
				revision: 2,
				result: { ok: true },
				preservedWorktrees: [],
			}),
		);

		const imported = loadConveyorRunForImport("import-run");
		assert.equal(imported.importContractVersion, 1);
		assert.equal(imported.status, "complete");
		assert.equal(imported.conveyor, "mobius-plan");
		assert.equal(imported.restricted, true);
		assert.equal(imported.enableMcp, false);
		assert.equal(imported.strictBudget, true);
		assert.equal(imported.previewPlanId, "preview-plan");
		assert.equal(imported.maxAgents, 15);
		assert.equal(imported.declaredLimits.maxTotalAgents, 8);
		assert.equal(imported.hostPath, null);
		assert.equal(imported.source, "return { ok: true };\n");
		assert.deepEqual(imported.args, args);
		assert.match(imported.argsSha256, /^[a-f0-9]{64}$/);
		assert.match(imported.scriptSha256, /^[a-f0-9]{64}$/);
		assert.deepEqual(imported.preservedWorktrees, []);
	}));

test("loadConveyorRunForImport validates manifest identity and host snapshots", () =>
	withRuns((runs) => {
		const makeRun = (id) => {
			const dir = runDir(runs, id);
			writeFileSync(join(dir, "manifest.json"), JSON.stringify({ runId: id, args: null }));
			writeFileSync(join(dir, "script.js"), "return null;\n");
			writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: id, status: "complete", revision: 1, result: null }));
			return dir;
		};

		const mismatch = makeRun("mismatch");
		writeFileSync(join(mismatch, "manifest.json"), JSON.stringify({ runId: "other", args: null }));
		assert.throws(() => loadConveyorRunForImport("mismatch"), /manifest id/);

		const symlinked = makeRun("symlinked");
		symlinkSync(tmpDir(), join(symlinked, "host"));
		assert.throws(() => loadConveyorRunForImport("symlinked"), /host snapshot/);

		const tampered = makeRun("tampered");
		const source = tmpDir();
		writeFileSync(join(source, "index.mjs"), "export const effect = () => 1;\n");
		snapshotHost(source, join(tampered, "host"));
		writeFileSync(join(tampered, "host", "index.mjs"), "tampered");
		assert.throws(() => loadConveyorRunForImport("tampered"), /integrity verification/);
	}));

test("getConveyorRunActivity reads terminal status", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "unsupported-terminal");
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ runId: "unsupported-terminal" }));
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			runId: "unsupported-terminal",
			status: "timeout",
			revision: 1,
		}));

test("ownerless partial ledgers are interrupted, not permanently running", () =>
		withRuns((runs) => {
			const dir = runDir(runs, "ownerless-partial");
			writeFileSync(join(dir, "ledger.jsonl"), [
				JSON.stringify({
					type: "progress",
					revision: 1,
					recordedAt: Date.now(),
					record: {
						ev: "run_start",
						meta: { name: "partial" },
					},
				}),
				"",
			].join("\n"));
			assert.equal(
				getConveyorRunActivity("ownerless-partial").status,
				"interrupted",
			);
		}));
		assert.deepEqual(
			getConveyorRunActivity("unsupported-terminal"),
			{
				runId: "unsupported-terminal",
				exists: true,
				status: "timeout",
				active: false,
			},
		);
	}));

test("getConveyorResult handles empty results and offsets past the end", () =>
	withRuns((runs) => {
		const empty = runDir(runs, "empty-run");
		writeFileSync(join(empty, "run.json"), JSON.stringify({ runId: "empty-run", status: "complete", aic: 0, result: "" }));
		const emptyResult = JSON.parse(getConveyorResult({ runId: "empty-run", format: "text", offset: 99 }));
		assert.equal(emptyResult.resultAvailable, true);
		assert.equal(emptyResult.nextOffset, null);
		assert.equal(emptyResult.result, "");

		const short = runDir(runs, "short-run");
		writeFileSync(join(short, "run.json"), JSON.stringify({ runId: "short-run", status: "complete", aic: 0, result: "abc" }));
		const pastEnd = JSON.parse(getConveyorResult({ runId: "short-run", format: "text", offset: 50, limit: 2 }));
		assert.equal(pastEnd.offset, 50);
		assert.equal(pastEnd.nextOffset, null);
		assert.equal(pastEnd.result, "");
	}));

test("getConveyorResult distinguishes running from terminal resultless runs", () =>
	withRuns((runs) => {
		const now = new Date().toISOString();
		const running = runDir(runs, "running-run");
		writeFileSync(
			join(running, "state.json"),
			JSON.stringify({
				status: "running",
				revision: 6,
				ownerPid: process.pid,
				ownerInstanceId: PROCESS_INSTANCE_ID,
				updatedAt: now,
				aic: 0.5,
			}),
		);
		writeLiveOwner(running);
		const pending = JSON.parse(getConveyorResult({ runId: "running-run" }));
		assert.equal(pending.resultAvailable, false);
		assert.equal(pending.status, "running");
		assert.match(pending.guidance, /Wait for the conveyor completion notification; do not poll/);

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
		const terminal = JSON.parse(getConveyorResult({ runId: "interrupted-run" }));
		assert.equal(terminal.resultAvailable, false);
		assert.equal(terminal.status, "interrupted");
		assert.match(terminal.guidance, /Waiting will not produce one/);
		assert.match(terminal.error, /host process exited/);
	}));

test("newer interrupted attempts suppress older terminal results", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "stale-terminal");
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			runId: "stale-terminal",
			status: "complete",
			revision: 1,
			result: { stale: true },
		}));
		writeFileSync(join(dir, "state.json"), JSON.stringify({
			runId: "stale-terminal",
			status: "interrupted",
			revision: 1,
			updatedAt: new Date().toISOString(),
		}));
		writeFileSync(join(dir, "ledger.jsonl"), [
			JSON.stringify({
				type: "attempt_started",
				revision: 2,
				attemptId: "attempt-2",
				startedAt: Date.now(),
			}),
			"",
		].join("\n"));
		const loaded = loadConveyorResult("stale-terminal");
		assert.equal(loaded.status, "interrupted");
		assert.equal(loaded.resultAvailable, false);
	}));

test("stale running state without a fresh owner heartbeat is interrupted", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "stale-heartbeat");
		writeFileSync(join(dir, "state.json"), JSON.stringify({
			runId: "stale-heartbeat",
			status: "running",
			revision: 1,
			heartbeatAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2020-01-01T00:00:00.000Z",
		}));
		assert.equal(
			getConveyorRunActivity("stale-heartbeat").status,
			"interrupted",
		);
	}));

test("getConveyorResult rejects unsafe inputs and malformed artifacts", () =>
	withRuns((runs) => {
		assert.throws(() => getConveyorResult({ runId: "../outside" }), ConveyorResultError);
		assert.throws(() => getConveyorResult({ runId: ".." }), ConveyorResultError);
		assert.throws(() => getConveyorResult({ runId: "bad\nid" }), /bare conveyor run id/);
		assert.throws(() => getConveyorResult({ runId: "missing" }), /Use list_conveyor_runs/);
		assert.throws(() => getConveyorResult({ runId: "missing", offset: -1 }), /offset must be/);
		assert.throws(() => getConveyorResult({ runId: "missing", limit: MAX_RESULT_CHUNK_CHARS + 1 }), /limit must be between/);

		const malformed = runDir(runs, "malformed-run");
		writeFileSync(join(malformed, "run.json"), "{not json");
		assert.throws(() => getConveyorResult({ runId: "malformed-run" }), /malformed JSON/);

		const primitive = runDir(runs, "primitive-run");
		writeFileSync(join(primitive, "run.json"), "false");
		assert.throws(() => getConveyorResult({ runId: "primitive-run" }), /must be a JSON object/);

		const invalid = runDir(runs, "invalid-run");
		writeFileSync(join(invalid, "run.json"), JSON.stringify({ runId: "invalid-run", status: "complete", result: { text: "no" } }));
		assert.deepEqual(JSON.parse(getConveyorResult({ runId: "invalid-run" })).result, { text: "no" });

		const logs = /** @type {string[]} */ ([]);
		conveyorCommand("result ../outside", { log: (message) => logs.push(message) });
		assert.match(logs.at(-1) ?? "", /no run found/);
	}));

test("inspectConveyorRun returns bounded running metadata without result text or args", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "running-inspect");
		const huge = "x".repeat(5000);
		const now = new Date().toISOString();
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({ conveyor: { name: huge }, createdAt: "2026-01-01T00:00:00Z" }));
		writeFileSync(
			join(dir, "state.json"),
			JSON.stringify({
				runId: "running-inspect",
				title: huge,
				status: "running",
				ownerPid: process.pid,
				ownerInstanceId: PROCESS_INSTANCE_ID,
				startedAt: "2026-01-01T00:00:00Z",
				heartbeatAt: now,
				updatedAt: now,
				phase: huge,
				counts: { launched: 1, done: 0, failed: 0, cached: 0, skipped: 0, dropped: 0 },
				running: [{ seq: 1, label: huge, model: huge, phase: huge, branchPath: "/0/2" }],
				groups: [{ gid: 1, kind: huge, phase: huge, n: 1 }],
				recent: [{ label: huge, status: "done", aic: 0.5, error: huge }],
				errors: [{ label: huge, error: huge }],
			}),
		);
		writeLiveOwner(dir);

		const inspected = JSON.parse(inspectConveyorRun({ runId: "running-inspect" }));
		assert.equal(inspected.status, "running");
		assert.equal(inspected.running.length, 1);
		assert.equal(inspected.running[0].branchPath, "/0/2");
		assert.ok(inspected.running[0].label.length <= 500);
		assert.ok(inspected.errors[0].error.length <= 2000);
		assert.equal(inspected.result.available, false);
		assert.equal("args" in inspected, false);
		assert.equal("resultText" in inspected, false);
	}));

test("inspectConveyorRun prefers terminal records, suppresses phantom running agents, and validates results", () =>
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
				revision: 4,
				conveyor: { name: "terminal" },
				args: { secret: "must-not-leak" },
				result: "must-not-leak",
				counts: { agents: 1, launched: 1, done: 1, failed: 0, cached: 0, skipped: 0, dropped: 0 },
				preservedWorktrees: Array.from({ length: 80 }, (_, i) => `/tmp/${i}/${"p".repeat(3000)}`),
			}),
		);
		writeFileSync(
			join(dir, "manifest.json"),
			JSON.stringify({
				parentPermissionMode: "auto",
				parentSessionMode: "autopilot",
				permissionMode: "parent-auto-profile-narrowed",
				permissionInheritance: { fineGrainedRules: "not-exposed-by-parent-sdk" },
			}),
		);

		const text = inspectConveyorRun({ runId: "terminal-inspect" });
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

test("inspectConveyorRun replays ledger progress", () =>
	withRuns((runs) => {
		const replayed = runDir(runs, "replay-inspect");
		writeFileSync(
			join(replayed, "ledger.jsonl"),
			[
				JSON.stringify({ type: "progress", revision: 1, recordedAt: 1, record: { ev: "run_start", meta: { name: "replayed" } } }),
				JSON.stringify({ type: "progress", revision: 2, recordedAt: 2, record: { ev: "run_end", status: "partial", error: "failure", agents: 2, launched: 2, done: 1, failed: 1, cached: 0, skipped: 0, nanoAiu: 500_000_000 } }),
				"",
			].join("\n"),
		);

		const inspected = JSON.parse(inspectConveyorRun({ runId: "replay-inspect" }));
		assert.equal(inspected.status, "partial");
		assert.equal(inspected.conveyor, "replayed");
		assert.equal(inspected.counts.failed, 1);
		assert.equal(inspected.result.available, false);
	}));

test("inspectConveyorRun keeps a previous process instance interrupted after reload", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "reloaded-owner");
		mkdirSync(join(dir, ".lock"), { recursive: true });
		writeFileSync(join(dir, ".lock", "owner.json"), JSON.stringify({
			token: "previous-owner",
			generation: 1,
			pid: process.pid,
			instanceId: "previous-process-instance",
		}));
		writeFileSync(join(dir, "manifest.json"), JSON.stringify({
			conveyor: { name: "reload-test" },
			args: {},
		}));
		writeFileSync(join(dir, "state.json"), JSON.stringify({
			runId: "reloaded-owner",
			status: "running",
			ownerPid: process.pid,
			ownerInstanceId: "previous-process-instance",
			revision: 1,
			updatedAt: new Date().toISOString(),
		}));
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			runId: "reloaded-owner",
			status: "complete",
			revision: 1,
			result: "older attempt",
		}));

		const inspected = JSON.parse(inspectConveyorRun({ runId: "reloaded-owner" }));
		assert.equal(inspected.status, "interrupted");
	}));

test("inspectConveyorRun rejects unsafe and missing run ids", () =>
	withRuns(() => {
		assert.throws(() => inspectConveyorRun({ runId: "../outside" }), ConveyorResultError);
		assert.throws(() => inspectConveyorRun({ runId: "missing" }), /Use list_conveyor_runs/);
	}));

test("agent inspection keeps summaries safe and gates prompt/result content", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "agent-run");
		const key = '["a",[],0,"fp",0]';
		writeFileSync(
			join(dir, "ledger.jsonl"),
			[
				JSON.stringify({ type: "branches_invalidated", revision: 1, generation: 1, branches: [[0]], invalidatedAt: "2026-01-01T00:00:00Z" }),
				JSON.stringify({ type: "agent_started", revision: 2, key, agentSeq: 7, branch: [0, 2], branchPath: "/0/2", label: "reviewer", prompt: "review this file", model: "m" }),
				JSON.stringify({ type: "agent_usage", revision: 3, key, label: "reviewer", sessionId: "session-1", model: "m", outcome: "ok", nanoAiu: 500_000_000, unknownUsage: false }),
				JSON.stringify({ type: "result", revision: 4, kind: "agent", key, value: { label: "reviewer", sessionId: "session-1", model: "m", ok: true, content: "long result" } }),
				JSON.stringify({ type: "progress", revision: 5, recordedAt: 5, record: { ev: "end", agentSeq: 7, label: "reviewer", ok: true } }),
				"",
			].join("\n"),
		);
		const summary = JSON.parse(inspectConveyorAgent({ runId: "agent-run", agent: "session-1" }));
		assert.equal(summary.label, "reviewer");
		assert.equal(summary.branchPath, "/0/2");
		assert.equal(summary.aic, 0.5);
		assert.equal(summary.hasPrompt, true);
		assert.equal(JSON.parse(getConveyorAgentContent({ runId: "agent-run", agent: "reviewer", section: "prompt", limit: 6 })).text, "review");
		assert.equal(JSON.parse(getConveyorAgentContent({ runId: "agent-run", agent: key, section: "result", offset: 5 })).text, "result");
		assert.match(JSON.parse(inspectConveyorAgent({ runId: "agent-run", agent: "reviewer", section: "events" })).text, /"ev":"end"/);
		assert.equal(JSON.parse(inspectConveyorAgent({ runId: "agent-run", agent: "reviewer", section: "usage" })).usage.length, 1);
		assert.throws(() => inspectConveyorAgent({ runId: "agent-run", agent: "missing" }), /no conveyor agent matched/);
	}));

test("agent event inspection scopes repeated agent sequences by attempt", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "attempt-events");
		const records = [
			{ type: "agent_started", revision: 1, key: "a", attemptId: "attempt-a", agentSeq: 1, label: "worker" },
			{ type: "progress", revision: 2, recordedAt: 2, record: { ev: "end", attemptId: "attempt-a", agentSeq: 1, label: "worker", error: "first" } },
			{ type: "agent_started", revision: 3, key: "b", attemptId: "attempt-b", agentSeq: 1, label: "worker" },
			{ type: "progress", revision: 4, recordedAt: 4, record: { ev: "end", attemptId: "attempt-b", agentSeq: 1, label: "worker", error: "second" } },
		];
		writeFileSync(join(dir, "ledger.jsonl"), records.map((record) => JSON.stringify(record)).join("\n") + "\n");
		const events = JSON.parse(inspectConveyorAgent({ runId: "attempt-events", agent: "a", section: "events" })).text;
		assert.match(events, /first/);
		assert.doesNotMatch(events, /second/);
	}));

test("getConveyorProgress pages authoritative revisioned ledger records", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "progress-run");
		const ledger = new Ledger(dir);
		ledger.record("progress", { record: { ev: "phase_enter", phaseId: "phase:0", phase: "review" } });
		ledger.record("progress", { record: { ev: "end", phaseId: "phase:0", phase: "review", agentSeq: 1, label: "a" } });
		ledger.record("progress", { record: { ev: "run_end", status: "complete" } });
		const latest = JSON.parse(getConveyorProgress({ runId: "progress-run", limit: 2 }));
		assert.equal(latest.records.length, 2);
		assert.equal(latest.records.at(-1).ev, "run_end");
		assert.equal(latest.hasMoreOlder, true);
		const older = JSON.parse(getConveyorProgress({ runId: "progress-run", beforeSeq: latest.oldestSeq, limit: 2 }));
		assert.equal(older.records[0].ev, "phase_enter");
		const phase = JSON.parse(getConveyorProgress({ runId: "progress-run", phaseId: "phase:0" }));
		assert.equal(phase.records.length, 2);
		assert.equal(phase.hasMoreNewer, false);
	}));

test("progress and usage inspection are bounded and paginated", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "bounded-inspection");
		const ledger = new Ledger(dir);
		ledger.recordStarted("k", { prompt: "p", label: "worker", model: "m", cacheCwd: "/" }, [], false, 1);
		for (let i = 0; i < 3; i++) {
			ledger.recordUsage("k", {
				nanoAiu: i,
				usageUnknown: false,
				ok: true,
				label: "worker",
				sessionId: "s",
				model: "m",
			});
		}
		ledger.progress({ ev: "end", agentSeq: 1, label: "worker", error: `bad\u0007${"x".repeat(5000)}` });
		ledger.flushProgress();
		const progress = JSON.parse(getConveyorProgress({ runId: "bounded-inspection" }));
		assert.ok(progress.records[0].error.length <= 2000);
		assert.doesNotMatch(progress.records[0].error, /[\u0000-\u001f]/);
		const usage = JSON.parse(inspectConveyorAgent({ runId: "bounded-inspection", agent: "k", section: "usage", offset: 1, limit: 1 }));
		assert.equal(usage.usage.length, 1);
		assert.equal(usage.offset, 1);
		assert.equal(usage.nextOffset, 2);
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
			heartbeatAt: now,
			updatedAt: now,
		}));

		writeLiveOwner(live);
		const ownerless = runDir(runs, "ownerless-stale");
		writeFileSync(join(ownerless, "state.json"), JSON.stringify({
			status: "running",
			updatedAt: old,
		}));

		const locked = runDir(runs, "stale-locked");
		writeFileSync(join(locked, "state.json"), JSON.stringify({
			status: "running",
			heartbeatAt: old,
			updatedAt: old,
		}));
		mkdirSync(join(locked, ".lock"));
		writeFileSync(join(locked, ".lock", "owner.json"), JSON.stringify({
			token: "live",
			generation: 1,
			pid: process.pid,
		}));
		const listing = listConveyorRuns();
		assert.match(listing, /dead-owner\s+interrupted/);
		assert.match(listing, /live-owner\s+running/);
		assert.match(listing, /ownerless-stale\s+interrupted/);
		assert.match(listing, /stale-locked\s+interrupted/);

		const logs = /** @type {string[]} */ ([]);
		conveyorCommand("dead-owner", { log: (message) => logs.push(message) });
		assert.match(logs.at(-1) ?? "", /interrupted/);
		const inspected = JSON.parse(inspectConveyorRun({ runId: "dead-owner" }));
		assert.equal(inspected.status, "interrupted");
		assert.deepEqual(inspected.running, []);
	}));

test("a newer interrupted resume state supersedes an older terminal result", () =>
	withRuns((runs) => {
		const dir = runDir(runs, "interrupted-resume");
		writeFileSync(join(dir, "run.json"), JSON.stringify({
			runId: "interrupted-resume",
			status: "complete",
			revision: 0,
			result: "old",
		}));
		const ledger = new Ledger(dir);
		ledger.startAttempt();
		writeFileSync(join(dir, "state.json"), JSON.stringify({
			runId: "interrupted-resume",
			status: "running",
			revision: 9,
			ownerPid: 2_147_483_647,
			ownerInstanceId: "dead",
			updatedAt: new Date().toISOString(),
		}));
		const loaded = loadConveyorResult("interrupted-resume");
		assert.equal(loaded.status, "interrupted");
		assert.equal(loaded.resultAvailable, false);
	}));

test("conveyorCommand renders latest dashboard, result, artifacts, and summary fallback", () =>
	withRuns((runs) => {
		const logs = /** @type {string[]} */ ([]);
		const ctx = { log: (/** @type {string} */ message) => logs.push(message) };
		conveyorCommand("", ctx);
		assert.match(logs.at(-1) ?? "", /no conveyor runs yet/);

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
		writeFileSync(join(full, "run.json"), JSON.stringify({ runId: "full-run", status: "complete", revision: 1, result: "hello" }));

		conveyorCommand("latest", ctx);
		assert.match(logs.at(-1) ?? "", /conveyor: demo/);
		conveyorCommand("result full-run", ctx);
		assert.equal(logs.at(-1), "hello");
		writeFileSync(join(full, "run.json"), JSON.stringify({ runId: "full-run", status: "complete", revision: 2, result: { ok: true } }));
		conveyorCommand("result full-run", ctx);
		assert.equal(logs.at(-1), '{\n  "ok": true\n}');
		conveyorCommand("artifacts full-run", ctx);
		assert.match(logs.at(-1) ?? "", /run\.json/);

		const summary = runDir(runs, "summary-run");
		writeFileSync(join(summary, "run.json"), JSON.stringify({ status: "complete", counts: { agents: 1, done: 1, cached: 0, skipped: 0, failed: 0 }, aic: 0.5 }));
		conveyorCommand("summary-run", ctx);
		assert.match(logs.at(-1) ?? "", /conveyor run summary-run/);
	}));

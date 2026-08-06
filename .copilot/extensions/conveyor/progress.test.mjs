/** @module progress.test — event application, narration fidelity, group tracking, persistence. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ProgressReporter } from "./progress.mjs";
import { tmpDir } from "./fixtures/support.mjs";

/** @param {(l: string) => void} [onLine] */
const reporter = (onLine) => new ProgressReporter({ runId: "r", write: false, onLine });

test("narration carries a log level: failures error, skips warning, ok/cached info", () => {
	const levels = /** @type {(string|undefined)[]} */ ([]);
	const metas = /** @type {({ ephemeral?: boolean }|undefined)[]} */ ([]);
	const p = new ProgressReporter({ runId: "r", write: false, onLine: (_line, level, meta) => (levels.push(level), metas.push(meta)) });
	p.emit({ ev: "end", seq: 1, label: "ok", ok: true, nanoAiu: 0 });
	p.emit({ ev: "end", seq: 2, label: "hit", cached: true, nanoAiu: 0 });
	p.emit({ ev: "end", seq: 3, label: "skip", skipped: true, error: "budget" });
	p.emit({ ev: "end", seq: 4, label: "err", ok: false, error: "boom" });
	assert.deepEqual(levels, ["info", "info", "warning", "error"]);
	assert.deepEqual(metas.map((m) => m?.ephemeral), [true, true, false, false]);
});

test("agent end events update counts, AIC, and tokens", () => {
	const p = reporter();
	p.emit({ ev: "run_start", runId: "r" });
	p.emit({ ev: "end", seq: 1, label: "a", ok: true, nanoAiu: 500_000_000, outputTokens: 10, model: "m" });
	p.emit({ ev: "end", seq: 2, label: "b", cached: true, nanoAiu: 250_000_000 });
	p.emit({ ev: "end", seq: 3, label: "c", skipped: true, error: "skipped: budget" });
	p.emit({ ev: "end", seq: 4, label: "d", ok: false, error: "boom" });
	const s = /** @type {any} */ (p.snapshot());
	assert.equal(s.counts.done, 1);
	assert.equal(s.counts.cached, 1);
	assert.equal(s.counts.skipped, 1);
	assert.equal(s.counts.failed, 1);
	assert.equal(s.aic, 0.75);
	assert.equal(s.errors.length, 1);
});

test("different progress revisions retain one agent identity from start through end", () => {
	const p = reporter();
	p.emit({ ev: "start", agentSeq: 9, revision: 20, label: "a" });
	assert.equal(/** @type {any} */ (p.snapshot()).running.length, 1);
	p.emit({ ev: "end", agentSeq: 9, revision: 21, label: "a", ok: true, nanoAiu: 0 });
	assert.equal(/** @type {any} */ (p.snapshot()).running.length, 0);
});

test("narration shows AIC/tokens/model for successful agents", () => {
	const lines = /** @type {string[]} */ ([]);
	const p = reporter((l) => lines.push(l));
	p.emit({ ev: "end", seq: 1, label: "ok", ok: true, nanoAiu: 500_000_000, outputTokens: 12, model: "gpt" });
	p.emit({ ev: "end", seq: 2, label: "hit", cached: true, nanoAiu: 0 });
	p.emit({ ev: "end", seq: 3, label: "skip", skipped: true, error: "skipped: budget" });
	p.emit({ ev: "end", seq: 4, label: "err", ok: false, error: "kaboom" });
	assert.match(lines[0], /OK\s+ok\s+0\.5000 AIC\s+12 tok\s+\[gpt\]/);
	assert.match(lines[1], /HIT\s+hit.*\(cached\)/);
	assert.match(lines[2], /SKIP\s+skip\s+\(skipped: budget\)/);
	assert.match(lines[3], /ERR\s+err.*ERROR: kaboom/);
});

test("group_start/group_end are narrated and tracked in the snapshot", () => {
	const lines = /** @type {string[]} */ ([]);
	const p = reporter((l) => lines.push(l));
	p.emit({ ev: "group_start", gid: 1, kind: "pipeline", n: 3, phase: "scan" });
	let s = /** @type {any} */ (p.snapshot());
	assert.equal(s.groups.length, 1);
	assert.equal(s.groups[0].kind, "pipeline");
	p.emit({ ev: "group_end", gid: 1, kind: "pipeline", n: 3 });
	s = p.snapshot();
	assert.equal(s.groups.length, 0);
	assert.match(lines[0], /pipeline launched \(3\)/);
	assert.match(lines[1], /pipeline settled \(3\)/);
});

test("declared phase observations track entries, duration, agents, and revision", () => {
	const p = new ProgressReporter({
		runId: "r",
		write: false,
		meta: { phases: [{ id: "phase:0", ordinal: 0, title: "review", detail: "Inspect" }] },
	});
	p.emit({ ev: "phase_enter", revision: 4, phaseId: "phase:0", phase: "review", invocationId: "i", ordinal: 0 });
	p.emit({ ev: "start", revision: 5, seq: 1, label: "a", phase: "review" });
	p.emit({ ev: "end", revision: 6, seq: 1, label: "a", phase: "review", ok: true, nanoAiu: 0 });
	p.emit({ ev: "phase_exit", revision: 7, phaseId: "phase:0", phase: "review", invocationId: "i", durationMs: 12 });
	const state = /** @type {any} */ (p.snapshot());
	assert.equal(state.revision, 7);
	assert.equal(state.phases[0].status, "completed");
	assert.equal(state.phases[0].entryCount, 1);
	assert.equal(state.phases[0].totalAgentCount, 1);
	assert.equal(state.phases[0].accumulatedActiveMs, 12);
});

test("dropped group items are counted, persisted as errors, and narrated", () => {
	const lines = /** @type {string[]} */ ([]);
	const p = reporter((line) => lines.push(line));
	p.emit({ ev: "drop", gid: 1, kind: "pipeline", index: 2, error: "bad item" });
	const s = /** @type {any} */ (p.snapshot());
	assert.equal(s.counts.dropped, 1);
	assert.equal(s.errors[0].label, "pipeline[2]");
	assert.match(lines[0], /DROP pipeline\[2\].*bad item/);
});

test("dashboard mode emits TUI snapshots and suppresses successful per-agent lines", () => {
	const lines = /** @type {string[]} */ ([]);
	const metas = /** @type {({ ephemeral?: boolean }|undefined)[]} */ ([]);
	const p = new ProgressReporter({ runId: "r1", title: "demo", write: false, dashboard: true, dashboardIntervalMs: 0, onLine: (l, _level, meta) => (lines.push(l), metas.push(meta)) });
	p.emit({ ev: "run_start", runId: "r1" });
	p.emit({ ev: "start", seq: 1, label: "scan-file", model: "m", phase: "scan" });
	p.emit({ ev: "end", seq: 1, label: "scan-file", ok: true, nanoAiu: 500_000_000, outputTokens: 12, model: "m", phase: "scan" });
	p.close("complete");
	assert.ok(lines.some((l) => /conveyor: demo · running/.test(l)));
	assert.ok(lines.some((l) => /phase: scan/.test(l)));
	assert.ok(lines.some((l) => /└─ inspect: \/conveyor r1/.test(l)));
	assert.ok(!lines.some((l) => /^\s*OK\s+scan-file/.test(l)));
	assert.ok(metas.filter((m) => m?.ephemeral === true).length >= 2);
});

test("dashboard mode still surfaces failed/skipped agent lines", () => {
	const lines = /** @type {string[]} */ ([]);
	const levels = /** @type {(string|undefined)[]} */ ([]);
	const metas = /** @type {({ ephemeral?: boolean }|undefined)[]} */ ([]);
	const p = new ProgressReporter({ runId: "r2", write: false, dashboard: true, dashboardIntervalMs: 0, onLine: (l, level, meta) => (lines.push(l), levels.push(level), metas.push(meta)) });
	p.emit({ ev: "end", seq: 1, label: "bad", ok: false, error: "boom", nanoAiu: 0 });
	p.emit({ ev: "end", seq: 2, label: "skip", skipped: true, error: "skipped: budget", nanoAiu: 0 });
	assert.ok(lines.some((l) => /ERR\s+bad/.test(l)));
	assert.ok(lines.some((l) => /SKIP\s+skip/.test(l)));
	assert.ok(levels.includes("error"));
	assert.ok(levels.includes("warning"));
	assert.ok(metas.some((m) => m?.ephemeral === false));
});

test("runSummary is a one-line conveyor-style rollup", () => {
	const p = reporter();
	p.emit({ ev: "end", seq: 1, label: "a", ok: true, nanoAiu: 1_000_000_000, outputTokens: 1, model: "m" });
	p.emit({ ev: "end", seq: 2, label: "b", cached: true, nanoAiu: 0 });
	assert.match(p.runSummary(), /— conveyor: 2 agents \(1 cached, 0 skipped, 0 failed, 0 dropped\), 1\.0 AIC, [\d.]+s/);
});

test("control characters in labels/errors are sanitized in narration", () => {
	const lines = /** @type {string[]} */ ([]);
	const p = reporter((l) => lines.push(l));
	p.emit({ ev: "end", seq: 1, label: "a\u001bb\nc", ok: false, error: "e\u0007r\nr" });
	assert.ok(!/[\u0000-\u001f]/.test(lines[0]), "no raw control chars in output");
});

test("state.json is written and reflects status on close", () => {
	const dir = tmpDir();
	const path = join(dir, "state.json");
	const p = new ProgressReporter({ runId: "r", writeState: (state) => writeFileSync(path, JSON.stringify(state)), onLine: () => {} });
	p.emit({ ev: "run_start", runId: "r" });
	p.emit({ ev: "end", seq: 1, label: "a", ok: true, nanoAiu: 0, outputTokens: 0, model: "m" });
	p.close("complete");
	assert.ok(existsSync(join(dir, "state.json")));
	const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
	assert.equal(state.status, "complete");
	assert.equal(state.counts.done, 1);
	assert.equal(state.ownerPid, process.pid);
	assert.equal(typeof state.ownerInstanceId, "string");
});

test("state.json receives the trailing state from a burst of events", async () => {
	const dir = tmpDir();
	const path = join(dir, "state.json");
	const p = new ProgressReporter({ runId: "r", writeState: (state) => writeFileSync(path, JSON.stringify(state)), onLine: () => {} });
	p.emit({ ev: "run_start", runId: "r" });
	p.emit({ ev: "group_start", gid: 1, kind: "pipeline", n: 2, phase: "research" });
	p.emit({ ev: "start", seq: 1, label: "slow", model: "m", phase: "research" });
	await new Promise((resolve) => setTimeout(resolve, 200));
	const state = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(state.phase, "research");
	assert.equal(state.running.length, 1);
	assert.equal(state.running[0].label, "slow");
	assert.equal(state.groups.length, 1);
	p.close("complete");
});

test("state updatedAt tracks progress events and terminal close", async () => {
	const dir = tmpDir();
	const path = join(dir, "state.json");
	const p = new ProgressReporter({ runId: "heartbeat", writeState: (state) => writeFileSync(path, JSON.stringify(state)), onLine: () => {} });
	p.emit({ ev: "run_start", runId: "heartbeat" });
	const first = JSON.parse(readFileSync(path, "utf8")).updatedAt;
	await new Promise((resolve) => setTimeout(resolve, 5));
	p.emit({ ev: "start", seq: 1, label: "active" });
	await new Promise((resolve) => setTimeout(resolve, 200));
	const live = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(live.status, "running");
	assert.ok(Date.parse(live.updatedAt) > Date.parse(first));
	p.close("complete");
	const closed = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(closed.status, "complete");
	assert.equal(closed.ownerGeneration, null);
});

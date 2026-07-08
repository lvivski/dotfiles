/** @module progress.test — event application, narration fidelity, group tracking, persistence. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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
	assert.equal(s.outputTokens, 10);
	assert.equal(s.errors.length, 1);
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
	p.emit({ ev: "group_start", gid: 1, kind: "fanOut", n: 3, phase: "scan" });
	let s = /** @type {any} */ (p.snapshot());
	assert.equal(s.groups.length, 1);
	assert.equal(s.groups[0].kind, "fanOut");
	p.emit({ ev: "group_end", gid: 1, kind: "fanOut", n: 3 });
	s = p.snapshot();
	assert.equal(s.groups.length, 0);
	assert.match(lines[0], /fanOut launched \(3\)/);
	assert.match(lines[1], /fanOut settled \(3\)/);
});

test("dashboard mode emits TUI snapshots and suppresses successful per-agent lines", () => {
	const lines = /** @type {string[]} */ ([]);
	const metas = /** @type {({ ephemeral?: boolean }|undefined)[]} */ ([]);
	const p = new ProgressReporter({ runId: "r1", title: "demo", write: false, dashboard: true, dashboardIntervalMs: 0, onLine: (l, _level, meta) => (lines.push(l), metas.push(meta)) });
	p.emit({ ev: "run_start", runId: "r1" });
	p.emit({ ev: "start", seq: 1, label: "scan-file", model: "m", phase: "scan" });
	p.emit({ ev: "end", seq: 1, label: "scan-file", ok: true, nanoAiu: 500_000_000, outputTokens: 12, model: "m", phase: "scan" });
	p.close("complete");
	assert.ok(lines.some((l) => /workflow: demo · running/.test(l)));
	assert.ok(lines.some((l) => /phase: scan/.test(l)));
	assert.ok(lines.some((l) => /└─ inspect: \/wf r1/.test(l)));
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

test("runSummary is a one-line workflow-style rollup", () => {
	const p = reporter();
	p.emit({ ev: "end", seq: 1, label: "a", ok: true, nanoAiu: 1_000_000_000, outputTokens: 1, model: "m" });
	p.emit({ ev: "end", seq: 2, label: "b", cached: true, nanoAiu: 0 });
	assert.match(p.runSummary(), /— workflow: 2 agents \(1 cached, 0 skipped, 0 failed\), 1\.0 AIC, [\d.]+s/);
});

test("control characters in labels/errors are sanitized in narration", () => {
	const lines = /** @type {string[]} */ ([]);
	const p = reporter((l) => lines.push(l));
	p.emit({ ev: "end", seq: 1, label: "a\u001bb\nc", ok: false, error: "e\u0007r\nr" });
	assert.ok(!/[\u0000-\u001f]/.test(lines[0]), "no raw control chars in output");
});

test("state.json is written and reflects status on close", () => {
	const dir = tmpDir();
	const p = new ProgressReporter({ runId: "r", statePath: join(dir, "state.json"), onLine: () => {} });
	p.emit({ ev: "run_start", runId: "r" });
	p.emit({ ev: "end", seq: 1, label: "a", ok: true, nanoAiu: 0, outputTokens: 0, model: "m" });
	p.close("complete");
	assert.ok(existsSync(join(dir, "state.json")));
	const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
	assert.equal(state.status, "complete");
	assert.equal(state.counts.done, 1);
});

test("progress.jsonl buffers events and flushes all records on close", () => {
	const dir = tmpDir();
	const path = join(dir, "progress.jsonl");
	const p = new ProgressReporter({ runId: "r", jsonlPath: path, onLine: () => {} });
	p.emit({ ev: "run_start", runId: "r" });
	for (let i = 0; i < 5; i++) p.emit({ ev: "end", seq: i, label: "a" + i, ok: true, nanoAiu: 0 });
	p.close("complete");
	const lines = readFileSync(path, "utf8").trim().split("\n");
	assert.equal(lines.length, 6);
	assert.deepEqual(lines.map((l) => JSON.parse(l).ev), ["run_start", "end", "end", "end", "end", "end"]);
});

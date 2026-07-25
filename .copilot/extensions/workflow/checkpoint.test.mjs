/** @module checkpoint.test — append-only journal cache: put/get, resume, prior spend, repair, schema. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { CheckpointStore } from "./checkpoint.mjs";
import { tmpDir, mkResult } from "./fixtures/support.mjs";

test("group branch blocks are durable and reject overlapping journal records", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	assert.equal(store.reserveBranches([], "fast", 2), 0);
	assert.equal(store.reserveBranches([], "slow", 2), 2);
	assert.equal(store.reserveBranches([0], "nested", 3), 0);
	// Reserving again is idempotent, whatever order the groups start in on a resume.
	assert.equal(store.reserveBranches([], "fast", 2), 0);

	const resumed = new CheckpointStore(dir, { resume: true });
	assert.equal(resumed.reserveBranches([], "slow", 2), 2);
	assert.equal(resumed.reserveBranches([], "fast", 2), 0);
	assert.equal(resumed.reserveBranches([0], "nested", 3), 0);
	assert.equal(resumed.reserveBranches([], "new", 1), 4);

	// A corrupt record overlapping an existing block is dropped, but still reserves the range it
	// claimed so the next allocation cannot be handed branches another group may have used.
	appendFileSync(join(dir, "journal.jsonl"), JSON.stringify({ type: "group", parent: [], site: "bogus", base: 3, size: 4 }) + "\n");
	const repaired = new CheckpointStore(dir, { resume: true });
	assert.equal(repaired.reserveBranches([], "fast", 2), 0, "existing blocks survive");
	assert.equal(repaired.reserveBranches([], "bogus", 4), 7, "overlapping record is not reused and its tail is reserved");
});

test("put/get round-trip and durable append", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	assert.equal(store.get("k1"), undefined);
	store.put("k1", mkResult({ content: "one" }));
	assert.equal(store.get("k1")?.content, "one");
	const lines = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).type, "result");
});

test("first write wins (duplicate key ignored)", () => {
	const store = new CheckpointStore(tmpDir());
	store.put("k", mkResult({ content: "first" }));
	store.put("k", mkResult({ content: "second" }));
	assert.equal(store.get("k")?.content, "first");
});

test("resume loads prior results, flags cached, accumulates prior spend", () => {
	const dir = tmpDir();
	const a = new CheckpointStore(dir);
	const one = mkResult({ content: "one", aic: 0.5 });
	const two = mkResult({ content: "two", aic: 0.25 });
	a.recordUsage("k1", one);
	a.put("k1", one);
	a.recordUsage("k2", two);
	a.put("k2", two);
	const b = new CheckpointStore(dir, { resume: true });
	assert.equal(b.get("k1")?.content, "one");
	assert.equal(b.get("k1")?.cached, true);
	assert.equal(b.priorSpent, 0.75);
});

test("torn trailing line is repaired; earlier records survive", () => {
	const dir = tmpDir();
	const path = join(dir, "journal.jsonl");
	writeFileSync(path, JSON.stringify({ type: "result", key: "k1", result: mkResult({ content: "one" }) }) + "\n", "utf8");
	appendFileSync(path, '{"v":1,"key":"k2","result": {"content": "tor', "utf8"); // crash mid-write, no newline
	const store = new CheckpointStore(dir, { resume: true });
	assert.equal(store.get("k1")?.content, "one");
	assert.equal(store.get("k2"), undefined);
});

test("fresh (non-resume) run reusing a dir drops stale checkpoints eagerly", () => {
	const dir = tmpDir();
	new CheckpointStore(dir).put("stale", mkResult());
	new CheckpointStore(dir); // no resume — truncates immediately, before any put
	// Even without a put, a subsequent resume sees nothing stale.
	const reloaded = new CheckpointStore(dir, { resume: true });
	assert.equal(reloaded.get("stale"), undefined);
});

test("usage records accumulate failed spend separately from cacheable results", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	store.recordUsage("bad", mkResult({ ok: false, error: "boom", aic: 0.4, nanoAiu: 400_000_000 }));
	store.recordUsage("unknown", mkResult({ ok: false, error: "timeout", aic: null, nanoAiu: null, usageUnknown: true }));
	const resumed = new CheckpointStore(dir, { resume: true });
	assert.equal(resumed.priorSpent, 0.4);
	assert.equal(resumed.priorUnknownUsage, 1);
	assert.equal(resumed.get("bad"), undefined, "usage records are not cacheable results");
});

test("repeated approvals persist the newest ceiling and do not latch", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	store.recordControl({ action: "budget_increased", from: 1, to: 3, spent: 1 });
	store.recordControl({ action: "budget_increased", from: 3, to: 9, spent: 3 });
	const resumed = new CheckpointStore(dir, { resume: true });
	assert.equal(resumed.latestBudget, 9, "the newest approved ceiling wins");
	assert.equal(resumed.budgetIncreaseDeclined, false, "approvals never stop future requests");
});

test("a declined increase latches across resume", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	store.recordControl({ action: "budget_increased", from: 1, to: 3, spent: 1 });
	store.recordControl({ action: "budget_increase_declined", from: 3, proposed: 6, spent: 3 });
	const resumed = new CheckpointStore(dir, { resume: true });
	assert.equal(resumed.latestBudget, 3);
	assert.equal(resumed.budgetIncreaseDeclined, true, "a resumed run must not re-ask after a refusal");
});

test("selective invalidation generations persist and apply to descendants only", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	assert.equal(store.invalidationEpoch([]), 0);
	assert.equal(store.invalidate([[0], [2, 1]]), 1);
	assert.equal(store.invalidationEpoch([0]), 1);
	assert.equal(store.invalidationEpoch([0, 4]), 1);
	assert.equal(store.invalidationEpoch([1]), 0);
	assert.equal(store.invalidationEpoch([2]), 0);
	assert.equal(store.invalidationEpoch([2, 1, 3]), 1);

	const resumed = new CheckpointStore(dir, { resume: true });
	assert.equal(resumed.invalidationEpoch([0, 9]), 1);
	assert.equal(resumed.invalidate([[0]]), 2);
	assert.equal(resumed.invalidationEpoch([0]), 2);
	assert.equal(resumed.invalidationEpoch([2, 1]), 1);
	const generations = readFileSync(join(dir, "journal.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((record) => record.action === "branches_invalidated")
		.map((record) => record.generation);
	assert.deepEqual(generations, [1, 2]);
});

test("read-only journal lookup never repairs or appends", () => {
	const dir = tmpDir();
	const path = join(dir, "journal.jsonl");
	const intact = JSON.stringify({ type: "control", action: "budget_increased", to: 3 }) + "\n";
	const torn = '{"v":3,"type":"usage"';
	writeFileSync(path, intact + torn);
	const before = readFileSync(path, "utf8");
	const store = new CheckpointStore(dir, { resume: true, readOnly: true });
	assert.equal(store.latestBudget, 3);
	assert.equal(readFileSync(path, "utf8"), before);
	assert.throws(() => store.recordControl({ action: "x" }), /read-only/);
});

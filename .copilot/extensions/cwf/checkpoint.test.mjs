/** @module checkpoint.test — append-only journal cache: put/get, resume, prior spend, repair, schema. */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import { CheckpointStore, CACHE_SCHEMA } from "./checkpoint.mjs";
import { tmpDir, mkResult } from "./fixtures/support.mjs";

test("put/get round-trip and durable append", () => {
	const dir = tmpDir();
	const store = new CheckpointStore(dir);
	assert.equal(store.get("k1"), undefined);
	store.put("k1", mkResult({ content: "one" }));
	assert.equal(store.get("k1")?.content, "one");
	assert.equal(store.count, 1);
	const lines = readFileSync(join(dir, "journal.jsonl"), "utf8").trim().split("\n");
	assert.equal(lines.length, 1);
	assert.equal(JSON.parse(lines[0]).v, CACHE_SCHEMA);
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
	a.put("k1", mkResult({ content: "one", aic: 0.5 }));
	a.put("k2", mkResult({ content: "two", aic: 0.25 }));
	const b = new CheckpointStore(dir, { resume: true });
	assert.equal(b.get("k1")?.content, "one");
	assert.equal(b.get("k1")?.cached, true);
	assert.equal(b.priorSpent, 0.75);
});

test("torn trailing line is repaired; earlier records survive", () => {
	const dir = tmpDir();
	const path = join(dir, "journal.jsonl");
	writeFileSync(path, JSON.stringify({ v: CACHE_SCHEMA, key: "k1", result: mkResult({ content: "one" }) }) + "\n", "utf8");
	appendFileSync(path, '{"v":1,"key":"k2","result": {"content": "tor', "utf8"); // crash mid-write, no newline
	const store = new CheckpointStore(dir, { resume: true });
	assert.equal(store.get("k1")?.content, "one");
	assert.equal(store.get("k2"), undefined);
});

test("records with a mismatched cache schema version are ignored", () => {
	const dir = tmpDir();
	const path = join(dir, "journal.jsonl");
	writeFileSync(path, JSON.stringify({ v: 999, key: "old", result: mkResult() }) + "\n", "utf8");
	const store = new CheckpointStore(dir, { resume: true });
	assert.equal(store.get("old"), undefined);
	assert.equal(store.count, 0);
});

test("fresh (non-resume) run reusing a dir drops stale checkpoints eagerly", () => {
	const dir = tmpDir();
	new CheckpointStore(dir).put("stale", mkResult());
	new CheckpointStore(dir); // no resume — truncates immediately, before any put
	// Even without a put, a subsequent resume sees nothing stale.
	const reloaded = new CheckpointStore(dir, { resume: true });
	assert.equal(reloaded.count, 0);
	assert.equal(reloaded.get("stale"), undefined);
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	LostLeaseError,
	LockedError,
	Persistence,
	atomicWriteJson,
	readJsonFile,
} from "./persistence.mjs";
import { tmpDir } from "./fixtures/support.mjs";

const manifest = (/** @type {string} */ runId) => ({
	runId,
	backend: "cli",
});

test("atomicWriteJson replaces a complete parseable artifact", () => {
	const dir = tmpDir();
	const path = join(dir, "state.json");
	atomicWriteJson(path, { value: 1 });
	atomicWriteJson(path, { value: 2 });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { value: 2 });
	assert.equal(existsSync(path), true);
});

test("one live process owns a run and release permits a new generation", () => {
	const dir = tmpDir();
	const first = new Persistence(dir, { runId: "r" });
	const lease1 = first.acquire();
	assert.throws(() => new Persistence(dir, { runId: "r" }).acquire(), LockedError);
	const generation1 = lease1.generation;
	lease1.release();
	const lease2 = new Persistence(dir, { runId: "r" }).acquire();
	assert.equal(lease2.generation, generation1 + 1);
	lease2.release();
});

test("dead-owner takeover fences the stale lease", () => {
	const dir = tmpDir();
	const first = new Persistence(dir, { runId: "r" });
	const lease1 = first.acquire();
	lease1.release();

	mkdirSync(first.lockPath);
	writeFileSync(first.generationPath, "1");
	writeFileSync(first.ownerPath, JSON.stringify({ token: "dead", generation: 1, pid: 2_147_483_647 }));
	const second = new Persistence(dir, { runId: "r" });
	const lease2 = second.acquire();
	assert.throws(() => lease1.assertOwned(), LostLeaseError);
	lease2.release();
});

test("manifest is immutable and required for resume", () => {
	const dir = tmpDir();
	const store = new Persistence(dir, { runId: "r" });
	store.ensureManifest(manifest("r"));
	assert.deepEqual(readJsonFile(join(dir, "manifest.json")), manifest("r"));
	assert.throws(() => store.ensureManifest(manifest("r")), /already exists/);
	assert.doesNotThrow(() => store.ensureManifest(manifest("r"), { resume: true }));

	const old = new Persistence(tmpDir(), { runId: "old" });
	assert.throws(() => old.ensureManifest(manifest("old"), { resume: true }), /has no manifest/);
});

test("stale leases cannot write run artifacts", () => {
	const dir = tmpDir();
	const store = new Persistence(dir, { runId: "r" });
	const lease = store.acquire();
	store.writeJson(lease, "state.json", { status: "running" });
	lease.release();
	assert.throws(() => store.writeJson(lease, "state.json", { status: "bad" }), LostLeaseError);
});

test("a lease that lost ownership refuses further writes", () => {
	const dir = tmpDir();
	const store = new Persistence(dir, { runId: "r" });
	const lease = store.acquire();
	writeFileSync(store.ownerPath, JSON.stringify({ token: "other", generation: lease.generation }));
	assert.throws(() => lease.assertOwned(), LostLeaseError);
	assert.throws(() => store.writeJson(lease, "state.json", { status: "bad" }), LostLeaseError);
	lease.release();
});

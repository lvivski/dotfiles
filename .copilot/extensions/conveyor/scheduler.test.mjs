/** @module scheduler.test — semaphore, run stats, and budget-stop primitives. */
import test from "node:test";
import assert from "node:assert/strict";
import { cpus } from "node:os";

import { BudgetExceeded, defaultConcurrency, RunStats, Semaphore } from "./scheduler.mjs";

test("defaultConcurrency follows the documented CPU-derived bounds", () => {
	const cpu = cpus()?.length || 4;
	assert.equal(defaultConcurrency(), Math.min(16, Math.max(2, cpu - 1)));
});

test("Semaphore bounds concurrent acquisition and releases waiters FIFO", async () => {
	const sem = new Semaphore(1);
	const events = /** @type {string[]} */ ([]);
	await sem.acquire();
	const second = sem.acquire().then(() => events.push("second"));
	const third = sem.acquire().then(() => events.push("third"));
	await Promise.resolve();
	assert.deepEqual(events, []);

	sem.release();
	await second;
	assert.deepEqual(events, ["second"]);
	sem.release();
	await third;
	assert.deepEqual(events, ["second", "third"]);
	sem.release();
});

test("Semaphore clamps non-positive limits to one permit", async () => {
	const sem = new Semaphore(0);
	await sem.acquire();
	let acquired = false;
	const blocked = sem.acquire().then(() => {
		acquired = true;
	});
	await Promise.resolve();
	assert.equal(acquired, false);
	sem.release();
	await blocked;
	assert.equal(acquired, true);
	sem.release();
});

test("RunStats classifies done, failed, cached, and skipped results", () => {
	const stats = new RunStats();
	stats.record({ ok: true, cached: false, skipped: false, error: null, nanoAiu: 500_000_000, usageUnknown: false });
	stats.record({ ok: true, cached: true, skipped: false, error: null, nanoAiu: 500_000_000, usageUnknown: false });
	stats.record({ ok: false, cached: false, skipped: true, error: "skipped: budget reached", nanoAiu: 0, usageUnknown: false });
	stats.record({ ok: false, cached: false, skipped: false, error: "boom", nanoAiu: 250_000_000, usageUnknown: false });
	stats.record({ ok: false, cached: false, skipped: false, error: "skipped: run aborting", nanoAiu: 0, usageUnknown: false });

	assert.equal(stats.agentCount, 5);
	assert.equal(stats.nanoAiu, 1_250_000_000);
	assert.deepEqual(stats.counts(), { agents: 5, launched: 2, done: 1, failed: 1, cached: 1, skipped: 2, unknownUsage: 0 });
	const copy = stats.counts();
	copy.done = 99;
	assert.equal(stats.counts().done, 1, "counts() returns a defensive copy");
});

test("BudgetExceeded is an Error subclass with the supplied message", () => {
	const err = new BudgetExceeded("budget reached");
	assert.ok(err instanceof Error);
	assert.ok(err instanceof BudgetExceeded);
	assert.equal(err.message, "budget reached");
});

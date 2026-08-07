import test from "node:test";
import assert from "node:assert/strict";

import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Ledger } from "./ledger.mjs";
import { mkResult, tmpDir } from "./fixtures/support.mjs";
import { LostLeaseError } from "./persistence.mjs";

test("ledger persists attempts, resources, approvals, and monotonic revisions", async () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.approve({ maxTotalAgents: 2 }, { maxTotalAgents: 2 });
	const attempt = ledger.startAttempt();
	ledger.admitAgent();
	ledger.recordUsage("agent", { nanoAiu: 250_000_000, usageUnknown: false });
	await new Promise((resolve) => setTimeout(resolve, 5));
	ledger.finishAttempt(attempt, "complete");
	const revision = ledger.revision;

	const loaded = new Ledger(dir, { readOnly: true });
	assert.equal(loaded.revision, revision);
	assert.equal(loaded.consumed.spawnedAgents, 1);
	assert.equal(loaded.consumed.nanoAiu, 250_000_000);
	assert.ok(loaded.consumed.activeMs >= 0);
	assert.deepEqual(loaded.approvedLimits, { maxTotalAgents: 2 });
});

test("ledger accounts an interrupted open attempt through its last durable record", async () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.startAttempt();
	await new Promise((resolve) => setTimeout(resolve, 5));
	ledger.record("progress", { record: { ev: "tick" } });
	const loaded = new Ledger(dir, { readOnly: true });
	assert.ok(loaded.consumed.activeMs >= 1);
	assert.ok(loaded.consumed.activeMs < 1000);
});

test("ledger repairs a torn trailing record before appending", () => {
	const dir = tmpDir();
	const first = new Ledger(dir);
	first.record("one");
	appendFileSync(join(dir, "ledger.jsonl"), '{"type":"broken"');
	const resumed = new Ledger(dir);
	resumed.record("two");
	const loaded = new Ledger(dir, { readOnly: true });
	assert.equal(loaded.revision, 2);
});

test("ledger persists cache values, branch blocks, and invalidation epochs", () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.put("agent", mkResult({ content: "one" }));
	for (const [key, value] of [["null", null], ["false", false], ["zero", 0], ["empty", ""]]) ledger.put(key, value, "step");
	assert.equal(ledger.reserveBranches([], "fast", 2), 0);
	assert.equal(ledger.reserveBranches([], "slow", 2), 2);
	assert.equal(ledger.reserveBranches([0], "nested", 3), 0);
	assert.equal(ledger.invalidate([[0], [2, 1]]), 1);

	const resumed = new Ledger(dir);
	const cachedAgent = resumed.get("agent");
	assert.ok(cachedAgent && typeof cachedAgent === "object" && "content" in cachedAgent && "cached" in cachedAgent);
	assert.equal(cachedAgent.content, "one");
	assert.equal(cachedAgent.cached, true);
	for (const [key, value] of [["null", null], ["false", false], ["zero", 0], ["empty", ""]]) {
		assert.deepEqual(resumed.lookup(key), { hit: true, value });
	}
	assert.equal(resumed.reserveBranches([], "slow", 2), 2);
	assert.equal(resumed.reserveBranches([], "fast", 2), 0);
	assert.equal(resumed.reserveBranches([], "new", 1), 4);
	assert.equal(resumed.invalidationEpoch([0, 9]), 1);
	assert.equal(resumed.invalidationEpoch([1]), 0);
	assert.equal(resumed.invalidationEpoch([2, 1, 3]), 1);
});

test("ledger records agent details once and persists limit refusal", () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	const result = mkResult({ content: "one", aic: 0.5, nanoAiu: 500_000_000 });
	ledger.recordStarted("k", { prompt: "secret", label: "review", model: "m", cacheCwd: "/tmp" }, [0], false);
	ledger.recordUsage("k", result);
	ledger.put("k", result);
	ledger.approve({ maxAiCredits: 1 }, { maxAiCredits: 3 });
	ledger.declineLimits({ maxAiCredits: 6 });

	const resumed = new Ledger(dir);
	assert.equal(resumed.consumed.nanoAiu, 500_000_000);
	const cached = resumed.get("k");
	assert.ok(cached && typeof cached === "object" && "content" in cached);
	assert.equal(cached.content, "one");
	assert.deepEqual(resumed.approvedLimits, { maxAiCredits: 3 });
	assert.equal(resumed.budgetIncreaseDeclined, true);
	const records = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.filter((record) => record.type === "agent_usage").length, 1);
	assert.equal(records.find((record) => record.type === "agent_started").prompt, undefined);
	assert.equal(typeof records.find((record) => record.type === "agent_started").promptHash, "string");
});

test("progress revisions become durable only on flush and stay ordered before critical records", () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	const first = ledger.progress({ ev: "start", agentSeq: 1 });
	const second = ledger.progress({ ev: "end", agentSeq: 1 });
	assert.equal(first.revision, 0);
	assert.equal(second.revision, 0);
	assert.equal(ledger.revision, 0);
	ledger.admitAgent();
	const records = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.deepEqual(records.map((record) => record.type), ["progress", "progress", "agent_admitted"]);
	assert.deepEqual(records.map((record) => record.revision), [1, 2, 3]);
});

test("summary mode computes accounting without retaining detailed records", () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.recordUsage("agent", mkResult({ nanoAiu: 500_000_000 }));
	ledger.put("agent", mkResult({ content: "large" }));
	const summary = new Ledger(dir, { readOnly: true, mode: "summary" });
	assert.equal(summary.consumed.nanoAiu, 500_000_000);
	assert.throws(() => summary.records, /not retained/);
	assert.equal(summary.get("agent"), undefined);
});

test("records mode retains only requested record types", () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.record("progress", { record: { ev: "tick" } });
	ledger.admitAgent();
	const progress = new Ledger(dir, { readOnly: true, mode: "records", types: ["progress"] }).records;
	assert.equal(progress.length, 1);
	assert.equal(progress[0].type, "progress");
});

test("buffered progress flushes on its timer without consuming revisions early", async () => {
	const dir = tmpDir();
	const ledger = new Ledger(dir);
	ledger.progress({ ev: "tick" });
	assert.equal(ledger.revision, 0);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const records = readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(records.length, 1);
	assert.equal(records[0].revision, 1);
});

test("buffered progress preserves fatal lease loss", () => {
	const ledger = new Ledger(tmpDir(), {
		lease: {
			assertOwned() {
				throw new LostLeaseError("lost");
			},
		},
	});
	ledger.progress({ ev: "tick" });
	assert.throws(() => ledger.flushProgress(), LostLeaseError);
	assert.throws(() => ledger.progress({ ev: "later" }), LostLeaseError);
});

test("resuming an interrupted ledger does not charge idle time", async () => {
	const dir = tmpDir();
	const first = new Ledger(dir);
	first.startAttempt();
	await new Promise((resolve) => setTimeout(resolve, 5));
	first.record("critical");
	const before = new Ledger(dir, { readOnly: true, mode: "summary" }).consumed.activeMs;
	await new Promise((resolve) => setTimeout(resolve, 20));
	const resumed = new Ledger(dir);
	resumed.startAttempt();
	const after = resumed.consumed.activeMs;
	assert.ok(after - before < 10, `idle time leaked into active time: ${after - before}ms`);
});

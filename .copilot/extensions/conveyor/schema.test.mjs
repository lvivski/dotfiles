import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { approveLimits, assertJson, normalizeLimits, normalizePhases, runEnvelope } from "./schema.mjs";

test("limits normalize and cannot be lowered below approved or consumed values", () => {
	assert.deepEqual(normalizeLimits({ maxTotalAgents: 3, maxAiCredits: 1.5 }), { maxTotalAgents: 3, maxAiCredits: 1.5 });
	assert.throws(() => normalizeLimits({ unknown: 1 }), /unknown Conveyor limit/);
	assert.deepEqual(
		approveLimits({ maxTotalAgents: 2 }, { maxTotalAgents: 3 }, { maxTotalAgents: 4 }, { spawnedAgents: 3 }),
		{ maxTotalAgents: 4 },
	);
	assert.throws(
		() => approveLimits({ maxTotalAgents: 2 }, { maxTotalAgents: 3 }, { maxTotalAgents: 2 }, { spawnedAgents: 3 }),
		/cannot be lowered/,
	);
	assert.deepEqual(
		approveLimits({ maxConcurrentAgents: 8 }, { maxConcurrentAgents: 8 }, { maxConcurrentAgents: 2 }),
		{ maxConcurrentAgents: 2 },
	);
});

test("phase metadata is normalized and unique", () => {
	assert.deepEqual(normalizePhases(["Review", { title: "Verify", detail: "Check claims" }]), [
		{ id: "phase:0", ordinal: 0, title: "Review" },
		{ id: "phase:1", ordinal: 1, title: "Verify", detail: "Check claims" },
	]);
	assert.throws(() => normalizePhases(["Review", "Review"]), /declared more than once/);
});

test("strict JSON and run envelopes reject lossy values", () => {
	assert.equal(assertJson(false), false);
	assert.deepEqual(assertJson(vm.runInNewContext("({ ok: true })")), { ok: true });
	assert.throws(() => assertJson({ value: undefined }), /undefined/);
	assert.throws(() => assertJson(new Date()), /non-plain object/);
	assert.deepEqual(runEnvelope({ runId: "r", status: "complete", revision: 2, result: { ok: true } }), {
		runId: "r",
		status: "complete",
		revision: 2,
		result: { ok: true },
	});
});

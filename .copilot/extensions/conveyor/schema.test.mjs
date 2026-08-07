import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { assertJson, normalizeLimits } from "./schema.mjs";

test("native Factory limits are strict", () => {
	assert.deepEqual(
		normalizeLimits({ maxTotalSubagents: 3, maxAiCredits: 1.5 }),
		{ maxTotalSubagents: 3, maxAiCredits: 1.5 },
	);
	assert.throws(() => normalizeLimits({ agents: 3 }), /unknown Factory limit/);
	assert.throws(() => normalizeLimits({ maxConcurrentSubagents: 1.5 }), /positive integer/);
});

test("strict JSON accepts cross-realm objects and rejects lossy values", () => {
	assert.equal(assertJson(false), false);
	assert.deepEqual(assertJson(vm.runInNewContext("({ ok: true })")), { ok: true });
	assert.throws(() => assertJson({ value: undefined }), /undefined/);
	assert.throws(() => assertJson(new Date()), /non-plain object/);
});

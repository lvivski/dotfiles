import assert from "node:assert/strict";
import test from "node:test";
import { findScopeConflicts } from "../../plan/scope.mjs";

/** @param {string} id @param {string[]} expectedFiles @returns {Pick<import("../../types/plan.js").FoundryTask, "id" | "status" | "expectedFiles">} */
function ready(id, expectedFiles) {
	return {
		id,
		status: "ready",
		expectedFiles,
	};
}

test("scope conflicts detect aliases, traversal normalization, and glob matches", () => {
	for (const [left, right] of [
		["./src/a.mjs", "src/a.mjs"],
		["src/../shared/a.mjs", "shared/a.mjs"],
		["src/a?.mjs", "src/ab.mjs"],
		["src/**", "src/nested/a.mjs"],
		["src/Foo.js", "src/foo.js"],
		["C:\\repo\\src\\same.js", "src/same.js"],
		["C:src\\same.js", "src/same.js"],
		[".", "src/a.mjs"],
		["./", "src/a.mjs"],
		["src/..", "src/a.mjs"],
	]) {
		const conflicts = findScopeConflicts([
			ready("T-001", [left]),
			ready("T-002", [right]),
		]);
		assert.equal(conflicts.length, 1, `${left} should overlap ${right}`);
	}
});

test("scope conflicts keep distinct exact files dispatchable", () => {
	const conflicts = findScopeConflicts([
		ready("T-001", ["src/a.mjs"]),
		ready("T-002", ["src/ab.mjs"]),
	]);
	assert.deepEqual(conflicts, []);
});

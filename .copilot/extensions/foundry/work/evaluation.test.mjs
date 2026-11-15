import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "./evaluation.mjs";

/** @type {import("./model.js").Check} */
const check = { id: "behavior", origin: "contract", requirement: "Required behavior works", kind: "command", version: "v1", command: "node --test" };
/** @type {import("./model.js").Evidence} */
const passed = { id: "observed-1", attemptId: "attempt", checkId: check.id, checkVersion: "v1", outcome: "passed", reference: "native:call-1", summary: "Exit 0", source: "native-command" };

test("unsupported architectural opinion cannot veto passing canonical checks", () => {
	const verdict = evaluate([check], [passed], [{ summary: "Architecture might need more review", evidenceIds: [] }]);
	assert.equal(verdict.passed, true);
	assert.equal(verdict.advisory.length, 1);
});

test("missing or differently versioned evidence does not satisfy the assigned check", () => {
	assert.deepEqual(evaluate([check], [{ ...passed, checkVersion: "v2" }]).missing, ["behavior"]);
	assert.equal(evaluate([check], []).passed, false);
});

test("a concrete reproduced standing violation blocks; a mere artifact reference does not", () => {
	/** @type {import("./model.js").Finding} */
	const finding = { summary: "Loses supported data", obligation: "data-loss", expected: "Preserve existing data", observed: "Existing data was deleted", evidenceIds: ["reproduction"] };
	const reproduction = { ...passed, id: "reproduction", checkId: "preservation", outcome: /** @type {const} */ ("failed") };
	assert.equal(evaluate([check], [passed, reproduction], [finding]).passed, false);
	assert.equal(evaluate([check], [passed], [{ ...finding, evidenceIds: ["artifact:deleted-data.json"] }]).passed, true);
	assert.equal(evaluate([check], [passed], [{ ...finding, evidenceIds: [passed.id] }]).passed, true);
});

test("a later observation of the same assigned check supersedes a development failure", () => {
	const failed = { ...passed, id: "earlier", outcome: /** @type {const} */ ("failed") };
	assert.equal(evaluate([check], [failed, passed]).passed, true);
	assert.deepEqual(evaluate([check], [passed, failed]).failed, ["behavior"]);
});

test("a stronger new check is not retroactively governing", () => {
	const additional = { ...check, id: "new-threshold", origin: /** @type {const} */ ("derived"), version: "v2" };
	const evidence = { ...passed, id: "additional", checkId: additional.id, checkVersion: "v2", outcome: /** @type {const} */ ("failed") };
	assert.equal(evaluate([check], [passed, evidence]).passed, true);
});

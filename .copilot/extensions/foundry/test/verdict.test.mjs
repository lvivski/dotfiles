import assert from "node:assert/strict";
import test from "node:test";
import { FoundryError } from "../work/values.mjs";
import { interpret, interrupted } from "../work/verdict.mjs";

const component = /** @type {const} */ ({ kind: "component" });
const product = { kind: /** @type {const} */ ("product"), outputs: ["app"] };
const goal = { kind: /** @type {const} */ ("goal"), squads: ["client"] };
const stdout = Buffer.from(`${"雪😀".repeat(32000)}\nFOUNDRY_REPAIR=app\nFOUNDRY_SQUAD=client\n`);
const stderr = Buffer.from("FOUNDRY_REPAIR=other\nFOUNDRY_SQUAD=other\n");
const result = { status: 1, signal: null, stdout, stderr };
const fields = { exit: 1, output: `${stdout}\n${stderr}` };

test("the same complete evaluator streams carry only their check kind's evidence", () => {
	assert.deepEqual(interpret(component, result), { fields });
	assert.deepEqual(interpret(product, result), { fields: { ...fields, repair: "app" } });
	assert.deepEqual(interpret(goal, result), { fields: { ...fields, squad: "client" }, feedback: stdout });
	for (const status of [0, 2]) {
		const r = { ...result, status };
		assert.equal(interpret(product, r).fields.repair, status ? "app" : undefined);
		assert.equal(interpret(goal, r).fields.squad, undefined);
		assert.equal(interpret(goal, r).feedback, status ? undefined : stdout);
	}
	for (const raw of [Buffer.alloc(0), Buffer.concat([stdout, stdout]), stderr]) {
		const r = { ...result, stdout: raw, stderr: stdout };
		assert.equal(interpret(product, r).fields.repair, undefined);
		assert.equal(interpret(goal, r).fields.squad, undefined);
	}
});

test("only a completed component followed by an export verification failure attests mutation", () => {
	const changed = new FoundryError("product_changed", "modified file");
	for (const r of [{ ...result, signal: "SIGTERM" }, { ...result, error: Error("launch failed") }]) {
		const { fields } = interpret(component, r);
		assert.equal(fields.exit, null); assert.equal(fields.failure, "incomplete");
		assert.match(fields.output, /SIGTERM|launch failed/);
		assert.equal(interpret(product, r).fields.repair, undefined);
		assert.equal(interpret(goal, r).feedback, undefined);
		assert.equal(interrupted(component, fields.exit, changed).failure, "incomplete");
	}
	for (const exit of [0, 1]) {
		assert.deepEqual(interrupted(component, exit, changed), { exit: null, output: changed.message, failure: "changed-export" });
		assert.equal(interrupted(component, exit, Error("unavailable")).failure, "incomplete");
		for (const check of [product, goal]) assert.deepEqual(interrupted(check, exit, changed), { exit: null, output: changed.message });
	}
});

test("shared-step attribution comes only from one valid completed goal stdout record; it never changes the verdict", () => {
	const failed = { id: "open", directory: "ui", blocked: 49 }, passed = { id: "open", directory: "ui", passed: true };
	const marker = (/** @type {unknown} */ data) => Buffer.from(`FOUNDRY_BLOCKERS=${JSON.stringify(data)}\n`);
	for (const [status, data] of /** @type {const} */ ([[1, failed], [0, passed], [1, passed]])) {
		const r = { ...result, status, stdout: marker([data]) };
		assert.deepEqual(interpret(goal, r).fields.blockers, [data]);
		assert.equal(interpret(product, r).fields.blockers, undefined);
		assert.equal(interpret(component, r).fields.blockers, undefined);
		assert.equal(interpret(goal, { ...r, stdout: Buffer.alloc(0), stderr: r.stdout }).fields.blockers, undefined);
	}
	for (const [status, data] of /** @type {const} */ ([[0, [failed]], [1, [failed, passed]], [1, [{ ...failed, directory: "../ui" }]],
		[1, [{ ...failed, blocked: -1 }]], [1, [{ ...failed, passed: true }]], [2, [failed]]])) {
		const { fields } = interpret(goal, { ...result, status, stdout: marker(data) });
		assert.equal(fields.blockers, undefined); assert.equal(fields.exit, status);
	}
});

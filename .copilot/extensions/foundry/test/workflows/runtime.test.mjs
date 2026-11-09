import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowContext } from "./runtime.mjs";

test("Workflow test runtime matches native item-failure semantics", async () => {
	const workflow = createWorkflowContext({});
	assert.deepEqual(await workflow.parallel([
		() => 1,
		() => {
			throw new Error("ordinary failure");
		},
	]), [1, null]);
	assert.deepEqual(await workflow.pipeline(
		[1, 2],
		(value) => {
			assert.ok(typeof value === "number");
			if (value === 2) throw new Error("ordinary failure");
			return value + 1;
		},
		(value) => {
			assert.ok(typeof value === "number");
			return value * 2;
		},
	), [4, null]);
});

test("Workflow test runtime replays JSON steps and durable one-shot checkpoints", async () => {
	const workflow = createWorkflowContext({});
	const prepared = await workflow.step("scope:v1", () => ({ files: ["src/a.js"] }));
	assert.deepEqual(prepared, { files: ["src/a.js"] });
	assert.ok(Object.isFrozen(prepared.files));
	assert.equal(await workflow.step("scope:v1", () => assert.fail("Cached producer ran")), prepared);
	for (const value of [undefined, { missing: undefined }, new Set(["src/a.js"]), NaN]) {
		// @ts-expect-error Exercise rejection of non-JSON step results without weakening the native contract.
		await assert.rejects(workflow.step("invalid:v1", () => value));
	}
	assert.equal(workflow.journal.steps.size, 1);
	await assert.rejects(workflow.pause("ready:v1"), { name: "AbortError", key: "ready:v1" });
	await workflow.pause("ready:v1");
	const resumed = createWorkflowContext({}, null, workflow.journal);
	assert.equal(await resumed.step("scope:v1", () => assert.fail("Resumed producer ran")), prepared);
	await resumed.pause("ready:v1");
	assert.deepEqual(resumed.stepExecutions, []);
});

test("Workflow test runtime bills identical agent calls once without merging independent labels", async () => {
	const workflow = createWorkflowContext({});
	await Promise.all([
		workflow.agent("Review", { label: "first" }),
		workflow.agent("Review", { label: "first" }),
		workflow.agent("Review", { label: "second" }),
	]);
	assert.equal(workflow.calls.length, 2);
	const resumed = createWorkflowContext({}, null, workflow.journal);
	await resumed.agent("Review", { label: "first" });
	await resumed.agent("Review", { label: "second" });
	assert.deepEqual(resumed.calls, []);
});

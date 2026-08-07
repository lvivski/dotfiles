import test from "node:test";
import assert from "node:assert/strict";

import { executeConveyor } from "./factory.mjs";

function fakeFactory(args, agent = async (prompt) => `agent:${prompt}`) {
	const phases = [];
	const logs = [];
	const steps = new Map();
	return {
		args,
		runId: "factory-run",
		signal: new AbortController().signal,
		phases,
		logs,
		agent,
		phase: (title) => phases.push(title),
		log: (message) => logs.push(message),
		parallel: async (thunks) => {
			assert.equal(Object.getPrototypeOf(thunks), Array.prototype);
			return Promise.all(thunks.map(async (thunk) => {
				try {
					const value = await thunk();
					assertNativeValue(value);
					return value;
				} catch {
					return null;
				}
			}));
		},
		pipeline: async (items, ...stages) => {
			assert.equal(Object.getPrototypeOf(items), Array.prototype);
			return Promise.all(items.map(async (item, index) => {
			let previous = item;
			for (const stage of stages) {
				try {
					previous = await stage(previous, item, index);
					assertNativeValue(previous);
				} catch {
					return null;
				}
			}
			return previous;
			}));
		},
		step: async (key, producer, options = {}) => {
			if (!options.volatile && steps.has(key)) return steps.get(key);
			const value = await producer();
			const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
			if (prototype && prototype !== Object.prototype) {
				throw new TypeError("native Factory step received a cross-realm object");
			}
			if (!options.volatile) steps.set(key, value);
			return value;
		},
	};
}

function assertNativeValue(value) {
	if (!value || typeof value !== "object") return;
	const prototype = Object.getPrototypeOf(value);
	assert.ok(
		prototype === Object.prototype || prototype === Array.prototype || prototype === null,
		"native Factory received a cross-realm object",
	);
}

test("executes a harness through native Factory primitives", async () => {
	const factory = fakeFactory({
		source: `export const meta = { name: "demo" };
phase("Review");
const rows = await pipeline(context.args, (item) => agent("review:" + item, { label: item }));
return { rows, runId: context.runId };`,
		filename: "demo.mjs",
		input: ["a", "b"],
	});
	const result = await executeConveyor(factory);
	assert.deepEqual(result, {
		rows: ["agent:review:a", "agent:review:b"],
		runId: "factory-run",
	});
	assert.deepEqual(factory.phases, ["Review"]);
	assert.match(factory.logs[0], /Conveyor demo started/);
});

test("uses native null agent failures without an outcome adapter", async () => {
	const factory = fakeFactory({
		source: `return await agent("fails");`,
	}, async () => null);
	assert.equal(await executeConveyor(factory), null);
});

test("rejects removed Conveyor-only agent options", async () => {
	const factory = fakeFactory({
		source: `return await agent("x", { profile: "read-only" });`,
	});
	await assert.rejects(executeConveyor(factory), /unsupported Factory agent option 'profile'/);
});

test("native durable steps are exposed directly", async () => {
	const factory = fakeFactory({
		source: `const first = await step("value", () => ({ count: 3 }));
const second = await step("value", () => ({ count: 9 }));
return [first, second];`,
	});
	assert.deepEqual(await executeConveyor(factory), [{ count: 3 }, { count: 3 }]);
});

test("normalizes parallel and pipeline values before native Factory code observes them", async () => {
	const factory = fakeFactory({
		source: `const parallelRows = await parallel([() => ({ value: 1 })]);
const pipelineRows = await pipeline([{ value: 1 }], (item) => ({ value: item.value + 1 }));
return { parallelRows, pipelineRows };`,
	});
	assert.deepEqual(await executeConveyor(factory), {
		parallelRows: [{ value: 1 }],
		pipelineRows: [{ value: 2 }],
	});
});

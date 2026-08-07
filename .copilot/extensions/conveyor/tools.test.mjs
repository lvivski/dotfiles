import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildTools, runConveyor } from "./tools.mjs";
import { tmpDir, withFakeEnv } from "./fixtures/support.mjs";

function fakeContext(cwd) {
	const launches = [];
	return {
		launches,
		getWorkspaceCwd: async () => cwd,
		launch: async (args, limits) => {
			launches.push({ args, limits });
			return { runId: "factory-1", status: "completed", result: "done" };
		},
	};
}

test("launches inline source through the native Factory boundary", async () => {
	const context = fakeContext(tmpDir());
	const result = await runConveyor({
		script: `export const meta = {
			name: "inline",
			limits: { maxTotalSubagents: 4, maxAiCredits: 2 },
		}; return context.args;`,
		args: { value: 1 },
		limits: { maxAiCredits: 3 },
	}, context);
	assert.equal(result.resultType, "success");
	assert.deepEqual(context.launches[0].limits, {
		maxTotalSubagents: 4,
		maxAiCredits: 3,
	});
	assert.deepEqual(context.launches[0].args.input, { value: 1 });
	assert.match(context.launches[0].args.source, /return context\.args/);
});

test("resolves saved names from the project", () => {
	const root = tmpDir();
	const dir = join(root, ".copilot", "conveyors");
	mkdirSync(join(root, ".git"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "audit.mjs"), `export const meta = { name: "audit" }; return "ok";`);
	return withFakeEnv({ CONVEYOR_DIR: tmpDir() }, async () => {
		const context = fakeContext(root);
		const result = await runConveyor({ name: "audit" }, context);
		assert.equal(result.resultType, "success");
		assert.match(context.launches[0].args.filename, /audit\.mjs$/);
	});
});

test("exposes and accepts only Factory-native launch inputs", async () => {
	const context = fakeContext(tmpDir());
	const tool = buildTools(context)[0];
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [
		"args",
		"limits",
		"name",
		"script",
		"scriptPath",
	]);
	const result = await runConveyor({
		script: "return 1;",
		agents: 2,
	}, context);
	assert.equal(result.resultType, "failure");
	assert.match(result.textResultForLlm, /unknown run_conveyor option/);
	assert.equal(context.launches.length, 0);
});

test("returns native non-completed envelopes as failures", async () => {
	const context = fakeContext(tmpDir());
	context.launch = async () => ({
		runId: "factory-2",
		status: "error",
		error: "boom",
		snapshot: { large: "hidden" },
	});
	const result = await runConveyor({ script: "return 1;" }, context);
	assert.equal(result.resultType, "failure");
	assert.match(result.textResultForLlm, /factory-2/);
	assert.doesNotMatch(result.textResultForLlm, /snapshot|hidden/);
});

test("returns a valid null payload when the Factory API yields no envelope", async () => {
	const context = fakeContext(tmpDir());
	context.launch = async () => undefined;
	const result = await runConveyor({ script: "return 1;" }, context);
	assert.equal(result.resultType, "failure");
	assert.equal(result.textResultForLlm, "null");
});

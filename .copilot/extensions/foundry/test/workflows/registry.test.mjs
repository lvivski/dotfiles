import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { meta as planMeta } from "../../workflows/plan.mjs";
import { FOUNDRY_WORKFLOWS, WORKFLOW_FILES } from "../../workflows/registry.mjs";
import { meta as verifyMeta } from "../../workflows/verify.mjs";
import { ADDITIONAL_WORKFLOWS } from "./registry.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const WORKFLOW_DIR = join(ROOT, "workflows");

test("registered workflow modules match metadata and declared phases", () => {
	const filenames = readdirSync(WORKFLOW_DIR)
		.filter((entry) => entry.endsWith(".mjs"))
		.sort();
	const definitions = Object.values(FOUNDRY_WORKFLOWS);
	assert.deepEqual(
		filenames,
		["registry.mjs", ...Object.values(WORKFLOW_FILES)].sort(),
	);
	assert.deepEqual(Object.keys(WORKFLOW_FILES).sort(), definitions.map(({ meta }) => meta.name).sort());

	for (const { meta, run } of definitions) {
		assert.equal(typeof run, "function");
		assert.ok(meta.phases.length > 0);
		assert.ok(meta.argsSchema && typeof meta.argsSchema === "object");
		assert.equal(new Set(meta.phases.map(({ title }) => title)).size, meta.phases.length);
		for (const value of Object.values(meta.limits)) {
			assert.equal(typeof value, "number");
			assert.ok(value > 0);
		}

		const filename = join(WORKFLOW_DIR, WORKFLOW_FILES[meta.name]);
		const source = readFileSync(filename, "utf8");
		const usedPhases = [...source.matchAll(/\bphase\("([^"]+)"\)/g)]
			.map((match) => match[1]);
		assert.deepEqual(usedPhases, meta.phases.map(({ title }) => title), filename);
		assert.match(source, /export async function run\(workflow\)/);
		assert.doesNotMatch(
			source,
			/run_conveyor|runHarness|stripExports|scriptPath|node:vm|context\.args/,
			filename,
		);
	}
});

test("additional workflows expose argument contracts", () => {
	const definitions = Object.values(ADDITIONAL_WORKFLOWS);
	assert.equal(definitions.length, 5);
	assert.equal(new Set(definitions.map(({ meta }) => meta.name)).size, definitions.length);
	for (const { meta } of definitions) {
		assert.match(meta.description, /Args:/);
		assert.ok(meta.argsSchema);
		const forms = meta.argsSchema.anyOf;
		assert.ok(Array.isArray(forms));
		for (const form of forms) {
			if (form === null || typeof form !== "object" || Array.isArray(form) || form.type !== "object") continue;
			const properties = form.properties;
			assert.ok(properties !== null && typeof properties === "object" && !Array.isArray(properties));
			assert.deepEqual(properties.pauseBeforeWork, { type: "boolean" });
			const required = form.required ?? [];
			assert.ok(Array.isArray(required));
			assert.equal(required.includes("pauseBeforeWork"), false);
		}
	}
});

test("declared execution limits remain unchanged", () => {
	assert.equal(
		planMeta.limits.maxTotalSubagents,
		10,
	);
	assert.equal(
		verifyMeta.limits.maxTotalSubagents,
		6,
	);
	for (const [key, concurrent, total, timeout] of [
		["audit", 4, 40, 900],
		["deepResearch", 2, 40, 3600],
		["reviewQueue", 8, 700, 3600],
		["securityReview", 6, 80, 3600],
		["triage", 8, 100, 900],
	]) {
		assert.deepEqual(ADDITIONAL_WORKFLOWS[key].meta.limits, {
			maxConcurrentSubagents: concurrent,
			maxTotalSubagents: total,
			timeoutSeconds: timeout,
			maxAiCredits: 10000,
		});
	}
});

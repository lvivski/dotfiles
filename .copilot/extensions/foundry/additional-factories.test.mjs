import test from "node:test";
import assert from "node:assert/strict";

import { FOUNDRY_FACTORIES } from "./factory.mjs";

const ADDITIONAL_FACTORIES = Object.freeze({
	audit: FOUNDRY_FACTORIES.audit,
	deepResearch: FOUNDRY_FACTORIES.deepResearch,
	reviewQueue: FOUNDRY_FACTORIES.reviewQueue,
	securityReview: FOUNDRY_FACTORIES.securityReview,
	triage: FOUNDRY_FACTORIES.triage,
});

function createFactory(args) {
	const phases = [];
	const logs = [];
	const calls = [];
	return {
		args,
		runId: "factory-run",
		signal: new AbortController().signal,
		phases,
		logs,
		calls,
		async agent(prompt, options = {}) {
			calls.push({ prompt, options });
			const schema = options.schema;
			if (!schema) return "NO ISSUES";
			if (schema.type === "array") {
				return schema.items?.type === "string" ? ["primary angle"] : [];
			}
			const properties = schema.properties ?? {};
			if (properties.authModel) {
				return {
					authModel: "unknown",
					assets: [],
					trustBoundaries: [],
					attackerInputs: [],
				};
			}
			if (properties.passed) return { passed: true, reasons: "supported" };
			if (properties.risk) {
				return {
					risk: "low",
					issues: [],
					missingTests: [],
					uncertainty: [],
					summary: "clean",
				};
			}
			if (properties.category) {
				return {
					category: "bug",
					priority: "p2",
					confidence: "high",
					rationale: "reproducible",
					action: "fix it",
				};
			}
			if (properties.verdict) {
				return { verdict: "true-positive", reasoning: "reachable" };
			}
			throw new Error("unhandled test schema");
		},
		async parallel(thunks) {
			return Promise.all(
				thunks.map(async (thunk) => {
					try {
						return await thunk();
					} catch {
						return null;
					}
				}),
			);
		},
		async pipeline(items, ...stages) {
			return Promise.all(
				items.map(async (item, index) => {
					let previous = item;
					for (const stage of stages) {
						try {
							previous = await stage(previous, item, index);
						} catch {
							return null;
						}
					}
					return previous;
				}),
			);
		},
		phase(title) {
			phases.push(title);
		},
		log(message) {
			logs.push(message);
		},
	};
}

test("exports five uniquely named native factories with declared limits and phases", () => {
	const definitions = Object.values(ADDITIONAL_FACTORIES);
	const complex = new Set(["deep-research", "review-queue", "security-review"]);
	assert.equal(definitions.length, 5);
	assert.equal(new Set(definitions.map(({ meta }) => meta.name)).size, definitions.length);
	for (const { meta, run } of definitions) {
		assert.equal(typeof run, "function");
		assert.match(meta.description, /Args:/);
		assert.ok(meta.phases.length > 0);
		assert.equal(new Set(meta.phases.map(({ title }) => title)).size, meta.phases.length);
		for (const value of Object.values(meta.limits)) {
			assert.equal(typeof value, "number");
			assert.ok(value > 0);
		}
		assert.equal(meta.limits.maxAiCredits, 10000);
		assert.equal(meta.limits.timeoutSeconds, complex.has(meta.name) ? 3600 : 900);
	}
});

test("bundled workflows execute directly against native factory primitives", async () => {
	const cases = [
		{
			key: "audit",
			args: { paths: ["src/a.js"] },
			expected: /No verified issues found/,
		},
		{
			key: "deepResearch",
			args: { question: "What changed?", angles: 1 },
			expected: /Coverage: 1 angles researched/,
		},
		{
			key: "reviewQueue",
			args: {
				prs: [{
					repo: "owner/repo",
					number: 1,
					title: "Small fix",
					diff: "+const answer = 42;",
					files: ["src/a.js"],
					me: "octocat",
					coverage: "full diff",
					platform: "github",
					url: "https://example.test/owner/repo/pull/1",
					updatedAt: "2026-08-11T00:00:00Z",
				}],
			},
			expected: /\| Approve \| low \|/,
		},
		{
			key: "securityReview",
			args: { root: "src", perspectives: 1 },
			expected: /No finding survived independent verification/,
		},
		{
			key: "triage",
			args: { tickets: ["The button crashes"] },
			expected: /\| 1 \| Triaged \| bug \| P2 \|/,
		},
	];

	for (const { key, args, expected } of cases) {
		const definition = ADDITIONAL_FACTORIES[key];
		const factory = createFactory(args);
		const result = await definition.run(factory);
		assert.match(result, expected, definition.meta.name);
		assert.ok(factory.calls.length > 0, definition.meta.name);
		const declared = new Set(definition.meta.phases.map(({ title }) => title));
		assert.ok(factory.phases.every((title) => declared.has(title)), definition.meta.name);
	}
});

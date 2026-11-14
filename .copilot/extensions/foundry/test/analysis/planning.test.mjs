import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest } from "../../digest.mjs";
import { FoundryAnalysisError } from "../../errors.mjs";
import { buildPlanningArgs, normalizePlanningInput, validatePlanBlueprint, validatePlanningArgs, validatePlanningResult } from "../../analysis/planning.mjs";
import { run as runPlanning } from "../../workflows/plan.mjs";
import { LIMITS } from "../../plan/values.mjs";
import { planningResult } from "../native/plans.mjs";

test("planning arguments retain complete content and use identifier capacity rather than an invented task budget", () => {
	const normalized = normalizePlanningInput({
		objective: "Build a reviewed feature",
		repositoryContext: "Node extension with no dependencies",
	});
	assert.equal(normalized.maxTasks, LIMITS.tasks - 1);
	assert.deepEqual(normalized.constraints, []);
	const args = buildPlanningArgs(normalized);
	assert.match(args.inputDigest, /^[a-f0-9]{64}$/);
	assert.equal(
		analysisInputDigest({ z: 1, a: 2 }),
		analysisInputDigest({ a: 2, z: 1 }),
	);
	assert.equal(normalizePlanningInput({ objective: "Build", repositoryContext: "Repo", maxTasks: 13 }).maxTasks, 13);
	for (const maxTasks of [0, 0.5, LIMITS.tasks, Number.POSITIVE_INFINITY]) {
		assert.throws(() => normalizePlanningInput({ objective: "Build", repositoryContext: "Repo", maxTasks }), FoundryAnalysisError);
	}
	const long = {
		objective: ` \n${"決定 🧪\t".repeat(5000)}\n `,
		repositoryContext: ` \n${"原文\t".repeat(40_000)}\n `,
		constraints: Array.from({ length: 70 }, (_, index) => ` ${index}\n${"Δ".repeat(2000)}\t `),
		factoryContext: { original: "文".repeat(150_000) },
	};
	const complete = buildPlanningArgs(long);
	for (const field of /** @type {const} */ (["objective", "repositoryContext", "constraints", "factoryContext"])) {
		assert.deepEqual(complete[field], long[field]);
	}
	assert.deepEqual(validatePlanningArgs(JSON.parse(JSON.stringify(complete))), complete);
});

test("the planning Workflow uses canonical defaults and rejects invalid args before agent work", async () => {
	const minimal = { objective: "Build", repositoryContext: "Node repo" };
	const canonical = buildPlanningArgs(minimal);
	const minimalArgs = { ...minimal, inputDigest: canonical.inputDigest };
	assert.deepEqual(validatePlanningArgs(minimalArgs), canonical);

	let agentCalls = 0;
	/** @param {unknown} args */
	const execute = (args) => runPlanning({
		// @ts-expect-error Deliberately pass non-JSON and malformed args to the public validator.
		args,
		phase() { },
		parallel: async () => assert.fail("Invalid planning args must not dispatch critics"),
		async agent() {
			agentCalls += 1;
			return null;
		},
	});
	for (const invalid of [
		{ ...minimalArgs, inputDigest: "0".repeat(64) },
		{ ...minimalArgs, inputDigest: undefined },
		{ ...canonical, objective: " \t\n" },
		{ ...canonical, constraints: ["bad\0content"] },
		{ ...canonical, maxTasks: 0 },
		{ ...canonical, maxTasks: LIMITS.tasks },
	]) {
		await assert.rejects(execute(invalid), FoundryAnalysisError);
	}
	assert.equal(agentCalls, 0);
	const result = await execute(minimalArgs);
	assert.deepEqual(result.input, canonical);
	assert.equal(agentCalls, 1);
	for (const maxTasks of [1, 13, LIMITS.tasks - 1]) {
		const args = buildPlanningArgs({ ...minimal, maxTasks });
		assert.deepEqual((await execute(args)).input, args);
	}
});

test("generated plan fields retain long Unicode, whitespace and beyond-cap collections while semantic gates remain closed", () => {
	const input = buildPlanningArgs({ objective: "Build", repositoryContext: "Node repo", maxTasks: 2 });
	const plan = planningResult(input).plan;
	const fullText = ` \t\n${"exact-原文🧪".repeat(2500)}\n `;
	assert.equal(validatePlanBlueprint({ ...plan, title: fullText }, 2).title, fullText);
	for (const field of ["title", "description"]) {
		const candidate = structuredClone(plan);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: fullText };
		assert.deepEqual(validatePlanBlueprint(candidate, 2), candidate);
	}
	for (const field of ["acceptanceCriteria", "expectedFiles"]) {
		const candidate = structuredClone(plan);
		const entries = Array.from({ length: 70 }, (_, index) => field === "acceptanceCriteria"
			? `${fullText}${index}` : `declared/${"segment/".repeat(100)}${index}.mjs`);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: entries };
		assert.deepEqual(validatePlanBlueprint(candidate, 2), candidate);
	}
	for (const acceptanceCriteria of [[], [" \t\n"]]) {
		const candidate = structuredClone(plan);
		candidate.tasks[0].acceptanceCriteria = acceptanceCriteria;
		assert.throws(() => validatePlanBlueprint(candidate, 2), /acceptanceCriteria/);
	}
	assert.throws(() => validatePlanBlueprint({ ...plan, tasks: [plan.tasks[0]] }, 2), /plus one verifier/);
	assert.throws(() => validatePlanBlueprint({ ...plan, tasks: [...plan.tasks, plan.tasks[0]] }, 1), /plus one verifier/);
});

test("planning results reuse the strict domain validator and fail closed", () => {
	const input = buildPlanningArgs({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repo",
		maxTasks: 2,
	});
	const plan = {
		title: "Plan",
		objective: input.objective,
		constraints: [],
		tasks: [
			{
				id: "T-001",
				title: "Implement",
				kind: "implement",
				description: "Implement",
				dependsOn: [],
				acceptanceCriteria: ["Tests pass"],
				expectedFiles: ["src/change.mjs"],
				deliveryRequirement: "commit",
			},
			{
				id: "T-002",
				title: "Verify",
				kind: "verify",
				description: "Verify",
				dependsOn: ["T-001"],
				acceptanceCriteria: [],
				expectedFiles: [],
				deliveryRequirement: "commit",
			},
		],
	};
	const result = {
		kind: "foundry-plan-result",
		inputDigest: input.inputDigest,
		status: "ready",
		plan,
		critiques: [
			{ verdict: "accept", risks: [], requiredChanges: [] },
			{ verdict: "accept", risks: [], requiredChanges: [] },
		],
		verification: { passed: true, issues: [] },
		missingPerspectives: [],
		issues: [],
	};
	assert.deepEqual(
		validatePlanningResult(result, input, 2),
		validatePlanBlueprint(plan, 2),
	);
	assert.throws(
		() => validatePlanningResult({
			...result,
			critiques: [null, result.critiques[1]],
		}, input, 2),
		/two complete critic perspectives/,
	);
	assert.equal(
		validatePlanningResult({
			...result,
			critiques: [
				{
					verdict: "revise",
					risks: ["Initial risk addressed by synthesis"],
					requiredChanges: ["Clarify the output"],
				},
				result.critiques[1],
			],
		}, input, 2).tasks.length,
		2,
	);
	assert.throws(
		() => validatePlanningResult({
			...result,
			plan: { ...plan, objective: "Drifted objective" },
		}, input, 2),
		/canonical objective/,
	);
	assert.throws(
		() => validatePlanBlueprint({
			...plan,
			tasks: plan.tasks.map((task) => {
				if (task.id !== "T-001") return task;
				const { deliveryRequirement: _discarded, ...withoutDelivery } = task;
				return withoutDelivery;
			}),
		}, 2),
		/deliveryRequirement/,
	);
	assert.throws(
		() => validatePlanBlueprint({
			...plan,
			tasks: plan.tasks.map((task) => task.id === "T-001"
				? { ...task, dependsOn: ["T-002"] }
				: task),
		}, 2),
		/[Cc]ycle/,
	);
});

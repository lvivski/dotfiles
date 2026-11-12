import assert from "node:assert/strict";
import test from "node:test";
import { analysisInputDigest } from "../../digest.mjs";
import { FoundryAnalysisError } from "../../errors.mjs";
import { buildPlanningArgs, normalizePlanningInput, validatePlanBlueprint, validatePlanningArgs, validatePlanningResult } from "../../analysis/planning.mjs";
import { run as runPlanning } from "../../workflows/plan.mjs";
import { LIMITS } from "../../plan/values.mjs";
import { planningResult } from "../native/plans.mjs";

test("planning arguments are bounded and digested canonically", () => {
	const normalized = normalizePlanningInput({
		objective: "Build a reviewed feature",
		repositoryContext: "Node extension with no dependencies",
	});
	assert.equal(normalized.maxTasks, 6);
	assert.deepEqual(normalized.constraints, []);
	const args = buildPlanningArgs(normalized);
	assert.match(args.inputDigest, /^[a-f0-9]{64}$/);
	assert.equal(
		analysisInputDigest({ z: 1, a: 2 }),
		analysisInputDigest({ a: 2, z: 1 }),
	);
	assert.throws(
		() => normalizePlanningInput({
			objective: "Build",
			repositoryContext: "Repo",
			maxTasks: 13,
		}),
		FoundryAnalysisError,
	);
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
		{ ...canonical, objective: "x".repeat(8001) },
		{ ...canonical, constraints: Array(33).fill("constraint") },
		{ ...canonical, constraints: ["x".repeat(1001)] },
		{ ...canonical, repositoryContext: "x".repeat(16001) },
		{ ...canonical, maxTasks: 0 },
		{ ...canonical, maxTasks: 13 },
	]) {
		await assert.rejects(execute(invalid), FoundryAnalysisError);
	}
	assert.equal(agentCalls, 0);
	const result = await execute(minimalArgs);
	assert.deepEqual(result.input, canonical);
	assert.equal(agentCalls, 1);
	for (const maxTasks of [1, 12]) {
		const args = buildPlanningArgs({ ...minimal, maxTasks });
		assert.deepEqual((await execute(args)).input, args);
	}
});

test("generated plan field bounds accept exact limits and reject overflow or blank criteria", () => {
	const input = buildPlanningArgs({ objective: "Build", repositoryContext: "Node repo", maxTasks: 2 });
	const plan = planningResult(input).plan;
	assert.equal(validatePlanBlueprint({ ...plan, title: "x".repeat(LIMITS.planTitle) }, 2).title.length, LIMITS.planTitle);
	assert.throws(() => validatePlanBlueprint({ ...plan, title: "x".repeat(LIMITS.planTitle + 1) }, 2), /plan.title/);
	for (const [field, maximum] of Object.entries({
		title: LIMITS.taskTitle, description: LIMITS.taskDescription,
	})) {
		const candidate = structuredClone(plan);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: "x".repeat(maximum) };
		assert.deepEqual(validatePlanBlueprint(candidate, 2), candidate);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: "x".repeat(maximum + 1) };
		assert.throws(() => validatePlanBlueprint(candidate, 2), /plan.tasks\[0\]/);
	}
	for (const { field, count, length } of [
		{ field: "acceptanceCriteria", count: LIMITS.acceptanceCriteria, length: LIMITS.acceptanceCriterion },
		{ field: "expectedFiles", count: LIMITS.expectedFiles, length: LIMITS.expectedFile },
	]) {
		const candidate = structuredClone(plan);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: ["x".repeat(length)] };
		assert.deepEqual(validatePlanBlueprint(candidate, 2), candidate);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: ["x".repeat(length + 1)] };
		assert.throws(() => validatePlanBlueprint(candidate, 2), /plan.tasks\[0\]/);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: Array.from({ length: count }, (_, index) => `check-${index}`) };
		assert.deepEqual(validatePlanBlueprint(candidate, 2), candidate);
		candidate.tasks[0] = { ...candidate.tasks[0], [field]: Array.from({ length: count + 1 }, (_, index) => `check-${index}`) };
		assert.throws(() => validatePlanBlueprint(candidate, 2), /plan.tasks\[0\]/);
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

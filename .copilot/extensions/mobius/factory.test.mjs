import test from "node:test";
import assert from "node:assert/strict";

import {
	buildPlanningArgs,
	buildVerificationInput,
	validatePlanningResult,
	validateVerificationResult,
} from "./analysis.mjs";
import { createFactoryAnalysis, MobiusFactoryError } from "./factory.mjs";
import { meta as planMeta, run as runPlan } from "./factories/plan.mjs";
import { meta as verifyMeta, run as runVerify } from "./factories/verify.mjs";
import {
	ATTEMPT_STATUS,
	EVIDENCE_TYPE,
	PLAN_STATUS,
	approvePlan,
	attachTaskAttempt,
	completeTaskAttempt,
	createDraftPlan,
	reserveTaskAttempt,
	transitionPlan,
} from "./domain.mjs";

function fakeApi(records = {}) {
	return {
		async getRun(runId) {
			const record = records[runId];
			if (!record) throw new Error(`Factory run ${runId} not found`);
			return record.run;
		},
		async getRunDetail(runId) {
			const record = records[runId];
			if (!record) throw new Error(`Factory run ${runId} not found`);
			return {
				runId,
				factoryName: record.factoryName,
				status: record.run.status,
			};
		},
	};
}

function executionContext(args, responses) {
	return {
		args,
		runId: "native-run",
		signal: new AbortController().signal,
		phase() {
			assert.equal(this.runId, "native-run");
		},
		log() {},
		async agent(_prompt, options = {}) {
			assert.equal(this.runId, "native-run");
			return structuredClone(responses[options.label] ?? null);
		},
		async parallel(thunks) {
			assert.equal(this.runId, "native-run");
			return Promise.all(thunks.map(async (thunk) => {
				try {
					return await thunk();
				} catch {
					return null;
				}
			}));
		},
		pipeline: async (items, ...stages) => Promise.all(items.map(async (item, index) => {
			let previous = item;
			for (const stage of stages) previous = await stage(previous, item, index);
			return previous;
		})),
		step: async (_key, producer) => producer(),
	};
}

function planningResult(input) {
	return {
		kind: "mobius-plan-result",
		inputDigest: input.inputDigest,
		input,
		status: "ready",
		plan: {
			title: "Plan",
			objective: input.objective,
			constraints: input.constraints,
			tasks: [{
				id: "T-001",
				title: "Implement",
				kind: "implement",
				description: "Implement",
				dependsOn: [],
				acceptanceCriteria: ["Tests pass"],
				expectedFiles: ["src/change.mjs"],
			}],
		},
		critiques: [
			{ verdict: "accept", risks: [], requiredChanges: [] },
			{ verdict: "accept", risks: [], requiredChanges: [] },
		],
		verification: { passed: true, issues: [] },
		missingPerspectives: [],
		issues: [],
	};
}

function completedPlan() {
	let plan = createDraftPlan({
		id: "factory-plan",
		title: "Factory plan",
		objective: "Validate native Factory integration",
		constraints: [],
		repository: { workingDirectory: "/tmp/factory-plan", baseBranch: "main" },
		tasks: [{
			id: "T-001",
			title: "Implement",
			description: "Implement",
			dependsOn: [],
			acceptanceCriteria: ["Tests pass"],
			expectedFiles: ["src/change.mjs"],
		}],
	}, { now: "2026-08-07T00:00:00.000Z" });
	plan = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
		at: "2026-08-07T00:01:00.000Z",
	});
	plan = approvePlan(plan, "tester", { at: "2026-08-07T00:02:00.000Z" });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "factory-reservation",
		at: "2026-08-07T00:03:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-001", "T-001-A001", {
		sessionId: "session-1",
		branch: "work/factory",
		at: "2026-08-07T00:04:00.000Z",
	});
	return completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Implemented",
		evidence: [{
			type: EVIDENCE_TYPE.TEST,
			summary: "Tests pass",
			source: "node --test",
			outcome: "passed",
		}],
		branch: "work/factory",
		commit: "a".repeat(40),
		at: "2026-08-07T00:05:00.000Z",
	});
}

test("prepare operations return native run_factory launch specs", async () => {
	const analysis = createFactoryAnalysis(() => fakeApi());
	const planning = await analysis.preparePlanning({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});

	assert.equal(planning.backend, "factory");
	assert.equal(planning.launchSpec.name, "mobius-plan");
	assert.deepEqual(planning.launchSpec.limits, {
		maxConcurrentSubagents: 2,
		maxTotalSubagents: 8,
		timeoutSeconds: 300,
		maxAiCredits: 20,
	});

	const verification = await analysis.prepareVerification(completedPlan());
	assert.equal(verification.launchSpec.name, "mobius-verify");
	assert.equal(verification.launchSpec.args.planId, "factory-plan");
});

test("bundled planning harness executes with native Factory result semantics", async () => {
	const args = buildPlanningArgs({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});
	const blueprint = {
		title: "Plan",
		objective: args.objective,
		constraints: args.constraints,
		tasks: [{
			id: "T-001",
			title: "Implement",
			kind: "implement",
			description: "Implement",
			dependsOn: [],
			acceptanceCriteria: ["Tests pass"],
			expectedFiles: ["src/change.mjs"],
		}],
	};
	assert.equal(planMeta.name, "mobius-plan");
	const result = await runPlan(executionContext(args, {
		"mobius-plan:decomposer": blueprint,
		"mobius-plan:architecture-critic": {
			verdict: "accept",
			risks: [],
			requiredChanges: [],
		},
		"mobius-plan:delivery-risk-critic": {
			verdict: "accept",
			risks: [],
			requiredChanges: [],
		},
		"mobius-plan:synthesizer": blueprint,
		"mobius-plan:verifier": { passed: true, issues: [] },
	}));
	assert.equal(result.kind, "mobius-plan-result");
	assert.equal(result.status, "ready");
	assert.equal(validatePlanningResult(result, args, 2).tasks.length, 1);
});

test("bundled verification harness binds its complete native Factory input", async () => {
	const args = buildVerificationInput(completedPlan());
	const evidenceId = args.tasks[0].evidence[0].id;
	const coverage = args.tasks[0].criteria.map((criterion) => ({
		criterionId: criterion.id,
		evidenceIds: [evidenceId],
	}));
	assert.equal(verifyMeta.name, "mobius-verify");
	const result = await runVerify(executionContext(args, {
		"mobius-verify:coverage-reviewer": {
			coverage,
			missingEvidence: [],
			integrationFindings: [],
			risks: [],
		},
		"mobius-verify:integration-skeptic": {
			coverage: [],
			missingEvidence: [],
			integrationFindings: [],
			risks: [],
		},
		"mobius-verify:verifier": {
			passed: true,
			summary: "Verified",
			evidenceIds: [evidenceId],
			missingEvidence: [],
			correctionTaskIds: [],
		},
	}));
	assert.deepEqual(result.input, args);
	assert.equal(validateVerificationResult(result, args).passed, true);
});

test("imports a completed planning Factory result", async () => {
	const input = buildPlanningArgs({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});
	const analysis = createFactoryAnalysis(() => fakeApi({
		planning: {
			factoryName: "mobius-plan",
			run: {
				runId: "planning",
				status: "completed",
				result: planningResult(input),
			},
		},
	}));
	const imported = await analysis.importPlanning("planning");
	assert.equal(imported.plan.objective, "Build");
	assert.equal(imported.inputDigest, input.inputDigest);
});

test("rejects a run owned by the wrong Factory", async () => {
	const analysis = createFactoryAnalysis(() => fakeApi({
		wrong: {
			factoryName: "other",
			run: { runId: "wrong", status: "completed", result: {} },
		},
	}));
	await assert.rejects(
		analysis.importPlanning("wrong"),
		(error) => error instanceof MobiusFactoryError && error.code === "factory_run_identity_mismatch",
	);
});

test("fails clearly when native Factory inspection is unavailable", async () => {
	const analysis = createFactoryAnalysis(() => ({}));
	await assert.rejects(
		analysis.importPlanning("run"),
		(error) =>
			error instanceof MobiusFactoryError &&
			error.code === "factory_backend_unavailable",
	);
});

test("verification binding accepts active runs and validates completed results", async () => {
	const plan = completedPlan();
	const args = buildVerificationInput(plan);
	const coverage = args.tasks[0].criteria.map((criterion) => ({
		criterionId: criterion.id,
		evidenceIds: [args.tasks[0].evidence[0].id],
	}));
	const result = {
		kind: "mobius-verification-result",
		input: args,
		inputDigest: args.inputDigest,
		planId: plan.id,
		passed: true,
		summary: "Passed",
		evidenceIds: [args.tasks[0].evidence[0].id],
		missingEvidence: [],
		correctionTaskIds: [],
		reviews: [
			{
				coverage,
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
			{
				coverage: [],
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
		],
	};
	const records = {
		active: {
			factoryName: "mobius-verify",
			run: { runId: "active", status: "running" },
		},
		complete: {
			factoryName: "mobius-verify",
			run: { runId: "complete", status: "completed", result },
		},
	};
	const analysis = createFactoryAnalysis(() => fakeApi(records));
	const active = await analysis.inspectVerification("active", plan);
	assert.equal(active.run.status, "running");
	const complete = await analysis.inspectVerification("complete", plan, { requireComplete: true });
	assert.equal(complete.result.passed, true);
	assert.equal(await analysis.verificationRunCanBeReplaced("active", plan), false);
	assert.equal(await analysis.verificationRunCanBeReplaced("complete", plan), false);
	assert.equal(await analysis.verificationRunIsTerminal("complete"), true);
});

test("failed, invalid, and missing verification runs are replaceable", async () => {
	const plan = completedPlan();
	const records = {
		failed: {
			factoryName: "mobius-verify",
			run: { runId: "failed", status: "error", error: "boom" },
		},
		future: {
			factoryName: "mobius-verify",
			run: { runId: "future", status: "queued" },
		},
	};
	const analysis = createFactoryAnalysis(() => fakeApi(records));
	assert.equal(await analysis.verificationRunCanBeReplaced("failed", plan), true);
	assert.equal(await analysis.verificationRunCanBeReplaced("future", plan), false);
	assert.equal(await analysis.verificationRunCanBeReplaced("missing", plan), true);
	assert.equal(await analysis.verificationRunIsTerminal("failed"), true);
	assert.equal(await analysis.verificationRunIsTerminal("missing"), false);
});

test("unrelated Factory read failures are never treated as missing runs", async () => {
	const api = {
		async getRun() {
			throw new Error("unknown accounting state");
		},
		async getRunDetail() {
			throw new Error("unknown accounting state");
		},
	};
	const analysis = createFactoryAnalysis(() => api);
	await assert.rejects(
		analysis.verificationRunCanBeReplaced("run", completedPlan()),
		/unknown accounting state/,
	);
	await assert.rejects(
		analysis.verificationRunIsTerminal("run"),
		/unknown accounting state/,
	);
});

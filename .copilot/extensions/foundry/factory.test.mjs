import test from "node:test";
import assert from "node:assert/strict";

import {
	buildPlanningArgs,
	buildVerificationInput,
	validatePlanningResult,
	validateVerificationResult,
} from "./analysis.mjs";
import { createFactoryAnalysis, FoundryFactoryError } from "./factory.mjs";
import { meta as planMeta, run as runPlan } from "./factories/plan.mjs";
import { meta as verifyMeta, run as runVerify } from "./factories/verify.mjs";
import { verificationMarker } from "./marker.mjs";
import {
	ATTEMPT_STATUS,
	EVIDENCE_TYPE,
	PLAN_STATUS,
	approvePlan,
	attachTaskAttempt,
	completeTaskAttempt,
	createDraftPlan,
	reconcileTaskReadiness,
	reserveTaskAttempt,
	reserveVerification,
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
			const all = (record.progress ?? []).map((text, index) => ({
				seq: (record.seqBase ?? 0) + index,
				kind: "log",
				text,
			}));
			const page = all.slice(-200);
			return {
				runId,
				factoryName: record.factoryName,
				status: record.run.status,
				createdAt: record.createdAt ?? Date.parse("2026-08-07T00:10:00.000Z"),
				progress: {
					records: page,
					oldestSeq: page[0]?.seq ?? null,
					newestSeq: page.at(-1)?.seq ?? null,
					hasMoreOlder: all.length > page.length,
					hasMoreNewer: false,
				},
			};
		},
		async listRuns() {
			return Object.entries(records).map(([runId, record]) => ({
				runId,
				factoryName: record.factoryName,
				status: record.run.status,
				createdAt: record.createdAt ?? Date.parse("2026-08-07T00:10:00.000Z"),
			}));
		},
		async getRunProgress(runId, options = {}) {
			const record = records[runId];
			if (!record) throw new Error(`Factory run ${runId} not found`);
			const all = (record.progress ?? []).map((text, index) => ({
				seq: (record.seqBase ?? 0) + index,
				kind: "log",
				text,
			}));
			const limit = options.limit ?? 200;
			const eligible = options.beforeSeq != null
				? all.filter((entry) => entry.seq < options.beforeSeq).slice(-limit)
				: all.filter((entry) => entry.seq > (options.afterSeq ?? -1)).slice(0, limit);
			const page = eligible;
			return {
				records: page,
				oldestSeq: page[0]?.seq ?? null,
				newestSeq: page.at(-1)?.seq ?? null,
				hasMoreOlder: all.some(
					(entry) => entry.seq < (page[0]?.seq ?? Number.POSITIVE_INFINITY),
				),
				hasMoreNewer: all.some(
					(entry) => entry.seq > (page.at(-1)?.seq ?? (options.afterSeq ?? -1)),
				),
			};
		},
		async cancel(runId) {
			const record = records[runId];
			if (!record) throw new Error(`Factory run ${runId} not found`);
			record.run = { ...record.run, status: "cancelled" };
			return record.run;
		},
		async waitForRun(runId) {
			const record = records[runId];
			if (!record) throw new Error(`Factory run ${runId} not found`);
			return record.run;
		},
	};
}

function executionContext(args, responses) {
	const logs = [];
	return {
		args,
		logs,
		runId: "native-run",
		signal: new AbortController().signal,
		phase() {
			assert.equal(this.runId, "native-run");
		},
		log(message) {
			assert.equal(this.runId, "native-run");
			logs.push(message);
		},
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
		kind: "foundry-plan-result",
		inputDigest: input.inputDigest,
		input,
		status: "ready",
		plan: {
			title: "Plan",
			objective: input.objective,
			constraints: input.constraints,
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
					description: "Verify the final delivery",
					dependsOn: ["T-001"],
					acceptanceCriteria: [],
					expectedFiles: [],
					deliveryRequirement: "commit",
				},
			],
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
	plan = completeTaskAttempt(plan, "T-001", "T-001-A001", ATTEMPT_STATUS.DONE, {
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
	plan = reconcileTaskReadiness(plan, { at: "2026-08-07T00:06:00.000Z" });
	plan = reserveTaskAttempt(plan, "T-002", {
		reservationId: "factory-verifier",
		at: "2026-08-07T00:07:00.000Z",
	});
	plan = attachTaskAttempt(plan, "T-002", "T-002-A001", {
		sessionId: "session-2",
		branch: "work/factory-verifier",
		at: "2026-08-07T00:08:00.000Z",
	});
	return completeTaskAttempt(plan, "T-002", "T-002-A001", ATTEMPT_STATUS.DONE, {
		resultSummary: "Independent report",
		evidence: [
			{
				checkId: "T-001-C001",
				type: EVIDENCE_TYPE.TEST,
				summary: "Tests pass",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "final-integration",
				type: EVIDENCE_TYPE.INTEGRATION,
				summary: "Integration passes",
				source: "node --test",
				outcome: "passed",
			},
			{
				checkId: "workspace-integrity",
				type: EVIDENCE_TYPE.COMMAND,
				summary: "Workspace is clean",
				source: "git status --porcelain",
				outcome: "passed",
			},
		],
		branch: "work/factory-verifier",
		commit: "a".repeat(40),
		at: "2026-08-07T00:09:00.000Z",
	});
}

function reservedPlan(reservationId = "verification-reservation") {
	const plan = completedPlan();
	const input = buildVerificationInput(plan);
	return reserveVerification(plan, {
		reservationId,
		inputDigest: input.inputDigest,
		at: "2026-08-07T00:06:00.000Z",
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

	assert.equal(planning.launchSpec.name, "plan");
	assert.equal(Object.hasOwn(planning.launchSpec, "limits"), false);

	const verification = await analysis.prepareVerification(
		completedPlan(),
		"verification-reservation",
	);
	assert.equal(verification.launchSpec.name, "verify");
	assert.equal(verification.launchSpec.args.planId, "factory-plan");
	assert.equal(
		verification.launchSpec.args.reservationId,
		"verification-reservation",
	);
	assert.equal(Object.hasOwn(verification.launchSpec, "limits"), false);
});

test("bundled planning factory executes with native result semantics", async () => {
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
	assert.equal(planMeta.name, "plan");
	const result = await runPlan(executionContext(args, {
		"plan:decomposer": blueprint,
		"plan:architecture-critic": {
			verdict: "accept",
			risks: [],
			requiredChanges: [],
		},
		"plan:delivery-risk-critic": {
			verdict: "accept",
			risks: [],
			requiredChanges: [],
		},
		"plan:synthesizer": blueprint,
		"plan:verifier": { passed: true, issues: [] },
	}));
	assert.equal(result.kind, "foundry-plan-result");
	assert.equal(result.status, "ready");
	assert.equal(validatePlanningResult(result, args, 2).tasks.length, 2);
});

test("bundled verification factory echoes its complete native input", async () => {
	const args = buildVerificationInput(completedPlan());
	const reservationId = "verification-reservation";
	const evidenceIds = args.verificationReport.evidence.map((entry) => entry.id);
	const coverage = args.tasks[0].criteria.map((criterion) => ({
		criterionId: criterion.id,
		evidenceIds: [evidenceIds[0]],
	}));
	assert.equal(verifyMeta.name, "verify");
	const factory = executionContext({ ...args, reservationId }, {
		"verify:coverage-reviewer": {
			coverage,
			missingEvidence: [],
			integrationFindings: [],
			risks: [],
		},
		"verify:integration-skeptic": {
			coverage: [],
			missingEvidence: [],
			integrationFindings: [],
			risks: [],
		},
		"verify:verifier": {
			passed: true,
			summary: "Verified",
			evidenceIds,
			missingEvidence: [],
			correctionTaskIds: [],
		},
	});
	const result = await runVerify(factory);
	assert.equal(factory.logs[0], verificationMarker(reservationId));
	assert.deepEqual(result.input, args);
	assert.equal(result.reservationId, reservationId);
	assert.equal(validateVerificationResult(result, args, reservationId).passed, true);
});

test("verification factory emits its marker before full input validation", async () => {
	const reservationId = "invalid-input-reservation";
	const factory = executionContext({ reservationId }, {});
	await assert.rejects(runVerify(factory), /planId must be a non-empty string/);
	assert.equal(factory.logs[0], verificationMarker(reservationId));
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
			factoryName: "plan",
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
		(error) => error instanceof FoundryFactoryError && error.code === "factory_run_identity_mismatch",
	);
});

test("fails clearly when native Factory inspection is unavailable", async () => {
	const analysis = createFactoryAnalysis(() => ({}));
	await assert.rejects(
		analysis.importPlanning("run"),
		(error) =>
			error instanceof FoundryFactoryError &&
			error.code === "factory_backend_unavailable",
	);
});

test("verification import validates the terminal result and reservation", async () => {
	const plan = reservedPlan();
	const args = buildVerificationInput(plan);
	const reservationId = plan.verification.reservationId;
	const marker = verificationMarker(reservationId);
	const coverage = args.tasks[0].criteria.map((criterion, index) => ({
		criterionId: criterion.id,
		evidenceIds: [args.verificationReport.evidence[index].id],
	}));
	const result = {
		kind: "foundry-verification-result",
		reservationId,
		input: args,
		inputDigest: args.inputDigest,
		planId: plan.id,
		passed: true,
		summary: "Passed",
		evidenceIds: args.verificationReport.evidence.map((entry) => entry.id),
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
		complete: {
			factoryName: "verify",
			run: { runId: "complete", status: "completed", result },
			progress: [marker],
		},
	};
	const analysis = createFactoryAnalysis(() => fakeApi(records));
	const complete = await analysis.importVerification("complete", plan);
	assert.equal(complete.result.passed, true);
	assert.equal(await analysis.verificationRunIsTerminal("complete"), true);
});

test("verification import rejects stale runs and foreign reservation markers", async () => {
	const plan = reservedPlan("expected-reservation");
	const marker = verificationMarker(plan.verification.reservationId);
	const records = {
		stale: {
			factoryName: "verify",
			run: { runId: "stale", status: "completed", result: {} },
			createdAt: Date.parse("2026-08-07T00:05:00.000Z"),
			progress: [marker],
		},
		foreign: {
			factoryName: "verify",
			run: { runId: "foreign", status: "completed", result: {} },
			progress: [verificationMarker("other-reservation")],
		},
		late: {
			factoryName: "verify",
			run: { runId: "late", status: "completed", result: {} },
			progress: ["other progress", marker],
		},
	};
	const analysis = createFactoryAnalysis(() => fakeApi(records));
	await assert.rejects(
		analysis.importVerification("stale", plan),
		/predates verification reservation/,
	);
	await assert.rejects(
		analysis.importVerification("foreign", plan),
		/does not carry verification reservation/,
	);
});

test("discoverVerificationRun is base-agnostic and reports duplicates", async () => {
	const plan = reservedPlan("find-reservation");
	const marker = verificationMarker(plan.verification.reservationId);
	const records = {
		match: {
			factoryName: "verify",
			run: { runId: "match", status: "running" },
			progress: ["earlier runtime record", marker, "later progress"],
			seqBase: 1,
		},
		foreign: {
			factoryName: "verify",
			run: { runId: "foreign", status: "running" },
			progress: [verificationMarker("other-reservation")],
		},
	};
	const analysis = createFactoryAnalysis(() => fakeApi(records));
	const found = await analysis.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(found.state, "found");
	assert.equal(found.run.runId, "match");

	const ambiguous = createFactoryAnalysis(() => fakeApi({
		first: {
			factoryName: "verify",
			run: { runId: "first", status: "running" },
			progress: [marker],
		},
		second: {
			factoryName: "verify",
			run: { runId: "second", status: "running" },
			progress: [marker],
		},
	}));
	const duplicate = await ambiguous.discoverVerificationRun(
		plan.verification.reservationId,
		plan.verification.reservedAt,
	);
	assert.equal(duplicate.state, "inconclusive");
	assert.deepEqual(duplicate.candidates.map((run) => run.runId), [
		"first",
		"second",
	]);
});

test("discoverVerificationRun distinguishes absent from inconclusive", async () => {
	const plan = reservedPlan("tri-state-reservation");
	const active = createFactoryAnalysis(() => fakeApi({
		pending: {
			factoryName: "verify",
			run: { runId: "pending", status: "pending" },
			progress: [],
		},
	}));
	assert.equal(
		(await active.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		)).state,
		"inconclusive",
	);

	const terminal = createFactoryAnalysis(() => fakeApi({
		failed: {
			factoryName: "verify",
			run: { runId: "failed", status: "error" },
			progress: [],
		},
	}));
	assert.deepEqual(
		await terminal.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		),
		{ state: "absent" },
	);
});

test("unrelated Factory read failures are never treated as missing runs", async () => {
	const api = {
		async getRun() {
			throw new Error("unknown accounting state");
		},
		async getRunDetail() {
			throw new Error("unknown accounting state");
		},
		async listRuns() {
			throw new Error("unknown accounting state");
		},
		async getRunProgress() {
			throw new Error("unknown accounting state");
		},
	};
	const analysis = createFactoryAnalysis(() => api);
	await assert.rejects(
		analysis.verificationRunIsTerminal("run"),
		/unknown accounting state/,
	);
});

test("verification cancellation checks Factory identity and reaches terminal state", async () => {
	const records = {
		active: {
			factoryName: "verify",
			run: { runId: "active", status: "running" },
		},
		wrong: {
			factoryName: "other",
			run: { runId: "wrong", status: "running" },
		},
	};
	const analysis = createFactoryAnalysis(() => fakeApi(records));
	assert.deepEqual(await analysis.cancelVerificationRun("active"), {
		runId: "active",
		status: "cancelled",
		alreadyTerminal: false,
	});
	await assert.rejects(
		analysis.cancelVerificationRun("wrong"),
		(error) => error.code === "factory_run_identity_mismatch",
	);
});

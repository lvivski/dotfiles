import assert from "node:assert/strict";
import test from "node:test";
import { buildPlanningArgs } from "../../analysis/planning.mjs";
import { buildVerificationInput } from "../../analysis/verification.mjs";
import { verificationMarker } from "../../marker.mjs";
import { FoundryWorkflowError } from "../../native/guards.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { fakeApi } from "./api.mjs";
import { completedPlan, planningResult, reservedPlan } from "./plans.mjs";

test("prepare operations return native run_dynamic_workflow launch specs", async () => {
	const analysis = createWorkflowAnalysis(() => fakeApi());
	const planning = await analysis.preparePlanning({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});

	assert.equal(planning.workflow, "plan");
	assert.equal(planning.launchSpec.name, planning.workflow);
	assert.equal(Object.hasOwn(planning.launchSpec, "limits"), false);

	const verification = await analysis.prepareVerification(
		completedPlan(),
		"verification-reservation",
	);
	assert.equal(verification.workflow, "verify");
	assert.equal(verification.launchSpec.name, verification.workflow);
	assert.equal(verification.launchSpec.args.planId, "workflow-plan");
	assert.equal(
		verification.launchSpec.args.reservationId,
		"verification-reservation",
	);
	assert.equal(Object.hasOwn(verification.launchSpec, "limits"), false);
});

test("planning imports use native settlement without resuming or cancelling runs", async () => {
	const input = buildPlanningArgs({
		objective: "Build",
		constraints: [],
		repositoryContext: "Node repository",
		maxTasks: 2,
	});
	for (const outcome of ["completed", "pending", "running", "paused", "error", "interrupted"]) {
		const controller = new AbortController();
		const interrupted = new Error("Import interrupted");
		/** @type {import("@github/copilot-sdk").WorkflowRunResult} */
		const run = {
			runId: "planning",
			status: outcome === "completed" ? "completed" : outcome === "pending" ? "pending" : "running",
		};
		if (outcome === "completed") run.result = planningResult(input);
		let waits = 0;
		const api = Object.assign(fakeApi({ planning: { workflowName: "plan", run } }), {
			/** @param {string} runId @param {{signal: AbortSignal}} options */
			async waitForRun(runId, { signal }) {
				assert.equal(runId, run.runId);
				assert.equal(signal, controller.signal);
				waits++;
				await new Promise((resolve) => setImmediate(resolve));
				if (outcome === "interrupted") {
					controller.abort(interrupted);
					signal.throwIfAborted();
				}
				run.status = outcome === "paused" ? "paused" : outcome === "error" ? "error" : "completed";
				if (run.status === "completed") run.result = planningResult(input);
				return run;
			},
		});
		const analysis = createWorkflowAnalysis(() => api);
		const importing = analysis.importPlanning("planning", { signal: controller.signal });
		if (outcome === "interrupted") {
			await assert.rejects(importing, (error) => error === interrupted);
			assert.equal(run.status, "running");
		} else if (outcome === "paused" || outcome === "error") {
			await assert.rejects(importing, {
				code: "workflow_result_unavailable",
				details: { status: outcome, failure: null },
			});
		} else {
			const imported = await importing;
			assert.equal(imported.plan.objective, "Build");
			assert.equal(imported.inputDigest, input.inputDigest);
		}
		assert.equal(waits, outcome === "completed" ? 0 : 1);
		assert.deepEqual(api.cancelCalls, []);
	}
});

test("rejects a run owned by the wrong Workflow", async () => {
	const analysis = createWorkflowAnalysis(() => fakeApi({
		wrong: {
			workflowName: "other",
			run: { runId: "wrong", status: "running" },
		},
	}));
	await assert.rejects(
		analysis.importPlanning("wrong"),
		(error) => error instanceof FoundryWorkflowError && error.code === "workflow_run_identity_mismatch",
	);
});

test("fails clearly when native Workflow inspection is unavailable", async () => {
	const analysis = createWorkflowAnalysis(() => ({}));
	await assert.rejects(
		analysis.importPlanning("run"),
		(error) =>
			error instanceof FoundryWorkflowError &&
			error.code === "workflow_backend_unavailable",
	);
});

test("native workflow failures retain their structured recovery metadata", async () => {
	/** @type {NonNullable<import("@github/copilot-sdk").WorkflowRunResult["failure"]>[]} */
	const failures = [
		{
			type: "workflow_limit_reached",
			runId: "failed",
			kind: "maxAiCredits",
			value: 10,
			suggestedValue: 20,
		},
		{ type: "workflow_resume_declined", runId: "failed", reason: "User declined" },
		{
			type: "workflow_durable_failure",
			runId: "failed",
			code: "workflow_storage_unavailable",
			operation: "journalGet",
		},
		{ type: "workflow_accounting_incomplete", runId: "failed", drainedNanoAiu: 100 },
		{ type: "workflow_provider_disconnected", runId: "failed" },
	];
	for (const failure of failures) {
		const analysis = createWorkflowAnalysis(() => fakeApi({
			failed: {
				workflowName: "plan",
				run: { runId: "failed", status: "error", failure },
			},
		}));
		await assert.rejects(analysis.importPlanning("failed"), {
			code: "workflow_result_unavailable",
			details: { status: "error", failure },
		});
	}
});

test("pause metadata is preserved without treating a settled attempt as cancelled", async () => {
	/** @type {NonNullable<import("@github/copilot-sdk").WorkflowRunResult["pauseInfo"]>[]} */
	const pauses = [{ type: "user" }, { type: "checkpoint", key: "review-ready" }];
	for (const pauseInfo of pauses) {
		const run = { runId: "paused", status: "paused", attempt: 2, pauseInfo };
		const analysis = createWorkflowAnalysis(() => fakeApi({
			paused: { workflowName: "verify", run },
		}));
		// @ts-expect-error A paused native run must be classified before consulting a plan.
		assert.deepEqual(await analysis.assessVerificationRun("paused", null), {
			state: "paused",
			run,
		});
		assert.equal(await analysis.verificationRunIsTerminal("paused"), false);
	}
});

test("verification import validates the terminal result and reservation", async () => {
	const plan = reservedPlan();
	const args = buildVerificationInput(plan);
	const reservationId = plan.verification.reservationId;
	const marker = verificationMarker(reservationId);
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
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
			{
				missingEvidence: [],
				integrationFindings: [],
				risks: [],
			},
		],
	};
	const records = {
		complete: {
			workflowName: "verify",
			run: { runId: "complete", status: "completed", result },
			progressUnavailable: true,
		},
		unknownTimestamp: {
			workflowName: "verify",
			run: { runId: "unknownTimestamp", status: "completed", result },
			createdAt: "2026-08-07T00:10:00.000Z",
			progress: [],
		},
		active: {
			workflowName: "verify",
			run: { runId: "active", status: "running", result },
			completedAt: /** @type {number | null} */ (null),
			progress: [marker],
		},
	};
	const completedAt = Date.parse("2026-08-07T00:11:00.000Z");
	const api = Object.assign(fakeApi(records), {
		async waitForRun(/** @type {string} */ runId) {
			assert.equal(runId, "active");
			await new Promise((resolve) => setImmediate(resolve));
			records.active.run.status = "completed";
			records.active.completedAt = completedAt;
			return records.active.run;
		},
	});
	const getRunDetail = api.getRunDetail.bind(api);
	let detailReads = 0;
	api.getRunDetail = async (runId) => {
		detailReads++;
		return getRunDetail(runId);
	};
	const analysis = createWorkflowAnalysis(() => api);
	const complete = await analysis.importVerification("complete", plan);
	assert.equal(complete.result.passed, true);
	assert.equal(detailReads, 1);
	assert.equal(
		(await analysis.importVerification("unknownTimestamp", plan)).result.passed,
		true,
	);
	assert.equal(await analysis.verificationRunIsTerminal("complete"), true);
	const active = await analysis.importVerification("active", plan);
	assert.equal(active.result.passed, true);
	assert.equal(active.detail.completedAt, completedAt);
	assert.equal(detailReads, 4);
	records.complete.run.result = { ...result, reservationId: "foreign-reservation" };
	await assert.rejects(analysis.importVerification("complete", plan), /does not match its run/);
});

test("verification import rejects stale and foreign runs before waiting", async () => {
	const plan = reservedPlan("expected-reservation");
	const marker = verificationMarker(plan.verification.reservationId);
	const records = {
		stale: {
			workflowName: "verify",
			run: { runId: "stale", status: "running" },
			createdAt: Date.parse("2026-08-07T00:05:00.000Z"),
			progress: [marker],
		},
		foreign: {
			workflowName: "verify",
			run: { runId: "foreign", status: "running" },
			progress: [verificationMarker("other-reservation")],
		},
		late: {
			workflowName: "verify",
			run: { runId: "late", status: "completed", result: {} },
			progress: ["other progress", marker],
		},
	};
	const analysis = createWorkflowAnalysis(() => fakeApi(records));
	await assert.rejects(
		analysis.importVerification("stale", plan),
		/predates verification reservation/,
	);
	await assert.rejects(
		analysis.importVerification("foreign", plan),
		/does not carry verification reservation/,
	);
});

test("malformed completed factory output falls back to its valid marker and permits explicit replacement", async () => {
	const plan = reservedPlan("malformed-factory-result");
	const input = buildVerificationInput(plan);
	const result = {
		kind: "foundry-verification-result", reservationId: plan.verification.reservationId, planId: plan.id,
		inputDigest: input.inputDigest, input: { ...input, factory: { binding: { repositoryId: "not-a-digest" }, evaluations: [] } },
		passed: true, summary: "Malformed report must not become permanently unobservable",
		evidenceIds: input.verificationReport.evidence.map((entry) => entry.id),
		missingEvidence: [], correctionTaskIds: [],
		reviews: [{ missingEvidence: [], integrationFindings: [], risks: [] }, { missingEvidence: [], integrationFindings: [], risks: [] }],
	};
	const api = fakeApi({
		malformed: {
			workflowName: "verify", run: { runId: "malformed", status: "completed", result },
			progress: [verificationMarker(plan.verification.reservationId)]
		},
	});
	const analysis = createWorkflowAnalysis(() => api);
	const discovery = await analysis.discoverVerificationRun(plan.verification.reservationId, plan.verification.reservedAt);
	assert.equal(discovery.state, "found");
	assert.equal(discovery.run.runId, "malformed");
	assert.equal((await analysis.assessVerificationRun("malformed", plan)).state, "terminal-nonimportable");
	const failure = new Error("Native storage is unavailable");
	api.getRun = async () => { throw failure; };
	assert.equal((await analysis.discoverVerificationRun(plan.verification.reservationId, plan.verification.reservedAt)).state, "inconclusive");
	await assert.rejects(analysis.assessVerificationRun("malformed", plan), (error) => error === failure);
});

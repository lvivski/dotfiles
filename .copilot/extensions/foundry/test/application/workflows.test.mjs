import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { available, completed as completedImport } from "../assertions.mjs";
import { workflowDetail as nativeDetail } from "../native/fixture.mjs";
import { analysisStub, completeImplementation, createInput, withOperations } from "./fixture.mjs";

/** @typedef {import("../../types/workflow.js").WorkflowAnalysisPort} AnalysisPort */

test("bound verification uses direct observation while completion retains collision checks", async () => {
	let discoveries = 0;
	let ambiguous = false;
	const run = nativeDetail({
		runId: "bound-run", workflowName: "verify", status: "running",
		canResume: false, createdAt: Date.now(),
	});
	/** @type {AnalysisPort} */
	const analysis = {
		...analysisStub({
			discoverVerificationRun: async () => {
				discoveries++;
				return ambiguous
					? { state: "inconclusive", reason: "Duplicate reservation", candidates: [run, { ...run, runId: "duplicate" }] }
					: { state: "found", run };
			},
		}),
		inspectWorkflow: async () => run,
		listWorkflowRuns: async () => ({ runs: [run], omittedOlder: 0 }),
		controlWorkflow: async () => ({ runId: run.runId, status: "paused" }),
	};
	await withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		({ plan } = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "bound-reservation",
		}));
		({ plan } = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "bound-reservation",
		}));
		assert.equal(plan.verification.runId, run.runId);
		assert.equal(discoveries, 1);
		const status = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.deepEqual(available(status.workflows).runs.map((entry) => entry.runId), [run.runId]);
		assert.equal(status.projection.nextAction.kind, "inspect-verification");
		assert.equal(await operations.getWorkflow({ planId: plan.id, runId: run.runId }), run);
		await operations.controlWorkflow({
			planId: plan.id, expectedRevision: plan.revision, runId: run.runId, action: "pause",
		});
		assert.equal(discoveries, 1);
		ambiguous = true;
		await assert.rejects(operations.finishVerification({
			planId: plan.id, expectedRevision: plan.revision, runId: run.runId,
		}), { code: "verification_launch_indeterminate" });
		assert.equal(discoveries, 2);
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, plan.revision);
	}, { analysis });
});

test("workflow controls enforce verification ownership without changing approvals or attempts", async () => {
	let unique = true;
	/** @type {Array<{runId: string, action: string}>} */
	const calls = [];
	const verify = nativeDetail({ runId: "verify-run", workflowName: "verify", status: "paused", canResume: true });
	/** @type {AnalysisPort} */
	const analysis = {
		...analysisStub({
			discoverVerificationRun: async () => unique
				? { state: "found", run: verify, duplicates: [] }
				: { state: "inconclusive", reason: "Duplicate reservation" },
		}),
		inspectWorkflow: async () => verify,
		listWorkflowRuns: async () => ({
			runs: [verify, { ...verify, runId: "foreign-run" }], omittedOlder: 0,
		}),
		controlWorkflow: async (runId, action) => {
			calls.push({ runId, action });
			return { runId, status: action === "pause" ? "paused" : "completed" };
		},
	};
	await withOperations(async ({ operations, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		({ plan } = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "control-reservation",
		}));
		const input = { planId: plan.id, expectedRevision: plan.revision, runId: "verify-run", action: "resume" };
		await assert.rejects(operations.controlWorkflow({ runId: "verify-run", action: "resume" }),
			{ code: "verification_plan_required" });
		await assert.rejects(operations.controlWorkflow({ ...input, expectedRevision: plan.revision - 1 }),
			{ code: "revision_conflict" });
		const status = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.deepEqual(available(status.workflows).runs.map((run) => run.runId), ["verify-run"]);
		assert.deepEqual(available(status.workflows).runs[0].actions, ["resume"]);
		await operations.controlWorkflow(input);
		assert.deepEqual(await operations.getPlan({ planId: plan.id }), plan);
		unique = false;
		await assert.rejects(operations.controlWorkflow(input), { code: "verification_launch_indeterminate" });
		const ambiguous = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.equal(available(ambiguous.workflows).warning, "Duplicate reservation");
		assert.deepEqual(available(ambiguous.workflows).runs, []);
		unique = true;
		plan = await operations.cancel({
			planId: plan.id, expectedRevision: plan.revision, requestId: "cancel-controls",
			reason: "Stop", requestedBy: "tester",
		});
		await assert.rejects(operations.controlWorkflow({ ...input, expectedRevision: plan.revision }),
			{ code: "verification_not_reserved" });
		assert.equal(calls.length, 1);
		const cancelling = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.deepEqual(available(cancelling.workflows).runs[0].actions, []);
		analysis.listWorkflowRuns = async () => { throw new Error("Native state unavailable"); };
		const unavailable = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.equal(unavailable.plan.id, plan.id);
		assert.deepEqual(unavailable.workflows, { state: "unavailable", error: "Native state unavailable" });
	}, { analysis });
});

test("workflow diagnostics return native detail and bounded older pages without persistence", async () => {
	const latest = {
		records: [{ seq: 1004, attempt: 2, phaseId: null, recordedAt: 123, kind: "log", text: "Latest entry" }],
		oldestSeq: 1004, newestSeq: 1004,
		hasMoreOlder: true, hasMoreNewer: false, revision: 8,
	};
	const detail = {
		runId: "standalone-run", workflowName: "audit", status: "paused", revision: 8,
		observedAt: 123, consumed: { nanoAiu: 1500000000, activeMs: 1200, subagents: 1 },
		approved: { maxTotalSubagents: 4 }, phases: [], agents: [], progress: latest,
	};
	const older = {
		records: Array.from({ length: 100 }, (_, index) => ({
			seq: 6 + index * 10, attempt: 1, phaseId: null, recordedAt: index, kind: "log", text: `Entry ${index}`,
		})),
		oldestSeq: 6, newestSeq: 996, hasMoreOlder: true, hasMoreNewer: true, revision: 9,
	};
	const empty = {
		records: [], oldestSeq: null, newestSeq: null,
		hasMoreOlder: false, hasMoreNewer: true, revision: 9,
	};
	/** @type {Array<{method: string, runId: string, options?: {beforeSeq?: number, limit?: number}}>} */
	const calls = [];
	const backend = {
		getRun: async () => assert.fail("Diagnostics do not import results"),
		getRunDetail: async (/** @type {string} */ runId) => {
			calls.push({ method: "detail", runId });
			return detail;
		},
		getRunProgress: async (/** @type {string} */ runId, /** @type {{beforeSeq?: number, limit?: number}} */ options) => {
			calls.push({ method: "progress", runId, options });
			return options.beforeSeq === 6 ? empty : older;
		},
		listRuns: async () => assert.fail("Standalone diagnostics do not list runs"),
	};
	const native = createWorkflowAnalysis(() => backend);
	const analysis = {
		...analysisStub({
			discoverVerificationRun: async () => assert.fail("Standalone reads do not discover verification"),
		}),
		inspectWorkflow: native.inspectWorkflow,
		getWorkflowProgress: native.getWorkflowProgress,
	};
	await withOperations(async ({ operations, notifications, workspacePath }) => {
		const plan = completedImport(await operations.createPlan(createInput(workspacePath)));
		const source = await operations.exportPlan({ planId: plan.id });
		const notificationCount = notifications.length;
		const input = { planId: plan.id, runId: detail.runId };
		assert.equal(await operations.getWorkflow(input), detail);
		assert.deepEqual(calls, [{ method: "detail", runId: detail.runId }]);
		const paged = await operations.getWorkflow({ ...input, beforeSeq: latest.oldestSeq });
		assert.deepEqual(paged, { ...detail, progress: older });
		assert.equal(paged.progress.records.length, 100);
		assert.equal(detail.progress, latest);
		assert.ok(paged.progress.oldestSeq !== null);
		assert.deepEqual(await operations.getWorkflow({ ...input, beforeSeq: paged.progress.oldestSeq }),
			{ ...detail, progress: empty });
		assert.deepEqual(calls.filter((call) => call.method === "progress"), [
			{ method: "progress", runId: detail.runId, options: { beforeSeq: 1004, limit: 100 } },
			{ method: "progress", runId: detail.runId, options: { beforeSeq: 6, limit: 100 } },
		]);

		/** @type {unknown[]} */
		const invalidCursors = ["", "6", " ", null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, []];
		const readCount = calls.length;
		for (const beforeSeq of invalidCursors) {
			await assert.rejects(operations.getWorkflow({ ...input, beforeSeq }),
				{ code: "workflow_progress_cursor_invalid" });
		}
		/** @type {unknown[]} */
		const invalidRunIds = ["", " \n", null, undefined, 1, {}, []];
		for (const runId of invalidRunIds) {
			await assert.rejects(operations.getWorkflow({ ...input, runId }), { code: "workflow_run_invalid" });
		}
		assert.equal(calls.length, readCount);
		const nativeError = Object.assign(new Error("Run is not owned by this session"), { code: "workflow_run_not_found" });
		const inspect = backend.getRunDetail;
		backend.getRunDetail = async () => { throw nativeError; };
		await assert.rejects(operations.getWorkflow(input), (error) => error === nativeError);
		backend.getRunDetail = inspect;
		backend.getRunProgress = async () => { throw nativeError; };
		await assert.rejects(operations.getWorkflow({ ...input, beforeSeq: 6 }), (error) => error === nativeError);
		assert.deepEqual(await operations.getPlan({ planId: plan.id }), plan);
		assert.equal(await operations.exportPlan({ planId: plan.id }), source);
		assert.equal(notifications.length, notificationCount);
	}, { analysis });
});

test("workflow diagnostics share the board's verification selection and persisted pin", async () => {
	const verify = nativeDetail({
		runId: "verify-run", workflowName: "verify", status: "paused", canResume: true, createdAt: 2,
		progress: { records: [], oldestSeq: null, newestSeq: null, hasMoreOlder: false, hasMoreNewer: false, revision: 1 },
	});
	const standalone = nativeDetail({ runId: "standalone-run", workflowName: "audit", status: "running", createdAt: 1 });
	/** @type {import("../../types/workflow.js").WorkflowDiscovery} */
	let discovery = { state: "found", run: verify, duplicates: [] };
	let progressReads = 0;
	/** @type {AnalysisPort} */
	const analysis = {
		...analysisStub({ discoverVerificationRun: async () => discovery }),
		inspectWorkflow: async (runId) => ({ ...verify, runId }),
		getWorkflowProgress: async () => { progressReads++; return verify.progress; },
		listWorkflowRuns: async () => ({
			runs: [standalone, { ...verify, runId: "other-plan-verify" }], omittedOlder: 20,
		}),
	};
	await withOperations(async ({ operations, notifications, workspacePath }) => {
		let plan = await completeImplementation(operations, workspacePath);
		await assert.rejects(operations.getWorkflow({ planId: plan.id, runId: verify.runId }),
			{ code: "verification_run_mismatch" });
		({ plan } = await operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "diagnostic-reservation",
		}));
		const input = { planId: plan.id, runId: verify.runId };
		const notificationCount = notifications.length;
		assert.deepEqual(await operations.getWorkflow(input), verify);
		await assert.rejects(operations.getWorkflow({ ...input, runId: "other-plan-verify", beforeSeq: 10 }),
			{ code: "verification_run_mismatch" });
		assert.equal(progressReads, 0);
		const status = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.deepEqual(available(status.workflows).runs.map((run) => run.runId), [verify.runId, standalone.runId]);
		assert.equal(available(status.workflows).omittedOlder, 20);
		for (const state of /** @type {const} */ (["absent", "inconclusive"])) {
			discovery = state === "absent" ? { state } : { state, reason: "Fixture discovery is inconclusive" };
			await assert.rejects(operations.getWorkflow(input), { code: "verification_run_mismatch" });
		}
		assert.deepEqual(await operations.getPlan({ planId: plan.id }), plan);
		assert.equal(notifications.length, notificationCount);
		discovery = { state: "found", run: verify, duplicates: [] };
		plan = completedImport(await operations.finishVerification({ ...input, expectedRevision: plan.revision }));
		analysis.discoverVerificationRun = async () => assert.fail("Completed verification uses its persisted binding");
		assert.deepEqual(await operations.getWorkflow(input), verify);
		await assert.rejects(operations.getWorkflow({ ...input, runId: "other-plan-verify" }),
			{ code: "verification_run_mismatch" });
		const completed = await operations.getStatus({ planId: plan.id, includeWorkflows: true });
		assert.deepEqual(available(completed.workflows).runs.map((run) => run.runId), [verify.runId, standalone.runId]);
		assert.deepEqual(available(completed.workflows).runs[0].actions, []);
		assert.deepEqual(await operations.getPlan({ planId: plan.id }), plan);
	}, { analysis });
});

test("workflow diagnostics revalidate ownership and revision after awaited native reads", async (t) => {
	for (const [stage, change, workflowName = "verify"] of [
		["detail", "revision"], ["discovery", "revision"], ["progress", "revision"], ["rediscovery", "revision"],
		["detail", "ownership"], ["progress", "ownership"], ["detail", "revision", "audit"],
	]) {
		await t.test(`${workflowName}: ${change} during ${stage}`, async () => {
			let duringRead = async (/** @type {string} */ _stage) => { };
			let selectedRunId = "verify-run";
			let discoveries = 0;
			const detail = nativeDetail({
				runId: "verify-run", workflowName,
			});
			/** @type {AnalysisPort} */
			const analysis = {
				...analysisStub({
					discoverVerificationRun: async () => {
						await duringRead(++discoveries === 1 ? "discovery" : "rediscovery");
						return { state: "found", run: { runId: selectedRunId, status: "running" }, duplicates: [] };
					},
				}),
				inspectWorkflow: async () => { await duringRead("detail"); return detail; },
				getWorkflowProgress: async () => { await duringRead("progress"); return detail.progress; },
			};
			await withOperations(async ({ operations, notifications, workspacePath }) => {
				let plan = await completeImplementation(operations, workspacePath);
				({ plan } = await operations.prepareVerification({
					planId: plan.id, expectedRevision: plan.revision, reservationId: "diagnostic-race",
				}));
				discoveries = 0;
				let changed = false;
				duringRead = async (current) => {
					if (current !== stage || changed) return;
					changed = true;
					if (change === "ownership") selectedRunId = "other-plan-verify";
					else await operations.storeFor().update(plan.id, plan.revision, { ...plan, title: "Concurrent update" });
				};
				const notificationCount = notifications.length;
				await assert.rejects(operations.getWorkflow({
					planId: plan.id, runId: detail.runId,
					...(stage === "progress" || stage === "rediscovery" ? { beforeSeq: 100 } : {}),
				}), { code: change === "revision" ? "revision_conflict" : "verification_run_mismatch" });
				assert.equal(changed, true);
				const persisted = await operations.getPlan({ planId: plan.id });
				assert.equal(persisted.revision, plan.revision + (change === "revision" ? 1 : 0));
				assert.deepEqual(persisted.verification, plan.verification);
				assert.equal(notifications.length, notificationCount);
			}, { analysis });
		});
	}
});

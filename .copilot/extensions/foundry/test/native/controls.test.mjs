import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { workflowDetail as nativeDetail } from "./fixture.mjs";

test("native controls preserve run identity and limits and reject ineligible runs", async () => {
	/** @type {import("@github/copilot-sdk").WorkflowRunDetail} */
	const detail = nativeDetail({
		runId: "native-run", workflowName: "deep-research", status: "running", revision: 1,
		createdAt: 1, completedAt: null, canResume: false, currentPhase: { id: "research", ordinal: 1 },
		liveAgentCount: 1, totalSpawnedAgentCount: 1, terminal: null,
		observedAt: 1, consumed: { activeMs: 0, subagents: 1, nanoAiu: 0 },
		declaredLimits: {}, approved: {}, phases: [], agents: [],
		progress: { records: [], oldestSeq: null, newestSeq: null, hasMoreOlder: false, hasMoreNewer: false, revision: 1 },
	});
	/** @type {Array<{action: string, runId: string, options?: unknown}>} */
	const calls = [];
	const backend = {
		getRun: async () => ({ runId: detail.runId, status: detail.status }),
		getRunDetail: async () => detail,
		getRunProgress: async () => detail.progress,
		listRuns: async () => ({ runs: [detail, { ...detail, workflowName: "foreign" }], omittedOlder: 4 }),
		pause: async (/** @type {string} */ runId) => {
			calls.push({ action: "pause", runId });
			detail.status = "paused";
			detail.canResume = true;
			detail.terminal = { pauseInfo: { type: "user" } };
			return { runId, status: detail.status };
		},
		resume: async (/** @type {string} */ runId, /** @type {unknown} */ options) => {
			calls.push({ action: "resume", runId, options });
			detail.status = "completed";
			detail.canResume = false;
			return { runId, status: detail.status };
		},
	};
	const analysis = createWorkflowAnalysis(() => backend);
	assert.equal((await analysis.controlWorkflow("native-run", "pause")).status, "paused");
	const page = await analysis.listWorkflowRuns();
	assert.equal(page.runs.length, 1);
	assert.equal(page.omittedOlder, 4);
	assert.equal(page.runs[0].terminal?.pauseInfo?.type, "user");
	assert.equal((await analysis.controlWorkflow("native-run", "resume")).status, "completed");
	assert.deepEqual(calls, [
		{ action: "pause", runId: "native-run" },
		{ action: "resume", runId: "native-run", options: { notifyOnComplete: true, logPhaseNames: true } },
	]);
	await assert.rejects(analysis.controlWorkflow("native-run", "resume"), { code: "workflow_not_resumable" });
	await assert.rejects(analysis.controlWorkflow("native-run", "pause"), { code: "workflow_not_active" });
	detail.canResume = true;
	detail.terminal = {
		pauseInfo: null,
		failure: { type: "workflow_limit_reached", runId: detail.runId, kind: "maxAiCredits", value: 10 },
	};
	await assert.rejects(analysis.controlWorkflow("native-run", "resume"), { code: "workflow_limit_reached" });
	detail.workflowName = "foreign";
	await assert.rejects(analysis.controlWorkflow("native-run", "resume"), { code: "workflow_run_identity_mismatch" });
	detail.workflowName = "audit";
	detail.status = "running";
	await assert.rejects(createWorkflowAnalysis(() => ({ ...backend, pause: undefined }))
		.controlWorkflow("native-run", "pause"), { code: "workflow_backend_unavailable" });
	for (const response of [
		{ runId: "wrong", status: "paused" },
		{ runId: "native-run", status: "running" },
	]) {
		await assert.rejects(createWorkflowAnalysis(() => ({ ...backend, pause: async () => response }))
			.controlWorkflow("native-run", "pause"), {
			code: response.runId === "wrong" ? "workflow_run_identity_mismatch" : "workflow_control_incomplete",
		});
	}
	assert.equal(calls.length, 2);
	detail.status = "paused";
	detail.terminal = { pauseInfo: { type: "user" } };
	const controller = new AbortController();
	let completeResume = (/** @type {unknown} */ _result) => { };
	let markStarted = () => { };
	const started = new Promise((resolve) => { markStarted = () => resolve(undefined); });
	const interruptible = createWorkflowAnalysis(() => ({
		...backend,
		resume: () => new Promise((resolve) => {
			completeResume = resolve;
			detail.status = "running";
			markStarted();
		}),
	}));
	const resuming = interruptible.controlWorkflow("native-run", "resume", { signal: controller.signal });
	await started;
	controller.abort();
	await assert.rejects(resuming, { name: "AbortError" });
	assert.equal(detail.status, "running");
	assert.equal(calls.length, 2);
	completeResume({ runId: "native-run", status: "completed" });
});

test("native diagnostic reads validate inputs and identity and preserve SDK failures", async () => {
	const detail = { runId: "diagnostic-run", workflowName: "audit" };
	const progress = {
		records: [], oldestSeq: null, newestSeq: null,
		hasMoreOlder: false, hasMoreNewer: true, revision: 3,
	};
	/** @type {Array<{method: string, runId: string, options?: unknown}>} */
	const calls = [];
	const backend = {
		getRun: async () => assert.fail("Diagnostics do not read result envelopes"),
		getRunDetail: async (/** @type {string} */ runId) => {
			calls.push({ method: "detail", runId });
			return detail;
		},
		getRunProgress: async (/** @type {string} */ runId, /** @type {unknown} */ options) => {
			calls.push({ method: "progress", runId, options });
			return progress;
		},
		listRuns: async () => assert.fail("Diagnostics do not enumerate runs"),
	};
	const analysis = createWorkflowAnalysis(() => backend);
	/** @type {unknown[]} */
	const invalidRunIds = ["", " \t\n", null, undefined, 1, {}, []];
	for (const runId of invalidRunIds) {
		await assert.rejects(analysis.inspectWorkflow(runId), { code: "workflow_run_invalid" });
		await assert.rejects(analysis.getWorkflowProgress(runId, 10), { code: "workflow_run_invalid" });
	}
	/** @type {unknown[]} */
	const invalidCursors = ["", "10", null, undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, true, {}, []];
	for (const beforeSeq of invalidCursors) {
		await assert.rejects(analysis.getWorkflowProgress(detail.runId, beforeSeq),
			{ code: "workflow_progress_cursor_invalid" });
	}
	assert.deepEqual(calls, []);
	assert.equal(await analysis.inspectWorkflow(detail.runId), detail);
	for (const beforeSeq of [1, 41, Number.MAX_SAFE_INTEGER]) {
		assert.equal(await analysis.getWorkflowProgress(detail.runId, beforeSeq), progress);
		assert.deepEqual(calls.at(-1), {
			method: "progress", runId: detail.runId, options: { beforeSeq, limit: 100 },
		});
	}
	detail.runId = "another-run";
	await assert.rejects(analysis.inspectWorkflow("diagnostic-run"), { code: "workflow_run_identity_mismatch" });
	detail.runId = "diagnostic-run";
	detail.workflowName = "unregistered";
	await assert.rejects(analysis.inspectWorkflow(detail.runId), { code: "workflow_run_identity_mismatch" });

	const nativeError = Object.assign(new Error("Native observation failed"), {
		code: -32603, data: { code: "workflow_storage_unavailable" },
	});
	backend.getRunDetail = async () => { throw nativeError; };
	backend.getRunProgress = async () => { throw nativeError; };
	await assert.rejects(analysis.inspectWorkflow(detail.runId), (error) => error === nativeError);
	await assert.rejects(analysis.getWorkflowProgress(detail.runId, 41), (error) => error === nativeError);
	const unavailable = createWorkflowAnalysis(() => undefined);
	await assert.rejects(unavailable.inspectWorkflow(detail.runId), { code: "workflow_backend_unavailable" });
	await assert.rejects(unavailable.getWorkflowProgress(detail.runId, 41), { code: "workflow_backend_unavailable" });
});

test("workflow listings keep twenty terminal summaries plus native active runs without hydration", async () => {
	const paused = { runId: "paused-run", workflowName: "audit", status: "paused", canResume: true };
	const terminal = Array.from({ length: 20 }, (_, index) => ({
		runId: `terminal-${index}`, workflowName: "deep-research", status: "completed",
	}));
	const active = [paused, { runId: "active-run", workflowName: "triage", status: "running" }];
	const page = {
		runs: [...active, ...terminal, { ...paused, runId: "unregistered-run", workflowName: "unregistered" }],
		oldestSeq: 21, newestSeq: 40, hasMoreNewer: false, omittedOlder: 20,
	};
	const analysis = createWorkflowAnalysis(() => ({
		getRun: async () => assert.fail("Summary reads do not load result envelopes"),
		getRunDetail: async () => assert.fail("Collapsed runs must not load detail"),
		getRunProgress: async () => assert.fail("Collapsed runs must not load progress"),
		listRuns: async (/** @type {unknown} */ options) => {
			assert.deepEqual(options, { limit: 20 });
			return page;
		},
	}));
	const result = await analysis.listWorkflowRuns();
	assert.deepEqual(result, { ...page, runs: [...active, ...terminal] });
	assert.equal(result.runs[0], paused);
	assert.equal(Object.hasOwn(result.runs[0], "progress"), false);
	assert.equal(page.runs.length, 23);
});

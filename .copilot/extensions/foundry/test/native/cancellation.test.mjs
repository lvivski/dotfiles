import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, errorMessage, property, readRecord } from "../../data.mjs";
import { createWorkflowAnalysis } from "../../workflow.mjs";
import { fakeApi } from "./api.mjs";

for (const status of ["running", "paused"]) test(`verification cancellation handles ${status} runs and checks identity`, async () => {
	const records = {
		active: {
			workflowName: "verify",
			run: { runId: "active", status },
		},
		wrong: {
			workflowName: "other",
			run: { runId: "wrong", status: "running" },
		},
	};
	const analysis = createWorkflowAnalysis(() => fakeApi(records));
	// @ts-expect-error Unsettled runs must be classified before consulting a plan.
	assert.equal((await analysis.assessVerificationRun("active", null)).state, status === "paused" ? "paused" : "active");
	assert.equal(await analysis.verificationRunIsTerminal("active"), false);
	assert.deepEqual(await analysis.cancelVerificationRun("active"), {
		runId: "active",
		status: "cancelled",
		alreadyTerminal: false,
	});
	await assert.rejects(
		analysis.cancelVerificationRun("wrong"),
		(/** @type {unknown} */ error) =>
			errorCode(error) === "workflow_run_identity_mismatch",
	);
});

test("verification cancellation returns already-terminal outcomes without cancelling", async () => {
	for (const status of ["completed", "error", "halted", "cancelled"]) {
		const api = fakeApi({
			settled: { workflowName: "verify", run: { runId: "settled", status } },
			wrong: { workflowName: "other", run: { runId: "wrong", status } },
		});
		const analysis = createWorkflowAnalysis(() => api);
		assert.deepEqual(await analysis.cancelVerificationRun("settled"), {
			runId: "settled",
			status,
			alreadyTerminal: true,
		});
		await assert.rejects(
			analysis.cancelVerificationRun("wrong"),
			(/** @type {unknown} */ error) => errorCode(error) === "workflow_run_identity_mismatch",
		);
		assert.deepEqual(api.cancelCalls, []);
	}
});

test("verification cancellation translates native errors without waiting", async () => {
	const api = fakeApi({
		active: { workflowName: "verify", run: { runId: "active", status: "running" } },
	});
	api.cancel = async () => { throw new Error("native cancellation failed"); };
	const analysis = createWorkflowAnalysis(() => api);
	await assert.rejects(
		analysis.cancelVerificationRun("active"),
		(/** @type {unknown} */ error) => errorCode(error) === "workflow_cancel_failed"
			&& errorMessage(error) === "native cancellation failed"
			&& property(property(error, "details"), "runId") === "active",
	);
	await assert.rejects(
		analysis.cancelVerificationRun("missing"),
		(/** @type {unknown} */ error) => errorCode(error) === "workflow_run_not_found",
	);
	const { cancel, ...withoutCancellation } = api;
	await assert.rejects(
		createWorkflowAnalysis(() => withoutCancellation).cancelVerificationRun("active"),
		(/** @type {unknown} */ error) => errorCode(error) === "workflow_backend_unavailable",
	);
});

test("verification cancellation rejects active or paused envelopes without a wait fallback", async () => {
	for (const response of [null, {}, { status: "running" }, { status: "pending" }, { runId: "active", status: "paused" }]) {
		const api = fakeApi({
			active: { workflowName: "verify", run: { runId: "active", status: "running" } },
		});
		api.cancel = async () => response;
		let waits = 0;
		const analysis = createWorkflowAnalysis(() => ({
			...api,
			async waitForRun() {
				waits++;
				return { runId: "active", status: "cancelled" };
			},
		}));
		await assert.rejects(
			analysis.cancelVerificationRun("active"),
			(/** @type {unknown} */ error) => errorCode(error) === "workflow_cancel_incomplete",
		);
		assert.equal(waits, 0);
	}
});

test("verification cancellation accepts only a terminal envelope for the requested run", async () => {
	for (const status of ["completed", "error", "halted", "cancelled"]) {
		const api = fakeApi({
			active: { workflowName: "verify", run: { runId: "active", status: "running" } },
		});
		api.cancel = async () => ({ runId: "active", status });
		assert.deepEqual(await createWorkflowAnalysis(() => api).cancelVerificationRun("active"), {
			runId: "active",
			status,
			alreadyTerminal: false,
		});
		api.cancel = async () => ({ runId: "different", status });
		await assert.rejects(
			createWorkflowAnalysis(() => api).cancelVerificationRun("active"),
			(/** @type {unknown} */ error) => errorCode(error) === "workflow_run_identity_mismatch",
		);
	}
});

test("failed cancellation can be retried and duplicate callbacks do not cancel again", async () => {
	const api = fakeApi({
		active: { workflowName: "verify", run: { runId: "active", status: "running" } },
	});
	const cancel = api.cancel;
	let calls = 0;
	api.cancel = async (runId) => {
		if (++calls === 1) throw new Error("native cancellation failed");
		return cancel(runId);
	};
	const analysis = createWorkflowAnalysis(() => api);
	await assert.rejects(analysis.cancelVerificationRun("active"), { code: "workflow_cancel_failed" });
	assert.equal(property(await api.getRun("active"), "status"), "running");
	assert.deepEqual(await analysis.cancelVerificationRun("active"), {
		runId: "active", status: "cancelled", alreadyTerminal: false,
	});
	for (let callback = 0; callback < 2; callback++) {
		assert.deepEqual(await analysis.cancelVerificationRun("active"), {
			runId: "active", status: "cancelled", alreadyTerminal: true,
		});
	}
	assert.equal(calls, 2);
	assert.deepEqual(api.cancelCalls, ["active"]);
});

test("native control failures and invalid envelopes never fall back to waiting", async () => {
	for (const action of /** @type {const} */ (["pause", "resume"])) {
		const api = fakeApi({
			active: {
				workflowName: "verify",
				run: { runId: "active", status: action === "pause" ? "running" : "paused" },
			},
		});
		const getRunDetail = api.getRunDetail;
		api.getRunDetail = async (runId) => ({
			...readRecord(await getRunDetail(runId)), canResume: true,
		});
		const nativeError = new Error(`native ${action} failed`);
		const failing = createWorkflowAnalysis(() => ({
			...api,
			[action]: async () => { throw nativeError; },
			waitForRun: async () => assert.fail("Control failures must not fall back to waiting"),
		}));
		await assert.rejects(failing.controlWorkflow("active", action), (error) => error === nativeError);
		for (const response of [null, undefined, { runId: "active", status: "running" }]) {
			const incomplete = createWorkflowAnalysis(() => ({
				...api,
				[action]: async () => response,
				waitForRun: async () => assert.fail("Incomplete controls must not fall back to waiting"),
			}));
			await assert.rejects(incomplete.controlWorkflow("active", action), {
				code: "workflow_control_incomplete",
			});
		}
		const mismatched = createWorkflowAnalysis(() => ({
			...api, [action]: async () => ({ runId: "foreign", status: "cancelled" }),
		}));
		await assert.rejects(mismatched.controlWorkflow("active", action), {
			code: "workflow_run_identity_mismatch",
		});
		assert.deepEqual(api.cancelCalls, []);
	}
});

test("aborting a control after native settlement still interrupts the caller", async () => {
	const api = fakeApi({
		active: { workflowName: "verify", run: { runId: "active", status: "running" } },
	});
	const controller = new AbortController();
	const reason = new Error("caller stopped waiting");
	let markStarted = () => {};
	const started = new Promise((resolve) => { markStarted = () => resolve(undefined); });
	let complete = (/** @type {unknown} */ _result) => {};
	const analysis = createWorkflowAnalysis(() => ({
		...api,
		pause: () => new Promise((resolve) => {
			complete = resolve;
			markStarted();
		}),
	}));
	const pending = analysis.controlWorkflow("active", "pause", { signal: controller.signal });
	await started;
	complete({ runId: "active", status: "paused" });
	queueMicrotask(() => controller.abort(reason));
	await assert.rejects(pending, (error) => error === reason);
	assert.deepEqual(api.cancelCalls, []);
});

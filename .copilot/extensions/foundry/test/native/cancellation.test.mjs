import assert from "node:assert/strict";
import test from "node:test";
import { errorCode, errorMessage, property } from "../../data.mjs";
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

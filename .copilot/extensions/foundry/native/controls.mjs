import { FOUNDRY_WORKFLOWS } from "../workflows/registry.mjs";
import { assertCompleted, assertRunId, fail, TERMINAL } from "./guards.mjs";

/**
 * Native pause/resume have no AbortSignal option; interrupt only the caller's wait.
 * @param {Promise<import("@github/copilot-sdk").WorkflowRunResult>} pending
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<import("@github/copilot-sdk").WorkflowRunResult>}
 */
function waitForControl(pending, signal) {
	if (!signal) return pending;
	return new Promise((resolve, reject) => {
		const aborted = () => reject(signal.reason);
		signal.addEventListener("abort", aborted, { once: true });
		if (signal.aborted) aborted();
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
	});
}

/**
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["api"]} api
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["loadRun"]} loadRun
 */
export function createWorkflowControls(api, loadRun) {

	/** @param {unknown} runId */
	const inspectWorkflow = async (runId) => {
		assertRunId(runId);
		const detail = await api().getRunDetail(runId);
		if (detail.runId !== runId || !Object.values(FOUNDRY_WORKFLOWS)
			.some(({ meta }) => meta.name === detail.workflowName)) {
			fail("workflow_run_identity_mismatch", `Run ${runId} is not a Foundry Workflow`);
		}
		return detail;
	};

	/** Capture current-session analysis only; never resolve a foreign stored run. @param {string} runId */
	const importAnalysis = async (runId) => {
		const detail = await inspectWorkflow(runId);
		if (!["audit", "deep-research", "review-queue", "security-review", "triage"].includes(detail.workflowName)) {
			fail("workflow_analysis_required", "Only standalone analysis runs can be captured as non-governing factory knowledge");
		}
		const specification = Object.values(FOUNDRY_WORKFLOWS).find((entry) => entry.meta.name === detail.workflowName);
		if (!specification) fail("workflow_analysis_required", "Unsupported analysis workflow");
		const inspected = await loadRun(runId, specification);
		assertCompleted(inspected.run);
		if (typeof inspected.detail.completedAt !== "number" || !Number.isFinite(inspected.detail.completedAt)) fail("workflow_provenance_missing", "Analysis completion timestamp is unavailable");
		const report = typeof inspected.run.result === "string" ? inspected.run.result : JSON.stringify(inspected.run.result);
		if (!report?.trim()) fail("workflow_result_invalid", "Analysis returned no retainable report");
		return { report, workflowName: detail.workflowName, completedAt: inspected.detail.completedAt, runId };
	};

	/**
	 * @param {unknown} runId
	 * @param {unknown} beforeSeq
	 * @returns {Promise<import("@github/copilot-sdk").WorkflowProgressPage>}
	 */
	const getWorkflowProgress = async (runId, beforeSeq) => {
		assertRunId(runId);
		if (typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq) || beforeSeq <= 0) {
			fail("workflow_progress_cursor_invalid", "beforeSeq must be a positive safe integer");
		}
		return api().getRunProgress(runId, { beforeSeq, limit: 100 });
	};

	const listWorkflowRuns = async () => {
		const page = await api().listRuns({ limit: 20 });
		const names = new Set(Object.values(FOUNDRY_WORKFLOWS).map(({ meta }) => meta.name));
		return { ...page, runs: page.runs.filter((run) => names.has(run.workflowName)) };
	};

	/** @param {string} runId @param {"pause" | "resume"} action @param {{signal?: AbortSignal}} [options] */
	const controlWorkflow = async (runId, action, { signal } = {}) => {
		signal?.throwIfAborted();
		const detail = await inspectWorkflow(runId);
		if (action !== "pause" && action !== "resume") {
			fail("workflow_action_invalid", "Workflow action must be pause or resume");
		}
		if (action === "pause" && detail.status !== "running") {
			fail("workflow_not_active", `Run ${runId} is ${detail.status}; refresh its state`);
		}
		if (action === "resume" && !detail.canResume) {
			fail("workflow_not_resumable", `The native runtime cannot resume run ${runId}`);
		}
		if (action === "resume" && detail.terminal?.failure?.type === "workflow_limit_reached") {
			fail("workflow_limit_reached", "Use run_dynamic_workflow to resume with an explicitly approved increase to the reached limit");
		}
		const backend = api();
		signal?.throwIfAborted();
		let pending;
		if (action === "pause") {
			if (typeof backend.pause !== "function") {
				fail("workflow_backend_unavailable", "Native Workflow pause is unavailable");
			}
			pending = backend.pause(runId);
		} else {
			if (typeof backend.resume !== "function") {
				fail("workflow_backend_unavailable", "Native Workflow resume is unavailable");
			}
			pending = backend.resume(runId, { notifyOnComplete: true, logPhaseNames: true });
		}
		const settled = await waitForControl(pending, signal);
		signal?.throwIfAborted();
		if (!settled) {
			fail("workflow_control_incomplete", `Workflow ${action} returned no settlement`, { runId });
		}
		if (settled.runId !== runId) {
			fail("workflow_run_identity_mismatch", `Workflow ${action} returned a different run`);
		}
		if (!TERMINAL.has(settled.status) && settled.status !== "paused") {
			fail("workflow_control_incomplete", `Workflow ${action} has not settled`, { runId, status: settled.status });
		}
		return settled;
	};
	return { inspectWorkflow, importAnalysis, getWorkflowProgress, listWorkflowRuns, controlWorkflow };
}

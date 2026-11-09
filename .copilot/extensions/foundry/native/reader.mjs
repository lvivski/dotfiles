import { errorMessage } from "../data.mjs";
import { assertCompleted, assertRunId, fail, FoundryWorkflowError, isMissingRun } from "./guards.mjs";

/**
 * @typedef {Pick<import("@github/copilot-sdk").SessionWorkflowApi,
 *   "getRun" | "getRunDetail" | "getRunProgress" | "listRuns">
 *   & Partial<Pick<import("@github/copilot-sdk").SessionWorkflowApi,
 *     "cancel" | "pause" | "resume" | "waitForRun">>} WorkflowInspectionApi
 */

/** @param {unknown} value @returns {value is WorkflowInspectionApi} */
function hasInspectionApi(value) {
	return typeof value === "object" && value !== null
		&& "getRun" in value && typeof value.getRun === "function"
		&& "getRunDetail" in value && typeof value.getRunDetail === "function"
		&& "getRunProgress" in value && typeof value.getRunProgress === "function"
		&& "listRuns" in value && typeof value.listRuns === "function";
}

/**
 * @param {() => unknown} getWorkflowApi
 */
export function createRunReader(getWorkflowApi) {

	/** Resolve the current session's Workflow API or fail closed. */
	const api = () => {
		const value = getWorkflowApi();
		if (!hasInspectionApi(value)) {
			fail(
				"workflow_backend_unavailable",
				"Foundry requires native Workflow run inspection APIs",
			);
		}
		return value;
	};

	/** @param {string} runId @param {Pick<import("@github/copilot-sdk").WorkflowHandle, "meta">} specification */
	const loadRun = async (runId, specification) => {
		assertRunId(runId);
		let run;
		let detail;
		try {
			[run, detail] = await Promise.all([
				api().getRun(runId),
				api().getRunDetail(runId),
			]);
		} catch (error) {
			if (
				error instanceof FoundryWorkflowError &&
				error.code === "workflow_backend_unavailable"
			) {
				throw error;
			}
			const message = errorMessage(error);
			fail(
				isMissingRun(error)
					? "workflow_run_not_found"
					: "workflow_run_invalid",
				message,
				{ runId },
			);
		}
		if (run.runId !== runId || detail.runId !== runId) {
			fail(
				"workflow_run_identity_mismatch",
				`Native Workflow lookup for ${runId} returned another run`,
				{ runId, actualRunId: run.runId, detailRunId: detail.runId },
			);
		}
		if (detail.workflowName !== specification.meta.name) {
			fail(
				"workflow_run_identity_mismatch",
				`Workflow run ${runId} belongs to ${detail.workflowName}, not ${specification.meta.name}`,
				{ runId, actualWorkflow: detail.workflowName },
			);
		}
		return { run, detail };
	};

	/**
	 * @param {string} runId
	 * @param {Pick<import("@github/copilot-sdk").WorkflowHandle, "meta">} specification
	 * @param {Awaited<ReturnType<typeof loadRun>>} inspected
	 * @param {{signal?: AbortSignal, wait?: boolean}} [options]
	 */
	const settleRun = async (runId, specification, inspected, { signal, wait = true } = {}) => {
		signal?.throwIfAborted();
		if (wait && (inspected.run.status === "pending" || inspected.run.status === "running")) {
			const backend = api();
			if (typeof backend.waitForRun !== "function") {
				fail("workflow_backend_unavailable", "Importing an active Workflow requires native waitForRun");
			}
			await backend.waitForRun(runId, { signal });
			signal?.throwIfAborted();
			inspected = await loadRun(runId, specification);
		}
		assertCompleted(inspected.run);
		return inspected;
	};
	return { api, loadRun, settleRun };
}

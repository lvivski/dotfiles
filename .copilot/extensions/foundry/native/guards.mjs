import { errorCode, errorMessage, property } from "../data.mjs";

// Paused runs retain their reservation and are not cancellation evidence.
export const TERMINAL = new Set(["completed", "error", "halted", "cancelled"]);

/** Typed failure raised when a native Workflow run cannot satisfy Foundry invariants. */
export class FoundryWorkflowError extends Error {
	/** @param {string} code @param {string} message @param {unknown} [details] */
	constructor(code, message, details = null) {
		super(message);
		this.name = "FoundryWorkflowError";
		this.code = code;
		this.details = details;
	}
}

/**
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 * @returns {never}
 */
export function fail(code, message, details) {
	throw new FoundryWorkflowError(code, message, details);
}

/** @param {unknown} runId @returns {asserts runId is string} */
export function assertRunId(runId) {
	if (typeof runId !== "string" || !runId.trim()) {
		fail("workflow_run_invalid", "A non-empty native Workflow run ID is required");
	}
}

/** @param {unknown} error */
export function isMissingRun(error) {
	const codes = [
		errorCode(error),
		errorCode(property(error, "data")),
		errorCode(property(error, "cause")),
		errorCode(property(property(error, "cause"), "data")),
	].filter((value) => typeof value === "string");
	if (codes.some((code) => code === "workflow_run_not_found" || code === "not_found")) {
		return true;
	}
	return /\b(?:workflow )?run\b.*\bnot found\b/i.test(errorMessage(error));
}

/**
 * @param {import("@github/copilot-sdk").WorkflowRunResult | null | undefined} run
 * @returns {asserts run is import("@github/copilot-sdk").WorkflowRunResult
 *   & {status: "completed"}}
 */
export function assertCompleted(run) {
	if (run?.status !== "completed" || !Object.hasOwn(run, "result")) {
		fail(
			"workflow_result_unavailable",
			`Workflow run ${run?.runId ?? "(unknown)"} is ${run?.status ?? "unknown"} and has no result`,
			{ status: run?.status, failure: run?.failure ?? null },
		);
	}
}

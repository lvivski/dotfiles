import { VERIFICATION_STATUS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @typedef {import("../types/workflow.js").WorkflowDiscovery} Discovery */

/**
 * @param {Pick<WorkflowAnalysis, "discoverVerificationRun">} analysis
 */
export function createVerificationOwnership(analysis) {

	/** Discover a native run launched for the plan's active verification reservation.
	 * @param {FoundryPlan} plan @param {boolean} [checkCollisions] @returns {Promise<Discovery>} */
	const discoverReservedVerification = async (plan, checkCollisions = false) => {
		if (plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
			return { state: "absent" };
		}
		if (plan.verification.runId && !checkCollisions) {
			return { state: "found", run: { runId: plan.verification.runId } };
		}
		if (!plan.verification.reservationId || !plan.verification.reservedAt) {
			throw new FoundryOperationError("workflow_reservation_invalid", "Reserved verification requires identity and time");
		}
		return analysis.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
	};

	/** @param {FoundryPlan} plan @param {string} runId @param {boolean} [checkCollisions] */
	const assertVerificationRun = async (plan, runId, checkCollisions = false) => {
		if (plan.verification.runId !== null && plan.verification.runId !== runId) {
			throw new FoundryOperationError(
				"verification_run_mismatch",
				`Verification is bound to ${plan.verification.runId}, not ${runId}`,
			);
		}
		const discovery = await discoverReservedVerification(plan, checkCollisions);
		if (discovery.state !== "found") {
			throw new FoundryOperationError(
				"verification_launch_indeterminate",
				"Verification reservation does not resolve to exactly one Workflow run",
				{ discovery },
			);
		}
		if (discovery.run.runId !== runId) {
			throw new FoundryOperationError(
				"verification_run_mismatch",
				`Verification run ${runId} is not authoritative for this reservation`,
				{ expectedRunId: discovery.run.runId, runId },
			);
		}
	};
	return { discoverReservedVerification, assertVerificationRun };
}

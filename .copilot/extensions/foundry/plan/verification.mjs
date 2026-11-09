import { assertPlainObject, assertRequestId, assertString, assertStringArray, clone, fail, nowIso, validateConceptualReview } from "./fields.mjs";
import { validatePlan } from "./validation.mjs";
import { LIMITS, PLAN_STATUS, TASK_STATUS, VERIFICATION_STATUS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").ClockValue} ClockValue */

/**
 * Persists a verification launch reservation before the Workflow is invoked.
 *
 * @param {FoundryPlan} plan
 * @param {{reservationId?: string, inputDigest?: string, at?: ClockValue, replacement?: Omit<import("../types/plan.js").VerificationReplacement, "at">}} [options]
 * @returns {FoundryPlan}
 */
export function reserveVerification(plan, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.RUNNING) {
		fail("invalid_plan_transition", `Verification cannot be reserved from ${plan.status}`, {
			path: "status",
		});
	}
	if (plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
		fail("implementation_incomplete", "Verification cannot be reserved until every task is done", {
			path: "tasks",
		});
	}
	assertRequestId(options.reservationId, "reservationId");
	if (typeof options.inputDigest !== "string"
		|| !/^[a-f0-9]{64}$/.test(options.inputDigest)) {
		fail("invalid_verification_digest", "inputDigest must be a SHA-256 digest", {
			path: "inputDigest",
		});
	}
	const timestamp = nowIso(options.at);
	const candidate = clone(plan);
	candidate.status = PLAN_STATUS.RUNNING;
	candidate.verification = {
		status: VERIFICATION_STATUS.RESERVED,
		reservationId: options.reservationId,
		runId: null,
		inputDigest: options.inputDigest,
		summary: null,
		evidence: [],
		missingEvidence: [],
		correctionTaskIds: [],
		replacement: options.replacement
			? {
				supersededReservationId: options.replacement.supersededReservationId,
				supersededRunId: options.replacement.supersededRunId ?? null,
				reason: options.replacement.reason,
				requestedBy: options.replacement.requestedBy,
				at: timestamp,
			}
			: null,
		reservedAt: timestamp,
		completedAt: null,
	};
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

/**
 * Binds an independently observed native run before waiting on external work.
 * @param {FoundryPlan} plan
 * @param {string} runId
 * @returns {FoundryPlan}
 */
export function bindVerificationRun(plan, runId) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.RUNNING
		|| plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
		fail("verification_not_reserved", "Only an active verification reservation can bind a run");
	}
	assertString(runId, "runId", LIMITS.verificationRunId);
	if (plan.verification.runId !== null && plan.verification.runId !== runId) {
		fail("verification_run_mismatch", "Verification is already bound to another run");
	}
	const candidate = clone(plan);
	candidate.verification.runId = runId;
	return validatePlan(candidate);
}

/**
 * Records an imported, evidence-validated verification result.
 *
 * @param {FoundryPlan} plan
 * @param {import("../types/analysis.js").VerificationOutcome} result
 * @param {{runId?: string, at?: ClockValue}} [options]
 * @returns {FoundryPlan}
 */
export function completeVerification(plan, result, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.RUNNING
		|| plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
		fail("verification_not_reserved", "Verification can only complete from a reservation", {
			path: "verification.status",
		});
	}
	assertString(options.runId, "runId", LIMITS.verificationRunId);
	if (plan.verification.runId !== null && plan.verification.runId !== options.runId) {
		fail("verification_run_mismatch", "The completed run does not match bound verification");
	}
	assertPlainObject(result, "result");
	validateConceptualReview(result.conceptualReview);
	assertString(result.summary, "result.summary", LIMITS.resultSummary);
	assertStringArray(result.evidence, "result.evidence", {
		maximum: LIMITS.verificationEvidence,
		itemMaximum: LIMITS.evidenceItem,
	});
	assertStringArray(result.missingEvidence, "result.missingEvidence", {
		maximum: LIMITS.missingEvidence,
		itemMaximum: LIMITS.missingEvidenceItem,
	});
	assertStringArray(result.correctionTaskIds, "result.correctionTaskIds", {
		maximum: LIMITS.tasks,
		itemMaximum: 5,
	});
	if (typeof result.passed !== "boolean") {
		fail("invalid_verification_result", "result.passed must be a boolean", {
			path: "result.passed",
		});
	}
	if (result.passed && (result.evidence.length === 0 || result.missingEvidence.length > 0)) {
		fail("invalid_verification_result", "Passed verification requires evidence and no missing evidence", {
			path: "result",
		});
	}
	if (result.passed && result.correctionTaskIds.length > 0) {
		fail("invalid_verification_result", "Passed verification cannot request corrections", {
			path: "result.correctionTaskIds",
		});
	}
	const taskIds = new Set(plan.tasks.map((task) => task.id));
	if (new Set(result.correctionTaskIds).size !== result.correctionTaskIds.length
		|| result.correctionTaskIds.some((id) => !taskIds.has(id))) {
		fail("invalid_verification_result", "Correction task IDs must identify unique plan tasks", {
			path: "result.correctionTaskIds",
		});
	}
	if (!result.passed
		&& (result.missingEvidence.length === 0 || result.correctionTaskIds.length === 0)) {
		fail("invalid_verification_result", "Failed verification requires missing evidence", {
			path: "result.missingEvidence",
		});
	}

	const timestamp = nowIso(options.at);
	const candidate = clone(plan);
	candidate.verification = {
		status: result.passed ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
		reservationId: candidate.verification.reservationId,
		runId: options.runId,
		inputDigest: candidate.verification.inputDigest,
		summary: result.summary,
		...(result.conceptualReview ? { conceptualReview: clone(result.conceptualReview) } : {}),
		evidence: clone(result.evidence),
		missingEvidence: clone(result.missingEvidence),
		correctionTaskIds: clone(result.correctionTaskIds),
		replacement: candidate.verification.replacement,
		reservedAt: candidate.verification.reservedAt,
		completedAt: timestamp,
	};
	candidate.status = result.passed
		? PLAN_STATUS.AWAITING_COMPLETION_APPROVAL
		: PLAN_STATUS.FAILED;
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

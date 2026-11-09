import { isList, isOneOf } from "../data.mjs";
import { fail, isPlainObject } from "./fields.mjs";
import { COMMIT_PATTERN, DELIVERY_REQUIREMENT, DELIVERY_REQUIREMENT_VALUES, EVIDENCE_OUTCOME, EVIDENCE_TYPE } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryTask} FoundryTask */

/**
 * Validates and returns a task's minimum delivery requirement.
 *
 * @param {{deliveryRequirement?: unknown}} task
 * @param {string} [fieldPath]
 * @returns {"branch"|"commit"|"pr"}
 */
export function effectiveDeliveryRequirement(task, fieldPath = "deliveryRequirement") {
	const requirement = task.deliveryRequirement;
	if (!isOneOf(requirement, DELIVERY_REQUIREMENT_VALUES)) {
		fail(
			"invalid_delivery_requirement",
			`${fieldPath} must be branch, commit, or pr`,
			{ path: fieldPath, details: { value: requirement } },
		);
	}
	return requirement;
}

/**
 * Reports missing completion requirements for an effective attempt.
 * Field shape and provenance validation remain separate from these requirements.
 *
 * @param {Pick<FoundryTask, "deliveryRequirement">} task
 * @param {{sessionId?: unknown, branch?: unknown, commit?: unknown, prUrl?: unknown,
 * resultSummary?: unknown, evidence?: unknown, integrationRequired: unknown[]}} attempt
 * @returns {{requirement: "branch"|"commit"|"pr", missing: string[], missingDelivery: string[]}}
 */
export function taskCompletionRequirements(task, attempt) {
	const requirement = effectiveDeliveryRequirement(task);
	const missing = [];
	const missingDelivery = [];
	if (typeof attempt.sessionId !== "string" || !attempt.sessionId.trim()) {
		missing.push("attached session");
	}
	if (typeof attempt.resultSummary !== "string" || !attempt.resultSummary.trim()) {
		missing.push("resultSummary");
	}
	if (!Array.isArray(attempt.evidence) || attempt.evidence.length === 0) {
		missing.push("evidence");
	}
	if (typeof attempt.branch !== "string" || !attempt.branch.trim()) {
		missing.push("branch");
	}
	if (requirement !== DELIVERY_REQUIREMENT.BRANCH
		&& (typeof attempt.commit !== "string"
			|| !COMMIT_PATTERN.test(attempt.commit))) {
		missingDelivery.push("full commit");
	}
	if (requirement === DELIVERY_REQUIREMENT.PR
		&& (typeof attempt.prUrl !== "string" || !attempt.prUrl.trim())) {
		missingDelivery.push("prUrl");
	}
	if (attempt.integrationRequired.length > 0
		&& (!isList(attempt.evidence)
			|| !attempt.evidence.some((entry) => (
				isPlainObject(entry) && entry.type === EVIDENCE_TYPE.INTEGRATION
				&& entry.outcome === EVIDENCE_OUTCOME.PASSED
			)))) {
		missing.push("passed integration evidence");
	}
	return { requirement, missing, missingDelivery };
}

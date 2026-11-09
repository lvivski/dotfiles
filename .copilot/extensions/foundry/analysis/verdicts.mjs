import { isList, isRecord } from "../data.mjs";
import { requiresHumanJudgment } from "../factory/definitions.mjs";
import { EVIDENCE_OUTCOME, LIMITS } from "../plan/values.mjs";
import { stableStringify } from "../digest.mjs";
import { plainObject, text } from "./fields.mjs";
import { fail } from "../errors.mjs";
import { criterionId, normalizeVerificationInput } from "./verification.mjs";

/** @typedef {import("../types/analysis.js").VerificationInput} VerificationInput */
/** @typedef {import("../types/analysis.js").VerificationOutcome} VerificationOutcome */

/** Bounded non-governing proposals, separate from acceptance and pass/fail. @param {unknown} reviews */
export function extractSimplificationProposals(reviews) {
	const risks = isList(reviews) ? reviews.flatMap((review) => isRecord(review) && isList(review.risks) ? review.risks : []) : [];
	const proposed = [...new Set(risks.filter(/** @returns {risk is string} */(risk) => typeof risk === "string" && risk.startsWith("Simplification proposal:")))];
	if (!proposed.length) return null;
	const bounded = proposed.filter((proposal) => proposal.length <= 2000);
	const gaps = [];
	if (bounded.length !== proposed.length) gaps.push("An oversized conceptual proposal was not imported; capture its bounded conserved meaning, evaluations and tradeoffs explicitly.");
	if (bounded.length > 3) gaps.push("More than three conceptual proposals were suggested; additional scope needs its own review.");
	return { proposals: bounded.slice(0, 3), gaps };
}

/**
 * Computes the deterministic verification gaps shared by the Workflow and importer.
 *
 * @param {VerificationInput} input Canonical normalized verification input.
 * @returns {{
 *   hardPassed: boolean,
 *   hardGaps: Array<{summary: string, taskIds: string[]}>,
 *   correctionTaskIds: string[],
 *   requiredEvidenceIds: string[]
 * }}
 */
export function assessDeterministicVerification(input) {
	const criterionOwners = new Map(input.evaluationTarget
		? input.evaluationTarget.criteria.map((_entry, index) => [criterionId(input.verificationReport.taskId, index), input.verificationReport.taskId])
		: input.tasks.flatMap((task) => task.criteria.map((criterion) => [criterion.id, task.id])));
	const reportByCheck = new Map(
		input.verificationReport.evidence.map((entry) => [entry.checkId, entry]),
	);
	const correctionTaskIds = new Set();
	const hardGaps = [];
	for (const [criterionId, ownerTaskId] of criterionOwners) {
		if (reportByCheck.get(criterionId)?.outcome !== EVIDENCE_OUTCOME.PASSED) {
			correctionTaskIds.add(ownerTaskId);
			hardGaps.push({
				summary: `Independent check failed for ${criterionId}`,
				taskIds: [ownerTaskId],
			});
		}
	}
	const targetTaskId = input.verificationReport.target.taskId ?? input.verificationReport.taskId;
	const definitions = input.factory?.context?.definitions?.evaluations ?? [];
	const human = definitions.filter((entry) => requiresHumanJudgment(entry.evaluation));
	const humanFailed = human.some((entry) => {
		const evidence = input.factory?.context?.humanEvidence.find((report) => report.evaluation.id === entry.id && report.evaluation.revision === entry.revision);
		return !evidence || evidence.outcome !== "passed" || evidence.environment !== entry.evaluation.environment
			|| evidence.workload !== entry.evaluation.workload || (entry.evaluation.independent && evidence.trust !== "independent-claim");
	});
	if (input.factory?.binding?.candidateId && (input.factory.evaluations.some((entry) => entry.outcome !== "passed") || humanFailed)) {
		correctionTaskIds.add(targetTaskId);
		hardGaps.push({ summary: "Pinned factory evaluation evidence is missing, failed or inconclusive", taskIds: [targetTaskId] });
	}
	if (input.verificationReport.observedCommit
		!== input.verificationReport.target.commit) {
		correctionTaskIds.add(targetTaskId);
		hardGaps.push({
			summary: "Verifier observed a different target commit",
			taskIds: [targetTaskId],
		});
	}
	for (const checkId of ["final-integration", "workspace-integrity"]) {
		if (reportByCheck.get(checkId)?.outcome !== EVIDENCE_OUTCOME.PASSED) {
			correctionTaskIds.add(targetTaskId);
			hardGaps.push({
				summary: `Independent check failed for ${checkId}`,
				taskIds: [targetTaskId],
			});
		}
	}
	return {
		hardPassed: hardGaps.length === 0,
		hardGaps,
		correctionTaskIds: [...correctionTaskIds],
		requiredEvidenceIds: input.verificationReport.evidence
			.filter((entry) => entry.outcome === EVIDENCE_OUTCOME.PASSED)
			.map((entry) => entry.id),
	};
}

/**
 * Validates a persisted verification result against canonical checks.
 *
 * @param {unknown} value
 * @param {unknown} expectedInput
 * @param {string} expectedReservationId
 * @returns {VerificationOutcome}
 */
export function validateVerificationResult(value, expectedInput, expectedReservationId) {
	const input = normalizeVerificationInput(expectedInput);
	const result = plainObject(value, "result");
	if (result.kind !== "foundry-verification-result") {
		fail("invalid_analysis_result", "Verification result kind is not supported");
	}
	if (result.inputDigest !== input.inputDigest
		|| result.planId !== input.planId
		|| result.reservationId !== expectedReservationId) {
		fail("analysis_input_mismatch", "Verification result does not match its run");
	}
	const returnedInput = normalizeVerificationInput(result.input);
	if (stableStringify(returnedInput) !== stableStringify(input)) {
		fail("analysis_input_mismatch", "Verification result changed the canonical Workflow input");
	}
	const evaluated = evaluateVerification(input, result);
	const missingReviewer = isList(result.reviews) ? result.reviews.findIndex((review) => review === null) : -1;
	if (missingReviewer !== -1) {
		fail("invalid_analysis_result", `Verification reviewer ${missingReviewer + 1} is invalid`);
	}
	if (evaluated.invalidEvidence) {
		fail("invalid_analysis_result", "Verification result references unknown evidence");
	}
	if (result.passed === true && evaluated.missingRequiredEvidence) {
		fail("invalid_analysis_result", "Passing verification omits verifier evidence");
	}
	if (result.passed === true && !evaluated.outcome.passed) {
		fail("invalid_analysis_result", "Passing verification contradicts canonical checks");
	}
	return evaluated.outcome;
}

/**
 * Evaluates review and verdict claims without trusting a proposed passing flag.
 * The Workflow selects valid proposed evidence; import rejects invalid persisted
 * references, missing reviewers, and contradicted passes instead of repairing them.
 *
 * @param {VerificationInput} input Canonical normalized input.
 * @param {unknown} value Review results and proposed verdict fields.
 * @returns {{
 *   outcome: VerificationOutcome,
 *   gaps: Array<{summary: string, taskIds: string[]}>,
 *   missingRequiredEvidence: boolean,
 *   invalidEvidence: boolean
 * }}
 */
export function evaluateVerification(input, value) {
	const result = plainObject(value, "result");
	const taskIds = input.evaluationTarget ? [input.verificationReport.taskId] : input.tasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const deterministic = assessDeterministicVerification(input);
	const correctionTaskIds = new Set(deterministic.correctionTaskIds);
	/** @type {Map<string, Set<string>>} */
	const gapsBySummary = new Map();

	const allEvidence = new Map([
		...input.tasks.flatMap(
			(task) => task.evidence.map((entry) => /** @type {const} */([entry.id, entry])),
		),
		...input.verificationReport.evidence.map((entry) => /** @type {const} */([entry.id, entry])),
	]);
	let unattributed = false;
	/** Merge repeated findings without losing attribution from either source. @param {unknown} entry @param {string} field */
	const consumeAttribution = (entry, field) => {
		if (!isRecord(entry) || typeof entry.summary !== "string" || !entry.summary.trim()) {
			fail("invalid_analysis_result", `${field} is invalid`);
		}
		let owners = gapsBySummary.get(entry.summary);
		if (!owners) {
			owners = new Set();
			gapsBySummary.set(entry.summary, owners);
		}
		if (!isList(entry.taskIds)
			|| entry.taskIds.length === 0
			|| !entry.taskIds.every((id) => typeof id === "string")
			|| entry.taskIds.some((id) => !taskIdSet.has(id))) {
			unattributed = true;
		} else {
			for (const id of entry.taskIds) {
				correctionTaskIds.add(id);
				owners.add(id);
			}
		}
	};
	deterministic.hardGaps.forEach((entry) => consumeAttribution(entry, "deterministic gap"));
	if (!isList(result.reviews) || result.reviews.length !== 2) {
		fail("invalid_analysis_result", "Verification result requires two reviewers");
	}
	result.reviews.forEach((review, reviewIndex) => {
		if (review === null) {
			consumeAttribution({
				summary: reviewIndex === 0
					? "Coverage reviewer returned no result"
					: "Integration skeptic returned no result",
				taskIds: [],
			}, `result.reviews[${reviewIndex}]`);
			return;
		}
		if (!isRecord(review)
			|| !isList(review.missingEvidence)
			|| !isList(review.integrationFindings)) {
			fail("invalid_analysis_result", `Verification reviewer ${reviewIndex + 1} is invalid`);
		}
		review.missingEvidence.forEach((entry, index) => (
			consumeAttribution(
				entry,
				`result.reviews[${reviewIndex}].missingEvidence[${index}]`,
			)
		));
		review.integrationFindings.forEach((entry, index) => {
			if (!isRecord(entry) || !isList(entry.evidenceIds)
				|| entry.evidenceIds.some((id) => typeof id !== "string" || !allEvidence.has(id))) {
				unattributed = true;
			}
			consumeAttribution(
				entry,
				`result.reviews[${reviewIndex}].integrationFindings[${index}]`,
			);
		});
	});
	if (!isList(result.missingEvidence)
		|| result.missingEvidence.length > LIMITS.missingEvidence) {
		fail("invalid_analysis_result", "Verification result missingEvidence is invalid");
	}
	result.missingEvidence.forEach((entry, index) => (
		consumeAttribution(entry, `result.missingEvidence[${index}]`)
	));
	if (!isList(result.correctionTaskIds)) {
		fail("invalid_analysis_result", "Verification result correctionTaskIds is invalid");
	}
	for (const taskId of result.correctionTaskIds) {
		if (typeof taskId === "string" && taskIdSet.has(taskId)) correctionTaskIds.add(taskId);
		else unattributed = true;
	}

	if (!isList(result.evidenceIds)) {
		fail("invalid_analysis_result", "Verification result references unknown evidence");
	}
	const passingIds = result.evidenceIds.filter(
		/** @returns {id is string} */
		(id) => typeof id === "string" && allEvidence.get(id)?.outcome === EVIDENCE_OUTCOME.PASSED,
	);
	const invalidEvidence = result.evidenceIds.length > LIMITS.verificationEvidence
		|| passingIds.length !== result.evidenceIds.length;
	const evidence = [...new Set(passingIds.slice(0, LIMITS.verificationEvidence))];
	const missingRequiredEvidence =
		deterministic.requiredEvidenceIds.some((id) => !evidence.includes(id));
	const passed = result.passed === true
		&& deterministic.hardPassed
		&& !missingRequiredEvidence
		&& gapsBySummary.size === 0
		&& evidence.length > 0;
	if (!passed && (unattributed || correctionTaskIds.size === 0)) {
		taskIds.forEach((taskId) => correctionTaskIds.add(taskId));
	}
	if (!passed && gapsBySummary.size === 0) {
		gapsBySummary.set(
			"Verification failed without an attributed evidence gap",
			new Set(correctionTaskIds),
		);
	}
	const gaps = [...gapsBySummary]
		.slice(0, LIMITS.missingEvidence)
		.map(([summary, owners]) => ({ summary, taskIds: [...owners].sort() }));
	const conceptualReview = extractSimplificationProposals(result.reviews);
	return {
		outcome: {
			passed,
			summary: text(result.summary, "result.summary", LIMITS.resultSummary),
			evidence,
			missingEvidence: gaps.map((entry) => entry.summary),
			correctionTaskIds: passed ? [] : [...correctionTaskIds].sort(),
			...(conceptualReview ? { conceptualReview } : {}),
		},
		gaps,
		missingRequiredEvidence,
		invalidEvidence,
	};
}

import { isList, isOneOf } from "../data.mjs";
import { assertKnownKeys, assertNullableString, assertPlainObject, assertString, fail } from "./fields.mjs";
import { verificationCheckIds } from "./graph.mjs";
import { ATTEMPT_STATUS, EVIDENCE_ID_PATTERN, EVIDENCE_OUTCOME, EVIDENCE_OUTCOME_VALUES, EVIDENCE_TYPE, EVIDENCE_TYPE_VALUES, LIMITS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").FoundryTask} FoundryTask */
/** @typedef {import("../types/plan.js").FoundryAttempt} FoundryAttempt */
/** @typedef {import("../types/plan.js").FoundryEvidence} FoundryEvidence */

const EVIDENCE_KEYS = new Set([
	"id",
	"type",
	"summary",
	"source",
	"outcome",
	"producer",
	"checkId",
	"trust",
]);

const EVIDENCE_INPUT_KEYS = new Set([
	"type",
	"summary",
	"source",
	"outcome",
	"checkId",
]);

/**
 * Derives the canonical evidence ID for an attempt-local index.
 *
 * @param {string} attemptId
 * @param {number} index
 * @returns {string}
 */
function expectedEvidenceId(attemptId, index) {
	return `${attemptId}-E${String(index + 1).padStart(3, "0")}`;
}

/**
 * Validates canonical evidence identity and attempt-bound provenance.
 *
 * @param {unknown} entry
 * @param {Pick<FoundryTask, "kind">} task
 * @param {Pick<FoundryAttempt, "id" | "sessionId">} attempt
 * @param {number} index
 * @param {string} fieldPath
 * @returns {asserts entry is FoundryEvidence}
 */
export function validateEvidence(entry, task, attempt, index, fieldPath) {
	assertPlainObject(entry, fieldPath);
	assertKnownKeys(entry, EVIDENCE_KEYS, fieldPath);
	const expectedId = expectedEvidenceId(attempt.id, index);
	if (entry.id !== expectedId || !EVIDENCE_ID_PATTERN.test(entry.id)) {
		fail("invalid_evidence_id", `${fieldPath}.id must be ${expectedId}`, {
			path: `${fieldPath}.id`,
		});
	}
	validateEvidenceFields(entry, fieldPath);
	assertString(entry.producer, `${fieldPath}.producer`, LIMITS.producer);
	if (entry.producer !== (attempt.sessionId ?? "coordinator")) {
		fail("invalid_evidence_producer", `${fieldPath}.producer does not match its attempt`, {
			path: `${fieldPath}.producer`,
		});
	}
	const expectedTrust = task.kind === "verify" ? "independent-claim" : "claimed";
	if (entry.trust !== expectedTrust) {
		fail("invalid_evidence_trust", `${fieldPath}.trust must be ${expectedTrust}`, {
			path: `${fieldPath}.trust`,
		});
	}
	if (task.kind === "verify") {
		assertString(entry.checkId, `${fieldPath}.checkId`, 32);
	} else if (entry.checkId !== null) {
		fail("invalid_evidence_check", `${fieldPath}.checkId must be null`, {
			path: `${fieldPath}.checkId`,
		});
	}
}

/** @param {Record<string, unknown>} entry @param {string} fieldPath @returns {asserts entry is Record<string, unknown> & import("../types/plan.js").EvidenceFields} */
function validateEvidenceFields(entry, fieldPath) {
	if (!isOneOf(entry.type, EVIDENCE_TYPE_VALUES)) {
		fail("invalid_evidence_type", `${fieldPath}.type is not supported`, {
			path: `${fieldPath}.type`,
		});
	}
	assertString(entry.summary, `${fieldPath}.summary`, LIMITS.evidenceItem);
	assertNullableString(entry.source, `${fieldPath}.source`, LIMITS.evidenceSource);
	if (!isOneOf(entry.outcome, EVIDENCE_OUTCOME_VALUES)) {
		fail("invalid_evidence_outcome", `${fieldPath}.outcome is not supported`, {
			path: `${fieldPath}.outcome`,
		});
	}
	if (isOneOf(entry.type, [EVIDENCE_TYPE.COMMAND, EVIDENCE_TYPE.TEST, EVIDENCE_TYPE.INTEGRATION])
		&& entry.outcome === EVIDENCE_OUTCOME.INFORMATIONAL) {
		fail("invalid_evidence_outcome", `${fieldPath}.outcome must record pass or failure`, {
			path: `${fieldPath}.outcome`,
		});
	}
}

/**
 * Assigns canonical IDs, check identities, and task-kind provenance.
 *
 * @param {unknown} value
 * @param {FoundryPlan} plan
 * @param {FoundryTask} task
 * @param {FoundryAttempt} attempt
 * @param {string} status
 * @param {string} [fieldPath]
 * @returns {FoundryEvidence[]}
 */
export function normalizeEvidence(value, plan, task, attempt, status, fieldPath = "evidence") {
	if (!isList(value) || value.length > LIMITS.evidence) {
		fail("invalid_evidence", `${fieldPath} must contain at most ${LIMITS.evidence} entries`, {
			path: fieldPath,
		});
	}
	const producer = attempt.sessionId ?? "coordinator";
	const parsed = value.map((entry, index) => {
		const entryPath = `${fieldPath}[${index}]`;
		assertPlainObject(entry, entryPath);
		assertKnownKeys(entry, EVIDENCE_INPUT_KEYS, entryPath);
		const source = entry.source ?? null;
		const outcome = entry.outcome ?? EVIDENCE_OUTCOME.INFORMATIONAL;
		const fields = { ...entry, source, outcome };
		validateEvidenceFields(fields, entryPath);
		/** @type {"claimed"|"independent-claim"} */
		const trust = task.kind === "verify" ? "independent-claim" : "claimed";
		return {
			type: fields.type,
			summary: fields.summary,
			source: fields.source,
			outcome: fields.outcome,
			producer,
			checkId: entry.checkId ?? null,
			trust,
		};
	});
	if (task.kind !== "verify") {
		if (parsed.some((entry) => entry.checkId !== null)) {
			fail("invalid_evidence_check", "Implementation evidence cannot set checkId", {
				path: fieldPath,
			});
		}
		return parsed.map((entry, index) => ({
			id: expectedEvidenceId(attempt.id, index),
			...entry,
			checkId: null,
		}));
	}
	const expectedChecks = verificationCheckIds(plan.tasks, plan.evaluationTarget);
	/** @type {Map<string, Omit<FoundryEvidence, "id">>} */
	const byCheck = new Map();
	for (const entry of parsed) {
		if (typeof entry.checkId !== "string"
			|| !expectedChecks.includes(entry.checkId)
			|| byCheck.has(entry.checkId)) {
			fail("invalid_evidence_check", "Verifier evidence has an unknown or duplicate checkId", {
				path: fieldPath,
				details: { checkId: entry.checkId },
			});
		}
		byCheck.set(entry.checkId, { ...entry, checkId: entry.checkId });
	}
	if (status === ATTEMPT_STATUS.DONE && byCheck.size !== expectedChecks.length) {
		fail("invalid_evidence_check", "Verifier evidence must cover every canonical check", {
			path: fieldPath,
			details: {
				missingCheckIds: expectedChecks.filter((checkId) => !byCheck.has(checkId)),
			},
		});
	}
	return expectedChecks
		.filter((checkId) => byCheck.has(checkId))
		.map((checkId, index) => {
			const entry = byCheck.get(checkId);
			if (!entry) fail("invalid_evidence_check", "Verifier evidence disappeared during canonicalization");
			return { id: expectedEvidenceId(attempt.id, index), ...entry };
		});
}

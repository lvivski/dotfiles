import { isOneOf } from "../../data.mjs";
import { assertKnownKeys, assertNullableString, assertPlainObject, assertRequestId, assertString, assertStringArray, assertTimestamp, fail, validateConceptualReview } from "../fields.mjs";
import { LIMITS, VERIFICATION_STATUS, VERIFICATION_STATUS_VALUES } from "../values.mjs";

const VERIFICATION_KEYS = new Set([
	"status",
	"reservationId",
	"runId",
	"inputDigest",
	"summary",
	"evidence",
	"missingEvidence",
	"correctionTaskIds",
	"replacement",
	"reservedAt",
	"completedAt",
	"conceptualReview",
]);

const VERIFICATION_REPLACEMENT_KEYS = new Set([
	"supersededReservationId",
	"supersededRunId",
	"reason",
	"requestedBy",
	"at",
]);

/**
 * Validates verification reservation, run binding, and terminal result fields.
 *
 * @param {unknown} verification
 * @returns {asserts verification is import("../../types/plan.js").Verification}
 */
export function validateVerification(verification) {
	assertPlainObject(verification, "verification");
	assertKnownKeys(verification, VERIFICATION_KEYS, "verification");
	validateConceptualReview(verification.conceptualReview);
	if (!isOneOf(verification.status, VERIFICATION_STATUS_VALUES)) {
		fail("invalid_verification_status", "verification.status is not supported", {
			path: "verification.status",
			details: { value: verification.status },
		});
	}
	assertNullableString(verification.reservationId, "verification.reservationId");
	if (verification.reservationId !== null) {
		assertRequestId(verification.reservationId, "verification.reservationId");
	}
	assertNullableString(verification.runId, "verification.runId");
	assertNullableString(verification.inputDigest, "verification.inputDigest");
	assertNullableString(verification.summary, "verification.summary");
	assertStringArray(verification.evidence, "verification.evidence");
	assertStringArray(verification.missingEvidence, "verification.missingEvidence");
	assertStringArray(verification.correctionTaskIds, "verification.correctionTaskIds");
	if (verification.replacement !== null) {
		assertPlainObject(verification.replacement, "verification.replacement");
		assertKnownKeys(
			verification.replacement,
			VERIFICATION_REPLACEMENT_KEYS,
			"verification.replacement",
		);
		assertRequestId(
			verification.replacement.supersededReservationId,
			"verification.replacement.supersededReservationId",
		);
		assertNullableString(verification.replacement.supersededRunId, "verification.replacement.supersededRunId");
		assertString(verification.replacement.reason, "verification.replacement.reason");
		assertString(verification.replacement.requestedBy, "verification.replacement.requestedBy");
		assertTimestamp(verification.replacement.at, "verification.replacement.at");
	}
	assertTimestamp(verification.reservedAt, "verification.reservedAt", { nullable: true });
	assertTimestamp(verification.completedAt, "verification.completedAt", { nullable: true });
	if (verification.reservedAt !== null
		&& verification.completedAt !== null
		&& Date.parse(verification.completedAt) < Date.parse(verification.reservedAt)) {
		fail("invalid_verification_timestamps", "verification.completedAt precedes reservedAt", {
			path: "verification.completedAt",
		});
	}

	if (verification.status === VERIFICATION_STATUS.NOT_STARTED) {
		if (verification.reservationId !== null
			|| verification.runId !== null
			|| verification.inputDigest !== null
			|| verification.summary !== null
			|| verification.evidence.length > 0
			|| verification.missingEvidence.length > 0
			|| verification.correctionTaskIds.length > 0
			|| verification.replacement !== null
			|| verification.reservedAt !== null
			|| verification.completedAt !== null) {
			fail("invalid_verification_state", "Unstarted verification cannot contain run data", {
				path: "verification",
			});
		}
	} else if (verification.status === VERIFICATION_STATUS.RESERVED) {
		if (verification.reservationId === null
			|| !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
			|| verification.reservedAt === null
			|| verification.summary !== null
			|| verification.evidence.length > 0
			|| verification.missingEvidence.length > 0
			|| verification.correctionTaskIds.length > 0
			|| verification.completedAt !== null) {
			fail("invalid_verification_state", "Reserved verification contains invalid run data", {
				path: "verification",
			});
		}
	} else if (verification.status === VERIFICATION_STATUS.PASSED) {
		if (verification.reservationId === null
			|| verification.runId === null
			|| !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
			|| verification.reservedAt === null
			|| verification.completedAt === null
			|| verification.summary === null
			|| verification.evidence.length === 0
			|| verification.missingEvidence.length > 0) {
			fail(
				"invalid_verification_state",
				"Passed verification requires timestamps, summary, evidence, and no missing evidence",
				{ path: "verification" },
			);
		}
		if (verification.correctionTaskIds.length > 0) {
			fail("invalid_verification_state", "Passed verification cannot request corrections", {
				path: "verification.correctionTaskIds",
			});
		}
	} else if (verification.status === VERIFICATION_STATUS.FAILED) {
		if (verification.reservationId === null
			|| verification.runId === null
			|| !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
			|| verification.reservedAt === null
			|| verification.completedAt === null
			|| verification.summary === null
			|| verification.missingEvidence.length === 0
			|| verification.correctionTaskIds.length === 0) {
			fail(
				"invalid_verification_state",
				"Failed verification requires timestamps, summary, and missing evidence",
				{ path: "verification" },
			);
		}
	}
}

/**
 * Creates the canonical unstarted verification state.
 *
 * @returns {import("../../types/plan.js").Verification}
 */
export function emptyVerification() {
	return {
		status: VERIFICATION_STATUS.NOT_STARTED,
		reservationId: null,
		runId: null,
		inputDigest: null,
		summary: null,
		evidence: [],
		missingEvidence: [],
		correctionTaskIds: [],
		replacement: null,
		reservedAt: null,
		completedAt: null,
	};
}

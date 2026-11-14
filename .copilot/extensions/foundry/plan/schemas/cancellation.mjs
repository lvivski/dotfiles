import { isList, isOneOf } from "../../data.mjs";
import { normalizeRecoveryObservation } from "../../inventory.mjs";
import { assertKnownKeys, assertNullableString, assertPlainObject, assertRequestId, assertString, assertStringArray, assertTimestamp, fail } from "../fields.mjs";
import { ATTEMPT_STATUS, LIMITS, PLAN_STATUS } from "../values.mjs";

/** @typedef {import("../../types/plan.js").FoundryTask} FoundryTask */
/** @typedef {import("../../types/plan.js").FoundryAttempt} FoundryAttempt */

const CANCELLATION_KEYS = new Set([
	"requestId",
	"reason",
	"requestedBy",
	"requestedAt",
	"requiredAttemptIds",
	"verificationReservationId",
	"verificationRunId",
	"acknowledgements",
	"verificationDisposition",
	"finalizationOverride",
	"verificationTerminatedAt",
	"finalizedBy",
	"finalizedAt",
	"parallelObservations",
]);

const CANCELLATION_ACK_KEYS = new Set([
	"attemptId",
	"disposition",
	"sessionId",
	"acknowledgedBy",
	"acknowledgedAt",
]);

const CANCELLATION_OVERRIDE_KEYS = new Set(["reason", "attestedBy"]);

/**
 * Validates cancellation snapshots, acknowledgements, and final disposition.
 *
 * @param {unknown} cancellation
 * @param {string} planStatus
 * @param {FoundryTask[]} tasks
 * @returns {asserts cancellation is import("../../types/plan.js").Cancellation | null}
 */
export function validateCancellation(cancellation, planStatus, tasks) {
	if (cancellation === null) {
		if (planStatus === PLAN_STATUS.CANCELLING || planStatus === PLAN_STATUS.CANCELLED) {
			fail("missing_cancellation", `Plan status ${planStatus} requires cancellation metadata`, {
				path: "cancellation",
			});
		}
		return;
	}
	assertPlainObject(cancellation, "cancellation");
	assertKnownKeys(cancellation, CANCELLATION_KEYS, "cancellation");
	assertRequestId(cancellation.requestId, "cancellation.requestId");
	assertString(cancellation.reason, "cancellation.reason");
	assertString(cancellation.requestedBy, "cancellation.requestedBy");
	assertTimestamp(cancellation.requestedAt, "cancellation.requestedAt");
	assertStringArray(cancellation.requiredAttemptIds, "cancellation.requiredAttemptIds");
	/** @type {Map<string, FoundryAttempt>} */
	const attemptsById = new Map(tasks.flatMap(
		(task) => task.attempts.map((attempt) => [attempt.id, attempt]),
	));
	const knownAttemptIds = new Set(attemptsById.keys());
	if (cancellation.parallelObservations !== undefined) {
		if (!isList(cancellation.parallelObservations) || !cancellation.parallelObservations.length) {
			fail("invalid_cancellation_observations", "Retained parallel observations must contain complete positive captures");
		}
		for (const value of cancellation.parallelObservations) {
			const observation = normalizeRecoveryObservation(value);
			const task = tasks.find(entry => entry.id === observation.attempt.taskId);
			const attempt = task?.attempts.find(entry => entry.id === observation.attempt.attemptId);
			if (!attempt || attempt.reservationId !== observation.attempt.reservationId) {
				fail("invalid_cancellation_observations", "Retained parallel observation belongs to an unknown native attempt");
			}
		}
	}
	if (new Set(cancellation.requiredAttemptIds).size !== cancellation.requiredAttemptIds.length
		|| cancellation.requiredAttemptIds.some((id) => !knownAttemptIds.has(id))) {
		fail("invalid_cancellation_attempts", "Cancellation attempt snapshot is invalid", {
			path: "cancellation.requiredAttemptIds",
		});
	}
	assertNullableString(cancellation.verificationReservationId, "cancellation.verificationReservationId");
	if (cancellation.verificationReservationId !== null) {
		assertRequestId(
			cancellation.verificationReservationId,
			"cancellation.verificationReservationId",
		);
	}
	assertNullableString(cancellation.verificationRunId, "cancellation.verificationRunId");
	if (cancellation.finalizationOverride !== null) {
		assertPlainObject(cancellation.finalizationOverride, "cancellation.finalizationOverride");
		assertKnownKeys(
			cancellation.finalizationOverride,
			CANCELLATION_OVERRIDE_KEYS,
			"cancellation.finalizationOverride",
		);
		assertString(cancellation.finalizationOverride.reason, "cancellation.finalizationOverride.reason");
		assertString(cancellation.finalizationOverride.attestedBy, "cancellation.finalizationOverride.attestedBy");
	}
	if (!isList(cancellation.acknowledgements)
		|| cancellation.acknowledgements.length > LIMITS.tasks + 1) {
		fail("invalid_cancellation_acknowledgements", "Cancellation acknowledgements are invalid", {
			path: "cancellation.acknowledgements",
		});
	}
	const requiredAttemptIds = cancellation.requiredAttemptIds;
	const acknowledgements = cancellation.acknowledgements.map((entry, index) => {
		const fieldPath = `cancellation.acknowledgements[${index}]`;
		assertPlainObject(entry, fieldPath);
		assertKnownKeys(entry, CANCELLATION_ACK_KEYS, fieldPath);
		if (typeof entry.attemptId !== "string" || !requiredAttemptIds.includes(entry.attemptId)) {
			fail("invalid_cancellation_acknowledgement", `${fieldPath}.attemptId was not snapshotted`, {
				path: `${fieldPath}.attemptId`,
			});
		}
		if (!isOneOf(entry.disposition, ["session-terminated", "no-session-created"])) {
			fail("invalid_cancellation_acknowledgement", `${fieldPath}.disposition is invalid`, {
				path: `${fieldPath}.disposition`,
			});
		}
		if (entry.disposition === "session-terminated") {
			assertString(entry.sessionId, `${fieldPath}.sessionId`);
		} else if (entry.sessionId !== null) {
			fail("invalid_cancellation_acknowledgement", `${fieldPath}.sessionId must be null`, {
				path: `${fieldPath}.sessionId`,
			});
		}
		assertString(entry.acknowledgedBy, `${fieldPath}.acknowledgedBy`);
		assertTimestamp(entry.acknowledgedAt, `${fieldPath}.acknowledgedAt`);
		return {
			attemptId: entry.attemptId, disposition: entry.disposition, sessionId: entry.sessionId,
			acknowledgedBy: entry.acknowledgedBy, acknowledgedAt: entry.acknowledgedAt
		};
	});
	if (new Set(acknowledgements.map((entry) => entry.attemptId)).size
		!== acknowledgements.length) {
		fail("duplicate_cancellation_acknowledgement", "An attempt can be acknowledged only once", {
			path: "cancellation.acknowledgements",
		});
	}
	for (const entry of acknowledgements) {
		const attempt = attemptsById.get(entry.attemptId);
		if (!attempt) {
			fail("invalid_cancellation_acknowledgement", `${entry.attemptId} is unknown`, {
				path: "cancellation.acknowledgements",
			});
		}
		if (entry.disposition === "session-terminated"
			&& entry.sessionId !== attempt.sessionId) {
			fail("invalid_cancellation_acknowledgement", `${entry.attemptId} session does not match`, {
				path: "cancellation.acknowledgements",
			});
		}
		if (entry.disposition === "no-session-created" && attempt.sessionId !== null) {
			fail("invalid_cancellation_acknowledgement", `${entry.attemptId} has an attached session`, {
				path: "cancellation.acknowledgements",
			});
		}
		if (Date.parse(entry.acknowledgedAt) < Date.parse(cancellation.requestedAt)) {
			fail("invalid_cancellation_acknowledgement", `${entry.attemptId} was acknowledged before cancellation`, {
				path: "cancellation.acknowledgements",
			});
		}
	}
	assertTimestamp(
		cancellation.verificationTerminatedAt,
		"cancellation.verificationTerminatedAt",
		{ nullable: true },
	);
	if (cancellation.verificationDisposition !== null
		&& !isOneOf(cancellation.verificationDisposition, ["run-terminated", "no-run-created"])) {
		fail("invalid_cancellation_verification", "Verification disposition is invalid", {
			path: "cancellation.verificationDisposition",
		});
	}
	assertNullableString(cancellation.finalizedBy, "cancellation.finalizedBy");
	assertTimestamp(cancellation.finalizedAt, "cancellation.finalizedAt", { nullable: true });
	if (cancellation.verificationRunId === null
		&& cancellation.verificationTerminatedAt !== null) {
		fail(
			"invalid_cancellation_verification",
			"Verification termination time must match a snapshotted run",
			{ path: "cancellation.verificationTerminatedAt" },
		);
	}
	if (cancellation.verificationRunId !== null
		&& cancellation.verificationReservationId === null) {
		fail("invalid_cancellation_verification", "Verification run lacks its reservation", {
			path: "cancellation.verificationReservationId",
		});
	}
	if (cancellation.verificationReservationId === null
		&& cancellation.verificationDisposition !== null) {
		fail("invalid_cancellation_verification", "Verification disposition lacks a reservation", {
			path: "cancellation.verificationDisposition",
		});
	}
	if ((cancellation.finalizedAt === null) !== (cancellation.finalizedBy === null)) {
		fail("invalid_cancellation_finalization", "Cancellation finalization actor and time must match", {
			path: "cancellation.finalizedAt",
		});
	}
	if (planStatus === PLAN_STATUS.CANCELLING) {
		if (cancellation.finalizedAt !== null) {
			fail("invalid_cancellation_finalization", "Cancelling plan cannot be finalized", {
				path: "cancellation.finalizedAt",
			});
		}
		if (cancellation.verificationDisposition !== null
			|| cancellation.finalizationOverride !== null
			|| cancellation.verificationTerminatedAt !== null) {
			fail("invalid_cancellation_verification", "Cancelling plan cannot contain a final verification disposition", {
				path: "cancellation.verificationDisposition",
			});
		}
		if (cancellation.requiredAttemptIds.some(
			(id) => attemptsById.get(id)?.status !== ATTEMPT_STATUS.CANCEL_REQUESTED,
		)) {
			fail("invalid_cancellation_attempts", "Snapshotted attempts must await cancellation", {
				path: "cancellation.requiredAttemptIds",
			});
		}
	} else if (planStatus === PLAN_STATUS.CANCELLED) {
		if (cancellation.finalizedAt === null
			|| cancellation.acknowledgements.length !== cancellation.requiredAttemptIds.length
			|| (cancellation.verificationReservationId !== null
				&& cancellation.verificationDisposition === null)
			|| (cancellation.verificationRunId !== null
				&& (cancellation.verificationTerminatedAt === null
					|| cancellation.verificationDisposition !== "run-terminated"))
			|| (cancellation.verificationReservationId !== null
				&& cancellation.verificationRunId === null
				&& cancellation.verificationDisposition !== "no-run-created")) {
			fail("invalid_cancellation_finalization", "Cancelled plan lacks termination acknowledgements", {
				path: "cancellation",
			});
		}
		if (cancellation.requiredAttemptIds.some(
			(id) => attemptsById.get(id)?.status !== ATTEMPT_STATUS.CANCELLED,
		)) {
			fail("invalid_cancellation_attempts", "Finalized attempts must be cancelled", {
				path: "cancellation.requiredAttemptIds",
			});
		}
	} else {
		fail("unexpected_cancellation", `Plan status ${planStatus} cannot carry cancellation metadata`, {
			path: "cancellation",
		});
	}
}

import { isList } from "../data.mjs";
import { stableStringify } from "../digest.mjs";
import { isTerminatedSessionState } from "../inventory.mjs";
import { admissionRecord, cancellationObligation } from "./parallel-contracts.mjs";
import { assertKnownKeys, assertPlainObject, assertRequestId, assertString, clone, fail, nowIso, requireActor } from "./fields.mjs";
import { PLAN_TRANSITIONS } from "./lifecycle.mjs";
import { activeTaskAttempt, findAttempt } from "./queries.mjs";
import { emptyVerification } from "./schemas/verification.mjs";
import { validatePlan } from "./validation.mjs";
import { ATTEMPT_STATUS, LIMITS, PLAN_STATUS, TASK_STATUS, VERIFICATION_STATUS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").ClockValue} ClockValue */

/**
 * Requests cancellation and snapshots active external work without claiming it stopped.
 *
 * @param {FoundryPlan} plan
 * @param {{requestId?: unknown, reason?: unknown, requestedBy?: unknown, verificationRunId?: string | null, at?: ClockValue}} [options]
 * @returns {FoundryPlan}
 */
export function requestPlanCancellation(plan, options = {}) {
	validatePlan(plan);
	if (!PLAN_TRANSITIONS[plan.status]?.has(PLAN_STATUS.CANCELLING)) {
		fail("invalid_plan_transition", `Cannot cancel a plan in ${plan.status}`, {
			path: "status",
		});
	}
	assertRequestId(options.requestId, "requestId");
	assertString(options.reason, "reason");
	requireActor(options.requestedBy, "requestedBy");
	const timestamp = nowIso(options.at);
	const candidate = clone(plan);
	const requiredAttemptIds = [];
	for (const task of candidate.tasks) {
		const attempt = activeTaskAttempt(task);
		if (!attempt) continue;
		requiredAttemptIds.push(attempt.id);
		attempt.status = ATTEMPT_STATUS.CANCEL_REQUESTED;
		attempt.cancelRequestedAt = timestamp;
		attempt.error = options.reason;
	}
	const verificationReserved =
		candidate.verification.status === VERIFICATION_STATUS.RESERVED;
	if (options.verificationRunId != null) {
		assertString(options.verificationRunId, "verificationRunId");
		if (!verificationReserved) {
			fail(
				"invalid_cancellation_verification",
				"A verification run requires an active reservation",
				{ path: "verificationRunId" },
			);
		}
		if (candidate.verification.runId !== null
			&& candidate.verification.runId !== options.verificationRunId) {
			fail("verification_run_mismatch", "Cancellation cannot replace a bound verification run");
		}
	}
	candidate.status = PLAN_STATUS.CANCELLING;
	candidate.cancellation = {
		requestId: options.requestId,
		reason: options.reason,
		requestedBy: options.requestedBy,
		requestedAt: timestamp,
		requiredAttemptIds,
		verificationReservationId: verificationReserved
			? candidate.verification.reservationId
			: null,
		verificationRunId: verificationReserved
			? options.verificationRunId ?? candidate.verification.runId
			: null,
		acknowledgements: [],
		verificationDisposition: null,
		finalizationOverride: null,
		verificationTerminatedAt: null,
		finalizedBy: null,
		finalizedAt: null,
	};
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

/**
 * Durably binds the verification run discovered after cancellation began.
 *
 * @param {FoundryPlan} plan
 * @param {string} runId
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function bindCancellationVerificationRun(plan, runId, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
		fail(
			"invalid_plan_transition",
			`Cannot bind a cancellation run while the plan is ${plan.status}`,
			{ path: "status" },
		);
	}
	if (plan.cancellation.verificationReservationId === null) {
		fail(
			"invalid_cancellation_verification",
			"Cancellation has no verification reservation to bind",
			{ path: "cancellation.verificationReservationId" },
		);
	}
	assertString(runId, "runId");
	if (plan.verification.runId !== null && plan.verification.runId !== runId) {
		fail("invalid_cancellation_verification", "Cancellation cannot replace a bound verification run");
	}
	if (plan.cancellation.verificationRunId !== null) {
		if (plan.cancellation.verificationRunId === runId) return clone(plan);
		fail(
			"invalid_cancellation_verification",
			"Cancellation is already bound to another verification run",
			{ path: "cancellation.verificationRunId" },
		);
	}
	const candidate = clone(plan);
	if (!candidate.cancellation) fail("missing_cancellation", "Cancellation metadata is required");
	candidate.verification.runId = runId;
	candidate.cancellation.verificationRunId = runId;
	candidate.updatedAt = nowIso(options.at);
	validatePlan(candidate);
	return candidate;
}

/**
 * Finalizes cancellation after exact task and verification dispositions exist.
 *
 * @param {FoundryPlan} plan
 * @param {unknown} dispositions
 * @param {{finalizedBy?: string, verificationRunId?: string | null,
 * verificationDisposition?: "run-terminated" | "no-run-created" | null, verificationTerminated?: boolean,
 * finalizationOverride?: import("../types/plan.js").FinalizationOverride | null, at?: ClockValue}} [options]
 * @returns {FoundryPlan}
 */
export function finalizePlanCancellation(plan, dispositions, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
		fail("invalid_plan_transition", `Cannot finalize cancellation from ${plan.status}`, {
			path: "status",
		});
	}
	requireActor(options.finalizedBy, "finalizedBy");
	if (!isList(dispositions)) {
		fail("invalid_cancellation_dispositions", "dispositions must be an array", {
			path: "dispositions",
		});
	}
	/** @type {Map<unknown, Record<string, unknown>>} */
	const byAttemptId = new Map();
	for (let index = 0; index < dispositions.length; index += 1) {
		const entry = dispositions[index];
		const fieldPath = `dispositions[${index}]`;
		assertPlainObject(entry, fieldPath);
		assertKnownKeys(entry, new Set(["attemptId", "disposition", "sessionId"]), fieldPath);
		if (byAttemptId.has(entry.attemptId)) {
			fail("duplicate_cancellation_disposition", `Attempt ${entry.attemptId} is repeated`, {
				path: `${fieldPath}.attemptId`,
			});
		}
		byAttemptId.set(entry.attemptId, entry);
	}
	const required = plan.cancellation.requiredAttemptIds;
	if (byAttemptId.size !== required.length
		|| required.some((attemptId) => !byAttemptId.has(attemptId))) {
		fail("cancellation_incomplete", "Every active attempt needs one termination disposition", {
			path: "dispositions",
			details: { requiredAttemptIds: required },
		});
	}
	const verificationRunId =
		options.verificationRunId ?? plan.cancellation.verificationRunId;
	if (plan.cancellation.verificationRunId !== null
		&& verificationRunId !== plan.cancellation.verificationRunId) {
		fail("invalid_cancellation_verification", "Verification run identity changed", {
			path: "verificationRunId",
		});
	}
	if (plan.cancellation.verificationReservationId === null) {
		if (verificationRunId !== null) {
			fail("invalid_cancellation_verification", "No verification launch was reserved", {
				path: "verificationRunId",
			});
		}
		if (options.verificationDisposition !== undefined
			&& options.verificationDisposition !== null) {
			fail("invalid_cancellation_verification", "No verification launch was reserved", {
				path: "verificationDisposition",
			});
		}
	} else if (verificationRunId === null) {
		if (options.verificationDisposition !== "no-run-created") {
			fail("cancellation_incomplete", "The reserved verification launch needs a no-run-created disposition", {
				path: "verificationDisposition",
			});
		}
	} else if (options.verificationDisposition !== "run-terminated"
		|| (options.verificationTerminated !== true && !options.finalizationOverride)) {
		fail("cancellation_incomplete", "The bound Workflow run is not confirmed terminal", {
			path: "verificationDisposition",
			details: { runId: verificationRunId },
		});
	}
	const timestamp = nowIso(options.at);
	const candidate = clone(plan);
	if (!candidate.cancellation) fail("missing_cancellation", "Cancellation metadata is required");
	candidate.cancellation.verificationRunId = verificationRunId;
	/** @type {import("../types/plan.js").Cancellation["acknowledgements"]} */
	const acknowledgements = [];
	for (const attemptId of required) {
		const task = candidate.tasks.find(
			(item) => item.attempts.some((attempt) => attempt.id === attemptId),
		);
		if (!task) {
			fail("cancellation_incomplete", `Attempt ${attemptId} has no owning task`, {
				path: "dispositions",
			});
		}
		const attempt = findAttempt(task, attemptId);
		const disposition = byAttemptId.get(attemptId);
		if (!disposition) {
			fail("cancellation_incomplete", `Attempt ${attemptId} has no disposition`, {
				path: "dispositions",
			});
		}
		if (attempt.sessionId === null) {
			if (disposition.disposition !== "no-session-created"
				|| (disposition.sessionId ?? null) !== null) {
				fail("invalid_cancellation_disposition", `${attemptId} has no attached session`, {
					path: "dispositions",
				});
			}
		} else if (disposition.disposition !== "session-terminated"
			|| disposition.sessionId !== attempt.sessionId) {
			fail("invalid_cancellation_disposition", `${attemptId} requires termination of ${attempt.sessionId}`, {
				path: "dispositions",
			});
		}
		attempt.status = ATTEMPT_STATUS.CANCELLED;
		attempt.completedAt = timestamp;
		attempt.sessionTerminatedAt = attempt.sessionId === null ? null : timestamp;
		attempt.error = candidate.cancellation.reason;
		task.status = TASK_STATUS.CANCELLED;
		const dispositionKind = attempt.sessionId === null ? "no-session-created" : "session-terminated";
		acknowledgements.push({
			attemptId,
			disposition: dispositionKind,
			sessionId: attempt.sessionId,
			acknowledgedBy: options.finalizedBy,
			acknowledgedAt: timestamp,
		});
	}
	for (const task of candidate.tasks) {
		if (task.status !== TASK_STATUS.DONE) {
			task.status = TASK_STATUS.CANCELLED;
		}
	}
	if (candidate.cancellation.verificationRunId !== null) {
		candidate.verification = {
			...candidate.verification,
			status: VERIFICATION_STATUS.FAILED,
			runId: candidate.cancellation.verificationRunId,
			summary: "Verification was cancelled with the plan",
			evidence: [],
			missingEvidence: ["Verification did not complete"],
			correctionTaskIds: candidate.tasks.map((task) => task.id),
			completedAt: timestamp,
		};
	} else if (candidate.cancellation.verificationReservationId !== null) {
		candidate.verification = emptyVerification();
	}
	candidate.cancellation.acknowledgements = acknowledgements;
	candidate.cancellation.verificationDisposition =
		candidate.cancellation.verificationReservationId === null
			? null
			: options.verificationDisposition ?? null;
	candidate.cancellation.finalizationOverride =
		options.finalizationOverride ?? null;
	candidate.cancellation.verificationTerminatedAt =
		candidate.cancellation.verificationRunId === null ? null : timestamp;
	candidate.cancellation.finalizedBy = options.finalizedBy;
	candidate.cancellation.finalizedAt = timestamp;
	candidate.status = PLAN_STATUS.CANCELLED;
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

/** Pure recovery decision; only the admission authority may persist or release it.
 * @param {import("../types/parallel.js").AdmissionRecord} value
 * @param {import("../inventory.mjs").RecoveryInventory} inventory
 * @param {{sessionIds: string[], runIds: string[]}} [retained]
 * @returns {{obligations: import("../types/parallel.js").CancellationObligation[], holds: string[]}} */
export function reconcileCancellationObligations(value, inventory, retained = { sessionIds: [], runIds: [] }) {
	const record = admissionRecord(value);
	const attempt = record.attempt;
	if (!attempt) return { obligations: [], holds: ["reservation-outcome-unresolved"] };
	const key = stableStringify(attempt);
	const matches = (/** @type {import("../types/parallel.js").AttemptIdentity} */ other) => stableStringify(other) === key;
	const ownSessions = inventory.sessions.filter(entry => matches(entry.attempt));
	const ownRuns = inventory.runs.filter(entry => matches(entry.attempt));
	const sessions = new Set([
		...retained.sessionIds,
		...record.obligations.flatMap(item => item.sessionId ? [item.sessionId] : []),
		...record.receipts.flatMap(item => item.sessionId ? [item.sessionId] : []),
		...(record.delivery ? [record.delivery.sessionId] : []),
		...ownSessions.map(item => item.id),
	]);
	const runs = new Set([
		...retained.runIds,
		...record.obligations.flatMap(item => item.runIds),
		...record.receipts.flatMap(item => item.runId ? [item.runId] : []),
		...(record.delivery?.terminalRunIds ?? []),
		...ownRuns.map(item => item.id),
	]);
	const pending = new Set(record.receipts
		.filter(item => ["intent", "in-flight", "uncertain"].includes(item.state)).map(item => item.id));
	for (const obligation of record.obligations) {
		for (const id of obligation.pendingEffectIds) {
			if (!record.receipts.some(item => item.id === id
				&& !["intent", "in-flight", "uncertain"].includes(item.state))) pending.add(id);
		}
	}
	const holds = [];
	if (!inventory.complete) holds.push("native-inventory-incomplete");
	if (record.receipts.some(item => Date.parse(item.at) >= Date.parse(inventory.capturedAt))) holds.push("native-inventory-stale");
	if (sessions.size > 1) holds.push(`ambiguous-native-sessions:${[...sessions].sort().join(",")}`);
	if (pending.size) holds.push(`native-effects-unresolved:${[...pending].sort().join(",")}`);
	if (runs.size > 128) {
		return { obligations: record.obligations, holds: [...holds, `native-observation-quarantine:run-count:${runs.size}`] };
	}
	for (const id of sessions) {
		const observed = ownSessions.find(item => item.id === id);
		if (!observed || !isTerminatedSessionState(observed.status)) holds.push(`session-not-terminal:${id}:${observed?.status ?? "unobservable"}`);
	}
	const terminalRuns = new Set(["completed", "error", "halted", "cancelled"]);
	const terminatedRunIds = [...runs].filter(id => {
		const observed = ownRuns.find(item => item.id === id);
		if (observed && terminalRuns.has(observed.status)) return true;
		holds.push(`run-not-terminal:${id}:${observed?.status ?? "unobservable"}`);
		return false;
	}).sort();
	const sessionId = [...sessions].sort()[0] ?? null;
	return {
		holds,
		obligations: [cancellationObligation({
			attempt, sessionId, runIds: [...runs].sort(), pendingEffectIds: [...pending].sort(),
			disposition: holds.length ? "unresolved" : sessionId === null ? "no-session-created" : "session-terminated",
			inventory: { complete: inventory.complete, capturedAt: inventory.capturedAt, source: inventory.source },
			terminatedRunIds,
		})],
	};
}

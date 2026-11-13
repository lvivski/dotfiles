import path from "node:path";
import { isList, isOneOf } from "../data.mjs";
import { assertKnownKeys, assertPlainObject, assertPlanId, assertString, assertStringArray, assertTimestamp, assertTimestampPair, fail, validateConceptualReview } from "./fields.mjs";
import { validateDependencyGraph, validateTaskTopology } from "./graph.mjs";
import { activeTaskAttempt, latestSuccessfulAttempt, taskMap } from "./queries.mjs";
import { validateDelegatedApproval } from "./schemas/approval.mjs";
import { validateCancellation } from "./schemas/cancellation.mjs";
import { validateEvaluationTarget, validateFactoryBinding } from "./schemas/factory.mjs";
import { validateTasks } from "./schemas/tasks.mjs";
import { validateVerification } from "./schemas/verification.mjs";
import { ATTEMPT_STATUS, EVIDENCE_OUTCOME, LIMITS, PLAN_STATUS, PLAN_STATUS_VALUES, TASK_STATUS, VERIFICATION_STATUS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").FoundryTask} FoundryTask */

const PLAN_KEYS = new Set([
	"revision",
	"id",
	"title",
	"objective",
	"constraints",
	"status",
	"repository",
	"planning",
	"factory",
	"evaluationTarget",
	"factoryVerification",
	"tasks",
	"gates",
	"verification",
	"cancellation",
	"activity",
	"createdAt",
	"updatedAt",
]);

const REPOSITORY_KEYS = new Set(["workingDirectory", "baseBranch"]);

const PLANNING_KEYS = new Set(["runId", "inputDigest", "conceptualReview"]);

const GATE_KEYS = new Set([
	"planApprovedAt",
	"planApprovedBy",
	"completionApprovedAt",
	"completionApprovedBy",
	"delegatedApproval",
	"delegatedCompletion",
]);

const ACTIVITY_KEYS = new Set([
	"event",
	"at",
	"revision",
	"actor",
	"verificationRunId",
]);

/**
 * Validates optional persisted planning-run provenance.
 *
 * @param {unknown} planning
 * @returns {asserts planning is import("../types/plan.js").Planning | null}
 */
function validatePlanning(planning) {
	if (planning === null) {
		return;
	}
	assertPlainObject(planning, "planning");
	assertKnownKeys(planning, PLANNING_KEYS, "planning");
	validateConceptualReview(planning.conceptualReview);
	assertString(planning.runId, "planning.runId", LIMITS.verificationRunId);
	if (typeof planning.inputDigest !== "string"
		|| !/^[a-f0-9]{64}$/.test(planning.inputDigest)) {
		fail("invalid_planning_digest", "planning.inputDigest must be a SHA-256 digest", {
			path: "planning.inputDigest",
		});
	}
}

/**
 * Validates the complete authoritative plan document and cross-object invariants.
 *
 * @param {unknown} plan
 * @returns {FoundryPlan}
 */
export function validatePlan(plan) {
	assertValidPlan(plan);
	return plan;
}

/** @param {unknown} plan @returns {asserts plan is FoundryPlan} */
function assertValidPlan(plan) {
	assertPlainObject(plan, "plan");
	assertKnownKeys(plan, PLAN_KEYS, "plan");

	if (typeof plan.revision !== "number" || !Number.isSafeInteger(plan.revision) || plan.revision < 1) {
		fail("invalid_revision", "revision must be a positive safe integer", { path: "revision" });
	}
	const planId = assertPlanId(plan.id);
	assertString(plan.title, "title", LIMITS.planTitle);
	assertString(plan.objective, "objective", LIMITS.objective);
	assertStringArray(plan.constraints, "constraints", {
		maximum: LIMITS.constraints,
		itemMaximum: LIMITS.constraint,
	});
	if (!isOneOf(plan.status, PLAN_STATUS_VALUES)) {
		fail("invalid_plan_status", "status is not supported", {
			path: "status",
			details: { value: plan.status },
		});
	}

	assertPlainObject(plan.repository, "repository");
	assertKnownKeys(plan.repository, REPOSITORY_KEYS, "repository");
	assertString(plan.repository.workingDirectory, "repository.workingDirectory", LIMITS.repositoryPath);
	if (!path.isAbsolute(plan.repository.workingDirectory)) {
		fail("invalid_repository_path", "repository.workingDirectory must be absolute", {
			path: "repository.workingDirectory",
		});
	}
	assertString(plan.repository.baseBranch, "repository.baseBranch", LIMITS.baseBranch);
	validatePlanning(plan.planning);
	validateFactoryBinding(plan.factory);
	const factoryBinding = plan.factory;
	validateEvaluationTarget(plan.evaluationTarget);
	if (plan.evaluationTarget != null && (plan.factory?.purpose !== "evaluation"
		|| plan.evaluationTarget.candidateId !== plan.factory.candidateId)) fail("invalid_evaluation_target", "Evaluation target requires its matching factory binding");
	if (plan.factory?.purpose === "evaluation" && plan.evaluationTarget == null) fail("invalid_evaluation_target", "Evaluation binding requires a pinned external target");
	if (plan.factoryVerification != null) {
		assertPlainObject(plan.factoryVerification, "factoryVerification");
		if (JSON.stringify(plan.factoryVerification).length > 256 * 1024) fail("invalid_factory_verification", "Frozen factory verification context exceeds 256 KiB");
	}

	if (!isList(plan.tasks) || plan.tasks.length === 0) {
		fail("invalid_tasks", "tasks must contain at least one task", { path: "tasks" });
	}
	if (plan.tasks.length > LIMITS.tasks) {
		fail("array_too_long", `tasks exceeds the ${LIMITS.tasks}-item limit`, {
			path: "tasks",
			details: { maximum: LIMITS.tasks, actual: plan.tasks.length },
		});
	}
	validateTasks(plan.tasks, plan.evaluationTarget ?? null);
	validateDependencyGraph(plan.tasks);
	const { targetTask } = validateTaskTopology(plan.tasks, plan.evaluationTarget ?? null);
	const sessionIds = new Set();
	const reservationIds = new Set();
	for (const task of plan.tasks) {
		for (const attempt of task.attempts) {
			if (reservationIds.has(attempt.reservationId)) {
				fail("duplicate_request_id", `Reservation ${attempt.reservationId} is duplicated`, {
					path: "tasks",
					details: { reservationId: attempt.reservationId },
				});
			}
			reservationIds.add(attempt.reservationId);
			if (attempt.sessionId === null) continue;
			if (sessionIds.has(attempt.sessionId)) {
				fail("duplicate_session_id", `Session ${attempt.sessionId} is attached more than once`, {
					path: "tasks",
					details: { sessionId: attempt.sessionId },
				});
			}
			sessionIds.add(attempt.sessionId);
		}
	}
	/** @type {FoundryTask[]} */
	const tasks = plan.tasks;
	const byId = taskMap(tasks);
	for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
		if (task.status === TASK_STATUS.RUNNING
			|| task.status === TASK_STATUS.DONE) {
			const unmet = task.dependsOn.filter(
				(id) => byId.get(id)?.status !== TASK_STATUS.DONE,
			);
			if (unmet.length > 0) {
				fail("dependency_unmet", `Task ${task.id} advanced before its dependencies were done`, {
					path: `tasks[${index}].status`,
					details: { unmet },
				});
			}
		}
	}

	if ((plan.status === PLAN_STATUS.DRAFT || plan.status === PLAN_STATUS.AWAITING_APPROVAL)
		&& plan.tasks.some((task) => task.status !== TASK_STATUS.PLANNED)) {
		fail("plan_not_approved", `Tasks cannot advance while the plan is ${plan.status}`, {
			path: "tasks",
		});
	}
	if (plan.tasks.some((task) => task.status === TASK_STATUS.RUNNING)
		&& plan.status !== PLAN_STATUS.RUNNING
		&& plan.status !== PLAN_STATUS.CANCELLING) {
		fail("plan_not_running", `Running tasks are not valid while the plan is ${plan.status}`, {
			path: "tasks",
		});
	}

	assertPlainObject(plan.gates, "gates");
	assertKnownKeys(plan.gates, GATE_KEYS, "gates");
	assertTimestampPair(plan.gates.planApprovedAt, plan.gates.planApprovedBy, "gates.planApproved");
	validateDelegatedApproval(plan.gates.delegatedApproval, {
		id: planId, revision: plan.revision, factory: plan.factory,
		repository: { workingDirectory: plan.repository.workingDirectory }, gates: plan.gates,
	});
	assertTimestampPair(
		plan.gates.completionApprovedAt,
		plan.gates.completionApprovedBy,
		"gates.completionApproved",
	);

	/** @type {Set<string>} */
	const approvalRequired = new Set([
		PLAN_STATUS.APPROVED,
		PLAN_STATUS.RUNNING,
		PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
		PLAN_STATUS.COMPLETED,
		PLAN_STATUS.FAILED,
	]);
	if (approvalRequired.has(plan.status) && plan.gates.planApprovedAt === null) {
		fail("missing_plan_approval", `Plan status ${plan.status} requires recorded plan approval`, {
			path: "gates.planApprovedAt",
		});
	}
	if ((plan.status === PLAN_STATUS.DRAFT || plan.status === PLAN_STATUS.AWAITING_APPROVAL)
		&& plan.gates.planApprovedAt !== null) {
		fail("premature_plan_approval", `Plan status ${plan.status} cannot carry plan approval`, {
			path: "gates.planApprovedAt",
		});
	}
	if (plan.status === PLAN_STATUS.COMPLETED && plan.gates.completionApprovedAt === null) {
		fail("missing_completion_approval", "A completed plan requires explicit completion approval", {
			path: "gates.completionApprovedAt",
		});
	}
	if (plan.status !== PLAN_STATUS.COMPLETED && plan.gates.completionApprovedAt !== null) {
		fail("premature_completion_approval", "Completion approval is only valid on a completed plan", {
			path: "gates.completionApprovedAt",
		});
	}

	/** @type {Set<string>} */
	const verificationStates = new Set([
		PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
		PLAN_STATUS.COMPLETED,
	]);
	if (verificationStates.has(plan.status)
		&& plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
		fail("implementation_incomplete", `Plan status ${plan.status} requires every task to be done`, {
			path: "tasks",
		});
	}

	validateVerification(plan.verification);
	validateDelegatedApproval(plan.gates.delegatedCompletion, {
		id: planId, revision: plan.revision, factory: plan.factory, gates: plan.gates,
		repository: { workingDirectory: plan.repository.workingDirectory }, verification: plan.verification,
		targetCommit: plan.evaluationTarget?.commit ?? (targetTask ? latestSuccessfulAttempt(targetTask)?.commit : null),
	}, "completion");
	if (plan.verification.reservationId !== null
		&& reservationIds.has(plan.verification.reservationId)) {
		fail(
			"duplicate_request_id",
			`Reservation ${plan.verification.reservationId} is duplicated`,
			{
				path: "verification.reservationId",
				details: { reservationId: plan.verification.reservationId },
			},
		);
	}
	const canonicalEvidence = new Map(plan.tasks.flatMap(
		(task) => task.attempts.flatMap(
			(attempt) => attempt.evidence.map((entry) => [entry.id, entry]),
		),
	));
	if (plan.verification.evidence.some(
		(id) => canonicalEvidence.get(id)?.outcome !== EVIDENCE_OUTCOME.PASSED,
	)) {
		fail("invalid_verification_evidence", "Verification references unknown evidence", {
			path: "verification.evidence",
		});
	}
	const correctionIds = new Set(plan.verification.correctionTaskIds);
	if (correctionIds.size !== plan.verification.correctionTaskIds.length
		|| plan.verification.correctionTaskIds.some((id) => !byId.has(id))) {
		fail("invalid_correction_tasks", "Verification correctionTaskIds must identify unique plan tasks", {
			path: "verification.correctionTaskIds",
		});
	}
	/** @type {Set<string>} */
	const preVerificationStates = new Set([
		PLAN_STATUS.DRAFT,
		PLAN_STATUS.AWAITING_APPROVAL,
		PLAN_STATUS.APPROVED,
	]);
	if (preVerificationStates.has(plan.status)
		&& plan.verification.status !== VERIFICATION_STATUS.NOT_STARTED) {
		fail("invalid_verification_state", `Verification cannot be ${plan.verification.status} while the plan is ${plan.status}`, {
			path: "verification.status",
		});
	}
	if (plan.status === PLAN_STATUS.RUNNING
		&& plan.verification.status !== VERIFICATION_STATUS.NOT_STARTED
		&& plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
		fail("invalid_verification_state", `Verification cannot be ${plan.verification.status} while the plan is running`, {
			path: "verification.status",
		});
	}
	if (plan.verification.status === VERIFICATION_STATUS.RESERVED
		&& plan.status !== PLAN_STATUS.RUNNING
		&& plan.status !== PLAN_STATUS.CANCELLING) {
		fail("invalid_verification_state", "Reserved verification requires running or cancelling plan status", {
			path: "verification.status",
		});
	}
	if (plan.verification.status === VERIFICATION_STATUS.RESERVED
		&& plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
		fail("implementation_incomplete", "Reserved verification requires every task to be done", {
			path: "tasks",
		});
	}
	if ((plan.status === PLAN_STATUS.AWAITING_COMPLETION_APPROVAL
		|| plan.status === PLAN_STATUS.COMPLETED)
		&& plan.verification.status !== VERIFICATION_STATUS.PASSED) {
		fail("verification_not_passed", `Plan status ${plan.status} requires passed verification`, {
			path: "verification.status",
		});
	}
	if (plan.verification.status === VERIFICATION_STATUS.FAILED
		&& plan.status !== PLAN_STATUS.FAILED
		&& plan.status !== PLAN_STATUS.CANCELLING
		&& plan.status !== PLAN_STATUS.CANCELLED) {
		fail("invalid_verification_state", "Failed verification requires a failed, cancelling, or cancelled plan", {
			path: "verification.status",
		});
	}
	validateCancellation(plan.cancellation, plan.status, plan.tasks);
	if (plan.cancellation?.parallelObservations?.some(observation =>
		observation.attempt.planId !== plan.id
		|| observation.attempt.repositoryId !== factoryBinding?.repositoryId
		|| observation.attempt.owner !== factoryBinding?.owner)) {
		fail("invalid_cancellation_observations", "Retained parallel observation belongs to another plan, repository or owner");
	}
	if (plan.cancellation?.verificationRunId != null
		&& plan.verification.runId !== null
		&& plan.cancellation.verificationRunId !== plan.verification.runId) {
		fail("invalid_cancellation_verification", "Cancellation run does not match bound verification", {
			path: "cancellation.verificationRunId",
		});
	}
	if (plan.status === PLAN_STATUS.CANCELLING
		&& plan.cancellation !== null && plan.cancellation.verificationReservationId !== null
		&& plan.cancellation.verificationReservationId !== plan.verification.reservationId) {
		fail("invalid_cancellation_verification", "Cancellation reservation does not match verification", {
			path: "cancellation.verificationReservationId",
		});
	}
	if (plan.status === PLAN_STATUS.CANCELLING
		&& plan.tasks.some((task) => {
			const active = activeTaskAttempt(task);
			return active !== null && active.status !== ATTEMPT_STATUS.CANCEL_REQUESTED;
		})) {
		fail("invalid_cancellation_state", "Every active task must have cancellation requested", {
			path: "tasks",
		});
	}
	if (plan.status === PLAN_STATUS.CANCELLED
		&& plan.tasks.some((task) => task.status !== TASK_STATUS.DONE
			&& task.status !== TASK_STATUS.CANCELLED)) {
		fail("invalid_cancellation_state", "Cancelled plans can retain only done or cancelled tasks", {
			path: "tasks",
		});
	}

	if (!isList(plan.activity)
		|| plan.activity.length < 1
		|| plan.activity.length > LIMITS.activity) {
		fail(
			"invalid_activity",
			`activity must contain 1-${LIMITS.activity} events`,
			{ path: "activity" },
		);
	}
	let previousActivityRevision = 0;
	plan.activity.forEach((event, index) => {
		const fieldPath = `activity[${index}]`;
		assertPlainObject(event, fieldPath);
		assertKnownKeys(event, ACTIVITY_KEYS, fieldPath);
		assertString(event.event, `${fieldPath}.event`, LIMITS.activityEvent);
		assertTimestamp(event.at, `${fieldPath}.at`);
		if (event.actor !== undefined) assertString(event.actor, `${fieldPath}.actor`, LIMITS.actor);
		if (event.verificationRunId !== undefined) {
			assertString(event.verificationRunId, `${fieldPath}.verificationRunId`, LIMITS.verificationRunId);
		}
		if (typeof event.revision !== "number" || !Number.isSafeInteger(event.revision)
			|| event.revision < 1
			|| event.revision < previousActivityRevision) {
			fail(
				"invalid_activity_revision",
				`${fieldPath}.revision must be a non-decreasing positive safe integer`,
				{ path: `${fieldPath}.revision` },
			);
		}
		previousActivityRevision = event.revision;
	});

	assertTimestamp(plan.createdAt, "createdAt");
	assertTimestamp(plan.updatedAt, "updatedAt");
	if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
		fail("invalid_plan_timestamps", "updatedAt precedes createdAt", { path: "updatedAt" });
	}
}

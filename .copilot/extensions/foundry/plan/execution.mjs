import { isOneOf } from "../data.mjs";
import { normalizeEvidence } from "./evidence.mjs";
import { assertCommit, assertHttpUrl, assertRequestId, assertString, assertTimestamp, clone, fail, nowIso } from "./fields.mjs";
import { activeTaskAttempt, assertTaskDependenciesDone, findAttempt, findTask, taskLaunchGuidance, taskStatus } from "./queries.mjs";
import { expectedAttemptId, validateScopeOverride } from "./schemas/tasks.mjs";
import { validatePlan } from "./validation.mjs";
import { ATTEMPT_STATUS, LIMITS, PLAN_STATUS, TASK_STATUS, TERMINAL_ATTEMPT_RESULTS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").ClockValue} ClockValue */

/**
 * Appends a durable task attempt before the external `create_session` call.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {{reservationId?: string, scopeOverride?: import("../types/plan.js").ScopeOverride | null, at?: ClockValue}} [options]
 * @returns {FoundryPlan}
 */
export function reserveTaskAttempt(plan, taskId, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
		fail("plan_not_running", `Task ${taskId} cannot be reserved while the plan is ${plan.status}`, {
			path: "status",
		});
	}
	assertRequestId(options.reservationId, "reservationId");
	validateScopeOverride(options.scopeOverride ?? null, "scopeOverride");
	const candidate = clone(plan);
	const task = findTask(candidate, taskId);
	if (taskStatus(candidate, task) !== TASK_STATUS.READY) {
		fail("invalid_task_transition", `Cannot reserve task ${task.id} from ${task.status}`, {
			path: "taskId",
			details: { taskId, status: task.status },
		});
	}
	if (task.attempts.length >= LIMITS.attempts) {
		fail("attempt_limit_reached", `Task ${task.id} reached the attempt limit`, {
			path: "taskId",
			details: { maximum: LIMITS.attempts },
		});
	}
	if (candidate.tasks.some((item) => item.attempts.some(
		(attempt) => attempt.reservationId === options.reservationId,
	))) {
		fail("duplicate_request_id", `Reservation ${options.reservationId} already exists`, {
			path: "reservationId",
		});
	}
	const guidance = taskLaunchGuidance(plan, taskId);
	const timestamp = nowIso(options.at);
	task.attempts.push({
		id: expectedAttemptId(task.id, task.attempts.length),
		reservationId: options.reservationId,
		status: ATTEMPT_STATUS.RESERVED,
		baseBranch: guidance.baseBranch,
		integrationRequired: guidance.integrationRequired,
		scopeOverride: clone(options.scopeOverride ?? null),
		sessionId: null,
		branch: null,
		commit: null,
		prUrl: null,
		resultSummary: null,
		evidence: [],
		error: null,
		reservedAt: timestamp,
		startedAt: null,
		sessionTerminatedAt: null,
		cancelRequestedAt: null,
		completedAt: null,
	});
	task.status = TASK_STATUS.RUNNING;
	if (candidate.status === PLAN_STATUS.APPROVED) {
		candidate.status = PLAN_STATUS.RUNNING;
	}
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

/**
 * Attaches one App child-session identity to a reserved attempt.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {string} attemptId
 * @param {{sessionId?: string, branch?: string | null, at?: ClockValue, verifierWorktree?: import("../types/plan.js").VerifierWorktree}} [options]
 * @returns {FoundryPlan}
 */
export function attachTaskAttempt(plan, taskId, attemptId, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.RUNNING && plan.status !== PLAN_STATUS.CANCELLING) {
		fail("plan_not_running", `Attempt ${attemptId} cannot attach while the plan is ${plan.status}`, {
			path: "status",
		});
	}
	assertString(options.sessionId, "sessionId", LIMITS.sessionId);
	if (options.branch !== undefined && options.branch !== null) {
		assertString(options.branch, "branch", LIMITS.branch);
	}
	const candidate = clone(plan);
	const task = findTask(candidate, taskId);
	const attempt = findAttempt(task, attemptId);
	if (attempt.sessionId !== null) {
		if (attempt.sessionId === options.sessionId
			&& attempt.branch === (options.branch ?? null)) {
			return candidate;
		}
		fail("attempt_already_attached", `Attempt ${attemptId} is already attached`, {
			path: "attemptId",
		});
	}
	if (attempt.status !== ATTEMPT_STATUS.RESERVED
		&& attempt.status !== ATTEMPT_STATUS.CANCEL_REQUESTED) {
		fail("invalid_attempt_transition", `Attempt ${attemptId} cannot attach from ${attempt.status}`, {
			path: "attemptId",
		});
	}
	if (plan.status === PLAN_STATUS.CANCELLING
		&& !plan.cancellation?.requiredAttemptIds.includes(attemptId)) {
		fail("invalid_cancellation_attempt", `Attempt ${attemptId} was not active when cancellation began`, {
			path: "attemptId",
		});
	}
	const duplicate = candidate.tasks.some((item) => item.attempts.some(
		(other) => other.id !== attemptId && other.sessionId === options.sessionId,
	));
	if (duplicate) {
		fail("duplicate_session_id", `Session ${options.sessionId} is already attached`, {
			path: "sessionId",
		});
	}
	const timestamp = nowIso(options.at);
	attempt.sessionId = options.sessionId;
	attempt.branch = options.branch ?? null;
	if (options.verifierWorktree) attempt.verifierWorktree = clone(options.verifierWorktree);
	attempt.startedAt = timestamp;
	if (attempt.status === ATTEMPT_STATUS.RESERVED) {
		attempt.status = ATTEMPT_STATUS.RUNNING;
	}
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

/**
 * Records the terminal outcome of the currently active attempt.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {string} attemptId
 * @param {string} status
 * @param {{branch?: string | null, commit?: string | null, prUrl?: string | null, resultSummary?: string | null,
 * evidence?: unknown, error?: string | null, learning?: import("../types/plan.js").Learning[],
 * factoryEvaluations?: import("../types/plan.js").EvaluationReport[], sessionTerminatedAt?: string | null, at?: ClockValue,
 * repositoryCheck?: import("../types/plan.js").RepositoryCheck}} [options]
 * @returns {FoundryPlan}
 */
export function completeTaskAttempt(plan, taskId, attemptId, status, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.RUNNING) {
		fail("plan_not_running", `Attempt ${attemptId} cannot complete while the plan is ${plan.status}`, {
			path: "status",
		});
	}
	if (!isOneOf(status, TERMINAL_ATTEMPT_RESULTS)) {
		fail("invalid_attempt_status", `Attempt result ${status} is not supported`, {
			path: "status",
		});
	}
	const candidate = clone(plan);
	const task = findTask(candidate, taskId);
	const attempt = findAttempt(task, attemptId);
	if (task.status !== TASK_STATUS.RUNNING || activeTaskAttempt(task)?.id !== attemptId) {
		fail("stale_attempt", `Attempt ${attemptId} is not active for ${taskId}`, {
			path: "attemptId",
		});
	}
	if (attempt.status !== ATTEMPT_STATUS.RESERVED
		&& attempt.status !== ATTEMPT_STATUS.RUNNING) {
		fail("invalid_attempt_transition", `Attempt ${attemptId} cannot finish from ${attempt.status}`, {
			path: "attemptId",
		});
	}
	if (status === ATTEMPT_STATUS.DONE && attempt.status !== ATTEMPT_STATUS.RUNNING) {
		fail("attempt_not_attached", `Attempt ${attemptId} must attach a session before success`, {
			path: "attemptId",
		});
	}
	if (options.branch !== undefined && options.branch !== null) {
		assertString(options.branch, "branch", LIMITS.branch);
		if (attempt.branch !== null && attempt.branch !== options.branch) {
			fail("branch_mismatch", `Attempt ${attemptId} is attached to ${attempt.branch}`, {
				path: "branch",
			});
		}
		attempt.branch ??= options.branch;
	}
	assertCommit(options.commit ?? null, "commit");
	assertHttpUrl(options.prUrl ?? null, "prUrl");
	if (options.sessionTerminatedAt !== undefined
		&& options.sessionTerminatedAt !== null) {
		assertTimestamp(options.sessionTerminatedAt, "sessionTerminatedAt");
	}
	const timestamp = nowIso(options.at);
	attempt.status = status;
	attempt.commit = options.commit ?? null;
	attempt.prUrl = options.prUrl ?? null;
	attempt.resultSummary = options.resultSummary ?? null;
	attempt.learning = clone(options.learning ?? []);
	attempt.factoryEvaluations = clone(options.factoryEvaluations ?? []);
	if (options.repositoryCheck) attempt.repositoryCheck = clone(options.repositoryCheck);
	attempt.evidence = normalizeEvidence(
		options.evidence ?? [],
		candidate,
		task,
		attempt,
		status,
	);
	attempt.error = options.error ?? null;
	attempt.sessionTerminatedAt = options.sessionTerminatedAt ?? null;
	attempt.completedAt = timestamp;
	task.status = status;
	candidate.updatedAt = timestamp;
	validatePlan(candidate);
	return candidate;
}

/**
 * Returns failed or blocked work to ready without deleting attempt history.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function retryTask(plan, taskId, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
		fail("plan_not_running", `Task ${taskId} cannot retry while the plan is ${plan.status}`, {
			path: "status",
		});
	}
	const candidate = clone(plan);
	const task = findTask(candidate, taskId);
	if (task.status !== TASK_STATUS.BLOCKED && task.status !== TASK_STATUS.FAILED) {
		fail("invalid_task_transition", `Task ${taskId} cannot retry from ${task.status}`, {
			path: "taskId",
		});
	}
	assertTaskDependenciesDone(candidate, task);
	task.status = TASK_STATUS.PLANNED;
	candidate.updatedAt = nowIso(options.at);
	validatePlan(candidate);
	return candidate;
}

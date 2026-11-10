import { isList, isOneOf } from "../../data.mjs";
import { effectiveDeliveryRequirement, taskCompletionRequirements } from "../delivery.mjs";
import { validateEvidence } from "../evidence.mjs";
import { assertCommit, assertHttpUrl, assertKnownKeys, assertNullableString, assertPlainObject, assertRequestId, assertString, assertStringArray, assertTimestamp, fail } from "../fields.mjs";
import { verificationCheckIds } from "../graph.mjs";
import { ATTEMPT_ID_PATTERN, ATTEMPT_STATUS, ATTEMPT_STATUS_VALUES, DELIVERY_REQUIREMENT, LIMITS, TASK_ID_PATTERN, TASK_KINDS, TASK_STATUS, TASK_STATUS_VALUES } from "../values.mjs";
import { validateFactoryEvaluations, validateFactoryLearning, validateRepositoryCheck, validateVerifierWorktree } from "./factory.mjs";

/** @typedef {import("../../types/plan.js").FoundryTask} FoundryTask */
/** @typedef {import("../../types/plan.js").FoundryAttempt} FoundryAttempt */
/** @typedef {import("../../types/plan.js").EvaluationTarget} EvaluationTarget */

const TASK_KEYS = new Set([
	"id",
	"title",
	"kind",
	"description",
	"dependsOn",
	"status",
	"acceptanceCriteria",
	"expectedFiles",
	"deliveryRequirement",
	"attempts",
]);

const ATTEMPT_KEYS = new Set([
	"id",
	"reservationId",
	"status",
	"baseBranch",
	"integrationRequired",
	"scopeOverride",
	"sessionId",
	"branch",
	"commit",
	"prUrl",
	"resultSummary",
	"evidence",
	"learning",
	"factoryEvaluations",
	"error",
	"reservedAt",
	"startedAt",
	"sessionTerminatedAt",
	"cancelRequestedAt",
	"completedAt",
	"verifierWorktree",
	"repositoryCheck",
]);

const INTEGRATION_KEYS = new Set([
	"taskId",
	"attemptId",
	"branch",
	"commit",
	"prUrl",
]);

const SCOPE_OVERRIDE_KEYS = new Set(["approvedBy", "reason"]);

/**
 * Derives the next canonical attempt ID for a task-local index.
 *
 * @param {string} taskId
 * @param {number} index
 * @returns {string}
 */
export function expectedAttemptId(taskId, index) {
	return `${taskId}-A${String(index + 1).padStart(3, "0")}`;
}

/**
 * Validates a dependency delivery that must be integrated by a later attempt.
 *
 * @param {unknown} entry
 * @param {string} fieldPath
 * @returns {asserts entry is import("../../types/plan.js").IntegrationEntry}
 */
function validateIntegrationEntry(entry, fieldPath) {
	assertPlainObject(entry, fieldPath);
	assertKnownKeys(entry, INTEGRATION_KEYS, fieldPath);
	if (typeof entry.taskId !== "string" || !TASK_ID_PATTERN.test(entry.taskId)) {
		fail("invalid_task_id", `${fieldPath}.taskId must use the T-001 format`, {
			path: `${fieldPath}.taskId`,
		});
	}
	if (typeof entry.attemptId !== "string"
		|| !ATTEMPT_ID_PATTERN.test(entry.attemptId)
		|| !entry.attemptId.startsWith(`${entry.taskId}-`)) {
		fail("invalid_attempt_id", `${fieldPath}.attemptId must belong to ${entry.taskId}`, {
			path: `${fieldPath}.attemptId`,
		});
	}
	assertNullableString(entry.branch, `${fieldPath}.branch`, LIMITS.branch);
	assertCommit(entry.commit, `${fieldPath}.commit`);
	assertHttpUrl(entry.prUrl, `${fieldPath}.prUrl`);
	if (entry.branch === null && entry.commit === null && entry.prUrl === null) {
		fail("invalid_integration_entry", `${fieldPath} must identify delivered work`, {
			path: fieldPath,
		});
	}
}

/**
 * Validates an auditable file-scope overlap approval.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @returns {asserts value is import("../../types/plan.js").ScopeOverride | null}
 */
export function validateScopeOverride(value, fieldPath) {
	if (value === null) return;
	assertPlainObject(value, fieldPath);
	assertKnownKeys(value, SCOPE_OVERRIDE_KEYS, fieldPath);
	assertString(value.approvedBy, `${fieldPath}.approvedBy`, LIMITS.actor);
	assertString(value.reason, `${fieldPath}.reason`, LIMITS.error);
}

/**
 * Validates one attempt and all status-dependent field invariants.
 *
 * @param {unknown} attempt
 * @param {Pick<FoundryTask, "id" | "kind" | "deliveryRequirement">} task
 * @param {number} index
 * @param {string} fieldPath
 * @returns {asserts attempt is FoundryAttempt}
 */
function validateAttempt(attempt, task, index, fieldPath) {
	assertPlainObject(attempt, fieldPath);
	assertKnownKeys(attempt, ATTEMPT_KEYS, fieldPath);
	const expectedId = expectedAttemptId(task.id, index);
	if (attempt.id !== expectedId || !ATTEMPT_ID_PATTERN.test(attempt.id)) {
		fail("invalid_attempt_id", `${fieldPath}.id must be ${expectedId}`, {
			path: `${fieldPath}.id`,
		});
	}
	assertRequestId(attempt.reservationId, `${fieldPath}.reservationId`);
	if (!isOneOf(attempt.status, ATTEMPT_STATUS_VALUES)) {
		fail("invalid_attempt_status", `${fieldPath}.status is not supported`, {
			path: `${fieldPath}.status`,
		});
	}
	assertString(attempt.baseBranch, `${fieldPath}.baseBranch`, LIMITS.baseBranch);
	if (!isList(attempt.integrationRequired)
		|| attempt.integrationRequired.length > LIMITS.dependencies) {
		fail("invalid_integration_entries", `${fieldPath}.integrationRequired is invalid`, {
			path: `${fieldPath}.integrationRequired`,
		});
	}
	attempt.integrationRequired.forEach((entry, integrationIndex) => {
		validateIntegrationEntry(
			entry,
			`${fieldPath}.integrationRequired[${integrationIndex}]`,
		);
	});
	validateScopeOverride(attempt.scopeOverride, `${fieldPath}.scopeOverride`);
	assertNullableString(attempt.sessionId, `${fieldPath}.sessionId`, LIMITS.sessionId);
	assertNullableString(attempt.branch, `${fieldPath}.branch`, LIMITS.branch);
	assertCommit(attempt.commit, `${fieldPath}.commit`);
	assertHttpUrl(attempt.prUrl, `${fieldPath}.prUrl`);
	assertNullableString(attempt.resultSummary, `${fieldPath}.resultSummary`, LIMITS.resultSummary);
	if (!isList(attempt.evidence) || attempt.evidence.length > LIMITS.evidence) {
		fail("invalid_evidence", `${fieldPath}.evidence is invalid`, {
			path: `${fieldPath}.evidence`,
		});
	}
	const evidenceOwner = { id: expectedId, sessionId: attempt.sessionId };
	attempt.evidence.forEach((entry, evidenceIndex) => {
		validateEvidence(entry, task, evidenceOwner, evidenceIndex, `${fieldPath}.evidence[${evidenceIndex}]`);
	});
	if (attempt.learning !== undefined) validateFactoryLearning(attempt.learning);
	if (attempt.factoryEvaluations !== undefined) validateFactoryEvaluations(attempt.factoryEvaluations);
	if (attempt.verifierWorktree !== undefined) {
		validateVerifierWorktree(attempt.verifierWorktree);
		if (task.kind !== "verify" || attempt.sessionId === null) fail("invalid_verifier_worktree", "Only an attached verifier can pin a worktree");
	}
	if (attempt.repositoryCheck !== undefined) {
		validateRepositoryCheck(attempt.repositoryCheck);
		if (attempt.status !== ATTEMPT_STATUS.DONE || attempt.repositoryCheck.commit !== attempt.commit) fail("invalid_repository_check", "Repository observations belong to the exact completed attempt");
		if (task.kind === "verify" && (!attempt.repositoryCheck.worktree || attempt.verifierWorktree?.status !== "available")) fail("invalid_repository_check", "A verified repository observation requires the pinned verifier worktree");
	}
	if (task.kind !== "verify" && attempt.factoryEvaluations?.length) {
		fail("invalid_factory_evidence", "Only the independent verifier can report factory evaluations");
	}
	assertNullableString(attempt.error, `${fieldPath}.error`, LIMITS.error);
	assertTimestamp(attempt.reservedAt, `${fieldPath}.reservedAt`);
	assertTimestamp(attempt.startedAt, `${fieldPath}.startedAt`, { nullable: true });
	assertTimestamp(
		attempt.sessionTerminatedAt,
		`${fieldPath}.sessionTerminatedAt`,
		{ nullable: true },
	);
	assertTimestamp(attempt.cancelRequestedAt, `${fieldPath}.cancelRequestedAt`, { nullable: true });
	assertTimestamp(attempt.completedAt, `${fieldPath}.completedAt`, { nullable: true });
	if (attempt.startedAt !== null
		&& Date.parse(attempt.startedAt) < Date.parse(attempt.reservedAt)) {
		fail("invalid_attempt_timestamps", `${fieldPath}.startedAt precedes reservedAt`, {
			path: `${fieldPath}.startedAt`,
		});
	}
	if (attempt.completedAt !== null
		&& Date.parse(attempt.completedAt) < Date.parse(attempt.reservedAt)) {
		fail("invalid_attempt_timestamps", `${fieldPath}.completedAt precedes reservedAt`, {
			path: `${fieldPath}.completedAt`,
		});
	}

	if (attempt.status === ATTEMPT_STATUS.RESERVED) {
		if (attempt.sessionId !== null
			|| attempt.branch !== null
			|| attempt.commit !== null
			|| attempt.prUrl !== null
			|| attempt.resultSummary !== null
			|| attempt.evidence.length > 0
			|| attempt.error !== null
			|| attempt.startedAt !== null
			|| attempt.sessionTerminatedAt !== null
			|| attempt.cancelRequestedAt !== null
			|| attempt.completedAt !== null) {
			fail("invalid_attempt_state", `${fieldPath} contains data before attachment`, {
				path: fieldPath,
			});
		}
	} else if (attempt.status === ATTEMPT_STATUS.RUNNING) {
		if (attempt.sessionId === null
			|| attempt.startedAt === null
			|| attempt.resultSummary !== null
			|| attempt.evidence.length > 0
			|| attempt.error !== null
			|| attempt.sessionTerminatedAt !== null
			|| attempt.cancelRequestedAt !== null
			|| attempt.completedAt !== null) {
			fail("invalid_attempt_state", `${fieldPath} is not a valid running attempt`, {
				path: fieldPath,
			});
		}
	} else if (attempt.status === ATTEMPT_STATUS.DONE) {
		const { requirement, missing, missingDelivery } = taskCompletionRequirements(task, {
			...attempt, integrationRequired: attempt.integrationRequired,
		});
		if (missing.length > 0
			|| attempt.startedAt === null
			|| attempt.error !== null
			|| attempt.sessionTerminatedAt !== null
			|| attempt.cancelRequestedAt !== null
			|| attempt.completedAt === null) {
			fail("invalid_attempt_state", `${fieldPath} is not a valid completed attempt`, {
				path: fieldPath,
			});
		}
		if (missingDelivery.length > 0) {
			fail(
				"delivery_requirement_unsatisfied",
				`Attempt ${attempt.id} does not satisfy ${requirement} delivery`,
				{
					path: fieldPath,
					details: {
						requirement,
						branch: attempt.branch,
						commit: attempt.commit,
						prUrl: attempt.prUrl,
					},
				},
			);
		}
	} else if (attempt.status === ATTEMPT_STATUS.BLOCKED
		|| attempt.status === ATTEMPT_STATUS.FAILED) {
		if (attempt.error === null
			|| attempt.completedAt === null
			|| attempt.cancelRequestedAt !== null
			|| (attempt.sessionId === null && attempt.sessionTerminatedAt !== null)
			|| (attempt.sessionId !== null
				&& (attempt.startedAt === null || attempt.sessionTerminatedAt === null))) {
			fail("invalid_attempt_state", `${fieldPath} is not a valid terminal attempt`, {
				path: fieldPath,
			});
		}
	} else if (attempt.status === ATTEMPT_STATUS.CANCEL_REQUESTED) {
		if (attempt.cancelRequestedAt === null
			|| attempt.completedAt !== null
			|| attempt.error === null
			|| attempt.sessionTerminatedAt !== null
			|| (attempt.sessionId !== null && attempt.startedAt === null)) {
			fail("invalid_attempt_state", `${fieldPath} is not awaiting cancellation`, {
				path: fieldPath,
			});
		}
	} else if (attempt.status === ATTEMPT_STATUS.CANCELLED
		&& (attempt.cancelRequestedAt === null
			|| attempt.completedAt === null
			|| attempt.error === null
			|| (attempt.sessionId === null && attempt.sessionTerminatedAt !== null)
			|| (attempt.sessionId !== null
				&& (attempt.startedAt === null || attempt.sessionTerminatedAt === null)))) {
		fail("invalid_attempt_state", `${fieldPath} is not a valid cancelled attempt`, {
			path: fieldPath,
		});
	}
}

/**
 * Validates one task and its append-only attempt history.
 *
 * @param {unknown} task
 * @param {number} index
 * @returns {asserts task is FoundryTask}
 */
function validateTask(task, index) {
	const fieldPath = `tasks[${index}]`;
	assertPlainObject(task, fieldPath);
	assertKnownKeys(task, TASK_KEYS, fieldPath);
	if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id)) {
		fail("invalid_task_id", `${fieldPath}.id must use the T-001 format`, {
			path: `${fieldPath}.id`,
		});
	}
	assertString(task.title, `${fieldPath}.title`, LIMITS.taskTitle);
	if (!isOneOf(task.kind, TASK_KINDS)) {
		fail("invalid_task_kind", `${fieldPath}.kind must be implement or verify`, {
			path: `${fieldPath}.kind`,
		});
	}
	assertString(task.description, `${fieldPath}.description`, LIMITS.taskDescription);
	assertStringArray(task.dependsOn, `${fieldPath}.dependsOn`, {
		maximum: LIMITS.dependencies,
		itemMaximum: 5,
	});
	if (typeof task.status !== "string" || !TASK_STATUS_VALUES.has(task.status)) {
		fail("invalid_task_status", `${fieldPath}.status is not supported`, {
			path: `${fieldPath}.status`,
			details: { value: task.status },
		});
	}
	assertStringArray(task.acceptanceCriteria, `${fieldPath}.acceptanceCriteria`, {
		minimum: task.kind === "verify" ? 0 : 1,
		maximum: LIMITS.acceptanceCriteria,
		itemMaximum: LIMITS.acceptanceCriterion,
	});
	assertStringArray(task.expectedFiles, `${fieldPath}.expectedFiles`, {
		maximum: LIMITS.expectedFiles,
		itemMaximum: LIMITS.expectedFile,
	});
	const deliveryRequirement = effectiveDeliveryRequirement(task, `${fieldPath}.deliveryRequirement`);
	if (task.kind === "verify"
		&& (task.acceptanceCriteria.length !== 0
			|| task.expectedFiles.length !== 0
			|| task.deliveryRequirement !== DELIVERY_REQUIREMENT.COMMIT)) {
		fail(
			"invalid_verifier_task",
			"Verifier tasks require no authored criteria/files and commit delivery",
			{ path: fieldPath },
		);
	}
	if (!isList(task.attempts) || task.attempts.length > LIMITS.attempts) {
		fail("invalid_attempts", `${fieldPath}.attempts is invalid`, {
			path: `${fieldPath}.attempts`,
		});
	}
	const header = { id: task.id, kind: task.kind, deliveryRequirement };
	const attempts = task.attempts.map((attempt, attemptIndex) => {
		validateAttempt(attempt, header, attemptIndex, `${fieldPath}.attempts[${attemptIndex}]`);
		return attempt;
	});
	const active = attempts.filter((attempt) => isOneOf(attempt.status, [
		ATTEMPT_STATUS.RESERVED,
		ATTEMPT_STATUS.RUNNING,
		ATTEMPT_STATUS.CANCEL_REQUESTED,
	]));
	if (active.length > 1) {
		fail("multiple_active_attempts", `${fieldPath} has more than one active attempt`, {
			path: `${fieldPath}.attempts`,
		});
	}
	if (task.status === TASK_STATUS.RUNNING && active.length !== 1) {
		fail("invalid_task_state", `${fieldPath} requires one active attempt while running`, {
			path: fieldPath,
		});
	}
	if (task.status !== TASK_STATUS.RUNNING && active.length !== 0) {
		fail("invalid_task_state", `${fieldPath} cannot retain an active attempt in ${task.status}`, {
			path: fieldPath,
		});
	}
	const latest = attempts.at(-1);
	if (task.status === TASK_STATUS.DONE && latest?.status !== ATTEMPT_STATUS.DONE) {
		fail("invalid_task_state", `${fieldPath} must end in a successful attempt`, {
			path: fieldPath,
		});
	}
	if (task.status === TASK_STATUS.BLOCKED && latest?.status !== ATTEMPT_STATUS.BLOCKED) {
		fail("invalid_task_state", `${fieldPath} must end in a blocked attempt`, {
			path: fieldPath,
		});
	}
	if (task.status === TASK_STATUS.FAILED && latest?.status !== ATTEMPT_STATUS.FAILED) {
		fail("invalid_task_state", `${fieldPath} must end in a failed attempt`, {
			path: fieldPath,
		});
	}
}

/** @param {unknown[]} tasks @param {EvaluationTarget | null} evaluationTarget @returns {asserts tasks is FoundryTask[]} */
export function validateTasks(tasks, evaluationTarget) {
	const checked = tasks.map((task, index) => {
		validateTask(task, index);
		return task;
	});
	for (const [index, task] of checked.entries()) {
		if (task.kind !== "verify") continue;
		const expectedChecks = verificationCheckIds(checked, evaluationTarget);
		for (const [attemptIndex, attempt] of task.attempts.entries()) {
			const fieldPath = `tasks[${index}].attempts[${attemptIndex}]`;
			const actualChecks = attempt.evidence.map((entry) => entry.checkId);
			if (new Set(actualChecks).size !== actualChecks.length
				|| actualChecks.some((checkId) => checkId === null || !expectedChecks.includes(checkId))) {
				fail("invalid_verifier_report", `${fieldPath} contains invalid check IDs`, { path: `${fieldPath}.evidence` });
			}
			if (attempt.status === ATTEMPT_STATUS.DONE
				&& (actualChecks.length !== expectedChecks.length
					|| actualChecks.some((checkId, checkIndex) => checkId !== expectedChecks[checkIndex])
					|| attempt.prUrl !== null)) {
				fail("invalid_verifier_report", `${fieldPath} lacks the canonical verifier report`, { path: fieldPath });
			}
		}
	}
}

import { clone, fail } from "./fields.mjs";
import { taskCompletionRequirements } from "./delivery.mjs";
import { ACTIVE_ATTEMPT_STATUSES, ATTEMPT_STATUS, PLAN_STATUS, TASK_STATUS } from "./values.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/plan.js").FoundryTask} FoundryTask */
/** @typedef {import("../types/plan.js").FoundryAttempt} FoundryAttempt */

/**
 * Indexes tasks by stable task ID.
 *
 * @template {{id: string}} T
 * @param {T[]} tasks
 * @returns {Map<string, T>}
 */
export function taskMap(tasks) {
	return new Map(tasks.map((task) => [task.id, task]));
}

/**
 * Returns the sole nonterminal attempt for a task.
 *
 * @param {FoundryTask} task
 * @returns {FoundryAttempt | null}
 */
export function activeTaskAttempt(task) {
	return task.attempts.find((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) ?? null;
}

/**
 * Returns the most recent successful attempt without mutating history.
 *
 * @param {FoundryTask} task
 * @returns {FoundryAttempt | null}
 */
export function latestSuccessfulAttempt(task) {
	return [...task.attempts].reverse().find(
		(attempt) => attempt.status === ATTEMPT_STATUS.DONE,
	) ?? null;
}

/** Completion labels and foreign observations cannot replace a recorded delivery.
 * @param {FoundryTask | undefined} task */
export function hasSuccessfulDelivery(task) {
	if (!task || task.status !== TASK_STATUS.DONE) return false;
	const attempt = latestSuccessfulAttempt(task);
	if (!attempt?.completedAt) return false;
	const requirements = taskCompletionRequirements(task, attempt);
	return requirements.missing.length === 0 && requirements.missingDelivery.length === 0;
}

/**
 * Finds a task or throws a typed domain error.
 *
 * @param {FoundryPlan} candidate
 * @param {string} taskId
 * @returns {FoundryTask}
 */
export function findTask(candidate, taskId) {
	const task = candidate.tasks.find((item) => item.id === taskId);
	if (!task) {
		fail("task_not_found", `Task ${taskId} does not exist`, {
			path: "taskId",
			details: { taskId },
		});
	}
	return task;
}

/**
 * Finds an attempt within its owning task or fails closed.
 *
 * @param {FoundryTask} task
 * @param {string} attemptId
 * @returns {FoundryAttempt}
 */
export function findAttempt(task, attemptId) {
	const attempt = task.attempts.find((item) => item.id === attemptId);
	if (!attempt) {
		fail("attempt_not_found", `Attempt ${attemptId} does not exist on ${task.id}`, {
			path: "attemptId",
			details: { taskId: task.id, attemptId },
		});
	}
	return attempt;
}

/**
 * Requires every declared dependency to be successfully done.
 *
 * @param {FoundryPlan} plan
 * @param {FoundryTask} task
 * @returns {void}
 */
export function assertTaskDependenciesDone(plan, task) {
	const byId = taskMap(plan.tasks);
	const unmet = task.dependsOn.filter(
		(id) => !hasSuccessfulDelivery(byId.get(id)),
	);
	if (unmet.length > 0) {
		fail("dependency_unmet", `Task ${task.id} has unfinished dependencies`, {
			path: "taskId",
			details: { unmet },
		});
	}
}

/**
 * Derives the deterministic App base branch and additional integration work.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @returns {{baseBranch: string, dependencies: import("../types/plan.js").IntegrationEntry[], integrationRequired: import("../types/plan.js").IntegrationEntry[]}}
 */
export function taskLaunchGuidance(plan, taskId) {
	const task = findTask(plan, taskId);
	assertTaskDependenciesDone(plan, task);
	const byId = taskMap(plan.tasks);
	const dependencies = task.dependsOn
		.map((id) => {
			const dependency = byId.get(id);
			if (!dependency) {
				fail("unknown_dependency", `Task ${task.id} depends on unknown task ${id}`, {
					path: "dependsOn",
				});
			}
			const attempt = latestSuccessfulAttempt(dependency);
			if (!attempt) {
				fail("dependency_delivery_missing", `Task ${id} has no successful delivery`, {
					path: "taskId",
					details: { taskId, dependencyId: id },
				});
			}
			return {
				taskId: id,
				attemptId: attempt.id,
				branch: attempt.branch,
				commit: attempt.commit,
				prUrl: attempt.prUrl,
			};
		})
		.sort((left, right) => left.taskId.localeCompare(right.taskId));
	const baseDelivery = dependencies.find((dependency) => dependency.branch !== null) ?? null;
	const baseBranch = baseDelivery?.branch ?? plan.repository.baseBranch;
	const integrationRequired = dependencies.filter(
		(dependency) => dependency.branch !== baseBranch,
	);
	return {
		baseBranch,
		dependencies: clone(dependencies),
		integrationRequired: clone(integrationRequired),
	};
}

/** @param {FoundryPlan} plan @param {FoundryTask} task */
export function taskStatus(plan, task) {
	if (task.status !== TASK_STATUS.PLANNED) return task.status;
	return (plan.status === PLAN_STATUS.APPROVED || plan.status === PLAN_STATUS.RUNNING)
		&& task.dependsOn.every((id) => plan.tasks.some((dependency) =>
			dependency.id === id && hasSuccessfulDelivery(dependency)))
		? TASK_STATUS.READY : TASK_STATUS.PLANNED;
}

/**
 * Returns dependency-ready tasks in stable ID order.
 *
 * @param {FoundryPlan} plan
 * @returns {FoundryTask[]}
 */
export function getReadyTasks(plan) {
	if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
		return [];
	}
	return plan.tasks
		.filter((task) => taskStatus(plan, task) === TASK_STATUS.READY)
		.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
		.map((task) => ({ ...clone(task), status: TASK_STATUS.READY }));
}

/**
 * Builds a bounded plan-list summary with progress and provenance.
 *
 * @param {FoundryPlan} plan
 */
export function summarizePlan(plan) {
	const byStatus = Object.fromEntries(Object.values(TASK_STATUS).map((status) => [status, 0]));
	for (const task of plan.tasks) {
		byStatus[taskStatus(plan, task)] += 1;
	}
	return {
		id: plan.id,
		title: plan.title,
		objective: plan.objective,
		status: plan.status,
		revision: plan.revision,
		tasksTotal: plan.tasks.length,
		tasksDone: byStatus[TASK_STATUS.DONE],
		tasksByStatus: byStatus,
		attemptsTotal: plan.tasks.reduce((sum, task) => sum + task.attempts.length, 0),
		planningRunId: plan.planning?.runId ?? null,
		verificationStatus: plan.verification.status,
		updatedAt: plan.updatedAt,
	};
}

import { FoundryError, text } from "./values.mjs";

/** @typedef {import("./model.d.ts").Goal} Goal */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @returns {Task[]} */
export function ancestors(tx, task) {
	const result = [];
	const seen = new Set([task.id]);
	let parentId = task.parentId;
	while (parentId) {
		if (seen.has(parentId)) throw new FoundryError("corrupt_tree", "Delegation must be a tree");
		seen.add(parentId);
		const parent = tx.get("tasks", parentId);
		if (parent.goalId !== task.goalId) throw new FoundryError("corrupt_tree", "Parent belongs to another goal");
		result.push(parent);
		parentId = parent.parentId;
	}
	return result;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} actor */
export function authorized(tx, task, actor) {
	text(actor, "actor");
	if (task.owner === actor || tx.get("goals", task.goalId).owner === actor) return true;
	return tx.db.prepare(`${MANAGED_TASKS} SELECT id FROM managed WHERE id=?`).get(actor, actor, task.id) !== undefined;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} actor */
export function requireOwner(tx, task, actor) {
	if (!authorized(tx, task, actor)) throw new FoundryError("forbidden", "Only the task owner or its accountable ancestors may manage this task");
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} actor */
export function assignedExecution(tx, task, actor) {
	const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	return task.repairReservation?.worker === actor || attempt?.nativeId === actor && attempt.taskVersion === task.version;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor @param {boolean} [execution] */
export function taskForCaller(tx, taskId, actor, execution = false) {
	const task = tx.get("tasks", taskId);
	if (!authorized(tx, task, actor) && !(execution && assignedExecution(tx, task, actor))) {
		throw new FoundryError("foreign_task", "This native session does not own the task or its assigned execution");
	}
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {Goal} goal @param {string} actor */
export function requireGoalOwner(tx, goal, actor) {
	if (goal.owner !== text(actor, "actor")) throw new FoundryError("forbidden", "Only the goal owner may manage this goal");
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} boundary */
export function below(tx, task, boundary) {
	return task.id === boundary || ancestors(tx, task).some(parent => parent.id === boundary);
}

/** @param {import("./database.mjs").Transaction} tx @param {Goal} goal @param {string} actor */
export function goalMember(tx, goal, actor) {
	text(actor, "actor");
	return goal.owner === actor || tx.db.prepare(`SELECT id FROM tasks WHERE goal_id=? AND owner=?
		UNION SELECT id FROM units WHERE goal_id=? AND owner=?
		UNION SELECT t.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=? AND a.native_id=? LIMIT 1`)
		.get(goal.id, actor, goal.id, actor, goal.id, actor) !== undefined;
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @param {string} actor */
export function requireReporter(tx, attempt, actor) {
	if (attempt.nativeId !== actor && attempt.creator !== actor) requireOwner(tx, tx.get("tasks", attempt.taskId), actor);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task */
export function uncancelled(tx, task) {
	if (task.state === "cancelled" || ancestors(tx, task).some((parent) => parent.state === "cancelled")) {
		throw new FoundryError("cancelled", "This task's subtree is cancelled");
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @returns {Task} */
export function current(tx, attempt) {
	const task = tx.get("tasks", attempt.taskId);
	uncancelled(tx, task);
	if (task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion) {
		throw new FoundryError("stale_attempt", "This attempt is no longer current");
	}
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {number} [generation] @param {boolean} [allowClosed] */
export function requireAdmission(tx, task, generation, allowClosed = false) {
	const completion = tx.optional("goal_completions", task.goalId);
	if (!completion) return undefined;
	const factory = tx.get("factory_controls", completion.factoryId);
	if (tx.get("tasks", completion.taskId).state === "cancelled") {
		throw new FoundryError("job_cancelled", "This bounded job is cancelled; settle its existing work without admitting new execution");
	}
	if (completion.closed && !allowClosed) throw new FoundryError("job_closed", "Accepted bounded jobs admit no new execution; reopen explicitly before starting or resuming work");
	const nativeId = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId).nativeId : undefined;
	if (factory.state !== "active" || factory.pausedWorkers.includes(task.owner)
		|| nativeId !== undefined && factory.pausedWorkers.includes(nativeId)) {
		throw new FoundryError("factory_paused", "Factory execution is paused; only an explicit user-requested restart can admit work");
	}
	if (generation !== undefined && generation !== factory.generation) {
		throw new FoundryError("stale_activation", "This prepared operation belongs to a revoked activation");
	}
	if (!task.dispatch) throw new FoundryError("assignment_snapshot_required", "Factory execution requires its admitted assignment snapshot; reset obsolete state rather than reconstructing policy at dispatch");
	return factory;
}

/** @param {import("./database.mjs").Transaction} tx @param {Goal} goal */
export function budgetAvailable(tx, goal) {
	return (goal.limits.credits === undefined || goal.credits < goal.limits.credits)
		&& (goal.limits.deadline === undefined || Date.parse(tx.timestamp()) < Date.parse(goal.limits.deadline));
}

export const MANAGED_TASKS = `WITH RECURSIVE managed(id,goal_id) AS (
	SELECT id,goal_id FROM tasks WHERE owner=? OR goal_id IN (SELECT id FROM goals WHERE owner=?)
	UNION SELECT t.id,t.goal_id FROM tasks t JOIN managed p ON t.parent_id=p.id AND t.goal_id=p.goal_id
)`;

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor */
export function ownsTask(tx, taskId, actor) {
	return authorized(tx, tx.get("tasks", taskId), actor);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} goalId @param {string} actor */
export function isNativeMember(tx, goalId, actor) {
	return goalMember(tx, tx.get("goals", goalId), actor);
}

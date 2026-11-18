import { preparedDispatch, releaseSlot } from "./attempts.mjs";
import { outstanding } from "./effects.mjs";
import { ancestors, below, budgetAvailable, goalMember, requireAdmission, requireGoalOwner, requireOwner, uncancelled } from "./policy.mjs";
import { decodeUnit } from "./records.mjs";
import { revise } from "./tasks.mjs";
import { FoundryError, natural, text } from "./values.mjs";
import { wake } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Unit} Unit */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./records.mjs").UnitInput} UnitInput */

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @returns {void} */
export function coordinationAdmission(tx, task) {
	uncancelled(tx, task);
	requireAdmission(tx, task);
	if (task.role !== "coordinator" || ["done", "failed", "cancelled"].includes(task.state)) {
		throw new FoundryError("coordinator_required", "An active coordinator task is required; a title or unit membership grants no authority");
	}
	if (!budgetAvailable(tx, tx.get("goals", task.goalId))) throw new FoundryError("limit_exhausted", "The coordinator goal's observed credits or deadline are exhausted");
}

/** @param {import("./database.mjs").Transaction} tx @param {Unit} unit @param {string} boundaryId @returns {boolean} */
export function unitBelow(tx, unit, boundaryId) {
	for (let current = unit; current.parentId;) {
		if (current.parentId === boundaryId) return true;
		current = tx.get("units", current.parentId);
	}
	return unit.id === boundaryId;
}

/** @param {import("./database.mjs").Transaction} tx @param {UnitInput} input @param {string} actor @returns {Unit} */
export function createUnit(tx, input, actor) {
	const goal = tx.get("goals", input.goalId);
	const boundary = input.taskId === undefined ? undefined : tx.get("tasks", input.taskId);
	if (boundary) {
		requireOwner(tx, boundary, actor);
		uncancelled(tx, boundary);
		requireAdmission(tx, boundary);
		if (boundary.role === "coordinator") coordinationAdmission(tx, boundary);
		if (boundary.goalId !== goal.id || !boundary.scope.delegation) throw new FoundryError("forbidden", "A unit needs an authorized delegating task in its goal");
	} else requireGoalOwner(tx, goal, actor);
	if (input.parentId) {
		const parent = tx.get("units", input.parentId);
		if (parent.goalId !== goal.id || parent.taskId && (!boundary || !below(tx, boundary, parent.taskId))) {
			throw new FoundryError("invalid_parent", "A sub-unit must stay inside its parent's goal and task boundary");
		}
	}
	const unit = decodeUnit({ ...input, id: tx.newId("units", input.id), owner: actor, context: input.context ?? [] });
	tx.put("units", unit);
	return unit;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} cause @returns {void} */
export function coordinationEvent(tx, task, cause) {
	if (!task.coordination || ["done", "failed", "cancelled"].includes(task.state)) return;
	task.coordination.generation++;
	task.coordination.causes = [...new Set([...task.coordination.causes, cause])];
	tx.put("tasks", task);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} cause @returns {void} */
export function notifyCoordination(tx, task, cause) {
	const coordinator = [task, ...ancestors(tx, task)].find(item => item.role === "coordinator");
	if (!coordinator) return;
	coordinationEvent(tx, coordinator, cause);
	wake(tx, coordinator.owner, coordinator.goalId, `coordination:${coordinator.id}`);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @returns {boolean} */
export function coordinatorsBound(tx, task) {
	return ancestors(tx, task).filter(parent => parent.role === "coordinator").every(parent => {
		const attempt = parent.currentAttemptId ? tx.get("attempts", parent.currentAttemptId) : undefined;
		return attempt?.nativeId !== undefined && attempt.taskVersion === parent.version && ["running", "waiting"].includes(attempt.state);
	});
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} root @param {string} previous @param {string} replacement @returns {void} */
export function transferOwnedDescendants(tx, root, previous, replacement) {
	for (const child of tx.list("tasks", "WHERE goal_id=? AND owner=?", [root.goalId, previous])) {
		if (child.id === root.id || !below(tx, child, root.id) || ["done", "cancelled"].includes(child.state)) continue;
		child.owner = replacement;
		if (child.currentAttemptId) {
			if (preparedDispatch(tx, child)) revise(tx, child, previous);
			else {
				const attempt = tx.get("attempts", child.currentAttemptId);
				attempt.assignedOwner = replacement;
				tx.put("attempts", attempt);
			}
		}
		tx.put("tasks", child);
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string[]} goalIds @param {number} [offset] */
export function unitDirectory(tx, actor, goalIds, offset = 0) {
	natural(offset, "unit directory offset");
	for (const goalId of goalIds) if (!goalMember(tx, tx.get("goals", goalId), actor)) throw new FoundryError("foreign_goal", "Unit discovery stays inside assigned goals");
	const units = tx.list("units", "WHERE goal_id IN (SELECT value FROM json_each(?))", [JSON.stringify(goalIds)])
		.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
	const coordinators = tx.list("tasks", "WHERE goal_id IN (SELECT value FROM json_each(?)) AND json_extract(document,'$.role')='coordinator' AND state<>'cancelled'",
		[JSON.stringify(goalIds)]);
	return { total: units.length, offset, ...(offset + 100 < units.length ? { nextOffset: offset + 100 } : {}),
		units: units.slice(offset, offset + 100).map(unit => {
			const coordinator = coordinators.find(task => task.unitId === unit.id);
			return { id: unit.id, goalId: unit.goalId, parentId: unit.parentId, name: unit.name, kind: unit.kind,
				...(coordinator ? { coordinatorTaskId: coordinator.id, coordinator: coordinator.owner, state: coordinator.state } : {}) };
		}) };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] */
export function coordinationViews(tx, actor, goalId) {
	return tx.list("tasks", `WHERE owner=? AND json_extract(document,'$.role')='coordinator' ${goalId === undefined ? "" : "AND goal_id=?"}`,
	goalId === undefined ? [actor] : [actor, goalId]).map(task => {
	const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	const completion = tx.optional("goal_completions", task.goalId);
	const factory = completion ? tx.get("factory_controls", completion.factoryId) : undefined;
	return { taskId: task.id, attemptId: attempt?.id, ...task.coordination,
		state: ["done", "cancelled", "failed"].includes(task.state) || completion?.closed ? "closed"
			: factory && (factory.state !== "active" || factory.pausedWorkers.includes(actor)) ? "paused"
				: !budgetAvailable(tx, tx.get("goals", task.goalId)) ? "limit-exhausted"
					: task.waiting?.kind === "input" ? "needs-input"
						: attempt && outstanding(tx, attempt, true) ? "settlement-blocked"
							: !attempt?.nativeId ? "awaiting-dispatch"
								: task.coordination && task.coordination.generation > task.coordination.handled ? "actionable"
									: task.coordination?.disposition?.reason ?? "waiting-for-events" };
});
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @returns {Task[]} */
export function parkCoordinators(tx, actor) {
	/** @type {Task[]} */
	const parked = [];
	for (const task of tx.list("tasks", "WHERE owner=? AND json_extract(document,'$.role')='coordinator' AND state IN ('running','waiting')", [actor])) {
		const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
		if (!attempt || attempt.nativeId !== actor || !task.coordination || task.waiting?.kind === "input" || outstanding(tx, attempt, true)) continue;
		if (attempt.slot) {
			task.state = "waiting";
			task.waiting = { kind: "events", reason: "Native coordination turn ended; retained work is not implicitly handled" };
			attempt.state = "waiting";
			attempt.waiting = task.waiting;
			tx.put("attempts", attempt);
			tx.put("tasks", task);
			releaseSlot(tx, attempt);
		}
		if (task.coordination.generation > task.coordination.handled && task.coordination.escalated !== task.coordination.generation) {
			task.coordination.escalated = task.coordination.generation;
			tx.put("tasks", task);
			const sponsor = task.parentId ? tx.get("tasks", task.parentId).owner : tx.get("goals", task.goalId).owner;
			wake(tx, sponsor, task.goalId, `coordination-stalled:${task.id}`);
		}
		parked.push(task);
	}
	return parked;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} unitId @param {string} newOwner @param {string} actor @returns {Unit} */
export function reassignUnit(tx, unitId, newOwner, actor) {
	const unit = tx.get("units", unitId);
	if (unit.taskId) requireOwner(tx, tx.get("tasks", unit.taskId), actor);
	else requireGoalOwner(tx, tx.get("goals", unit.goalId), actor);
	unit.owner = text(newOwner, "new unit coordinator");
	tx.put("units", unit);
	wake(tx, unit.owner, unit.goalId, `unit:${unit.id}`);
	return unit;
}

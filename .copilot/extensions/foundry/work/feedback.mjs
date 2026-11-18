import { randomUUID } from "node:crypto";
import { signalDiscovery } from "./backlog.mjs";
import { goalMember, requireGoalOwner } from "./policy.mjs";
import { decodeLesson, decodeSignal } from "./records.mjs";
import { FoundryError, digest, json, record } from "./values.mjs";
import { signalOwner, wake } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Signal} Signal */
/** @typedef {import("./model.d.ts").Lesson} Lesson */

/** @param {import("./database.mjs").Transaction} tx @param {Omit<Signal,"id"> & {id?: string}} input @param {string} actor @returns {Signal} */
export function recordSignal(tx, input, actor) {
	const goal = tx.get("goals", input.goalId);
	if (!goalMember(tx, goal, actor)) throw new FoundryError("forbidden", "Only actual goal members may record its non-governing signals");
	if (input.taskId) {
		const task = tx.get("tasks", input.taskId);
		if (task.goalId !== goal.id) throw new FoundryError("invalid_task", "Signal task must belong to its goal");
	}
	if (input.unitId && tx.get("units", input.unitId).goalId !== goal.id) throw new FoundryError("invalid_team", "Feedback unit must belong to the goal");
	const candidate = decodeSignal({ ...record(input), id: input.id ?? randomUUID() });
	const existing = input.id === undefined ? tx.list("signals", "WHERE goal_id=?", [goal.id]).find((signal) => {
		const { id: _left, ...left } = signal;
		const { id: _right, ...right } = candidate;
		return digest(json(left)) === digest(json(right));
	}) : tx.optional("signals", candidate.id);
	if (existing) {
		if (input.id !== undefined && digest(json(existing)) !== digest(json(candidate))) throw new FoundryError("signal_identity_conflict", "Signal identities are immutable");
		return existing;
	}
	tx.put("signals", candidate);
	signalDiscovery(tx, candidate);
	wake(tx, signalOwner(tx, candidate), goal.id, `signal:${candidate.id}`);
	return candidate;
}

/** @param {import("./database.mjs").Transaction} tx @param {Omit<Lesson,"id"> & {id?: string}} input @param {string} actor @returns {Lesson} */
export function recordLesson(tx, input, actor) {
	const goal = tx.get("goals", input.goalId);
	if (goal.owner !== actor && !tx.list("tasks", "WHERE goal_id=? AND owner=?", [goal.id, actor])
		.some((task) => task.scope.workTypes.includes("*") || task.scope.workTypes.includes(input.workType))) requireGoalOwner(tx, goal, actor);
	const candidate = decodeLesson({ ...record(input), id: input.id ?? randomUUID() });
	const existing = input.id === undefined ? tx.list("lessons", "WHERE goal_id=? AND json_extract(document,'$.workType')=?", [goal.id, candidate.workType]).find((lesson) => {
		const { id: _left, ...left } = lesson;
		const { id: _right, ...right } = candidate;
		return digest(json(left)) === digest(json(right));
	}) : tx.optional("lessons", candidate.id);
	if (existing) {
		if (input.id !== undefined && digest(json(existing)) !== digest(json(candidate))) throw new FoundryError("lesson_identity_conflict", "Lesson identities are immutable");
		return existing;
	}
	tx.put("lessons", candidate);
	return candidate;
}

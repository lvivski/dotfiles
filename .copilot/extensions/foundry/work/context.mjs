import { preparedDispatch, runnable } from "./attempts.mjs";
import { completionStatus } from "./jobs.mjs";
import { coordinatorsBound } from "./organization.mjs";
import { ancestors, assignedExecution, authorized, goalMember, MANAGED_TASKS, taskForCaller } from "./policy.mjs";
import { FoundryError, text } from "./values.mjs";

/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Lesson} Lesson */

/** @param {import("./database.mjs").Transaction} tx @param {string} [goalId] @param {boolean} [history] @returns {import("./model.d.ts").Snapshot} */
export function snapshot(tx, goalId, history = true) {
	if (goalId !== undefined) tx.get("goals", goalId);
	const parameters = goalId === undefined ? [] : [goalId];
	const goalWhere = goalId === undefined ? "" : "WHERE goal_id=?";
	const attemptWhere = goalId === undefined ? "" : "WHERE task_id IN (SELECT id FROM tasks WHERE goal_id=?)";
	const effectWhere = goalId === undefined ? "" : "WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=?)";
	const goals = tx.list("goals", goalId === undefined ? "" : "WHERE id=?", parameters);
	const tasks = tx.list("tasks", goalWhere, parameters);
	const attempts = tx.list("attempts", history ? attemptWhere
		: `WHERE id IN (SELECT json_extract(document,'$.currentAttemptId') FROM tasks ${goalWhere})`, parameters);
	return { goals, tasks, attempts,
		factories: tx.list("factory_controls").filter(factory => goalId === undefined
			|| tx.optional("goal_completions", goalId)?.factoryId === factory.id),
		completions: tx.list("goal_completions", goalWhere, parameters).map(completionStatus.bind(undefined, tx)),
		units: tx.list("units", goalWhere, parameters).map(unit => ({ ...unit,
			coordinatorTaskId: tasks.find(task => task.unitId === unit.id && task.role === "coordinator" && task.state !== "cancelled")?.id })),
		collaborations: tx.list("collaborations").filter(item => goalId === undefined || item.goalId === goalId || item.destinationGoalId === goalId),
		wakes: tx.list("wakes", goalWhere, parameters),
		effects: history ? tx.list("effects", effectWhere, parameters) : [],
		claims: history ? tx.list("claims", effectWhere, parameters) : [],
		signals: tx.list("signals", goalWhere, parameters),
		lessons: tx.list("lessons", goalWhere, parameters),
	};
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] @param {string} [taskId] */
export function contextSnapshot(tx, actor, goalId, taskId) {
	if (goalId !== undefined && !goalMember(tx, tx.get("goals", goalId), actor)) throw new FoundryError("foreign_goal", "This caller has no assignment in the requested goal");
	if (taskId !== undefined && goalId !== undefined && taskForCaller(tx, taskId, actor, true).goalId !== goalId) {
		throw new FoundryError("foreign_task", "The requested task belongs to another goal");
	}
	if (taskId !== undefined && goalId === undefined) taskForCaller(tx, taskId, actor, true);
	const ownWakes = tx.list("wakes", `WHERE owner=? AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')
		${goalId === undefined ? "" : "AND goal_id=?"}`, goalId === undefined ? [actor] : [actor, goalId]);
	const causes = ownWakes.flatMap(wake => wake.relatedReasons ?? [wake.reason]);
	const affected = JSON.stringify(causes.filter(reason => reason.startsWith("output:")).map(reason => reason.slice(7)));
	const visible = tx.db.prepare(`${MANAGED_TASKS}, pending(id) AS (
		SELECT DISTINCT a.task_id FROM attempts a JOIN tasks t ON t.id=a.task_id
		JOIN effects e ON (a.id=e.attempt_id OR a.id IN (SELECT value FROM json_each(e.document,'$.relatedAttemptIds')))
		WHERE e.kind='command' AND e.state IN ('issued','uncertain')
			AND (a.native_id=? OR a.task_id IN (SELECT id FROM managed))
			AND (?='' OR t.id=? OR t.parent_id=?)
	) SELECT t.id FROM tasks t WHERE (? IS NULL OR t.goal_id=?)
		AND (t.id IN pending OR t.id=? OR t.parent_id=?
			OR json_extract(t.document,'$.repairReservation.worker')=?
			OR (t.id IN (SELECT id FROM managed) AND (t.owner=? OR t.parent_id IN (SELECT id FROM tasks WHERE owner=?)
				OR t.parent_id IS NULL OR t.id IN (SELECT value FROM json_each(?)))))
		AND (t.state NOT IN ('done','cancelled') OR t.id=? OR t.id IN pending
			OR t.id IN (SELECT value FROM json_each(?)))`)
		.all(actor, actor, actor, taskId ?? "", taskId ?? "", taskId ?? "", goalId ?? null, goalId ?? null,
			taskId ?? "", taskId ?? "", actor, actor, actor, affected, taskId ?? "", affected);
	const tasks = tx.list("tasks", "WHERE id IN (SELECT value FROM json_each(?))",
		[JSON.stringify(visible.map(row => text(row.id, "visible task")))]);
	const ids = JSON.stringify(tasks.map(task => task.id));
	const effects = tx.list("effects", `WHERE kind='command' AND state IN ('issued','uncertain')
		AND (attempt_id IN (SELECT id FROM attempts WHERE task_id IN (SELECT value FROM json_each(?)))
			OR EXISTS (SELECT 1 FROM json_each(document,'$.relatedAttemptIds') related JOIN attempts a ON a.id=related.value
				WHERE a.task_id IN (SELECT value FROM json_each(?))))`, [ids, ids]);
	const goalIds = [...new Set([...tasks.map(task => task.goalId), ...ownWakes.map(wake => wake.goalId), ...(goalId ? [goalId] : [])])];
	const goals = tx.list("goals", "WHERE id IN (SELECT value FROM json_each(?))", [JSON.stringify(goalIds)]);
	const attempts = tx.list("attempts", `WHERE task_id IN (SELECT value FROM json_each(?))
		AND (id IN (SELECT json_extract(document,'$.currentAttemptId') FROM tasks WHERE id IN (SELECT value FROM json_each(?)))
			OR id IN (SELECT attempt_id FROM effects WHERE kind='command' AND state IN ('issued','uncertain'))
			OR id IN (SELECT value FROM effects,json_each(document,'$.relatedAttemptIds')
				WHERE kind='command' AND state IN ('issued','uncertain')))`, [ids, ids]);
	const goalJson = JSON.stringify(goalIds);
	const units = tx.list("units", "WHERE goal_id IN (SELECT value FROM json_each(?)) AND (owner=? OR id IN (SELECT json_extract(value,'$.unitId') FROM json_each(?)))",
		[goalJson, actor, JSON.stringify(tasks)]);
	const signals = tx.list("signals", `WHERE goal_id IN (SELECT value FROM json_each(?))
		AND (id IN (SELECT value FROM json_each(?)) OR id IN (
			SELECT id FROM signals WHERE goal_id IN (SELECT value FROM json_each(?))
			AND (task_id=? OR json_extract(document,'$.unitId') IN (SELECT value FROM json_each(?))
				OR (task_id IS NULL AND goal_id IN (SELECT id FROM goals WHERE owner=?)))
			ORDER BY rowid DESC LIMIT 20))`,
		[goalJson, JSON.stringify(causes.filter(reason => reason.startsWith("signal:")).map(reason => reason.slice(7))),
			goalJson, taskId ?? "", JSON.stringify(units.map(unit => unit.id)), actor]);
	const lessons = tx.list("lessons", `WHERE id IN (SELECT id FROM lessons WHERE goal_id IN (SELECT value FROM json_each(?))
		${taskId === undefined ? "" : "AND json_extract(document,'$.workType')=(SELECT json_extract(document,'$.workType') FROM tasks WHERE id=?)"}
		ORDER BY rowid DESC LIMIT 20)`, taskId === undefined ? [goalJson] : [goalJson, taskId]);
	const wakes = tx.list("wakes", `WHERE goal_id IN (SELECT value FROM json_each(?))
		AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')`, [goalJson]);
	const ready = tasks.filter(task => (task.repairReservation ? task.repairReservation.worker === actor : authorized(tx, task, actor))
		&& coordinatorsBound(tx, task) && (runnable(tx, task) || preparedDispatch(tx, task)));
	const collaborations = tx.list("collaborations").filter(item =>
		[ item.sourceTaskId, item.destinationTaskId, ...(item.producerTaskId ? [item.producerTaskId] : []) ]
			.some(id => authorized(tx, tx.get("tasks", id), actor) || assignedExecution(tx, tx.get("tasks", id), actor))
		&& (goalId === undefined || item.goalId === goalId || item.destinationGoalId === goalId));
	return { goals, tasks, attempts, units, collaborations, signals, lessons, wakes, effects, ready, claims: [] };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] @param {boolean} [dispatchOnly] @returns {Task[]} */
export function readyTasks(tx, actor, goalId, dispatchOnly = false) {
	text(actor, "actor");
	if (goalId !== undefined) tx.get("goals", goalId);
	return tx.list("tasks", `WHERE state IN ('ready','waiting','running') ${goalId === undefined ? "" : "AND goal_id=?"}`, goalId === undefined ? [] : [goalId]).filter((task) => (goalId === undefined || task.goalId === goalId)
		&& (task.repairReservation ? task.repairReservation.worker === actor : authorized(tx, task, actor))
		&& (!dispatchOnly || !task.repairReservation && task.state !== "waiting"
			&& (!tx.optional("goal_completions", task.goalId) && !ancestors(tx, task).some(parent => parent.role === "coordinator") || task.owner === actor))
		&& coordinatorsBound(tx, task) && (runnable(tx, task) || preparedDispatch(tx, task)));
}

/** @param {import("./database.mjs").Transaction} tx @param {string} goalId @param {string} workType @returns {Lesson[]} */
export function lessonsFor(tx, goalId, workType) {
	tx.get("goals", goalId);
	return tx.list("lessons", "WHERE goal_id=? AND json_extract(document,'$.workType')=?", [goalId, text(workType, "workType")]);
}

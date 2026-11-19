import { preparedDispatch, releaseSlot } from "./attempts.mjs";
import { recycleCapacity } from "./backlog.mjs";
import { archivedCreator, enqueueCancelledRetirements } from "./retirement.mjs";
import { syncConsumerVersions } from "./collaboration.mjs";
import { outstanding, retirePrepared, scheduleStop } from "./effects.mjs";
import { compileFactoryContext } from "./factory.mjs";
import { coordinationAdmission, createUnit, notifyCoordination, unitBelow } from "./organization.mjs";
import { ancestors, below, requireAdmission, requireGoalOwner, requireOwner, uncancelled } from "./policy.mjs";
import { decodeGoal, decodeTask } from "./records.mjs";
import { checkArtifactScope } from "./results.mjs";
import { FoundryError, decodeCheck, decodeInput, digest, json, narrowScope, natural, record, text } from "./values.mjs";
import { rerouteWakes, wake } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Goal} Goal */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./records.mjs").GoalInput} GoalInput */
/** @typedef {import("./records.mjs").TaskInput} TaskInput */
/** @typedef {import("./records.mjs").UnitInput} UnitInput */

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").Input} input @returns {import("./model.d.ts").Output|undefined} */
export function inputOutput(tx, input) {
	const producer = tx.get("tasks", input.taskId);
	if (producer.state === "cancelled" && input.version === undefined) return undefined;
	const current = producer.state === "done" ? producer.outputs.find(output => output.name === input.output
		&& (input.version === undefined || output.version === input.version)) : undefined;
	if (current || input.version === undefined) return current;
	const published = tx.list("results", `WHERE state='done'
		AND attempt_id IN (SELECT id FROM attempts WHERE task_id=?)
		AND id IN (SELECT result_id FROM outcomes WHERE promoted=1)`, [producer.id]);
	return published.flatMap(result => result.outputs).find(output => output.name === input.output && output.version === input.version);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @returns {import("./model.d.ts").PinnedInput[] | undefined} */
export function resolvedInputs(tx, task) {
	if (tx.list("collaborations", "WHERE json_extract(document,'$.consumerTaskId')=?", [task.id])
		.some(item => item.required && (item.state !== "fulfilled" || !item.bound))) return undefined;
	const resolved = [];
	for (const input of task.inputs) {
		const output = inputOutput(tx, input);
		if (!output) return undefined;
		resolved.push({ taskId: input.taskId, output: input.output, version: output.version });
	}
	return resolved;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} newOwner @param {string} actor @returns {Task} */
export function transfer(tx, task, newOwner, actor) {
	if (tx.get("goals", task.goalId).owner !== text(actor, "actor")
		&& !ancestors(tx, task).some(parent => parent.owner === actor)) {
		throw new FoundryError("forbidden", "Only an accountable owner or ancestor may transfer this subtree");
	}
	requireOwner(tx, task, actor);
	uncancelled(tx, task);
	const previousOwner = task.owner;
	task.owner = text(newOwner, "newOwner");
	if (task.repairReservation && task.owner !== previousOwner) delete task.repairReservation;
	if (task.currentAttemptId && task.owner !== previousOwner) {
		const attempt = tx.get("attempts", task.currentAttemptId);
		if (preparedDispatch(tx, task)) revise(tx, task, actor);
		else { attempt.assignedOwner = task.owner; tx.put("attempts", attempt); }
	}
	tx.put("tasks", task);
	wake(tx, task.owner, task.goalId, `reassignment:${task.id}`);
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} root @param {string} actor @returns {string[]} */
export function reviseDependents(tx, root, actor) {
	const affected = [root];
	const seen = new Set([root.id]);
	for (const producer of affected) {
		if (!producer.outputs.length) continue;
		for (const row of tx.db.prepare("SELECT DISTINCT task_id FROM dependencies WHERE producer_id=? AND version IS NULL").all(producer.id)) {
			const consumer = tx.get("tasks", text(row.task_id, "consumer"));
			if (!seen.has(consumer.id) && consumer.state !== "cancelled") { seen.add(consumer.id); affected.push(consumer); }
		}
	}
	for (const task of affected) revise(tx, task, actor);
	return affected.map(task => task.id);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {import("./model.d.ts").Input[]} inputs @param {string} actor @returns {void} */
export function replaceInputs(tx, task, inputs, actor) {
	requireAdmission(tx, task);
	const completion = tx.optional("goal_completions", task.goalId);
	if (completion?.taskId === task.id && completion.requiredInputs.some(required => !inputs.some(input => digest(json(input)) === digest(json(required))))) {
		throw new FoundryError("protected_input", "Collaboration cannot remove an accepted completion requirement");
	}
	for (const input of inputs) {
		const cycle = tx.db.prepare(`WITH RECURSIVE upstream(id) AS (
			SELECT ? UNION SELECT producer_id FROM dependencies JOIN upstream ON task_id=upstream.id
		) SELECT id FROM upstream WHERE id=? LIMIT 1`).get(input.taskId, task.id);
		if (cycle) throw new FoundryError("dependency_cycle", "Collaboration dependencies must remain acyclic");
	}
	if (digest(json(inputs)) === digest(json(task.inputs))) return;
	task.inputs = inputs;
	tx.db.prepare("DELETE FROM dependencies WHERE task_id=?").run(task.id);
	for (const input of inputs) tx.db.prepare("INSERT INTO dependencies(task_id,producer_id,output,version) VALUES(?,?,?,?)")
		.run(task.id, input.taskId, input.output, input.version ?? null);
	const previous = task.version;
	reviseDependents(tx, task, actor);
	syncConsumerVersions(tx, tx.get("tasks", task.id), previous);
}

/** @param {import("./database.mjs").Transaction} tx @param {GoalInput} input @param {string} actor @returns {Goal} */
export function createGoal(tx, input, actor) {
	text(actor, "actor");
	if (tx.list("tasks", "WHERE owner=?", [actor]).some((task) => tx.get("goals", task.goalId).owner !== actor)
		|| tx.list("attempts", "WHERE native_id=?", [actor]).some((attempt) => tx.get("goals", tx.get("tasks", attempt.taskId).goalId).owner !== actor)) {
		throw new FoundryError("forbidden", "Delegated workers cannot create root goals");
	}
	return insertGoal(tx, input, actor);
}

/** Call only after ordinary root authorization or charter-bound item admission.
 * @param {import("./database.mjs").Transaction} tx @param {GoalInput} input @param {string} actor @returns {Goal} */
export function insertGoal(tx, input, actor) {
	const goal = decodeGoal({ ...record(input), id: tx.newId("goals", input.id), owner: actor,
		limits: input.limits ?? {}, credits: 0, createdAt: tx.timestamp() });
	tx.put("goals", goal);
	return goal;
}

/** @param {import("./database.mjs").Transaction} tx @param {TaskInput} input @param {string} actor @param {boolean} [planned] @returns {Task} */
export function createTask(tx, input, actor, planned = false) {
	const goal = tx.get("goals", input.goalId);
	if (!planned && (tx.list("backlog_items", "WHERE goal_id=?", [goal.id]).length || tx.list("squads", "WHERE goal_id=?", [goal.id]).length)) {
		throw new FoundryError("item_required", "Declare independent outputs on the milestone observation, not as children of a subscription");
	}
	const completion = tx.optional("goal_completions", goal.id);
	if (completion) {
		requireAdmission(tx, tx.get("tasks", completion.taskId));
		if (completion.closed) throw new FoundryError("job_closed", "Reopen this bounded job explicitly before admitting new required work");
	}
	const parent = input.parentId === undefined ? undefined : tx.get("tasks", input.parentId);
	if (parent) {
		requireOwner(tx, parent, actor);
		uncancelled(tx, parent);
		if (parent.goalId !== goal.id) throw new FoundryError("invalid_parent", "Parent must belong to the task's goal");
		if (!parent.scope.delegation) throw new FoundryError("delegation_forbidden", "This parent cannot delegate");
		if (parent.role === "coordinator") coordinationAdmission(tx, parent);
	} else requireGoalOwner(tx, goal, actor);
	if (input.unitId !== undefined && tx.get("units", input.unitId).goalId !== goal.id) {
		throw new FoundryError("invalid_team", "Unit must belong to the task's goal");
	}
	const task = decodeTask({ ...record(input), id: tx.newId("tasks", input.id), owner: actor, createdAt: tx.timestamp(),
		scope: narrowScope(parent?.scope ?? goal.scope, input.scope), checks: input.checks ?? [],
		inputs: input.inputs ?? [], outputs: [], state: "ready", version: 1, currentAttemptId: undefined, waiting: undefined,
		...(input.role === "coordinator" ? { coordination: { generation: 1, handled: 0, causes: ["admission"] } } : {}) });
	if (task.role === "coordinator" && (!task.scope.delegation || task.checks.length || task.inputs.length)) {
		throw new FoundryError("invalid_coordinator", "A coordinator delegates scoped producer work; put executable checks and product prerequisites on its producer children");
	}
	if (task.unitId) {
		const unit = tx.get("units", task.unitId);
		if (unit.taskId && !below(tx, task, unit.taskId)) throw new FoundryError("forbidden", "Unit membership cannot escape its canonical task boundary");
		if (task.role === "coordinator") {
			if (tx.list("tasks", "WHERE json_extract(document,'$.unitId')=? AND json_extract(document,'$.role')='coordinator' AND state<>'cancelled'", [unit.id]).length) {
				throw new FoundryError("coordinator_conflict", "This unit already has a coordinator task in this goal");
			}
			for (const other of tx.list("tasks", "WHERE goal_id=? AND json_extract(document,'$.role')='coordinator'", [goal.id])) {
				const otherUnit = other.unitId ? tx.get("units", other.unitId) : undefined;
				if (otherUnit && other.state !== "cancelled" && (unitBelow(tx, unit, otherUnit.id) && !below(tx, task, other.id)
					|| unitBelow(tx, otherUnit, unit.id) && !below(tx, other, task.id))) {
					throw new FoundryError("invalid_parent", "Nested coordinator units must retain compatible task ancestry");
				}
			}
		}
	}
	if (completion && !task.dispatch) {
		const factory = tx.get("factory_controls", completion.factoryId);
		task.dispatch = compileFactoryContext(factory.definition, factory.source);
	}
	if (completion && task.scope.mode !== goal.scope.mode) {
		throw new FoundryError("continuation_conflict", "Factory tasks must retain their one accepted continuation mode; ordinary goals still support mode narrowing");
	}
	if (!task.scope.workTypes.includes("*") && !task.scope.workTypes.includes(task.workType)) {
		throw new FoundryError("work_type_forbidden", "Task work type is outside its scope");
	}
	if (new Set(task.checks.map((check) => check.id)).size !== task.checks.length) {
		throw new FoundryError("duplicate_check", "Check identities must be unique");
	}
	checkArtifactScope(tx, task.checks, task.scope);
	for (const input of task.inputs) {
		if (input.taskId === task.id) throw new FoundryError("dependency_cycle", "A task cannot consume itself");
		tx.get("tasks", input.taskId);
		const cycle = tx.db.prepare(`WITH RECURSIVE upstream(id) AS (
			SELECT producer_id FROM dependencies WHERE task_id=?
			UNION SELECT d.producer_id FROM dependencies d JOIN upstream u ON d.task_id=u.id
		) SELECT id FROM upstream WHERE id=? LIMIT 1`).get(input.taskId, task.id);
		if (cycle) throw new FoundryError("dependency_cycle", "Artifact dependencies must be acyclic");
	}
	tx.put("tasks", task);
	for (const input of task.inputs) tx.db.prepare("INSERT INTO dependencies(task_id,producer_id,output,version) VALUES(?,?,?,?)")
		.run(task.id, input.taskId, input.output, input.version ?? null);
	if (parent) notifyCoordination(tx, parent, `admission:${task.id}:${task.version}`);
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @param {string} actor @param {boolean} [notify] @returns {void} */
export function revise(tx, task, actor, notify = true) {
	task.owner = archivedCreator(tx, task.owner) ?? task.owner;
	if (task.currentAttemptId) {
		const attempt = tx.get("attempts", task.currentAttemptId);
		if (task.waiting?.kind === "input") attempt.waiting = task.waiting;
		if (!["done", "failed", "cancelled"].includes(attempt.state) || outstanding(tx, attempt, true)) {
			attempt.state = "cancelled";
			attempt.endedBy = actor;
			tx.put("attempts", attempt);
			retirePrepared(tx, attempt, "superseded");
			scheduleStop(tx, attempt, actor, "superseded");
		}
		releaseSlot(tx, attempt);
	}
	task.version++;
	task.state = "ready";
	task.outputs = [];
	delete task.waiting;
	delete task.repairReservation;
	tx.put("tasks", task);
	if (notify) wake(tx, task.owner, task.goalId, `revision:${task.id}`);
}

/** @param {import("./database.mjs").Transaction} tx @param {GoalInput} input @param {Array<Omit<TaskInput, "goalId">>} tasks @param {string} actor @param {Array<Omit<UnitInput,"goalId">>} [units] @returns {{goal:Goal,tasks:Task[]}} */
export function createGoalWithTasks(tx, input, tasks, actor, units = []) {
	const goal = createGoal(tx, input, actor);
	for (const unit of units) createUnit(tx, { ...unit, goalId: goal.id }, actor);
	return { goal, tasks: tasks.map(task => createTask(tx, { ...task, goalId: goal.id }, actor)) };
}

/** @param {import("./database.mjs").Transaction} tx @param {import("./model.d.ts").Input} input @returns {import("./model.d.ts").Output|undefined} */
export function outputForInput(tx, input) {
	return inputOutput(tx, decodeInput(input));
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor @returns {Task[]} */
export function cancelTask(tx, taskId, actor) {
	const root = tx.get("tasks", taskId);
	requireOwner(tx, root, actor);
	const rows = tx.db.prepare(`WITH RECURSIVE subtree(id) AS (
		SELECT id FROM tasks WHERE id=? UNION SELECT t.id FROM tasks t JOIN subtree s ON t.parent_id=s.id
	) SELECT id FROM subtree`).all(taskId);
	const tasks = rows.map((row) => tx.get("tasks", text(row.id, "task.id")));
	for (const task of tasks) {
		const waiting = task.waiting;
		task.state = "cancelled";
		task.outputs = [];
		delete task.waiting;
		delete task.repairReservation;
		tx.put("tasks", task);
		// Superseded executions can still have known effects or live native workers.
		for (const attempt of tx.list("attempts", "WHERE task_id=?", [task.id])) {
			if (["done", "failed", "cancelled"].includes(attempt.state) && !outstanding(tx, attempt, true)) continue;
			if (attempt.id === task.currentAttemptId && waiting?.kind === "input") attempt.waiting = waiting;
			attempt.state = "cancelled";
			attempt.endedBy = actor;
			tx.put("attempts", attempt);
			retirePrepared(tx, attempt, "cancelled");
			scheduleStop(tx, attempt, actor);
			releaseSlot(tx, attempt);
		}
		enqueueCancelledRetirements(tx, task);
	}
	recycleCapacity(tx, root.goalId);
	return tasks;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} newOwner @param {string} actor @returns {Task} */
export function reassignTask(tx, taskId, newOwner, actor) {
	const existing = tx.get("tasks", taskId);
	if (existing.role === "coordinator" && existing.currentAttemptId && tx.get("attempts", existing.currentAttemptId).nativeId
		&& !tx.get("attempts", existing.currentAttemptId).supersededBy) {
		throw new FoundryError("execution_handoff_required", "Supersede the settled coordinator execution before changing its accountable binding");
	}
	const task = transfer(tx, tx.get("tasks", taskId), newOwner, actor);
	rerouteWakes(tx, task.goalId);
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {{taskId:string,expectedVersion:number,checks?:import("./model.d.ts").Check[],inputs?:import("./model.d.ts").Input[]}} input @param {string} actor @returns {{task:Task,affected:string[]}} */
export function evolveTask(tx, input, actor) {
	const task = tx.get("tasks", input.taskId);
	requireOwner(tx, task, actor);
	uncancelled(tx, task);
	if (task.version !== natural(input.expectedVersion, "expected task version")) throw new FoundryError("stale_task", "Only this task's current definition may evolve");
	const checks = input.checks === undefined ? task.checks : input.checks.map(decodeCheck);
	if (new Set(checks.map(check => check.id)).size !== checks.length) throw new FoundryError("duplicate_check", "Check identities must be unique");
	checkArtifactScope(tx, checks, task.scope);
	for (const check of task.checks.filter(check => check.origin !== "derived")) {
		const replacement = checks.find(item => item.id === check.id);
		if (!replacement || digest(json(replacement)) !== digest(json(check))) {
			throw new FoundryError("protected_check", "User, contract and standing obligations cannot be relaxed or relabeled through derived evolution");
		}
	}
	if (checks.some(check => ["user", "contract"].includes(check.origin) && !task.checks.some(previous => previous.id === check.id))) {
		throw new FoundryError("protected_check", "Internal evolution cannot invent a new user or accepted-contract obligation");
	}
	const inputs = input.inputs === undefined ? task.inputs : input.inputs.map(decodeInput);
	if (task.role === "coordinator" && (checks.length || inputs.length)) {
		throw new FoundryError("invalid_coordinator", "Put product checks and prerequisites on producer children, not the coordinator role");
	}
	const completion = tx.optional("goal_completions", task.goalId);
	if (completion) {
		requireAdmission(tx, task);
		if (completion.closed) throw new FoundryError("job_closed", "Explicitly reopen the job before changing a required definition");
		if (task.id === completion.taskId && completion.requiredInputs.some(required =>
			!inputs.some(input => digest(json(input)) === digest(json(required))))) {
			throw new FoundryError("protected_input", "Accepted completion requirements cannot be removed through derived evolution");
		}
		for (const input of inputs) if (tx.get("tasks", input.taskId).goalId === task.goalId && input.version !== undefined) {
			throw new FoundryError("pinned_required_producer", "Factory required production must float");
		}
	}
	if (digest(json({ checks, inputs })) === digest(json({ checks: task.checks, inputs: task.inputs }))) return { task, affected: [] };
	for (const input of inputs) {
		tx.get("tasks", input.taskId);
		const cycle = tx.db.prepare(`WITH RECURSIVE upstream(id) AS (
			SELECT ? UNION SELECT producer_id FROM dependencies JOIN upstream ON task_id=upstream.id
		) SELECT id FROM upstream WHERE id=? LIMIT 1`).get(input.taskId, task.id);
		if (cycle) throw new FoundryError("dependency_cycle", "Artifact dependencies must remain acyclic");
	}
	task.checks = checks;
	task.inputs = inputs;
	tx.db.prepare("DELETE FROM dependencies WHERE task_id=?").run(task.id);
	for (const input of inputs) tx.db.prepare("INSERT INTO dependencies(task_id,producer_id,output,version) VALUES(?,?,?,?)")
		.run(task.id, input.taskId, input.output, input.version ?? null);
	const affected = reviseDependents(tx, task, actor);
	return { task: tx.get("tasks", task.id), affected };
}

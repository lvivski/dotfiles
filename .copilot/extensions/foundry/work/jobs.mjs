import { randomUUID } from "node:crypto";
import { hasSlot, parkPausedExecution, preparedDispatch, runnable } from "./attempts.mjs";
import { outstanding, retirePrepared } from "./effects.mjs";
import { factorySettings } from "./factory.mjs";
import { coordinatorsBound, createUnit } from "./organization.mjs";
import { budgetAvailable, goalMember, requireAdmission } from "./policy.mjs";
import { decodeAttempt, decodeCompletion, decodeFactory } from "./records.mjs";
import { admittedEvidence } from "./results.mjs";
import { createGoal, createTask, resolvedInputs, revise } from "./tasks.mjs";
import { FoundryError, decodeLimits, decodeScope, digest, json, narrowScope, positive, record, text } from "./values.mjs";
import { wake } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").FactoryControl} Factory */
/** @typedef {import("./model.d.ts").GoalCompletion} Completion */
/** @typedef {import("./records.mjs").GoalInput} GoalInput */
/** @typedef {import("./records.mjs").TaskInput} TaskInput */
/** @typedef {import("./records.mjs").UnitInput} UnitInput */

/** @param {import("./database.mjs").Transaction} tx @param {Completion} completion */
export function productionClosure(tx, completion) {
	const commitments = tx.list("collaborations").filter(item => item.required);
	const tasks = [...new Set([completion.taskId,
		...commitments.filter(item => item.goalId === completion.goalId).map(item => item.consumerTaskId),
		...commitments.filter(item => item.destinationGoalId === completion.goalId && item.producerTaskId)
			.map(item => text(item.producerTaskId, "committed producer")),
	])].map(id => tx.get("tasks", id));
	const seen = new Set(tasks.map(task => task.id));
	for (const task of tasks) for (const input of task.inputs) {
		const producer = tx.get("tasks", input.taskId);
		if (producer.goalId !== completion.goalId) continue;
		if (input.version !== undefined) throw new FoundryError("pinned_required_producer", "Mutable in-job required production must float; historical pins are not current-job acceptance");
		if (!seen.has(producer.id)) { seen.add(producer.id); tasks.push(producer); }
	}
	return tasks;
}

/** @param {import("./database.mjs").Transaction} tx @param {Completion} completion */
export function completionStatus(tx, completion) {
	const accepted = completion.accepted;
	const delivered = completion.closed && accepted?.revision === completion.revision
		&& accepted.tasks.every(item => {
			const task = tx.get("tasks", item.id);
			return task.state === "done" && task.version === item.version
				&& digest(json(resolvedInputs(tx, task) ?? null)) === digest(json(item.inputs));
		});
	const attempts = tx.list("attempts", "WHERE task_id IN (SELECT id FROM tasks WHERE goal_id=?)", [completion.goalId]);
	const settled = attempts.every(attempt => !attempt.slot && attempt.waiting?.kind !== "input" && !outstanding(tx, attempt, true))
		&& !tx.list("claims", "WHERE attempt_id IN (SELECT a.id FROM attempts a JOIN tasks t ON a.task_id=t.id WHERE t.goal_id=?)", [completion.goalId]).length;
	const cancelled = tx.get("tasks", completion.taskId).state === "cancelled"
		&& tx.list("tasks", "WHERE goal_id=?", [completion.goalId]).every(task => ["done", "failed", "cancelled"].includes(task.state));
	return { goalId: completion.goalId, factoryId: completion.factoryId, taskId: completion.taskId, delivered: Boolean(delivered), settled, cancelled,
		closed: completion.closed, revision: completion.revision };
}

/** @param {import("./database.mjs").Transaction} tx @param {GoalInput} input @param {Array<Omit<TaskInput,"goalId">>} tasks @param {string} factoryId @param {string} completionTaskId @param {string} actor @param {number} [generation] @param {boolean} [validation] @param {Array<Omit<UnitInput,"goalId">>} [units] */
export function admitFactoryJob(tx, input, tasks, factoryId, completionTaskId, actor, generation, validation = false, units = []) {
	const factory = tx.get("factory_controls", factoryId);
	if (factory.owner !== actor || factory.state !== "active") throw new FoundryError("factory_paused", "Only the active factory's actual coordinator can admit source work");
	if (generation !== undefined && factory.generation !== generation) throw new FoundryError("stale_activation", "Source observation belongs to a revoked activation");
	const accepted = record(record(factory.definition).goal);
	const scope = narrowScope(decodeScope(accepted.scope), input.scope);
	if (scope.mode !== record(accepted.scope).mode || input.projectId !== accepted.projectId
		|| digest(json(input.limits ?? {})) !== digest(json(decodeLimits(accepted.limits ?? {})))) {
		throw new FoundryError("factory_policy_mismatch", "Job mode, project and per-job limits must retain their accepted factory policy");
	}
	const existing = input.id === undefined ? undefined : tx.optional("goals", input.id);
	if (existing) {
		const completion = tx.get("goal_completions", existing.id);
		if (completion.factoryId !== factoryId || digest(json(existing.source ?? null)) !== digest(json(input.source ?? null))) {
			throw new FoundryError("source_conflict", "A source event identity cannot change its accepted definition");
		}
		return { goal: existing, tasks: tx.list("tasks", "WHERE goal_id=?", [existing.id]), replay: true };
	}
	const unsettled = tx.list("goal_completions", "WHERE json_extract(document,'$.factoryId')=?", [factoryId])
		.filter(completion => { const status = completionStatus(tx, completion); return !(status.delivered || status.cancelled) || !status.settled; });
	if (!validation && unsettled.length >= factory.maximumJobs) throw new FoundryError("factory_capacity", "The factory's effective active-job bound is exhausted");
	const goal = createGoal(tx, { ...input, scope }, actor);
	for (const unit of units) createUnit(tx, { ...unit, goalId: goal.id }, actor);
	const admitted = tasks.map(task => createTask(tx, { ...task, goalId: goal.id }, actor));
	const final = tx.get("tasks", completionTaskId);
	if (final.goalId !== goal.id || !final.checks.length) throw new FoundryError("unattended_acceptance", "Factory completion requires its own executable acceptance checks");
	if (admitted.some(task => task.scope.mode !== goal.scope.mode)) {
		throw new FoundryError("continuation_conflict", "Factory tasks must retain one accepted continuation mode");
	}
	const completion = decodeCompletion({ id: goal.id, goalId: goal.id, owner: actor, taskId: final.id,
		factoryId, revision: 1, closed: false, requiredInputs: final.inputs, repairs: 0 });
	productionClosure(tx, completion);
	tx.put("goal_completions", completion);
	return { goal, tasks: admitted, replay: false };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} id @param {string} actor */
export function factory(tx, id, actor) {
	const factory = tx.get("factory_controls", id);
	if (factory.owner !== actor) throw new FoundryError("forbidden", "Only the actual factory owner can manage its policy");
	return factory;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor */
export function factoryViews(tx, actor) {
	return tx.list("factory_controls", "WHERE owner=?", [actor]).map(factory => ({
	id: factory.id, state: factory.state, generation: factory.generation, source: factory.source,
	settings: factorySettings(factory),
	reason: factory.reason, heartbeat: factory.heartbeat === undefined ? undefined : {
		state: factory.heartbeat.state, id: factory.heartbeat.id, minutes: factory.heartbeat.request.every_minutes,
	},
}));
}

/** @param {import("./database.mjs").Transaction} tx @param {Omit<Factory,"owner"|"state"|"generation"|"pausedWorkers"|"reminders">} input @param {string} actor @param {{goal:GoalInput,tasks:Array<Omit<TaskInput,"goalId">>,units?:Array<Omit<UnitInput,"goalId">>,completionTaskId:string}} initial */
export function activateFactory(tx, input, actor, initial) {
	const existing = tx.optional("factory_controls", input.id);
	if (existing && (existing.owner !== actor || digest(existing.definition) !== digest(input.definition)
		|| digest(json(existing.source)) !== digest(json(input.source)))) {
		throw new FoundryError("factory_conflict", "Factory identity cannot change its native owner or accepted policy snapshot");
	}
	const factory = decodeFactory({ ...input, owner: actor, state: "active",
		generation: (existing?.generation ?? 0) + 1, pausedWorkers: [], reminders: {},
		...(existing?.heartbeat === undefined ? {} : { heartbeat: existing.heartbeat }),
		...(existing?.sourceCursor === undefined ? {} : { sourceCursor: existing.sourceCursor }) });
	tx.put("factory_controls", factory);
	for (const completion of tx.list("goal_completions", "WHERE json_extract(document,'$.factoryId')=?", [factory.id])) {
		for (const task of tx.list("tasks", "WHERE goal_id=? AND state='blocked'", [completion.goalId])) {
			if (!task.currentAttemptId || task.waiting?.kind !== "factory") continue;
			const attempt = tx.get("attempts", task.currentAttemptId);
			if (attempt.state !== "waiting" || outstanding(tx, attempt, true)) continue;
			task.state = "waiting";
			tx.put("tasks", task);
			wake(tx, attempt.nativeId ?? task.owner, task.goalId, "capacity");
		}
	}
	if (record(factory.definition).source !== undefined) {
		tx.db.exec("SAVEPOINT factory_template");
		try { admitFactoryJob(tx, initial.goal, initial.tasks, factory.id, initial.completionTaskId, actor, factory.generation, true, initial.units); }
		finally { tx.db.exec("ROLLBACK TO factory_template; RELEASE factory_template"); }
		return { factory, tasks: [], replay: false };
	}
	return { factory, ...admitFactoryJob(tx, initial.goal, initial.tasks, factory.id, initial.completionTaskId, actor, factory.generation, false, initial.units) };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} reason @param {string} [factoryId] */
export function pauseFactories(tx, actor, reason, factoryId) {
	const completions = tx.list("goal_completions", factoryId === undefined ? "" : "WHERE json_extract(document,'$.factoryId')=?", factoryId === undefined ? [] : [factoryId]);
	const changed = new Map();
	for (const factory of tx.list("factory_controls", "WHERE owner=?", [actor])) {
		if (factoryId !== undefined && factory.id !== factoryId) continue;
		factory.state = "paused";
		factory.generation++;
		factory.reason = text(reason, "pause reason");
		tx.put("factory_controls", factory);
		changed.set(factory.id, factory);
	}
	for (const completion of completions) {
		const factory = tx.get("factory_controls", completion.factoryId);
		if (factory.owner !== actor && !tx.list("attempts", "WHERE native_id=? AND task_id IN (SELECT id FROM tasks WHERE goal_id=?)", [actor, completion.goalId]).length) continue;
		if (factory.owner !== actor) factory.pausedWorkers = [...new Set([...factory.pausedWorkers, actor])];
		factory.reason = text(reason, "pause reason");
		tx.put("factory_controls", factory);
		changed.set(factory.id, factory);
		for (const task of tx.list("tasks", "WHERE goal_id=?", [completion.goalId])) {
			if (!task.currentAttemptId) continue;
			const attempt = tx.get("attempts", task.currentAttemptId);
			if (factory.owner !== actor && attempt.nativeId !== actor) continue;
			if (attempt.state === "prepared") revise(tx, task, actor);
			else retirePrepared(tx, attempt, "factory paused");
			if (attempt.nativeId === actor) parkPausedExecution(tx, attempt);
		}
	}
	if (factoryId !== undefined && !changed.size) throw new FoundryError("forbidden", "This caller cannot pause that factory");
	return [...changed.values()];
}

/** @param {import("./database.mjs").Transaction} tx @param {string} goalId @param {string} actor */
export function reopenCompletion(tx, goalId, actor) {
	const completion = tx.get("goal_completions", goalId);
	const factory = tx.get("factory_controls", completion.factoryId);
	if (factory.owner !== actor) throw new FoundryError("forbidden", "Only the factory owner can reopen its bounded job");
	const task = tx.get("tasks", completion.taskId);
	requireAdmission(tx, task, undefined, true);
	if (completion.closed) {
		completion.closed = false;
		completion.revision++;
		delete completion.accepted;
		tx.put("goal_completions", completion);
		revise(tx, task, actor);
	}
	for (const coordinator of tx.list("tasks", "WHERE goal_id=? AND json_extract(document,'$.role')='coordinator' AND state='done'", [goalId])) {
		const previous = coordinator.currentAttemptId ? tx.get("attempts", coordinator.currentAttemptId) : undefined;
		if (previous && (previous.waiting?.kind === "input" || outstanding(tx, previous, true)
			|| tx.list("claims", "WHERE attempt_id=?", [previous.id]).length)) continue;
		coordinator.version++;
		coordinator.state = previous?.nativeId ? "waiting" : "ready";
		coordinator.coordination = { generation: (coordinator.coordination?.generation ?? 0) + 1,
			handled: coordinator.coordination?.generation ?? 0, causes: ["job-reopened"] };
		if (previous?.nativeId) {
			const lease = decodeAttempt({ ...previous, id: randomUUID(), token: randomUUID(), taskVersion: coordinator.version,
				state: "waiting", slot: false, waiting: { kind: "events", reason: "Explicitly reopened coordination" },
				createdAt: tx.timestamp(), endedBy: undefined, supersededBy: undefined });
			tx.put("attempts", lease);
			if (tx.db.prepare("SELECT attempt_id FROM local_attempts WHERE attempt_id=?").get(previous.id)) {
				tx.db.prepare("INSERT INTO local_attempts(attempt_id) VALUES(?)").run(lease.id);
			}
			coordinator.currentAttemptId = lease.id;
			coordinator.waiting = lease.waiting;
		}
		tx.put("tasks", coordinator);
		wake(tx, coordinator.owner, goalId, `coordination:${coordinator.id}`);
	}
	return completion;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} factoryId @param {string} actor @param {number} generation @param {string|undefined} cursor */
export function updateSourceCursor(tx, factoryId, actor, generation, cursor) {
	const factory = tx.get("factory_controls", factoryId);
	if (factory.owner !== actor || factory.state !== "active" || factory.generation !== generation) {
		throw new FoundryError("stale_activation", "Do not move an intake cursor after its actual owner or activation changed");
	}
	if (cursor === undefined) delete factory.sourceCursor;
	else factory.sourceCursor = text(cursor, "native intake cursor");
	tx.put("factory_controls", factory);
	return factory;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] */
export function advance(tx, actor, goalId) {
	return tx.list("goal_completions", goalId === undefined ? "" : "WHERE goal_id=?", goalId === undefined ? [] : [goalId])
	.filter(completion => goalMember(tx, tx.get("goals", completion.goalId), actor)).map(completion => {
		const factory = tx.get("factory_controls", completion.factoryId);
		const status = completionStatus(tx, completion);
		const own = tx.list("tasks", "WHERE goal_id=?", [completion.goalId]).filter(task => task.owner === actor
			|| task.repairReservation?.worker === actor || task.currentAttemptId !== undefined && tx.get("attempts", task.currentAttemptId).nativeId === actor);
		const input = own.some(task => task.waiting?.kind === "input");
		const actions = own.filter(task => !factory.pausedWorkers.includes(task.owner)
			&& !factory.pausedWorkers.includes(actor)).flatMap(task => {
			if (task.role === "coordinator" && task.coordination && task.waiting?.kind !== "input"
				&& ["running", "waiting"].includes(task.state)) {
				return task.owner === actor && task.coordination.generation > task.coordination.handled
					&& budgetAvailable(tx, tx.get("goals", task.goalId)) ? [{ taskId: task.id, kind: "coordinate" }] : [];
			}
			if (task.state === "running" && task.currentAttemptId) {
				const attempt = tx.get("attempts", task.currentAttemptId);
				if (attempt.nativeId === actor && !outstanding(tx, attempt, true)) return [{ taskId: task.id, kind: "execute" }];
				if (preparedDispatch(tx, task)) return [{ taskId: task.id, kind: "dispatch" }];
			}
			if (!runnable(tx, task) || !coordinatorsBound(tx, task) || !hasSlot(tx, tx.get("goals", task.goalId)) || !budgetAvailable(tx, tx.get("goals", task.goalId))) return [];
			if (task.repairReservation) return task.repairReservation.worker === actor ? [{ taskId: task.id, kind: "repair" }] : [];
			if (task.state === "waiting") return task.currentAttemptId && tx.get("attempts", task.currentAttemptId).nativeId === actor
				? [{ taskId: task.id, kind: "resume" }] : [];
			return task.owner === actor ? [{ taskId: task.id, kind: "dispatch" }] : [];
		});
		return { ...status, generation: factory.generation, mechanism: factory.mechanism,
			disposition: factory.state === "paused" || factory.pausedWorkers.includes(actor) ? "paused"
				: status.cancelled ? "cancelled" : status.delivered ? "delivered" : actions.length ? "actionable" : input ? "needs-input" : "waiting",
			actions: factory.state === "active" ? actions : [] };
	});
}

/** @param {import("./database.mjs").Transaction} tx @param {string} factoryId @param {string} actor @param {number} generation @param {boolean} [reentry] */
export function remindFactory(tx, factoryId, actor, generation, reentry = false) {
	const factory = tx.get("factory_controls", factoryId);
	if (factory.state !== "active" || factory.generation !== generation || factory.pausedWorkers.includes(actor)
		|| factory.mechanism !== "stop-hook") return;
	const own = tx.list("tasks", `WHERE (owner=? OR json_extract(document,'$.currentAttemptId') IN (SELECT id FROM attempts WHERE native_id=?))
		AND goal_id IN (SELECT goal_id FROM goal_completions WHERE json_extract(document,'$.factoryId')=?)`, [actor, actor, factoryId])
		.filter(task => ["running", "ready", "waiting"].includes(task.state) && !(task.role === "coordinator" && task.waiting?.kind === "events"));
	if (!own.length || own.some(task => task.waiting?.kind === "input")) return;
	if (tx.list("wakes", "WHERE owner=? AND json_extract(document,'$.sent')>json_extract(document,'$.consumed')", [actor]).length) return;
	const marker = digest(json(own.map(task => ({ id: task.id, version: task.version, state: task.state,
		evidence: [...new Map((task.currentAttemptId ? admittedEvidence(tx, task.currentAttemptId) : []).map(item => [
			JSON.stringify([item.checkId, item.checkVersion]),
			{ checkId: item.checkId, checkVersion: item.checkVersion, outcome: item.outcome, candidate: item.candidate?.version ?? null },
		])).values()] }))));
	const previous = factory.reminders[actor];
	const count = previous?.generation === generation ? previous.count + 1 : 1;
	factory.reminders[actor] = { marker, count, generation };
	if (count > positive(factory.blocks, "stop-hook continuation blocks") || reentry && previous?.generation === generation && previous.marker === marker) {
		factory.pausedWorkers = [...new Set([...factory.pausedWorkers, actor])];
		factory.reason = "continuation_stalled";
		if (factory.owner === actor) { factory.state = "paused"; factory.generation++; }
		tx.put("factory_controls", factory);
		for (const task of own) {
			if (task.currentAttemptId) {
				const attempt = tx.get("attempts", task.currentAttemptId);
				if (attempt.nativeId === actor) parkPausedExecution(tx, attempt, "stalled");
			}
		}
		return { paused: true, reason: "continuation_stalled" };
	}
	tx.put("factory_controls", factory);
	return { decision: /** @type {const} */ ("block"), reason: `Foundry continuation ${factory.id}:${generation}. Read foundry_advance and execute only its current locally owned actions. This reminder grants no authority.` };
}

/** @param {import("./database.mjs").Transaction} tx @param {string} factoryId @param {Factory["heartbeat"]} heartbeat @param {string} actor @param {number} generation */
export function recordHeartbeat(tx, factoryId, heartbeat, actor, generation) {
	const factory = tx.get("factory_controls", factoryId);
	if (factory.owner !== actor || factory.generation !== generation) {
		throw new FoundryError("stale_activation", "Native heartbeat binding must retain its actual owner and current activation");
	}
	if (heartbeat?.state === "issued") {
		if (factory.state !== "active") throw new FoundryError("factory_paused", "Paused factories cannot issue a heartbeat");
		if (factory.heartbeat) throw new FoundryError("heartbeat_pending", "Reconcile the original native heartbeat instead of issuing another");
		if (tx.list("factory_controls", "WHERE owner=?", [actor]).some(other => other.id !== factoryId && other.heartbeat)) {
			throw new FoundryError("heartbeat_conflict", "One actual session can have only one owned factory heartbeat");
		}
	}
	if (heartbeat === undefined) delete factory.heartbeat;
	else factory.heartbeat = heartbeat;
	tx.put("factory_controls", factory);
	return factory;
}

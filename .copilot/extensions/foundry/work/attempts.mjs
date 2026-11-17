import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { releaseOwnedClaims } from "./claims.mjs";
import { effectsForAttempt, outstanding, retirePrepared, scheduleStop } from "./effects.mjs";
import { coordinatorsBound, transferOwnedDescendants } from "./organization.mjs";
import { ancestors, authorized, budgetAvailable, current, requireAdmission, requireOwner, requireReporter, uncancelled } from "./policy.mjs";
import { decodeAttempt } from "./records.mjs";
import { resolvedInputs, revise } from "./tasks.mjs";
import { settleUsage } from "./usage.mjs";
import { FoundryError, decodeEvidence, decodeWaiting, digest, json, latestEvidence, nativeSessionName, natural, record, text } from "./values.mjs";
import { notifyOutcome, rerouteWakes, wake, wakeCapacity } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Goal} Goal */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */

/** @param {import("./database.mjs").Transaction} tx */
export function executionBase(tx, directory = tx.cwd) {
	const result = spawnSync("git", ["-C", directory, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status === 1) return undefined;
	if (result.status !== 0) throw new FoundryError("baseline_unavailable", result.stderr || "The actual execution baseline could not be inspected");
	return text(result.stdout.trim(), "execution baseline");
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt */
export function observeExecutionBase(tx, attempt) {
	if (attempt.executionDirectory || effectsForAttempt(tx, attempt.id).some(effect => effect.kind === "command" && effect.state !== "prepared")) return;
	const base = executionBase(tx);
	if (attempt.startCommit && base !== attempt.startCommit) {
		throw new FoundryError("execution_base_mismatch", "The replacement execution must start from its recorded unchanged baseline");
	}
	attempt.baseCommit = base;
	attempt.executionDirectory = realpathSync(tx.cwd);
	tx.put("attempts", attempt);
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @param {"paused"|"stalled"} [cause] */
export function parkPausedExecution(tx, attempt, cause = "paused") {
	const task = tx.get("tasks", attempt.taskId);
	const completion = tx.optional("goal_completions", task.goalId);
	if (!completion || !attempt.nativeId || task.currentAttemptId !== attempt.id || task.version !== attempt.taskVersion
		|| task.state !== "running" || outstanding(tx, attempt, true)) return;
	const factory = tx.get("factory_controls", completion.factoryId);
	if (factory.state !== "paused" && !factory.pausedWorkers.includes(attempt.nativeId)) return;
	task.state = "blocked";
	task.waiting = { kind: "factory", cause, reason: cause === "paused" ? "factory_paused" : "continuation_stalled" };
	attempt.state = "waiting";
	attempt.waiting = task.waiting;
	tx.put("tasks", task);
	tx.put("attempts", attempt);
	releaseSlot(tx, attempt);
	notifyOutcome(tx, task);
}

/** @param {import("./database.mjs").Transaction} tx @param {Attempt} attempt @param {boolean} [notify] @param {boolean} [preserveClaims] */
export function releaseSlot(tx, attempt, notify = true, preserveClaims = false) {
	if (attempt.slot && !outstanding(tx, attempt, true)
		&& ["done", "failed", "cancelled", "waiting"].includes(attempt.state)) {
		attempt.slot = false;
		tx.put("attempts", attempt);
		if (notify) wakeCapacity(tx, tx.get("tasks", attempt.taskId).goalId);
	}
	if (!preserveClaims) releaseOwnedClaims(tx, attempt);
}

/** @param {import("./database.mjs").Transaction} tx @param {Goal} goal */
export function hasSlot(tx, goal) {
	if (goal.limits.workers === undefined) return true;
	const count = tx.db.prepare("SELECT count(*) AS n FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE t.goal_id=? AND a.slot=1").get(goal.id)?.n;
	return natural(count, "active slots") < goal.limits.workers;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task */
export function resumable(tx, task) {
	if (task.state !== "waiting" || !task.currentAttemptId || tx.get("attempts", task.currentAttemptId).slot) return false;
	if (task.waiting?.kind === "capacity" || task.waiting?.kind === "factory") return true;
	if (task.waiting?.kind === "events") return task.role === "coordinator";
	if (task.waiting?.kind !== "children") return false;
	if (task.inputs.length) return resolvedInputs(tx, task) !== undefined;
	const children = tx.list("tasks", "WHERE parent_id=?", [task.id]);
	return children.length > 0 && children.every((child) => ["done", "failed", "blocked", "cancelled"].includes(child.state));
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task */
export function runnable(tx, task) {
	return (task.state === "ready" || resumable(tx, task)) && !ancestors(tx, task).some((parent) => parent.state === "cancelled")
		&& resolvedInputs(tx, task) !== undefined;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task */
export function preparedDispatch(tx, task) {
	if (task.state !== "running" || !task.currentAttemptId) return false;
	const attempt = tx.get("attempts", task.currentAttemptId);
	return attempt.state === "prepared" && attempt.slot && attempt.nativeId === undefined
		&& !ancestors(tx, task).some((parent) => parent.state === "cancelled")
		&& !tx.list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'prepared'", [attempt.id]).length;
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @returns {FoundryError | undefined} */
export function allocate(tx, task) {
	requireAdmission(tx, task);
	const goal = tx.get("goals", task.goalId);
	if (!budgetAvailable(tx, goal)) throw new FoundryError("limit_exhausted", "The goal's observed credits or absolute deadline are exhausted");
	if (!hasSlot(tx, goal)) {
		wake(tx, task.repairReservation?.worker ?? task.owner, goal.id, "capacity");
		return new FoundryError("capacity_wait", `Goal ${goal.id} has no free worker slot; wait for its capacity wake`);
	}
	return undefined;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor @param {string} [localRepairOf] @returns {Attempt | FoundryError} */
export function prepareAttempt(tx, taskId, actor, localRepairOf) {
	const task = tx.get("tasks", taskId);
	if (task.repairReservation && (localRepairOf !== task.repairReservation.attemptId || actor !== task.repairReservation.worker)) {
		throw new FoundryError("repair_reserved", "This repair is reserved for its existing native worker");
	}
	if (localRepairOf === undefined) requireOwner(tx, task, actor);
	else {
		const previous = tx.get("attempts", localRepairOf);
		if (previous.nativeId !== actor || previous.state !== "failed" || task.currentAttemptId !== previous.id
			|| task.version !== previous.taskVersion + 1) throw new FoundryError("foreign_execution", "Repair must retain its exact failed worker and current task");
	}
	uncancelled(tx, task);
	if (!coordinatorsBound(tx, task)) throw new FoundryError("coordinator_pending", "Bind the accountable coordinator before staffing its recorded descendants");
	if (task.currentAttemptId && task.state === "running") {
		const existing = tx.get("attempts", task.currentAttemptId);
		if (existing.state === "prepared" && existing.slot) {
			const factory = requireAdmission(tx, task);
			const creation = effectsForAttempt(tx, existing.id).find(effect => effect.kind === "create");
			if (factory && creation && creation.factoryGeneration !== factory.generation && preparedDispatch(tx, task)) {
				revise(tx, task, actor);
			} else {
				requireAdmission(tx, task, creation?.factoryGeneration);
				return existing;
			}
		}
	}
	if (task.state !== "ready") throw new FoundryError("invalid_transition", "Only a ready task can start a new attempt");
	const inputs = resolvedInputs(tx, task);
	if (inputs === undefined) throw new FoundryError("inputs_unavailable", "Required named producer outputs and versions are not available");
	const denied = allocate(tx, task);
	if (denied) return denied;
	const previous = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	const startCommit = previous?.supersededBy ? previous.baseCommit
		: previous?.state === "cancelled" && !previous.nativeId ? previous.startCommit : undefined;
	const attempt = decodeAttempt({ id: randomUUID(), taskId, token: randomUUID(), creator: actor,
		state: "prepared", taskVersion: task.version, checks: task.checks, inputs, slot: true,
		createdAt: tx.timestamp(), ...(task.currentAttemptId && !tx.get("attempts", task.currentAttemptId).supersededBy ? { repairOf: task.currentAttemptId } : {}),
		...(startCommit ? { startCommit } : {}),
		...(localRepairOf !== undefined && task.owner !== actor ? { assignedOwner: task.owner } : {}) });
	task.currentAttemptId = attempt.id;
	task.state = "running";
	delete task.waiting;
	delete task.repairReservation;
	tx.put("attempts", attempt);
	tx.put("tasks", task);
	if (localRepairOf !== undefined) {
		for (const claim of tx.list("claims", "WHERE json_extract(document,'$.attemptId')=?", [localRepairOf])) {
			tx.db.prepare("DELETE FROM claims WHERE id=?").run(claim.id);
			tx.put("claims", { ...claim, id: randomUUID(), attemptId: attempt.id });
		}
	}
	return attempt;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} attemptId @param {string} nativeId @param {string} actor @param {Json} [receipt] @param {boolean} [local] @returns {Attempt} */
export function bindAttempt(tx, attemptId, nativeId, actor, receipt, local = false) {
	const attempt = tx.get("attempts", attemptId);
	const task = tx.get("tasks", attempt.taskId);
	requireReporter(tx, attempt, text(actor, "actor"));
	text(nativeId, "nativeId");
	const stale = task.currentAttemptId !== attemptId || task.version !== attempt.taskVersion;
	if (stale && attempt.nativeId !== undefined) {
		if (attempt.nativeId !== nativeId) throw new FoundryError("binding_conflict", "A historical native identity cannot be rebound");
		return attempt;
	}
	const creation = tx.optional("effects", `create:${attemptId}`);
	if (stale && (attempt.state !== "cancelled" || !creation || creation.state === "prepared"
		|| creation.result !== undefined && record(creation.result).neverIssued === true)) {
		throw new FoundryError("stale_attempt", "Cannot bind an unissued superseded attempt");
	}
	if (attempt.nativeId && attempt.nativeId !== nativeId) throw new FoundryError("binding_conflict", "Attempt is already bound to another native identity");
	const firstBinding = !attempt.nativeId;
	if (!stale && task.role === "coordinator" && tx.list("attempts", "WHERE native_id=?", [nativeId]).some(other => {
		const assigned = tx.get("tasks", other.taskId);
		return assigned.role === "coordinator" && assigned.goalId !== task.goalId && assigned.currentAttemptId === other.id
			&& !["done", "cancelled", "failed"].includes(assigned.state);
	})) throw new FoundryError("binding_conflict", "A native coordinator cannot carry execution authority and usage affinity across different active goals");
	if (firstBinding && !local && tx.list("attempts", "WHERE native_id=? AND id NOT IN (SELECT attempt_id FROM local_attempts)", [nativeId])
		.some((other) => other.taskId !== task.id)) throw new FoundryError("binding_conflict", "Native identity already owns another task");
	attempt.nativeId = nativeId;
	if (!stale && firstBinding && attempt.assignedOwner === undefined) {
		const previousOwner = task.owner;
		task.owner = nativeId;
		if (task.role === "coordinator") transferOwnedDescendants(tx, task, previousOwner, nativeId);
	}
	for (const effect of tx.list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'settled'", [attemptId])) {
		effect.state = "settled";
		effect.result = receipt === undefined ? { nativeId } : json(receipt);
		tx.put("effects", effect);
	}
	if (stale) attempt.state = "cancelled";
	else if (task.state === "cancelled" || ancestors(tx, task).some((parent) => parent.state === "cancelled")) {
		task.state = "cancelled";
		attempt.state = "cancelled";
	} else if (firstBinding) attempt.state = task.state === "waiting" ? "waiting" : "running";
	tx.put("tasks", task);
	tx.put("attempts", attempt);
	for (const observation of tx.list("native_usage", "WHERE native_id=? AND goal_id IS NULL", [nativeId])) settleUsage(tx, observation);
	if (firstBinding && !stale) rerouteWakes(tx, task.goalId);
	if (attempt.state === "cancelled") scheduleStop(tx, attempt, actor);
	releaseSlot(tx, tx.get("attempts", attemptId));
	return tx.get("attempts", attemptId);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor @param {string} [localRepairOf] @returns {Attempt|FoundryError} */
export function startLocalTask(tx, taskId, actor, localRepairOf) {
	const task = tx.get("tasks", taskId);
	if (task.repairReservation) localRepairOf = task.repairReservation.attemptId;
	if (localRepairOf === undefined) requireOwner(tx, task, actor);
	uncancelled(tx, task);
	if (task.currentAttemptId) {
		const existing = tx.get("attempts", task.currentAttemptId);
		if (existing.nativeId === actor && tx.db.prepare("SELECT attempt_id FROM local_attempts WHERE attempt_id=?").get(existing.id)
			&& task.state === "running" && existing.state === "running" && existing.slot) return existing;
	}
	const attempt = prepareAttempt(tx, taskId, actor, localRepairOf);
	if (attempt instanceof FoundryError) return attempt;
	observeExecutionBase(tx, attempt);
	if (tx.list("effects", "WHERE attempt_id=? AND kind='create'", [attempt.id]).length) {
		throw new FoundryError("invalid_transition", "A prepared native creation cannot be silently converted to local execution");
	}
	tx.db.prepare("INSERT INTO local_attempts(attempt_id) VALUES(?)").run(attempt.id);
	return bindAttempt(tx, attempt.id, actor, actor, undefined, true);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} expectedAttemptId @param {string} actor @param {boolean} [notify] @param {boolean} [execution] @returns {Task} */
export function retryTask(tx, taskId, expectedAttemptId, actor, notify = true, execution = false) {
	const task = tx.get("tasks", taskId);
	if (!execution || tx.get("attempts", expectedAttemptId).nativeId !== actor) requireOwner(tx, task, actor);
	uncancelled(tx, task);
	const factory = requireAdmission(tx, task);
	if (task.currentAttemptId !== text(expectedAttemptId, "expectedAttemptId") || !["failed", "blocked"].includes(task.state)) {
		throw new FoundryError("stale_attempt", "Repair requires the current failed or blocked attempt");
	}
	const goal = tx.get("goals", task.goalId);
	const repairs = task.repairs ?? 0;
	if (factory?.unchangedFailures !== undefined) {
		/** @param {Attempt} attempt */
		const fingerprint = attempt => {
			const evidence = tx.db.prepare(`SELECT e.document FROM evidence_admissions e JOIN effects f ON e.effect_id=f.id
				WHERE e.attempt_id=? AND json_extract(f.document,'$.factoryGeneration')=? ORDER BY e.sequence`)
				.all(attempt.id, factory.generation).map(row => decodeEvidence(/** @type {unknown} */ (JSON.parse(text(row.document, "failure evidence")))));
			const latest = [...latestEvidence(evidence).values()];
			const failures = latest.filter(item => item.outcome === "failed");
			return failures.length ? digest(json({ inputs: attempt.inputs, failures: failures.map(item => ({ check: item.checkId, version: item.checkVersion,
				candidate: item.candidate?.version ?? null, blocker: item.blocker ?? null }))
				.sort((a, b) => a.check.localeCompare(b.check)) })) : undefined;
		};
		let attempt = tx.get("attempts", expectedAttemptId);
		const currentFailure = fingerprint(attempt);
		let unchanged = currentFailure === undefined ? 0 : 1;
		while (currentFailure && attempt.repairOf) {
			attempt = tx.get("attempts", attempt.repairOf);
			if (fingerprint(attempt) !== currentFailure) break;
			unchanged++;
		}
		if (unchanged >= factory.unchangedFailures) throw new FoundryError("stagnation", "Unchanged evaluated failures reached the authorized stop rule; explicit restart or revised work is required");
	}
	if (goal.limits.repairs !== undefined && repairs >= goal.limits.repairs) {
		throw new FoundryError("repair_limit", "The explicitly allowed additional attempts are exhausted");
	}
	const completion = tx.optional("goal_completions", task.goalId);
	if (completion && factory?.aggregateRepairs !== undefined) {
		if (completion.repairs >= factory.aggregateRepairs) throw new FoundryError("repair_limit", "The goal's explicit aggregate repair allowance is exhausted");
		completion.repairs++;
		tx.put("goal_completions", completion);
	}
	task.state = "ready";
	task.version++;
	task.repairs = repairs + 1;
	if (execution) task.repairReservation = { attemptId: expectedAttemptId, worker: actor };
	task.outputs = [];
	delete task.waiting;
	tx.put("tasks", task);
	if (notify) wake(tx, task.owner, task.goalId, `repair:${task.id}`);
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] */
export function openInputRequests(tx, actor, goalId) {
	return tx.list("attempts", "WHERE json_extract(document,'$.waiting.kind')='input'")
	.filter(attempt => {
		const task = tx.get("tasks", attempt.taskId);
		return (goalId === undefined || task.goalId === goalId) && (attempt.nativeId === actor || authorized(tx, task, actor));
	});
}

/** @param {import("./database.mjs").Transaction} tx Only invoked with explicitly observed native input clearance. @param {string} nativeId @param {string} actor */
export function clearNativeInputs(tx, nativeId, actor) {
	for (const attempt of tx.list("attempts", "WHERE native_id=? AND json_extract(document,'$.waiting.kind')='input'", [nativeId])) {
		requireReporter(tx, attempt, actor);
		delete attempt.waiting;
		tx.put("attempts", attempt);
		const task = tx.get("tasks", attempt.taskId);
		if (task.currentAttemptId === attempt.id && task.version === attempt.taskVersion
			&& task.state === "waiting" && task.waiting?.kind === "input") {
			task.waiting = { kind: "capacity", reason: "The actual native input request was answered" };
			tx.put("tasks", task);
			wakeCapacity(tx, task.goalId);
		}
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {string} name */
export function attemptByCreationName(tx, name) {
	let effects = tx.list("effects", "WHERE kind='create' AND json_extract(document,'$.request.name')=?", [name]);
	const suffix = nativeSessionName(name).match(/ [0-9a-f]{8}$/u)?.[0];
	if (!effects.length && suffix) effects = tx.list("effects",
		"WHERE kind='create' AND json_extract(document,'$.request.name') LIKE ?", [`%${suffix}`])
		.filter(effect => typeof record(effect.request).name === "string"
			&& nativeSessionName(text(record(effect.request).name, "native name")) === nativeSessionName(name));
	return effects.length === 1 ? tx.get("attempts", effects[0].attemptId) : undefined;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor */
export function executingAttempts(tx, actor) {
	return tx.list("attempts", `WHERE native_id=? AND slot=1 AND state='running'
	AND id IN (SELECT json_extract(document,'$.currentAttemptId') FROM tasks WHERE state='running')`, [actor]);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} token */
export function attemptByToken(tx, token) {
	return tx.list("attempts", "WHERE json_extract(document,'$.token')=?", [text(token, "token")])[0];
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor @param {Task["waiting"]} waiting @param {{attemptId:string,handledGeneration?:number,relatedIds?:string[]}} [event] @returns {Task} */
export function waitTask(tx, taskId, actor, waiting, event) {
	const task = tx.get("tasks", taskId);
	const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	if (attempt?.nativeId !== actor) requireOwner(tx, task, actor);
	uncancelled(tx, task);
	if (!attempt || !["running", "waiting"].includes(task.state)) {
		throw new FoundryError("invalid_transition", "Only an active task can wait");
	}
	const decoded = decodeWaiting(waiting);
	if (!decoded) throw new FoundryError("invalid_field", "Waiting must name its reason");
	if (decoded.kind === "events") {
		if (task.role !== "coordinator" || !task.coordination || attempt.nativeId !== actor || task.owner !== actor) {
			throw new FoundryError("foreign_execution", "Only the current executing coordinator can yield its event lease");
		}
		if (event?.attemptId !== attempt.id) throw new FoundryError("stale_attempt", "Event handling must retain the exact current coordinator attempt");
		if (attempt.waiting?.kind === "input" || outstanding(tx, attempt, true)) {
			throw new FoundryError("settlement_required", "Resolve actual native inputs and substantive commands before yielding coordination");
		}
		if (event.handledGeneration !== undefined) {
			const generation = natural(event.handledGeneration, "handled generation");
			if (generation > task.coordination.generation || generation < task.coordination.handled) {
				throw new FoundryError("stale_generation", "A disposition can acknowledge only observed current work generations");
			}
			const relatedIds = event.relatedIds ?? [];
			for (const id of relatedIds) {
				const related = tx.optional("tasks", id);
				const request = tx.optional("collaborations", id);
				if (!(related && authorized(tx, related, actor))
					&& !(request && [request.sourceTaskId, request.destinationTaskId].some(id => authorized(tx, tx.get("tasks", id), actor)))) {
					throw new FoundryError("forbidden", "A disposition may reference only locally accountable work or collaboration");
				}
			}
			task.coordination.handled = generation;
			task.coordination.disposition = { generation, reason: decoded.reason, relatedIds };
			if (generation === task.coordination.generation) task.coordination.causes = [];
		}
	}
	task.state = "waiting";
	task.waiting = decoded;
	attempt.state = "waiting";
	attempt.waiting = decoded;
	tx.put("tasks", task);
	tx.put("attempts", attempt);
	releaseSlot(tx, attempt);
	return task;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor */
export function assertCommandAdmission(tx, actor) {
	const executing = tx.list("attempts", "WHERE native_id=? AND slot=1 AND state='running'", [actor])
		.filter(attempt => tx.get("tasks", attempt.taskId).currentAttemptId === attempt.id);
	for (const attempt of executing) {
		requireAdmission(tx, tx.get("tasks", attempt.taskId));
		observeExecutionBase(tx, attempt);
	}
	if (!executing.length && tx.list("attempts", "WHERE native_id=?", [actor])
		.some(attempt => tx.get("tasks", attempt.taskId).role === "coordinator")) {
		throw new FoundryError("capacity_required", "A waiting or closed coordinator must resume an admitted execution attempt before running commands");
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} actor @returns {Attempt | FoundryError} */
export function resumeTask(tx, taskId, actor) {
	const task = tx.get("tasks", taskId);
	const attempt = task.currentAttemptId ? tx.get("attempts", task.currentAttemptId) : undefined;
	if (attempt?.nativeId !== actor) requireOwner(tx, task, actor);
	uncancelled(tx, task);
	requireAdmission(tx, task);
	if (!attempt || !["running", "waiting"].includes(task.state)) {
		throw new FoundryError("invalid_transition", "Only a current running or waiting attempt can resume");
	}
	current(tx, attempt);
	if (resolvedInputs(tx, task) === undefined) throw new FoundryError("inputs_unavailable", "Required inputs are not available");
	if (!attempt.slot) {
		const denied = allocate(tx, task);
		if (denied) {
			task.waiting = { kind: "capacity", reason: denied.message };
			tx.put("tasks", task);
			return denied;
		}
	}
	attempt.slot = true;
	const creations = tx.list("effects", "WHERE attempt_id=? AND kind='create' AND state<>'prepared'", [attempt.id]);
	attempt.state = attempt.nativeId ? "running"
		: creations.some((effect) => effect.state === "uncertain") ? "uncertain"
			: creations.length ? "issued" : "prepared";
	task.state = "running";
	delete task.waiting;
	delete task.repairReservation;
	delete attempt.waiting;
	tx.put("tasks", task);
	tx.put("attempts", attempt);
	return attempt;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} taskId @param {string} attemptId @param {string} newOwner @param {string} actor @param {boolean} [unavailable] */
export function handoffTask(tx, taskId, attemptId, newOwner, actor, unavailable = false) {
	const task = tx.get("tasks", taskId);
	const old = tx.get("attempts", attemptId);
	if (old.taskId === task.id && old.supersededBy === newOwner && (old.nativeId === actor || authorized(tx, task, actor))) return task;
	requireOwner(tx, task, actor);
	requireAdmission(tx, task);
	if (old.taskId !== task.id) throw new FoundryError("stale_attempt", "Handoff requires this task's exact attempt");
	current(tx, old);
	if (!["running", "waiting"].includes(old.state) || !["running", "waiting"].includes(task.state)) {
		throw new FoundryError("invalid_transition", "Only a current executing or waiting attempt can be relinquished");
	}
	if (newOwner === old.nativeId) throw new FoundryError("invalid_owner", "Handoff must change the actual accountable execution");
	if (actor !== old.nativeId && (!unavailable || task.role !== "coordinator"
		|| !ancestors(tx, task).some(parent => parent.owner === actor) && tx.get("goals", task.goalId).owner !== actor)) {
		throw new FoundryError("foreign_execution", "Only the actual worker can relinquish, or its ancestor replace a verified unavailable coordinator");
	}
	if (old.waiting?.kind === "input" || outstanding(tx, old, true)
		|| tx.list("claims", "WHERE attempt_id=?", [old.id]).length) {
		throw new FoundryError("settlement_required", "Handoff cannot erase pending native requests, effects, or owned claims");
	}
	const directory = old.executionDirectory;
	if (!directory || !existsSync(directory) || realpathSync(directory) !== directory || !old.baseCommit
		|| actor === old.nativeId && realpathSync(tx.cwd) !== directory
		|| realpathSync(execFileSync("git", ["-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ encoding: "utf8" }).trim()) !== path.dirname(path.dirname(tx.databasePath))
		|| executionBase(tx, directory) !== old.baseCommit) {
		throw new FoundryError("implementation_transfer_required", "Only the actual unchanged, verified executing worktree can move; dirty, missing or unverified checkpoints are unsupported");
	}
	const worktree = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
	if (execFileSync("git", ["--literal-pathspecs", "-C", worktree, "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ...task.scope.paths],
		{ encoding: "utf8" }).trim()) {
		throw new FoundryError("implementation_transfer_required", "Scoped changes, including untracked or ignored files, require an unsupported checkpoint transfer");
	}
	const previousOwner = task.owner;
	retirePrepared(tx, old, "execution handoff");
	old.state = "cancelled";
	old.endedBy = actor;
	old.supersededBy = text(newOwner, "new accountable owner");
	tx.put("attempts", old);
	releaseSlot(tx, old);
	task.state = "ready";
	task.owner = newOwner;
	delete task.waiting;
	delete task.repairReservation;
	if (task.role === "coordinator") transferOwnedDescendants(tx, task, previousOwner, newOwner);
	tx.put("tasks", task);
	rerouteWakes(tx, task.goalId);
	wake(tx, task.owner, task.goalId, `reassignment:${task.id}`);
	return task;
}

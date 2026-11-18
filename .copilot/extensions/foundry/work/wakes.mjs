import { randomUUID } from "node:crypto";
import { successorOwners } from "./backlog.mjs";
import { hasSlot, runnable } from "./attempts.mjs";
import { collaborationReasons, collaborationWake } from "./collaboration.mjs";
import { coordinationEvent } from "./organization.mjs";
import { ancestors, budgetAvailable, current, goalMember, requireOwner, requireReporter } from "./policy.mjs";
import { decodeDelivery } from "./records.mjs";
import { inputOutput } from "./tasks.mjs";
import { FoundryError, json, natural, record, text } from "./values.mjs";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Wake} Wake */
/** @typedef {import("./model.d.ts").Signal} Signal */
/** @typedef {import("./model.d.ts").Delivery} Delivery */

/** @param {import("./database.mjs").Transaction} tx @param {string} owner @param {string} goalId @param {string} reason @param {string} [coordinatorId] @returns {Wake} */
export function wake(tx, owner, goalId, reason, coordinatorId) {
	if (!reason.startsWith("coordination:") && !reason.startsWith("coordination-stalled:")) {
		for (const coordinator of coordinatorId ? [tx.get("tasks", coordinatorId)]
			: tx.list("tasks", "WHERE owner=? AND goal_id=? AND json_extract(document,'$.role')='coordinator'", [owner, goalId])) {
			if (coordinatorId || coordinator.currentAttemptId && tx.get("attempts", coordinator.currentAttemptId).nativeId === owner) {
				coordinationEvent(tx, coordinator, reason);
			}
		}
	}
	return enqueueWake(tx, owner, goalId, reason);
}

/** Transport only: the caller has already recorded the coordination event.
 * @param {import("./database.mjs").Transaction} tx @param {string} owner @param {string} goalId @param {string} reason @returns {Wake} */
export function enqueueWake(tx, owner, goalId, reason) {
	const existing = tx.list("wakes", "WHERE owner=? AND goal_id=?", [owner, goalId])[0];
	const relatedReasons = [...new Set([
		...(existing && existing.generation > existing.consumed ? existing.relatedReasons ?? [existing.reason] : []),
		reason,
	])];
	const result = existing ? { ...existing, reason, relatedReasons, generation: existing.generation + 1 }
		: { id: randomUUID(), owner, goalId, reason, relatedReasons, generation: 1, consumed: 0, sent: 0 };
	tx.put("wakes", result);
	return result;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} goalId @returns {void} */
export function wakeCapacity(tx, goalId) {
	const goal = tx.get("goals", goalId);
	if (goal.limits.workers === undefined || !hasSlot(tx, goal) || !budgetAvailable(tx, goal)) return;
	for (const task of tx.list("tasks", "WHERE goal_id=? AND state IN ('ready','waiting')", [goalId])) {
		if (task.waiting?.kind !== "events" && runnable(tx, task)) wake(tx, task.repairReservation?.worker ?? task.owner, task.goalId, "capacity");
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Wake} notification @returns {string[]} */
export function wakeTargets(tx, notification) {
	if (notification.reason === "capacity") {
		const goal = tx.get("goals", notification.goalId);
		if (!hasSlot(tx, goal) || !budgetAvailable(tx, goal)) return [];
		return tx.list("tasks", "WHERE goal_id=? AND state IN ('ready','waiting')", [notification.goalId])
			.filter(runnable.bind(undefined, tx)).map((task) => task.repairReservation?.worker ?? task.owner);
	}
	const prefix = notification.reason.split(":", 1)[0];
	const taskId = notification.reason.slice(prefix.length + 1);
	if (prefix === "signal") {
		const signal = tx.optional("signals", taskId);
		if (!signal) return [];
		return [signalOwner(tx, signal)];
	}
	if (prefix === "unavailable") {
		const failed = tx.optional("wakes", taskId);
		return failed?.unavailable ? [fallbackOwner(tx, failed)] : [];
	}
	if (prefix === "unit") return [tx.get("units", taskId).owner];
	if (prefix === "coordination") return [tx.get("tasks", taskId).owner];
	if (prefix === "coordination-stalled") {
		const coordinator = tx.get("tasks", taskId);
		return [coordinator.parentId ? tx.get("tasks", coordinator.parentId).owner : tx.get("goals", coordinator.goalId).owner];
	}
	if (prefix === "collaboration") {
		const collaboration = tx.get("collaborations", taskId);
		return [tx.get("tasks", collaboration.sourceTaskId), tx.get("tasks", collaboration.destinationTaskId)]
			.filter(task => task.goalId === notification.goalId).map(task => task.owner);
	}
	const task = tx.optional("tasks", taskId);
	if (!task) return [];
	if (prefix === "reassignment" || prefix === "revision") return [task.owner];
	if (prefix === "repair") return task.state === "ready" ? [task.repairReservation?.worker ?? task.owner] : [];
	if (prefix !== "output") return [notification.owner];
	const parent = task.parentId ? tx.get("tasks", task.parentId) : undefined;
	const recipients = parent?.goalId === notification.goalId ? [parent.owner]
		: !parent && task.goalId === notification.goalId ? [tx.get("goals", task.goalId).owner] : [];
	for (const row of tx.db.prepare("SELECT DISTINCT task_id FROM dependencies WHERE producer_id=?").all(task.id)) {
		const consumer = tx.get("tasks", text(row.task_id, "consumer"));
		if (consumer.goalId === notification.goalId && receivesOutput(tx, task, consumer)) recipients.push(consumer.owner);
	}
	return [...recipients, ...successorOwners(tx, task.id, notification.goalId)];
}

/** A publication belongs to every still-interested consumer, not just the
 * first one with all its *other* inputs already satisfied.
 * @param {import("./database.mjs").Transaction} tx @param {Task} producer @param {Task} consumer @returns {boolean} */
export function receivesOutput(tx, producer, consumer) {
	return producer.state === "done" && !["done","cancelled"].includes(consumer.state)
		&& consumer.inputs.some(input => input.taskId === producer.id
			&& producer.outputs.some(output => output.name === input.output && (!input.version || input.version === output.version))
			&& inputOutput(tx, input));
}

/** @param {import("./database.mjs").Transaction} tx @param {Wake} wake @param {string} actor @param {string} [origin] @param {boolean} [fallback] @returns {string[]} */
function outputReasons(tx, wake, actor, origin, fallback = true) {
	return (wake.relatedReasons ?? [wake.reason]).filter(reason => {
		if (fallback && reason.startsWith("unavailable:")) {
			const failed = tx.optional("wakes", reason.slice("unavailable:".length));
			if (!failed?.unavailable || failed.goalId !== wake.goalId || fallbackOwner(tx, failed) !== wake.owner) return false;
			const sent = tx.get("deliveries", failed.unavailable.effectId);
			// Only the original sender, for its own authorized output, may
			// relay this failure to the accountable fallback.
			return sent.owner === actor && sent.state === "settled" && outputReasons(tx, failed, actor, origin, false).length > 0;
		}
		if (!reason.startsWith("output:")) return false;
		const producer = tx.optional("tasks", reason.slice(7));
		if (!producer || producer.state !== "done" || origin !== undefined && producer.goalId !== origin
			|| !producer.currentAttemptId) return false;
		const attempt = tx.get("attempts", producer.currentAttemptId);
		return (actor === attempt.nativeId || actor === attempt.creator || actor === producer.owner)
			&& wakeTargets(tx, { ...wake, reason }).includes(wake.owner);
	});
}

/** @param {import("./database.mjs").Transaction} tx @param {string} id @param {string} actor @param {string} [origin] @returns {boolean} */
export function canRelayOutput(tx, id, actor, origin) {
	return outputReasons(tx, tx.get("wakes", id), actor, origin).length > 0;
}

/** @param {import("./database.mjs").Transaction} tx @param {Signal} signal @returns {string} */
export function signalOwner(tx, signal) {
	if (signal.unitId) {
		const unit = tx.get("units", signal.unitId);
		const coordinator = tx.list("tasks", "WHERE json_extract(document,'$.unitId')=? AND json_extract(document,'$.role')='coordinator' AND state<>'cancelled'", [unit.id])[0];
		return coordinator?.owner ?? (unit.taskId ? tx.get("tasks", unit.taskId).owner : tx.get("goals", unit.goalId).owner);
	}
	if (!signal.taskId) return tx.get("goals", signal.goalId).owner;
	const task = tx.get("tasks", signal.taskId);
	if (task.role === "coordinator") return task.owner;
	return task.parentId ? tx.get("tasks", task.parentId).owner
		: task.unitId ? tx.get("units", task.unitId).owner : tx.get("goals", task.goalId).owner;
}

/** @param {import("./database.mjs").Transaction} tx @param {Wake} notification @returns {string} */
export function fallbackOwner(tx, notification) {
	for (const task of tx.list("tasks", "WHERE goal_id=? AND owner=?", [notification.goalId, notification.owner])) {
		const parent = ancestors(tx, task).find(parent => parent.owner !== notification.owner && parent.state !== "cancelled");
		if (parent) return parent.owner;
	}
	return tx.get("goals", notification.goalId).owner;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} owner @param {Wake} notification @returns {void} */
export function wakeOwnerFallback(tx, owner, notification) { wake(tx, owner, notification.goalId, `unavailable:${notification.id}`); }

/** @param {import("./database.mjs").Transaction} tx @param {string} goalId @returns {void} */
export function rerouteWakes(tx, goalId) {
	for (const notification of tx.list("wakes", "WHERE goal_id=?", [goalId])) {
		if (notification.generation <= notification.consumed) continue;
		const targets = new Set();
		for (const reason of notification.relatedReasons ?? [notification.reason]) {
			for (const owner of wakeTargets(tx, { ...notification, reason })) {
				targets.add(owner);
				if (owner !== notification.owner) wake(tx, owner, goalId, reason);
			}
		}
		if (!targets.has(notification.owner)) {
			notification.consumed = notification.generation;
			tx.put("wakes", notification);
		}
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Wake} notification @returns {boolean} */
export function wakeReady(tx, notification) {
	return !notification.inFlight && !notification.unavailable
		&& (!notification.retry || notification.retry.generation < notification.generation
			|| notification.retry.after !== undefined && Date.parse(notification.retry.after) <= Date.parse(tx.timestamp()))
		&& notification.generation > Math.max(notification.sent ?? 0, notification.consumed)
		&& ((notification.sent ?? 0) <= notification.consumed
			|| tx.list("tasks", "WHERE owner=? AND goal_id=? AND json_extract(document,'$.role')='coordinator' AND state IN ('running','waiting')",
				[notification.owner, notification.goalId]).length > 0);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} task @returns {void} */
export function notifyOutcome(tx, task) {
	const owner = task.parentId ? tx.get("tasks", task.parentId).owner : tx.get("goals", task.goalId).owner;
	wake(tx, owner, task.goalId, `output:${task.id}`);
}

/** @param {import("./database.mjs").Transaction} tx @param {Delivery} delivery @param {Json} result @returns {void} */
export function finishDelivery(tx, delivery, result) {
	tx.put("deliveries", { ...delivery, state: "settled", result });
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {string} [goalId] @returns {Delivery[]} */
export function pendingDeliveries(tx, actor, goalId) {
	return tx.list("deliveries", `WHERE owner=? AND state='issued'${goalId === undefined ? ""
		: " AND (goal_id=? OR json_extract(document,'$.originGoalId')=?)"} AND id IN
		(SELECT json_extract(document,'$.inFlight') FROM wakes WHERE json_extract(document,'$.inFlight') IS NOT NULL)`,
		goalId === undefined ? [actor] : [actor, goalId, goalId]);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} owner @returns {Wake[]} */
export function pendingWakes(tx, owner) {
	return tx.list("wakes", "WHERE owner=? AND json_extract(document,'$.generation')>json_extract(document,'$.consumed')", [text(owner, "owner")]);
}

/** @param {import("./database.mjs").Transaction} tx @param {string} actor @param {boolean} [capacity] @param {boolean} [includeInFlight] @returns {Wake[]} */
export function outgoingWakes(tx, actor, capacity = false, includeInFlight = false) {
	return tx.list("wakes", `WHERE owner<>? ${includeInFlight ? "" : "AND json_extract(document,'$.inFlight') IS NULL"}
	AND json_extract(document,'$.unavailable') IS NULL
	AND json_extract(document,'$.generation')>MAX(COALESCE(json_extract(document,'$.sent'),0),json_extract(document,'$.consumed'))`,
	[actor]).flatMap(wake => {
		if (!includeInFlight && !wakeReady(tx, wake)) return [];
		if (goalMember(tx, tx.get("goals", wake.goalId), actor)) return [wake];
		const reasons = [...collaborationReasons(tx, wake, actor), ...outputReasons(tx, wake, actor)];
		if (capacity && reasons.length && (wake.relatedReasons ?? [wake.reason]).includes("capacity")) reasons.push("capacity");
		return reasons.length ? [{ ...wake, reason: text(reasons.at(-1), "permitted wake reason"), relatedReasons: reasons }] : [];
	});
}

/** @param {import("./database.mjs").Transaction} tx @param {string} wakeId @returns {boolean} */
export function wakeCanSend(tx, wakeId) {
	return wakeReady(tx, tx.get("wakes", wakeId));
}

/** @param {import("./database.mjs").Transaction} tx @param {string} wakeId @returns {boolean} */
export function wakeHasCurrentRecipient(tx, wakeId) {
	const notification = tx.get("wakes", wakeId);
	return (notification.relatedReasons ?? [notification.reason])
		.some(reason => wakeTargets(tx, { ...notification, reason }).includes(notification.owner));
}

/** @param {import("./database.mjs").Transaction} tx @param {string} wakeId @param {number} generation @param {string|undefined} attemptId @param {Json} request @param {string} actor @param {string} [originGoalId] @returns {Delivery|undefined} */
export function claimWakeDelivery(tx, wakeId, generation, attemptId, request, actor, originGoalId) {
	const wake = tx.get("wakes", wakeId);
	const authority = tx.optional("goal_completions", wake.goalId) ?? tx.list("squads", "WHERE goal_id=?", [wake.goalId])[0];
	if (authority) {
		const factory = tx.get("factory_controls", authority.factoryId);
		if (factory.state !== "active" || factory.pausedWorkers.includes(wake.owner)) return;
	}
	if (attemptId === undefined) {
		if (!goalMember(tx, tx.get("goals", wake.goalId), actor) && !collaborationWake(tx, wake, actor)
			&& !canRelayOutput(tx, wakeId, actor)) throw new FoundryError("foreign_wake", "Bookkeeping cannot deliver unrelated goals' messages");
	} else {
		const attempt = tx.get("attempts", attemptId);
		requireReporter(tx, attempt, actor);
		const task = current(tx, attempt);
		if (attempt.nativeId !== actor) requireOwner(tx, task, actor);
		if (!goalMember(tx, tx.get("goals", wake.goalId), actor)
			&& !collaborationWake(tx, wake, actor) && !canRelayOutput(tx, wakeId, actor)) {
			throw new FoundryError("foreign_wake", "This reporter cannot deliver unrelated goals' messages");
		}
	}
	natural(generation, "generation");
	if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot send an unseen generation");
	if (!wakeReady(tx, wake) || generation <= Math.max(wake.consumed, wake.sent ?? 0) || !wakeHasCurrentRecipient(tx, wakeId)) return;
	const delivery = decodeDelivery({ id: `wake:${wake.id}:${randomUUID()}`, wakeId, goalId: wake.goalId,
		...(originGoalId && originGoalId !== wake.goalId ? { originGoalId } : {}),
		generation, owner: actor, state: "issued", request,
		...(attemptId === undefined ? {} : { attemptId }) });
	wake.inFlight = delivery.id;
	tx.put("deliveries", delivery);
	tx.put("wakes", wake);
	return delivery;
}

/** @param {import("./database.mjs").Transaction} tx Native queue acceptance settles only the claimed generation, never a concurrent update.
 * @param {string} wakeId @param {string} effectId @param {number} generation @param {Json} result @param {boolean} accepted @param {string} actor @param {boolean} [unavailable] @returns {Wake}
 */
export function settleWakeDelivery(tx, wakeId, effectId, generation, result, accepted, actor, unavailable = false) {
	const wake = tx.get("wakes", wakeId);
	const delivery = tx.get("deliveries", effectId);
	const consumed = delivery.result === undefined ? undefined : record(delivery.result);
	if (delivery.state === "settled" && consumed?.consumedBy === wake.owner
		&& delivery.wakeId === wakeId && delivery.generation === generation && delivery.owner === actor) {
		if (accepted) wake.sent = Math.max(wake.sent ?? 0, generation);
		tx.put("wakes", wake);
		return wake;
	}
	if (wake.inFlight !== effectId || delivery.wakeId !== wakeId || delivery.generation !== generation
		|| delivery.state !== "issued" || delivery.owner !== actor) {
		throw new FoundryError("wake_delivery_conflict", "This is not the outstanding native wake delivery");
	}
	natural(generation, "generation");
	if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot settle an unseen generation");
	finishDelivery(tx, delivery, result);
	delete wake.inFlight;
	if (accepted) { wake.sent = Math.max(wake.sent ?? 0, generation); delete wake.unavailable; delete wake.retry; }
	else if (unavailable) {
		const fallback = fallbackOwner(tx, wake);
		const envelope = record(result);
		wake.unavailable = { effectId, generation, fallback,
			message: typeof envelope.textResultForLlm === "string" && envelope.textResultForLlm
				? envelope.textResultForLlm : "The native recipient is unavailable" };
		if (fallback !== wake.owner) wakeOwnerFallback(tx, fallback, wake);
	} else {
		const envelope = record(result);
		const message = typeof envelope.error === "string" ? envelope.error : typeof envelope.textResultForLlm === "string" ? envelope.textResultForLlm : "Native queue rejected the send";
		if (!/session[\s-]+management.*disabled/iu.test(message)) {
			const failures = (wake.retry?.generation === generation ? wake.retry.failures : 0) + 1;
			const hold = failures >= 3 || ["denied", "rejected"].includes(String(envelope.resultType));
			wake.retry = { generation, failures, reason: message || "Native queue rejected the send",
				...(hold ? {} : { after: new Date(Date.parse(tx.timestamp()) + (failures === 1 ? 0 : 1000 * (2 ** failures))).toISOString() }) };
		}
	}
	tx.put("wakes", wake);
	return wake;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} wakeId @param {number} generation @param {string} actor @returns {Wake} */
export function consumeWake(tx, wakeId, generation, actor) {
	const wake = tx.get("wakes", wakeId);
	if (wake.owner !== text(actor, "actor")) throw new FoundryError("forbidden", "Only the addressed owner may consume this wake");
	natural(generation, "generation");
	if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot consume an unseen wake generation");
	wake.consumed = Math.max(wake.consumed, generation);
	if (wake.unavailable && wake.unavailable.generation <= generation) delete wake.unavailable;
	if (wake.retry && wake.retry.generation <= generation) delete wake.retry;
	if (wake.inFlight) {
		const delivery = tx.get("deliveries", wake.inFlight);
		if (delivery.generation <= wake.consumed && delivery.state === "issued") {
			finishDelivery(tx, delivery, json({ consumedBy: actor, generation: wake.consumed }));
			delete wake.inFlight;
		}
	}
	tx.put("wakes", wake);
	return wake;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} wakeId @param {number} generation @param {string} actor @param {boolean} [observedOnly] @returns {Wake} */
export function markWakeSent(tx, wakeId, generation, actor, observedOnly = false) {
	const wake = tx.get("wakes", wakeId);
	text(actor, "actor");
	if (wake.owner !== actor && !goalMember(tx, tx.get("goals", wake.goalId), actor)
		&& !collaborationWake(tx, wake, actor) && !canRelayOutput(tx, wakeId, actor)) {
		throw new FoundryError("forbidden", "Only a legitimate goal member or the affected output's publisher may acknowledge native delivery");
	}
	natural(generation, "generation");
	if (generation > wake.generation) throw new FoundryError("wake_generation", "Cannot acknowledge an unseen generation");
	if (observedOnly) {
		if ((wake.sent ?? 0) < generation && wake.consumed < generation)
			throw new FoundryError("wake_receipt_required", "No native queue receipt or recipient observation for this generation. Reconcile the original call on the sender's next advance.");
		return wake;
	}
	wake.sent = Math.max(wake.sent ?? 0, generation);
	if (wake.inFlight) {
		const delivery = tx.get("deliveries", wake.inFlight);
		if (delivery.generation === generation && delivery.state === "issued") {
			finishDelivery(tx, delivery, json({ nativeQueueAcknowledgedBy: actor, generation }));
			delete wake.inFlight;
		}
	}
	tx.put("wakes", wake);
	return wake;
}

import { readCandidate } from "./artifacts.mjs";
import { coordinationAdmission } from "./organization.mjs";
import { ancestors, assignedExecution, authorized, below, budgetAvailable, requireAdmission, requireOwner } from "./policy.mjs";
import { decodeCollaboration } from "./records.mjs";
import { createTask, replaceInputs, reviseDependents } from "./tasks.mjs";
import { FoundryError, digest, json, text } from "./values.mjs";
import { wake, wakeTargets } from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Collaboration} Collaboration */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Wake} Wake */
/** @typedef {import("./records.mjs").TaskInput} TaskInput */

/** @param {import("./database.mjs").Transaction} tx @param {Task} coordinator @param {Task} producer */
function ownsItem(tx, coordinator, producer) {
	const squad = tx.list("squads", "WHERE task_id=?", [coordinator.id])[0];
	if (!squad || !coordinator.currentAttemptId || tx.get("attempts", coordinator.currentAttemptId).nativeId !== coordinator.owner) return false;
	return tx.list("backlog_items", "WHERE goal_id=? AND state='pulled'", [producer.goalId]).some(item => item.squad === squad.id);
}

/** @param {import("./database.mjs").Transaction} tx @param {Task} consumer @param {number} previous @returns {void} */
export function syncConsumerVersions(tx, consumer, previous) {
	for (const item of tx.list("collaborations", "WHERE json_extract(document,'$.consumerTaskId')=?", [consumer.id])) {
		const source = tx.get("tasks", item.sourceTaskId);
		if (item.consumerVersion === previous && item.sourceOwner === source.owner && item.sourceVersion === source.version) {
			item.consumerVersion = consumer.version;
			tx.put("collaborations", item);
		}
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Collaboration} item @param {string} actor @returns {void} */
export function bindCollaboration(tx, item, actor) {
	if (!item.delivery) throw new FoundryError("delivery_unavailable", "Only a published exact-version delivery can satisfy a collaboration");
	const consumer = tx.get("tasks", item.consumerTaskId);
	const input = { taskId: item.delivery.taskId, output: item.delivery.output,
		...(consumer.goalId === tx.get("tasks", item.delivery.taskId).goalId ? {} : { version: item.delivery.version }) };
	item.bound = true;
	delete item.reason;
	tx.put("collaborations", item);
	if (item.required) replaceInputs(tx, consumer,
		[...consumer.inputs.filter(previous => previous.taskId !== input.taskId || previous.output !== input.output), input], actor);
	item.consumerVersion = tx.get("tasks", consumer.id).version;
	tx.put("collaborations", item);
	wake(tx, consumer.owner, consumer.goalId, `collaboration:${item.id}`);
}

/** @param {import("./database.mjs").Transaction} tx @param {Collaboration} item @returns {void} */
export function notifyCollaboration(tx, item) {
	for (const id of [item.sourceTaskId, item.destinationTaskId]) {
		const task = tx.get("tasks", id);
		wake(tx, task.owner, task.goalId, `collaboration:${item.id}`, task.id);
	}
}

/** @param {import("./database.mjs").Transaction} tx @param {Wake} notification @param {string} actor @returns {string[]} */
export function collaborationReasons(tx, notification, actor) {
	const permitted = new Set(tx.list("collaborations").filter(item =>
		(notification.goalId === item.goalId || notification.goalId === item.destinationGoalId
			|| [item.sourceTaskId, item.destinationTaskId].some(id => tx.get("tasks", id).goalId === notification.goalId))
		&& [item.sourceTaskId, item.destinationTaskId, ...(item.producerTaskId ? [item.producerTaskId] : [])]
			.some(id => { const task = tx.get("tasks", id); return authorized(tx, task, actor) || assignedExecution(tx, task, actor); }))
		.flatMap(item => [`collaboration:${item.id}`, ...(item.producerTaskId ? [`output:${item.producerTaskId}`] : [])]));
	return (notification.relatedReasons ?? [notification.reason]).filter(reason =>
		permitted.has(reason) && wakeTargets(tx, { ...notification, reason }).includes(notification.owner));
}

/** @param {import("./database.mjs").Transaction} tx @param {Wake} notification @param {string} actor @returns {boolean} */
export function collaborationWake(tx, notification, actor) { return collaborationReasons(tx, notification, actor).length > 0; }

/** @param {import("./database.mjs").Transaction} tx @param {{id?:string,sourceTaskId:string,destinationTaskId:string,consumerTaskId:string,expectedVersion:number,title:string,output:string,required?:boolean}} input @param {string} actor @returns {Collaboration} */
export function requestCollaboration(tx, input, actor) {
	const source = tx.get("tasks", input.sourceTaskId);
	const destination = tx.get("tasks", input.destinationTaskId);
	const consumer = tx.get("tasks", input.consumerTaskId);
	requireOwner(tx, source, actor);
	requireOwner(tx, consumer, actor);
	coordinationAdmission(tx, source);
	coordinationAdmission(tx, destination);
	if (consumer.role !== "producer" || !(consumer.goalId === source.goalId && below(tx, consumer, source.id) || ownsItem(tx, source, consumer))) {
		throw new FoundryError("forbidden", "A request can govern only a producer inside its source coordinator's task boundary");
	}
	requireAdmission(tx, consumer);
	const proposal = digest(json(input));
	const previous = input.id === undefined ? undefined : tx.optional("collaborations", input.id);
	if (previous) {
		if (previous.proposal !== proposal) throw new FoundryError("collaboration_conflict", "A request identity cannot change its immutable proposal");
		return previous;
	}
	if (consumer.version !== input.expectedVersion) throw new FoundryError("stale_task", "Request the consumer's current definition");
	const item = decodeCollaboration({ ...input, id: tx.newId("collaborations", input.id), goalId: consumer.goalId,
		destinationGoalId: destination.goalId, sourceOwner: source.owner, sourceVersion: source.version,
		destinationVersion: destination.version, consumerVersion: consumer.version,
		required: input.required ?? true, revision: 1, state: "proposed", proposal, bound: false });
	tx.put("collaborations", item);
	if (item.required) {
		const version = consumer.version;
		reviseDependents(tx, consumer, actor);
		syncConsumerVersions(tx, tx.get("tasks", consumer.id), version);
		item.consumerVersion = tx.get("tasks", consumer.id).version;
		tx.put("collaborations", item);
	}
	notifyCollaboration(tx, item);
	return item;
}

/** @param {import("./database.mjs").Transaction} tx @param {{collaborationId:string,expectedRevision:number,action:"accept"|"fulfill"|"bind"|"decline"|"block"|"cancel"|"release",reason?:string,producerTaskId?:string,producer?:Omit<TaskInput,"goalId"|"parentId"|"unitId"|"role">}} input @param {string} actor @returns {Collaboration} */
export function respondCollaboration(tx, input, actor) {
	let item = tx.get("collaborations", input.collaborationId);
	const source = tx.get("tasks", item.sourceTaskId);
	const destination = tx.get("tasks", item.destinationTaskId);
	const sourceAuthority = authorized(tx, source, actor);
	const destinationAuthority = authorized(tx, destination, actor);
	if (!sourceAuthority && !destinationAuthority) throw new FoundryError("forbidden", "Only a request's actual accountable coordinators can change it");
	if (["accept", "fulfill", "decline", "block"].includes(input.action) && !destinationAuthority
		|| ["bind", "release"].includes(input.action) && !sourceAuthority) {
		throw new FoundryError("forbidden", "A source cannot promise another unit's work, and a destination cannot release the source's requirements");
	}
	const action = digest(json({ input, actor }));
	if (item.lastAction === action) return item;
	if (item.revision !== input.expectedRevision) throw new FoundryError("stale_collaboration", "Use the current collaboration revision");
	if (input.action === "accept") {
		coordinationAdmission(tx, source);
		coordinationAdmission(tx, destination);
		const consumer = tx.get("tasks", item.consumerTaskId);
		requireAdmission(tx, consumer);
		if (item.state !== "proposed" || Boolean(input.producer) === Boolean(input.producerTaskId)) throw new FoundryError("invalid_transition", "Accept with exactly one new producer assignment or current declared producing task");
		if (item.sourceOwner !== source.owner || item.sourceVersion !== source.version
			|| item.destinationVersion !== destination.version || item.consumerVersion !== consumer.version) {
			throw new FoundryError("source_update_required", "Changed source/destination authority or consumer definition requires a fresh authorized proposal");
		}
		let producer;
		if (input.producerTaskId) {
			producer = tx.get("tasks", input.producerTaskId);
			if (destination.owner !== actor || !ownsItem(tx, destination, producer) || producer.deliverable !== item.output
				|| tx.get("goal_completions", producer.goalId).taskId === producer.id) {
				throw new FoundryError("foreign_producer", "Offer this squad's actual scoped output producer, not its final product gate or another owner's work");
			}
			requireAdmission(tx, producer);
			item.destinationGoalId = producer.goalId;
		} else if (input.producer) producer = createTask(tx, { ...input.producer, goalId: destination.goalId, parentId: destination.id,
			...(destination.unitId ? { unitId: destination.unitId } : {}) }, actor);
		else throw new FoundryError("invalid_transition", "Missing collaboration producer");
		item.producerTaskId = producer.id;
		item.state = "accepted";
		tx.put("collaborations", item);
		if (item.required) {
			replaceInputs(tx, consumer, [...consumer.inputs, { taskId: producer.id, output: item.output }], actor);
			item = tx.get("collaborations", item.id);
		}
	} else if (input.action === "fulfill") {
		if (!["accepted", "blocked"].includes(item.state) || !item.producerTaskId) throw new FoundryError("invalid_transition", "Only an accepted producer can fulfill a request");
		const producer = tx.get("tasks", item.producerTaskId);
		const output = producer.state === "done" ? producer.outputs.find(output => output.name === item.output) : undefined;
		if (!output) throw new FoundryError("delivery_unavailable", "The accepted producer has not published the requested named output");
		readCandidate(output.reference, output.version, tx.databasePath);
		item.delivery = { taskId: producer.id, output: output.name, version: output.version };
		item.state = "fulfilled";
		const consumer = tx.get("tasks", item.consumerTaskId);
		const completion = tx.optional("goal_completions", consumer.goalId);
		const factory = completion ? tx.get("factory_controls", completion.factoryId) : undefined;
		if (!completion?.closed && source.owner === item.sourceOwner && source.version === item.sourceVersion
			&& consumer.version === item.consumerVersion && !ancestors(tx, consumer).some(parent => parent.state === "cancelled")
			&& consumer.state !== "cancelled" && budgetAvailable(tx, tx.get("goals", consumer.goalId))
			&& (!factory || factory.state === "active" && !factory.pausedWorkers.includes(source.owner) && !factory.pausedWorkers.includes(consumer.owner))) bindCollaboration(tx, item, actor);
		else item.reason = "Delivery retained; changed or unavailable source admission requires explicit source binding";
	} else if (input.action === "bind") {
		coordinationAdmission(tx, source);
		requireOwner(tx, tx.get("tasks", item.consumerTaskId), actor);
		if (item.state !== "fulfilled") throw new FoundryError("invalid_transition", "Only a fulfilled delivery can be explicitly bound");
		bindCollaboration(tx, item, actor);
	} else {
		const reason = text(input.reason, "collaboration disposition");
		if (input.action === "release") {
			coordinationAdmission(tx, source);
			const consumer = tx.get("tasks", item.consumerTaskId);
			requireOwner(tx, consumer, actor);
			requireAdmission(tx, consumer);
			item.required = false;
			tx.put("collaborations", item);
			replaceInputs(tx, consumer, consumer.inputs.filter(previous =>
				previous.taskId !== item.producerTaskId || previous.output !== item.output), actor);
			item.consumerVersion = tx.get("tasks", consumer.id).version;
		} else {
			requireAdmission(tx, sourceAuthority ? source : destination);
			if (input.action === "decline" && item.state !== "proposed"
				|| input.action === "block" && !["accepted", "blocked"].includes(item.state)
				|| input.action === "cancel" && ["fulfilled", "declined", "cancelled"].includes(item.state)) {
				throw new FoundryError("invalid_transition", "This collaboration transition does not apply to its current state");
			}
			item.state = input.action === "decline" ? "declined" : input.action === "block" ? "blocked" : "cancelled";
		}
		item.reason = reason;
	}
	item.revision++;
	item.lastAction = action;
	tx.put("collaborations", item);
	notifyCollaboration(tx, item);
	return item;
}

/** @param {import("./database.mjs").Transaction} tx @param {string} wakeId @param {string} actor @returns {boolean} */
export function canRelayCollaboration(tx, wakeId, actor) {
	return collaborationWake(tx, tx.get("wakes", wakeId), actor);
}

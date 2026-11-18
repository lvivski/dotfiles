import { FoundryError, text, textPage } from "./values.mjs";
import { openDatabase } from "./database.mjs";
import * as Landing from "./landing.mjs";
import { retirementStore } from "./retirement.mjs";
import * as Attempts from "./attempts.mjs";
import * as Backlog from "./backlog.mjs";
import * as Claims from "./claims.mjs";
import * as Collaboration from "./collaboration.mjs";
import * as Context from "./context.mjs";
import * as Effects from "./effects.mjs";
import * as Feedback from "./feedback.mjs";
import * as Jobs from "./jobs.mjs";
import * as Organization from "./organization.mjs";
import * as Policy from "./policy.mjs";
import * as Results from "./results.mjs";
import * as Tasks from "./tasks.mjs";
import * as Usage from "./usage.mjs";
import * as Wakes from "./wakes.mjs";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Goal} Goal */
/** @typedef {import("./model.d.ts").Unit} Unit */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Effect} Effect */
/** @typedef {import("./model.d.ts").Result} Result */
/** @typedef {import("./model.d.ts").Claim} Claim */
/** @typedef {import("./model.d.ts").Wake} Wake */
/** @typedef {import("./model.d.ts").Signal} Signal */
/** @typedef {import("./model.d.ts").Lesson} Lesson */
/** @typedef {import("./model.d.ts").Delivery} Delivery */
/** @typedef {import("./model.d.ts").FactoryControl} Factory */
/** @typedef {import("./records.mjs").GoalInput} GoalInput */
/** @typedef {import("./records.mjs").TaskInput} TaskInput */
/** @typedef {import("./records.mjs").UnitInput} UnitInput */

/**
 * Native calls stay outside the store. Public operations share one synchronous
 * transaction across the affected state modules.
 * @param {string} workingDirectory
 * @param {{clock?: () => Date}} [options]
 */
export function openWorkStore(workingDirectory, options = {}) {
	const database = openDatabase(workingDirectory, options);
	return {
		databasePath: database.databasePath,
		/** @param {string} goalId @param {string} actor */
		prepareDelivery(goalId, actor) {
			const basis = database.transaction(tx => Landing.captureDelivery(tx,goalId,actor),false);
			const joined = Landing.prepareJoin(database.databasePath,basis);
			return database.transaction(tx => Landing.recordJoin(tx,basis,joined,actor));
		},
		/** @param {string} goalId @param {string} id @param {string} actor */
		qualifyDelivery(goalId,id,actor) { return database.transaction(tx => Landing.qualifyDelivery(tx,goalId,id,actor)); },
		/** @param {string} goalId @param {string} id @param {string} actor */
		authorizeLanding(goalId,id,actor) { return database.transaction(tx => Landing.authorizeLanding(tx,goalId,id,actor),false); },
		/** @param {string} goalId @param {string} id @param {string} actor */
		issueLanding(goalId,id,actor) { return database.transaction(tx => Landing.issueLanding(tx,goalId,id,actor)); },
		/** @param {string} goalId @param {string} id @param {string} token @param {string} reason */
		blockLanding(goalId,id,token,reason) { return database.transaction(tx => Landing.blockLanding(tx,goalId,id,token,reason)); },
		/** @param {string} goalId @param {string} id @param {string} actor */
		reconcileLanding(goalId,id,actor) { return database.transaction(tx => Landing.reconcileLanding(tx,goalId,id,actor)); },
		/** @param {string} goalId @param {string} actor */
		deliveryStatus(goalId,actor) { return database.transaction(tx => Landing.deliveryStatus(tx,goalId,actor),false); },
		/** @param {string} goalId @param {string} actor */
		nextDelivery(goalId,actor) { return database.transaction(tx => Landing.nextDelivery(tx,goalId,actor),false); },
		/** @param {string} attemptId */
		productCheckPlan(attemptId) { return database.transaction(tx => Landing.productCheckPlan(tx,attemptId),false); },
		...retirementStore(database),
		/** @param {string} id @param {string} actor */
		factory(id, actor) { return database.transaction(tx => Jobs.factory(tx, id, actor), false); },
		/** @param {string} actor */
		factoryViews(actor) { return database.transaction(tx => Jobs.factoryViews(tx, actor), false); },
		/** @param {Omit<Factory,"owner"|"state"|"generation"|"pausedWorkers"|"reminders">} input @param {string} actor @param {{goal:GoalInput,tasks:Array<Omit<TaskInput,"goalId">>,units?:Array<Omit<UnitInput,"goalId">>,completionTaskId:string}} [initial] */
		activateFactory(input, actor, initial) { return database.transaction(tx => Jobs.activateFactory(tx, input, actor, initial)); },
		/** @param {Record<string,unknown>} input @param {string} actor */
		observeWork(input, actor) { return database.transaction(tx => Backlog.observe(tx, input, actor)); },
		/** @param {Record<string,unknown>} input @param {string} actor */
		inspectEvidence(input, actor) { return database.transaction(tx => Backlog.inspect(tx, input, actor), false); },
		/** @param {Record<string,unknown>} input @param {string} actor */
		pullWork(input, actor) { return database.transaction(tx => Backlog.pull(tx, input, actor)); },
		/** @param {Record<string,unknown>} input @param {string} actor */
		splitWork(input, actor) { return database.transaction(tx => Backlog.split(tx, input, actor)); },
		/** @param {string} id @param {number} revision @param {unknown} direction @param {string} source @param {string} actor */
		reviseDirection(id, revision, direction, source, actor) { return database.transaction(tx => Backlog.reviseDirection(tx, id, revision, direction, source, actor)); },
		/** @param {string} actor @param {string} [goalId] */
		backlog(actor, goalId) { return database.transaction(tx => Backlog.views(tx, actor, goalId), false); },
		/** @param {string} actor @param {string} [goalId] */
		squadTurns(actor, goalId) { return database.transaction(tx => Backlog.turns(tx, actor, goalId), false); },
		/** @param {string} actor @param {string} reason @param {string} [factoryId] */
		pauseFactories(actor, reason, factoryId) { return database.transaction(tx => Jobs.pauseFactories(tx, actor, reason, factoryId)); },
		/** @param {string} goalId @param {string} actor */
		reopenCompletion(goalId, actor) { return database.transaction(tx => Jobs.reopenCompletion(tx, goalId, actor)); },
		/** @param {GoalInput} input @param {Array<Omit<TaskInput,"goalId">>} tasks @param {string} factoryId @param {string} completionTaskId @param {string} actor @param {number} [generation] @param {Array<Omit<UnitInput,"goalId">>} [units] */
		admitFactoryJob(input, tasks, factoryId, completionTaskId, actor, generation, units) { return database.transaction(tx => Jobs.admitFactoryJob(tx, input, tasks, factoryId, completionTaskId, actor, generation, false, units)); },
		/** @param {string} factoryId @param {string} actor @param {number} generation @param {string|undefined} cursor */
		updateSourceCursor(factoryId, actor, generation, cursor) { return database.transaction(tx => Jobs.updateSourceCursor(tx, factoryId, actor, generation, cursor)); },
		/** @param {string} actor @param {string} [goalId] */
		advance(actor, goalId) { return database.transaction(tx => Jobs.advance(tx, actor, goalId), false); },
		/** @param {string} factoryId @param {string} actor @param {number} generation @param {boolean} [reentry] */
		remindFactory(factoryId, actor, generation, reentry = false) { return database.transaction(tx => Jobs.remindFactory(tx, factoryId, actor, generation, reentry)); },
		/** @param {string} factoryId @param {Factory["heartbeat"]} heartbeat @param {string} actor @param {number} generation */
		recordHeartbeat(factoryId, heartbeat, actor, generation) { return database.transaction(tx => Jobs.recordHeartbeat(tx, factoryId, heartbeat, actor, generation)); },
		/** @param {string} taskId @param {string} actor @param {boolean} [execution] */
		taskForCaller(taskId, actor, execution = false) { return database.transaction(tx => Policy.taskForCaller(tx, taskId, actor, execution), false); },
		close: database.close,
		/** @param {GoalInput} input @param {string} actor @returns {Goal} */
		createGoal(input, actor) { return database.transaction(tx => Tasks.createGoal(tx, input, actor)); },
		/** @param {GoalInput} input @param {Array<Omit<TaskInput, "goalId">>} tasks @param {string} actor @param {Array<Omit<UnitInput,"goalId">>} [units] */
		createGoalWithTasks(input, tasks, actor, units = []) { return database.transaction(tx => Tasks.createGoalWithTasks(tx, input, tasks, actor, units)); },
		/** @param {UnitInput} input @param {string} actor @returns {Unit} */
		createUnit(input, actor) { return database.transaction(tx => Organization.createUnit(tx, input, actor)); },
		/** @param {TaskInput} input @param {string} actor @returns {Task} */
		createTask(input, actor) { return database.transaction(tx => Tasks.createTask(tx, input, actor)); },
		/** @param {{id?:string,sourceTaskId:string,destinationTaskId:string,consumerTaskId:string,expectedVersion:number,title:string,output:string,required?:boolean}} input @param {string} actor */
		requestCollaboration(input, actor) { return database.transaction(tx => Collaboration.requestCollaboration(tx, input, actor)); },
		/** @param {{collaborationId:string,expectedRevision:number,action:"accept"|"fulfill"|"bind"|"decline"|"block"|"cancel"|"release",reason?:string,producerTaskId?:string,producer?:Omit<TaskInput,"goalId"|"parentId"|"unitId"|"role">}} input @param {string} actor */
		respondCollaboration(input, actor) { return database.transaction(tx => Collaboration.respondCollaboration(tx, input, actor)); },
		/** @param {string} id */
		getGoal(id) { return database.transaction(tx => tx.get("goals", id), false); },
		/** @param {string} id */
		getTask(id) { return database.transaction(tx => tx.get("tasks", id), false); },
		/** @param {string} taskId @param {string} actor */
		ownsTask(taskId, actor) { return database.transaction(tx => Policy.ownsTask(tx, taskId, actor), false); },
		/** @param {string} goalId @param {string} actor */
		isNativeMember(goalId, actor) { return database.transaction(tx => Policy.isNativeMember(tx, goalId, actor), false); },
		/** @param {string} id */
		getUnit(id) { return database.transaction(tx => tx.get("units", id), false); },
		/** @param {string} id */
		getDelivery(id) { return database.transaction(tx => tx.get("deliveries", id), false); },
		/** @param {string} actor @param {string} [goalId] */
		pendingDeliveries(actor, goalId) { return database.transaction(tx => Wakes.pendingDeliveries(tx, actor, goalId), false); },
		/** @param {string} actor @param {string} [goalId] */
		openInputRequests(actor, goalId) { return database.transaction(tx => Attempts.openInputRequests(tx, actor, goalId), false); },
		/** Only invoked with explicitly observed native input clearance. @param {string} nativeId @param {string} actor @param {string} [goalId] */
		clearNativeInputs(nativeId, actor, goalId) { return database.transaction(tx => Attempts.clearNativeInputs(tx, nativeId, actor, goalId)); },
		/** @param {import("./model.d.ts").Input} input */
		outputForInput(input) { return database.transaction(tx => Tasks.outputForInput(tx, input), false); },
		/** @param {string} id */
		getAttempt(id) { return database.transaction(tx => tx.get("attempts", id), false); },
		/** @param {string} id */
		getEffect(id) { return database.transaction(tx => tx.get("effects", id), false); },
		/** @param {string} shellId @param {string} actor */
		commandForShell(shellId, actor) { return database.transaction(tx => Effects.commandForShell(tx, shellId, actor), false); },
		pendingEffects() { return database.transaction(tx => Effects.pendingEffects(tx), false); },
		/** @param {string} attemptId */
		effectsForAttempt(attemptId) { return database.transaction(tx => Effects.effectsForAttempt(tx, attemptId), false); },
		/** @param {string} callId @param {boolean} [includeSettled] */
		effectByNativeCall(callId, includeSettled = false) { return database.transaction(tx => Effects.effectByNativeCall(tx, callId, includeSettled), false); },
		/** @param {string} name */
		attemptByCreationName(name) { return database.transaction(tx => Attempts.attemptByCreationName(tx, name), false); },
		/** @param {string} actor */
		executingAttempts(actor) { return database.transaction(tx => Attempts.executingAttempts(tx, actor), false); },
		/** @param {string} token */
		attemptByToken(token) { return database.transaction(tx => Attempts.attemptByToken(tx, token), false); },
		/** @param {string} [goalId] @param {boolean} [history] @returns {import("./model.d.ts").Snapshot} */
		snapshot(goalId, history = true) { return database.transaction(tx => Context.snapshot(tx, goalId, history), false); },
		/** @param {string} actor @param {string} [goalId] @param {string} [taskId] */
		contextSnapshot(actor, goalId, taskId) { return database.transaction(tx => Context.contextSnapshot(tx, actor, goalId, taskId), false); },
		/** @param {string} actor @param {string[]} goalIds @param {number} [offset] */
		unitDirectory(actor, goalIds, offset = 0) { return database.transaction(tx => Organization.unitDirectory(tx, actor, goalIds, offset), false); },
		/** @param {string} actor @param {string} [goalId] */
		coordinationViews(actor, goalId) { return database.transaction(tx => Organization.coordinationViews(tx, actor, goalId), false); },
		/** @param {string} actor @param {string} [goalId] @param {boolean} [dispatchOnly] @returns {Task[]} */
		readyTasks(actor, goalId, dispatchOnly = false) { return database.transaction(tx => Context.readyTasks(tx, actor, goalId, dispatchOnly), false); },
		/** @param {string} taskId @param {string} actor @returns {Attempt} */
		prepareAttempt(taskId, actor) { return database.transaction(tx => Attempts.prepareAttempt(tx, taskId, actor)); },
		/** @param {string} taskId @param {string} actor @returns {Attempt} */
		startLocalTask(taskId, actor) { return database.transaction(tx => Attempts.startLocalTask(tx, taskId, actor)); },
		/** @param {string} attemptId @param {string} actor @param {string} effectId @param {Json} request @returns {Effect} */
		issueAttempt(attemptId, actor, effectId, request) { return database.transaction(tx => Effects.issueAttempt(tx, attemptId, actor, effectId, request)); },
		/** @param {string} effectId @param {string} actor @param {Json} receipt */
		rejectCreation(effectId, actor, receipt) { return database.transaction(tx => Effects.rejectCreation(tx, effectId, actor, receipt)); },
		/** @param {string} effectId @param {string} actor @param {Json} receipt */
		refuseDisabledDispatch(effectId, actor, receipt) { return database.transaction(tx => Effects.refuseDisabledDispatch(tx, effectId, actor, receipt)); },
		/** @param {string} actor */
		sharedCoordinator(actor) { return database.transaction(tx => Boolean(tx.db.prepare(`SELECT 1 FROM effects e
			JOIN attempts a ON a.id=e.attempt_id JOIN tasks t ON t.id=a.task_id WHERE a.native_id=? AND e.kind='create'
			AND json_extract(e.document,'$.request.workspace_type')='branch' AND json_extract(t.document,'$.role')='coordinator' LIMIT 1`).get(actor)), false); },
		/** @param {string} attemptId @param {string} nativeId @param {string} actor @param {Json} [receipt] @returns {Attempt} */
		bindAttempt(attemptId, nativeId, actor, receipt) { return database.transaction(tx => Attempts.bindAttempt(tx, attemptId, nativeId, actor, receipt)); },
		/** @param {Omit<Effect,"owner">} input @param {string} actor @returns {Effect} */
		recordEffect(input, actor) { return database.transaction(tx => Effects.recordEffect(tx, input, actor)); },
		/** @param {string} attemptId @param {string} actor @param {number} offset @param {string} [checkId] */
		assignmentPage(attemptId, actor, offset, checkId) { return database.transaction(tx => {
			const attempt = tx.get("attempts", attemptId);
			if (attempt.nativeId !== actor) throw new FoundryError("foreign_execution",
				`Only the bound worker can read this assignment. If binding is pending, use foundry_reconcile_native with your sessionId "${actor}" before reading again.`);
			const task = Policy.current(tx, attempt);
			if (!["running", "waiting"].includes(attempt.state)) throw new FoundryError("stale_attempt", "This assignment is no longer active");
			const check = attempt.checks.find(item => item.id === checkId);
			if (checkId !== undefined && !check) throw new FoundryError("invalid_check", "No such evaluator on this assignment");
			const body = check ? JSON.stringify(check) : text(tx.get("effects", `create:${attemptId}`).assignment, "captured assignment");
			const { content, ...page } = textPage(body, offset);
			return { taskId: task.id, attemptId, assignment: content, ...page };
		}, false); },
		/**
		 * reportedSender is a separately supplied, native-verified identity for
		 * parent-local reporting; it is never read from the result payload.
		 * @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor
		 * @param {string} [reportedSender] @returns {{result: Result, promoted: boolean}}
		 */
		recordResult(input, actor, reportedSender) { return database.transaction(tx => Results.recordResult(tx, input, actor, reportedSender)); },
		/** @param {Omit<Result, "createdAt" | "sender">} input @param {string} actor */
		recordResultAndRepair(input, actor) { return database.transaction(tx => Results.recordResultAndRepair(tx, input, actor)); },
		/** @param {string} taskId @param {string} expectedAttemptId @param {string} actor @returns {Task} */
		retryTask(taskId, expectedAttemptId, actor) { return database.transaction(tx => Attempts.retryTask(tx, taskId, expectedAttemptId, actor)); },
		/** @param {string} taskId @param {string} actor @param {Task["waiting"]} waiting @param {{attemptId:string,handledGeneration?:number,relatedIds?:string[]}} [event] @returns {Task} */
		waitTask(taskId, actor, waiting, event) { return database.transaction(tx => Attempts.waitTask(tx, taskId, actor, waiting, event)); },
		/** @param {string} actor */
		parkCoordinators(actor) { return database.transaction(tx => Organization.parkCoordinators(tx, actor)); },
		/** @param {string} actor @param {string} [attemptId] */
		assertCommandAdmission(actor, attemptId) { return database.transaction(tx => Attempts.assertCommandAdmission(tx, actor, attemptId)); },
		/** @param {string} taskId @param {string} actor @returns {Attempt} */
		resumeTask(taskId, actor) { return database.transaction(tx => Attempts.resumeTask(tx, taskId, actor)); },
		/** @param {string} taskId @param {string} actor @returns {Task[]} */
		cancelTask(taskId, actor) { return database.transaction(tx => Tasks.cancelTask(tx, taskId, actor)); },
		/** @param {{attemptId: string, surface: string, resource: string}} input @param {string} actor @returns {Claim} */
		claim(input, actor) { return database.transaction(tx => Claims.claim(tx, input, actor)); },
		/** @param {string} claimId @param {string} actor @returns {Claim} */
		releaseClaim(claimId, actor) { return database.transaction(tx => Claims.releaseClaim(tx, claimId, actor)); },
		/** @param {string} actor @param {string} [goalId] */
		retryFailedStops(actor, goalId) { return database.transaction(tx => Effects.retryFailedStops(tx, actor, goalId)); },
		/** @param {Effect[]} stops @param {string} actor */
		claimStops(stops, actor) { return database.transaction(tx => stops.flatMap(stop => {
			const current = tx.get("effects", stop.id);
			return current.kind === "stop" && current.state === "prepared"
				? [Effects.recordEffect(tx, { ...current, state: "issued" }, actor)] : [];
		})); },
		/** @param {string} owner @returns {Wake[]} */
		pendingWakes(owner) { return database.transaction(tx => Wakes.pendingWakes(tx, owner), false); },
		/** @param {string} actor @param {boolean} [capacity] @param {boolean} [includeInFlight] */
		outgoingWakes(actor, capacity = false, includeInFlight = false) { return database.transaction(tx => Wakes.outgoingWakes(tx, actor, capacity, includeInFlight), false); },
		/** @param {string} wakeId */
		wakeCanSend(wakeId) { return database.transaction(tx => Wakes.wakeCanSend(tx, wakeId), false); },
		/** @param {string} wakeId @param {string} actor */
		canRelayCollaboration(wakeId, actor) { return database.transaction(tx => Collaboration.canRelayCollaboration(tx, wakeId, actor), false); },
		/** @param {string} wakeId @param {string} actor @param {string} [origin] */
		canRelayOutput(wakeId, actor, origin) { return database.transaction(tx => Wakes.canRelayOutput(tx, wakeId, actor, origin), false); },
		/** @param {string} wakeId */
		wakeHasCurrentRecipient(wakeId) { return database.transaction(tx => Wakes.wakeHasCurrentRecipient(tx, wakeId), false); },
		/** @param {string} wakeId @param {number} generation @param {string|undefined} attemptId @param {Json} request @param {string} actor @returns {Delivery|undefined} */
		claimWakeDelivery(wakeId, generation, attemptId, request, actor) { return database.transaction(tx => Wakes.claimWakeDelivery(tx, wakeId, generation, attemptId, request, actor)); },
		/** Native queue acceptance settles only the claimed generation, never a concurrent update.
		 * @param {string} wakeId @param {string} effectId @param {number} generation @param {Json} result @param {boolean} accepted @param {string} actor @param {boolean} [unavailable] @returns {Wake}
		 */
		settleWakeDelivery(wakeId, effectId, generation, result, accepted, actor, unavailable = false) { return database.transaction(tx => Wakes.settleWakeDelivery(tx, wakeId, effectId, generation, result, accepted, actor, unavailable)); },
		/** @param {string} wakeId @param {number} generation @param {string} actor @returns {Wake} */
		consumeWake(wakeId, generation, actor) { return database.transaction(tx => Wakes.consumeWake(tx, wakeId, generation, actor)); },
		/** @param {string} wakeId @param {number} generation @param {string} actor @param {boolean} [observedOnly] @returns {Wake} */
		markWakeSent(wakeId, generation, actor, observedOnly = false) { return database.transaction(tx => Wakes.markWakeSent(tx, wakeId, generation, actor, observedOnly), !observedOnly); },
		/** @param {string} taskId @param {string} newOwner @param {string} actor @returns {Task} */
		reassignTask(taskId, newOwner, actor) { return database.transaction(tx => Tasks.reassignTask(tx, taskId, newOwner, actor)); },
		/** @param {string} unitId @param {string} newOwner @param {string} actor */
		reassignUnit(unitId, newOwner, actor) { return database.transaction(tx => Organization.reassignUnit(tx, unitId, newOwner, actor)); },
		/** @param {string} taskId @param {string} attemptId @param {string} newOwner @param {string} actor @param {boolean} [unavailable] */
		handoffTask(taskId, attemptId, newOwner, actor, unavailable = false) { return database.transaction(tx => Attempts.handoffTask(tx, taskId, attemptId, newOwner, actor, unavailable)); },
		/** @param {{taskId:string,expectedVersion:number,checks?:import("./model.d.ts").Check[],inputs?:import("./model.d.ts").Input[]}} input @param {string} actor */
		evolveTask(input, actor) { return database.transaction(tx => Tasks.evolveTask(tx, input, actor)); },
		/** @param {string} id @param {string} observedAt @returns {import("./model.d.ts").UsageAffinity|undefined} */
		usageAffinity(id, observedAt) {
			const observed = Date.parse(text(observedAt, "native event timestamp"));
			if (!Number.isFinite(observed)) throw new FoundryError("invalid_field", "Native usage must retain its actual timestamp");
			return database.transaction(tx => Usage.usageAffinity(tx, id, observed), false);
		},
		/** @param {string} id @param {string} actor @param {string} [token] @param {{id: string,timestamp: string}} [request] */
		captureUsageAffinity(id, actor, token, request) { return database.transaction(tx => Usage.captureUsageAffinity(tx, id, actor, token, request)); },
		/** @param {import("./model.d.ts").NativeUsage} input @param {string} actor @param {boolean} [idle] */
		recordNativeUsage(input, actor, idle = false) { return database.transaction(tx => Usage.recordNativeUsage(tx, input, actor, idle)); },
		/** @param {string} actor @param {string[]} goalIds */
		accounting(actor, goalIds) { return database.transaction(tx => Usage.accounting(tx, actor, goalIds), false); },
		/** @param {string} attemptId @param {number} credits @param {string} eventId @param {string} actor @returns {Goal} */
		recordUsage(attemptId, credits, eventId, actor) { return database.transaction(tx => Usage.recordUsage(tx, attemptId, credits, eventId, actor)); },
		/** @param {Omit<Signal,"id"> & {id?: string}} input @param {string} actor @returns {Signal} */
		recordSignal(input, actor) { return database.transaction(tx => Feedback.recordSignal(tx, input, actor)); },
		/** @param {Omit<Lesson,"id"> & {id?: string}} input @param {string} actor @returns {Lesson} */
		recordLesson(input, actor) { return database.transaction(tx => Feedback.recordLesson(tx, input, actor)); },
		/** @param {string} attemptId @returns {Result[]} */
		resultsForAttempt(attemptId) { return database.transaction(tx => Results.resultsForAttempt(tx, attemptId), false); },
		/** @param {string} attemptId @param {string} [effectId] @returns {import("./model.d.ts").Evidence[]} */
		evidenceForAttempt(attemptId, effectId) { return database.transaction(tx => Results.evidenceForAttempt(tx, attemptId, effectId), false); },
		/** @param {string} goalId @param {string} workType @returns {Lesson[]} */
		lessonsFor(goalId, workType) { return database.transaction(tx => Context.lessonsFor(tx, goalId, workType), false); },
	};
}

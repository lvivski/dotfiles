import {
	FoundryError, array, boolean, choice, closedFields, decodeCheck, decodeDispatch, decodeEvidence, decodeFinding,
	decodeInput, decodeLimits, decodeOutput, decodeScope, decodeSource, decodeWaiting, json, natural, number, optionalText,
	positive, record, resourcePath, strings, text,
} from "./values.mjs";

/** @typedef {import("./model.d.ts").Json} Json */
/** @typedef {import("./model.d.ts").Goal} Goal */
/** @typedef {import("./model.d.ts").Unit} Unit */
/** @typedef {import("./model.d.ts").Collaboration} Collaboration */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Effect} Effect */
/** @typedef {import("./model.d.ts").Result} Result */
/** @typedef {import("./model.d.ts").Claim} Claim */
/** @typedef {import("./model.d.ts").Wake} Wake */
/** @typedef {import("./model.d.ts").Signal} Signal */
/** @typedef {import("./model.d.ts").Lesson} Lesson */
/** @typedef {import("./model.d.ts").Delivery} Delivery */
/** @typedef {{id?: string, title: string, projectId?: string, scope: import("./model.d.ts").Scope, limits?: import("./model.d.ts").Limits, source?: Goal["source"]}} GoalInput */
/** @typedef {{id?: string, goalId: string, parentId?: string, unitId?: string, role?:Task["role"], title: string, assignment: string, dispatch?: Task["dispatch"], workType: string, scope?: unknown, checks?: import("./model.d.ts").Check[], inputs?: import("./model.d.ts").Input[]}} TaskInput */
/** @typedef {{id?:string,goalId:string,name:string,context?:string[],parentId?:string,taskId?:string,kind?:string}} UnitInput */
/** @typedef {import("./model.d.ts").FactoryControl} Factory */
/** @typedef {import("./model.d.ts").GoalCompletion} Completion */
/** @typedef {{goals: Goal, units: Unit, collaborations: Collaboration, tasks: Task, attempts: Attempt, effects: Effect, claims: Claim, wakes: Wake, signals: Signal, lessons: Lesson, results: Result, deliveries: Delivery, native_usage: import("./model.d.ts").NativeUsage, usage_affinity: import("./model.d.ts").UsageAffinity, factory_controls: Factory, goal_completions: Completion}} Records */
/** @typedef {keyof Records} Table */

/** @param {unknown} value @returns {Goal} */
export function decodeGoal(value) {
	const row = record(value);
	const projectId = optionalText(row.projectId, "goal.projectId");
	const source = row.source === undefined ? undefined : decodeSource(row.source);
	return {
		id: text(row.id, "goal.id"), title: text(row.title, "goal.title"), owner: text(row.owner, "goal.owner"),
		scope: decodeScope(row.scope), limits: decodeLimits(row.limits),
		credits: number(row.credits, "goal.credits"), createdAt: text(row.createdAt, "goal.createdAt"),
		...(projectId === undefined ? {} : { projectId }),
		...(source === undefined ? {} : { source }),
	};
}

/** @param {unknown} value @returns {Unit} */
export function decodeUnit(value) {
	const row = record(value);
	return {
		id: text(row.id, "unit.id"), goalId: text(row.goalId, "unit.goalId"), name: text(row.name, "unit.name"),
		owner: text(row.owner, "unit.owner"), context: strings(row.context),
		...(row.parentId === undefined ? {} : { parentId: text(row.parentId, "parent unit") }),
		...(row.taskId === undefined ? {} : { taskId: text(row.taskId, "unit task boundary") }),
		...(row.kind === undefined ? {} : { kind: text(row.kind, "unit kind") }),
	};
}

/** @param {unknown} value @returns {Task} */
export function decodeTask(value) {
	const row = record(value);
	const parentId = optionalText(row.parentId, "task.parentId");
	const unitId = optionalText(row.unitId, "task.unitId");
	const currentAttemptId = optionalText(row.currentAttemptId, "task.currentAttemptId");
	const waiting = decodeWaiting(row.waiting);
	return {
		id: text(row.id, "task.id"), goalId: text(row.goalId, "task.goalId"), owner: text(row.owner, "task.owner"),
		title: text(row.title, "task.title"), assignment: text(row.assignment, "task.assignment"),
		role: choice(row.role ?? "producer", ["producer", "coordinator"], "task.role"),
		...(row.coordination === undefined ? {} : { coordination: decodeCoordination(row.coordination) }),
		...(row.dispatch === undefined ? {} : { dispatch: decodeDispatch(row.dispatch) }),
		workType: text(row.workType, "task.workType"), scope: decodeScope(row.scope),
		checks: array(row.checks, decodeCheck), inputs: array(row.inputs, decodeInput), outputs: array(row.outputs, decodeOutput),
		state: choice(row.state, /** @type {const} */ (["ready", "running", "waiting", "blocked", "failed", "done", "cancelled"]), "task.state"),
		version: natural(row.version, "task.version"),
		...(row.repairs === undefined ? {} : { repairs: natural(row.repairs, "task.repairs") }),
		...(row.repairReservation === undefined ? {} : { repairReservation: {
			attemptId: text(record(row.repairReservation).attemptId, "reserved failed attempt"),
			worker: text(record(row.repairReservation).worker, "reserved repair worker"),
		} }),
		...(parentId === undefined ? {} : { parentId }), ...(unitId === undefined ? {} : { unitId }),
		...(currentAttemptId === undefined ? {} : { currentAttemptId }), ...(waiting === undefined ? {} : { waiting }),
	};
}

/** @param {unknown} value @returns {Attempt} */
export function decodeAttempt(value) {
	const row = record(value);
	const nativeId = optionalText(row.nativeId, "attempt.nativeId");
	const repairOf = optionalText(row.repairOf, "attempt.repairOf");
	return {
		id: text(row.id, "attempt.id"), taskId: text(row.taskId, "attempt.taskId"), token: text(row.token, "attempt.token"),
		creator: text(row.creator, "attempt.creator"),
		state: choice(row.state, /** @type {const} */ (["prepared", "issued", "running", "waiting", "done", "failed", "cancelled", "uncertain"]), "attempt.state"),
		taskVersion: natural(row.taskVersion, "attempt.taskVersion"), checks: array(row.checks, decodeCheck),
		inputs: array(row.inputs, decodeInput), slot: boolean(row.slot, "attempt.slot"),
		createdAt: text(row.createdAt, "attempt.createdAt"),
		...(nativeId === undefined ? {} : { nativeId }), ...(repairOf === undefined ? {} : { repairOf }),
		...(row.assignedOwner === undefined ? {} : { assignedOwner: text(row.assignedOwner, "assigned coordinator") }),
		...(row.endedBy === undefined ? {} : { endedBy: text(row.endedBy, "attempt terminator") }),
		...(row.supersededBy === undefined ? {} : { supersededBy: text(row.supersededBy, "superseding owner") }),
		...(row.baseCommit === undefined ? {} : { baseCommit: text(row.baseCommit, "execution baseline") }),
		...(row.startCommit === undefined ? {} : { startCommit: text(row.startCommit, "conserved execution base") }),
		...(row.executionDirectory === undefined ? {} : { executionDirectory: text(row.executionDirectory, "actual executing worktree") }),
		...(row.waiting === undefined ? {} : { waiting: decodeWaiting(row.waiting) }),
	};
}

/** @param {unknown} value @returns {Effect} */
export function decodeEffect(value) {
	const row = record(value);
	return {
		id: text(row.id, "effect.id"), attemptId: text(row.attemptId, "effect.attemptId"),
		kind: choice(row.kind, /** @type {const} */ (["create", "command", "stop"]), "effect.kind"),
		state: choice(row.state, /** @type {const} */ (["prepared", "issued", "settled", "uncertain"]), "effect.state"),
		owner: text(row.owner, "effect.owner"), request: json(row.request),
		...(row.result === undefined ? {} : { result: json(row.result) }),
		...(row.relatedAttemptIds === undefined ? {} : { relatedAttemptIds: strings(row.relatedAttemptIds) }),
		...(row.factoryGeneration === undefined ? {} : { factoryGeneration: natural(row.factoryGeneration, "effect activation") }),
	};
}

/** @param {unknown} value @returns {Result} */
export function decodeResult(value) {
	const row = record(value);
	return {
		id: text(row.id, "result.id"), attemptId: text(row.attemptId, "result.attemptId"),
		sender: text(row.sender, "result.sender"),
		state: choice(row.state, /** @type {const} */ (["done", "failed", "blocked"]), "result.state"),
		summary: text(row.summary, "result.summary"), outputs: array(row.outputs, decodeOutput),
		evidence: array(row.evidence, decodeEvidence), findings: array(row.findings, decodeFinding),
		createdAt: text(row.createdAt, "result.createdAt"),
		...(row.reportedBy === undefined ? {} : { reportedBy: text(row.reportedBy, "result reporter") }),
	};
}

/** @param {unknown} value @returns {Claim} */
export function decodeClaim(value) {
	const row = record(value);
	return { id: text(row.id, "claim.id"), attemptId: text(row.attemptId, "claim.attemptId"),
		surface: text(row.surface, "claim.surface"), resource: resourcePath(row.resource) };
}

/** @param {unknown} value @returns {Wake} */
export function decodeWake(value) {
	const row = record(value);
	const sent = row.sent === undefined ? undefined : natural(row.sent, "wake.sent");
	return {
		id: text(row.id, "wake.id"), owner: text(row.owner, "wake.owner"), goalId: text(row.goalId, "wake.goalId"),
		generation: natural(row.generation, "wake.generation"), consumed: natural(row.consumed, "wake.consumed"),
		reason: text(row.reason, "wake.reason"),
		...(row.relatedReasons === undefined ? {} : { relatedReasons: strings(row.relatedReasons) }),
		...(row.inFlight === undefined ? {} : { inFlight: text(row.inFlight, "wake delivery effect") }),
		...(sent === undefined ? {} : { sent }),
		...(row.unavailable === undefined ? {} : { unavailable: {
			effectId: text(record(row.unavailable).effectId, "failed delivery"),
			generation: natural(record(row.unavailable).generation, "failed generation"),
			fallback: text(record(row.unavailable).fallback, "fallback owner"),
			message: text(record(row.unavailable).message, "delivery failure"),
		} }),
	};
}

/** @param {unknown} value @returns {Signal} */
export function decodeSignal(value) {
	const row = record(value);
	const taskId = optionalText(row.taskId, "signal.taskId");
	return { id: text(row.id, "signal.id"), goalId: text(row.goalId, "signal.goalId"),
		kind: text(row.kind, "signal.kind"), summary: text(row.summary, "signal.summary"), references: strings(row.references),
		...(taskId === undefined ? {} : { taskId }),
		...(row.unitId === undefined ? {} : { unitId: text(row.unitId, "signal.unitId") }) };
}

/** @param {unknown} value @returns {Lesson} */
export function decodeLesson(value) {
	const row = record(value);
	return { id: text(row.id, "lesson.id"), goalId: text(row.goalId, "lesson.goalId"),
		workType: text(row.workType, "lesson.workType"), summary: text(row.summary, "lesson.summary"),
		references: strings(row.references) };
}

/** @param {unknown} value @returns {Delivery} */
export function decodeDelivery(value) {
	const row = record(value);
	return { id: text(row.id, "delivery"), goalId: text(row.goalId, "delivery goal"), wakeId: text(row.wakeId, "wake"),
		generation: natural(row.generation, "delivery generation"), owner: text(row.owner, "native sender"),
		state: choice(row.state, ["issued", "settled"], "delivery state"), request: json(row.request),
		...(row.attemptId === undefined ? {} : { attemptId: text(row.attemptId, "delivery attempt") }),
		...(row.result === undefined ? {} : { result: json(row.result) }) };
}

/** @param {unknown} value @returns {import("./model.d.ts").Coordination} */
export function decodeCoordination(value) {
	const item = record(value);
	const disposition = item.disposition === undefined ? undefined : record(item.disposition);
	const generation = natural(item.generation, "coordination generation");
	const handled = natural(item.handled, "handled generation");
	if (handled > generation || disposition && natural(disposition.generation, "disposition generation") > handled
		|| item.escalated !== undefined && natural(item.escalated, "escalated generation") > generation) {
		throw new FoundryError("invalid_field", "Handled, disposed and escalated work cannot exceed its recorded generation");
	}
	return {
		generation, handled,
		causes: strings(item.causes),
		...(item.escalated === undefined ? {} : { escalated: natural(item.escalated, "escalated generation") }),
		...(disposition === undefined ? {} : { disposition: {
			generation: natural(disposition.generation, "disposition generation"),
			reason: text(disposition.reason, "coordination disposition"), relatedIds: strings(disposition.relatedIds),
		} }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").Collaboration} */
export function decodeCollaboration(value) {
	const item = record(value);
	return {
		id: text(item.id, "collaboration id"), goalId: text(item.goalId, "source goal"),
		destinationGoalId: text(item.destinationGoalId, "destination goal"),
		sourceTaskId: text(item.sourceTaskId, "source coordinator"), destinationTaskId: text(item.destinationTaskId, "destination coordinator"),
		consumerTaskId: text(item.consumerTaskId, "consumer task"), sourceOwner: text(item.sourceOwner, "proposal owner"),
		sourceVersion: positive(item.sourceVersion, "source version"), destinationVersion: positive(item.destinationVersion, "destination version"),
		consumerVersion: positive(item.consumerVersion, "consumer version"),
		title: text(item.title, "requested outcome"), output: text(item.output, "requested output"), required: boolean(item.required, "required prerequisite"),
		revision: positive(item.revision, "collaboration revision"),
		state: choice(item.state, ["proposed", "accepted", "blocked", "fulfilled", "declined", "cancelled"], "collaboration state"),
		proposal: text(item.proposal, "proposal identity"), bound: boolean(item.bound, "bound prerequisite"),
		...(item.lastAction === undefined ? {} : { lastAction: text(item.lastAction, "last collaboration action") }),
		...(item.producerTaskId === undefined ? {} : { producerTaskId: text(item.producerTaskId, "producer task") }),
		...(item.delivery === undefined ? {} : { delivery: decodeInput(item.delivery) }),
		...(item.reason === undefined ? {} : { reason: text(item.reason, "collaboration reason") }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").UsageAffinity} */
export function decodeUsageAffinity(value) {
	const row = record(value);
	const startedAt = text(row.startedAt, "native request start");
	if (!Number.isFinite(Date.parse(startedAt))) throw new FoundryError("invalid_field", "Native request start must be an actual timestamp");
	return { id: text(row.id, "affinity id"), groupId: text(row.groupId, "native affinity group"),
		startedAt: new Date(startedAt).toISOString(), nativeId: text(row.nativeId, "native session"),
		attemptIds: strings(row.attemptIds), ...(row.token === undefined ? {} : { token: text(row.token, "assignment token") }) };
}

/** @param {unknown} value @returns {import("./model.d.ts").NativeUsage} */
export function decodeNativeUsage(value) {
	const row = record(value);
	const credits = row.credits === undefined ? undefined : number(row.credits, "observed credits");
	const debitedCredits = row.debitedCredits === undefined ? undefined : number(row.debitedCredits, "debited credits");
	if ((credits !== undefined && credits < 0) || (debitedCredits !== undefined && debitedCredits < 0)) {
		throw new FoundryError("invalid_field", "Native charges cannot be negative or refunded");
	}
	const billing = row.billing;
	if (billing !== "complete" && billing !== "partial" && billing !== "unavailable") throw new FoundryError("invalid_field", "Unknown native billing status");
	return { id: text(row.id, "native usage id"), nativeId: text(row.nativeId, "native session"),
		sourceSessionId: text(row.sourceSessionId, "accounting source"), aliases: strings(row.aliases),
		attemptIds: strings(row.attemptIds), billing,
		...(row.sequence === undefined ? {} : { sequence: natural(row.sequence, "usage sequence") }),
		...(credits === undefined ? {} : { credits }),
		...(debitedCredits === undefined ? {} : { debitedCredits }),
		...(row.token === undefined ? {} : { token: text(row.token, "assignment token") }),
		...(row.attemptId === undefined ? {} : { attemptId: text(row.attemptId, "attempt id") }),
		...(row.goalId === undefined ? {} : { goalId: text(row.goalId, "goal id") }) };
}

/** @param {unknown} value @returns {import("./model.d.ts").FactoryControl} */
export function decodeFactory(value) {
	const row = record(value);
	const mechanism = choice(row.mechanism, ["native", "stop-hook"], "continuation mechanism");
	const origins = row.settingOrigins === undefined ? undefined : record(row.settingOrigins);
	if (origins) closedFields(origins, ["maximumJobs", ...(mechanism === "native" ? [] : ["blocks"])], "factory setting origins");
	const heartbeat = row.heartbeat === undefined ? undefined : record(row.heartbeat);
	const request = heartbeat === undefined ? undefined : record(heartbeat.request);
	const reminders = Object.fromEntries(Object.entries(record(row.reminders)).map(([id, value]) => {
		const reminder = record(value);
		return [id, { marker: text(reminder.marker, "progress marker"), count: natural(reminder.count, "reminder count"),
			generation: natural(reminder.generation, "reminder generation") }];
	}));
	return {
		id: text(row.id, "factory id"), owner: text(row.owner, "factory owner"),
		state: choice(row.state, ["active", "paused"], "factory state"),
		generation: positive(row.generation, "activation generation"),
		mechanism,
		source: decodeSource(row.source), definition: json(row.definition),
		maximumJobs: positive(row.maximumJobs, "maximum concurrent jobs"),
		...(row.blocks === undefined && mechanism === "native" ? {} : { blocks: positive(row.blocks, "stop-hook continuation blocks") }),
		...(origins === undefined ? {} : { settingOrigins: {
			maximumJobs: choice(origins.maximumJobs, ["policy", "default"], "maximumJobs origin"),
			...(mechanism === "native" ? {} : { blocks: choice(origins.blocks, /** @type {const} */ (["policy", "default"]), "blocks origin") }),
		} }),
		pausedWorkers: strings(row.pausedWorkers), reminders,
		...(row.unchangedFailures === undefined ? {} : { unchangedFailures: positive(row.unchangedFailures, "unchanged failures") }),
		...(row.aggregateRepairs === undefined ? {} : { aggregateRepairs: natural(row.aggregateRepairs, "aggregate repairs") }),
		...(heartbeat === undefined || request === undefined ? {} : { heartbeat: {
			state: choice(heartbeat.state, ["issued", "bound", "uncertain"], "heartbeat state"),
			generation: positive(heartbeat.generation, "heartbeat generation"),
			request: { interval: choice(request.interval, ["minutes"], "heartbeat cadence"),
				every_minutes: positive(request.every_minutes, "heartbeat minutes"), prompt: text(request.prompt, "heartbeat prompt") },
			...(heartbeat.id === undefined ? {} : { id: text(heartbeat.id, "native heartbeat identity") }),
			...(heartbeat.receipt === undefined ? {} : { receipt: json(heartbeat.receipt) }),
		} }),
		...(row.sourceCursor === undefined ? {} : { sourceCursor: text(row.sourceCursor, "native source cursor") }),
		...(row.reason === undefined ? {} : { reason: text(row.reason, "pause reason") }),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").GoalCompletion} */
export function decodeCompletion(value) {
	const row = record(value);
	if (typeof row.closed !== "boolean") throw new FoundryError("invalid_field", "Completion closure must be boolean");
	const accepted = row.accepted === undefined ? undefined : record(row.accepted);
	return {
		id: text(row.id, "completion id"), goalId: text(row.goalId, "completion goal"), owner: text(row.owner, "completion owner"),
		taskId: text(row.taskId, "completion task"), factoryId: text(row.factoryId, "completion factory"),
		revision: positive(row.revision, "closure revision"), closed: row.closed,
		requiredInputs: array(row.requiredInputs, decodeInput), repairs: natural(row.repairs, "aggregate repairs"),
		...(accepted === undefined ? {} : { accepted: {
			revision: positive(accepted.revision, "accepted closure"),
			tasks: array(accepted.tasks, value => {
				const item = record(value);
				return { id: text(item.id, "required task"), version: positive(item.version, "required version"),
					inputs: array(item.inputs, decodeInput) };
			}),
		} }),
	};
}

/** @type {{[K in Table]: (value: unknown) => Records[K]}} */
export const decoders = {
	goals: decodeGoal, units: decodeUnit, tasks: decodeTask, attempts: decodeAttempt, effects: decodeEffect,
	collaborations: decodeCollaboration,
	claims: decodeClaim, wakes: decodeWake, signals: decodeSignal, lessons: decodeLesson, results: decodeResult, deliveries: decodeDelivery,
	native_usage: decodeNativeUsage, usage_affinity: decodeUsageAffinity,
	factory_controls: decodeFactory, goal_completions: decodeCompletion,
};

import { FoundryError, array, boolean, choice, closedFields, decodeScope, json, natural, positive, record, strings, text } from "./values.mjs";

/** @param {unknown} value @returns {import("./model.d.ts").Direction} */
export function decodeDirection(value) {
	const input = record(value);
	closedFields(input, ["revision", "outcomes", "nonGoals", "constraints"], "direction");
	const outcomes = array(input.outcomes, value => {
		const row = record(value);
		closedFields(row, ["id", "title", "priority", "success"], "direction outcome");
		return { id: text(row.id, "outcome id"), title: text(row.title, "desired outcome"),
			priority: positive(row.priority, "outcome priority"), success: text(row.success, "observable success") };
	});
	if (new Set(outcomes.map(outcome => outcome.id)).size !== outcomes.length) throw new FoundryError("duplicate_outcome", "Direction outcome IDs must be unique");
	return { revision: positive(input.revision, "direction revision"), outcomes, nonGoals: strings(input.nonGoals), constraints: strings(input.constraints) };
}

/** @param {unknown} value @returns {import("./model.d.ts").DirectionRecord} */
export function directionRecord(value) {
	const row = record(value);
	const direction = decodeDirection(row.direction);
	return { id: text(row.id, "direction id"), factoryId: text(row.factoryId, "factory"), ...direction,
		direction, source: text(row.source, "pinned source hash") };
}

/** @param {unknown} value @returns {import("./model.d.ts").Squad} */
export function squadRecord(value) {
	const row = record(value);
	return { id: text(row.id, "squad id"), factoryId: text(row.factoryId, "factory"), name: text(row.name, "charter"),
		goalId: text(row.goalId, "subscription goal"), taskId: text(row.taskId, "subscription coordinator"),
		outcomes: strings(row.outcomes), templates: strings(row.templates), scope: decodeScope(row.scope),
		discoveryLimit: natural(row.discoveryLimit, "question allowance"), questions: natural(row.questions, "questions used"),
		generation: positive(row.generation, "generation"), handled: natural(row.handled, "handled generation"),
		reason: text(row.reason, "discovery trigger or wait"), revision: positive(row.revision, "direction revision") };
}

/** @param {unknown} value @returns {import("./model.d.ts").BacklogItem} */
export function itemRecord(value) {
	const row = record(value);
	return { id: text(row.id, "work item"), factoryId: text(row.factoryId, "factory"), squad: text(row.squad, "squad"),
		outcome: text(row.outcome, "outcome"), gapKey: text(row.gapKey, "gap identity"), kind: choice(row.kind, ["gap", "question", "advisory"], "observation"),
		state: choice(row.state, ["proposal", "queued", "admitted", "accepted", "retired"], "queue state"),
		revision: positive(row.revision, "admitted direction"), currentRevision: positive(row.currentRevision, "assessed direction"),
		template: text(row.template, "acceptance template"), title: text(row.title, "work title"), gap: text(row.gap, "observed gap"),
		improvement: text(row.improvement, "improvement"), stop: text(row.stop, "stopping condition"),
		evidence: array(row.evidence, json), observations: array(row.observations ?? [], json), scope: decodeScope(row.scope), dependencies: strings(row.dependencies),
		sources: Object.fromEntries(Object.entries(record(row.sources ?? {})).map(([output, id]) => [output, text(id, "source item")])),
		owner: text(row.owner, "observing native owner"), createdAt: text(row.createdAt, "admission time"),
		severity: natural(row.severity, "severity"), cost: positive(row.cost, "cost"),
		...(row.predecessor === undefined ? {} : { predecessor: text(row.predecessor, "accepted predecessor") }),
		...(row.reason === undefined ? {} : { reason: text(row.reason, "disposition") }),
		...(row.goalId === undefined ? {} : { goalId: text(row.goalId, "bounded job") }),
		...(row.resultId === undefined ? {} : { resultId: text(row.resultId, "acceptance result") }),
		capacityReleased: boolean(row.capacityReleased ?? false, "bounded job capacity released"),
		producers: producers(row.producers),
	};
}

/** @param {unknown} value @returns {import("./model.d.ts").BacklogItem["producers"]} */
export function producers(value) {
	return array(value, entry => {
		const p = record(entry);
		closedFields(p, ["template", "output", "purpose", "inputs"], "milestone producer");
		return { template: text(p.template, "producer template"), output: text(p.output, "named output"),
			purpose: text(p.purpose, "producer purpose"), inputs: [...new Set(strings(p.inputs ?? []))] };
	});
}

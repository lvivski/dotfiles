import { FoundryError, choice, decodeInput, natural, positive, record, strings, text, boolean } from "./values.mjs";

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

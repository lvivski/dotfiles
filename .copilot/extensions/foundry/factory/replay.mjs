import { abandonPlan, activateEvaluationPlan, bindPlan, recordCompletion, recordEvaluationCompletion } from "./bindings.mjs";
import { decideCandidate, prepareCandidate, recordDelivery } from "./candidates.mjs";
import { recordEvaluation } from "./evaluation.mjs";
import { fail, integer, object, timestamp } from "./fields.mjs";
import { acceptContract, appendKnowledge, createUnit, ingestAnalysis } from "./knowledge.mjs";
import { same } from "./records.mjs";
import { compactFactory, retire } from "./retention.mjs";
import { recordSignal } from "./signals.mjs";

/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */
/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryDocument} FactoryDocument */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").FactoryAction} FactoryAction */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

export const FACTORY_FORMAT = "foundry-factory-v2";

/** @returns {FactoryState} */
function emptyState() {
	return { units: [], knowledge: [], contracts: [], candidates: [], decisions: [], signals: [], renewals: [], retirements: [], compactions: [], bindings: [] };
}

/**
 * @template {FactoryAction} A
 * @overload
 * @param {FactoryState} state
 * @param {import("../types/factory.js").FactoryEvent<A>} event
 * @param {{historical?: boolean}} [options]
 * @returns {FactoryResults[A]}
 */
/** Apply one attributed event; old incomplete bindings remain inspectable, not proof of process origin.
 * @param {FactoryState} state @param {FactoryEvent} event @param {{historical?: boolean}} [options]
 * @returns {FactoryResults[FactoryAction]}
 */

export function applyEvent(state, event, options = {}) {
	switch (event.action) {
		case "createUnit":
			return createUnit(state, event, options);
		case "appendKnowledge":
			return appendKnowledge(state, event, options);
		case "acceptContract":
			return acceptContract(state, event, options);
		case "prepareCandidate":
			return prepareCandidate(state, event, options);
		case "bindPlan":
		case "bindEvaluationPlan":
			return bindPlan(state, event, options);
		case "activateEvaluationPlan":
			return activateEvaluationPlan(state, event, options);
		case "recordDelivery":
			return recordDelivery(state, event, options);
		case "recordEvaluation":
			return recordEvaluation(state, event, options);
		case "recordCompletion":
			return recordCompletion(state, event, options);
		case "recordEvaluationCompletion":
			return recordEvaluationCompletion(state, event, options);
		case "abandonPlan":
			return abandonPlan(state, event, options);
		case "decideCandidate":
			return decideCandidate(state, event, options);
		case "recordSignal":
			return recordSignal(state, event, options);
		case "ingestAnalysis":
			return ingestAnalysis(state, event, options);
		case "retire":
			return retire(state, event, options);
		case "compactFactory":
			return compactFactory(state, event, options);
		default: fail("factory_action_invalid", `Unknown factory action ${event.action}`);
	}
}

/** @param {FactoryDocument} document @param {RepositoryIdentity} identity */
export function replay(document, identity) {
	object(document, ["format", "repository", "revision", "events"], "factory document");
	if (document.format !== FACTORY_FORMAT) fail("factory_format_unsupported", "Only the current factory format is supported");
	if (!same(document.repository, identity)) fail("factory_repository_mismatch", "Factory JSON belongs to another canonical repository");
	integer(document.revision, "factory revision", 0);
	const events = document.events;
	if (document.revision !== events.length) fail("factory_revision_invalid", "Factory revision must equal the immutable event count");
	const state = emptyState();
	let previous = "";
	for (const [index, event] of events.entries()) {
		if (Buffer.byteLength(JSON.stringify(event)) > 128 * 1024) fail("factory_input_invalid", "Factory event exceeds 128 KiB");
		object(event, ["revision", "at", "action", "input"], "factory event");
		if (event.revision !== index + 1) fail("factory_revision_invalid", "Factory event revisions must be contiguous");
		timestamp(event.at, "event.at");
		if (previous && event.at < previous) fail("factory_time_invalid", "Factory events must be causally ordered");
		previous = event.at;
		applyEvent(state, event, { historical: true });
	}
	return state;
}

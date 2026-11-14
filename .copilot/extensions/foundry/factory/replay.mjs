import { abandonPlan, activateEvaluationPlan, bindPlan, recordCompletion, recordEvaluationCompletion } from "./bindings.mjs";
import { decideCandidate, prepareCandidate, recordDelivery } from "./candidates.mjs";
import { recordEvaluation } from "./evaluation.mjs";
import { digest, fail, integer, list, object, timestamp } from "./fields.mjs";
import { acceptContract, appendKnowledge, createUnit, ingestAnalysis } from "./knowledge.mjs";
import { same } from "./records.mjs";
import { compactFactory, retire } from "./retention.mjs";
import { recordSignal } from "./signals.mjs";
import { applyOperatingPublication, validateOperatingRules } from "./operating.mjs";
import { validateSquads } from "./squads.mjs";
import { validateGoals } from "./goals.mjs";
import { operatingPublication } from "../plan/schemas/operating.mjs";

/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */
/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryDocument} FactoryDocument */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").FactoryAction} FactoryAction */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

export const FACTORY_FORMAT = "foundry-factory-v2";
/** @type {readonly FactoryAction[]} */
export const FACTORY_ACTIONS = Object.freeze(["createUnit", "appendKnowledge", "acceptContract", "prepareCandidate",
	"bindPlan", "bindEvaluationPlan", "activateEvaluationPlan", "recordDelivery", "recordEvaluation",
	"recordCompletion", "recordEvaluationCompletion", "abandonPlan", "decideCandidate",
	"recordSignal", "ingestAnalysis", "retire", "compactFactory", "checkpoint", "recordOperating"]);

/** Canonical policy cannot be replaced by an adapter's optional extra checks.
 * @param {import("../types/factory.js").FactorySnapshot} state
 * @param {import("../types/operating.js").OperatingBatch} batch
 * @param {import("../types/operating.js").OperatingRules} [additional] */
export function validateCanonicalOperating(state, batch, additional) {
	validateOperatingRules(state, batch, { charters: validateSquads, goals: validateGoals });
	if (additional) validateOperatingRules(state, batch, { charters() {}, goals() {}, ...additional });
}

/** Service-owned metadata must be identical in prospective validation and persistence.
 * @param {FactoryAction} action @param {Record<string, unknown>} input */
export function prepareCommand(action, input) {
	const prepared = { ...input };
	if (action === "acceptContract") {
		prepared.sealVersion = 3;
		prepared.lineageVersion = 2;
	}
	if (action === "ingestAnalysis") prepared.derivationVersion = 2;
	if (action === "appendKnowledge" && isRecord(prepared.source)) prepared.sourceCommitment = analysisInputDigest(prepared.source);
	if (action === "appendKnowledge" && typeof prepared.statement === "string") prepared.statementCommitment = analysisInputDigest(prepared.statement);
	return prepared;
}

/** @returns {FactoryState} */
function emptyState() {
	return { units: [], knowledge: [], contracts: [], candidates: [], decisions: [], signals: [], renewals: [], retirements: [], compactions: [], bindings: [] };
}

/**
 * @template {FactoryAction} A
 * @overload
 * @param {FactoryState} state
 * @param {import("../types/factory.js").FactoryEvent<A>} event
 * @param {{historical?: boolean, portable?: boolean}} [options]
 * @returns {FactoryResults[A]}
 */
/** Apply one attributed event; old incomplete bindings remain inspectable, not proof of process origin.
 * @param {FactoryState} state @param {FactoryEvent} event @param {{historical?: boolean, portable?: boolean}} [options]
 * @returns {FactoryResults[FactoryAction]}
 */

export function applyEvent(state, event, options = {}) {
	switch (event.action) {
		case "recordOperating":
			return applyOperatingPublication(state, event.input);
		case "checkpoint":
			if (!options.historical || !options.portable) fail("factory_action_invalid", "Private checkpoints are historical portable knowledge, not executable authority");
			object(event.input, ["digest", "knowledge"], "checkpoint");
			for (const input of list(event.input.knowledge ?? [], "checkpoint knowledge")) {
				object(input, ["id", "unitId", "kind", "statement", "source", "links", "uncertainty", "evaluation", "sourceCommitment", "statementCommitment"], "private knowledge");
				if (input.kind !== "observation") fail("factory_context_invalid", "Private checkpoints retain observations, never governing acceptance");
				appendKnowledge(state, { ...event, action: "appendKnowledge", input }, options);
			}
			return { retainedDigest: digest(event.input.digest, "checkpoint.digest") };
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
	object(document, ["format", "repository", "revision", "events", "portable"], "factory document");
	if (document.format !== FACTORY_FORMAT) fail("factory_format_unsupported", "Only the current factory format is supported");
	if (document.portable !== undefined && document.portable !== true) fail("factory_format_unsupported", "Portable knowledge must declare its historical projection");
	if (!same(document.repository, identity)) fail("factory_repository_mismatch", "Factory JSON belongs to another canonical repository");
	integer(document.revision, "factory revision", 0);
	const events = document.events;
	if (document.revision !== events.length) fail("factory_revision_invalid", "Factory revision must equal the immutable event count");
	const state = emptyState();
	let previous = "";
	for (const [index, event] of events.entries()) {
		object(event, ["revision", "at", "action", "input"], "factory event");
		if (event.revision !== index + 1) fail("factory_revision_invalid", "Factory event revisions must be contiguous");
		timestamp(event.at, "event.at");
		if (previous && event.at < previous) fail("factory_time_invalid", "Factory events must be causally ordered");
		previous = event.at;
		if (event.action === "recordOperating") {
			validateCanonicalOperating({ ...state, repository: identity, revision: event.revision - 1 },
				operatingPublication(event.input.publication).batch);
		}
		applyEvent(state, event, { historical: true, portable: document.portable === true });
	}
	return state;
}
import { isRecord } from "../data.mjs";
import { analysisInputDigest } from "../digest.mjs";

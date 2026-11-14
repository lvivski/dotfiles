import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { candidateAssurance } from "./assurance.mjs";
import { assertGenerationAuthority, generationPackage } from "./context.mjs";
import { artifact, source } from "./definitions.mjs";
import { COMMIT, actorReason, enumeration, fail, integer, list, object, text } from "./fields.mjs";
import { candidateFor, contractFor, currentCandidate, retired, same, uniqueId } from "./records.mjs";
import { renewalSignals } from "./signals.mjs";

/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["prepareCandidate"]} */
export function prepareCandidate(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["id", "unitId", "contractRevision", "mode", "context", "actor", "renewalSignalIds"], action);
	const id = uniqueId(state.candidates, input.id);
	const contract = contractFor(state, input.unitId, integer(input.contractRevision, "contractRevision"));
	assertGenerationAuthority(state, contract);
	if (contractFor(state, input.unitId).digest !== contract.digest) fail("factory_contract_superseded", "New candidates must use the current accepted contract");
	object(input.context, ["generation", "comparisonOnly", "independence"], "context");
	object(input.context.independence, ["method", "reason"], "context.independence");
	/** @type {import("../types/factory.js").CandidateContext} */
	const context = {
		generation: list(input.context.generation, "generation").map(artifact),
		comparisonOnly: list(input.context.comparisonOnly, "comparisonOnly").map(artifact),
		independence: {
			method: enumeration(input.context.independence.method, ["fresh-session", "fresh-process", "declared", "existing-artifact"], "context.independence.method"),
			reason: text(input.context.independence.reason, "context.independence.reason"),
		},
	};
	const mode = enumeration(input.mode ?? "reconstruction", ["adoption", "implementation", "reconstruction"], "candidate.mode");
	if (mode === "adoption"
		? context.generation.length !== 0 || !context.comparisonOnly.some((entry) => entry.kind === "implementation")
		|| context.independence.method !== "existing-artifact"
		: context.independence.method === "existing-artifact") {
		fail("factory_context_invalid", "Adoption evaluates an existing comparison artifact with no generation inputs; generation cannot claim an existing-artifact origin");
	}
	if (context.generation.some((entry) => context.comparisonOnly.some((prior) => prior.ref === entry.ref || prior.digest === entry.digest))
		|| (mode === "reconstruction" && context.generation.some((entry) => entry.kind === "implementation"))) {
		fail("factory_context_contaminated", "Reconstruction generation inputs cannot include prior implementation or comparison-only artifacts");
	}
	const acceptedDecision = state.decisions.find((entry) => entry.id === contract.decisionId);
	if (!acceptedDecision || acceptedDecision.kind !== "accept-contract") fail("factory_decision_missing", "Accepted contract has no acceptance decision");
	const acceptedSignals = acceptedDecision.renewalSignalIds ?? [];
	const renewalSignalIds = renewalSignals(state, contract.unitId, input.renewalSignalIds ?? acceptedSignals);
	if (renewalSignalIds.some((id) => !acceptedSignals.includes(id))) {
		fail("factory_renewal_unaccepted", "Candidate renewal signals must be acknowledged by its explicitly accepted contract decision");
	}
	/** @type {Candidate} */
	const candidate = {
		id, unitId: contract.unitId, contractRevision: contract.revision, contractDigest: contract.digest,
		mode, context, contextDigest: "",
		actor: text(input.actor, "actor"), createdAt: at,
		incumbentId: currentCandidate(state, contract.unitId),
		binding: null, delivery: null, completion: null, evidence: [],
		...(renewalSignalIds.length ? { renewalSignalIds } : {}),
	};
	const generation = generationPackage(state, candidate);
	const { contextDigest: _unsealed, ...generationInput } = generation;
	if (mode !== "adoption") {
		const serialized = stableStringify(generationInput);
		if (context.comparisonOnly.some((prior) => [prior.ref, prior.digest]
			.some((value) => serialized.includes(JSON.stringify(value).slice(1, -1))))) {
			fail("factory_context_contaminated", "Comparison-only implementation artifacts cannot leak through accepted knowledge, rationale or decision provenance");
		}
	}
	candidate.contextDigest = analysisInputDigest({ sealVersion: 2, generation: generationInput, comparisonOnly: context.comparisonOnly });
	state.candidates.push(candidate);
	return { candidate, generation: generationPackage(state, candidate), comparison: context.comparisonOnly };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["recordDelivery"]} */
export function recordDelivery(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["candidateId", "commit", "artifact", "source"], action);
	const candidate = candidateFor(state, input.candidateId);
	if (typeof input.commit !== "string" || !COMMIT.test(input.commit)) fail("factory_input_invalid", "Delivery requires a full lowercase commit ID");
	const origin = source(input.source, at);
	const deliveredArtifact = artifact(input.artifact);
	if (candidate.delivery) {
		if (candidate.delivery.commit === input.commit && same(candidate.delivery.artifact, deliveredArtifact) && same(candidate.delivery.source, origin)) {
			return { candidate, idempotent: true };
		}
		fail("factory_delivery_immutable", "Delivery is immutable; prepare a new candidate for a different implementation");
	}
	if (retired(state, "candidate", candidate.id)) fail("factory_delivery_immutable", "Retired candidates cannot acquire new deliveries");
	if (!origin["sessionId"] && !origin["runId"]) fail("factory_provenance_incomplete", "Delivery needs an exact generation session or external run");
	if (candidate.mode === "adoption") {
		if (Date.parse(origin.at) > Date.parse(candidate.createdAt)
			|| !candidate.context.comparisonOnly.some((entry) => same(entry, input.artifact))) {
			fail("factory_adoption_origin", "Adoption must identify the prepared comparison artifact and its actual prior origin, not invent fresh generation provenance");
		}
	} else if (Date.parse(origin.at) < Date.parse(candidate.createdAt)) {
		fail("factory_generation_predates_context", "Fresh candidate generation cannot predate its sealed context");
	}
	if (candidate.mode !== "adoption") {
		const method = candidate.context.independence.method;
		if ((method === "fresh-session" && !origin["sessionId"]) || (method === "fresh-process" && !origin["runId"])) {
			fail("factory_generation_origin_incomplete", "Fresh generation needs its actual session or process/run identity, not only a later timestamp");
		}
		if (state.candidates.some((prior) => prior.delivery && prior.id !== candidate.id
			&& (method === "fresh-session"
				? prior.delivery.source.sessionId === origin["sessionId"]
				: method === "fresh-process" && prior.delivery.source.runId === origin["runId"] && prior.delivery.source.owner === origin["owner"]))) {
			fail("factory_generation_origin_reused", "A known generation origin cannot count as a fresh candidate merely by reporting a later timestamp");
		}
	}
	if (candidate.binding && (origin.kind !== "app-task" || origin["owner"] !== candidate.binding.owner || origin["planId"] !== candidate.binding.planId)) {
		fail("factory_execution_mismatch", "Delivery must come from the candidate's bound session plan");
	}
	candidate.delivery = { commit: input.commit, artifact: deliveredArtifact, source: origin, recordedAt: at, trust: "claimed" };
	return { candidate };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["decideCandidate"]} */
export function decideCandidate(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["candidateId", "action", "expectedIncumbentId", "actor", "reason"], action);
	const candidate = candidateFor(state, input.candidateId);
	const decisionAction = enumeration(input.action, ["accept", "reject"], "decision.action");
	if (state.decisions.some((entry) => entry.kind !== "accept-contract" && entry.candidateId === candidate.id)) {
		fail("factory_candidate_decided", "Candidate already has an immutable selection decision");
	}
	const incumbentId = currentCandidate(state, candidate.unitId);
	if (input.expectedIncumbentId !== incumbentId) fail("factory_incumbent_changed", "Current implementation changed; inspect before deciding");
	if (decisionAction === "accept") {
		const assurance = candidateAssurance(state, candidate, at);
		// Recorded v2 decisions remain historical facts. The old engine used
		// publication order; only prospective decisions use current support.
		const historical = options.historical && !assurance.ready
			? candidateAssurance(state, candidate, at, {}, new Set(), new Map(), true) : null;
		if (!assurance.ready && !historical?.ready) fail("factory_assurance_incomplete", "Candidate cannot replace the current implementation", assurance);
		if (candidate.incumbentId !== incumbentId) fail("factory_incumbent_changed", "Candidate preservation context predates the current incumbent");
	}
	/** @type {import("../types/factory.js").CandidateDecision} */
	const decision = {
		id: `decision-${revision}`, kind: `${decisionAction}-candidate`, candidateId: candidate.id,
		unitId: candidate.unitId, incumbentId, contractDigest: candidate.contractDigest,
		evidenceIds: candidate.evidence.map((entry) => entry.id), ...actorReason(input, at),
	};
	state.decisions.push(decision);
	return { candidate, decision };

}

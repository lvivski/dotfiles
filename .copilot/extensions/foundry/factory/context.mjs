import { stableStringify } from "../digest.mjs";
import { fail } from "./fields.mjs";
import { contractFor, evaluationFor, key, knowledgeFor, unitFor } from "./records.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").CapabilityUnit} CapabilityUnit */
/** @typedef {import("../types/factory.js").FactoryContract} FactoryContract */
/** @typedef {import("../types/factory.js").Candidate} Candidate */

const MAX_CONTEXT_BYTES = 128 * 1024;

/** @param {FactoryState} state @param {KnowledgeRef[]} selected @param {KnowledgeRef[]} [explicit] */
export function rationaleClosure(state, selected, explicit = []) {
	const selectedKeys = new Set(selected.map(key));
	const seen = new Set();
	const pending = [...selected, ...explicit];
	const rationale = [];
	while (pending.length) {
		const ref = pending.shift();
		if (!ref) break;
		if (seen.has(key(ref))) continue;
		seen.add(key(ref));
		if (seen.size > 128) fail("factory_context_capacity", "Accepted knowledge context exceeds 128 connected revisions; choose a smaller coherent unit");
		const entry = knowledgeFor(state, ref);
		if (!selectedKeys.has(key(entry))) rationale.push({ id: entry.id, revision: entry.revision });
		for (const link of entry.links) {
			if (["supports", "derived-from", "depends-on"].includes(link.relation)) pending.push(link.target);
		}
	}
	return rationale.sort((left, right) => key(left).localeCompare(key(right)));
}

/** @param {FactoryState} state @param {CapabilityUnit} unit */
export function assertAcceptedDependencies(state, unit) {
	/** @param {string} id @param {Set<string>} visited */
	const walk = (id, visited) => {
		if (id === unit.id) fail("factory_dependency_cycle", "Accepted capability boundaries cannot form a dependency cycle");
		if (visited.has(id)) return;
		visited.add(id);
		const contract = contractFor(state, id);
		unitFor(state, id, contract.unitRevision).dependencies.forEach((dependency) => walk(dependency, visited));
	};
	return unit.dependencies.map((id) => {
		const contract = contractFor(state, id);
		walk(id, new Set());
		return { unitId: id, unitRevision: contract.unitRevision, contractRevision: contract.revision, contractDigest: contract.digest };
	});
}

/** @param {FactoryState} state @param {KnowledgeRef} ref @param {"accepted" | "non-governing"} authority @returns {import("../types/factory.js").ProjectedKnowledge} */
function projectedKnowledge(state, ref, authority) {
	const entry = knowledgeFor(state, ref);
	// Source refs, run/session paths and source artifacts stay in the inspectable
	// ledger. A lesson's provenance must not leak incumbent implementation inputs.
	return {
		id: entry.id, revision: entry.revision, unitId: entry.unitId, kind: entry.kind,
		authority, statement: entry.statement, uncertainty: entry.uncertainty, links: entry.links,
		...(authority === "accepted" && entry.evaluation ? { evaluation: entry.evaluation } : {}),
	};
}

/** @param {FactoryState} state @param {FactoryContract} contract @returns {Omit<import("../types/factory.js").FactoryDefinitions, "contract">} */
export function contractContext(state, contract) {
	return {
		sealVersion: 2,
		unit: unitFor(state, contract.unitId, contract.unitRevision),
		obligations: contract.obligations.map((ref) => projectedKnowledge(state, ref, "accepted")),
		evaluations: contract.evaluations.map((ref) => ({ ...projectedKnowledge(state, ref, "accepted"), evaluation: evaluationFor(state, ref) })),
		rationale: contract.rationale.map((ref) => projectedKnowledge(state, ref, "non-governing")),
		decisionLineage: contract.decisionIds.map((id) => {
			const decision = state.decisions.find((entry) => entry.id === id);
			if (!decision) fail("factory_decision_missing", "Accepted context references a missing decision");
			return decision;
		}),
		omittedEarlierDecisions: contract.omittedEarlierDecisions,
		foundations: contract.dependencies.map((dependency) => ({
			...dependency, usage: "reuse-shared-foundation",
			boundary: unitFor(state, dependency.unitId, dependency.unitRevision).boundary,
		})),
	};
}

/** @param {unknown} context */
export function checkContextSize(context) {
	if (Buffer.byteLength(stableStringify(context)) > MAX_CONTEXT_BYTES) {
		fail("factory_context_capacity", "Sealed generation context exceeds 128 KiB; bound the unit's contracts and references before generation");
	}
}

/** @param {FactoryState} state @param {Candidate} candidate @returns {import("../types/factory.js").GenerationPackage} */
export function generationPackage(state, candidate) {
	const contract = contractFor(state, candidate.unitId, candidate.contractRevision);
	return {
		purpose: candidate.mode === "adoption" ? "evaluate-existing-artifact-not-generation" : candidate.mode,
		candidateId: candidate.id,
		...contractContext(state, contract),
		contract,
		inputs: candidate.context.generation,
		independence: candidate.context.independence,
		contextDigest: candidate.contextDigest,
		limitations: "Manifest and actor reports are claims, not OS-level source isolation or deterministic generation.",
	};
}

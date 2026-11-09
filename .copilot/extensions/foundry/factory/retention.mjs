import { actorReason, enumeration, fail, identifier, integer, object, reference, text } from "./fields.mjs";
import { candidateFor, contractFor, currentCandidate, evaluationRetirementHolds, key, knowledgeFor, latest, retired } from "./records.mjs";

/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").Knowledge} Knowledge */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["retire"]} */
export function retire(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["type", "id", "revision", "actor", "reason", "summary"], action);
	const type = enumeration(input.type, ["candidate", "knowledge"], "retirement.type");
	if (retired(state, type, input.id, input.revision)) fail("factory_already_retired", "Artifact is already retired");
	if (type === "candidate") {
		const candidate = candidateFor(state, input.id);
		const holds = evaluationRetirementHolds(state, candidate.id);
		if (!options.historical && holds.length) fail("factory_retirement_unsafe", "Outstanding read-only evaluation work must complete or be abandoned before retirement", {
			bindings: holds.map((binding) => ({ owner: binding.owner, planId: binding.planId })),
		});
		if (input.revision !== undefined || currentCandidate(state, candidate.unitId) === candidate.id
			|| (candidate.binding && !candidate.completion)
			|| !state.decisions.some((decision) => decision.kind !== "accept-contract" && decision.candidateId === candidate.id)) {
			fail("factory_retirement_unsafe", "Cannot retire current, undecided, or unfinished bound candidates");
		}
	} else {
		const ref = reference({ id: input.id, revision: input.revision });
		knowledgeFor(state, ref);
		const pinned = state.contracts.filter((contract) => contractFor(state, contract.unitId) === contract
			|| state.candidates.some((candidate) => candidate.unitId === contract.unitId
				&& candidate.contractRevision === contract.revision && !retired(state, "candidate", candidate.id)));
		if (pinned.some((contract) => [...contract.obligations, ...contract.evaluations, ...contract.rationale].some((entry) => key(entry) === key(ref)))) {
			fail("factory_retirement_unsafe", "Knowledge is still required by a current contract or retained candidate");
		}
		if (latest(state.knowledge, input.id)?.revision === input.revision) {
			fail("factory_retirement_unsafe", "Only superseded knowledge revisions may be compacted");
		}
	}
	const retirement = {
		type, id: identifier(input.id), ...(type === "knowledge" ? { revision: integer(input.revision, "knowledge revision") } : {}),
		...actorReason(input, at), summary: text(input.summary, "retained summary"),
		retention: "Logical compaction only: full history remains exportable. No user artifact, data, branch or file is deleted.",
	};
	state.retirements.push(retirement);
	return { retirement };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["compactFactory"]} */
export function compactFactory(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["actor", "reason"], action);
	if (!state.retirements.length) fail("factory_compaction_unsafe", "Explicitly retire superseded artifacts before compacting their retained ledger");
	const compaction = {
		id: `compaction-${revision}`, ...actorReason(input, at),
		retention: "All history is retained; compression is used only when it reduces stored document bytes. No user artifact is removed.",
	};
	state.compactions.push(compaction);
	return { compaction };

}

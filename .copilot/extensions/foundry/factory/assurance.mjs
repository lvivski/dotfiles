import { stableStringify } from "../digest.mjs";
import { requiresHumanJudgment } from "./definitions.mjs";
import { evaluationObservation } from "./observations.mjs";
import { candidateFor, contractFor, currentCandidate, disputedKnowledge, evaluationFor, key, retired } from "./records.mjs";
import { affectedUnits, signalAffectsEvaluation } from "./signals.mjs";

/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").Assurance} Assurance */

/**
 * Current assurance is a projection; later incidents/expiry never rewrite an
 * earlier acceptance decision. Distinct identifiers establish only claims.
 * @param {FactoryState} state @param {Candidate} candidate @param {string} at
 * @param {{environment?: string, workload?: string}} [context]
 * @param {Set<string>} [ancestors] @param {Map<string, Assurance>} [memo]
 * @param {boolean} [historicalPublicationOrder]
 * @returns {Assurance}
 */
export function candidateAssurance(state, candidate, at, context = {}, ancestors = new Set(), memo = new Map(), historicalPublicationOrder = false) {
	const memoKey = stableStringify([candidate.id, at, context.environment ?? null, context.workload ?? null, historicalPublicationOrder]);
	const cached = memo.get(memoKey);
	if (cached) return cached;
	const contract = contractFor(state, candidate.unitId, candidate.contractRevision);
	const missing = [];
	if (!candidate.delivery) missing.push("delivery");
	const incumbent = currentCandidate(state, candidate.unitId);
	if (incumbent !== candidate.id && candidate.incumbentId !== incumbent) missing.push("incumbent-changed");
	if (state.decisions.some((entry) => entry.kind === "reject-candidate" && entry.candidateId === candidate.id)) missing.push("candidate-rejected");
	if (retired(state, "candidate", candidate.id)) missing.push("candidate-retired");
	if (contractFor(state, candidate.unitId).digest !== contract.digest) missing.push("contract-superseded");
	const visited = new Set(ancestors);
	visited.add(candidate.unitId);
	for (const dependency of contract.dependencies) {
		if (visited.has(dependency.unitId)) {
			missing.push(`dependency-cycle: ${dependency.unitId}`);
			continue;
		}
		if (contractFor(state, dependency.unitId).digest !== dependency.contractDigest) {
			missing.push(`dependency-contract-superseded: ${dependency.unitId}`);
			continue;
		}
		const selected = currentCandidate(state, dependency.unitId);
		if (!selected || !candidateAssurance(state, candidateFor(state, selected), at, {}, visited, memo, historicalPublicationOrder).ready) {
			missing.push(`dependency-support-missing: ${dependency.unitId}`);
		}
	}
	const acceptance = state.decisions.find((entry) => entry.id === contract.decisionId);
	const resolutions = acceptance?.kind === "accept-contract" ? acceptance.resolutions : [];
	for (const entry of disputedKnowledge(state, [...contract.obligations, ...contract.evaluations])) {
		if (!resolutions.some((resolution) => key(resolution.knowledge) === key(entry))) missing.push(`unresolved-knowledge: ${key(entry)}`);
	}
	if (candidate.mode === "reconstruction" && candidate.context.independence.method === "declared") missing.push("fresh-context-evidence");
	if (candidate.delivery && candidate.mode !== "adoption"
		&& ((candidate.context.independence.method === "fresh-session" && !candidate.delivery.source.sessionId)
			|| (candidate.context.independence.method === "fresh-process" && !candidate.delivery.source.runId))) {
		missing.push("generation-origin-incomplete");
	}
	const relevantSignals = state.signals.filter((signal) => {
		const impact = affectedUnits(state, signal.unitIds, signal.knowledgeRefs);
		return [...impact.affectedUnitIds, ...impact.uncertainUnitIds].includes(candidate.unitId);
	});
	const evaluationSupport = contract.evaluations.map((ref) => {
		const definition = evaluationFor(state, ref);
		const observation = historicalPublicationOrder
			? { evidence: candidate.evidence.filter((entry) => key(entry.evaluation) === key(ref)).at(-1), conflicting: false }
			: evaluationObservation(candidate, ref);
		const evidence = observation.evidence;
		const gaps = [];
		if (!evidence) gaps.push(requiresHumanJudgment(definition) ? "pending-human" : "missing");
		else {
			if (observation.conflicting) gaps.push("conflicting-observations");
			if (evidence.outcome !== "passed") gaps.push(evidence.outcome);
			if (definition.independent && evidence.trust !== "independent-claim") gaps.push("independence-missing");
			if (evidence.environment !== (context.environment ?? definition.environment)) gaps.push("environment-mismatch");
			if (evidence.workload !== (context.workload ?? definition.workload)) gaps.push("workload-mismatch");
			if (Date.parse(evidence.source.at) + definition.maxAgeSeconds * 1000 <= Date.parse(at)) gaps.push("expired");
			if (relevantSignals.some((signal) => Date.parse(signal.recordedAt) >= Date.parse(evidence.source.at)
				&& signalAffectsEvaluation(state, signal, candidate.unitId, ref, definition))) gaps.push("renewal-required");
			const execution = evidence.source.kind === "app-task" ? state.bindings.find((binding) =>
				binding.candidateId === candidate.id && binding.purpose === "evaluation"
				&& binding.owner === evidence.source.owner && binding.planId === evidence.source.planId) : null;
			if (execution && (!execution.completion || Date.parse(execution.completion.source.at) < Date.parse(evidence.source.at))) gaps.push("evaluation-plan-pending");
			else if (execution?.completion && !execution.completion.passed) gaps.push("evaluation-plan-failed");
		}
		if (gaps.length) missing.push(`${key(ref)}: ${gaps.join(", ")}`);
		return { evaluation: ref, modality: definition.modality, preservation: definition.preservation, evidenceId: evidence?.id ?? null, observedAt: evidence?.source.at ?? null, gaps };
	});
	const renewed = state.bindings.some((binding) => binding.purpose === "evaluation" && binding.candidateId === candidate.id && binding.completion?.passed);
	if (candidate.binding && !candidate.completion && !renewed) missing.push("plan-verification");
	if (candidate.completion && !candidate.completion.passed && !renewed) missing.push("plan-verification-failed");
	const result = { ready: missing.length === 0, missing, evaluationSupport, trust: "claims-not-attestation", observedAt: at };
	memo.set(memoKey, result);
	return result;
}

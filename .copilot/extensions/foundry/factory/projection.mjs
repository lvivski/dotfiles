import { candidateAssurance } from "./assurance.mjs";
import { fail, integer, object } from "./fields.mjs";
import { evaluationObservation } from "./observations.mjs";
import { candidateFor, contractFor, currentCandidate, evaluationFor, evaluationRetirementHolds, key, retired, unitFor } from "./records.mjs";
import { affectedUnits } from "./signals.mjs";

/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").Assurance} Assurance */
/** @typedef {import("../types/factory.js").PublicationDisposition} PublicationDisposition */

/** @param {Pick<ReturnType<typeof import("./storage.mjs").createFactoryLedger>, "snapshot" | "storageInfo">} ledger
 * @param {RepositoryIdentity} repository @param {() => string} now */
export function createFactoryInspection(ledger, repository, now) {
	const { snapshot } = ledger;

	/** @param {{unitId?: string, candidateId?: string, limit?: number, includeRetired?: boolean, environment?: string, workload?: string}} [input] */
	const inspect = (input = {}) => {
		object(input, ["unitId", "candidateId", "limit", "includeRetired", "environment", "workload"], "inspection");
		const limit = integer(input.limit ?? 50, "limit", 1, 100);
		const state = snapshot();
		const observedAt = now();
		/** @type {Map<string, Assurance>} */
		const assuranceMemo = new Map();
		/** @param {Candidate} candidate @param {{environment?: string, workload?: string}} [context] */
		const assuranceFor = (candidate, context = {}) => candidateAssurance(state, candidate, observedAt, context, new Set(), assuranceMemo);
		if (input.unitId) unitFor(state, input.unitId);
		if (input.candidateId) candidateFor(state, input.candidateId);
		/** @param {{unitId?: string, id?: string}} entry */
		const match = (entry) => (!input.unitId || entry.unitId === input.unitId || entry.id === input.unitId);
		const units = [...new Set(state.units.map((unit) => unit.id))].map((id) => {
			const unit = unitFor(state, id);
			const contract = state.contracts.filter((entry) => entry.unitId === id).at(-1);
			return { ...unit, acceptedUnitRevision: contract?.unitRevision ?? null, contractRevision: contract?.revision ?? null, currentCandidateId: currentCandidate(state, id) };
		}).filter(match);
		const knowledge = state.knowledge.filter(match).filter((entry) => input.includeRetired || !retired(state, "knowledge", entry.id, entry.revision)).map((entry) => ({
			...entry,
			authority: state.contracts.some((contract) => contract.unitId === entry.unitId
				&& contractFor(state, contract.unitId) === contract
				&& [...contract.obligations, ...contract.evaluations].some((ref) => key(ref) === key(entry)))
				? "accepted" : state.contracts.some((contract) => [...contract.obligations, ...contract.evaluations].some((ref) => key(ref) === key(entry)))
					? "historically-accepted" : "non-governing",
		}));
		const candidates = state.candidates.filter(match).filter((entry) => !input.candidateId || entry.id === input.candidateId)
			.filter((entry) => input.includeRetired || !retired(state, "candidate", entry.id))
			.map((entry) => {
				/** @type {Map<string, PublicationDisposition>} */
				const dispositions = new Map();
				for (const ref of contractFor(state, entry.unitId, entry.contractRevision).evaluations) {
					for (const [id, disposition] of evaluationObservation(entry, ref).dispositions) dispositions.set(id, disposition);
				}
				const holds = evaluationRetirementHolds(state, entry.id);
				const evaluationWork = state.bindings.filter((binding) => binding.purpose === "evaluation" && binding.candidateId === entry.id);
				return {
					...entry,
					evidence: entry.evidence.slice(-32).map((evidence) => ({ ...evidence, publicationDisposition: dispositions.get(evidence.id) })),
					evidenceCount: entry.evidence.length,
					evidenceTruncated: entry.evidence.length > 32,
					retirementHolds: holds.slice(0, 32).map((binding) => ({ owner: binding.owner, planId: binding.planId })),
					retirementHoldCount: holds.length,
					evaluationWork: evaluationWork.slice(-32).map((binding) => ({
						owner: binding.owner, planId: binding.planId, active: binding.active ?? !binding.completion,
						completion: binding.completion ?? null,
					})),
					evaluationWorkCount: evaluationWork.length,
					selection: state.decisions.find((decision) => decision.kind !== "accept-contract" && decision.candidateId === entry.id) ?? null,
					isCurrent: currentCandidate(state, entry.unitId) === entry.id,
					assurance: assuranceFor(entry, input),
				};
			});
		const renewalNeeds = candidates.flatMap((candidate) => {
			if (!candidate.isCurrent && (candidate.selection
				|| candidate.completion?.disposition === "cancelled"
				|| candidate.assurance.missing.some((gap) => ["candidate-retired", "candidate-rejected", "incumbent-changed", "contract-superseded"].includes(gap)))) return [];
			const unsupported = candidate.assurance.evaluationSupport.filter((support) =>
				support.gaps.some((gap) => ["failed", "inconclusive", "expired", "environment-mismatch", "workload-mismatch", "renewal-required"].includes(gap)));
			if (!unsupported.length) return [];
			const obligations = [...new Map(unsupported.flatMap((support) => evaluationFor(state, support.evaluation).obligations)
				.map((ref) => [key(ref), ref])).values()];
			return [{
				candidateId: candidate.id, unitId: candidate.unitId,
				scope: candidate.isCurrent ? "current-support" : "candidate-only",
				evaluations: unsupported, obligations,
				...affectedUnits(state, [candidate.unitId], obligations),
				proposal: "Re-evaluate these pinned obligations in the relevant context first. Any changed contract or fresh replacement requires explicit acceptance and a bounded new plan.",
			}];
		});
		const collections = {
			units, knowledge, candidates, contracts: state.contracts.filter(match).map((contract) => ({
				...contract, current: contractFor(state, contract.unitId).digest === contract.digest,
				unitName: unitFor(state, contract.unitId, contract.unitRevision).name,
			})), decisions: state.decisions.filter(match),
			signals: state.signals.map((entry) => ({ ...entry, currentImpact: affectedUnits(state, entry.unitIds, entry.knowledgeRefs) }))
				.filter((entry) => !input.unitId || [...entry.currentImpact.affectedUnitIds, ...entry.currentImpact.uncertainUnitIds].includes(input.unitId)),
			renewals: state.renewals.map((entry) => {
				const signal = state.signals.find((signal) => signal.id === entry.signalId);
				if (!signal) fail("factory_signal_missing", "Renewal references a missing signal");
				const impact = affectedUnits(state, signal.unitIds, signal.knowledgeRefs);
				const relevantUnits = [...impact.affectedUnitIds, ...impact.uncertainUnitIds];
				const supportedUnitIds = relevantUnits.filter((unitId) => {
					const current = currentCandidate(state, unitId);
					return current && assuranceFor(candidateFor(state, current)).ready;
				});
				const pendingUnitIds = relevantUnits.filter((id) => !supportedUnitIds.includes(id));
				const decisionIds = state.decisions.filter((decision) => decision.kind === "accept-contract" && decision.renewalSignalIds?.includes(signal.id)).map((decision) => decision.id);
				return {
					...entry, ...impact, supportedUnitIds, pendingUnitIds, decisionIds,
					candidateIds: state.candidates.filter((candidate) => candidate.renewalSignalIds?.includes(signal.id)).map((candidate) => candidate.id),
					status: relevantUnits.length && !pendingUnitIds.length ? "supported"
						: supportedUnitIds.length ? "partially-supported"
							: decisionIds.length ? "awaiting-evaluation" : "proposed",
				};
			}).filter((entry) => !input.unitId || [...entry.affectedUnitIds, ...entry.uncertainUnitIds].includes(input.unitId)),
			retirements: state.retirements,
			compactions: state.compactions,
			renewalNeeds,
		};
		return {
			repository, revision: state.revision, observedAt,
			storage: ledger.storageInfo(),
			units: collections.units.slice(-limit),
			knowledge: collections.knowledge.slice(-limit),
			candidates: collections.candidates.slice(-limit),
			contracts: collections.contracts.slice(-limit),
			decisions: collections.decisions.slice(-limit),
			signals: collections.signals.slice(-limit),
			renewals: collections.renewals.slice(-limit),
			retirements: collections.retirements.slice(-limit),
			compactions: collections.compactions.slice(-limit),
			renewalNeeds: collections.renewalNeeds.slice(-limit),
			counts: Object.fromEntries(Object.entries(collections).map(([name, entries]) => [name, entries.length])),
			truncated: Object.fromEntries(Object.entries(collections).map(([name, entries]) => [name, entries.length > limit])),
			limitations: "Identity uses canonical Git common-directory location. Evidence is claimed or independent-claim; imports never adopt another session's native execution ownership. Compaction retains full history.",
		};
	};
	return inspect;
}

import { errorMessage, parseJson } from "../data.mjs";
import { analysisInputDigest } from "../digest.mjs";
import { candidateAssurance } from "./assurance.mjs";
import { DISCOVERY_BOUNDS, knowledgeQuery, retrieveKnowledge } from "./context.mjs";
import { digest, fail, identifier, integer, object, text, timestamp } from "./fields.mjs";
import { evaluationObservation } from "./observations.mjs";
import { candidateFor, contractFor, currentCandidate, evaluationFor, evaluationRetirementHolds, key, retired, unitFor } from "./records.mjs";
import { replay } from "./replay.mjs";
import { affectedUnits } from "./signals.mjs";

/** @typedef {import("../types/factory.js").RepositoryIdentity} RepositoryIdentity */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").Assurance} Assurance */
/** @typedef {import("../types/factory.js").PublicationDisposition} PublicationDisposition */
/** @typedef {import("../types/factory.js").FactoryInspectionCursor} FactoryInspectionCursor */

/** @param {unknown} value @returns {FactoryInspectionCursor | null} */
function readCursor(value) {
	if (value === undefined) return null;
	try {
		const encoded = text(value, "cursor");
		const decoded = Buffer.from(encoded, "base64url");
		if (decoded.toString("base64url") !== encoded) fail("factory_inspection_cursor", "Inspection cursor is not canonical base64url");
		const cursor = parseJson(decoded.toString("utf8"));
		object(cursor, ["version", "repositoryId", "revision", "throughDigest", "offset", "observedAt", "filtersDigest"], "inspection cursor");
		if (cursor.version !== 1) fail("factory_inspection_cursor", "Unsupported inspection cursor version");
		return {
			version: 1, repositoryId: digest(cursor.repositoryId, "cursor.repositoryId"),
			revision: integer(cursor.revision, "cursor.revision", 0), throughDigest: digest(cursor.throughDigest, "cursor.throughDigest"),
			offset: integer(cursor.offset, "cursor.offset", 0), observedAt: timestamp(cursor.observedAt, "cursor.observedAt"),
			filtersDigest: digest(cursor.filtersDigest, "cursor.filtersDigest"),
		};
	} catch (error) {
		fail("factory_inspection_cursor", "Invalid inspection cursor; start a new inspection", { message: errorMessage(error) });
	}
}

/** @param {Pick<ReturnType<typeof import("./storage.mjs").createFactoryLedger>, "exportFactoryPage" | "storageInfo">} ledger
 * @param {RepositoryIdentity} repository @param {() => string} now */
export function createFactoryInspection(ledger, repository, now) {
	/** @type {{revision: number, throughDigest: string, state: import("../types/factory.js").FactoryState} | null} */
	let cached = null;
	/** Historical pages use the same validated immutable event prefix as export, not today's mutable candidate state.
	 * @param {FactoryInspectionCursor | null} cursor */
	const pinnedSnapshot = (cursor) => {
		let page = ledger.exportFactoryPage({
			...(cursor ? { throughRevision: cursor.revision, throughDigest: cursor.throughDigest } : {}), limit: 256,
		});
		const { revision, throughDigest, format, portable } = page;
		if (cached?.revision !== revision || cached.throughDigest !== throughDigest) {
			const events = [...page.events];
			while (!page.complete) {
				const afterRevision = page.nextRevision;
				page = ledger.exportFactoryPage({ throughRevision: revision, throughDigest, afterRevision, limit: 256 });
				if (page.nextRevision <= afterRevision) fail("factory_inspection_cursor", "Inspection history did not advance");
				if (page.portable !== portable) fail("factory_inspection_cursor", "Inspection history changed its portable provenance");
				events.push(...page.events);
			}
			cached = { revision, throughDigest, state: replay({ format, repository, revision, events,
				...(portable ? { portable: /** @type {const} */ (true) } : {}) }, repository) };
		}
		return { revision, throughDigest, ...structuredClone(cached.state) };
	};

	/** @param {import("../types/factory.js").FactoryInspectionInput} [input] */
	const inspect = (input = {}) => {
		object(input, ["unitId", "candidateId", "limit", "includeRetired", "environment", "workload", "kinds", "query", "relatedTo", "cursor"], "inspection");
		const limit = integer(input.limit ?? 50, "limit", 1, 100);
		if (input.unitId !== undefined) identifier(input.unitId, "unitId");
		if (input.candidateId !== undefined) identifier(input.candidateId, "candidateId");
		if (input.includeRetired !== undefined && typeof input.includeRetired !== "boolean") fail("factory_input_invalid", "includeRetired must be boolean");
		if (input.environment !== undefined) text(input.environment, "environment");
		if (input.workload !== undefined) text(input.workload, "workload");
		const filters = knowledgeQuery(input);
		const filtersDigest = analysisInputDigest({
			unitId: input.unitId ?? null, candidateId: input.candidateId ?? null, includeRetired: input.includeRetired ?? false,
			environment: input.environment ?? null, workload: input.workload ?? null, ...filters, limit,
		});
		const cursor = readCursor(input.cursor);
		if (cursor && (cursor.repositoryId !== repository.id || cursor.filtersDigest !== filtersDigest)) {
			fail("factory_inspection_cursor", "Inspection cursor belongs to another repository or filter; repeat the original filters and limit");
		}
		const state = pinnedSnapshot(cursor);
		const observedAt = cursor?.observedAt ?? now();
		const offset = cursor?.offset ?? 0;
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
		const retrieval = retrieveKnowledge(state, input);
		const retrieved = new Map(retrieval.entries.map((entry) => [key(entry.entry), entry]));
		const knowledge = state.knowledge.filter((entry) => retrieved.has(key(entry))).map((entry) => ({
			...entry,
			selectionReasons: retrieved.get(key(entry))?.selectionReasons ?? [],
			revisionStatus: retrieved.get(key(entry))?.revisionStatus,
			supersededBy: retrieved.get(key(entry))?.supersededBy ?? [],
			omittedSuperseders: retrieved.get(key(entry))?.omittedSuperseders ?? 0,
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
					evidence: entry.evidence.map((evidence) => ({ ...evidence, publicationDisposition: dispositions.get(evidence.id) })),
					evidenceCount: entry.evidence.length,
					evidenceTruncated: false,
					retirementHolds: holds.map((binding) => ({ owner: binding.owner, planId: binding.planId })),
					retirementHoldCount: holds.length,
					evaluationWork: evaluationWork.map((binding) => ({
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
		/** @template T @param {T[]} entries */
		const window = (entries) => {
			const end = Math.max(0, entries.length - offset);
			return entries.slice(Math.max(0, end - limit), end);
		};
		const more = Object.values(collections).some((entries) => entries.length > offset + limit);
		const nextCursor = more ? Buffer.from(JSON.stringify({
			version: 1, repositoryId: repository.id, revision: state.revision, throughDigest: state.throughDigest,
			offset: offset + limit, observedAt, filtersDigest,
		})).toString("base64url") : null;
		return {
			repository, revision: state.revision, observedAt,
			storage: ledger.storageInfo(),
			units: window(collections.units),
			knowledge: window(collections.knowledge),
			candidates: window(collections.candidates),
			contracts: window(collections.contracts),
			decisions: window(collections.decisions),
			signals: window(collections.signals),
			renewals: window(collections.renewals),
			retirements: window(collections.retirements),
			compactions: window(collections.compactions),
			renewalNeeds: window(collections.renewalNeeds),
			counts: Object.fromEntries(Object.entries(collections).map(([name, entries]) => [name, entries.length])),
			truncated: Object.fromEntries(Object.entries(collections).map(([name, entries]) => [name, entries.length > Math.min(limit, Math.max(0, entries.length - offset))])),
			page: {
				revision: state.revision, throughDigest: state.throughDigest, observedAt, offset, limit, nextCursor,
				order: "newest-page-first",
				omittedBefore: Object.fromEntries(Object.entries(collections).map(([name, entries]) => [name, Math.min(offset, entries.length)])),
				omittedAfter: Object.fromEntries(Object.entries(collections).map(([name, entries]) => [name, Math.max(0, entries.length - offset - limit)])),
				bounds: { perCollection: 100, connectedRevisions: DISCOVERY_BOUNDS.connectedRevisions, queryTerms: DISCOVERY_BOUNDS.queryTerms },
			},
			retrieval: { ...filters, matching: "any-subject-term; all terms retained", traversal: retrieval.traversal },
			limitations: "Pages pin knowledge, authority and assurance time; physical storage diagnostics remain live. Evidence is claimed or independent-claim; imports never adopt another session's native execution ownership. Compaction retains full history.",
		};
	};
	return inspect;
}

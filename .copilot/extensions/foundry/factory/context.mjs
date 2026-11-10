import { stableStringify } from "../digest.mjs";
import { enumeration, fail, list, reference, text } from "./fields.mjs";
import { contractFor, evaluationFor, key, knowledgeFor, privateKnowledge, privateStatement, retired, unitFor } from "./records.mjs";
import { affectedUnits } from "./signals.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").CapabilityUnit} CapabilityUnit */
/** @typedef {import("../types/factory.js").FactoryContract} FactoryContract */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").Knowledge} Knowledge */
/** @typedef {import("../types/factory.js").KnowledgeQuery} KnowledgeQuery */

const MAX_CONTEXT_BYTES = 128 * 1024;
const RATIONALE_RELATIONS = ["supports", "derived-from", "depends-on"];

export const DISCOVERY_BOUNDS = Object.freeze({
	knowledge: 32, connectedRevisions: 128, knowledgeBytes: 48 * 1024,
	signals: 8, signalBytes: 16 * 1024, contextBytes: MAX_CONTEXT_BYTES,
	queryCharacters: 8000, queryTerms: 32, selectionReasons: 16, superseders: 16,
});

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
			if (RATIONALE_RELATIONS.includes(link.relation)) pending.push(link.target);
		}
	}
	return rationale.sort((left, right) => key(left).localeCompare(key(right)));
}

/** @param {FactoryState} state @param {CapabilityUnit} unit @param {boolean} [historical] */
export function assertAcceptedDependencies(state, unit, historical = false) {
	/** @param {string} id @param {Set<string>} visited */
	const walk = (id, visited) => {
		if (id === unit.id) fail("factory_dependency_cycle", "Accepted capability boundaries cannot form a dependency cycle");
		if (visited.has(id)) return;
		visited.add(id);
		const contract = contractFor(state, id);
		if (contract.historyOnly && !historical) fail("factory_contract_reacceptance_required", "A migrated private-context dependency needs explicit portable contract acceptance");
		unitFor(state, id, contract.unitRevision).dependencies.forEach((dependency) => walk(dependency, visited));
	};
	return unit.dependencies.map((id) => {
		const contract = contractFor(state, id);
		walk(id, new Set());
		return { unitId: id, unitRevision: contract.unitRevision, contractRevision: contract.revision, contractDigest: contract.digest };
	});
}

/** @param {FactoryState} state @param {FactoryContract} contract @param {Set<string>} [seen] */
export function assertGenerationAuthority(state, contract, seen = new Set()) {
	const identity = `${contract.unitId}@${contract.revision}`;
	if (seen.has(identity)) return;
	seen.add(identity);
	if (contract.historyOnly) fail("factory_contract_reacceptance_required", "Historical private-context commitments need explicit portable re-acceptance before generation");
	for (const dependency of contract.dependencies) {
		assertGenerationAuthority(state, contractFor(state, dependency.unitId, dependency.contractRevision), seen);
	}
}

/** @param {FactoryState} state @param {KnowledgeRef} ref @param {"accepted" | "non-governing"} authority
 * @param {boolean} [portable] @returns {import("../types/factory.js").ProjectedKnowledge} */
function projectedKnowledge(state, ref, authority, portable = false) {
	const entry = knowledgeFor(state, ref);
	// Source refs, run/session paths and source artifacts stay in the inspectable
	// ledger. A lesson's provenance must not leak incumbent implementation inputs.
	return {
		id: entry.id, revision: entry.revision, unitId: entry.unitId, kind: entry.kind,
		authority, statement: portable && privateKnowledge(entry) ? privateStatement(entry) : entry.statement, uncertainty: entry.uncertainty, links: entry.links,
		...(authority === "accepted" && entry.evaluation ? { evaluation: entry.evaluation } : {}),
	};
}

/** @param {FactoryState} state @param {FactoryContract} contract @returns {Omit<import("../types/factory.js").FactoryDefinitions, "contract">} */
export function contractContext(state, contract) {
	return {
		sealVersion: contract.sealVersion,
		unit: unitFor(state, contract.unitId, contract.unitRevision),
		obligations: contract.obligations.map((ref) => projectedKnowledge(state, ref, "accepted")),
		evaluations: contract.evaluations.map((ref) => ({ ...projectedKnowledge(state, ref, "accepted"), evaluation: evaluationFor(state, ref) })),
		rationale: contract.rationale.map((ref) => projectedKnowledge(state, ref, "non-governing", contract.sealVersion >= 3)),
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
	assertGenerationAuthority(state, contract);
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

/** @param {string} left @param {string} right */
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

/** @param {unknown} value */
const bytes = (value) => Buffer.byteLength(stableStringify(value));

/** @param {KnowledgeQuery} input */
export function knowledgeQuery(input) {
	const query = input.query === undefined ? null : text(input.query, "query", DISCOVERY_BOUNDS.queryCharacters).trim();
	const allTerms = [...new Set(query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
		.sort((left, right) => right.length - left.length || compareText(left, right));
	if (query && !allTerms.length) fail("factory_input_invalid", "query must contain at least one search term");
	const terms = allTerms.slice(0, DISCOVERY_BOUNDS.queryTerms).sort(compareText);
	const kinds = list(input.kinds ?? [], "kinds", 5).map((kind) =>
		enumeration(kind, /** @type {const} */ (["observation", "inference", "proposal", "obligation", "evaluation"]), "knowledge kind"));
	const relatedTo = list(input.relatedTo ?? [], "relatedTo", 32).map(reference);
	if (new Set(kinds).size !== kinds.length || new Set(relatedTo.map(key)).size !== relatedTo.length) {
		fail("factory_input_invalid", "Knowledge filters must not contain duplicate kinds or references");
	}
	return { query, terms, omittedTerms: allTerms.length - terms.length, kinds: kinds.sort(compareText), relatedTo: relatedTo.sort((left, right) => compareText(key(left), key(right))) };
}

/** Selection is deliberately separate from contractContext: accepted seals never grow with later knowledge.
 * @param {FactoryState} state @param {KnowledgeQuery} input @param {boolean} [discovery] */
export function retrieveKnowledge(state, input = {}, discovery = false) {
	const filters = knowledgeQuery(input);
	if (input.unitId) unitFor(state, input.unitId);
	filters.relatedTo.forEach((ref) => knowledgeFor(state, ref));
	const byKey = new Map(state.knowledge.map((entry) => [key(entry), entry]));
	/** @type {Map<string, KnowledgeRef[]>} */
	const superseders = new Map();
	/** @type {Map<string, {target: KnowledgeRef, relation: string}[]>} */
	const connections = new Map();
	/** @param {KnowledgeRef} from @param {KnowledgeRef} target @param {string} relation */
	const connect = (from, target, relation) => {
		const links = connections.get(key(from)) ?? [];
		links.push({ target, relation });
		connections.set(key(from), links);
	};
	for (const entry of state.knowledge) for (const link of entry.links) {
		if (RATIONALE_RELATIONS.includes(link.relation) || ["contradicts", "supersedes"].includes(link.relation)) {
			connect(entry, link.target, link.relation);
			connect(link.target, entry, `inverse-${link.relation}`);
		}
		if (link.relation === "supersedes") {
			const revisions = superseders.get(key(link.target)) ?? [];
			revisions.push({ id: entry.id, revision: entry.revision });
			superseders.set(key(link.target), revisions);
		}
	}
	for (const links of connections.values()) links.sort((left, right) =>
		compareText(key(left.target), key(right.target)) || compareText(left.relation, right.relation));
	for (const revisions of superseders.values()) revisions.sort((left, right) => compareText(key(left), key(right)));
	const resolved = new Set(state.decisions.flatMap((decision) =>
		decision.kind === "accept-contract" ? decision.resolutions.map((entry) => key(entry.knowledge)) : []));
	/** @param {Knowledge} entry */
	const operational = (entry) => entry.kind === "observation"
		&& ["app-task", "implementation", "command", "native-workflow"].includes(entry.source.kind);
	/** @param {Knowledge} entry @returns {"current" | "superseded" | "retired"} */
	const revisionStatus = (entry) => retired(state, "knowledge", entry.id, entry.revision) ? "retired"
		: superseders.has(key(entry)) ? "superseded" : "current";
	const disputed = new Set();
	for (const entry of state.knowledge) {
		if (revisionStatus(entry) !== "current" || resolved.has(key(entry))) continue;
		if (entry.uncertainty && !operational(entry)) disputed.add(key(entry));
		for (const link of entry.links.filter((link) => link.relation === "contradicts")) {
			disputed.add(key(entry));
			disputed.add(key(link.target));
		}
	}
	const acknowledgedSignals = new Set(state.decisions.flatMap((decision) =>
		decision.kind === "accept-contract" && (!input.unitId || decision.unitId === input.unitId) ? decision.renewalSignalIds ?? [] : []));
	const signals = state.signals.filter((signal) => {
		if (!input.unitId) return true;
		const impact = affectedUnits(state, signal.unitIds, signal.knowledgeRefs);
		return [...impact.affectedUnitIds, ...impact.uncertainUnitIds].includes(input.unitId);
	}).map((signal) => ({
		signal, acknowledged: acknowledgedSignals.has(signal.id),
	})).sort((left, right) => Number(left.acknowledged) - Number(right.acknowledged)
		|| compareText(right.signal.recordedAt, left.signal.recordedAt) || compareText(left.signal.id, right.signal.id));
	const signalled = new Set(signals.filter((entry) => !entry.acknowledged).flatMap(({ signal }) => signal.knowledgeRefs.map(key)));
	const requested = new Set(filters.relatedTo.map(key));
	/** @param {Knowledge} entry */
	const describe = (entry) => {
		const searchable = `${entry.id} ${entry.kind} ${entry.statement} ${entry.uncertainty ?? ""}`.toLowerCase();
		const matches = filters.terms.filter((term) => searchable.includes(term));
		const causal = entry.links.some((link) => RATIONALE_RELATIONS.includes(link.relation))
			|| (connections.get(key(entry)) ?? []).some((link) => link.relation.startsWith("inverse-")
				&& RATIONALE_RELATIONS.includes(link.relation.slice(8)));
		const noise = operational(entry) && !causal;
		const reasons = [`kind:${entry.kind}`];
		if (requested.has(key(entry))) reasons.push("explicit-reference");
		if (matches.length) reasons.push(`subject:${matches.join(",")}`);
		if (signalled.has(key(entry))) reasons.push("active-signal");
		if (disputed.has(key(entry))) reasons.push("unresolved-knowledge");
		if (causal) reasons.push("causal-relationship");
		if (noise) reasons.push("operational-observation");
		const priority = requested.has(key(entry)) ? 0 : signalled.has(key(entry)) ? 100
			: disputed.has(key(entry)) ? 200 : matches.length && !noise ? 300
				: causal ? 400 : entry.kind !== "observation" ? 500 : !noise ? 600 : 700;
		return { entry, selectionReasons: reasons, revisionStatus: revisionStatus(entry),
			supersededBy: (superseders.get(key(entry)) ?? []).slice(0, DISCOVERY_BOUNDS.superseders),
			omittedSuperseders: Math.max(0, (superseders.get(key(entry))?.length ?? 0) - DISCOVERY_BOUNDS.superseders), priority, matches: matches.length };
	};
	/** @param {ReturnType<typeof describe>} left @param {ReturnType<typeof describe>} right */
	const compare = (left, right) => left.priority - right.priority || right.matches - left.matches
		|| compareText(right.entry.recordedAt, left.entry.recordedAt) || compareText(key(left.entry), key(right.entry));
	const candidates = state.knowledge.filter((entry) => (!input.unitId || entry.unitId === input.unitId)
		&& (input.includeRetired || !retired(state, "knowledge", entry.id, entry.revision))
		&& (!filters.kinds.length || filters.kinds.includes(entry.kind))).map(describe)
		.filter((entry) => discovery ? entry.revisionStatus === "current" || entry.matches || requested.has(key(entry.entry)) || signalled.has(key(entry.entry))
			: !filters.terms.length || entry.matches > 0).sort(compare);
	const selected = new Map(candidates.map((entry) => [key(entry.entry), entry]));
	const candidateKeys = new Set(selected.keys());
	const seeds = filters.relatedTo.length ? filters.relatedTo
		: discovery ? candidates.slice(0, DISCOVERY_BOUNDS.knowledge).map(({ entry }) => ({ id: entry.id, revision: entry.revision })) : [];
	const pending = seeds.map((ref) => ({ ref, priority: selected.get(key(ref))?.priority ?? 0, depth: 0 }));
	const queued = new Set(seeds.map(key));
	const visited = new Set();
	while (pending.length && visited.size < DISCOVERY_BOUNDS.connectedRevisions) {
		const current = pending.shift();
		if (!current) break;
		visited.add(key(current.ref));
		for (const link of connections.get(key(current.ref)) ?? []) {
			const entry = byKey.get(key(link.target));
			if (!entry) continue;
			const described = selected.get(key(entry)) ?? describe(entry);
			const reason = `linked:${link.relation}:${key(current.ref)}`;
			if (!described.selectionReasons.includes(reason) && described.selectionReasons.length < DISCOVERY_BOUNDS.selectionReasons) described.selectionReasons.push(reason);
			described.priority = Math.min(described.priority, current.priority + Math.min(current.depth + 1, 99));
			if (discovery || candidateKeys.has(key(entry))) selected.set(key(entry), described);
			if (!queued.has(key(entry))) {
				queued.add(key(entry));
				pending.push({ ref: entry, priority: current.priority, depth: current.depth + 1 });
			}
		}
	}
	const entries = [...selected.values()].filter((entry) => !filters.relatedTo.length || visited.has(key(entry.entry))).sort(compare);
	return {
		entries, signals, filters,
		traversal: { limit: DISCOVERY_BOUNDS.connectedRevisions, roots: seeds.length, visited: visited.size, omittedFrontier: pending.length, complete: pending.length === 0 },
	};
}

/** @param {FactoryState} state @param {string} unitId @param {{query?: string}} [input] */
export function discoveryContext(state, unitId, input = {}) {
	const selection = retrieveKnowledge(state, { unitId, ...input }, true);
	/** @type {import("../types/factory.js").RetrievedKnowledge[]} */
	const rationale = [];
	let omittedByBytes = 0;
	for (const { entry, selectionReasons, revisionStatus, supersededBy, omittedSuperseders } of selection.entries) {
		if (rationale.length >= DISCOVERY_BOUNDS.knowledge) break;
		const projected = { ...projectedKnowledge(state, { id: entry.id, revision: entry.revision }, "non-governing"), selectionReasons, revisionStatus, supersededBy, omittedSuperseders };
		if (bytes([...rationale, projected]) > DISCOVERY_BOUNDS.knowledgeBytes) { omittedByBytes++; continue; }
		rationale.push(projected);
	}
	/** @type {{id: string, kind: string, summary: string, knowledgeRefs: KnowledgeRef[], authority: "non-governing", acknowledged: boolean}[]} */
	const signals = [];
	for (const { signal, acknowledged } of selection.signals) {
		if (signals.length >= DISCOVERY_BOUNDS.signals) break;
		const projected = { id: signal.id, kind: signal.kind, summary: signal.summary, knowledgeRefs: signal.knowledgeRefs, authority: /** @type {const} */ ("non-governing"), acknowledged };
		if (bytes([...signals, projected]) <= DISCOVERY_BOUNDS.signalBytes) signals.push(projected);
	}
	return {
		rationale, signals,
		retrieval: {
			query: selection.filters.query, terms: selection.filters.terms, omittedQueryTerms: selection.filters.omittedTerms,
			matching: "any-selected-subject-term; longest terms first",
			bounds: DISCOVERY_BOUNDS, traversal: selection.traversal,
			eligible: selection.entries.length, selected: rationale.length, omitted: selection.entries.length - rationale.length, omittedByBytes,
			signals: { eligible: selection.signals.length, selected: signals.length, omitted: selection.signals.length - signals.length },
			limitations: "Retrieved lessons and signals are non-governing. A bounded link frontier may have further unvisited revisions; inspect pinned pages for retained history.",
		},
	};
}

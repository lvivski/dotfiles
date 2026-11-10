import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { fail, identifier, reference } from "./fields.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").Knowledge} Knowledge */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").EvaluationDefinition} EvaluationDefinition */
/** @template {KnowledgeRef} T @typedef {{length: number, latest: Map<string, T>, revisions: Map<string, T>}} RecordIndex */

/** @param {KnowledgeRef} ref */
export const key = (ref) => `${ref.id}@${ref.revision}`;

/** @param {unknown} left @param {unknown} right */
export const same = (left, right) => stableStringify(left) === stableStringify(right);

/** @param {Knowledge} entry */
export const privateKnowledge = (entry) => entry.kind === "observation"
	&& (entry.source.kind === "app-task" || (entry.id.startsWith("analysis-")
		&& ["audit", "research", "review", "security", "triage"].includes(entry.source.kind)));

/** @param {Knowledge} entry */
export const privateStatement = (entry) => `Local report omitted; statement commitment ${entry.statementCommitment ?? analysisInputDigest(entry.statement)}. Inspect the originating session for the raw evidence.`;

/** @type {WeakMap<object, RecordIndex<KnowledgeRef>>} */
const recordIndexes = new WeakMap();

/** @template {KnowledgeRef} T @param {T[]} entries @returns {RecordIndex<T>} */
function indexes(entries) {
	// Each cache entry is created only from the exact array used as its weak key.
	let index = /** @type {RecordIndex<T> | undefined} */ (recordIndexes.get(entries));
	if (!index || index.length > entries.length) {
		index = { length: 0, latest: new Map(), revisions: new Map() };
		recordIndexes.set(entries, index);
	}
	for (; index.length < entries.length; index.length++) {
		const entry = entries[index.length];
		index.latest.set(entry.id, entry);
		index.revisions.set(key(entry), entry);
	}
	return index;
}

/** @template {KnowledgeRef} T @param {T[]} entries @param {unknown} id */
export const latest = (entries, id) => typeof id === "string" ? indexes(entries).latest.get(id) : undefined;

/** @param {{id: string}[]} entries @param {unknown} id */
export const uniqueId = (entries, id) => {
	const checked = identifier(id);
	if (entries.some((entry) => entry.id === id)) fail("factory_identity_conflict", `Identity ${id} already exists`);
	return checked;
};

/** @param {FactoryState} state @param {unknown} ref */
export function knowledgeFor(state, ref) {
	const checked = reference(ref);
	const entry = indexes(state.knowledge).revisions.get(key(checked));
	if (!entry) fail("factory_knowledge_missing", `Knowledge ${key(checked)} does not exist`);
	return entry;
}

/** @param {FactoryState} state @param {KnowledgeRef} ref @returns {EvaluationDefinition} */
export function evaluationFor(state, ref) {
	const definition = knowledgeFor(state, ref).evaluation;
	if (!definition) fail("factory_contract_invalid", `Knowledge ${key(ref)} is not an evaluator`);
	return definition;
}

/** @param {FactoryState} state @param {unknown} id @param {unknown} [revision] */
export function unitFor(state, id, revision = undefined) {
	const unit = revision === undefined ? latest(state.units, id)
		: state.units.find((entry) => entry.id === id && entry.revision === revision);
	if (!unit) fail("factory_unit_missing", `Capability ${id} does not exist`);
	return unit;
}

/** @param {FactoryState} state @param {unknown} unitId @param {unknown} [revision] */
export function contractFor(state, unitId, revision = undefined) {
	const contracts = state.contracts.filter((entry) => entry.unitId === unitId);
	const contract = revision === undefined ? contracts.at(-1) : contracts.find((entry) => entry.revision === revision);
	if (!contract) fail("factory_contract_missing", `Capability ${unitId} needs explicitly accepted obligations and evaluations`);
	return contract;
}

/** @param {FactoryState} state @param {unknown} id */
export function candidateFor(state, id) {
	const candidate = state.candidates.find((entry) => entry.id === id);
	if (!candidate) fail("factory_candidate_missing", `Candidate ${id} does not exist`);
	return candidate;
}

/** @param {FactoryState} state @param {string} type @param {unknown} id @param {unknown} [revision] */
export function retired(state, type, id, revision = undefined) {
	return state.retirements.some((entry) => entry.type === type && entry.id === id
		&& (type !== "knowledge" || entry.revision === revision));
}

/** @param {FactoryState} state @param {string} unitId */
export function currentCandidate(state, unitId) {
	const decision = state.decisions.filter((entry) => entry.kind === "accept-candidate" && entry.unitId === unitId).at(-1);
	return decision?.kind === "accept-candidate" ? decision.candidateId : null;
}

/** @param {FactoryState} state @param {KnowledgeRef[]} references */
export function disputedKnowledge(state, references) {
	const selected = new Set(references.map(key));
	return state.knowledge.filter((entry) => (selected.has(key(entry)) && entry.uncertainty)
		|| entry.links.some((link) => link.relation === "contradicts"
			&& (selected.has(key(link.target)) || selected.has(key(entry)))));
}

/** @param {FactoryState} state @param {string} candidateId */
export function evaluationRetirementHolds(state, candidateId) {
	return state.bindings.filter((binding) => binding.purpose === "evaluation" && binding.candidateId === candidateId
		&& (binding.active ?? !binding.completion));
}

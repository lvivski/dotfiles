import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { operatingRecord } from "../plan/schemas/operating.mjs";
import { fail, reference } from "./fields.mjs";
import { operatingGeneration, operatingRecords } from "./operating.mjs";

/** @typedef {import("../types/factory.js").FactorySnapshot} Snapshot */
/** @typedef {import("../types/factory.js").KnowledgeRef} Reference */
/** @typedef {import("../types/operating.js").OperatingRecord} Record */
/** @typedef {import("../types/operating.js").OperatingCharter} Charter */
/** @typedef {import("../types/operating.js").OperatingDecision} Decision */
/** @param {Reference} left @param {Reference} right */
const matches = (left, right) => left.id === right.id && left.revision === right.revision;

/** @param {readonly Record[]} records @param {Reference} ref @returns {Charter} */
export function squadCharter(records, ref) {
	const record = records.find(record => matches(record, reference(ref)));
	if (record?.kind !== "charter") fail("squad_charter_missing", "An exact charter revision is required; a display name is not an identity");
	return record;
}

/** Validate retained revisions as well as the new batch. Historical attribution is
 * never converted into native ownership or accepted evaluation evidence.
 * @param {Snapshot} state @param {readonly Record[]} additions */
export function validateSquads(state, additions) {
	const history = operatingRecords(state);
	const records = [...history, ...additions].map(operatingRecord);
	const restricted = new Set(records.flatMap(record => record.context.filter(item => item.usage !== "generation").map(item => item.digest)));
	for (const record of records) {
		if (record.kind !== "charter" && record.kind !== "decision") continue;
		if (new Set(record.context.map(item => item.id)).size !== record.context.length) {
			fail("squad_context_conflict", "Context identities must be unique within a revision");
		}
		for (const context of record.context) {
			if (context.usage !== "generation") continue;
			if (restricted.has(context.digest)) fail("squad_comparison_context", "Private or comparison-only history cannot be relabeled as generation context");
			if (context.kind === "artifact") {
				if (!context.artifact || context.knowledge || context.digest !== context.artifact.digest) {
					fail("squad_context_invalid", "Artifact context requires one exact digest-bound artifact");
				}
				if (state.candidates.some(candidate => candidate.context.comparisonOnly.some(artifact =>
					artifact.digest === context.digest || artifact.ref === context.artifact?.ref))) {
					fail("squad_comparison_context", "Known comparison-only artifacts cannot become generation inputs");
				}
			} else {
				const ref = context.knowledge;
				if (!ref || context.artifact) fail("squad_context_invalid", "Knowledge and decision context require one exact reference");
				const target = context.kind === "decision"
					? records.find(item => item.kind === "decision" && matches(item, ref))
					: state.knowledge.find(item => matches(item, ref));
				if (!target) fail("squad_context_missing", "Generation context must resolve to retained exact knowledge or decision history");
				if (analysisInputDigest(target) !== context.digest) fail("squad_context_invalid", "Context digest must identify the exact retained revision");
			}
		}
		if (record.kind === "charter") {
			if (!record.decisions.length || new Set(record.decisions).size !== record.decisions.length) {
				fail("squad_categories_invalid", "A charter must declare a nonempty distinct set of bounded decision categories");
			}
			continue;
		}
		const charter = squadCharter(records, record.charter);
		if (!charter.decisions.includes(record.category)) fail("squad_decision_out_of_scope", "The pinned charter does not describe this decision category");
		const goal = record.goal;
		if (goal && !records.some(item => item.kind === "goal" && matches(item, goal)
			&& matches(item.charter, record.charter))) {
			fail("squad_goal_missing", "A decision goal must resolve to the same exact charter revision");
		}
		if (new Set(record.governing.map(ref => `${ref.id}@${ref.revision}`)).size !== record.governing.length
			|| record.governing.some(ref => !state.knowledge.some(item => matches(item, ref)))) {
			fail("squad_governing_missing", "Retain distinct, exact governing knowledge references, not invented acceptance");
		}
		if (record.category === "observation" && !["observation", "inference"].includes(record.status)
			|| record.category === "proposal" && record.status !== "proposal"
			|| !["observation", "proposal"].includes(record.category) && !["proposal", "historical"].includes(record.status)) {
			fail("squad_decision_status", "An observation or proposal cannot masquerade as an authoritative decision");
		}
		if (record.category === "human" && record.status === "historical" && record.source.kind !== "human") {
			fail("squad_human_identity", "An agent judgment cannot be recorded as a historical human decision");
		}
		const previous = records.find(item => item.id === record.id && item.revision === record.revision - 1);
		if (previous?.kind === "decision") {
			const attribution = (/** @type {Decision} */ entry) => ({
				category: entry.category, status: entry.status, source: entry.source,
				charter: entry.charter, goal: entry.goal, governing: entry.governing,
			});
			if (stableStringify(attribution(previous)) !== stableStringify(attribution(record))) {
				fail("squad_decision_immutable", "Revisions may clarify rationale but cannot rewrite decision authority or historical attribution");
			}
		}
	}
}

/** A portable, explicitly non-owning projection. It never includes owner-local
 * references or resolves referenced material into a prompt.
 * @param {Snapshot} state @param {Reference} ref */
export function squadHistory(state, ref) {
	validateSquads(state, []);
	const records = operatingRecords(state);
	const charter = squadCharter(records, ref);
	return {
		authority: /** @type {const} */ ("historical"),
		charter: structuredClone(charter),
		revisions: records.filter(record => record.kind === "charter" && record.id === charter.id).map(record => structuredClone(record)),
		decisions: records.filter(record => record.kind === "decision" && record.charter.id === charter.id).map(record => structuredClone(record)),
	};
}

/** The exact charter and its decisions only; later charter context must not leak
 * into a worker pinned to an earlier revision.
 * @param {Snapshot} state @param {Reference} ref */
export function squadGeneration(state, ref) {
	const history = squadHistory(state, ref);
	return {
		authority: history.authority,
		charter: { ...history.charter, context: operatingGeneration(history.charter).context },
		decisions: history.decisions.filter(record => record.kind === "decision" && matches(record.charter, ref)).map(operatingGeneration),
	};
}

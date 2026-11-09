import { stableStringify } from "../digest.mjs";
import { key } from "./records.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").EvaluationEvidence} EvaluationEvidence */
/** @typedef {import("../types/factory.js").Provenance} Provenance */
/** @typedef {import("../types/factory.js").PublicationDisposition} PublicationDisposition */

/** @param {Provenance} origin */
function evaluationOrigin(origin) {
	if (origin.kind === "app-task") return stableStringify(["app", origin.owner, origin.planId, origin.taskId, origin.attemptId, origin.sessionId]);
	if (origin.kind === "human") return stableStringify(["human-source", origin.ref.trim()]);
	return stableStringify([origin.kind, origin.owner ?? null, origin.runId ?? origin.sessionId ?? origin.ref]);
}

/** @param {Provenance} origin */
function evaluationOriginKeys(origin) {
	const keys = [evaluationOrigin(origin)];
	if (origin.kind === "human" && origin.judgmentId) keys.push(stableStringify(["human-judgment", origin.actor.trim(), origin.judgmentId.trim()]));
	return keys;
}

/** @param {Provenance} left @param {Provenance} right */
export function sameEvaluationOrigin(left, right) {
	const keys = new Set(evaluationOriginKeys(left));
	return evaluationOriginKeys(right).some((value) => keys.has(value));
}

/**
 * Publication order is not execution order. Coalesce historical origin aliases,
 * anchor each execution at its earliest claimed observation, and fail closed on
 * contradictory observations rather than letting an arrival order pick a pass.
 *
 * @param {Candidate} candidate @param {KnowledgeRef} ref
 * @returns {{evidence: EvaluationEvidence | null, conflicting: boolean, dispositions: Map<string, PublicationDisposition>}}
 */
export function evaluationObservation(candidate, ref) {
	const entries = candidate.evidence.filter((entry) => key(entry.evaluation) === key(ref));
	/** @typedef {{keys: Set<string>, entries: EvaluationEvidence[]}} OriginGroup */
	/** @type {Map<string, OriginGroup>} */
	const byOrigin = new Map();
	/** @type {Set<OriginGroup>} */
	const groups = new Set();
	for (const entry of entries) {
		const keys = evaluationOriginKeys(entry.source);
		const found = [...new Set(keys.map((value) => byOrigin.get(value)).filter((group) => group !== undefined))];
		const group = found[0] ?? { keys: new Set(), entries: [] };
		groups.add(group);
		for (const other of found.slice(1)) {
			group.entries.push(...other.entries);
			for (const value of other.keys) { group.keys.add(value); byOrigin.set(value, group); }
			groups.delete(other);
		}
		group.entries.push(entry);
		for (const value of keys) { group.keys.add(value); byOrigin.set(value, group); }
	}
	/** @param {EvaluationEvidence} entry */
	const meaning = (entry) => stableStringify([entry.outcome, entry.environment, entry.workload]);
	/** @param {EvaluationEvidence} entry */
	const originClaim = (entry) => stableStringify([meaning(entry), entry.trust, entry.source.actor, entry.independence.method]);
	const observations = [...groups].map((group) => {
		const ordered = [...group.entries].sort((a, b) => Date.parse(a.source.at) - Date.parse(b.source.at));
		return { evidence: ordered[0], duplicates: ordered.slice(1), conflicting: ordered.some((entry) => originClaim(entry) !== originClaim(ordered[0])) };
	});
	const newestAt = observations.reduce((latest, observation) => Math.max(latest, Date.parse(observation.evidence.source.at)), -Infinity);
	const newest = observations.filter((observation) => Date.parse(observation.evidence.source.at) === newestAt);
	newest.sort((a, b) => Number(b.evidence.trust === "independent-claim") - Number(a.evidence.trust === "independent-claim") || a.evidence.id.localeCompare(b.evidence.id));
	const evidence = newest[0]?.evidence ?? null;
	const conflicting = evidence !== null && newest.some((observation) => observation.conflicting || meaning(observation.evidence) !== meaning(evidence));
	/** @type {Map<string, PublicationDisposition>} */
	const dispositions = new Map();
	for (const observation of observations) {
		dispositions.set(observation.evidence.id, Date.parse(observation.evidence.source.at) < newestAt ? "historical"
			: conflicting ? "conflicting" : observation.evidence === evidence ? "current" : "corroborating");
		for (const duplicate of observation.duplicates) dispositions.set(duplicate.id, "duplicate-origin");
	}
	return { evidence, conflicting, dispositions };
}

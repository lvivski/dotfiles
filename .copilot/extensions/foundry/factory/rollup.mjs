import { candidateAssurance } from "./assurance.mjs";
import { evaluationCriterion } from "./criterion.mjs";
import { requiresHumanJudgment } from "./definitions.mjs";
import { fail, timestamp } from "./fields.mjs";
import { goalGraph, producerGaps, validateGoals } from "./goals.mjs";
import { evaluationObservation } from "./observations.mjs";
import { contractFor, evaluationFor, key, knowledgeFor, same } from "./records.mjs";

/** @typedef {import("../types/factory.js").FactorySnapshot} Snapshot */
/** @typedef {import("../types/factory.js").KnowledgeRef} Ref */
/** @typedef {import("../types/factory.js").EvaluationEvidence} Evidence */
/** @typedef {{evaluation: Ref, requirement: string, procedureDigest: string, modality: string,
 * preservation: boolean, visual: boolean, reasons: string[], selected: Evidence | null,
 * observations: {evidence: Evidence, disposition: string}[]}} Support */
/** @typedef {{relationship: Ref, target: Ref | null, requirement: string, reasons: string[]}} Dependency */
/** @typedef {{id: string, status: "supported" | "open", reasons: string[], evaluations: Support[], dependencies: Dependency[]}} Criterion */
/** @typedef {{goal: Ref, charter: Ref, status: "closed" | "open", criteria: Criterion[],
 * observedAt: string, trust: "claims-not-attestation", relationshipCoverage: "complete" | "partial"}} Rollup */
/** @typedef {{availableEnvironments?: readonly string[]}} Options */

/** A criterion selects existing canonical assurance, never a separately persisted
 * success flag. Task counts and historical acceptance do not participate.
 * @param {Snapshot} state @param {Ref} ref @param {string} at @param {Options} [options]
 * @returns {Rollup} */
export function goalRollup(state, ref, at, options = {}) {
	timestamp(at, "rollup.at");
	validateGoals(state, []);
	const graph = goalGraph(state);
	/** @type {Map<string, Rollup>} */
	const memo = new Map();
	/** @param {Ref} current @returns {Rollup} */
	function visit(current) {
		const cached = memo.get(key(current));
		if (cached) return cached;
		const goal = graph.resolve(current, "goal");
		const candidate = state.candidates.find(entry => entry.id === goal.candidateId);
		const contract = goal.contract ? contractFor(state, goal.contract.unitId, goal.contract.contractRevision) : null;
		/** @type {string[]} */
		const global = [];
		if (goal.authority !== "accepted") global.push("requirements-proposed");
		if (!contract) global.push("contract-unaccepted");
		else if (contract.historyOnly) global.push("contract-history-only");
		if (!candidate) global.push("candidate-missing");
		const assurance = candidate ? candidateAssurance(state, candidate, at) : null;
		if (assurance) {
			global.push(...assurance.missing.filter(reason =>
				!assurance.evaluationSupport.some(support => reason.startsWith(`${key(support.evaluation)}: `))));
		}
		/** @type {Criterion[]} */
		const criteria = goal.criteria.map(criterion => {
			const reasons = [...global];
			if (!criterion.obligation) reasons.push("obligation-unaccepted");
			if (!criterion.evaluations.length) reasons.push("evaluators-unresolved");
			// Context is criterion-local; an unavailable platform is not an implicit
			// waiver for the same evaluator on another supported platform.
			const scoped = candidate ? candidateAssurance(state, candidate, at, criterion) : null;
			const evaluations = criterion.evaluations.map(evaluation => {
				const definition = evaluationFor(state, evaluation);
				const knowledge = knowledgeFor(state, evaluation);
				const { id, revision, unitId, kind, statement, uncertainty, links } = knowledge;
				const observation = candidate ? evaluationObservation(candidate, evaluation) : null;
				const selected = observation?.evidence ?? null;
				const gaps = [...(scoped?.evaluationSupport.find(entry => same(entry.evaluation, evaluation))?.gaps
					?? [requiresHumanJudgment(definition) ? "pending-human" : "missing"])];
				if (options.availableEnvironments && !options.availableEnvironments.includes(criterion.environment)) gaps.push("unavailable-platform");
				if (selected && candidate) {
					if (selected.candidateId !== candidate.id || selected.commit !== candidate.delivery?.commit
						|| selected.contractDigest !== candidate.contractDigest || selected.contextDigest !== candidate.contextDigest
						|| selected.procedureDigest !== definition.procedure.digest
						|| (selected.identity && (selected.identity.candidateCommit !== selected.commit
							|| selected.identity.digest !== definition.procedure.digest
							|| selected.identity.evaluatorCommit !== definition.procedure.bundle?.commit))) gaps.push("evidence-identity-mismatch");
					if (requiresHumanJudgment(definition) && (selected.source.kind !== "human"
						|| selected.independence.method !== "human-review")) gaps.push("pending-human");
					if (definition.visual && selected.outcome === "failed") gaps.push("visually-rejected");
				}
				const support = {
					evaluation, requirement: evaluationCriterion({ id, revision, unitId, kind, statement, uncertainty, links,
						authority: goal.authority === "accepted" ? "accepted" : "non-governing", evaluation: definition }),
					procedureDigest: definition.procedure.digest, modality: definition.modality, preservation: definition.preservation,
					visual: Boolean(definition.visual), reasons: [...new Set(gaps)], selected: selected ? structuredClone(selected) : null,
					observations: (candidate?.evidence ?? []).filter(entry => same(entry.evaluation, evaluation)).map(entry => ({
						evidence: structuredClone(entry), disposition: observation?.dispositions.get(entry.id) ?? "unselected",
					})),
				};
				reasons.push(...support.reasons.map(reason => `${key(evaluation)}: ${reason}`));
				return support;
			});
			return { id: criterion.id, status: "open", reasons: [...new Set(reasons)], evaluations, dependencies: [] };
		});
		const result = { goal: { id: goal.id, revision: goal.revision }, charter: goal.charter,
			status: /** @type {const} */ ("open"), criteria, observedAt: at,
			trust: /** @type {const} */ ("claims-not-attestation"), relationshipCoverage: goal.relationshipCoverage };
		/** @type {Rollup} */
		const rollup = result;
		memo.set(key(current), rollup);
		for (const edge of graph.relationships.filter(entry => entry.from.id === goal.id)) {
			const reasons = [];
			if (!same(edge.from, current)) reasons.push("consumer-revision-changed");
			if (!edge.to) reasons.push("unresolved-requirement");
			else {
				if (!same(graph.effective.get(edge.to.id) && { id: edge.to.id, revision: graph.effective.get(edge.to.id)?.revision }, edge.to)) {
					reasons.push("producer-revision-changed");
				}
				const target = visit(edge.to);
				if (target.status !== "closed") reasons.push("producer-support-open");
				reasons.push(...producerGaps(state, edge, graph));
			}
			const dependency = { relationship: { id: edge.id, revision: edge.revision }, target: edge.to, requirement: edge.requirement, reasons };
			for (const criterion of criteria) {
				// Old endpoint criteria cannot silently discard blockers after rename.
				if (edge.criterionIds.includes(criterion.id) || !same(edge.from, current)) {
					criterion.dependencies.push(structuredClone(dependency));
					criterion.reasons.push(...reasons.map(reason => `${key(edge)}: ${reason}`));
				}
			}
		}
		const pending = new Map(goal.criteria.map(criterion => [criterion.id, criterion.dependsOn]));
		const complete = new Set();
		/** @param {Criterion} criterion */
		function resolveCriterion(criterion) {
			if (complete.has(criterion.id)) return;
			for (const id of pending.get(criterion.id) ?? []) {
				const dependency = criteria.find(entry => entry.id === id);
				if (!dependency) continue; // Already rejected by full graph validation.
				resolveCriterion(dependency);
				if (dependency.status !== "supported") criterion.reasons.push(`criterion-open: ${id}`);
			}
			criterion.reasons = [...new Set(criterion.reasons)];
			criterion.status = criterion.reasons.length ? "open" : "supported";
			complete.add(criterion.id);
		}
		for (const criterion of criteria) resolveCriterion(criterion);
		rollup.status = criteria.every(criterion => criterion.status === "supported") ? "closed" : "open";
		return rollup;
	}
	return structuredClone(visit(ref));
}

/** Reopening is a projection over explicit links; incomplete coverage is reported
 * separately rather than pretending every unknown consumer was localized.
 * @param {Snapshot} state @param {{goal: Ref, criterionIds: string[]}[]} changes */
export function goalImpact(state, changes) {
	validateGoals(state, []);
	const graph = goalGraph(state);
	/** @type {Map<string, Set<string>>} */
	const affected = new Map();
	for (const change of changes) {
		const goal = graph.resolve(change.goal, "goal");
		const ids = change.criterionIds.length ? change.criterionIds : goal.criteria.map(entry => entry.id);
		for (const id of ids) {
			if (!goal.criteria.some(criterion => criterion.id === id)) fail("goal_criterion_missing", `Unknown affected criterion ${id}`);
		}
		const prior = affected.get(goal.id) ?? new Set();
		for (const id of ids) prior.add(id);
		affected.set(goal.id, prior);
	}
	let changed = true;
	while (changed) {
		changed = false;
		for (const goal of graph.goals) {
			const ids = affected.get(goal.id) ?? new Set();
			const before = ids.size;
			for (const edge of graph.relationships) {
				if (edge.from.id === goal.id && edge.to && affected.has(edge.to.id)) {
					for (const id of same(edge.from, { id: goal.id, revision: goal.revision }) ? edge.criterionIds : goal.criteria.map(entry => entry.id)) ids.add(id);
				}
			}
			for (const criterion of goal.criteria) if (criterion.dependsOn.some(id => ids.has(id))) ids.add(criterion.id);
			if (ids.size) affected.set(goal.id, ids);
			if (ids.size !== before) changed = true;
		}
	}
	const incomplete = graph.goals.some(goal => affected.has(goal.id) && goal.relationshipCoverage === "partial");
	return {
		affected: [...affected].map(([id, ids]) => ({ goalId: id, criterionIds: [...ids].sort() })),
		uncertainGoalIds: incomplete ? graph.goals.filter(goal => !affected.has(goal.id)).map(goal => goal.id) : [],
		localization: incomplete ? "explicit-links-with-uncertain-downstream-impact" : "declared-complete-links",
	};
}

/** Readiness is an advisory projection for the existing admission machinery,
 * not a reservation, native authorization or launch instruction.
 * @param {Snapshot} state @param {Ref} ref @param {string} at
 * @param {{phase: "available" | "held" | "cancelled" | "unknown", reason: string}} admission
 * @param {Options} [options] */
export function goalReadiness(state, ref, at, admission, options = {}) {
	const rollup = goalRollup(state, ref, at, options);
	const blockers = rollup.criteria.flatMap(criterion => criterion.dependencies.flatMap(dependency =>
		dependency.reasons.map(reason => `${key(dependency.relationship)}: ${reason}`)));
	if (admission.phase !== "available") blockers.push(`admission-${admission.phase}: ${admission.reason}`);
	return { goal: rollup.goal, readyForExistingAdmission: blockers.length === 0, blockers: [...new Set(blockers)],
		admission: structuredClone(admission), rollup, authority: "projection-only" };
}

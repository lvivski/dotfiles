import { requiresHumanJudgment, source } from "./definitions.mjs";
import { digest, fail, integer, list, object, reference, strings, text } from "./fields.mjs";
import { candidateFor, contractFor, evaluationFor, key, retired, same, unitFor } from "./records.mjs";

/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").Candidate} Candidate */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["bindPlan" | "bindEvaluationPlan"]} */
export function bindPlan(state, event, options = {}) {
	const { action, input, at, revision } = event;
	const evaluating = action === "bindEvaluationPlan";
	object(input, ["unitId", "unitRevision", "contractRevision", "contractDigest", "contextDigest", "candidateId", "planId", "owner", "blueprintDigest", ...(evaluating ? ["evaluations", "targetCommit"] : [])], action);
	const unit = unitFor(state, input.unitId, integer(input.unitRevision, "unitRevision"));
	let contract = null;
	if (input.contractRevision === null) {
		if (input.contractDigest !== null || input.contextDigest !== null || input.candidateId !== null) {
			fail("factory_context_invalid", "Discovery bindings without an accepted contract cannot claim candidate context");
		}
	} else {
		contract = contractFor(state, input.unitId, integer(input.contractRevision, "contractRevision"));
		if (input.contractDigest !== contract.digest || input.unitRevision !== contract.unitRevision) {
			fail("factory_context_invalid", "Plan binding does not match the pinned accepted contract");
		}
	}
	const candidateId = input.candidateId ?? null;
	if (candidateId !== null && typeof candidateId !== "string") fail("factory_input_invalid", "candidateId must be text or null");
	const contextDigest = input.contextDigest;
	if (contextDigest !== null && typeof contextDigest !== "string") fail("factory_context_invalid", "Context digest must be text or null");
	/** @type {import("../types/factory.js").FactoryBinding} */
	const binding = {
		unitId: unit.id, candidateId,
		unitRevision: unit.revision, contractRevision: contract?.revision ?? null,
		contractDigest: contract?.digest ?? null, contextDigest,
		planId: text(input.planId, "planId", 64), owner: text(input.owner, "owner", 512),
		blueprintDigest: digest(input.blueprintDigest, "blueprintDigest"), at,
	};
	const existing = state.bindings.find((entry) => entry.planId === binding.planId && entry.owner === binding.owner);
	if (existing) fail("factory_plan_bound", "This session plan already has a factory binding");
	if (binding.candidateId) {
		const candidate = candidateFor(state, binding.candidateId);
		if (candidate.unitId !== input.unitId || (!evaluating && (candidate.binding || candidate.delivery))
			|| retired(state, "candidate", candidate.id)) fail("factory_candidate_bound", "Candidate is already bound, delivered, retired, or belongs to another unit");
		if (candidate.contractDigest !== binding.contractDigest || candidate.contextDigest !== binding.contextDigest) {
			fail("factory_context_invalid", "Candidate binding must retain the sealed contract and context");
		}
		if (evaluating) {
			if (!candidate.delivery || input.targetCommit !== candidate.delivery.commit) fail("factory_delivery_required", "Read-only evaluation needs the immutable delivered commit");
			const selected = list(input.evaluations, "evaluations", 32, 1).map(reference);
			const contract = contractFor(state, candidate.unitId, candidate.contractRevision);
			if (new Set(selected.map(key)).size !== selected.length
				|| selected.some((ref) => !contract.evaluations.some((accepted) => key(accepted) === key(ref)))) fail("factory_evaluator_changed", "Evaluation plans must select pinned accepted evaluator revisions");
			if (!selected.some((ref) => !requiresHumanJudgment(evaluationFor(state, ref)))) fail("factory_human_judgment_required", "Human-only work uses explicit judgment, not an App agent");
			Object.assign(binding, { purpose: "evaluation", evaluations: selected, targetCommit: candidate.delivery.commit, completion: null, active: true });
		} else {
			if (!options.historical && candidate.context.independence.method === "fresh-process") fail("factory_app_generation_origin", "App dispatch provides session/attempt provenance, not fresh process provenance. Prepare a fresh-session candidate or use an actual external process.");
			candidate.binding = binding;
		}
	} else if (binding.contextDigest !== null) {
		fail("factory_context_invalid", "Only candidates have a generation context digest");
	}
	state.bindings.push(binding);
	return { binding };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["activateEvaluationPlan"]} */
export function activateEvaluationPlan(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["candidateId", "owner", "planId"], action);
	const candidate = candidateFor(state, input.candidateId);
	const binding = state.bindings.find((entry) => entry.purpose === "evaluation"
		&& entry.candidateId === candidate.id && entry.owner === input.owner && entry.planId === input.planId);
	if (!binding) fail("factory_execution_mismatch", "Evaluation activation requires its existing owned binding");
	if (retired(state, "candidate", candidate.id)) fail("factory_candidate_retired", "Retired candidates cannot start new evaluation work");
	if (binding.active === true) return { binding, idempotent: true };
	binding.active = true;
	binding.activatedAt = at;
	return { binding };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["recordCompletion"]} */
export function recordCompletion(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["candidateId", "source", "passed", "commit", "evidenceIds"], action);
	const candidate = candidateFor(state, input.candidateId);
	const origin = source(input.source, at);
	if (!candidate.binding || !candidate.delivery || origin.kind !== "native-workflow"
		|| origin["owner"] !== candidate.binding.owner || origin["planId"] !== candidate.binding.planId
		|| input.commit !== candidate.delivery.commit || typeof input.passed !== "boolean") {
		fail("factory_execution_mismatch", "Completion must identify the exact bound plan, owner, verification run and delivered commit");
	}
	if (candidate.completion) fail("factory_completion_immutable", "Candidate completion is immutable");
	candidate.completion = { source: origin, passed: input.passed, commit: input.commit, evidenceIds: strings(input.evidenceIds, "evidenceIds", 128), recordedAt: at };
	return { candidate };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["recordEvaluationCompletion"]} */
export function recordEvaluationCompletion(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["candidateId", "source", "passed", "commit", "evidenceIds"], action);
	const candidate = candidateFor(state, input.candidateId);
	const origin = source(input.source, at);
	const binding = state.bindings.find((entry) => entry.purpose === "evaluation"
		&& entry.candidateId === candidate.id && entry.owner === origin["owner"] && entry.planId === origin["planId"]);
	if (!binding || !candidate.delivery || origin.kind !== "native-workflow"
		|| input.commit !== candidate.delivery.commit || typeof input.passed !== "boolean") {
		fail("factory_execution_mismatch", "Evaluation completion requires its own bound plan, native run and immutable target commit");
	}
	const completion = { source: origin, passed: input.passed, commit: input.commit, evidenceIds: strings(input.evidenceIds, "evidenceIds", 128), recordedAt: at };
	const previous = options.historical
		? (binding.completion?.source.runId === origin["runId"] ? binding.completion : null)
		: (binding.completions ?? [binding.completion]).find((entry) => entry?.source.runId === origin["runId"]);
	if (previous) {
		if (previous.passed === input.passed && same(previous.evidenceIds, completion.evidenceIds)) return { binding, idempotent: true };
		fail("factory_completion_immutable", "A completed evaluation run cannot change its result");
	}
	binding.completions = [...(binding.completions ?? []), completion];
	binding.completion = completion;
	binding.active = false;
	return { binding };

}

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["abandonPlan"]} */
export function abandonPlan(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["candidateId", "source", "reason"], action);
	const candidate = candidateFor(state, input.candidateId);
	const origin = source(input.source, at);
	const binding = state.bindings.find((entry) => entry.candidateId === candidate.id && entry.owner === origin["owner"] && entry.planId === origin["planId"]);
	if (!binding || origin.kind !== "human"
		|| (binding.purpose === "evaluation" ? binding.completion?.disposition === "cancelled" && !binding.active : candidate.completion)) {
		fail("factory_execution_mismatch", "Abandonment requires the owning plan's completed cancellation");
	}
	/** @type {import("../types/factory.js").Completion} */
	const completion = {
		source: origin, passed: false, commit: candidate.delivery?.commit ?? null, evidenceIds: [],
		disposition: "cancelled", reason: text(input.reason, "cancellation reason"), recordedAt: at,
	};
	if (binding.purpose === "evaluation") {
		binding.completions = [...(binding.completions ?? []), completion];
		binding.completion = completion;
		binding.active = false;
	}
	else candidate.completion = completion;
	return { candidate };

}

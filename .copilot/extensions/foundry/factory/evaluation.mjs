import { analysisInputDigest } from "../digest.mjs";
import { property } from "../data.mjs";
import { candidateAssurance } from "./assurance.mjs";
import { requiresHumanJudgment, source } from "./definitions.mjs";
import { enumeration, fail, object, reference, text } from "./fields.mjs";
import { evaluationObservation, sameEvaluationOrigin } from "./observations.mjs";
import { candidateFor, contractFor, evaluationFor, key, same, uniqueId } from "./records.mjs";
import { evaluationIdentity } from "./procedures.mjs";
import { visualReport } from "./visual.mjs";

/** @typedef {import("../types/factory.js").FactoryEvent} FactoryEvent */
/** @typedef {import("../types/factory.js").FactoryState} FactoryState */
/** @typedef {import("../types/factory.js").EvaluationEvidence} EvaluationEvidence */
/** @typedef {import("../types/factory.js").FactoryResults} FactoryResults */

/** @param {FactoryState} state @param {FactoryEvent} event
 * @param {{historical?: boolean}} [options] @returns {FactoryResults["recordEvaluation"]} */
export function recordEvaluation(state, event, options = {}) {
	const { action, input, at, revision } = event;
	object(input, ["id", "candidateId", "evaluation", "contractDigest", "contextDigest", "commit", "outcome", "source", "environment", "workload", "independence", "report", "procedureDigest", "identity"], action);
	const candidate = candidateFor(state, input.candidateId);
	if (!candidate.delivery) fail("factory_delivery_required", "Evaluation requires an immutable delivered candidate");
	const ref = reference(input.evaluation);
	const contract = contractFor(state, candidate.unitId, candidate.contractRevision);
	if (!contract.evaluations.some((entry) => key(entry) === key(ref))
		|| input.contractDigest !== candidate.contractDigest || input.contextDigest !== candidate.contextDigest
		|| input.commit !== candidate.delivery.commit) fail("factory_evidence_subject_mismatch", "Evidence must name the exact candidate commit and pinned contract/context/evaluation revisions");
	const definition = evaluationFor(state, ref);
	visualReport(definition, text(input.report, "evidence.report"), candidate.delivery.commit, String(input.outcome));
	if (input.procedureDigest !== definition.procedure.digest) fail("factory_evaluator_changed", "Evidence does not use the pinned evaluator");
	const origin = source(input.source, at);
	if (Date.parse(origin.at) < Date.parse(candidate.delivery.source.at)) fail("factory_evidence_predates_delivery", "Evaluation must follow the actual delivery");
	const human = requiresHumanJudgment(definition);
	const identity = input.identity === undefined ? undefined : evaluationIdentity(input.identity);
	if (identity && (human || definition.procedure.kind !== "command" || !definition.procedure.bundle
		|| identity.evaluatorCommit !== definition.procedure.bundle.commit
		|| identity.candidateCommit !== candidate.delivery.commit || identity.digest !== definition.procedure.digest)) {
		fail("factory_evaluator_changed", "Mechanical identity must name this exact executable bundle and delivered candidate");
	}
	if (!options.historical && !human && definition.procedure.kind === "reference" && input.outcome !== "inconclusive") {
		fail("factory_evaluator_unsupported", "A non-executable reference cannot establish a passed executable check", { disposition: "unsupported" });
	}
	const binding = state.bindings.find((entry) => entry.candidateId === candidate.id && entry.owner === origin["owner"] && entry.planId === origin["planId"]);
	const retirement = state.retirements.find((entry) => entry.type === "candidate" && entry.id === candidate.id);
	if (retirement && !(origin.kind === "app-task" && binding?.purpose === "evaluation" && binding.at <= retirement.at)) {
		fail("factory_delivery_required", "Retired candidates only retain receipts from evaluation work already bound before retirement");
	}
	if (!human && (candidate.binding || origin.kind === "app-task")
		&& (origin.kind !== "app-task" || !binding || origin["sessionId"] === candidate.delivery.source.sessionId
			|| (binding.purpose === "evaluation" && !binding.evaluations?.some((selected) => key(selected) === key(ref))))) {
		fail("factory_execution_mismatch", "App evaluation must come from a separately bound verifier of this exact candidate");
	}
	object(input.independence, ["method", "reason"], "evidence.independence");
	const independence = {
		method: enumeration(input.independence.method, ["separate-session", "separate-process", "human-review", "same-context"], "evidence.independence.method"),
		reason: text(input.independence.reason, "evidence.independence.reason"),
	};
	if (human && (origin.kind !== "human" || independence.method !== "human-review")) {
		fail("factory_human_judgment_required", "A human evaluation requires an explicitly attributed human judgment, not an agent or process verdict");
	}
	if (!human && origin.kind === "human") fail("factory_evaluation_modality", "A human judgment cannot stand in for the pinned executable evaluation");
	const existing = candidate.evidence.find((entry) => entry.id === input.id);
	if (existing) {
		const expected = { ...input, source: origin, independence };
		if (Object.keys(expected).every((field) => same(property(existing, field), property(expected, field)))) return { evidence: existing, assurance: candidateAssurance(state, candidate, at), idempotent: true };
		fail("factory_evidence_immutable", "An evaluation receipt cannot change after publication");
	}
	if (!options.historical && candidate.evidence.some((entry) => key(entry.evaluation) === key(ref)
		&& sameEvaluationOrigin(entry.source, origin))) {
		fail("factory_evaluation_origin_reused", "Changing a receipt ID or timestamp cannot turn an already reported evaluation execution into fresh evidence");
	}
	const producer = candidate.delivery.source;
	const sameProducer = (origin["sessionId"] && origin["sessionId"] === producer.sessionId)
		|| (origin["runId"] && origin["runId"] === producer.runId);
	const independent = !sameProducer && (independence.method === "separate-session"
		? origin["sessionId"] && origin["sessionId"] !== producer.sessionId
		: independence.method === "separate-process"
			? origin["runId"] && origin["runId"] !== producer.runId
			: independence.method === "human-review" && origin.kind === "human" && origin.actor !== producer.actor);
	/** @type {EvaluationEvidence} */
	const evidence = {
		id: uniqueId(state.candidates.flatMap((entry) => entry.evidence), input.id),
		candidateId: candidate.id, evaluation: ref, contractDigest: candidate.contractDigest,
		contextDigest: candidate.contextDigest, commit: candidate.delivery.commit,
		procedureDigest: definition.procedure.digest,
		outcome: enumeration(input.outcome, ["passed", "failed", "inconclusive"], "evidence.outcome"),
		source: origin, environment: text(input.environment, "evidence.environment"),
		workload: text(input.workload, "evidence.workload"), independence,
		report: text(input.report, "evidence.report"),
		reportDigest: analysisInputDigest(input.report),
		trust: independent ? "independent-claim" : "claimed", recordedAt: at,
		...(identity ? { identity } : {}),
	};
	candidate.evidence.push(evidence);
	const observation = evaluationObservation(candidate, ref);
	return {
		evidence, assurance: candidateAssurance(state, candidate, at),
		publication: { disposition: observation.dispositions.get(evidence.id), currentEvidenceId: observation.evidence?.id ?? null },
	};

}

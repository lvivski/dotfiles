import { isRecord } from "../data.mjs";
import { fail, reference } from "../factory/fields.mjs";
import { candidateFor, contractFor, evaluationFor } from "../factory/records.mjs";
import { checkEvaluator, resolveEvaluatorBundle } from "./bundles.mjs";
import { requireCommit } from "./git.mjs";

/** External observations are resolved before append acquires the writer transaction.
 * The ledger subsequently rechecks the exact revision and all pure domain rules.
 * @param {string} repository
 * @param {import("../types/factory.js").FactoryAction} action
 * @param {Record<string, unknown>} input
 * @param {import("../types/factory.js").FactorySnapshot} state */
export function guardFactoryEvidence(repository, action, input, state) {
	if (input.expectedRevision !== state.revision) fail("revision_conflict", "Repository factory has changed", { expectedRevision: input.expectedRevision, latestRevision: state.revision });
	if (action === "appendKnowledge" && isRecord(input.evaluation) && isRecord(input.evaluation.procedure)
		&& input.evaluation.procedure.bundle !== undefined) {
		const procedure = input.evaluation.procedure;
		if (procedure.kind !== "command" || input.evaluation.modality === "human") fail("factory_evaluation_modality", "Only executable commands can pin evaluator bundles");
		const resolved = resolveEvaluatorBundle(repository, procedure.bundle);
		if (procedure.digest !== undefined && procedure.digest !== resolved.digest) fail("factory_evaluator_changed", "The supplied evaluator digest does not match the actual Git bundle and invocation");
		return { ...input, evaluation: { ...input.evaluation, procedure: { ...procedure, bundle: resolved.bundle, digest: resolved.digest } } };
	}
	if (action === "acceptContract" && Array.isArray(input.evaluations)) {
		for (const ref of input.evaluations) checkEvaluator(repository, evaluationFor(state, reference(ref)));
	}
	if (action === "recordDelivery" && !candidateFor(state, input.candidateId).delivery) requireCommit(repository, input.commit);
	if (action === "decideCandidate" && input.action === "accept") {
		const candidate = candidateFor(state, input.candidateId);
		const commit = requireCommit(repository, candidate.delivery?.commit);
		for (const ref of contractFor(state, candidate.unitId, candidate.contractRevision).evaluations) {
			checkEvaluator(repository, evaluationFor(state, ref), commit);
		}
	}
	if (action === "recordEvaluation") {
		if (Object.hasOwn(input, "identity")) fail("factory_evaluator_identity_reserved", "Mechanical identity is computed by the service, never accepted from a caller");
		const candidate = candidateFor(state, input.candidateId);
		// Exact retries preserve historical receipts rather than retroactively upgrading them.
		if (candidate.evidence.some((entry) => entry.id === input.id)) return input;
		const definition = evaluationFor(state, reference(input.evaluation));
		if (!candidate.delivery || input.commit !== candidate.delivery.commit) fail("factory_evidence_subject_mismatch", "Evaluation must name the exact delivered candidate");
		const identity = checkEvaluator(repository, definition, candidate.delivery.commit);
		if (identity) return { ...input, identity };
	}
	return input;
}

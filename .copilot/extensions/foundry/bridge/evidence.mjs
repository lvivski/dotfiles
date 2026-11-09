import { isList, property } from "../data.mjs";
import { candidateAssurance } from "../factory/assurance.mjs";
import { requiresHumanJudgment } from "../factory/definitions.mjs";
import { fail } from "../factory/fields.mjs";
import { evaluationObservation } from "../factory/observations.mjs";
import { key as refKey } from "../factory/records.mjs";
import { latestSuccessfulAttempt } from "../plan/queries.mjs";
import { validateFactoryEvaluations } from "../plan/schemas/factory.mjs";
import { selectEvaluations } from "./pinning.mjs";
import { evaluationId, pendingReceipts } from "./receipts.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {FoundryPlan & {factory: NonNullable<FoundryPlan["factory"]>}} BoundPlan */
/** @typedef {import("../types/factory.js").FactorySnapshot} FactorySnapshot */
/** @typedef {ReturnType<typeof import("../factory.mjs").createFactoryService>} FactoryService */

/**
 * @param {ReturnType<typeof import("./authority.mjs").createAuthority>["stateFor"]} stateFor
 * @param {() => string} workspace
 */
export function createEvidenceBridge(stateFor, workspace) {

	/** @param {FoundryPlan} plan @param {string} taskId @param {unknown} rawReports @param {unknown} evidence */
	const validateReports = (plan, taskId, rawReports, evidence) => {
		const reports = rawReports ?? [];
		validateFactoryEvaluations(reports);
		if (!plan.factory?.candidateId || plan.tasks.find((task) => task.id === taskId)?.kind !== "verify") return;
		const { factory } = stateFor(plan);
		const generation = factory.generation(plan.factory.candidateId);
		const definitions = selectEvaluations(generation.evaluations, plan.evaluationTarget?.evaluations);
		const automatic = definitions.filter((entry) => !requiresHumanJudgment(entry.evaluation));
		if ((reports?.length ?? 0) !== automatic.length) fail("factory_evaluation_coverage", "Verifier must report every selected executable evaluation; human judgments are recorded separately");
		for (const [index, entry] of automatic.entries()) {
			const report = reports.find((report) => refKey(report.evaluation) === refKey(entry));
			if (!report || report.procedureDigest !== entry.evaluation.procedure.digest) fail("factory_evaluator_changed", "Verifier report must use the exact accepted evaluation revision and procedure");
			const check = isList(evidence) ? evidence.find((item) => property(item, "checkId") === `T-001-C${String(index + 1).padStart(3, "0")}`) : undefined;
			if (property(check, "outcome") !== (report.outcome === "passed" ? "passed" : "failed")) fail("factory_evidence_contradiction", "Canonical verifier checks and factory evaluation outcomes disagree");
		}
	};

	/** @param {BoundPlan} plan @param {FactoryService} factory @param {FactorySnapshot} state @returns {import("../types/factory.js").FactoryDefinitions} */
	const pinnedDefinitions = (plan, factory, state) => {
		const unit = state.units.find((entry) => entry.id === plan.factory.unitId && entry.revision === plan.factory.unitRevision);
		if (!unit) fail("factory_unit_missing", "Plan references a missing capability boundary");
		if (!plan.factory.contractRevision) return {
			unit,
			contract: null, obligations: [], evaluations: [], rationale: [], decisionLineage: [], foundations: [],
		};
		const context = factory.contractContext(plan.factory.unitId, plan.factory.contractRevision);
		return { ...context, evaluations: selectEvaluations(context.evaluations, plan.evaluationTarget?.evaluations) };
	};

	/** @param {BoundPlan} plan @param {FactoryService} factory @param {FactorySnapshot} state */
	const pendingHumanFor = (plan, factory, state) => {
		if (!plan.factory.candidateId) return [];
		const candidate = state.candidates.find((entry) => entry.id === plan.factory.candidateId);
		if (!candidate) fail("factory_candidate_missing", "Plan references a missing candidate");
		const definitions = pinnedDefinitions(plan, factory, state);
		const support = candidateAssurance(state, candidate, new Date().toISOString());
		return definitions.evaluations.filter((entry) => requiresHumanJudgment(entry.evaluation))
			.map((entry) => ({
				evaluation: { id: entry.id, revision: entry.revision }, definition: entry.evaluation,
				gaps: support.evaluationSupport.find((item) => refKey(item.evaluation) === refKey(entry))?.gaps ?? ["pending-human"]
			}))
			.filter((entry) => entry.gaps.some((gap) => gap !== "failed"));
	};

	/** @param {FoundryPlan} rawPlan */
	const verificationContext = (rawPlan) => {
		const { factory, state, plan } = stateFor(rawPlan);
		const definitions = pinnedDefinitions(plan, factory, state);
		const candidate = state.candidates.find((entry) => entry.id === plan.factory.candidateId);
		const humanEvidence = definitions.evaluations.filter((entry) => requiresHumanJudgment(entry.evaluation))
			.map((entry) => candidate ? evaluationObservation(candidate, entry).evidence : null)
			.filter((entry) => entry !== null);
		const verifyTask = plan.tasks.find((task) => task.kind === "verify");
		if (!verifyTask) fail("factory_execution_mismatch", "Plan requires a verifier");
		const verifier = latestSuccessfulAttempt(verifyTask);
		const observations = candidate && verifier ? (verifier.factoryEvaluations ?? []).map((report) => {
			const id = evaluationId(plan, verifier, report);
			const evidence = candidate.evidence.find((entry) => entry.id === id);
			if (!evidence) fail("factory_evaluation_coverage", "The plan's own evaluation receipt is not yet published");
			const observation = evaluationObservation(candidate, report.evaluation);
			return {
				evaluation: report.evaluation, receiptId: evidence.id, observedAt: evidence.source.at,
				publishedAt: evidence.recordedAt, disposition: observation.dispositions.get(evidence.id),
				currentEvidenceId: observation.evidence?.id ?? null,
			};
		}) : [];
		return { version: /** @type {const} */ (1), definitions, humanEvidence, observations };
	};

	/** @param {FoundryPlan} rawPlan @param {boolean} [passing] */
	const verificationGate = (rawPlan, passing = false) => {
		const { factory, state, plan } = stateFor(rawPlan);
		if (!plan.factory.candidateId) return;
		const candidate = state.candidates.find((entry) => entry.id === plan.factory.candidateId);
		if (!candidate) fail("factory_candidate_missing", "Plan references a missing candidate");
		if (pendingHumanFor(plan, factory, state).length) fail("factory_human_judgment_pending", "Pinned human judgments are missing or stale; collect an explicit human review, never an agent verdict");
		const assurance = candidateAssurance(state, candidate, new Date().toISOString());
		const definitions = pinnedDefinitions(plan, factory, state);
		const verifyTask = plan.tasks.find((task) => task.kind === "verify");
		if (!verifyTask) fail("factory_execution_mismatch", "Plan requires a verifier");
		const verifier = latestSuccessfulAttempt(verifyTask);
		const reports = verifier?.factoryEvaluations ?? [];
		if (!verifier || reports.length !== definitions.evaluations.filter((entry) => !requiresHumanJudgment(entry.evaluation)).length) fail("factory_evaluation_coverage", "Independent pinned evaluations are missing");
		const missing = plan.evaluationTarget
			? definitions.evaluations.flatMap((definition) => {
				if (requiresHumanJudgment(definition.evaluation)) return assurance.evaluationSupport
					.filter((entry) => refKey(entry.evaluation) === refKey(definition)).flatMap((entry) => entry.gaps);
				const report = reports.find((entry) => refKey(entry.evaluation) === refKey(definition));
				const receipt = report ? candidate.evidence.find((entry) => entry.id === evaluationId(plan, verifier, report)) : null;
				if (!receipt) return [`${refKey(definition)}: missing plan receipt`];
				return receipt.outcome !== "passed" || receipt.environment !== definition.evaluation.environment
					|| receipt.workload !== definition.evaluation.workload
					|| (definition.evaluation.independent && receipt.trust !== "independent-claim")
					? [`${refKey(definition)}: plan observation does not pass its pinned evaluation`] : [];
			})
			: assurance.missing.filter((gap) => gap !== "plan-verification");
		if (passing && missing.length) fail("factory_assurance_incomplete", "Passing verification is unsupported by the pinned factory evidence", { missing });
	};

	/** @param {FoundryPlan} rawPlan */
	const inspectPlan = (rawPlan) => {
		const { factory, state, plan } = stateFor(rawPlan, false);
		const pending = pendingReceipts(plan, state).map((receipt) => receipt.label);
		return {
			...factory.inspect({ unitId: plan.factory.unitId, limit: 50 }),
			pendingHuman: pendingHumanFor(plan, factory, state),
			synchronization: { pending, owned: plan.factory.owner === workspace() },
		};
	};
	return { validateReports, verificationContext, verificationGate, inspectPlan };
}

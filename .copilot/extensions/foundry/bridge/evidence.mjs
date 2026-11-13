import { isList, property } from "../data.mjs";
import { candidateAssurance } from "../factory/assurance.mjs";
import { requiresHumanJudgment } from "../factory/definitions.mjs";
import { fail } from "../factory/fields.mjs";
import { evaluationObservation } from "../factory/observations.mjs";
import { key as refKey } from "../factory/records.mjs";
import { latestSuccessfulAttempt } from "../plan/queries.mjs";
import { validateFactoryEvaluations } from "../plan/schemas/factory.mjs";
import { evaluationCheckId, selectEvaluations } from "./pinning.mjs";
import { evaluationId, pendingReceipts } from "./receipts.mjs";
import { checkEvaluator } from "../evidence/bundles.mjs";
import { checkVisualReport } from "../evidence/visual.mjs";
import { declaredVisual, visualCriterion } from "../factory/visual.mjs";
import { validateTaskTopology } from "../plan/graph.mjs";
import { assessPackageAssurance } from "../analysis/assurance.mjs";
import { createHash } from "node:crypto";
import { git, requireAncestor, requireCommit } from "../evidence/git.mjs";

/** Owner-resolved subject in, checked independent claims out; no authority or ledger mutation.
 * @param {string} repository @param {import("../analysis/assurance.mjs").AssuranceSubject} subject @param {unknown} report @param {string} [at] */
export function validatePackageAssurance(repository, subject, report, at = new Date().toISOString()) {
	const result = assessPackageAssurance(report, subject, at);
	for (const entry of subject.protectedDefinitions) checkEvaluator(repository, entry.evaluation, subject.delivery.commit);
	for (const commit of new Set([subject.inputs.bootstrap.commit, ...subject.inputs.deliveries.map((entry) => entry.commit)])) {
		requireAncestor(repository, commit, subject.delivery.commit);
	}
	for (const item of [...subject.inputs.inputs.map((entry) => entry.artifact), ...subject.delivery.outputs.map((entry) => entry.artifact)]) {
		requireCommit(repository, item.commit);
		const tree = git(repository, ["ls-tree", "-z", "--full-tree", item.commit, "--", item.path]);
		if (tree.error || tree.status !== 0 || !tree.stdout.toString("utf8").startsWith(`${item.mode} blob `)
			|| tree.stdout.toString("utf8").split("\0").filter(Boolean).length !== 1
			|| tree.stdout.toString("utf8").split("\t")[1] !== `${item.path}\0`) {
			fail("parallel_assurance_artifact", "Input/output path or executable mode differs from the immutable artifact");
		}
		const blob = git(repository, ["show", `${item.commit}:${item.path}`]);
		if (blob.error || blob.status !== 0 || createHash("sha256").update(blob.stdout).digest("hex") !== item.digest) {
			fail("parallel_assurance_artifact", "Input/output bytes differ from the immutable artifact");
		}
	}
	for (const entry of subject.definitions) {
		const observed = result.evaluations.find((item) => refKey(item.evaluation) === refKey(entry));
		if (observed) checkVisualReport(repository, entry.evaluation, observed.report, subject.delivery.commit, observed.outcome);
	}
	return result;
}

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {FoundryPlan & {factory: NonNullable<FoundryPlan["factory"]>}} BoundPlan */
/** @typedef {import("../types/factory.js").FactorySnapshot} FactorySnapshot */
/** @typedef {ReturnType<typeof import("../factory.mjs").createFactoryService>} FactoryService */

/**
 * @param {ReturnType<typeof import("./authority.mjs").createAuthority>["stateFor"]} stateFor
 * @param {() => string} workspace
 */
export function createEvidenceBridge(stateFor, workspace) {

	/** External evaluator reads happen before the plan writer transaction.
	 * @param {FoundryPlan} plan @param {string} taskId @param {unknown} rawReports @param {unknown} evidence
	 * @param {string | null | undefined} [commit] */
	const validateReports = (plan, taskId, rawReports, evidence, commit) => {
		const reports = rawReports ?? [];
		validateFactoryEvaluations(reports);
		const { factory, state } = stateFor(plan);
		if (plan.tasks.find((task) => task.id === taskId)?.kind !== "verify") return state.revision;
		const unit = state.units.find((entry) => entry.id === plan.factory?.unitId && entry.revision === plan.factory.unitRevision);
		const visual = unit ? declaredVisual(state, unit) : null;
		if (!plan.factory?.candidateId) {
			if (visual) {
				const report = reports.find((entry) => refKey(entry.evaluation) === refKey(visual));
				if (reports.length !== 1 || !report || report.procedureDigest !== visual.evaluation.procedure.digest
					|| report.environment !== visual.evaluation.environment || report.workload !== visual.evaluation.workload || !commit) {
					fail("factory_visual_required", "UI discovery needs its declared independent visual report, even without an accepted contract/candidate");
				}
				const target = validateTaskTopology(plan.tasks).targetTask;
				const index = target?.acceptanceCriteria.indexOf(visualCriterion(visual)) ?? -1;
				const checkId = `${target?.id}-C${String(index + 1).padStart(3, "0")}`;
				const check = isList(evidence) ? evidence.find((item) => property(item, "checkId") === checkId) : undefined;
				if (index < 0 || property(check, "outcome") !== (report.outcome === "passed" ? "passed" : "failed")) fail("factory_visual_contradiction", "Visual report must agree with the declared canonical visual criterion");
				checkEvaluator(plan.repository.workingDirectory, visual.evaluation, commit);
				checkVisualReport(plan.repository.workingDirectory, visual.evaluation, report.report, commit, report.outcome);
			}
			return state.revision;
		}
		const generation = factory.generation(plan.factory.candidateId);
		const candidate = state.candidates.find((entry) => entry.id === plan.factory?.candidateId);
		if (!candidate?.delivery || candidate.delivery.commit !== commit) fail("factory_evidence_subject_mismatch", "Verifier must name the exact immutable delivered candidate");
		const definitions = selectEvaluations(generation.evaluations, plan.evaluationTarget?.evaluations);
		const automatic = definitions.filter((entry) => !requiresHumanJudgment(entry.evaluation));
		if ((reports?.length ?? 0) !== automatic.length) fail("factory_evaluation_coverage", "Verifier must report every selected executable evaluation; human judgments are recorded separately");
		for (const entry of automatic) {
			const report = reports.find((report) => refKey(report.evaluation) === refKey(entry));
			if (!report || report.procedureDigest !== entry.evaluation.procedure.digest) fail("factory_evaluator_changed", "Verifier report must use the exact accepted evaluation revision and procedure");
			if (report.environment !== entry.evaluation.environment || report.workload !== entry.evaluation.workload) fail("factory_evidence_subject_mismatch", "Verifier report must retain the exact evaluation environment and workload");
			const checkId = evaluationCheckId(plan, entry);
			const check = isList(evidence) ? evidence.find((item) => property(item, "checkId") === checkId) : undefined;
			if (property(check, "outcome") !== (report.outcome === "passed" ? "passed" : "failed")) fail("factory_evidence_contradiction", "Canonical verifier checks and factory evaluation outcomes disagree");
			if (entry.evaluation.procedure.kind === "reference" && report.outcome !== "inconclusive") fail("factory_evaluator_unsupported", "Non-executable references cannot be reported as executed checks", { disposition: "unsupported" });
			checkEvaluator(plan.repository.workingDirectory, entry.evaluation, candidate.delivery.commit);
			checkVisualReport(plan.repository.workingDirectory, entry.evaluation, report.report, candidate.delivery.commit, report.outcome);
		}
		return state.revision;
	};

	/** @param {BoundPlan} plan @param {FactoryService} factory @param {FactorySnapshot} state @returns {import("../types/factory.js").FactoryDefinitions} */
	const pinnedDefinitions = (plan, factory, state) => {
		const unit = state.units.find((entry) => entry.id === plan.factory.unitId && entry.revision === plan.factory.unitRevision);
		if (!unit) fail("factory_unit_missing", "Plan references a missing capability boundary");
		const visual = declaredVisual(state, unit);
		if (!plan.factory.contractRevision) return {
			unit,
			contract: null, obligations: [], evaluations: [], rationale: [], decisionLineage: [], foundations: [],
			...(visual ? { visualEvaluation: visual } : {}),
		};
		const context = factory.contractContext(plan.factory.unitId, plan.factory.contractRevision);
		return { ...context, evaluations: selectEvaluations(context.evaluations, plan.evaluationTarget?.evaluations),
			...(visual ? { visualEvaluation: visual } : {}) };
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

	/** @param {FoundryPlan} rawPlan @param {boolean} [passing] @param {boolean} [visualOnly] */
	const verificationGate = (rawPlan, passing = false, visualOnly = false) => {
		const { factory, state, plan } = stateFor(rawPlan);
		const definitions = pinnedDefinitions(plan, factory, state);
		const visual = definitions.visualEvaluation;
		if (visualOnly && !visual) return;
		if (visual) {
			const verifier = plan.tasks.find((task) => task.kind === "verify");
			const attempt = verifier ? latestSuccessfulAttempt(verifier) : null;
			const report = attempt?.factoryEvaluations?.find((entry) => refKey(entry.evaluation) === refKey(visual));
			if (!attempt?.commit || !report) fail("factory_visual_required", "Declared UI work cannot finish without independent visual evidence");
			checkVisualReport(plan.repository.workingDirectory, visual.evaluation, report.report, attempt.commit, report.outcome);
			if (passing && report.outcome !== "passed") fail("factory_visual_required", "Missing capture or failed reference-to-output assessment blocks completion");
		}
		if (!plan.factory.candidateId) return;
		const candidate = state.candidates.find((entry) => entry.id === plan.factory.candidateId);
		if (!candidate) fail("factory_candidate_missing", "Plan references a missing candidate");
		if (pendingHumanFor(plan, factory, state).length) fail("factory_human_judgment_pending", "Pinned human judgments are missing or stale; collect an explicit human review, never an agent verdict");
		const assurance = candidateAssurance(state, candidate, new Date().toISOString());
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

import { analysisInputDigest, stableStringify } from "../digest.mjs";
import { property } from "../data.mjs";
import { fail } from "../factory/fields.mjs";
import { key as refKey, same as sameRefs } from "../factory/records.mjs";
import { latestSuccessfulAttempt } from "../plan/queries.mjs";

/** @typedef {FoundryPlan & {factory: NonNullable<FoundryPlan["factory"]>}} BoundPlan */
/** @typedef {import("../types/plan.js").FoundryTask} FoundryTask */
/** @typedef {import("../types/plan.js").FoundryAttempt} FoundryAttempt */
/** @typedef {import("../types/factory.js").FactorySnapshot} FactorySnapshot */
/** @typedef {import("../types/factory.js").FactoryReceipt & {label: string}} FactoryReceipt */
/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */

/** @param {BoundPlan} plan @param {FoundryTask} task @param {FoundryAttempt} attempt @param {number | string} index */
const observationId = (plan, task, attempt, index) =>
	`learn-${analysisInputDigest([plan.factory.owner, plan.id, task.id, attempt.id, index]).slice(0, 40)}`;

/** @param {BoundPlan} plan @param {FoundryAttempt} attempt @param {import("../types/plan.js").EvaluationReport} report */
export const evaluationId = (plan, attempt, report) =>
	`eval-${analysisInputDigest([plan.factory.owner, plan.id, attempt.id, report.evaluation]).slice(0, 40)}`;

/** @param {BoundPlan} plan @param {FoundryTask} task @param {FoundryAttempt} attempt */
export const origin = (plan, task, attempt) => ({
	kind: attempt.sessionId ? "app-task" : "implementation",
	ref: `foundry:${plan.id}/${task.id}/${attempt.id}`, actor: attempt.sessionId ?? plan.factory.owner,
	at: attempt.completedAt, owner: plan.factory.owner, planId: plan.id, taskId: task.id, attemptId: attempt.id,
	...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
});

/** @param {BoundPlan} plan @param {FactorySnapshot} state */
export const receiptsFor = (plan, state) => {
	/** @type {FactoryReceipt[]} */
	const receipts = [];
	/** @param {FactoryReceipt["action"]} action @param {Record<string, unknown>} input @param {string} label */
	const add = (action, input, label) => receipts.push({ action, input, label });
	for (const decision of plan.technicalDecisions ?? []) {
		if (decision.renewal) add("acceptContract", {
			...decision.renewal.publication, technical: decision,
		}, `technical renewal ${decision.id}`);
	}
	const candidate = state.candidates.find((entry) => entry.id === plan.factory.candidateId);
	const binding = state.bindings.find((entry) => entry.owner === plan.factory.owner && entry.planId === plan.id);
	if (candidate && plan.status === "cancelled") {
		if (!binding || !plan.cancellation) fail("factory_execution_mismatch", "Cancellation requires its owned binding and metadata");
		if (plan.evaluationTarget ? binding.active || binding.completion?.disposition !== "cancelled" : !candidate.completion) add("abandonPlan", {
			candidateId: candidate.id, reason: plan.cancellation.reason,
			source: {
				kind: "human", ref: `foundry-cancellation:${plan.id}/${plan.cancellation.requestId}`,
				actor: plan.cancellation.finalizedBy, at: plan.cancellation.finalizedAt,
				owner: plan.factory.owner, planId: plan.id,
			},
		}, "terminal abandonment");
	}
	for (const review of [
		{ stage: "planning", value: plan.planning?.conceptualReview, runId: plan.planning?.runId, at: plan.createdAt, digest: plan.planning?.inputDigest },
		{ stage: "verification", value: plan.verification.conceptualReview, runId: plan.verification.runId, at: plan.verification.completedAt, digest: plan.verification.inputDigest },
	]) {
		if (!review.value || !review.runId) continue;
		const links = (state.contracts.find((entry) => entry.unitId === plan.factory.unitId && entry.revision === plan.factory.contractRevision)?.obligations ?? [])
			.map((target) => ({ relation: "depends-on", target }));
		const items = [...review.value.proposals.map((statement) => ({ kind: "proposal", statement })),
		...review.value.gaps.map((statement) => ({ kind: "observation", statement }))];
		items.forEach((entry, index) => add("appendKnowledge", {
			id: `simplify-${analysisInputDigest([plan.factory.owner, plan.id, review.runId, index]).slice(0, 40)}`,
			unitId: plan.factory.unitId, ...entry, links,
			uncertainty: "Bounded conceptual simplification review, not accepted intent or a minimality proof. Conserve the linked external meaning/evaluations; judgment or contract changes require explicit acceptance.",
			source: { kind: "native-workflow", ref: `workflow:${review.runId}`, actor: `workflow:${review.stage}`, owner: plan.factory.owner, runId: review.runId, at: review.at, digest: review.digest },
		}, `${review.stage}: conceptual review ${index}`));
	}
	for (const task of plan.tasks) for (const attempt of task.attempts) {
		if (!attempt.completedAt) continue;
		/** @type {import("../types/plan.js").Learning[]} */
		const learning = [
			{ kind: "observation", statement: attempt.resultSummary ?? attempt.error ?? `Attempt ended ${attempt.status}`, uncertainty: "Task report is an implementation claim, not an accepted obligation." },
			...(attempt.learning ?? []),
		];
		learning.forEach((entry, index) => {
			const id = observationId(plan, task, attempt, index);
			add("appendKnowledge", {
				id, unitId: plan.factory.unitId, ...entry, uncertainty: entry.uncertainty ?? null,
				links: [], source: origin(plan, task, attempt),
			}, `${task.id}/${attempt.id}: learning ${index}`);
		});
		if (plan.status === "cancelled" && attempt.factoryEvaluations?.length) add("appendKnowledge", {
			id: observationId(plan, task, attempt, "unpublished"),
			unitId: plan.factory.unitId, kind: "observation",
			statement: `Cancelled plan report was not published as assurance. Reported commit: ${attempt.commit}. ${stableStringify(attempt.factoryEvaluations)}`,
			uncertainty: "Unpublished, potentially invalid report; bounded excerpt only. The original complete report remains in the plan.",
			links: [], source: origin(plan, task, attempt),
		}, `${task.id}/${attempt.id}: unpublished cancellation report`);
	}
	if (!candidate || plan.status === "cancelled") return receipts;
	const verifyTask = plan.tasks.find((task) => task.kind === "verify");
	if (!verifyTask) fail("factory_execution_mismatch", "A factory plan requires its verifier");
	const targetTask = plan.tasks.find((task) => task.id === verifyTask.dependsOn[0]);
	const target = targetTask ? latestSuccessfulAttempt(targetTask) : null;
	const verifier = latestSuccessfulAttempt(verifyTask);
	if (target && targetTask) {
		add("recordDelivery", {
			candidateId: candidate.id, commit: target.commit,
			artifact: { kind: "implementation", ref: `git:${target.commit}`, digest: analysisInputDigest({ repositoryId: plan.factory.repositoryId, commit: target.commit }) },
			source: origin(plan, targetTask, target),
		}, "candidate delivery");
	}
	if (verifier && (target || plan.evaluationTarget)) for (const report of verifier.factoryEvaluations ?? []) {
		const id = evaluationId(plan, verifier, report);
		const { independenceReason, ...evaluation } = report;
		add("recordEvaluation", {
			id, candidateId: candidate.id, ...evaluation,
			commit: verifier.commit, contractDigest: candidate.contractDigest, contextDigest: candidate.contextDigest,
			source: origin(plan, verifyTask, verifier),
			independence: { method: "separate-session", reason: independenceReason },
		}, `evaluation ${refKey(report.evaluation)}`);
	}
	if ((target || plan.evaluationTarget) && ["completed", "failed"].includes(plan.status) && plan.verification.runId) add(plan.evaluationTarget ? "recordEvaluationCompletion" : "recordCompletion", {
		candidateId: candidate.id, commit: plan.evaluationTarget?.commit ?? target?.commit, passed: plan.status === "completed" && plan.verification.status === "passed",
		evidenceIds: plan.verification.evidence,
		source: {
			kind: "native-workflow", ref: `workflow:${plan.verification.runId}`,
			actor: plan.gates.completionApprovedBy ?? plan.factory.owner, at: plan.updatedAt,
			owner: plan.factory.owner, planId: plan.id, runId: plan.verification.runId,
		},
	}, "candidate completion");
	return receipts;
};

/** @param {FactorySnapshot} state @param {FactoryReceipt} receipt */
export const receiptPresent = (state, receipt) => {
	const { action, input } = receipt;
	if (action === "acceptContract") {
		const technical = property(input, "technical");
		const existing = state.decisions.find(entry => entry.kind === "accept-contract" && entry.technical
			&& entry.technical.id === property(technical, "id")
			&& entry.technical.delegation.scope.owner === property(property(property(technical, "delegation"), "scope"), "owner"));
		if (!existing) return false;
		if (existing.kind !== "accept-contract" || !sameRefs(existing.technical, technical)) {
			fail("factory_receipt_conflict", "Published technical decision differs from the immutable owner-local receipt");
		}
		return true;
	}
	const candidate = state.candidates.find((entry) => entry.id === input.candidateId);
	const binding = state.bindings.find((entry) => entry.owner === property(input.source, "owner") && entry.planId === property(input.source, "planId"));
	const existing = action === "appendKnowledge" ? state.knowledge.find((entry) => entry.id === input.id)
		: action === "recordDelivery" ? candidate?.delivery
			: action === "recordEvaluation" ? candidate?.evidence.find((entry) => entry.id === input.id)
				: action === "recordEvaluationCompletion"
					? (binding?.completions ?? [binding?.completion]).find((entry) => entry?.source.runId === property(input.source, "runId"))
					: action === "abandonPlan" && binding?.purpose === "evaluation" ? binding.completion : candidate?.completion;
	if (!existing) return false;
	if (action === "abandonPlan" && property(existing, "disposition") !== "cancelled") return false;
	const fields = Object.keys(input).filter((field) => field !== "candidateId");
	if (!fields.every((field) => sameRefs(property(existing, field), input[field]))) {
		fail("factory_receipt_conflict", `Persisted ${receipt.label} disagrees with its immutable plan receipt`);
	}
	return true;
};

/** @param {BoundPlan} plan @param {FactorySnapshot} state */
export const pendingReceipts = (plan, state) => receiptsFor(plan, state).filter((receipt) => !receiptPresent(state, receipt));

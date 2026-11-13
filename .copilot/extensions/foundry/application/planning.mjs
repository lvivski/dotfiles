import { approvePlan, retryFailedPlan, transitionPlan } from "../plan/lifecycle.mjs";
import { assertString } from "../plan/fields.mjs";
import { LIMITS, PLAN_STATUS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** @param {{
 * analysis: Pick<WorkflowAnalysis, "preparePlanning" | "importPlanning">,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "context" | "createBoundDraft" | "requireRetry" | "activateEvaluation" | "verificationGate">,
 * persist: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["persist"],
 * syncFactoryPlan: ReturnType<typeof import("./repository.mjs").createRepositoryOperations>["syncFactoryPlan"],
 * approveDelegated: ReturnType<typeof import("./approval.mjs").createApprovalOperations>["approveDelegated"],
 * }} dependencies */
export function createPlanningOperations({ analysis, factory, persist, syncFactoryPlan, approveDelegated }) {

	/**
	 * Builds the native planning Workflow launch specification.
	 *
	 * @param {Request<"preparePlan">} input
	 */
	const preparePlan = async (input) => {
		const factoryContext = factory.context(input.repositoryPath, input.unitId, { query: input.objective });
		if (input.intent !== undefined && input.intent !== "discovery") {
			throw new FoundryOperationError("factory_planning_intent", "Native planning intent must be discovery; accepted reconstruction uses a sealed candidate");
		}
		if (factoryContext.contract && input.intent !== "discovery") {
			throw new FoundryOperationError("factory_candidate_required", "Accepted capabilities use prepare_candidate and create_factory_plan by default. Explicit intent: discovery is only for exploration, not replacement.");
		}
		return analysis.preparePlanning({ ...input, factoryContext: { ...factoryContext, purpose: "discovery" } });
	};

	/**
	 * Imports a completed planning run as a new draft artifact.
	 *
	 * @param {Request<"createPlan">} input
	 * @param {{signal?: AbortSignal}} [options]
	 */
	const createPlan = async ({
		expectedRevision,
		id,
		repository,
		runId,
	}, { signal } = {}) => {
		const imported = await analysis.importPlanning(runId, { signal });
		signal?.throwIfAborted();
		if (!imported.factoryContext) {
			throw new FoundryOperationError("factory_context_required", "Planning results must carry canonical factory context; prepare a capability-backed plan");
		}
		const created = await factory.createBoundDraft({
			id, repository, expectedRevision, blueprint: imported.plan,
			planning: { runId, inputDigest: imported.inputDigest, ...(imported.conceptualReview ? { conceptualReview: imported.conceptualReview } : {}) },
			factoryContext: imported.factoryContext,
		});
		syncFactoryPlan(created);
		return created;
	};

	/**
	 * Moves a draft into explicit approval review.
	 *
	 * @param {{planId: string, expectedRevision: number}} input
	 */
	const submitPlan = async ({ planId, expectedRevision }) => {
		return persist(
			planId,
			expectedRevision,
			(plan) => transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL),
			"plan-submitted",
		);
	};

	/**
	 * Records initial approval, correction retry, or completion approval.
	 *
	 * @param {Request<"approve">} input
	 * @param {import("../requests.mjs").OperationContext} [options]
	 */
	const approve = async ({
		planId,
		expectedRevision,
		approvedBy,
		approvalType = "plan",
		retryStatus = PLAN_STATUS.RUNNING,
		delegationId,
		review,
	}, options = {}) => {
		if (delegationId && (!["plan", "completion"].includes(approvalType) || approvedBy !== undefined)) {
			throw new FoundryOperationError("delegation_approval_type", "Delegation supports only its explicitly granted initial-plan or technical-completion kind; its native agent attribution cannot be supplied by the caller");
		}
		if (!delegationId) assertString(approvedBy, "approvedBy", LIMITS.actor);
		const updated = await persist(
			planId,
			expectedRevision,
			(plan, delegation) => {
				if (delegationId) return approveDelegated(plan, delegation, review, options, approvalType === "completion" ? "completion" : "plan");
				assertString(approvedBy, "approvedBy", LIMITS.actor);
				if (approvalType === "plan") return approvePlan(plan, approvedBy);
				if (approvalType === "completion") {
					factory.verificationGate(plan, true, true);
					return transitionPlan(plan, PLAN_STATUS.COMPLETED, { actor: approvedBy });
				}
				if (approvalType !== "retry") throw new TypeError(`Unknown approvalType ${approvalType}`);
				factory.requireRetry(plan);
				if (retryStatus !== PLAN_STATUS.RUNNING) {
					throw new FoundryOperationError("invalid_retry_status", "Failed Foundry plans retry directly to running");
				}
				const retry = retryFailedPlan(plan, approvedBy);
				if (plan.evaluationTarget) syncFactoryPlan(plan);
				factory.activateEvaluation(retry);
				return retry;
			},
			approvalType === "retry" ? null : delegationId ? approvalType === "completion" ? "completion-approved:delegated" : "plan-approved:delegated" : `plan-approved:${approvalType}`,
			{ delegationId },
		);
		if (approvalType === "completion") syncFactoryPlan(updated);
		return updated;
	};
	return { preparePlan, createPlan, submitPlan, approve };
}

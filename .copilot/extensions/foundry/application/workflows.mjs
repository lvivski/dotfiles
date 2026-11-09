import { errorMessage } from "../data.mjs";
import { PLAN_STATUS, VERIFICATION_STATUS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */
/** @typedef {import("../types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */
/** @typedef {import("../types/workflow.js").WorkflowDiscovery} Discovery */
/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** Selects the same verification run for board summaries and detail reads. @param {FoundryPlan} plan @param {Discovery} discovery */
function visibleVerificationRunId(plan, discovery) {
	return discovery.state === "found" ? discovery.run.runId : plan.verification.runId;
}

/** @param {{
 * analysis: Pick<WorkflowAnalysis, "listWorkflowRuns" | "inspectWorkflow" | "getWorkflowProgress" | "controlWorkflow">,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "requireOwner">,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * readForMutation: ReturnType<typeof import("./mutation.mjs").createPlanMutations>["readForMutation"],
 * discoverReservedVerification: ReturnType<typeof import("./ownership.mjs").createVerificationOwnership>["discoverReservedVerification"],
 * assertVerificationRun: ReturnType<typeof import("./ownership.mjs").createVerificationOwnership>["assertVerificationRun"],
 * }} dependencies */
export function createWorkflowOperations({ analysis, factory, storeFor, readForMutation, discoverReservedVerification, assertVerificationRun }) {

	/** @param {FoundryPlan} plan */
	const workflowStatus = async (plan) => {
		try {
			factory.requireOwner(plan);
			const [page, discovery] = await Promise.all([
				analysis.listWorkflowRuns(),
				discoverReservedVerification(plan),
			]);
			const verificationRunId = visibleVerificationRunId(plan, discovery);
			if (verificationRunId && !page.runs.some((run) => run.runId === verificationRunId)) {
				page.runs.push(await analysis.inspectWorkflow(verificationRunId));
			}
			const runs = page.runs
				.filter((run) => run.workflowName !== "verify" || run.runId === verificationRunId)
				.map((run) => ({
					...run,
					actions: run.workflowName === "verify"
						&& (discovery.state !== "found" || plan.status !== PLAN_STATUS.RUNNING)
						? []
						: run.status === "running"
							? ["pause"]
							: run.canResume && run.terminal?.failure?.type !== "workflow_limit_reached"
								? ["resume"] : [],
				}))
				.sort((left, right) => right.createdAt - left.createdAt);
			return {
				state: /** @type {const} */ ("available"), runs, omittedOlder: page.omittedOlder,
				warning: discovery.state === "inconclusive" ? discovery.reason
					: plan.verification.status === VERIFICATION_STATUS.RESERVED && discovery.state === "absent"
						? "The reserved verification run has not been observed yet." : null,
			};
		} catch (error) {
			return { state: /** @type {const} */ ("unavailable"), error: errorMessage(error) };
		}
	};

	/**
	 * Reads native diagnostics without changing the plan or Workflow.
	 * @param {Request<"getWorkflow">} input
	 * @returns {Promise<import("@github/copilot-sdk").WorkflowRunDetail>}
	 */
	const getWorkflow = async ({ planId, runId, beforeSeq }) => {
		if (beforeSeq !== undefined && (typeof beforeSeq !== "number" || !Number.isSafeInteger(beforeSeq) || beforeSeq <= 0)) {
			throw new FoundryOperationError("workflow_progress_cursor_invalid", "beforeSeq must be a positive safe integer");
		}
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		const detail = await analysis.inspectWorkflow(runId);
		const assertVisible = async () => {
			if (detail.workflowName !== "verify") return;
			const discovery = await discoverReservedVerification(plan);
			const expectedRunId = visibleVerificationRunId(plan, discovery);
			if (detail.runId !== expectedRunId) {
				throw new FoundryOperationError(
					"verification_run_mismatch",
					`Verification run ${runId} is not visible for this plan`,
					{ expectedRunId, runId },
				);
			}
		};
		await assertVisible();
		const progress = beforeSeq === undefined
			? detail.progress : await analysis.getWorkflowProgress(runId, beforeSeq);
		if (beforeSeq !== undefined) await assertVisible();
		await readForMutation(planId, plan.revision);
		return beforeSeq === undefined ? detail : { ...detail, progress };
	};

	/**
	 * Native controls never change plan approval or App task-attempt state.
	 * @param {Request<"controlWorkflow">} input
	 * @param {{signal?: AbortSignal}} [options]
	 */
	const controlWorkflow = async ({ runId, action, planId, expectedRevision }, { signal } = {}) => {
		signal?.throwIfAborted();
		if (planId) factory.requireOwner(await storeFor().read(planId));
		if (action !== "pause" && action !== "resume") {
			throw new FoundryOperationError("workflow_action_invalid", "Workflow action must be pause or resume");
		}
		const detail = await analysis.inspectWorkflow(runId);
		if (detail.workflowName === "verify") {
			if (!planId || typeof expectedRevision !== "number" || !Number.isSafeInteger(expectedRevision)) {
				throw new FoundryOperationError("verification_plan_required", "Verification controls require planId and expectedRevision");
			}
			const plan = await readForMutation(planId, expectedRevision);
			if (plan.status !== PLAN_STATUS.RUNNING || plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
				throw new FoundryOperationError("verification_not_reserved", "Only the running plan's active verification reservation can be controlled");
			}
			await assertVerificationRun(plan, runId);
			await readForMutation(planId, expectedRevision);
		}
		return analysis.controlWorkflow(runId, action, { signal });
	};
	return { workflowStatus, getWorkflow, controlWorkflow };
}

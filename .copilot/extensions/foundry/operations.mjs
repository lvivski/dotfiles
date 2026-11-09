import { createCancellationOperations } from "./application/cancellation.mjs";
import { createPlanMutations } from "./application/mutation.mjs";
import { createVerificationOwnership } from "./application/ownership.mjs";
import { createPlanningOperations } from "./application/planning.mjs";
import { createPlanAccess } from "./application/plans.mjs";
import { createRepositoryOperations } from "./application/repository.mjs";
import { createStatusOperations } from "./application/status.mjs";
import { createSessionStorage } from "./application/storage.mjs";
import { createTaskOperations } from "./application/tasks.mjs";
import { createVerificationOperations } from "./application/verification.mjs";
import { createWorkflowOperations } from "./application/workflows.mjs";
import { createFactoryBridge } from "./bridge.mjs";
import { requestHandler } from "./requests.mjs";

/** @typedef {ReturnType<typeof createFoundryOperations>} FoundryOperations */

/**
 * @typedef {object} FoundryOperationsOptions
 * @property {() => string | undefined} getWorkspacePath
 * @property {(event: {workspacePath: string, planId: string, revision: number}) => void} [notify]
 * @property {WorkflowAnalysis} analysis Native Workflow adapter.
 * @property {string} [factoryStorageRoot] Private root override for isolated fixtures.
 */
/** @typedef {import("./types/workflow.js").WorkflowAnalysisPort} WorkflowAnalysis */

/**
 * Creates the complete Foundry application service for one Copilot session.
 *
 * Stores are cached per session workspace while every mutation remains
 * revision-checked and atomically persisted.
 *
 * @param {FoundryOperationsOptions} options
 */
export function createFoundryOperations(options) {

	if (!options || typeof options.getWorkspacePath !== "function") {
		throw new TypeError("createFoundryOperations requires getWorkspacePath");
	}
	if (!options.analysis) throw new TypeError("createFoundryOperations requires analysis");
	const notify = typeof options.notify === "function" ? options.notify : () => { };
	const analysis = options.analysis;
	const { workspace, storeFor } = createSessionStorage(options.getWorkspacePath);
	const factory = createFactoryBridge({ workspace, storeFor, notify, storageRoot: options.factoryStorageRoot });
	const { readForMutation, persist } = createPlanMutations({ workspace, storeFor, notify, factory });
	const { syncFactoryPlan, factoryAction, createFactoryPlan, createEvaluationPlan, recordHumanJudgment, syncFactory, captureAnalysis } = createRepositoryOperations({ workspace, storeFor, notify, factory, analysis });
	const { discoverReservedVerification, assertVerificationRun } = createVerificationOwnership(analysis);
	const { workflowStatus, getWorkflow, controlWorkflow } = createWorkflowOperations({ analysis, factory, storeFor, readForMutation, discoverReservedVerification, assertVerificationRun });
	const { getStatus, nextTasks } = createStatusOperations({ storeFor, workspace, factory, workflowStatus });
	const { preparePlan, createPlan, submitPlan, approve } = createPlanningOperations({ analysis, factory, persist, syncFactoryPlan });
	const { reserveTask, attachTask, completeTask, retry } = createTaskOperations({ storeFor, persist, factory, syncFactoryPlan });
	const { prepareVerification, finishVerification } = createVerificationOperations({ storeFor, persist, readForMutation, factory, analysis, discoverReservedVerification, assertVerificationRun, syncFactoryPlan });
	const { cancel, cancelVerificationRun, finalizeCancellation } = createCancellationOperations({ storeFor, persist, readForMutation, factory, analysis, discoverReservedVerification, syncFactoryPlan });
	const { quarantinePlan, activate, getPlan, listPlans, importPlan, exportPlan } = createPlanAccess({ storeFor, workspace, notify, factory });

	return Object.freeze({
		preparePlan: requestHandler("preparePlan", preparePlan),
		createPlan: requestHandler("createPlan", createPlan),
		/** Reads one validated plan. */
		getPlan: requestHandler("getPlan", getPlan),
		getStatus: requestHandler("getStatus", getStatus),
		getWorkflow: requestHandler("getWorkflow", getWorkflow),
		controlWorkflow: requestHandler("controlWorkflow", controlWorkflow),
		/** Lists bounded validated plan summaries. */
		listPlans: requestHandler("listPlans", listPlans),
		quarantinePlan: requestHandler("quarantinePlan", quarantinePlan),
		importPlan: requestHandler("importPlan", importPlan),
		exportPlan: requestHandler("exportPlan", exportPlan),
		submitPlan: requestHandler("submitPlan", submitPlan),
		approve: requestHandler("approve", approve),
		nextTasks: requestHandler("nextTasks", nextTasks),
		reserveTask: requestHandler("reserveTask", reserveTask),
		attachTask: requestHandler("attachTask", attachTask),
		completeTask: requestHandler("completeTask", completeTask),
		retry: requestHandler("retry", retry),
		prepareVerification: requestHandler("prepareVerification", prepareVerification),
		finishVerification: requestHandler("finishVerification", finishVerification),
		cancel: requestHandler("cancel", cancel),
		cancelVerificationRun: requestHandler("cancelVerificationRun", cancelVerificationRun),
		finalizeCancellation: requestHandler("finalizeCancellation", finalizeCancellation),
		activate: requestHandler("activate", activate),
		/** Removes the session-local activation marker. */
		deactivate: () => storeFor().deactivate(),
		/** Reads the activated plan, or `null` when inactive. */
		getActive: () => storeFor().getActive(),
		getActivation: () => storeFor().getActivation(),
		storeFor,
		factoryFor: factory.factoryFor,
		createFactoryPlan: requestHandler("createFactoryPlan", createFactoryPlan),
		createEvaluationPlan: requestHandler("createEvaluationPlan", createEvaluationPlan),
		recordHumanJudgment: requestHandler("recordHumanJudgment", recordHumanJudgment),
		syncFactory: requestHandler("syncFactory", syncFactory),
		captureAnalysis: requestHandler("captureAnalysis", captureAnalysis),
		factoryAction,
	});
}

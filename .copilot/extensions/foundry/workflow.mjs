import { createWorkflowControls } from "./native/controls.mjs";
import { createReservationDiscovery } from "./native/discovery.mjs";
import { isMissingRun, TERMINAL } from "./native/guards.mjs";
import { createPlanningWorkflow } from "./native/planning.mjs";
import { createRunReader } from "./native/reader.mjs";
import { createRepairWorkflow } from "./native/repair.mjs";
import { createVerificationWorkflow } from "./native/verification.mjs";

/**
 * Build the Foundry analysis boundary over the current session's native Workflow API.
 * @param {() => unknown} getWorkflowApi
 * @param {import("./types/repair.js").RepairHostPort} [repairHost]
 */
export function createWorkflowAnalysis(getWorkflowApi, repairHost) {

	if (typeof getWorkflowApi !== "function") throw new TypeError("createWorkflowAnalysis requires getWorkflowApi");
	const { api, loadRun, settleRun } = createRunReader(getWorkflowApi);
	const { inspectWorkflow, importAnalysis, getWorkflowProgress, listWorkflowRuns, controlWorkflow } = createWorkflowControls(api, loadRun);
	const { readReservationIdentity, discoverVerificationRun } = createReservationDiscovery(api);
	const { preparePlanning, importPlanning } = createPlanningWorkflow(loadRun, settleRun, repairHost);
	const { prepareVerification, importVerification, assessVerificationRun, verificationRunIsTerminal, cancelVerificationRun } = createVerificationWorkflow({ api, loadRun, settleRun, readReservationIdentity });

	return Object.freeze({
		controlWorkflow,
		inspectWorkflow,
		getWorkflowProgress,
		listWorkflowRuns,
		importPlanning,
		importAnalysis,
		importVerification,
		assessVerificationRun,
		cancelVerificationRun,
		discoverVerificationRun,
		isMissingWorkflowRun: isMissingRun,
		isTerminalWorkflowStatus: (/** @type {import("@github/copilot-sdk").WorkflowRunStatus} */ status) => TERMINAL.has(status),
		preparePlanning,
		...createRepairWorkflow(api, repairHost),
		prepareVerification,
		verificationRunIsTerminal,
	});
}

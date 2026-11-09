import { createAuthority } from "./bridge/authority.mjs";
import { createDispatchBridge } from "./bridge/dispatch.mjs";
import { createEvidenceBridge } from "./bridge/evidence.mjs";
import { createBoundPlans } from "./bridge/planning.mjs";
import { createSynchronization } from "./bridge/synchronization.mjs";
import { validateFactoryLearning } from "./plan/schemas/factory.mjs";

/**
 * @param {{workspace: () => string, storeFor: () => ReturnType<typeof import("./storage.mjs").createPlanStore>,
 * notify: (event: import("./types/plan.js").ChangeEvent) => void, storageRoot?: string, clock?: () => Date|string|number}} options
 */
export function createFactoryBridge({ workspace, storeFor, notify, storageRoot, clock }) {

	const { factoryFor, requireOwner, stateFor, context } = createAuthority({ workspace, storageRoot, clock });
	const { createBoundDraft, createPlan, createEvaluationPlan } = createBoundPlans({ workspace, storeFor, notify, factoryFor, context });
	const { validateReports, verificationContext, verificationGate, inspectPlan } = createEvidenceBridge(stateFor, workspace);
	const { prompt, requireRetry, activateEvaluation } = createDispatchBridge(stateFor, context);
	const { preflight, sync, captureRejectedReport } = createSynchronization(stateFor, activateEvaluation);

	return {
		factoryFor, requireOwner, requireRetry, context, createBoundDraft, createPlan, createEvaluationPlan, sync, preflight,
		prompt, inspectPlan, validateReports, verificationGate, verificationContext, activateEvaluation,
		captureRejectedReport,
		/** @param {unknown} value */
		validateLearning: (value) => { validateFactoryLearning(value); },
	};
}

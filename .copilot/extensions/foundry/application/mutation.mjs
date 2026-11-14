import { LIMITS } from "../plan/values.mjs";
import { revisionConflict } from "./errors.mjs";

/** @typedef {import("../types/plan.js").FoundryPlan} FoundryPlan */

/** @param {{
 * workspace: () => string,
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * notify: (event: import("../types/plan.js").ChangeEvent) => void,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "requireOwner">,
 * }} dependencies */
export function createPlanMutations({ workspace, storeFor, notify, factory }) {

	/**
	 * Reads a plan and enforces its expected revision before a mutation.
	 *
	 * @param {string} planId
	 * @param {number} expectedRevision
	 */
	const readForMutation = async (planId, expectedRevision) => {
		const plan = await storeFor().read(planId);
		factory.requireOwner(plan);
		if (plan.revision !== expectedRevision) {
			throw revisionConflict(planId, expectedRevision, plan.revision);
		}
		return plan;
	};

	/**
	 * Adds bounded correlated activity, atomically persists, and notifies canvases.
	 *
	 * @param {string} planId
	 * @param {number} expectedRevision
	 * @param {(plan: import("../types/plan.js").FoundryPlan, delegation: import("../types/plan.js").ApprovalDelegation | null) => import("../types/plan.js").FoundryPlan} change
	 * @param {string | null | ((plan: import("../types/plan.js").FoundryPlan) => string)} event
	 * @param {{delegationId?: string}} [settings]
	 */
	const persist = async (
		planId,
		expectedRevision,
		change,
		event,
		settings = {},
	) => {
		const workspacePath = workspace();
		const updated = await storeFor(workspacePath).mutate(
			planId,
			expectedRevision,
			(plan, delegation) => {
				factory.requireOwner(plan);
				const candidate = change(plan, delegation);
				const name = typeof event === "function" ? event(candidate) : event;
				if (name !== null) candidate.activity.push({
					event: name,
					at: new Date().toISOString(),
					revision: expectedRevision + 1,
				});
				return candidate;
			},
			settings,
		);
		notify({ workspacePath, planId, revision: updated.revision });
		return updated;
	};
	return { readForMutation, persist };
}

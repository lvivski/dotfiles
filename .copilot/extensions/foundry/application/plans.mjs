import { LIMITS } from "../plan/values.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** @param {{
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * workspace: () => string,
 * notify: (event: import("../types/plan.js").ChangeEvent) => void,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "requireOwner">,
 * }} dependencies */
export function createPlanAccess({ storeFor, workspace, notify, factory }) {

	/**
	 * Quarantines one unreadable plan artifact with an attributed reason.
	 *
	 * @param {{planId: string, reason: string, requestedBy: string}} input
	 */
	const quarantinePlan = ({ planId, reason, requestedBy }) => {
		if (typeof reason !== "string"
			|| !reason.trim()
			|| typeof requestedBy !== "string"
			|| !requestedBy.trim()) {
			throw new FoundryOperationError(
				"invalid_quarantine_request",
				"Quarantining a plan requires a reason and requestedBy",
			);
		}
		return storeFor().quarantineInvalidPlan(planId, {
			reason,
			requestedBy,
		});
	};

	/**
	 * Activates coordinator context and guardrails for one plan revision.
	 *
	 * @param {{planId: string, expectedRevision: number}} input
	 */
	const activate = async ({ planId, expectedRevision }) => {
		const workspacePath = workspace();
		factory.requireOwner(await storeFor().read(planId));
		const marker = await storeFor(workspacePath).activate(planId, expectedRevision);
		notify({ workspacePath, planId, revision: expectedRevision });
		return marker;
	};

	/** @param {Request<"getPlan">} input */
	const getPlan = ({ planId }) => storeFor().read(planId);

	/** @param {Request<"listPlans">} input */
	const listPlans = ({ limit }) => storeFor().list({ limit });

	/** @param {Request<"importPlan">} input */
	const importPlan = async ({ source, expectedRevision }) => {
		const plan = await storeFor().importPlan(source, { expectedRevision });
		notify({ workspacePath: workspace(), planId: plan.id, revision: plan.revision });
		return plan;
	};

	/** @param {Request<"exportPlan">} input */
	const exportPlan = ({ planId }) => storeFor().exportPlan(planId);
	return { quarantinePlan, activate, getPlan, listPlans, importPlan, exportPlan };
}

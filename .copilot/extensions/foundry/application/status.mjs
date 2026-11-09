import { errorCode, errorMessage } from "../data.mjs";
import { TASK_STATUS } from "../plan/values.mjs";
import { projectPlan } from "../projection.mjs";
import { FoundryOperationError } from "./errors.mjs";

/** @template {keyof typeof import("../requests.mjs").requestShapes} K @typedef {import("../requests.mjs").Request<K>} Request */

/** @param {{
 * storeFor: ReturnType<typeof import("./storage.mjs").createSessionStorage>["storeFor"],
 * workspace: () => string,
 * factory: Pick<ReturnType<typeof import("../bridge.mjs").createFactoryBridge>, "inspectPlan">,
 * workflowStatus: ReturnType<typeof import("./workflows.mjs").createWorkflowOperations>["workflowStatus"],
 * }} dependencies */
export function createStatusOperations({ storeFor, workspace, factory, workflowStatus }) {

	/**
	 * Reads the authoritative plan and derives recovery guidance.
	 *
	 * @param {Request<"getStatus">} input
	 */
	const getStatus = async ({ planId, sessionInventory, includeWorkflows = false }) => {
		const plan = await storeFor().read(planId);
		let factoryView;
		try {
			factoryView = { state: /** @type {const} */ ("available"), ...factory.inspectPlan(plan) };
		} catch (error) {
			factoryView = { state: /** @type {const} */ ("unavailable"), code: errorCode(error) ?? "factory_unavailable", error: errorMessage(error) };
		}
		const projection = projectPlan(plan, { sessionInventory });
		const foreign = !plan.factory || plan.factory.owner !== workspace();
		const currentContract = factoryView.state === "available" ? factoryView.contracts.filter((entry) => entry.unitId === plan.factory?.unitId).at(-1) : undefined;
		const contextChanged = factoryView.state === "available" && (currentContract?.digest ?? null) !== plan.factory?.contractDigest;
		const pending = factoryView.state === "available" && factoryView.synchronization.pending.length > 0;
		const humanPending = factoryView.state === "available" && factoryView.pendingHuman.length > 0 && plan.tasks.every((task) => task.status === "done");
		if (foreign || factoryView.state !== "available" || contextChanged || pending) {
			projection.factoryHold = {
				code: foreign ? "factory_execution_foreign" : factoryView.state !== "available" ? factoryView.code
					: pending ? "factory_sync_pending" : "factory_contract_superseded",
				reason: foreign ? "Repository knowledge is inspectable, but this session does not own execution."
					: factoryView.state !== "available" ? factoryView.error
						: pending ? "Recover persisted factory receipts before dispatching more work."
							: "Accepted authority changed; prepare a new bounded draft instead of changing an approved task contract.",
				blocksAllExecution: foreign,
			};
			projection.scheduling.heldTaskIds = [...new Set([...projection.scheduling.heldTaskIds, ...projection.scheduling.dispatchableTaskIds])];
			projection.scheduling.dispatchableTaskIds = [];
			projection.scheduling.launches = [];
			projection.actions = foreign ? [] : projection.actions.filter((entry) =>
				!["reserve-task", "retry-task", "approve-plan", "approve-completion", "approve-correction"].includes(entry.kind));
			projection.actions.unshift({
				kind: pending && !foreign ? "sync-factory" : "inspect-factory",
				reason: projection.factoryHold.reason,
			});
			projection.nextAction = projection.actions[0];
		}
		if (!foreign && !projection.factoryHold && humanPending && factoryView.state === "available") {
			projection.actions = projection.actions.filter((entry) => !["prepare-verification", "approve-completion"].includes(entry.kind));
			projection.actions.unshift({ kind: "collect-human-judgment", evaluations: factoryView.pendingHuman.map((entry) => entry.evaluation) });
			projection.nextAction = projection.actions[0];
		}
		return {
			plan,
			projection,
			...(includeWorkflows ? { workflows: await workflowStatus(plan) } : {}),
			factory: factoryView,
		};
	};

	/**
	 * Lists dependency-ready tasks, delivery guidance, and scope holds.
	 *
	 * @param {{planId: string}} input
	 */
	const nextTasks = async ({ planId }) => {
		const { plan, projection } = await getStatus({ planId });
		const { readyTaskIds, launches, ...selection } = projection.scheduling;
		return {
			planId,
			revision: plan.revision,
			status: plan.status,
			tasks: launches.map(({ taskId, launch }) => {
				const task = plan.tasks.find((task) => task.id === taskId);
				if (!task) throw new FoundryOperationError("task_not_found", `Projected task ${taskId} does not exist`);
				return { ...task, status: TASK_STATUS.READY, launch };
			}),
			...selection,
		};
	};
	return { getStatus, nextTasks };
}

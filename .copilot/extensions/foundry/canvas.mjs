/**
 * Copilot canvas declaration for the Foundry plan board.
 *
 * @module foundry/canvas
 */
import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";

import { errorCode, errorMessage } from "./data.mjs";
import { assertPlanId } from "./plan/fields.mjs";
import { PLAN_ID_PATTERN } from "./plan/values.mjs";
import { startServer } from "./server.mjs";

/**
 * @typedef {object} FoundryCanvasOptions
 * @property {ReturnType<typeof import("./operations.mjs").createFoundryOperations>} operations
 * @property {() => string | undefined} getWorkspacePath
 * @property {() => import("./server.mjs").FoundryUi | undefined} [getUi]
 * @property {typeof import("./events.mjs").subscribeToPlan} subscribe
 */

/**
 * Converts arbitrary provider failures into structured canvas errors.
 *
 * @param {unknown} error
 * @returns {CanvasError}
 */
function canvasFailure(error) {
	if (error instanceof CanvasError) {
		return error;
	}
	return new CanvasError(
		errorCode(error) ?? "foundry_canvas_error",
		errorMessage(error),
	);
}

/**
 * Creates the Foundry board canvas declaration and per-instance server registry.
 *
 * @param {FoundryCanvasOptions} options
 * @returns {import("@github/copilot-sdk/extension").Canvas}
 */
export function createFoundryCanvas(options) {
	/** @type {Map<string, Promise<Awaited<ReturnType<typeof startServer>>>>} */
	const instances = new Map();

	/**
	 * Resolves an open instance for an agent-invoked canvas action.
	 *
	 * @param {string} instanceId
	 * @returns {Promise<Awaited<ReturnType<typeof startServer>>>}
	 * @throws {CanvasError} When the instance is not open.
	 */
	const entryForAction = async (instanceId) => {
		const entryPromise = instances.get(instanceId);
		if (!entryPromise) {
			throw new CanvasError("foundry_canvas_not_open", "This Foundry canvas instance is not open");
		}
		return entryPromise;
	};

	return createCanvas({
		id: "foundry-board",
		displayName: "Foundry",
		description: "Inspect governed repository capabilities, candidate assurance and renewal alongside a Foundry engineering plan.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			oneOf: [{ required: ["planId"], not: { required: ["repositoryPath"] } }, { required: ["repositoryPath"], not: { required: ["planId"] } }],
			properties: {
				planId: {
					type: "string",
					pattern: PLAN_ID_PATTERN,
					maxLength: 64,
				},
				repositoryPath: { type: "string", minLength: 1 },
				unitId: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,95}$" },
				readOnly: { type: "boolean" },
			},
		},
		actions: [
			{
				name: "refresh",
				description: "Reload the current Foundry plan and notify the open board.",
				handler: async (context) => {
					try {
						const entry = await entryForAction(context.instanceId);
						const snapshot = await entry.snapshot();
						entry.broadcast({ revision: snapshot.plan?.revision });
						return snapshot.plan ? {
							planId: snapshot.plan.id,
							revision: snapshot.plan.revision,
							status: snapshot.plan.status,
							nextAction: snapshot.projection.nextAction,
						} : { repositoryId: snapshot.factory.repository.id, revision: snapshot.factory.revision, mode: "factory" };
					} catch (error) {
						throw canvasFailure(error);
					}
				},
			},
			{
				name: "get_snapshot",
				description: "Return the complete validated plan currently displayed by this Foundry board.",
				handler: async (context) => {
					try {
						return await (await entryForAction(context.instanceId)).snapshot();
					} catch (error) {
						throw canvasFailure(error);
					}
				},
			},
		],
		open: async (context) => {
			let createdEntry = false;
			try {
				const workspacePath = options.getWorkspacePath();
				if (!workspacePath) {
					throw new CanvasError(
						"foundry_workspace_unavailable",
						"Foundry requires a Copilot session workspace",
					);
				}
				const input = context.input;
				const value = input && typeof input === "object" && !Array.isArray(input) ? input : {};
				const planId = value.planId === undefined ? undefined : assertPlanId(value.planId, "planId");
				const repositoryPath = typeof value.repositoryPath === "string" ? value.repositoryPath : undefined;
				const unitId = typeof value.unitId === "string" ? value.unitId : undefined;
				if (Boolean(planId) === Boolean(repositoryPath)) throw new CanvasError("foundry_canvas_input", "Choose a plan or repository-only inspection");
				const plan = planId ? await options.operations.getPlan({ planId }) : null;
				if (repositoryPath) await options.operations.factoryAction({ repositoryPath, action: "inspect", input: { ...(unitId ? { unitId } : {}) } });
				let entryPromise = instances.get(context.instanceId);
				if (entryPromise) {
					const existing = await entryPromise;
					if (existing.planId !== planId || existing.repositoryPath !== repositoryPath || existing.unitId !== unitId
						|| existing.readOnly !== (value.readOnly === true || !planId)) {
						throw new CanvasError(
							"foundry_instance_conflict",
							"This canvas instance is already bound to another scope or access mode",
						);
					}
				} else {
					entryPromise = startServer({
						instanceId: context.instanceId,
						planId,
						repositoryPath,
						unitId,
						readOnly: value.readOnly === true,
						workspacePath,
						operations: options.operations,
						subscribe: options.subscribe,
						getUi: options.getUi,
					});
					instances.set(context.instanceId, entryPromise);
					createdEntry = true;
				}
				const entry = await entryPromise;
				return {
					title: plan ? `Foundry — ${plan.title}` : "Foundry — repository factory",
					status: "Ready",
					url: entry.url,
				};
			} catch (error) {
				if (createdEntry) {
					instances.delete(context.instanceId);
				}
				throw canvasFailure(error);
			}
		},
		onClose: async (context) => {
			const entryPromise = instances.get(context.instanceId);
			if (!entryPromise) {
				return;
			}
			instances.delete(context.instanceId);
			const entry = await entryPromise;
			await entry.close();
		},
	});
}

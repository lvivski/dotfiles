/**
 * Copilot canvas declaration for the Foundry plan board.
 *
 * @module foundry/canvas
 */
import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";

import { startServer } from "./server.mjs";

/**
 * @typedef {object} FoundryCanvasOptions
 * @property {ReturnType<typeof import("./operations.mjs").createFoundryOperations>} operations
 * @property {() => string | undefined} getWorkspacePath
 * @property {(workspacePath: string, planId: string, listener: (event: any) => void) => () => void} subscribe
 */

/** JSON Schema pattern shared with the domain plan-ID validator. */
const PLAN_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

/**
 * Converts arbitrary provider failures into structured canvas errors.
 *
 * @param {any} error
 * @returns {CanvasError}
 */
function canvasFailure(error) {
    if (error instanceof CanvasError) {
        return error;
    }
    return new CanvasError(
        error?.code ?? "foundry_canvas_error",
        error?.message ?? String(error),
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
        description: "Inspect and control a dependency-aware Foundry engineering plan.",
        inputSchema: {
            type: "object",
            additionalProperties: false,
            required: ["planId"],
            properties: {
                planId: {
                    type: "string",
                    pattern: PLAN_ID_PATTERN,
                    maxLength: 64,
                },
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
                        entry.broadcast({ revision: snapshot.plan.revision });
                        return {
                            planId: snapshot.plan.id,
                            revision: snapshot.plan.revision,
                            status: snapshot.plan.status,
                            nextAction: snapshot.projection.nextAction,
                        };
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
            const planId = context.input?.planId;
            let createdEntry = false;
            try {
                const workspacePath = options.getWorkspacePath();
                if (!workspacePath) {
                    throw new CanvasError(
                        "foundry_workspace_unavailable",
                        "Foundry requires a Copilot session workspace",
                    );
                }
                const plan = await options.operations.getPlan({ planId });
                let entryPromise = instances.get(context.instanceId);
                if (entryPromise) {
                    const existing = await entryPromise;
                    if (existing.planId !== planId) {
                        throw new CanvasError(
                            "foundry_instance_conflict",
                            "This canvas instance is already bound to another plan",
                        );
                    }
                } else {
                    entryPromise = startServer({
                        instanceId: context.instanceId,
                        planId,
                        workspacePath,
                        operations: options.operations,
                        subscribe: options.subscribe,
                    });
                    instances.set(context.instanceId, entryPromise);
                    createdEntry = true;
                }
                const entry = await entryPromise;
                return {
                    title: `Foundry — ${plan.title}`,
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

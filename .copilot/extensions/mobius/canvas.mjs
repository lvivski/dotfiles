/**
 * Copilot canvas declaration for the Mobius plan board.
 *
 * @module mobius/canvas
 */
import { CanvasError, createCanvas } from "@github/copilot-sdk/extension";

import { startServer } from "./server.mjs";

/**
 * @typedef {object} MobiusCanvasOptions
 * @property {ReturnType<typeof import("./operations.mjs").createMobiusOperations>} operations
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
        error?.code ?? "mobius_canvas_error",
        error?.message ?? String(error),
    );
}

/**
 * Creates the Mobius board canvas declaration and per-instance server registry.
 *
 * @param {MobiusCanvasOptions} options
 * @returns {import("@github/copilot-sdk/extension").Canvas}
 */
export function createMobiusCanvas(options) {
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
            throw new CanvasError("mobius_canvas_not_open", "This Mobius canvas instance is not open");
        }
        return entryPromise;
    };

    return createCanvas({
        id: "mobius-board",
        displayName: "Mobius",
        description: "Inspect and control a dependency-aware Mobius engineering plan.",
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
                description: "Reload the current Mobius plan and notify the open board.",
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
                description: "Return the complete validated plan currently displayed by this Mobius board.",
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
                        "mobius_workspace_unavailable",
                        "Mobius requires a Copilot session workspace",
                    );
                }
                const plan = await options.operations.getPlan({ planId });
                let entryPromise = instances.get(context.instanceId);
                if (entryPromise) {
                    const existing = await entryPromise;
                    if (existing.planId !== planId) {
                        throw new CanvasError(
                            "mobius_instance_conflict",
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
                    title: `Mobius — ${plan.title}`,
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

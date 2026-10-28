/**
 * Foundry extension entry point.
 *
 * Registers workflows, tools, hooks, and canvases against the current foreground
 * Copilot session, then performs conservative stale-lock recovery.
 *
 * @module foundry/extension
 */
import { defineWorkflow, joinSession } from "@github/copilot-sdk/extension";

import { createFoundryCanvas } from "./canvas.mjs";
import { publishPlanChange, publishWorkflowChange, subscribeToPlan } from "./events.mjs";
import { createWorkflowAnalysis, FOUNDRY_WORKFLOWS } from "./workflow.mjs";
import { buildFoundryHooks } from "./hooks.mjs";
import { createFoundryOperations } from "./operations.mjs";
import { buildFoundryTools } from "./tools.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession | null} */
let session = null;

const workflows = Object.values(FOUNDRY_WORKFLOWS).map(
    /** @param {import("@github/copilot-sdk").WorkflowDefinition} definition */
    (definition) => defineWorkflow(definition),
);

/** Shared service boundary used by tools, hooks, and canvases. */
const operations = createFoundryOperations({
    getWorkspacePath: () => session?.workspacePath,
    analysis: createWorkflowAnalysis(() => session?.workflow),
    notify: publishPlanChange,
});

session = await joinSession({
    workflows,
    tools: buildFoundryTools(operations),
    hooks: buildFoundryHooks({ operations }),
    canvases: [
        createFoundryCanvas({
            operations,
            getWorkspacePath: () => session?.workspacePath,
            subscribe: subscribeToPlan,
        }),
    ],
});

session.on("workflow.run_updated", (event) => publishWorkflowChange(event.data));

try {
    const recovery = await operations.recoverStorage();
    if (recovery.recovered.length > 0) {
        await session.log(
            `Foundry recovered ${recovery.recovered.length} stale write lock(s).`,
            { level: "warning" },
        );
    }
} catch (error) {
    await session.log(
        `Foundry storage recovery could not complete: ${error?.message ?? String(error)}`,
        { level: "warning" },
    );
}

/**
 * Foundry extension entry point.
 *
 * Registers the tool, hook, and canvas surfaces against the current foreground
 * Copilot session, then performs conservative stale-lock recovery.
 *
 * @module foundry/extension
 */
import { defineFactory, joinSession } from "@github/copilot-sdk/extension";

import { createFoundryCanvas } from "./canvas.mjs";
import { publishPlanChange, subscribeToPlan } from "./events.mjs";
import { createFactoryAnalysis, FOUNDRY_FACTORIES } from "./factory.mjs";
import { buildFoundryHooks } from "./hooks.mjs";
import { createFoundryOperations } from "./operations.mjs";
import { buildFoundryTools } from "./tools.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession | null} */
let session = null;

const factories = Object.values(FOUNDRY_FACTORIES).map((definition) => defineFactory(definition));

/** Shared service boundary used by tools, hooks, and canvases. */
const operations = createFoundryOperations({
    getWorkspacePath: () => session?.workspacePath,
    analysis: createFactoryAnalysis(() => session?.factory),
    notify: publishPlanChange,
});

session = await joinSession({
    factories,
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

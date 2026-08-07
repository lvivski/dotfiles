/**
 * Mobius extension entry point.
 *
 * Registers the tool, hook, and canvas surfaces against the current foreground
 * Copilot session, then performs conservative stale-lock recovery.
 *
 * @module mobius/extension
 */
import { joinSession } from "@github/copilot-sdk/extension";

import { createMobiusCanvas } from "./canvas.mjs";
import { publishPlanChange, subscribeToPlan } from "./events.mjs";
import { buildMobiusHooks } from "./hooks.mjs";
import { createMobiusOperations } from "./operations.mjs";
import { buildMobiusTools } from "./tools.mjs";

/** @type {import("@github/copilot-sdk").CopilotSession | null} */
let session = null;

/** Shared service boundary used by tools, hooks, and canvases. */
const operations = createMobiusOperations({
    getWorkspacePath: () => session?.workspacePath,
    notify: publishPlanChange,
});

session = await joinSession({
    tools: buildMobiusTools(operations),
    hooks: buildMobiusHooks({ operations }),
    canvases: [
        createMobiusCanvas({
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
            `Mobius recovered ${recovery.recovered.length} stale write lock(s).`,
            { level: "warning" },
        );
    }
} catch (error) {
    await session.log(
        `Mobius storage recovery could not complete: ${error?.message ?? String(error)}`,
        { level: "warning" },
    );
}

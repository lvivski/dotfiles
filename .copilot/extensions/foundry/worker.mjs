/**
 * Child-process fixture used by storage concurrency tests.
 *
 * It intentionally writes its result to stdout because it is executed as a
 * standalone worker, not loaded as the JSON-RPC extension entry point.
 *
 * @module foundry/worker
 */
import { createPlanStore } from "./storage.mjs";

const [workspacePath = "", planId = "", title = ""] = process.argv.slice(2);

/** Store instance bound to the test worker's session workspace. */
const store = createPlanStore({
    workspacePath,
    clock: () => "2026-08-05T16:01:00.000Z",
});

try {
    const candidate = await store.read(planId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    candidate.title = title;
    const plan = await store.update(planId, 1, candidate);
    process.stdout.write(JSON.stringify({
        code: "updated",
        revision: plan.revision,
        title: plan.title,
    }));
} catch (error) {
    process.stdout.write(JSON.stringify({
        code: error?.code ?? "unknown_error",
        message: error?.message ?? String(error),
        details: error?.details ?? null,
    }));
    process.exitCode = error?.code === "revision_conflict" ? 2 : 1;
}

/** Subprocess fixture for SQLite contention, isolation, and crash recovery. */
import { DatabaseSync } from "node:sqlite";
import { errorCode, errorMessage, isRecord, property } from "../../data.mjs";
import { createPlanStore } from "../../storage.mjs";

const [workspacePath = "", action = "update", planId = "sample-plan"] = process.argv.slice(2);

const store = createPlanStore({
	workspacePath,
	clock: () => "2026-08-05T16:01:00.000Z",
});

try {
	await store.list();
	/** @type {Promise<unknown>} */
	const input = new Promise((resolve) => process.once("message", resolve));
	process.send?.({ event: "ready" });
	const payload = await input;
	if (!isRecord(payload) || (action !== "create" && typeof payload.title !== "string")) {
		throw new TypeError("Worker IPC requires a plan or title payload");
	}

	if (action.startsWith("crash-") || action === "hold-update") {
		const execute = DatabaseSync.prototype.exec;
		DatabaseSync.prototype.exec = function(sql) {
			if (sql === "COMMIT") {
				if (action.endsWith("-after")) execute.call(this, sql);
				if (action === "hold-update") {
					process.send?.({ event: "staged" });
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
				}
				process.kill(process.pid, "SIGKILL");
			}
			return execute.call(this, sql);
		};
	}

	const plan = action === "create"
		? await store.create(payload.plan, 0)
		: await store.mutate(planId, 1, (current) => ({ ...current, title: payload.title }));
	process.stdout.write(JSON.stringify({
		code: action === "create" ? "created" : "updated",
		revision: plan.revision,
		title: plan.title,
	}));
} catch (error) {
	process.stdout.write(JSON.stringify({
		code: errorCode(error) ?? "unknown_error",
		message: errorMessage(error),
		details: property(error, "details") ?? null,
	}));
	process.exitCode = ["revision_conflict", "plan_exists"].includes(errorCode(error) ?? "") ? 2 : 1;
} finally {
	process.disconnect?.();
}

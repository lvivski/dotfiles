import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdtemp,
	rm
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../data.mjs";
import { createDraftPlan } from "../../plan/lifecycle.mjs";
import { createPlanStore } from "../../storage.mjs";

/** @typedef {ReturnType<typeof createPlanStore>} Store */
/** @typedef {{workspace: string, store: Store}} Workspace */

export const CREATED_AT = "2026-08-05T16:00:00.000Z";

export const UPDATED_AT = "2026-08-05T16:01:00.000Z";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));

/** @param {string} repositoryPath @param {string} [id] */
export function makePlan(repositoryPath, id = "sample-plan") {
	return createDraftPlan({
		id,
		title: `Plan ${id}`,
		objective: "Prove durable Foundry storage",
		constraints: [],
		repository: { workingDirectory: repositoryPath, baseBranch: "main" },
		tasks: [{
			id: "T-001",
			title: "Implement storage",
			kind: "implement",
			description: "Persist the plan safely",
			dependsOn: [],
			acceptanceCriteria: ["The plan survives a fresh read"],
			expectedFiles: ["src/storage.mjs"],
			deliveryRequirement: "commit",
		}, {
			id: "T-002",
			title: "Verify storage",
			kind: "verify",
			description: "Verify the persisted plan",
			dependsOn: ["T-001"],
			acceptanceCriteria: [],
			expectedFiles: [],
			deliveryRequirement: "commit",
		}],
	}, { now: CREATED_AT });
}

/** @template T @param {(context: Workspace) => T | Promise<T>} operation */
export async function withWorkspace(operation) {
	const workspace = await mkdtemp(path.join(os.tmpdir(), "foundry-storage-"));
	const store = createPlanStore({ workspacePath: workspace, clock: () => UPDATED_AT });
	try {
		return await operation({ workspace, store });
	} finally {
		await rm(workspace, { recursive: true, force: true });
	}
}

/** @template T @param {Store} store @param {(db: DatabaseSync) => T} operation */
export function withDatabase(store, operation) {
	const db = new DatabaseSync(store.databasePath);
	try {
		return operation(db);
	} finally {
		db.close();
	}
}

/** @param {Promise<unknown>} promise @param {string} code @param {(error: Record<string, unknown>) => void} [check] */
export async function rejectsCode(promise, code, check = (_error) => { }) {
	await assert.rejects(promise, (error) => {
		assert.ok(isRecord(error) && typeof error.code === "string");
		assert.equal(error.code, code);
		check(error);
		return true;
	});
}

/** @param {import("node:test").TestContext} context @param {string} workspace @param {string} action */
export function startWorker(context, workspace, action) {
	const child = spawn(process.execPath, [WORKER_PATH, workspace, action, "sample-plan"], {
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
	context.after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	let stdout = "";
	let stderr = "";
	assert.ok(child.stdout);
	assert.ok(child.stderr);
	child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
	child.on("error", (error) => { stderr += error.message; });
	/** @type {Promise<{code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string}>} */
	const done = new Promise((resolve) => child.once("close", (code, signal) => {
		resolve({ code, signal, stdout, stderr });
	}));
	/** @param {string} name @returns {Promise<Record<string, unknown>>} */
	const event = (name) => new Promise((resolve, reject) => {
		/** @param {unknown} value */
		const message = (value) => {
			if (!isRecord(value) || value.event !== name) return;
			child.off("message", message);
			child.off("exit", exit);
			resolve(value);
		};
		const exit = () => {
			child.off("message", message);
			reject(new Error(`Worker exited before ${name}: ${stdout}\n${stderr}`));
		};
		child.on("message", message);
		child.once("exit", exit);
	});
	return { child, event, done };
}

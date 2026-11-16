import assert from "node:assert/strict";
import { createResearchTimeReview } from "../../research/review.mjs";
import { workflowDetail } from "../workflows/detail.mjs";

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export function gate() {
	let release = () => { };
	const promise = new Promise((resolve) => { release = () => resolve(undefined); });
	return { promise, release };
}

/** @param {Partial<import("@github/copilot-sdk").WorkflowRunDetail>} [overrides] */
export function detail(overrides = {}) {
	/** @type {import("@github/copilot-sdk").WorkflowRunDetail} */
	const run = workflowDetail({
		runId: "research-run", workflowName: "deep-research", revision: 2,
		status: "paused", canResume: true, createdAt: 1, completedAt: null, observedAt: Date.now(),
		currentPhase: { id: "research", ordinal: 1 }, liveAgentCount: 0, totalSpawnedAgentCount: 12,
		approved: { timeoutSeconds: 3600, maxAiCredits: 10, maxConcurrentSubagents: 2, maxTotalSubagents: 40 },
		declaredLimits: { timeoutSeconds: 3600, maxAiCredits: 10, maxConcurrentSubagents: 2, maxTotalSubagents: 40 },
		consumed: { activeMs: 3_540_000, nanoAiu: 1_000_000_000, subagents: 12 },
		terminal: { pauseInfo: { type: "checkpoint", key: "deep-research:time-review:v1:3600" } },
		phases: [], agents: [],
		progress: { records: [], oldestSeq: null, newestSeq: null, hasMoreOlder: false, hasMoreNewer: false, revision: 2 },
	});
	return { ...run, ...overrides };
}

/** @param {import("@github/copilot-sdk").WorkflowRunDetail} run */
export function context(run) {
	const controller = new AbortController();
	/** @type {string[]} */
	const pauses = [];
	/** @type {string[]} */
	const logs = [];
	/** @type {Parameters<typeof import("../../research/budget.mjs").researchWithTimeReview>[0]} */
	const workflow = {
		runId: run.runId,
		signal: controller.signal,
		session: { workflow: { getRunDetail: async () => structuredClone(run) } },
		log: (message) => logs.push(message),
		pause: async (key) => { pauses.push(key); throw new DOMException("Checkpoint", "AbortError"); },
	};
	return { workflow, controller, pauses, logs };
}

/**
 * @param {import("@github/copilot-sdk").WorkflowRunDetail[]} [runs]
 * @param {{choose?: import("@github/copilot-sdk").SessionUiApi["select"], supported?: boolean}} [options]
 */
export function service(runs = [detail()], { choose = async (_message, _choices) => "Extend by one hour", supported = true } = {}) {
	const records = new Map(runs.map((run) => [run.runId, run]));
	/** @type {Array<{action: string, runId: string, options?: Parameters<import("@github/copilot-sdk").SessionWorkflowApi["resume"]>[1]}>} */
	const controls = [];
	/** @type {Array<{message: string, choices: string[]}>} */
	const dialogs = [];
	/** @type {string[]} */
	const logs = [];
	/** @type {string[]} */
	const reads = [];
	/** @type {Array<{runId: string, signal?: AbortSignal, settle: (result?: import("@github/copilot-sdk").WorkflowRunResult) => void}>} */
	const waits = [];
	const finish = gate();
	/** @type {Parameters<typeof createResearchTimeReview>[0]["workflow"]} */
	const api = {
		listRuns: async (options) => {
			assert.deepEqual(options, { limit: 20 });
			return { runs: structuredClone([...records.values()]), omittedOlder: 0 };
		},
		getRunDetail: async (runId) => {
			reads.push(runId);
			const run = records.get(runId);
			assert.ok(run);
			return structuredClone(run);
		},
		waitForRun: (runId, { signal } = {}) => new Promise((resolve, reject) => {
			const run = records.get(runId);
			assert.ok(run);
			const abort = () => reject(signal?.reason);
			/** @param {import("@github/copilot-sdk").WorkflowRunResult} [result] */
			const settle = (result = { runId, status: run.status }) => {
				signal?.removeEventListener("abort", abort);
				resolve(result);
			};
			waits.push({ runId, signal, settle });
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			else if (run.status !== "running" && run.status !== "pending") settle();
		}),
		resume: async (runId, options) => {
			controls.push({ action: "resume", runId, options });
			const run = records.get(runId);
			assert.ok(run);
			const approved = { ...run.approved };
			for (const key of /** @type {const} */ (["timeoutSeconds", "maxAiCredits", "maxConcurrentSubagents", "maxTotalSubagents"])) {
				const value = options?.limits?.[key];
				if (value === null) delete approved[key];
				else if (value !== undefined) approved[key] = value;
			}
			run.approved = approved;
			run.status = "running";
			run.revision++;
			await finish.promise;
			return { runId, status: "completed" };
		},
		cancel: async (runId) => {
			controls.push({ action: "cancel", runId });
			const run = records.get(runId);
			assert.ok(run);
			run.status = "cancelled";
			run.canResume = false;
			run.revision++;
			return { runId, status: "cancelled" };
		},
	};
	const review = createResearchTimeReview({
		workflow: api,
		getUi: () => supported ? {
			select: async (message, choices) => { dialogs.push({ message, choices }); return choose(message, choices); },
		} : undefined,
		log: (message) => { logs.push(message); },
	});
	return { review, records, api, controls, dialogs, logs, reads, waits, close: () => { review.close(); finish.release(); } };
}

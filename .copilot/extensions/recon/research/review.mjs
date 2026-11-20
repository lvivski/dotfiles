import { errorMessage } from "../data.mjs";
import { MAX_TIMEOUT_SECONDS, PREFIX } from "./budget.mjs";

const EXTRA_HOUR = 3600;

const EXTEND = "Extend by one hour";

const KEEP_PAUSED = "Keep paused";

const STOP = "Stop";

/** @param {import("@github/copilot-sdk").WorkflowRunSummary} run @param {boolean} observed */
function reviewLimit(run, observed) {
	if (run.workflowName !== "deep-research" || !run.canResume) return null;
	const seconds = run.approved?.timeoutSeconds;
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
	const pause = run.terminal?.pauseInfo;
	if (run.status === "paused" && !run.terminal?.failure
		&& pause?.type === "checkpoint" && pause.key === `${PREFIX}${seconds}`) return seconds;
	const failure = run.terminal?.failure;
	if (observed && run.status === "error" && failure?.type === "workflow_limit_reached"
		&& failure.kind === "timeoutSeconds" && failure.value === seconds) return seconds;
	return null;
}

/**
 * Native waits recover missed checkpoint events for active research runs.
 * Only dialogs are serialized; a resumed run never holds the decision queue.
 *
 * @param {{
 *   workflow: Pick<import("@github/copilot-sdk").SessionWorkflowApi, "getRunDetail" | "waitForRun" | "resume" | "cancel">
 *     & {listRuns: (options: import("@github/copilot-sdk").WorkflowListRunsOptions) => Promise<import("@github/copilot-sdk").WorkflowRunsPage>},
 *   getUi: () => Pick<import("@github/copilot-sdk").SessionUiApi, "select"> | undefined,
 *   log: (message: string) => void | Promise<void>
 * }} options
 */
export function createResearchTimeReview({ workflow, getUi, log }) {
	/** @type {Map<string, number>} */
	const reviewed = new Map();
	/** @type {Set<string>} */
	const observed = new Set();
	/** @type {Set<string>} */
	const invalidated = new Set();
	/** @type {Map<string, {controller: AbortController, revision: number}>} */
	const waits = new Map();
	/** @type {Map<string, number>} */
	const failedWaits = new Map();
	let closed = false;
	let refreshing = false;
	let pending = false;
	let discover = true;

	/** @param {string} message */
	async function report(message) {
		if (closed) return;
		try {
			await log(message);
		} catch (error) {
			console.error(`${message} (Recon could not notify the session: ${errorMessage(error)})`);
		}
	}

	/** @param {import("@github/copilot-sdk").WorkflowRunSummary} run */
	function observe(run) {
		const active = run.status === "running" || run.status === "pending";
		const waiting = waits.get(run.runId);
		if (!active) {
			waiting?.controller.abort();
			waits.delete(run.runId);
			failedWaits.delete(run.runId);
			return;
		}
		observed.add(run.runId);
		if (waiting) {
			waiting.revision = run.revision;
			return;
		}
		if (failedWaits.get(run.runId) === run.revision) return;
		const entry = { controller: new AbortController(), revision: run.revision };
		waits.set(run.runId, entry);
		void (async () => {
			try {
				const settled = await workflow.waitForRun(run.runId, { signal: entry.controller.signal });
				if (closed || entry.controller.signal.aborted) return;
				if (settled.runId !== run.runId || !["completed", "error", "halted", "paused", "cancelled"].includes(settled.status)) {
					throw new Error("Native wait returned a different or unsettled run");
				}
			} catch (error) {
				if (!closed && !entry.controller.signal.aborted) {
					failedWaits.set(run.runId, entry.revision);
					await report(`Research time-review wait for ${run.runId} failed: ${errorMessage(error)}. Native time limits remain enforced; inspect the original run.`);
				}
				return;
			} finally {
				if (waits.get(run.runId) === entry) waits.delete(run.runId);
			}
			void refresh(run.runId);
		})();
	}

	/** @param {import("@github/copilot-sdk").WorkflowRunSummary} summary */
	async function decide(summary) {
		const run = await workflow.getRunDetail(summary.runId);
		if (closed) return;
		if (run.runId !== summary.runId) throw new Error(`Native lookup returned a different run for ${summary.runId}`);
		const seconds = reviewLimit(run, observed.has(summary.runId));
		if (seconds === null || reviewed.get(run.runId) === seconds) return;
		reviewed.set(run.runId, seconds);
		const ui = getUi();
		const canExtend = seconds + EXTRA_HOUR <= MAX_TIMEOUT_SECONDS;
		if (!ui) {
			await report(
				`Research ${run.runId} needs a time decision. Native dialogs are unavailable on this host. ` +
				(canExtend
					? `Ask the user whether to extend the same run to ${seconds + EXTRA_HOUR} total active seconds, keep it paused, or stop. `
					: "Another hour would exceed the SDK's maximum time limit; ask whether to keep it paused or stop. ") +
				"Do not resume or change other limits without approval.",
			);
			return;
		}
		const choice = await ui.select(
			`Research ${run.runId} ${run.status === "paused" ? "paused before" : "reached"} its ` +
			`${seconds / 60}-minute active-time limit. ` +
			(canExtend
				? `Another hour resumes this same run with a ${seconds / 60 + 60}-minute total limit. `
				: "Another hour would exceed the SDK's maximum time limit. ") +
			"Completed results are retained; interrupted agents may repeat. Dismissing this decision leaves the run stopped.",
			[...(canExtend ? [EXTEND] : []), KEEP_PAUSED, STOP],
		);
		if (closed || choice === null || choice === KEEP_PAUSED) return;
		if (choice !== STOP && (choice !== EXTEND || !canExtend)) {
			throw new Error("The native time-review dialog returned an unsupported decision");
		}
		const current = await workflow.getRunDetail(run.runId);
		if (closed) return;
		if (current.runId !== run.runId || current.revision !== run.revision
			|| reviewLimit(current, observed.has(run.runId)) !== seconds) {
			throw new Error(`Research ${run.runId} changed while awaiting your decision; no control was dispatched`);
		}
		const control = choice === EXTEND
			? workflow.resume(run.runId, {
				limits: { timeoutSeconds: seconds + EXTRA_HOUR },
				notifyOnComplete: true, logPhaseNames: true,
			})
			: workflow.cancel(run.runId);
		void control.then(async (result) => {
			if (result.runId !== run.runId || result.status === "error" || result.status === "halted"
				|| (choice === STOP && result.status !== "cancelled")) {
				await report(`Research ${run.runId}: ${result.error ?? `native control settled as ${result.status}`}. Inspect the original run before retrying.`);
			}
			void refresh(run.runId);
		}, (error) => report(`Research ${run.runId}: ${errorMessage(error)}. Inspect the original run before retrying.`));
	}

	/** @param {string} [runId] */
	async function refresh(runId) {
		if (closed) return;
		if (runId) invalidated.add(runId);
		else discover = true;
		pending = true;
		if (refreshing) return;
		refreshing = true;
		try {
			while (pending && !closed) {
				pending = false;
				const changed = [...invalidated];
				invalidated.clear();
				/** @type {Map<string, import("@github/copilot-sdk").WorkflowRunSummary>} */
				const runs = new Map();
				if (discover) {
					discover = false;
					try {
						const page = await workflow.listRuns({ limit: 20 });
						for (const run of page.runs) runs.set(run.runId, run);
					} catch (error) {
						await report(`Research time-review discovery failed: ${errorMessage(error)}. Native time limits remain enforced.`);
					}
				}
				for (const id of changed) {
					if (closed) return;
					try {
						const run = await workflow.getRunDetail(id);
						if (run.runId !== id) throw new Error("Native lookup returned a different run");
						runs.set(id, run);
					} catch (error) {
						await report(`Research time-review lookup for ${id} failed: ${errorMessage(error)}.`);
					}
				}
				for (const run of runs.values()) {
					if (closed) return;
					if (run.workflowName !== "deep-research") continue;
					observe(run);
					if (run.status === "completed" || run.status === "cancelled") {
						reviewed.delete(run.runId);
						observed.delete(run.runId);
					}
				}
				for (const run of runs.values()) {
					if (closed) return;
					const seconds = reviewLimit(run, observed.has(run.runId));
					if (seconds === null || reviewed.get(run.runId) === seconds) continue;
					try {
						await decide(run);
					} catch (error) {
						await report(`Research time review failed: ${errorMessage(error)}. Inspect the original run; no automatic retry will be made.`);
					}
				}
			}
		} catch (error) {
			await report(`Research time-review discovery failed: ${errorMessage(error)}. Native time limits remain enforced.`);
		} finally {
			refreshing = false;
		}
	}
	return {
		refresh,
		close() {
			closed = true;
			pending = false;
			invalidated.clear();
			for (const { controller } of waits.values()) controller.abort();
			waits.clear();
			failedWaits.clear();
		},
	};
}

export const PREFIX = "deep-research:time-review:v1:";

const PAUSE_LEAD_MS = 60_000;

export const MAX_TIMEOUT_SECONDS = 2_147_483.647;

/**
 * The checkpoint runs in the main workflow flow, outside concurrent stages.
 * Its native key survives provider restarts and changes with the approved budget.
 *
 * @param {Pick<import("@github/copilot-sdk").WorkflowContext, "runId" | "signal" | "log" | "pause">
 *   & {session: {workflow: Pick<import("@github/copilot-sdk").SessionWorkflowApi, "getRunDetail">}}} workflow
 * @param {() => Promise<string>} research
 * @returns {Promise<string>}
 */
export async function researchWithTimeReview(workflow, research) {
	const run = await workflow.session.workflow.getRunDetail(workflow.runId);
	workflow.signal.throwIfAborted();
	if (run.runId !== workflow.runId || run.workflowName !== "deep-research"
		|| run.status !== "running" || !run.approved) {
		throw new Error("Cannot establish the active research run's approved time budget");
	}
	const seconds = run.approved.timeoutSeconds;
	if (seconds === undefined) return research();
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_TIMEOUT_SECONDS
		|| !Number.isFinite(run.consumed.activeMs) || run.consumed.activeMs < 0
		|| !Number.isFinite(run.observedAt)) {
		throw new Error("Native research time accounting is invalid");
	}
	const pause = async () => {
		workflow.signal.throwIfAborted();
		workflow.log(
			`Research is approaching its ${seconds / 60}-minute active-time limit; requesting a time-review checkpoint. ` +
			"Choose another hour, keep the same run paused, or stop. Completed agent results remain journaled.",
		);
		await workflow.pause(`${PREFIX}${seconds}`);
	};
	const delay = seconds * 1000 - run.consumed.activeMs - PAUSE_LEAD_MS
		- Math.max(0, Date.now() - run.observedAt);
	if (delay <= 0) {
		await pause();
		workflow.signal.throwIfAborted();
		return research();
	}

	/** @type {ReturnType<typeof setTimeout> | undefined} */
	let timer;
	let abort = () => { };
	/** @type {Promise<null>} */
	const deadline = new Promise((resolve, reject) => {
		abort = () => reject(workflow.signal.reason);
		workflow.signal.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => resolve(null), delay);
	});
	try {
		const work = Promise.resolve().then(() => {
			workflow.signal.throwIfAborted();
			return research();
		});
		const outcome = await Promise.race([work.then((result) => ({ result })), deadline]);
		if (outcome !== null) return outcome.result;
		await pause();
		return await work;
	} finally {
		clearTimeout(timer);
		workflow.signal.removeEventListener("abort", abort);
	}
}

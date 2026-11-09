import { readSnapshot } from "./client.mjs";
import { FoundryWire } from "./contracts.mjs";
/** @typedef {ReturnType<typeof import("./contracts.mjs").FoundryWire.snapshot>} PlanSnapshot */

/** @param {{
 * acceptSnapshot: (snapshot: PlanSnapshot) => void,
 * readWorkflow: (runId: string, options: {beforeSeq?: number, selectPage: boolean}) => Promise<void>,
 * reportError: (message: string) => void,
 * needsRefresh: () => boolean,
 * }} dependencies */
export function createReader({ acceptSnapshot, readWorkflow, reportError, needsRefresh }) {
	/** @type {ReturnType<typeof setTimeout> | null} */
	let workflowRefreshTimer = null;

	let closing = false;

	/** Only this read queue owns snapshots; mutations and SSE merely invalidate it. */
	let refreshing = false;

	let refreshPending = false;

	/** @type {Map<string, {beforeSeq?: number, selectPage: boolean}>} */
	const workflowReads = new Map();
	/**
	 * Reloads the authoritative plan and derived projection.
	 *
	 * @returns {Promise<void>}
	 */
	async function loadPlan() {
		if (closing) return;
		refreshPending = true;
		await refreshViews();
	}
	async function refreshViews() {
		if (refreshing) return;
		refreshing = true;
		try {
			while (!closing && (refreshPending || workflowReads.size > 0)) {
				if (refreshPending) {
					refreshPending = false;
					try {
						const snapshot = await readSnapshot();
						if (!closing) acceptSnapshot(snapshot);
					} catch (error) {
						if (!closing) reportError(FoundryWire.errorMessage(error));
					}
				} else {
					const next = workflowReads.entries().next().value;
					if (!next) break;
					const [runId, options] = next;
					workflowReads.delete(runId);
					await readWorkflow(runId, options);
				}
			}
		} finally {
			refreshing = false;
		}
	}
	function updateWorkflowTimer() {
		const active = !closing && !document.hidden && needsRefresh();
		if (!active && workflowRefreshTimer !== null) {
			clearTimeout(workflowRefreshTimer);
			workflowRefreshTimer = null;
		}
		if (active && workflowRefreshTimer === null) {
			workflowRefreshTimer = setTimeout(async () => {
				workflowRefreshTimer = null;
				await loadPlan();
				updateWorkflowTimer();
			}, 10_000);
		}
	}
	function connectEvents() {
		const source = new EventSource("events");
		source.addEventListener("change", loadPlan);
		source.addEventListener("ready", loadPlan);
		source.onerror = () => {
			if (!closing) reportError("Live updates disconnected; use Refresh.");
		};
		return source;
	}
	return {
		refresh: loadPlan,
		updateTimer: updateWorkflowTimer,
		isClosed: () => closing,
		/** @param {string} runId @param {{beforeSeq?: number, selectPage: boolean}} options */
		enqueue(runId, options) {
			if (options.selectPage || !workflowReads.has(runId)) workflowReads.set(runId, options);
			void refreshViews();
		},
		start() {
			let events = connectEvents();
			document.addEventListener("visibilitychange", () => {
				updateWorkflowTimer();
				if (!document.hidden) void loadPlan();
			});
			window.addEventListener("pagehide", () => {
				closing = true;
				workflowReads.clear();
				updateWorkflowTimer();
				events.close();
			});
			window.addEventListener("pageshow", () => {
				if (!closing) return;
				closing = false;
				events = connectEvents();
				void loadPlan();
			});
			void loadPlan();
		},
	};
}

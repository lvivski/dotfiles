import { FoundryAnalysisError } from "../errors.mjs";
import { validateVerificationResult } from "../analysis/verdicts.mjs";
import { parseVerificationMarker } from "../marker.mjs";
import { FOUNDRY_WORKFLOWS } from "../workflows/registry.mjs";
import { fail, TERMINAL } from "./guards.mjs";

const RUN_DISCOVERY_PAGE_SIZE = 200;

const RUN_DISCOVERY_MAX_PAGES = 10;

/**
 * @param {ReturnType<typeof import("./reader.mjs").createRunReader>["api"]} api
 */
export function createReservationDiscovery(api) {

	/**
	 * Completed canonical results own their reservation; unfinished or invalid
	 * results still need bounded, base-agnostic marker discovery.
	 *
	 * @param {string} runId
	 * @param {import("@github/copilot-sdk").WorkflowRunDetail | null} [existingDetail]
	 * @returns {Promise<
	 *   {state: "readable", reservationIds: string[]}
	 *   | {state: "inconclusive", reason: string}
	 * >}
	 */
	const readReservationIdentity = async (runId, existingDetail = null) => {
		try {
			const detail = existingDetail ?? await api().getRunDetail(runId);
			if (detail.runId !== runId || detail.workflowName !== FOUNDRY_WORKFLOWS.verify.meta.name) {
				return { state: "inconclusive", reason: "verification run identity does not match" };
			}
			if (detail.status === "completed") {
				const run = await api().getRun(runId);
				if (run.runId !== runId) return { state: "inconclusive", reason: "verification result belongs to another run" };
				const result = run.result;
				if (run.status === "completed" && result && typeof result === "object" && !Array.isArray(result)
					&& typeof result.reservationId === "string" && result.reservationId.trim()) {
					try {
						validateVerificationResult(result, result.input, result.reservationId);
						return { state: "readable", reservationIds: [result.reservationId] };
					} catch (error) {
						if (!(error instanceof FoundryAnalysisError)) throw error;
					}
				}
			}
			let page = detail?.progress;
			const markers = new Set();
			for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
				if (!page || !Array.isArray(page.records)) {
					return { state: "inconclusive", reason: "progress-unavailable" };
				}
				for (const record of page.records) {
					if (record?.kind !== "log") continue;
					const marker = parseVerificationMarker(record.text);
					if (marker) markers.add(marker);
				}
				if (markers.size > 0) {
					return { state: "readable", reservationIds: [...markers] };
				}
				if (page.hasMoreOlder !== true) {
					return { state: "readable", reservationIds: [...markers] };
				}
				if (typeof page.oldestSeq !== "number" || !Number.isSafeInteger(page.oldestSeq)) {
					return { state: "inconclusive", reason: "progress-cursor-unavailable" };
				}
				page = await api().getRunProgress(runId, {
					beforeSeq: page.oldestSeq,
					limit: 500,
				});
			}
			return { state: "inconclusive", reason: "progress-unbounded" };
		} catch (error) {
			return {
				state: "inconclusive",
				reason: error instanceof Error ? error.message : String(error),
			};
		}
	};

	/**
	 * Discover the native verification run associated with one reservation.
	 * @param {string} reservationId
	 * @param {string} reservedAt
	 * @returns {Promise<
	 *   {state: "absent"}
	 *   | {state: "found", run: import("@github/copilot-sdk").WorkflowRunSummary, duplicates: []}
	 *   | {state: "inconclusive", reason: string,
	 *     candidates: Array<import("@github/copilot-sdk").WorkflowRunSummary & {reason?: string}>,
	 *     unattributable?: Array<import("@github/copilot-sdk").WorkflowRunSummary & {reason?: string}>}
	 * >}
	 */
	const discoverVerificationRun = async (reservationId, reservedAt) => {
		const threshold = Date.parse(String(reservedAt));
		if (!Number.isFinite(threshold)) {
			fail("workflow_reservation_invalid", "Verification reservation timestamp is invalid");
		}
		/** @type {Map<string, import("@github/copilot-sdk").WorkflowRunSummary>} */
		const summaries = new Map();
		let beforeSeq;
		/** @type {string | null} */
		let historyReason = "workflow run history exceeds the discovery page budget";
		for (let pageNumber = 0; pageNumber < RUN_DISCOVERY_MAX_PAGES; pageNumber++) {
			/** @type {import("@github/copilot-sdk").WorkflowRunsPage} */
			let page;
			try {
				page = await api().listRuns({
					limit: RUN_DISCOVERY_PAGE_SIZE,
					...(beforeSeq === undefined ? {} : { beforeSeq }),
				});
			} catch (error) {
				historyReason = error instanceof Error ? error.message : String(error);
				break;
			}
			if (!page || !Array.isArray(page.runs)) {
				historyReason = "workflow run listing is unavailable";
				break;
			}
			for (const summary of page.runs) {
				// Active runs can accompany every terminal window. They are not duplicates.
				if (summary && !summaries.has(summary.runId)) {
					summaries.set(summary.runId, summary);
				}
			}
			if (pageNumber === 0 && page.hasMoreNewer !== false) {
				historyReason = "workflow run listing has unresolved newer history";
				break;
			}
			if (
				typeof page.omittedOlder !== "number"
				|| !Number.isSafeInteger(page.omittedOlder)
				|| page.omittedOlder < 0
			) {
				historyReason = "workflow run listing has unknown omitted older history";
				break;
			}
			if (page.omittedOlder === 0) {
				historyReason = null;
				break;
			}
			// These are terminal-run cursors, not offsets into runs (which includes active runs).
			if (
				typeof page.oldestSeq !== "number"
				|| !Number.isSafeInteger(page.oldestSeq)
				|| (beforeSeq !== undefined && page.oldestSeq >= beforeSeq)
			) {
				historyReason = "workflow run listing has no advancing older cursor";
				break;
			}
			beforeSeq = page.oldestSeq;
		}
		const matches = [];
		const inconclusive = [];
		const unattributable = [];
		for (const summary of [...summaries.values()]
			.filter((entry) => entry?.workflowName === FOUNDRY_WORKFLOWS.verify.meta.name)
			.filter((entry) => !Number.isFinite(entry.createdAt) || entry.createdAt >= threshold)
			.sort((left, right) => (
				(Number.isFinite(left.createdAt) ? left.createdAt : Number.POSITIVE_INFINITY)
				- (Number.isFinite(right.createdAt) ? right.createdAt : Number.POSITIVE_INFINITY)
			))) {
			const identity = await readReservationIdentity(summary.runId);
			if (identity.state === "inconclusive") {
				const candidate = { ...summary, reason: identity.reason };
				if (!Number.isFinite(summary.createdAt) && TERMINAL.has(summary.status)) {
					unattributable.push(candidate);
				} else {
					inconclusive.push(candidate);
				}
				continue;
			}
			if (identity.reservationIds.includes(reservationId)) {
				matches.push(summary);
				continue;
			}
			if (identity.reservationIds.length > 0) continue;
			if (
				!TERMINAL.has(summary.status)
			) {
				inconclusive.push({ ...summary, reason: "run has not emitted a reservation marker" });
			}
		}
		if (matches.length > 1) {
			return {
				state: "inconclusive",
				reason: "multiple Workflow runs carry the verification reservation",
				candidates: matches,
			};
		}
		if (historyReason !== null) {
			return {
				state: "inconclusive",
				reason: historyReason,
				candidates: [...matches, ...inconclusive],
				unattributable,
			};
		}
		if (matches.length === 1 && (inconclusive.length > 0 || unattributable.length > 0)) {
			return {
				state: "inconclusive",
				reason: "a matching verification run exists alongside unresolved candidates",
				candidates: [...matches, ...inconclusive],
				unattributable,
			};
		}
		if (matches.length === 1) {
			return {
				state: "found",
				run: matches[0],
				duplicates: [],
			};
		}
		if (inconclusive.length > 0) {
			return {
				state: "inconclusive",
				reason: "verification launch is not yet observable",
				candidates: inconclusive,
				unattributable,
			};
		}
		if (unattributable.length > 0) {
			return {
				state: "inconclusive",
				reason: "terminal Workflow runs cannot be attributed to this reservation",
				candidates: [],
				unattributable,
			};
		}
		return { state: "absent" };
	};
	return { readReservationIdentity, discoverVerificationRun };
}

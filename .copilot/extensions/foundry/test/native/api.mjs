import { must } from "../assertions.mjs";

/** @typedef {{run: {runId: string, status: string, result?: unknown, error?: string, reason?: string, pauseInfo?: unknown, failure?: unknown},
 * workflowName: string, progress?: string[], progressUnavailable?: boolean, seqBase?: number, createdAt?: unknown, completedAt?: number | null}} FakeRunRecord */

/** Raw native-wire fixture: malformed responses intentionally remain unknown until the adapter inspects them.
 * @param {Record<string, FakeRunRecord>} [records] @param {{pageSize?: number, seqBase?: number}} [options] */
export function fakeApi(records = {}, { pageSize = 200, seqBase = 0 } = {}) {
	/** @type {Array<import("@github/copilot-sdk").WorkflowListRunsOptions | undefined>} */
	const listCalls = [];
	/** @type {string[]} */
	const detailCalls = [];
	/** @type {string[]} */
	const cancelCalls = [];
	const terminalStatuses = new Set(["completed", "error", "halted", "paused", "cancelled"]);
	return {
		listCalls,
		detailCalls,
		cancelCalls,
		/** @param {string} runId @returns {Promise<unknown>} */
		async getRun(runId) {
			const record = records[runId];
			if (!record) throw new Error(`Workflow run ${runId} not found`);
			return record.run;
		},
		/** @param {string} runId @returns {Promise<unknown>} */
		async getRunDetail(runId) {
			detailCalls.push(runId);
			const record = records[runId];
			if (!record) throw new Error(`Workflow run ${runId} not found`);
			const all = (record.progress ?? []).map((text, index) => ({
				seq: (record.seqBase ?? 0) + index,
				kind: "log",
				text,
			}));
			const page = all.slice(-200);
			return {
				runId,
				workflowName: record.workflowName,
				status: record.run.status,
				createdAt: record.createdAt ?? Date.parse("2026-08-07T00:10:00.000Z"),
				completedAt: record.completedAt ?? null,
				progress: record.progressUnavailable
					? null
					: {
						records: page,
						oldestSeq: page[0]?.seq ?? null,
						newestSeq: page.at(-1)?.seq ?? null,
						hasMoreOlder: all.length > page.length,
						hasMoreNewer: false,
					},
			};
		},
		/**
		 * @param {import("@github/copilot-sdk").WorkflowListRunsOptions} [options]
		 * @returns {Promise<unknown>} Deliberately malformed pages are native-wire boundary tests.
		 */
		async listRuns(options = undefined) {
			listCalls.push(options);
			const { afterSeq, beforeSeq, limit = 200 } = options ?? {};
			const all = Object.entries(records).map(([runId, record], index) => ({
				seq: seqBase + index,
				summary: {
					runId,
					workflowName: record.workflowName,
					status: record.run.status,
					createdAt: record.createdAt ?? Date.parse("2026-08-07T00:10:00.000Z"),
				},
			}));
			const terminal = all.filter((entry) => terminalStatuses.has(entry.summary.status));
			const eligible = terminal.filter((entry) =>
				(afterSeq === undefined || entry.seq > afterSeq)
				&& (beforeSeq === undefined || entry.seq < beforeSeq),
			);
			const size = Math.min(limit, pageSize, 500);
			const window = afterSeq === undefined
				? eligible.slice(-size)
				: eligible.slice(0, size);
			// Native paging limits terminals; active runs remain visible across pages.
			const runs = [
				...window,
				...all.filter((entry) => !terminalStatuses.has(entry.summary.status)),
			].sort((left, right) => left.seq - right.seq).map((entry) => entry.summary);
			const page = {
				runs,
				oldestSeq: window[0]?.seq ?? null,
				newestSeq: window.at(-1)?.seq ?? null,
				hasMoreNewer: terminal.some((entry) =>
					entry.seq > (window.at(-1)?.seq ?? afterSeq ?? Number.POSITIVE_INFINITY),
				),
				omittedOlder: terminal.filter((entry) =>
					entry.seq < (window[0]?.seq ?? beforeSeq ?? Number.NEGATIVE_INFINITY),
				).length,
			};
			return options === undefined ? page.runs : page;
		},
		/** @param {string} runId @param {{limit?: number, beforeSeq?: number, afterSeq?: number}} [options] @returns {Promise<unknown>} */
		async getRunProgress(runId, options = {}) {
			const record = records[runId];
			if (!record) throw new Error(`Workflow run ${runId} not found`);
			const all = (record.progress ?? []).map((text, index) => ({
				seq: (record.seqBase ?? 0) + index,
				kind: "log",
				text,
			}));
			const limit = options.limit ?? 200;
			const eligible = options.beforeSeq != null
				? all.filter((entry) => entry.seq < must(options.beforeSeq)).slice(-limit)
				: all.filter((entry) => entry.seq > (options.afterSeq ?? -1)).slice(0, limit);
			const page = eligible;
			return {
				records: page,
				oldestSeq: page[0]?.seq ?? null,
				newestSeq: page.at(-1)?.seq ?? null,
				hasMoreOlder: all.some(
					(entry) => entry.seq < (page[0]?.seq ?? Number.POSITIVE_INFINITY),
				),
				hasMoreNewer: all.some(
					(entry) => entry.seq > (page.at(-1)?.seq ?? (options.afterSeq ?? -1)),
				),
			};
		},
		/** @param {string} runId @returns {Promise<unknown>} */
		async cancel(runId) {
			cancelCalls.push(runId);
			const record = records[runId];
			if (!record) throw new Error(`Workflow run ${runId} not found`);
			record.run = { ...record.run, status: "cancelled" };
			return record.run;
		},
	};
}

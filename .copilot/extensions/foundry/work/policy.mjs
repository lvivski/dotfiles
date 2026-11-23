import { fail, fields, integer } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Pick<Run, "policy"|"scheduling">} run */
export const workerLimit = run => run.scheduling?.workers ?? run.policy.workers;
/** @param {Run} run */
export const scheduling = run => ({ revision: run.scheduling?.revision ?? 0, workers: workerLimit(run) ?? null,
	ceiling: run.policy.workers ?? null, checkpointReviews: run.scheduling?.checkpointReviews ?? true });

/** @param {Run} run @param {string} actor @param {Record<string,unknown>} a */
export function configure(run, actor, a) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner can change scheduling policy");
	fields(a, ["run","revision","workers","checkpointReviews"]);
	const old = scheduling(run);
	if (integer(a.revision, 0, "expected policy revision") !== old.revision)
		fail("stale_policy", "Scheduling policy revision changed; read the current settings");
	if (a.workers === undefined && a.checkpointReviews === undefined) fail("invalid_field", "Select a scheduling setting");
	const workers = a.workers === undefined ? old.workers : a.workers === null ? old.ceiling : integer(a.workers, 1, "worker limit");
	if (old.ceiling !== null && workers !== null && workers > old.ceiling) fail("limit", "Worker limit exceeds the committed ceiling");
	if (a.checkpointReviews !== undefined && typeof a.checkpointReviews !== "boolean") fail("invalid_field", "checkpointReviews must be boolean");
	const checkpointReviews = a.checkpointReviews ?? old.checkpointReviews;
	if (workers === old.workers && checkpointReviews === old.checkpointReviews) return;
	run.scheduling = { revision: old.revision + 1, ...(workers !== null && workers !== old.ceiling ? {workers} : {}), checkpointReviews };
}

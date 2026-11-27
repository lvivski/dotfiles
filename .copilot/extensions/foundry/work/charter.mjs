import { repairDirectory } from "./blockers.mjs";
import { awaitingReply, unissued } from "./dispatch.mjs";
import { comparisonGoal, leadGoal, repairDetail } from "./evidence.mjs";
import { comparison } from "./origin.mjs";
export { comparison, comparisonReview, evidenceOrigin, wakeSource } from "./origin.mjs";
import { comparisonScope, referenceRepo } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @param {Run} run */
export const reviews = run => run.effects.filter(e => e.kind === "scout");

export const staleReviewReason = "Chartered inputs changed during review";

/** Only old snapshots use display text as an index. Re-admission always rechecks the actual report.
 * @param {Review} r @param {import("./model.js").ReviewObstacle["kind"]} kind @param {string} [subject] */
export function obstructed(r,kind,subject){
	if(r.obstacle)return r.obstacle.kind===kind && r.obstacle.subject===subject;
	switch(kind){
	case "missing-output":return r.error===`Unknown required output: ${subject}`;
	case "overlap":return r.error==="Writable directories must be disjoint";
	case "stale-review":return r.error===staleReviewReason;
	case "outside-scope":return r.error===`This comparison is for one independent directory: ${subject}` || !!r.error?.startsWith(`Preserving assignments outside comparison ${subject}: `);
	case "repeated-output":return r.error===`Cannot repartition ${subject}: its repeated output has not passed a product checkpoint`;
	default:return false;
	}
}

export const staleReaderMessage = "The installed Foundry reader changed. Reload Foundry in this session, then check the original assignment's status. Do not restart the run.";

/** Only the bound workflow's terminal envelope, not a scout's report or an unconfirmed exception.
 * Keep the original receipt recognizable on installations that already recorded it.
 * @param {Review} r */
export const readerInterrupted = r => r.state === "blocked" && !!r.workflowId && !!r.callId && !r.observation && !r.packet &&
	!r.retryOf && r.error === `Discovery error: Request workflow.execute failed with message: ${staleReaderMessage}`;

/** @param {Review} r */
export const reading = r => unissued(r) || awaitingReply(r);

/** The first dialog is already identified by its unique review, including before recovery was supported.
 * @param {Review} r */
export const presentation = r => r.decision?.status === "presenting" ? r.decision.presentation ?? r.id :
	r.decision?.status === "unavailable" ? r.decision.presentation : undefined;

/** @param {Review} review @param {import("./model.js").Squad} squad */
export const investigation = (review, squad) => review.wake?.key === "research" ||
	!!referenceRepo(review.wake?.key) && "areas" in squad && !!squad.researchAgent;

/** @param {Run} run @param {Review|undefined} review */
export function checkpointScope(run, review) {
	if (review?.renewal?.state==="approved") return {check:review.renewal.checkpoint,goal:review.renewal.goal};
	if (review?.lead) return {check:review.lead.checkpoint, goal:leadGoal(review.lead)};
	const i = comparison(run, review);
	if (i?.basis) return {check:i.receipt, goal:comparisonGoal(i)};
}

/** @param {Run} run @param {ReturnType<typeof checkpointScope>} scope */
export const atCheckpoint = (run, scope) => !!scope && scope.check === run.products.at(-1)?.check &&
	(!scope.goal || scope.goal === run.goal?.check);

/** Only immutable review evidence determines same-checkpoint handoff scope.
 * @param {Run} run @param {Review} review @param {import("./model.js").Observation} report */
export function successorDirectory(run, review, report) {
	const iteration = comparison(run, review);
	if (review.retryOf) return iteration && comparisonScope(iteration);
	if (!iteration && report.replace?.length === 1) {
		const id = report.replace[0], n = review.predecessor ?? run.nodes[id], detail = n && repairDetail(n);
		if (detail && n.grain.id === id && review.packet?.sources?.includes(`detail:${detail}`)) return n.grain.directory;
	}
	return iteration ? comparisonScope(iteration) : repairDirectory(run, review, report);
}

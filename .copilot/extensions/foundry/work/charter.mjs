import { repairDirectory } from "./blockers.mjs";
import { awaitingReply, unissued } from "./dispatch.mjs";
import { comparisonGoal, leadGoal, repairDetail, sameEvaluation } from "./evidence.mjs";
import { effectAt } from "./revision.mjs";
import { comparisonScope, fail, referenceRepo } from "./values.mjs";

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

/** A retry has its own workflow and packet, but its routing evidence belongs to the original.
 * @param {Run} run @param {Review} review */
export function evidenceOrigin(run, review) {
	if (!review.retryOf) return review;
	const original = effectAt(run,review.retryOf);
	if (original?.kind !== "scout" || original.retryOf || run.effects.indexOf(original) >= run.effects.indexOf(review))
		fail("corrupt_run", "Missing original scout review");
	return original;
}

/** @param {Review} r */
export const reading = r => unissued(r) || awaitingReply(r);

/** The first dialog is already identified by its unique review, including before recovery was supported.
 * @param {Review} r */
export const presentation = r => r.decision?.status === "presenting" ? r.decision.presentation ?? r.id :
	r.decision?.status === "unavailable" ? r.decision.presentation : undefined;

/** @param {Run} run @param {Review} r */
export const wakeSource = (run, r) => {
	const wake=r.wake,p=wake && effectAt(run,wake.review);
	return p?.kind==="scout" && p.squad===r.squad && sameEvaluation(p,r) &&
		(wake?.key==="released-inputs"?p.state==="deferred":p.base===r.base) ? p : undefined;
};

/** @param {Review} review @param {import("./model.js").Squad} squad */
export const investigation = (review, squad) => review.wake?.key === "research" ||
	!!referenceRepo(review.wake?.key) && "areas" in squad && !!squad.researchAgent;

/** Evidence pages continue the same comparison, but an ordinary later review does not.
 * @param {Run} run @param {Review|undefined} review */
export function comparisonReview(run, review) {
	let r = review && evidenceOrigin(run, review);
	while (r && !r.iteration && r.wake) {
		const prev = wakeSource(run, r);
		if (!prev || prev.observation?.outcome !== "needs-evidence" || prev.base !== r.base ||
			prev.version !== r.version || !sameEvaluation(prev,r) || run.effects.indexOf(prev) >= run.effects.indexOf(r)) return;
		r = evidenceOrigin(run, prev);
	}
	return r?.iteration ? r : undefined;
}

/** @param {Run} run @param {Review|undefined} review */
export const comparison = (run, review) => comparisonReview(run, review)?.iteration;

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

import { working } from "./assignment.mjs";
import { workerLimit } from "./policy.mjs";
import { reading } from "./reviews.mjs";

/** @typedef {import("./model.js").Run} Run */
/** Count reservations, not deliveries. An inline repair records its token on
 * the preceding component check rather than reserving a separate notice.
 * @param {Pick<Run, "effects"|"correctionDrafts">} run */
export const assignmentCount = run => run.effects.filter(e => e.kind === "scout" || e.kind === "writer" ||
	e.kind === "repair" || e.kind === "component" && e.inlineRepair).length+(run.correctionDrafts??[]).reduce((n,d)=>n+d.parts.filter(p=>p.dispatch).length,0);

/** @param {Pick<Run, "policy"|"effects"|"correctionDrafts">} run */
export const remainingAssignments = run => run.policy.assignments === undefined ? Infinity : Math.max(0, run.policy.assignments - assignmentCount(run));

/** Already reserved work drains normally when a live concurrency limit drops.
 * @param {Pick<Run, "policy"|"scheduling"|"effects"|"nodes"|"correctionDrafts">} run
 * @param {number} [remaining] Remaining lifetime budget, if already computed in this transition. */
export function availableReservations(run, remaining = remainingAssignments(run)) {
	const limit = workerLimit(run);
	if (limit === undefined) return remaining;
	const occupied = Object.values(run.nodes).filter(working).length + run.effects.filter(e => e.kind === "scout" && reading(e)).length +
		(run.correctionDrafts??[]).reduce((n,d)=>n+d.parts.filter(p=>p.state==="issued").length,0);
	return Math.max(0, Math.min(remaining, limit - occupied));
}
/** An exact host admission refusal, not an uncertain launch or a workflow's own failure message.
 * @param {unknown} error */
export const noWorkflowSlot=error=>error instanceof Error && /^This session already has [1-9]\d* active workflow runs, which is the concurrent limit\.$/.test(error.message);

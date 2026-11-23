import { checkpointReceipt, checkReceipt, goalReceipt, milestoneBlocker } from "./evidence.mjs";
import { awaitingReply } from "./native.mjs";
import { working } from "./plan.mjs";
import { comparison, nextReview, reading, reviews } from "./reviews.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run */
export function pendingGoal(run) {
	const e = run.effects.find(e => e.id === run.goal?.check);
	return e?.kind === "goal" && e.commit === run.goal?.commit && !e.receipt && !e.permissionHold && awaitingReply(e);
}

/** @param {Run} run @param {string} receipt @param {string} target */
export function checkpointCurrent(run, receipt, target) {
	const last = run.products.at(-1);
	return !!last && !run.join && !run.blocker && !run.conflict && last.check === receipt && last.target === target &&
		last.commit === run.goal?.commit && run.goal.target === target && !!checkpointReceipt(run, receipt, last.commit);
}

/** @param {import("./model.js").Receipt} r */
export const undecided = r => `Final goal check could not decide at ${r.commit} (exit ${r.exit ?? "unknown"}): ${r.output || "no diagnostic"}`;

/** @param {Run} run @param {string} target @returns {import("./engine.mjs").Facts} */
export function releaseFacts(run, target) {
	const at = run.goal, last = run.products.at(-1), effect = at && run.effects.find(e => e.id === at.check);
	const pin = run.repins?.at(-1)?.revision, receipt = goalReceipt(run);
	const obsolete = effect?.kind === "goal" && effect.evaluatorRevision !== pin;
	const old = obsolete && checkReceipt(effect), heldPin = obsolete && (awaitingReply(effect) || effect.permissionHold || effect.state === "refused");
	const goal = !at ? "absent" : obsolete ? heldPin ? "superseded" : "repin" : last && last.commit !== at.commit ? "new-product" :
		!receipt ? "pending" : receipt.exit === 2 ? "missing" : receipt.exit === 1 ? "unmet" : receipt.exit === 0 ? "met" : "incomplete";
	const history = reviews(run), nodes = Object.values(run.nodes), byId = new Map(history.map(r => [r.id, r]));
	const review = goal === "met" && [...new Map(history.map(r => [r.squad, r])).values()].some(r =>
		r.base === at?.commit && r.evaluatorRevision === pin && comparison(run, r)?.basis &&
		(reading(r) || r.state === "reported" || r.state === "observed" && r.observation?.outcome === "needs-evidence" &&
			nextReview(run, history.filter(p => p.squad === r.squad && p.evaluatorRevision === pin), r.base, r.version)?.wake));
	const exactProduct = !!last && at?.commit === last.commit && last.target === target && !!checkpointReceipt(run, last.check, last.commit);
	return { active: run.active, qualified: !!last?.qualifiedAt, goal,
		blocked: !!run.blocker && !(goal === "repin" && old && run.blocker === undecided(old)),
		scoped: exactProduct && at?.target === target && !run.join && !run.blocker && !run.conflict && (!!pendingGoal(run) || review),
		stalled: !!at?.stall, moved: !!at && at.target !== target, idle: !nodes.some(n => n.state !== "idle") && !history.some(reading),
		product: !!last, exactProduct, join: !!run.join, held: !!milestoneBlocker(run), review,
		work: goal === "met" && nodes.some(n => n.state !== "qualified" && n.review && comparison(run, byId.get(n.review))?.basis ||
			run.repins?.length && (working(n) || n.state === "published" || n.worker && n.state === "waiting")) };
}

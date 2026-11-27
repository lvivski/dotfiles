import { remainingAssignments } from "./capacity.mjs";
import { effectAt } from "./revision.mjs";
import { checkpointReceipt, checkReceipt, currentEvaluation, failedCandidate, failedComponent, goalReceipt, milestoneBlocker, originalVerification, productPin, qualifiedProduct, verification } from "./evidence.mjs";
import { unprovenExports } from "./attestation.mjs";
import { awaitingReply } from "./reservation.mjs";
import { discoverLeads } from "./leads.mjs";
import { working } from "./assignment.mjs";
import { writerInputs } from "./plan.mjs";
import { atCheckpoint, checkpointScope, checkpointWake, reading, reviews } from "./reviews.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run */
export function pendingGoal(run) {
	const e = effectAt(run,run.goal?.check);
	return e?.kind === "goal" && e.commit === run.goal?.commit && !e.receipt && !e.permissionHold && awaitingReply(e);
}

/** @param {Run} run @param {string} receipt @param {string} target */
export function checkpointCurrent(run, receipt, target) {
	const last = run.products.at(-1);
	return !!last && !run.join && !run.blocker && !run.conflict && last.check === receipt && last.target === target &&
		last.commit === run.goal?.commit && run.goal.target === target && !!checkpointReceipt(run, receipt, last.commit);
}

/** A later checkpoint need not reopen a proposal to continue the original writer's
 * verified component failure. Directory, prerequisites and citations still need Git validation.
 * @param {Run} run @param {import("./model.js").Node} n @param {import("./model.js").Review|undefined} r
 * @param {string|undefined} checkpoint */
export function continuingRepair(run, n, r, checkpoint) {
	const last = run.products.at(-1);
	return n.state === "waiting" && n.repairs < run.policy.repairs && !!checkpoint && !!last && last.check !== checkpoint &&
		r?.state === "observed" && n.base === r.base && currentEvaluation(run,r) &&
		last.commit === run.goal?.commit && last.target === run.goal.target &&
		run.products.some(p => p.check === checkpoint && p.commit === r.base && p.target === last.target) &&
		!!checkpointReceipt(run, checkpoint, r.base) && (failedCandidate(run, n) || !!run.inspections?.some(i=>i.state==="changes" &&
			i.component===n.check && i.grain===n.grain.id && i.candidate===n.candidate && i.base===n.base && i.generation===n.generation));
}

/** A new joined check blamed the included parent, not its original (pre-transfer) scout.
 * @param {Run} run @param {import("./model.js").Node} n */
export function retainedRepair(run,n) {
	if (!n.retained || !n.worker || n.state!=="waiting" || !n.replaces || run.join) return false;
	const last=run.products.at(-1), e=run.effects.findLast(e=>e.kind==="product");
	return last?.outputs[n.grain.id]===n.replaces && last.commit===run.goal?.commit && last.target===run.goal.target &&
		e?.kind==="product" && e.evaluatorRevision===productPin(run) && !e.error && !e.permissionHold &&
		checkReceipt(e)?.repair===n.grain.id && run.effects.indexOf(e)>run.effects.findIndex(g=>g.id===run.goal?.check);
}

/** @param {import("./model.js").Receipt} r */
export const undecided = r => `Final goal check could not decide at ${r.commit} (exit ${r.exit ?? "unknown"}): ${r.output || "no diagnostic"}`;

/** @param {Run} run @param {string} target @returns {import("./engine.mjs").Facts} */
export function releaseFacts(run, target) {
	const at = run.goal, last = run.products.at(-1), effect=effectAt(run,at?.check);
	const receipt = goalReceipt(run), upgrade = run.productRepins?.at(-1);
	const obsolete = effect?.kind === "goal" && !currentEvaluation(run,effect);
	const old = obsolete && checkReceipt(effect), heldPin = obsolete && (awaitingReply(effect) || effect.permissionHold || effect.state === "refused");
	const approved=run.repins?.at(-1),previous=last && run.effects.find(e=>e.id===last.check);
	const independentGoal=!!(obsolete && approved && approved.revision!==effect.evaluatorRevision && effect.state==="uncertain" &&
		effect.runnerStarted && effect.runnerClaim && effect.callId && !effect.receipt && !effect.permissionHold &&
		last && previous?.kind==="product" && previous.runnerClaim && checkpointReceipt(run,last.check,last.commit) &&
		last.target===target && at?.target===target && !run.conflict && !run.independent && !run.effects.some(e=>e.permissionHold) && !run.inspections?.some(i=>i.permissionHold));
	const withdrawn=at && run.products.findLast(p=>p.withdrawnHandoff?.goal===at.check)?.withdrawnHandoff;
	const withheld=unprovenExports(run).length>0 || !!withdrawn && (last?.check!==withdrawn.recheck || last.target!==target);
	const rejoin = at && run.effects.find(e=>e.kind==="product" && e.recheck?.of===at.check);
	const pendingPin=upgrade && at?.check===upgrade.goal && originalVerification(run,last?.check)!==verification(upgrade) ? upgrade : undefined;
	const goal = !at ? "absent" : withheld ? "withheld-handoff" :
		withdrawn ? "new-product" : pendingPin ? "product-repin" :
		rejoin ? last && run.effects.findIndex(e=>e.id===last.check)>=run.effects.indexOf(rejoin) ? "new-product" : "rejoining" :
		obsolete ? independentGoal && last?.commit!==at.commit && previous && run.effects.indexOf(previous)>run.effects.indexOf(effect) ? "new-product" :
			heldPin ? "superseded" : "repin" : last && last.commit !== at.commit ? "new-product" :
		effect?.state === "retired" ? "retired" : !receipt ? "pending" : receipt.exit === 2 ? "missing" : receipt.exit === 1 ? "unmet" : receipt.exit === 0 ? "met" : "incomplete";
	const history = reviews(run).filter(r=>currentEvaluation(run,r)), nodes = Object.values(run.nodes), byId = new Map(history.map(r => [r.id, r]));
	const remaining = remainingAssignments(run);
	const review = (goal === "met" || goal === "missing") && [...new Map(history.map(r => [r.squad, r])).values()].some(r =>
		r.base === at?.commit && atCheckpoint(run, checkpointScope(run,r)) &&
		(reading(r) || r.state === "reported" || remaining > 0 && checkpointWake(run, history.filter(p => p.squad === r.squad), r.base, r.version)));
	const exactProduct = !!last && at?.commit === last.commit && last.target === target && !!checkpointReceipt(run, last.check, last.commit);
	const historicalWork = goal === "missing" ? nodes.filter(n => {
		if (retainedRepair(run,n)) return true;
		const r = n.review && byId.get(n.review);
		if (!r) return false;
		const scope = checkpointScope(run,r);
		return atCheckpoint(run,scope) || n.reuse || continuingRepair(run, n, r, scope?.check);
	}) : [];
	// A chain can advance if some writer is reserved or its next prerequisite can
	// actually start. A report alone cannot fund another writer (including a repair).
	/** @param {import("./model.js").Node} n */
	const reachable = n => working(n) || remaining > 0 && !!writerInputs(run.nodes, n);
	// A missing observation restricts new assignments, not integration of already checked work.
	const work = (goal === "missing" || goal === "met") && nodes.some(n => n.state === "published" || goal === "met" && reachable(n));
	const scoped = exactProduct && at?.target === target && !run.blocker && !run.conflict && (
		!run.join && (pendingGoal(run) || review || historicalWork.some(reachable) ||
			goal === "missing" && remaining > 0 && !!discoverLeads(run, history)?.leads.size) ||
		goal === "missing" && work && !milestoneBlocker(run));
	return { active: run.active, qualified: !!qualifiedProduct(run), goal,
		blocked: !!run.blocker && !(goal === "repin" && old && run.blocker === undecided(old)),
		scoped,supersededWork:independentGoal && !!last && last.commit===at?.commit && nodes.some(n=>n.state==="published"),
		failedComponent:!!pendingPin?.targetFrom && originalVerification(run,run.join?.check)===verification(pendingPin) && !!failedComponent(run.effects.find(e=>e.id===run.join?.check)),
		stalled: !!at?.stall, moved: !!at && (pendingPin?.targetFrom ? pendingPin.revision : at.target) !== target, idle: !nodes.some(n => n.state !== "idle") && !history.some(reading),
		product: !!last, exactProduct, join: !!run.join, held: !!milestoneBlocker(run), review, work };
}

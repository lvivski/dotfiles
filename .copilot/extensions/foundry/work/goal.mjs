import { admissionPolicy } from "./admission.mjs";
import { assign } from "./assignment.mjs";
import { activate } from "./activity.mjs";
import { checkpointReceipt, checkReceipt, currentEvaluation, goalReceipt, leadGoal, milestoneBlocker, productPin } from "./evidence.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { release, transition } from "./engine.mjs";
import { implement } from "./adapter.mjs";
import { pendingGoal, releaseFacts, undecided } from "./facts.mjs";
import { expired, reserveCheck, reserveNotice, reserveProduct } from "./native.mjs";
import { workKey } from "./plan.mjs";
import { partitionConflict } from "./partition.mjs";
import { heldRepair } from "./successor.mjs";
import { descendsFrom, retain, treeOf, verifyContracts } from "./product.mjs";
export { frozenCheckpoint } from "./frozen.mjs";
import { blockReview, checkpointWake, comparison, reading, reviews, staleReviewReason } from "./reviews.mjs";
import { FoundryError, deadlineAt, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} cwd @param {Run} run @param {string} actor @param {string} target @param {string} commit */
export function assess(cwd, run, actor, target, commit) {
	verifyContracts(cwd, run.policy, target);
	run.goal = { target, commit, check: reserveCheck(run, actor, cwd, commit, text(run.policy.goalCheck, "goal evaluator")) };
	for (const r of reviews(run)) if (r.state === "ready" && r.base !== commit)
		blockReview(r, "Reviewed revision was superseded before dispatch");
}

/** Publish the timestamp and owner notification in the same transition as the exact receipt.
 * @param {Run} run @param {string} actor @param {import("./model.js").Product} product */
export function qualify(run, actor, product) {
	product.qualifiedAt = Date.now();
	const exclusions = [];
	if (run.goal) {
		const budget = remainingAssignments(run);
		for (const n of Object.values(run.nodes)) if (n.state === "blocked" || n.state === "waiting") {
			if (n.candidate && product.outputs[n.grain.id] === n.candidate) continue;
			exclusions.push(`${n.grain.id}: ${n.reason ?? (budget ? "No reachable prerequisite" : "No assignment remains")}`);
		}
		if (!budget) for (const r of new Map(reviews(run).filter(r => currentEvaluation(run,r)).map(r => [r.squad,r])).values()) {
			if (r.base === product.commit && r.state === "observed" && r.observation?.outcome === "needs-evidence")
				exclusions.push(`Review ${r.id}: no assignment remains for the requested evidence follow-up`);
		}
	}
	reserveNotice(run, actor, product.check, "handoff",
		`Foundry ${run.id} qualified ${product.commit}. The target was not changed. Read foundry_status({run:"${run.id}"}) for the checked product and its receipts.` +
		(exclusions.length ? `\nNot included in this release:\n${exclusions.join("\n")}` : ""));
}

/** Shared, read-only preflight. Re-evaluate the current tip, not yesterday's persisted conflict.
 * @param {()=>string} tip */
export function observeTarget(tip) {
	try { return { target:tip() }; }
	catch (error) {
		if (!(error instanceof Error && "status" in error)) throw error;
		return { error:`Target unavailable: ${error.message}` };
	}
}

/** Never infer when an older receipt finished. Only completed observations, not a
 * reservation or a native success, can be settled after the clock expires.
 * @param {Run} run */
export function timelyChecks(run) {
	const until=run.policy.deadline && deadlineAt(run.policy.deadline), product=run.join ?? run.products.at(-1);
	if (typeof until!=="number" || !product || product.commit!==run.goal?.commit || product.target!==run.goal.target || run.blocker || run.conflict ||
		run.effects.some(e=>e.permissionHold)) return false;
	const effect=run.effects.find(e=>e.id===product.check), goal=goalReceipt(run);
	if (effect?.kind!=="product" || effect.commit!==product.commit || effect.check!==run.policy.productCheck ||
		effect.evaluatorRevision!==productPin(run)) return false;
	const milestone=checkReceipt(effect);
	return [goal,milestone].every(r=>r?.exit===0 && r.completedAt!==undefined && r.completedAt<until);
}

/** An automatic survey belongs to the signed checkpoint and goal, not to the tip of the delivery branch.
 * Explicit comparisons, retries and grants keep their own live-target checks.
 * @param {Run} run @param {import("./model.js").Review|undefined} r */
export const checkpointSurvey = (run,r) => !!r?.lead && !r.retryOf && !r.correction && !comparison(run,r) &&
	r.base===run.goal?.commit && leadGoal(r.lead)===run.goal?.check && r.lead.checkpoint===run.products.at(-1)?.check && currentEvaluation(run,r);

/** @param {string} cwd @param {Run} run @param {string} target */
export function movingSurvey(cwd,run,target) {
	const p=run.products.at(-1), at=run.goal;
	if (!p || !at || p.target===target || p.qualifiedAt || p.target!==at.target || p.commit!==at.commit ||
		run.join || run.independent || run.blocker || !checkpointReceipt(run,p.check,p.commit) ||
		!(pendingGoal(run) || goalReceipt(run)?.exit===2) || partitionConflict(run,undefined,p.target)) return;
	const history=reviews(run).filter(r=>currentEvaluation(run,r));
	const unfinished=new Set(Object.values(run.nodes).filter(n=>["waiting","writing","checking","published"].includes(n.state)).map(n=>n.review));
	const latest=new Map(history.map(r=>[r.squad,r]));
	const pending=history.some(r=>{
		if (!checkpointSurvey(run,r)) return false;
		if (unfinished.has(r.id)) return true;
		if (latest.get(r.squad)!==r) return false;
		if (reading(r) || r.state==="reported" || r.state==="blocked" && r.error===staleReviewReason) return true;
		return r.state==="observed" && (r.observation?.ownerInput && !r.decision ||
			checkpointWake(run,history.filter(h=>h.squad===r.squad),p.commit,r.version));
	});
	if (pending && descendsFrom(cwd,target,p.target)) return p;
}

/** @param {string} cwd @param {Run} run @param {()=>string} tip @param {boolean} [retry] */
export function releaseAssessment(cwd, run, tip, retry = false) {
	const wait = /** @type {const} */ ({ action: "wait", admission: "closed" });
	const elapsed=expired(run);
	if (elapsed && !timelyChecks(run)) return { ...wait, reason: "deadline" };
	const { target, error } = observeTarget(tip);
	if (target === undefined) return { ...wait, reason: "target-unavailable", error };
	if (run.independent) return {...wait,target,reason:"ownership-conflict",error:
		`Non-release checkpoint ${run.independent.product}; ownership remains held at ${run.independent.checkpoint} by failed observer ${run.independent.observer}.`+
		(target===run.independent.target?"":` Approved target ${run.independent.target} is not current (${target}); no check can advance on this target.`)};
	if (run.active) {
		const conflict=partitionConflict(run,undefined,target);
		const survey=!elapsed && !conflict ? movingSurvey(cwd,run,target) : undefined;
		const scoped=survey && transition(releaseFacts(run,survey.target)).admission;
		const frozen=survey && {target,workTarget:survey.target,action:/** @type {const} */("wait"),
			admission:scoped==="checkpoint" || scoped==="repaired-checkpoint" ? /** @type {const} */("checkpoint") : wait.admission};
		try { verifyContracts(cwd, run.policy, target); }
		catch (error) {
			if (!(error instanceof FoundryError) || error.code !== "contract_changed") throw error;
			return { ...wait, target, ...frozen, reason: "contract-changed", error: error.message };
		}
		if (frozen) return scoped==="repaired-checkpoint" && Object.values(run.nodes).some(n=>n.state==="published")
			? /** @type {const} */ ({target,action:"rejoin",admission:"join-only",reason:"target-changed"})
			: {...frozen,reason:"checkpoint-work"};
		if (conflict) {
			const normal=admissionPolicy(transition(releaseFacts(run,target),false).admission);
			const repair=run.goal?.target===target && !run.join && !run.blocker && !run.conflict && !run.effects.some(e=>e.permissionHold) &&
				normal.writers==="eligible" && Object.values(run.nodes).some(n=>heldRepair(run,n));
			return /** @type {const} */ ({...wait,target,reason:"ownership-conflict",error:conflict,
				admission:!repair ? "closed" : normal.scoped ? "ownership-checkpoint-repairs" : "ownership-repairs"});
		}
	}
	const decision=transition(releaseFacts(run, target), retry);
	return elapsed && decision.action!=="qualify" && decision.reason!=="qualified" ? {...wait,target,reason:"deadline"} : {target,...decision};
}

/** @typedef {{cwd:string,run:Run,actor:string,target:string,at:NonNullable<Run["goal"]>,last?:import("./model.js").Product}} ReleaseContext */
/** @type {Record<import("./engine.mjs").Action,(c:ReleaseContext)=>void>} */
const releaseActions={
	assess({cwd,run,actor,at,last}) {
		delete run.blocker;
		assess(cwd, run, actor, last?.target ?? at.target, last?.commit ?? at.commit);
	},
	retry({cwd,run,actor,target,at}) {
		if (!milestoneBlocker(run)) delete run.join;
		assess(cwd, run, actor, target, at.commit);
	},
	undecided({run}) {
		const receipt = goalReceipt(run);
		if (receipt) run.blocker = undecided(receipt);
	},
	"assess-target"({cwd,run,actor,target}) {
		delete run.join;
		assess(cwd, run, actor, target, retain(cwd, target));
	},
	rejoin({at}) {delete at.stall;},
	qualify({run,actor,last}) {
		if (!last) throw Error("Missing checked product for qualification");
		qualify(run, actor, last);
		activate(run,"goal-met");
		for (const r of reviews(run).filter(reading)) blockReview(r, "Goal met; no further review is needed");
	},
	baseline({cwd,run,actor,target,at}) {reserveProduct(run,actor,cwd,target,at.commit,{});},
	none() {}, wait() {},
};
const applyRelease=implement(release,releaseActions);

/** @param {string} cwd @param {Run} run @param {string} actor @param {()=>string} tip @param {boolean} retry */
export function applyGoal(cwd, run, actor, tip, retry) {
	const decision = releaseAssessment(cwd, run, tip, retry);
	if ("error" in decision) {
		if (!("workTarget" in decision) && decision.reason!=="target-unavailable" && decision.reason!=="ownership-conflict") run.conflict = decision.error;
	} else if (decision.target!==undefined && run.goal) {
		applyRelease(decision.action,{cwd,run,actor,target:decision.target,at:run.goal,last:run.products.at(-1)});
	}
	return decision;
}

/** A new assignment or report is not progress if it reproduces an already assessed tree.
 * @param {string} cwd @param {Run} run @param {string} target @param {string} commit @param {Record<string,string>} outputs */
export function rejectRepeat(cwd, run, target, commit, outputs) {
	if (run.goal?.target !== target) return;
	const receipt = run.effects.find(e => e.kind === "goal" && currentEvaluation(run,e) && e.check === run.policy.goalCheck && checkReceipt(e)?.exit === 1 &&
		(e.commit === commit || e.commit === target && treeOf(cwd, commit) === treeOf(cwd, target)))?.receipt;
	if (!receipt) return;
	const tried = new Set(run.goal.tried);
	for (const id of Object.keys(outputs)) {
		const n = run.nodes[id];
		if (n.state !== "published") continue;
		if (n.grain.task) tried.add(workKey(n.grain, text(n.base, "producer base"), n.inputs));
		assign(n,"repeat");
	}
	if (tried.size) run.goal.tried = [...tried];
	return receipt;
}

/** @param {Run} run @param {string} why @param {import("./model.js").Receipt} receipt */
export function stall(run, why, receipt) {
	if (!run.goal) return;
	const decisions = reviews(run).filter(r => r.base === run.goal?.commit).map(r =>
		`${r.squad}: ${r.error ?? r.observation?.reason}`);
	const blocked = Object.entries(run.nodes).filter(([, n]) => n.state === "blocked").map(([id, n]) => `${id}: ${n.reason}`);
	run.goal.stall = [`Goal unmet at ${receipt.commit}: ${receipt.output.trim() || `${receipt.check} exited 1`}.`, why, ...decisions, ...blocked].join("\n");
}

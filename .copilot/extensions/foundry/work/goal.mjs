import { admissionPolicy } from "./admission.mjs";
import { checkReceipt, currentEvaluation, goalReceipt, milestoneBlocker, productPin } from "./evidence.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { transition, unhandled } from "./engine.mjs";
import { releaseFacts, undecided } from "./facts.mjs";
import { expired, reserveCheck, reserveNotice, reserveProduct } from "./native.mjs";
import { workKey } from "./plan.mjs";
import { partitionConflict } from "./partition.mjs";
import { retain, treeOf, verifyContracts } from "./product.mjs";
import { blockReview, reading, reviews } from "./reviews.mjs";
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
		try { verifyContracts(cwd, run.policy, target); }
		catch (error) {
			if (!(error instanceof FoundryError) || error.code !== "contract_changed") throw error;
			return { ...wait, target, reason: "contract-changed", error: error.message };
		}
		if (conflict) {
			const normal=admissionPolicy(transition(releaseFacts(run,target),false).admission);
			const repair=run.goal?.target===target && !run.join && !run.blocker && !run.conflict && !run.effects.some(e=>e.permissionHold) &&
				Object.values(run.nodes).some(n=>n.state==="waiting" && n.worker && n.check) && normal.writers==="eligible";
			return /** @type {const} */ ({...wait,target,reason:"ownership-conflict",error:conflict,
				admission:!repair ? "closed" : normal.scoped ? "bound-checkpoint-repairs" : "bound-repairs"});
		}
	}
	const decision=transition(releaseFacts(run, target), retry);
	return elapsed && decision.action!=="qualify" && decision.reason!=="qualified" ? {...wait,target,reason:"deadline"} : {target,...decision};
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {()=>string} tip @param {boolean} retry */
export function applyGoal(cwd, run, actor, tip, retry) {
	const decision = releaseAssessment(cwd, run, tip, retry);
	if ("error" in decision) {
		if (decision.reason!=="target-unavailable" && decision.reason!=="ownership-conflict") run.conflict = decision.error;
		return decision.admission;
	}
	if (!("target" in decision)) return decision.admission;
	const { action, admission, target } = decision;
	const at = run.goal, last = run.products.at(-1);
	if (!at) return admission;
	switch (action) {
	case "assess":
		delete run.blocker;
		assess(cwd, run, actor, last?.target ?? at.target, last?.commit ?? at.commit);
		break;
	case "retry":
		if (!milestoneBlocker(run)) delete run.join;
		assess(cwd, run, actor, target, at.commit);
		break;
	case "undecided": {
		const receipt = goalReceipt(run);
		if (receipt) run.blocker = undecided(receipt);
		break;
	}
	case "assess-target":
		delete run.join;
		assess(cwd, run, actor, target, retain(cwd, target));
		break;
	case "rejoin":
		delete at.stall;
		break;
	case "qualify":
		if (!last) throw Error("Missing checked product for qualification");
		qualify(run, actor, last);
		run.active = false;
		for (const r of reviews(run).filter(reading)) blockReview(r, "Goal met; no further review is needed");
		break;
	case "baseline":
		reserveProduct(run, actor, cwd, target, at.commit, {});
		break;
	case "none":
	case "wait":
		break;
	default: return unhandled(action);
	}
	return admission;
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
		n.state = "repeated";
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

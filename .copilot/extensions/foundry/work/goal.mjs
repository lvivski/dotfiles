import { checkReceipt, goalReceipt, milestoneBlocker } from "./evidence.mjs";
import { transition, unhandled } from "./engine.mjs";
import { releaseFacts, undecided } from "./facts.mjs";
import { expired, reserveCheck, reserveNotice, reserveProduct } from "./native.mjs";
import { workKey } from "./plan.mjs";
import { retain, treeOf, verifyContracts } from "./product.mjs";
import { blockReview, reading, reviews } from "./reviews.mjs";
import { FoundryError, text } from "./values.mjs";

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
	reserveNotice(run, actor, product.check, "handoff",
		`Foundry ${run.id} qualified ${product.commit}. The target was not changed. Read foundry_status({run:"${run.id}"}) for the checked product and its receipts.`);
}

/** Shared, read-only preflight. Re-evaluate the current tip, not yesterday's persisted conflict.
 * @param {string} cwd @param {Run} run @param {()=>string} tip @param {boolean} [retry] */
export function releaseAssessment(cwd, run, tip, retry = false) {
	const wait = /** @type {const} */ ({ action: "wait", admission: "closed" });
	if (expired(run)) return { ...wait, reason: "deadline" };
	let target;
	try { target = tip(); }
	catch (error) {
		if (!(error instanceof Error && "status" in error)) throw error;
		return { ...wait, reason: "target-unavailable", error: error.message };
	}
	if (run.active) {
		try { verifyContracts(cwd, run.policy, target); }
		catch (error) {
			if (!(error instanceof FoundryError) || error.code !== "contract_changed") throw error;
			return { ...wait, target, reason: "contract-changed", error: error.message };
		}
	}
	return { target, ...transition(releaseFacts(run, target), retry) };
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {()=>string} tip @param {boolean} retry */
export function applyGoal(cwd, run, actor, tip, retry) {
	const decision = releaseAssessment(cwd, run, tip, retry);
	if ("error" in decision) { run.conflict = decision.error; return decision.admission; }
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
	const receipt = run.effects.find(e => e.kind === "goal" && e.evaluatorRevision === run.repins?.at(-1)?.revision && e.check === run.policy.goalCheck && checkReceipt(e)?.exit === 1 &&
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

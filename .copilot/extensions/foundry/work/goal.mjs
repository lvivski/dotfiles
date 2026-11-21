import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { reserveCheck, reserveNotice, reserveProduct } from "./native.mjs";
import { workKey } from "./plan.mjs";
import { retain, treeOf, verifyContracts } from "./product.mjs";
import { blockReview, reading, reviews } from "./reviews.mjs";
import { text } from "./values.mjs";

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
		`Foundry ${run.id} qualified ${product.commit}. The target was not changed. Read foundry_status({run:"${run.id}"}) for the checked product and named writer handoff. Archive is separate and opt-in; do not archive on this notice.`);
}

/** Gate graph admission on the exact baseline or latest checkpoint, never on a worker's report.
 * @param {string} cwd @param {Run} run @param {string} actor @param {string} target @param {boolean} retry */
export function goalAllowsWork(cwd, run, actor, target, retry) {
	const at = run.goal;
	if (!at) return true;
	verifyContracts(cwd, run.policy, target);
	const last = run.products.at(-1);
	if (last && at.commit !== last.commit) {
		assess(cwd, run, actor, last.target, last.commit);
		return false;
	}
	const receipt = goalReceipt(run);
	if (!receipt) return false;
	// A later scout can still add missing work to a failed milestone. Its exact failed
	// candidate stays pinned so the same native refusal or failure cannot be retried.
	if (run.blocker) return !!run.join && receipt.exit === 1;
	if (receipt.exit === 2) {
		if (!retry && !run.join) return false;
		if (at.target === target) {
			delete run.join;
			assess(cwd, run, actor, target, at.commit);
			return false;
		}
		// A confirmed retry on a moved target goes through the normal rejoin below.
	} else if (receipt.exit !== 0 && receipt.exit !== 1) {
		run.blocker = `Final goal check could not decide at ${at.commit} (exit ${receipt.exit ?? "unknown"}): ${receipt.output || "no diagnostic"}`;
		return false;
	}
	if (at.target !== target) {
		delete at.stall;
		if (!last && !Object.values(run.nodes).some(n => n.state !== "idle") && !reviews(run).some(reading)) {
			delete run.join; // A baseline milestone reserved on the old tip cannot attest to the new one.
			assess(cwd, run, actor, target, retain(cwd, target));
			return false;
		}
		return true; // Incorporate the new target and recheck before accepting.
	}
	if (at.stall) return false;
	if (receipt.exit === 1) return true;
	if (last) {
		qualify(run, actor, last);
		run.active = false;
		delete run.capacity?.offer;
		for (const r of reviews(run).filter(reading)) blockReview(r, "Goal met; no further review is needed");
	} else if (!run.join) {
		// The baseline already satisfies the goal. Check its milestone invariants without hiring a writer.
		reserveProduct(run, actor, cwd, target, at.commit, {});
	}
	return false;
}

/** A new assignment or report is not progress if it reproduces an already assessed tree.
 * @param {string} cwd @param {Run} run @param {string} target @param {string} commit @param {Record<string,string>} outputs */
export function rejectRepeat(cwd, run, target, commit, outputs) {
	if (run.goal?.target !== target) return;
	const receipt = run.effects.find(e => e.kind === "goal" && e.check === run.policy.goalCheck && checkReceipt(e)?.exit === 1 &&
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

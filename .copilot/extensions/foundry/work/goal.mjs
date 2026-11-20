import { checkEffect } from "./native.mjs";
import { retain, treeOf, verifyContracts } from "./product.mjs";
import { text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} cwd @param {Run} run @param {string} actor @param {string} target @param {string} commit */
export function assess(cwd, run, actor, target, commit) {
	verifyContracts(cwd, run.policy, target);
	const e = checkEffect(run, actor, cwd, commit, text(run.policy.goalCheck, "goal evaluator"));
	run.goal = { target, commit, check: e.id };
	run.effects.push(e);
}

/** @param {Run} run */
export function goalReceipt(run) {
	const at = run.goal;
	const e = at && run.effects.find(e => e.id === at.check);
	if (e?.kind === "goal" && e.state === "done" && e.runnerStarted && e.commit === at?.commit &&
		e.check === run.policy.goalCheck && e.receipt?.commit === e.commit && e.receipt?.check === e.check)
		return e.receipt;
}

/** @param {Run} run */
export function missingObservation(run) {
	const receipt = goalReceipt(run);
	if (!run.blocker && !run.join && receipt?.exit === 2) return receipt;
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
	if (!receipt || run.blocker) return false;
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
		if (!last && !Object.keys(run.nodes).length && !run.reviews.some(r => r.state === "reading")) {
			delete run.join; // A baseline milestone reserved on the old tip cannot attest to the new one.
			assess(cwd, run, actor, target, retain(cwd, target));
			return false;
		}
		return true; // Incorporate the new target and recheck before accepting.
	}
	if (at.stall) return false;
	if (receipt.exit === 1) return true;
	if (last) {
		run.accepted = at.commit;
		run.active = false;
		delete run.capacity.offer;
	} else if (!run.join) {
		// The baseline already satisfies the goal. Check its milestone invariants without hiring a writer.
		const e = checkEffect(run, actor, cwd, at.commit, run.policy.productCheck);
		run.join = { target, commit: at.commit, check: e.id, outputs: {} };
		run.effects.push(e);
	}
	return false;
}

/** Joined commits on one target are deterministic. The initial probe checks the target commit itself.
 * @param {string} cwd @param {Run} run @param {string} target @param {string} commit */
export function repeatedGoal(cwd, run, target, commit) {
	return run.effects.find(e => e.kind === "goal" && e.state === "done" && e.receipt?.exit === 1 &&
		(e.commit === commit || e.commit === target && treeOf(cwd, commit) === treeOf(cwd, target)))?.receipt;
}

/** @param {Run} run @param {string} why @param {import("./model.js").Receipt} receipt */
export function stall(run, why, receipt) {
	if (!run.goal) return;
	const decisions = run.reviews.filter(r => r.base === run.goal?.commit).map(r =>
		`${r.squad}: ${r.observation?.reason ?? r.reason}`);
	const blocked = Object.entries(run.nodes).filter(([, n]) => n.state === "blocked").map(([id, n]) => `${id}: ${n.reason}`);
	run.goal.stall = [`Goal unmet at ${receipt.commit}: ${receipt.output.trim() || `${receipt.check} exited 1`}.`, why, ...decisions, ...blocked].join("\n");
}

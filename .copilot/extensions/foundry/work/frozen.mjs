import { checkpointReceipt, goalReceipt } from "./evidence.mjs";
import { partitionConflict } from "./partition.mjs";
import { contractConflict, descendsFrom, verifyContracts } from "./product.mjs";

/** A frozen repair or observation, never authority to integrate into the changed target.
 * @param {string} cwd @param {import("./model.js").Run} run @param {string} tip */
export function frozenCheckpoint(cwd,run,tip) {
	const p=run.products.at(-1), goal=run.goal;
	if (!p || p.qualifiedAt || !goal || goal.target!==p.target || goal.commit!==p.commit || run.join || run.independent || run.blocker ||
		run.effects.some(e=>e.permissionHold) || !checkpointReceipt(run,p.check,p.commit) || ![1,2].includes(goalReceipt(run)?.exit ?? -1) ||
		partitionConflict(run,undefined,p.target) || !descendsFrom(cwd,tip,p.target) ||
		run.conflict && (tip===p.target || run.conflict!==contractConflict(cwd,run.policy,tip))) return;
	verifyContracts(cwd,run.policy,p.commit);
	return p;
}

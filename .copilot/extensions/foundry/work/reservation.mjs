import { milestoneBlocker, qualifiedProduct } from "./evidence.mjs";
import { partitionConflict } from "./partition.mjs";
import { validIsolation } from "./isolation.mjs";

/** @param {import("./model.js").Effect} e */
export const unissued = e => e.state === "ready" || e.state === "ordinary";
/** @param {import("./model.js").Effect} e */
export const awaitingReply = e => e.state === "issued" || e.state === "uncertain" || e.state === "suspended";

/** Is this still the named check? Issuing a call and claiming a runner each have additional gates.
 * @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e */
export function currentCheck(run, e) {
	if (e.tool !== "bash" || e.state === "retired" || e.state === "withdrawn") return false;
	if (e.kind === "component") {
		const n = e.grain && run.nodes[e.grain];
		return !!n && n.state === "checking" && n.check === e.id;
	}
	if (e.kind !== "goal" && e.kind !== "product") return false;
	if (run.conflict && e.state === "ready" || run.blocker) return false;
	if (run.independent) return !!e.isolation && validIsolation(run) && !run.conflict &&
		(e.kind==="product" ? run.join?.check===e.id && !milestoneBlocker(run) : run.independent.assessment===e.id);
	if (unissued(e) && partitionConflict(run, e.kind === "product" ? run.join?.outputs : undefined)) return false;
	return e.kind === "goal" ? !qualifiedProduct(run) && run.goal?.check === e.id :
		run.join?.check === e.id && !milestoneBlocker(run);
}

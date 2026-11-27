import { milestoneBlocker, qualifiedProduct } from "./evidence.mjs";
import { partitionConflict } from "./partition.mjs";
import { validIsolation } from "./isolation.mjs";
import { currentRemedy } from "./remedy.mjs";
import { currentReplacement } from "./replacement.mjs";
import { currentRollout, pendingSuccessor, rolloutChecks, rolloutOffer } from "./campaign.mjs";
import { activeDelivery } from "./batch.mjs";
import { accepts } from "./dispatch.mjs";
import { currentControl } from "./calibration.mjs";

/** @param {import("./model.js").Effect} e */
export const unissued = e => accepts(e,"issue");
/** @param {import("./model.js").Effect} e */
export const awaitingReply = e => accepts(e,"unconfirmed");

/** Is this still the named check? Issuing a call and claiming a runner each have additional gates.
 * @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e */
export function currentCheck(run, e) {
	if (e.tool !== "bash" || e.lane || e.state === "retired" || e.state === "withdrawn") return false;
	if(e.kind==="control")return currentControl(run,e) && (unissued(e) || awaitingReply(e));
	const delivery=activeDelivery(run);
	if (delivery || e.delivery) return !!delivery && e.delivery===delivery.id && (unissued(e) || awaitingReply(e));
	if (e.kind === "rerun") return !!e.rerun && (unissued(e) || awaitingReply(e)) && !run.independent;
	if (e.kind === "component") {
		if(e.rollout){
			const a=rolloutOffer(run,e);
			if(!a || !currentRollout(run,e) || unissued(e) && pendingSuccessor(run,a))return false;
			const batch=rolloutChecks(run,a),i=batch.indexOf(e);
			return i>=0 && batch.slice(0,i).every(c=>c.state==="done" && !!c.runnerClaim && c.receipt?.exit===0);
		}
		if(e.replacement)return currentReplacement(run,e);
		if (e.remedy) return currentRemedy(run,e);
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

import { activeDelivery } from "./batch.mjs";
import { pendingSuccessor, rolloutSlots } from "./campaign.mjs";
import { currentControl } from "./calibration.mjs";
import { awaitingReply, unissued } from "./dispatch.mjs";
import { checkReceipt, milestoneBlocker, productPin, qualifiedProduct } from "./evidence.mjs";
import { validIsolation } from "./isolation.mjs";
import { partitionConflict } from "./partition.mjs";
import { currentChange } from "./replacement.mjs";
export { currentChange } from "./replacement.mjs";
import { currentRemedy } from "./remedy.mjs";
import { currentDeclaration } from "./requirements.mjs";
import { sourceAt } from "./description.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */

/** Historical eligibility is evidence for the original slot. No historical check may execute.
 * @param {Run} run @param {Check} e */
export function currentCheck(run,e){
	if(e.attempt?.version===3)return currentDeclaration(run,e,sourceAt(run,e));
	if(e.tool!=="bash" || e.lane || e.state==="retired" || e.state==="withdrawn")return false;
	const pending=()=>unissued(e) || awaitingReply(e);
	if(e.kind==="control")return currentControl(run,e) && pending();
	const delivery=activeDelivery(run);
	if(delivery || e.delivery)return !!delivery && delivery.id===e.delivery && pending();
	if(e.kind==="rerun")return !!e.rerun && pending() && !run.independent;
	if(e.kind==="component"){
		if(e.rollout || e.replacement){
			const change=currentChange(run,e);
			if(!change)return false;
			if(!(change.rollout?.harness??productPin(run)))return false;
			if(change.rollout){
				const {checks}=rolloutSlots(run,change),i=checks.indexOf(e);
				if(i<0 || unissued(e) && pendingSuccessor(run,change) ||
					!checks.slice(0,i).every(c=>c.runnerClaim && checkReceipt(c)?.exit===0))return false;
			}
			return true;
		}
		if(e.remedy)return currentRemedy(run,e);
		const n=e.grain && run.nodes[e.grain];
		return !!n && n.state==="checking" && n.check===e.id;
	}
	if(e.kind!=="goal" && e.kind!=="product" || run.conflict && e.state==="ready" || run.blocker)return false;
	if(run.independent)return !!e.isolation && validIsolation(run) && !run.conflict &&
		(e.kind==="product"?run.join?.check===e.id && !milestoneBlocker(run):run.independent.assessment===e.id);
	if(unissued(e) && partitionConflict(run,e.kind==="product"?run.join?.outputs:undefined))return false;
	return e.kind==="goal"?!qualifiedProduct(run) && run.goal?.check===e.id:run.join?.check===e.id && !milestoneBlocker(run);
}

import { checkReceipt } from "./receipt.mjs";
import { effectAt, revisionLookup } from "./revision.mjs";
import { fail } from "./values.mjs";

/** A pending, unbound, unavailable or permission-held review is neither approval nor a confirmed code defect.
 * @param {import("./model.js").Inspection|undefined} i */
export const publicationVerdict=i=>i?.dispatch && i.workflow && i.summary && !i.permissionHold && (i.state==="approved" || i.state==="changes") ? i.state : undefined;

const approvalIndex=revisionLookup(run=>new Map(run.inspections?.map(i=>[i.component,i])));
/** Resolve evidence for exactly one component. The scope owner must still authorize its use; the store verifies its signature.
 * A pre-journal reference is deliberately not returned here. Only its original corroboration path can use it.
 * @param {import("./model.js").Run} run @param {string|undefined} component @param {string} grain @param {string|undefined} candidate */
export function publishedComponent(run,component,grain,candidate) {
	const c=effectAt(run,component);
	if(!c || !candidate || c.kind!=="component" || !c.callId || !c.runnerClaim || c.grain!==grain || c.commit!==candidate)return;
	const receipt=checkReceipt(c);
	if(receipt?.exit!==0 || receipt.failure)return;
	const review=Object.isFrozen(run)?approvalIndex(run).get(c.id):run.inspections?.find(i=>i.component===c.id);
	if(run.inspections!==undefined && (!review || publicationVerdict(review)!=="approved" || review.grain!==grain ||
		review.candidate!==candidate || review.issuer!==run.owner && review.issuer!==c.issuer))return;
	return {component:c,receipt,review};
}

/** A signed checkpoint can carry its own unchanged pre-journal input forward. It does not make that old component signed.
 * @param {import("./model.js").Run} run @param {import("./model.js").Product|undefined} product
 * @param {import("./model.js").Effect|undefined} old @param {string} grain @param {string} candidate */
export function carriedInput(run,product,old,grain,candidate){
	if(run.inspections!==undefined || !product || product.outputs[grain]!==candidate || old?.kind!=="component" || old.runnerClaim ||
		!old.callId || old.error || old.grain!==grain || old.commit!==candidate || checkReceipt(old)?.exit!==0)return false;
	const checkpoint=run.effects.find(c=>c.id===product.check);
	return run.products.includes(product) && checkpoint?.kind==="product" && !!checkpoint.runnerClaim && checkpoint.commit===product.commit &&
		checkpoint.check===run.policy.productCheck && checkReceipt(checkpoint)?.exit===0 && run.effects.indexOf(old)<run.effects.indexOf(checkpoint);
}

/** Build every binding before exposing any of them. The supplying power alone decides the
 * allowed ownership/rebinding change; it cannot substitute another observation or grant.
 * @param {import("./model.js").Run} run @param {import("./model.js").NativeCall[]} checks
 * @param {(n:import("./model.js").Node,c:import("./model.js").NativeCall)=>import("./model.js").Node} binding */
export function publishedNodes(run,checks,binding){
	const nodes={...run.nodes},seen=new Set();
	for(const c of checks){
		const id=c.grain;
		if(!id || seen.has(id) || !nodes[id] || !publishedComponent(run,c.id,id,c.commit))fail("unreviewed_output","Missing exact, reviewed component in batch");
		seen.add(id);
		const next=binding(nodes[id],c);
		if(next.grain.id!==id)fail("ownership_transition","Cannot publish another owner's binding");
		nodes[id]={...next,candidate:c.commit,check:c.id};
	}
	return nodes;
}

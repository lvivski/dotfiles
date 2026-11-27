import { checkReceipt } from "./receipt.mjs";
import { effectAt, inspectionAt } from "./revision.mjs";
import { digest, fail } from "./values.mjs";

/** A pending, unbound or unavailable review is not an observed verdict.
 * @param {import("./model.js").Inspection|undefined} i */
const observedReview=i=>i?.dispatch && i.workflow && i.summary && (i.state==="approved" || i.state==="changes") ? i.state : undefined;
/** @param {import("./model.js").Inspection|undefined} i */
export const publicationVerdict=i=>i?.permissionHold?undefined:observedReview(i);

/** A signed component observation can open review; it cannot by itself publish the bytes.
 * @param {import("./model.js").Effect|undefined} c @param {string|undefined} grain @param {string|undefined} candidate */
export function observedComponent(c,grain,candidate){
	if(c?.kind!=="component" || !grain || c.grain!==grain || !candidate || c.commit!==candidate || !c.callId || !c.runnerClaim)return;
	const receipt=checkReceipt(c);
	if(receipt?.exit===0 && !receipt.failure)return {component:c,receipt};
}
/** Resolve the signed component and its applicable decision. A finding belongs to this
 * candidate just as an approval does; neither may be borrowed from another issuer or grant.
 * @param {import("./model.js").Run} run @param {string|undefined} component @param {string} grain @param {string|undefined} candidate */
function componentRecord(run,component,grain,candidate) {
	const observed=observedComponent(effectAt(run,component),grain,candidate);
	if(!observed)return;
	const review=inspectionAt(run,component);
	if(run.inspections!==undefined && (!review || review.grain!==grain || review.candidate!==candidate ||
		review.issuer!==run.owner && review.issuer!==observed.component.issuer))return;
	return {...observed,review};
}

/** Read what a writer actually received at dispatch. A stricter rule for a new
 * publication or proof cannot invalidate this historical input reference.
 * @param {import("./model.js").Run} run @param {string} grain
 * @param {NonNullable<import("./model.js").NativeCall["writing"]>["inputs"][string]} pin */
export function grantedComponent(run,grain,pin){
	const record=componentRecord(run,pin.component,grain,pin.revision);
	if(!record || (record.review?.id??null)!==pin.review)return;
	if(record.review?observedReview(record.review)==="approved":run.inspections===undefined && !!run.historicalPrefix?.length)return record.component;
}

/** Judge a new use, not the continuing validity of the original observation.
 * @param {import("./model.js").Run} run @param {string|undefined} component @param {string} grain @param {string|undefined} candidate */
export function componentDecision(run,component,grain,candidate) {
	const observed=componentRecord(run,component,grain,candidate);if(!observed)return;
	const {review}=observed;
	const verdict=review?publicationVerdict(review):"approved";
	if(verdict)return {...observed,verdict};
}
/** A consumer needs a publication, not just a completed review. Pre-journal inputs have
 * only their separate historical corroboration path. @param {import("./model.js").Run} run
 * @param {string|undefined} component @param {string} grain @param {string|undefined} candidate */
export function publishedComponent(run,component,grain,candidate){
	const result=componentDecision(run,component,grain,candidate);
	if(result?.verdict==="approved")return result;
}

/** @param {Pick<import("./model.js").Inspection,"issuer"|"base"|"generation"|"scope"|"task"|"specification">} i */
export const reviewSubject=i=>digest([i.issuer,i.base,i.generation,i.scope,i.task,i.specification??null]);
/** A future review ID is not known at reservation. Its exact subject and
 * producer are known; only a bound, eligible approval can satisfy the edge.
 * @param {import("./model.js").Run} run @param {Extract<import("./model.js").Requirement,{kind:"publication"}>} f */
export function hasPublication(run,f){
	const c=effectAt(run,f.component),p=c?.kind==="component" && c.grain && publishedComponent(run,c.id,c.grain,c.commit);
	return !!p && !!p.review && reviewSubject(p.review)===f.subject;
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

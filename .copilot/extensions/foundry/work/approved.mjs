import { approvalId, currentOrder, memberDeclaration, occupiedMember, seriesEvidence, terms } from "./series.mjs";
import { effectAt } from "./revision.mjs";
import { fail } from "./values.mjs";
import { sameRecipe } from "./consent.mjs";
export { approvalId } from "./series.mjs";
export { offerId } from "./consent.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").Adoption} Approval */
/** Translate only the historical reservation positions, not the old executor.
 * @param {Run} run @param {Approval} a */
export function approvedOrder(run,a){
	if(a.accepted)return currentOrder(run,a);
	const pins=terms(run,a);if(!pins)return;
	const {ids}=pins,end=run.historicalPrefix?.length??0;
	const originals=run.effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && e.rollout===a.id);
	if(originals.length!==ids.length || originals.some((e,i)=>run.effects.indexOf(e)>=end || e.attempt?.version!==2 || e.attempt.previous || e.grain!==ids[i] ||
		e.issuer!==run.owner || e.commit!==a.assembly || e.check!==run.nodes[ids[i]]?.grain.check || !e.verification))return;
	const checks=[...originals],positions=new Map(originals.map((c,i)=>[c.id,i]));
	for(const e of run.effects)if(e.kind==="component" && e.attempt?.version===3){
		const i=e.attempt.previous===undefined?undefined:positions.get(e.attempt.previous);
		if(i===undefined && approvalId(e)!==a.id)continue;
		if(i===undefined || approvalId(e)!==a.id || checks[i]!==originals[i] || e.grain!==ids[i] ||
			e.issuer!==run.owner || e.commit!==a.assembly || e.check!==originals[i].check || run.effects.indexOf(e)<=run.effects.indexOf(originals[i]))return;
		checks[i]=e;
	}
	return {...pins,originals,checks};
}
/** @param {Run} run @param {Check} e @param {string} [cwd] */
export function approvalEvidence(run,e,cwd){
	const id=approvalId(e),a=id && run.adoptions?.find(a=>a.id===id);
	if(!a || a.accepted)return;
	const proof=seriesEvidence(run,e,a,approvedOrder(run,a),cwd);
	if(proof?.recipe && e.attempt?.version===3 && e.attempt.previous){
		const c=effectAt(run,e.attempt.previous),prior=c?.tool==="bash" && c.verification,d=proof.recipe;
		if(!prior || !sameRecipe(prior,d))
			fail("invalid_inputs","The new physical inputs differ from the original slot");
	}
	return proof;
}
/** @param {Run} run @param {Check} e @param {Approval} a @param {string} [previous] */
export const declareApproved=(run,e,a,previous)=>memberDeclaration(run,e,a,approvedOrder(run,a),previous);
/** @param {Run} run @param {Check} e @param {Approval} a */
export const activeApproval=(run,e,a)=>occupiedMember(run,e,a,approvedOrder(run,a));

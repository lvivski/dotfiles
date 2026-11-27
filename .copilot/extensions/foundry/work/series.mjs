import { approvalId, signedFact, stoppedMembers } from "./receipt.mjs";
export { approvalId } from "./receipt.mjs";
import { assemblyAt, effectAt, inspectionAt } from "./revision.mjs";
import { covers, digest, fail, within } from "./values.mjs";
import { topology } from "./topology.mjs";
import { approvedRecipe } from "./steps.mjs";
import { approvedInput, correctionRefs, declaration, draftId, offerId, sameDraft } from "./consent.mjs";
import { writerPublication } from "./origin.mjs";
import { recordedFinding, reviewSubject } from "./publication.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").Adoption} Approval */
/** @typedef {import("./model.js").CurrentAttempt} Attempt */
/** @param {string} grain @param {import("./model.js").HarnessRollout} r */
export const memberBasis=(grain,r)=>({base:r.from,generation:r.from,scope:r.owners[grain].scope,
	task:`Review ${grain} on the exact harness rollout ${r.blob} from ${r.followup?.assembly??r.from}.`+
		(r.followup?` Review the cumulative output against ${r.from}; the earlier rollout was not published.`:"")+
		` Preserve all behavior assertions; check the new dependency pins.`});
/** Freeze a different serial order only on a new byte decision whose concrete
 * review edges require it. Never mutate the manifest or an old reservation.
 * @param {Approval} a */
export function scheduleMembers(a){
	const r=a.rollout,accepted=a.accepted;
	if(!r || !accepted?.inputs || accepted.order)fail("invalid_rule","Expected a new accepted member declaration");
	const ids=Object.keys(r.owners),edges=new Map(ids.map(id=>[id,/** @type {string[]} */([])]));
	for(const f of accepted.inputs)if("member" in f){
		const deps=edges.get(f.member);
		if(!deps || !edges.has(f.afterReviewOf) || !Object.hasOwn(r.included[f.member].inputs,f.afterReviewOf))
			fail("invalid_rule","A review dependency must refer to two admitted owners and their granted input");
		deps.push(f.afterReviewOf);
	}
	const order=[...topology(id=>edges.get(id)).validate(ids)];
	if(order.some((id,i)=>id!==ids[i]))accepted.order=order;
}
/** @param {Run} run @param {Approval} a */
export function terms(run,a){
	const r=a.rollout;if(!r || a.id!==offerId(a) || !a.assembly || !a.failed || a.foreground || r.draft && !r.followup || r.followup && !a.accepted || !run.inspections ||
		a.decision?.status!=="answered" || a.decision.answer!==r.blob)return;
	const owners=Object.keys(r.owners),ids=a.accepted?.order??owners,all=Object.keys(r.included);
	if(!Array.isArray(ids) || !ids.length || ids.length!==owners.length || new Set(ids).size!==owners.length ||
		!a.accepted && ids.length!==all.length || !ids.every(id=>Object.hasOwn(r.owners,id) && Object.hasOwn(r.included,id)) || all.some(id=>r.included[id].legacy))return;
	return {ids,all};
}

/** @typedef {{ids:string[],all:string[],originals:Check[],checks:Check[]}} Order */
/** @param {Run} run @param {Approval} a @param {Check} [reserving] @returns {Order|undefined} */
export function currentOrder(run,a,reserving){
	const pins=terms(run,a),accepted=a.accepted,after=accepted && effectAt(run,accepted.after);
	if(!pins || !after || !accepted?.presentation)return;
	if(!Array.isArray(accepted.inputs) || !accepted.inputs.every(approvedInput) ||
		new Set(accepted.inputs.map(pin=>"component" in pin?pin.component:JSON.stringify([pin.member,pin.afterReviewOf]))).size!==accepted.inputs.length ||
		accepted.inputs.some(pin=>"member" in pin && (!pins.ids.includes(pin.afterReviewOf) || pins.ids.indexOf(pin.afterReviewOf)>=pins.ids.indexOf(pin.member) ||
			!Object.hasOwn(a.rollout?.included[pin.member]?.inputs??{},pin.afterReviewOf))))return;
	const cut=run.effects.indexOf(after);
	const checks=run.effects.filter(/** @returns {c is Check} */ c=>c.kind==="component" && (c===reserving || approvalId(c)===a.id));
	if(checks.length>pins.ids.length || checks.some((e,i)=>run.effects.indexOf(e)<=cut || run.effects.indexOf(e)<(run.historicalPrefix?.length??0) ||
		e!==reserving && (e.attempt?.version!==3 || "previous" in e.attempt) || e.grain!==pins.ids[i] || e.commit!==a.assembly ||
		e.issuer!==run.owner || e.check!==run.nodes[pins.ids[i]]?.grain.check))return;
	return {...pins,originals:[],checks};
}
/** @param {Run} run @param {Check} e @param {Approval} a @param {Order|undefined} order @param {string} [cwd] */
export function seriesEvidence(run,e,a,order,cwd){
	if(!order || e.attempt?.version!==3)return;
	const expected=memberDeclaration(run,e,a,order,e.attempt.previous);
	if(expected)return {expected,slot:occupiedMember(run,e,a,order)?e.id:undefined,...(cwd && {recipe:approvedRecipe(cwd,run,e,a)})};
}
/** The default entitlement names the failed owner. An answered scope may name
 * several original owners; none can return bytes for another owner's files.
 * @param {Run} run @param {import("./model.js").CorrectionDraft} d @param {import("./model.js").HarnessRollout} change @param {string} failed */
function ownedContributions(run,d,change,failed){
	if(!d.parts.length || d.automatic && (d.parts.length!==1 || d.parts[0].source.grain!==failed))return false;
	const owners=new Set(),paths=new Set(),dispatches=new Set(),workflows=new Set();
	return d.parts.every(part=>{
		const s=part.source,id=s.grain,owner=id && Object.hasOwn(change.owners,id) && change.owners[id];
		if(s.kind!=="owned" || !id || !owner || owners.has(id) || owner.component!==s.component || owner.output!==s.output ||
			!part.dispatch || dispatches.has(part.dispatch) || !part.workflow || workflows.has(part.workflow) || !part.changes?.length)return false;
		const p=writerPublication(run,owner.component,id,owner.output);
		if(!p?.inspection || p.writer.worker!==s.producer || p.writer.review?.id!==s.grant || digest(p.inspection.scope)!==digest(owner.scope))return false;
		owners.add(id);dispatches.add(part.dispatch);workflows.add(part.workflow);
		for(const f of part.files){
			if(paths.has(f.file) || !within(owner.scope,f.file) || d.automatic && !f.before)return false;
			paths.add(f.file);
		}
		return part.changes.every(c=>part.files.some(f=>f.file===c.file && f.before===c.before && f.mode===c.mode));
	});
}
/** Declared by the approved change, not inferred by the runner. Its stable evidence
 * is reconstructed at the original position; later links never change an earlier subject.
 * Live ownership, permission and target checks are separate from these persisted facts.
 * @param {Run} run @param {Check} e @param {Approval} a @param {Order|undefined} order @param {string} [previous] @returns {Attempt|undefined} */
export function memberDeclaration(run,e,a,order,previous){
	const r=a.rollout,use=e.kind,commit=a.assembly,target=a.revision;
	if(!r || !order || !commit || !a.failed || !e.check || e.commit!==commit || e.issuer!==run.owner ||
		!(use==="component" || use==="product" || use==="goal"))return;
	const {ids,originals,checks}=order,policy=run.policy.base,source=/** @type {const} */({kind:"approval",id:a.id,policy,commit,target});
	/** @type {Attempt["facts"]} */ const facts=[{kind:"approved",id:a.id,bytes:r.blob,manifest:digest([r,ids,order.all,a.decision])},
		{kind:"target",ref:run.policy.target,commit:target},{kind:"clear",issuer:run.owner}];
	const at=run.effects.indexOf(e);
	if(a.accepted)facts.push({kind:"consent",offer:a.id,terms:digest(a.accepted),answer:digest(a.decision?.status==="answered"?a.decision.answer:null)});
	/** @param {string} id @param {"component"|"goal"|"product"} kind @param {string} pin @param {boolean} [passing] */
	function signed(id,kind,pin,passing=true){
		const fact=signedFact(run,at,effectAt(run,id),kind,pin);
		if(!fact || (passing?fact.exit!==0:fact.exit===0))return false;
		facts.push(fact);return true;
	}
	/** @param {Check} c */
	function review(c){
		const i=inspectionAt(run,c.id);
		if(!i || i.component!==c.id || i.grain!==c.grain || i.candidate!==c.commit || i.issuer!==run.owner && i.issuer!==c.issuer ||
			i.state!=="approved" || !i.workflow || !i.dispatch || !i.summary || i.permissionHold)return false;
		facts.push({kind:"review",component:c.id,inspection:i.id,workflow:i.workflow,dispatch:i.dispatch});return true;
	}
	const p=run.productRepins?.find(p=>p.recheck===a.failed && p.checkpoint===a.checkpoint && p.goal===a.goal && p.revision===target && p.targetFrom);
	const base=run.products.find(p=>p.check===a.checkpoint);
	if(!p || !base || !signed(a.checkpoint,"product",base.commit) || !signed(a.goal,"goal",base.commit,false) ||
		!signed(a.failed,"product",r.from,false))return;
	// Earlier unpublished assemblies remain evidence, not checked output pins.
	for(let link=a;link.rollout?.followup;){
		const f=link.rollout.followup,parent=run.adoptions?.find(p=>p.id===f.proposal),stop=effectAt(run,f.check);
		const cut=link.accepted && effectAt(run,link.accepted.after),prior=parent && currentOrder(run,parent);
		if(!run.adoptions || !parent?.accepted || !parent.rollout || !cut || !prior || run.adoptions.indexOf(parent)>=run.adoptions.indexOf(link) ||
			prior.checks.length!==prior.ids.length || !stoppedMembers(prior.checks,f.check,true,f.observation===0) || f.observation===undefined || f.recipe ||
			parent.failed!==a.failed || parent.revision!==target || parent.checkpoint!==a.checkpoint || parent.goal!==a.goal ||
			parent.assembly!==f.assembly || stop?.kind!=="component" || !stop.grain || stop.receipt?.exit!==f.observation ||
			run.effects.indexOf(stop)>run.effects.indexOf(cut) || digest(parent.rollout.included)!==digest(r.included))return;
		const change=link.rollout,ref=correctionRefs(run).find(ref=>ref.draft?.id===change.draft && ref.blob===change.blob && !ref.evaluation &&
			ref.base===target && ref.assembly===f.assembly && f.files.every(p=>p.file.startsWith(".foundry/") || covers(ref.to,p.file)));
		if(!ref)return;
		if(ref.draft){
			const d=ref.draft,subject=prior.checks.find(c=>c.id===d.check);
			if(!subject?.grain || (d.finding ? f.observation!==0 || prior.checks.at(-1)!==stop || !recordedFinding(run,subject,d.finding) :
				f.observation!==1) || d.id!==draftId(d) || !sameDraft(run,d,stop.id,f.assembly,f.files) ||
				d.product!==d.assembly || d.checkpoint!==a.checkpoint || d.goal!==a.goal || !ownedContributions(run,d,change,subject.grain))return;
		}
		for(const c of prior.checks){
			if(!signed(c.id,"component",f.assembly,c!==stop || f.observation===0))return;
			if(c===stop)break;
		}
		link=parent;
	}
	if(use==="component"){
		const i=ids.indexOf(e.grain??""),orig=originals[i],slot=previous && run.history?.[previous];
		if(i<0 || !previous && checks[i]!==e || e.evaluatorRevision || e.productEvaluatorRevision || e.check!==run.nodes[ids[i]]?.grain.check)return;
		if(orig){
			if(!previous || orig.id!==previous || orig.receipt || orig.runnerClaim || !slot || !(slot.closure==="never-issued" || slot.settlement?.kind==="terminal") ||
				e.callId!==undefined && e.callId===orig.callId || run.effects.indexOf(orig)>=at || e.check!==orig.check)return;
		}else if(previous || !a.accepted)return;
		const old=r.owners[ids[i]],owner=effectAt(run,old.component);
		if(owner?.kind!=="component" || owner.grain!==e.grain || !signed(owner.id,"component",old.output) || !review(owner))return;
		if(a.accepted){
			const publication=writerPublication(run,old.component,ids[i],old.output);
			if(!publication?.inspection || digest(publication.inspection.scope)!==digest(old.scope))return;
			for(const pin of a.accepted.inputs??[]){
				if("member" in pin){
					if(pin.member===e.grain){
						const up=checks[ids.indexOf(pin.afterReviewOf)];if(!up || run.effects.indexOf(up)>=at)return;
						facts.push({kind:"publication",component:up.id,subject:reviewSubject({...memberBasis(pin.afterReviewOf,r),issuer:run.owner,specification:r.owners[pin.afterReviewOf].specification})});
					}
					continue;
				}
				const c=effectAt(run,pin.component),id=c?.grain,base=id && r.included[id];
				const output=id && assemblyAt(run,p,a.failed)?.outputs[id];
				const seen=output && id && writerPublication(run,pin.component,id,output);
				if(!base || !seen || !seen.inspection || !output || c?.kind!=="component" || seen.inspection.id!==pin.inspection ||
					digest(base.scope)!==digest(seen.inspection.scope) || run.effects.indexOf(c)>run.effects.findIndex(c=>c.id===a.accepted?.after))return;
				if(c.id!==owner.id && (!signed(c.id,"component",output) || !review(c)))return;
			}
		}
		if(previous && slot)facts.push({kind:"closed-slot",original:previous,request:slot.request,position:i});
		const predecessors=checks.slice(0,i);
		if(predecessors.length!==i || predecessors.some(c=>run.effects.indexOf(c)>=at))return;
		for(const c of predecessors)facts.push({kind:"signed",use:"component",check:c.id,commit,exit:0});
		facts.push({kind:"build-group",group:a.id,prior:predecessors.map(c=>c.id)});
	}else{
		const step=p.amendments?.find(s=>s.proposal===a.id && s.harness===r.harness && s.prior.check===a.failed && s.prior.commit===r.from);
		if(previous || !step || checks.length!==ids.length || run.effects.some(other=>other!==e && other.kind===use && approvalId(other)===a.id) ||
			e.evaluatorRevision!==r.harness || e.check!==(use==="product"?run.policy.productCheck:run.policy.goalCheck) ||
			!checks.every(c=>signed(c.id,"component",commit) && review(c)))return;
		if(use==="product" ? step.recheck!==e.id || e.productEvaluatorRevision!==undefined :
			e.productEvaluatorRevision!==r.harness || !signed(step.recheck,"product",commit))return;
		const joined=effectAt(run,a.failed);
		for(const id of order.all)if(!Object.hasOwn(r.owners,id)){
			const output=step.prior.outputs[id],originals=joined?.tool==="bash" && joined.attempt?.version===3 && joined.attempt.facts.flatMap(f=>{
				if(f.kind!=="review")return [];
				const c=effectAt(run,f.component);return c?.kind==="component" && c.grain===id && c.commit===output?[c]:[];
			});
			const c=originals && originals.length===1 && originals[0],pub=c && writerPublication(run,c.id,id,output);
			if(!c || !pub || !pub.inspection || !signed(c.id,"component",output) || !review(c) ||
				digest(pub.inspection.scope)!==digest(r.included[id].scope))return;
		}
	}
	return {...declaration(run,e,source,use,facts),...(previous && {previous})};
}

/** State checked at issuance, claim, and before external build/evaluation. No other
 * grant on the same bytes can substitute a slot, publication, or evaluator pin.
 * @param {Run} run @param {Check} e @param {Approval} a @param {Order|undefined} order */
export function occupiedMember(run,e,a,order){
	const r=a.rollout,g=e.grain,latest=run.productRepins?.at(-1);
	if(!r || !order || !latest || run.independent || run.conflict || run.blocker || run.policy.contractTarget!==a.revision ||
		latest.revision!==a.revision || latest.checkpoint!==a.checkpoint || latest.goal!==a.goal || latest.recheck!==a.failed ||
		run.adoptions?.some(next=>next.rollout?.followup?.proposal===a.id && (next.decision?.status==="answered" || next.id===run.targetProposal)) ||
		run.testRepairs?.length || run.deliveries?.some(d=>!d.assessment && !d.error))return false;
	if(e.kind==="component"){
		if(!g || run.join?.check!==a.failed || run.join?.commit!==r.from || run.join?.target!==a.revision || run.goal?.check!==a.goal ||
			run.products.at(-1)?.check!==a.checkpoint || latest.amendments?.length || order.checks[order.ids.indexOf(g)]!==e)return false;
		return order.ids.every(id=>run.join?.outputs[id]===r.owners[id].output && digest(run.nodes[id])===r.owners[id].binding);
	}
	const step=latest.amendments?.at(-1),product=e.kind==="product"?run.join:run.products.at(-1);
	if(!step || step.proposal!==a.id || step.harness!==r.harness || run.repins?.at(-1)?.revision!==r.harness || !product ||
		product.target!==a.revision || product.commit!==a.assembly || product.check!==step.recheck ||
		(e.kind==="product"?product.check!==e.id:run.goal?.check!==e.id || run.goal.commit!==e.commit || run.goal.target!==a.revision))return false;
	return order.checks.every((c,i)=>{const id=order.ids[i],n=run.nodes[id];return n?.candidate===a.assembly &&
		product.outputs[id]===a.assembly && n.check===c.id && !n.worker && !n.token && n.replaces===r.owners[id].output;}) &&
		order.all.every(id=>Object.hasOwn(r.owners,id) || run.nodes[id]?.candidate===step.prior.outputs[id] && product.outputs[id]===step.prior.outputs[id] &&
			e.attempt?.version===3 && e.attempt.facts.some(f=>f.kind==="review" && f.component===run.nodes[id]?.check));
}

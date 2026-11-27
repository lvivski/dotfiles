import { checkReceipt, correctionEvaluator, failedComponent, originalVerification, productPin } from "./evidence.mjs";
import { verificationAssembly } from "./migrations.mjs";
import { validReplacement } from "./replacement.mjs";
import { validRollout } from "./campaign.mjs";
import { changesFixedContract } from "./contract.mjs";
import { correctionRefs, draftChanges, matchesDraft } from "./drafts.mjs";
import { contractConflict, outside } from "./product.mjs";
import { grant } from "./transfer.mjs";
import { covers, digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Adoption} Adoption */
/** @typedef {Omit<Adoption,"id"|"basis"|"decision"|"previous">} Subject */

/** Approval identity is the authorized inputs, not the wording or formatting of their presentation.
 * @param {Subject} s */
export const offerId=s=>digest([s.revision,s.checkpoint,s.goal,s.assembly??null,...(s.failed?[s.failed,s.rollout??s.patch??s.message]:[s.evaluator??s.manifest??s.message])]);

/** Bind the actual output grants, not the whole scheduling document or the last actor to write it.
 * @param {Run} run @param {Record<string,string>} outputs @param {string[]} [retained] */
export function checkpointBindings(run,outputs,retained=[]){
	const ids=new Set(Object.keys(outputs));
	if(retained.length){
		const checks=new Set(retained);
		for(const n of Object.values(run.nodes))if(n.check && checks.has(n.check))ids.add(n.grain.id);
	}
	const nodes=[...ids].flatMap(id=>run.nodes[id]?[run.nodes[id]]:[]);
	const checks=new Set(nodes.map(n=>n.check)),approvals=new Map(checks.size?run.inspections?.flatMap(i=>checks.has(i.component)?[[i.component,i]]:[]):[]);
	return digest([run.id,run.owner,run.policy.base,run.policy.contractTarget??null,productPin(run)??null,
		run.repins?.at(-1)?.revision??null,run.products.at(-1)??null,run.goal?.check??null,outputs,
		Object.fromEntries(nodes.map(n=>{const i=n.check && approvals.get(n.check);return [n.grain.id,[n.grain,n.review,n.generation,n.base,n.token,n.worker,
			n.check,n.candidate,n.inputs,n.supporting,grant(n),n.restoration,n.successor,run.inspections ? i && [i.id,i.state] : "pre-review"]];}))]);
}

/** The verifier must also re-evaluate eligibility, including quiescence and competing offers, on the live snapshot.
 * @param {Run} run @param {Subject} s */
export function presentationBasis(run,s){
	const outputs=s.manifest?.outputs??(s.evaluator?.kind==="product"?run.products.at(-1)?.outputs:undefined)??{};
	return "inputs/1:"+digest([offerId(s),run.active,run.join?.check??null,checkpointBindings(run,outputs,s.manifest?.retained)]);
}

/** Reader 95 forms already on display keep their actual binding. Never mint one from a newer edition.
 * @param {string} cwd @param {Run} run @param {Adoption} a */
export function matchesPresentation(cwd,run,a){
	if(a.basis.startsWith("inputs/1:"))return a.basis===presentationBasis(run,a);
	if(a.evaluator)return a.basis===digest([offerId(a),run.owner,run.active,run.policy.base,run.policy.contractTarget??null,
		run.products.at(-1)??null,run.goal?.check??null,run.repins?.at(-1)?.revision??null,productPin(run)??null,run.join?.check??null]);
	const {adoptions,targetProposal,offerHold,conflict,instructions,diagnostics,footprintRequests,...old}=run;
	// The decoder tags historical calls in memory. These tags were never part of the question.
	// A closure or new attempt IS a change to authority and must not be projected away.
	old.effects=old.effects.map(e=>{
		if(e.tool!=="bash" || e.attempt?.version!==1 || e.attempt.closure)return e;
		const {attempt,...original}=e;return original;
	});
	return a.basis===digest(conflict && conflict!==contractConflict(cwd,old.policy,a.revision)?{...old,conflict}:old);
}

/** @param {Run} run */
export function currentOffer(run){
	const a=run.adoptions?.at(-1);
	if(a && a.id===run.targetProposal && a.checkpoint===run.products.at(-1)?.check && a.goal===run.goal?.check &&
		!a.rollout?.followup?.recipe &&
		!(a.rollout && (changesFixedContract(run,a.rollout.files) || a.rollout.followup && changesFixedContract(run,a.rollout.followup.files))) &&
		(a.evaluator ? a.revision===run.goal?.target : a.failed ? a.revision===run.policy.contractTarget && a.failed===run.join?.check : a.revision!==run.policy.contractTarget))return a;
}

/** @param {Run} run */
export function pendingAdoption(run) {
	const a=currentOffer(run);
	return run.active && a?.assembly && !a.decision ? a : undefined;
}

/** @param {Run} run @param {Adoption} selected */
export function rememberOffer(run,selected){
	const offers=run.adoptions??=[], existing=offers.find(a=>a.id===selected.id);
	run.targetProposal=selected.id;
	if(!existing){offers.push(selected);return selected;}
	existing.basis=selected.basis;
	if(!existing.decision)existing.message=selected.message;
	if(existing!==offers.at(-1)){offers.splice(offers.indexOf(existing),1);offers.push(existing);}
	return existing;
}

/** A stored question is not an approval. An answered question must link to the exact adopted assembly and evaluator change.
 * @param {Run} run @param {Map<string,import("./model.js").Product>} products @param {Map<string,import("./model.js").Effect>} effects */
export function validOffers(run,products,effects){
	const offers=run.adoptions??[];
	if(run.targetProposal && run.targetProposal!==offers.at(-1)?.id || new Set(offers.map(a=>a.id)).size!==offers.length)return false;
	const amendments=(run.productRepins??[]).flatMap(p=>p.amendments??[]);
	if(new Set(amendments.map(s=>s.proposal)).size!==amendments.length ||
		amendments.some(s=>!offers.some(a=>a.id===s.proposal && a.failed===s.prior.check && (a.patch || a.rollout) && s.harness===a.rollout?.harness && a.decision?.status==="answered")))return false;
	return offers.every(a=>{
		const p=products.get(a.checkpoint),g=effects.get(a.goal),m=a.manifest,d=a.decision;
		if(a.id!==offerId(a) || a.offeredThrough!==undefined && (!a.rollout || d?.status!=="answered" || a.offeredThrough>(run.artifacts?.length??0)) ||
			a.foreground && !a.rollout || !!(m||a.patch||a.rollout||a.evaluator)!==!!a.assembly || a.rollout && (!a.failed || a.patch || m) || !!a.patch && (!a.failed || m) || !p || g?.kind!=="goal" || g.commit!==p.commit ||
			![1,2].includes(checkReceipt(g)?.exit??-1) || (a.revision===p.target)!==!!a.evaluator || !a.assembly && (d || a.previous))return false;
		if(m && (!m.files.length || m.files.includes(run.policy.source) || m.goalFrom!==(g.evaluatorRevision??run.policy.base) ||
			new Set(m.files).size!==m.files.length || m.resolutions?.some(r=>!outside(r.file,[".foundry",...run.policy.files]))))return false;
		const replaced=a.previous?.flatMap(prior=>prior.status==="unavailable" && prior.presentation?[prior.presentation]:[])??[];
		if(new Set(replaced).size!==replaced.length || d?.status==="presenting" && d.presentation && replaced.includes(d.presentation) ||
			a.previous?.some(prior=>prior.status!=="dismissed" && prior.status!=="unavailable") ||
			d?.status==="presenting" && (!d.presentation || a.id!==run.targetProposal || d.selected!==undefined && (d.selected!==a.id || !a.failed && !a.evaluator)))return false;
		if(a.evaluator){
			const {kind,from,blob,files}=a.evaluator,check=kind==="goal"?run.policy.goalCheck:run.policy.productCheck;
			if(a.failed || m || a.patch || a.rollout || !a.assembly || !files.length || new Set(files).size!==files.length ||
				!correctionRefs(run).some(o=>o.draft?.id===a.evaluator?.draft && o.to.length===1 && o.to[0]===check && o.blob===blob && o.evaluation?.from===from &&
					o.evaluation.goal===a.goal && o.evaluation.checkpoint===a.checkpoint && (!o.draft || digest(draftChanges(o.draft).map(f=>f.file))===digest(files))))return false;
			return d?.status!=="answered" || d.answer===blob && (kind==="goal"?run.repins:run.productRepins)?.some(pin=>pin.from===from && pin.revision===a.assembly && digest(pin.files)===digest(files))===true;
		}
		const pin=run.productRepins?.find(pin=>pin.targetFrom && pin.revision===a.revision);
		if(a.failed){
			const old=pin && verificationAssembly(run,pin,a.failed,products), patch=a.patch, grain=failedComponent(effects.get(a.failed));
			if(m || !pin || !old || !grain || pin.checkpoint!==a.checkpoint || pin.goal!==a.goal || !Object.hasOwn(old.outputs,grain))return false;
			if(a.rollout)return validRollout(run,a,old,effects,pin);
			if(!patch)return !d;
			const evaluator=correctionEvaluator(pin,originalVerification(run,a.failed)??a.failed);
			if(!evaluator || effects.get(a.failed)?.evaluatorRevision!==evaluator || pin.amendments?.some(s=>s.harness && s.recheck===originalVerification(run,a.failed)) &&
				(!patch.owner || offers.filter(o=>o.failed===a.failed && o.patch && o.decision?.status==="answered").length>1))return false;
			const paths=patch.files.map(f=>f.file);
			if(grain!==patch.grain || !paths.length || new Set(paths).size!==paths.length || a.assembly===old.commit ||
				patch.files.some(r=>r.before===r.result || !outside(r.file,[".foundry",...run.policy.files,...(pin.resolutions??[]).map(r=>r.file)])) ||
				!correctionRefs(run).some(ref=>ref.draft?.id===patch.draft && ref.base===a.revision && ref.blob===patch.blob && paths.every(f=>covers(ref.to,f)) &&
					matchesDraft(ref,old.check,old.commit,patch.files)))return false;
			const step=pin.amendments?.find(s=>s.proposal===a.id);
			if(patch.owner){
				if(!validReplacement(run,a,old,effects))return false;
				if(!step && d?.status==="answered")return d.answer===patch.blob;
			}
			return d?.status==="answered" ? d.answer===patch.blob && !!step && step.prior.check===a.failed &&
				verificationAssembly(run,pin,step.recheck,products)?.commit===a.assembly : !step;
		}
		if(d?.status!=="answered")return true;
		const product=pin && verificationAssembly(run,pin,pin.recheck,products);
		return !!pin && !!m && pin.targetFrom===m.from && pin.from===m.productFrom && pin.checkpoint===p.check && pin.goal===g.id &&
			pin.acceptance===d.answer && !!product && product.commit===a.assembly && digest(product.outputs)===digest(m.outputs) &&
			digest(pin.files)===digest(m.files) && digest([...(pin.resolutions??[])].sort((a,b)=>a.file<b.file?-1:1))===digest(m.resolutions??[]);
	});
}

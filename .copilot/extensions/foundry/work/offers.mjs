import { checkReceipt, failedComponent } from "./evidence.mjs";
import { verificationAssembly } from "./migrations.mjs";
import { contractConflict, outside } from "./product.mjs";
import { covers, digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Adoption} Adoption */
/** @typedef {Omit<Adoption,"id"|"basis"|"decision"|"previous">} Subject */

/** Approval identity is the authorized inputs, not the wording or formatting of their presentation.
 * @param {Subject} s */
export const offerId=s=>digest([s.revision,s.checkpoint,s.goal,s.assembly??null,...(s.failed?[s.failed,s.patch??s.message]:[s.manifest??s.message])]);

/** Presenting a question changes neither the run's authority nor its inputs.
 * @param {string} cwd @param {Run} run @param {string} revision */
export function targetBasis(cwd,{adoptions,targetProposal,conflict,...domain},revision){
	return digest(conflict && conflict!==contractConflict(cwd,domain.policy,revision) ? {...domain,conflict} : domain);
}

/** @param {Run} run */
export function currentOffer(run){
	const a=run.adoptions?.at(-1);
	if(a && a.id===run.targetProposal && a.checkpoint===run.products.at(-1)?.check && a.goal===run.goal?.check &&
		(a.failed ? a.revision===run.policy.contractTarget && a.failed===run.join?.check : a.revision!==run.policy.contractTarget))return a;
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
		amendments.some(s=>!offers.some(a=>a.id===s.proposal && a.failed===s.prior.check && a.patch && a.decision?.status==="answered")))return false;
	return offers.every(a=>{
		const p=products.get(a.checkpoint),g=effects.get(a.goal),m=a.manifest,d=a.decision;
		if(a.id!==offerId(a) || !!(m||a.patch)!==!!a.assembly || !!a.patch && (!a.failed || m) || !p || g?.kind!=="goal" || g.commit!==p.commit ||
			![1,2].includes(checkReceipt(g)?.exit??-1) || a.revision===p.target || !a.assembly && (d || a.previous))return false;
		if(m && (!m.files.length || m.files.includes(run.policy.source) || m.goalFrom!==(g.evaluatorRevision??run.policy.base) ||
			new Set(m.files).size!==m.files.length || m.resolutions?.some(r=>!outside(r.file,[".foundry",...run.policy.files]))))return false;
		if(a.previous?.some(prior=>prior.status!=="dismissed" && prior.status!=="unavailable") ||
			d?.status==="presenting" && (!d.presentation || a.id!==run.targetProposal))return false;
		const pin=run.productRepins?.find(pin=>pin.targetFrom && pin.revision===a.revision);
		if(a.failed){
			const old=pin && verificationAssembly(pin,a.failed,products,run.join), patch=a.patch, grain=failedComponent(effects.get(a.failed));
			if(m || !pin || !old || !grain || pin.checkpoint!==a.checkpoint || pin.goal!==a.goal || !Object.hasOwn(old.outputs,grain))return false;
			if(!patch)return !d;
			const paths=patch.files.map(f=>f.file);
			if(grain!==patch.grain || !paths.length || new Set(paths).size!==paths.length || a.assembly===old.commit ||
				patch.files.some(r=>r.before===r.result || !outside(r.file,[".foundry",...run.policy.files,...(pin.resolutions??[]).map(r=>r.file)])) ||
				!run.artifacts?.some(ref=>ref.publisher===run.owner && ref.base===a.revision && ref.blob===patch.blob && paths.every(f=>covers(ref.to,f))))return false;
			const step=pin.amendments?.find(s=>s.proposal===a.id);
			return d?.status==="answered" ? d.answer===patch.blob && !!step && step.prior.check===a.failed &&
				verificationAssembly(pin,step.recheck,products,run.join)?.commit===a.assembly : !step;
		}
		if(d?.status!=="answered")return true;
		const product=pin && verificationAssembly(pin,pin.recheck,products,run.join);
		return !!pin && !!m && pin.targetFrom===m.from && pin.from===m.productFrom && pin.checkpoint===p.check && pin.goal===g.id &&
			pin.acceptance===d.answer && !!product && product.commit===a.assembly && digest(product.outputs)===digest(m.outputs) &&
			digest(pin.files)===digest(m.files) && digest([...(pin.resolutions??[])].sort((a,b)=>a.file<b.file?-1:1))===digest(m.resolutions??[]);
	});
}

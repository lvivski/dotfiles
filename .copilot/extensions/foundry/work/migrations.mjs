import { productOverlayPaths } from "./contract.mjs";
import { checkReceipt, failedComponent } from "./evidence.mjs";
import { outside } from "./product.mjs";
import { retainedMode } from "./transfer.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Product} Product */
/** @typedef {import("./model.js").ProductPin} Pin */
/** A failed verification remains an assembly, never a passing checkpoint.
 * @param {Pin} pin @param {string} id @param {Map<string,Product>} products @param {Product|undefined} join */
export const verificationAssembly=(pin,id,products,join)=>products.get(id)??(join?.check===id ? join : pin.amendments?.find(s=>s.prior.check===id)?.prior);

/** @param {Pin} p @param {import("./model.js").Receipt} receipt @param {Product} assembly @param {Map<string,string>} captures */
function observed(p,receipt,assembly,captures){
	const map=receipt.components,ids=Object.keys(assembly.outputs);
	return receipt.resolutionDigest===(p.resolutions && digest(p.resolutions)) && !!map &&
		Object.entries(map).every(([id,c],i)=>id===ids[i] && captures.get(`${id}@${assembly.outputs[id]}`)===c.check) &&
		(receipt.exit!==0 || Object.keys(map).length===ids.length && Object.values(map).every(c=>c.exit===0));
}

/** Follow products in journal order, including failed attempts. Only a new, explicitly approved
 * assembly can intervene between a mixed pin and its goal; it cannot change the approved output set.
 * @param {Run} run @param {Map<string,Product>} products @param {Map<string,import("./model.js").Effect>} effects */
export function productLineage(run,products,effects){
	const pins=run.productRepins??[];
	if(run.policy.contractTarget!==pins.findLast(p=>p.targetFrom)?.revision)return false;
	if(!pins.length)return !run.effects.some(e=>e.productEvaluatorRevision || e.kind==="product" && e.evaluatorRevision);
	if(!run.goal || products.size!==run.products.length || new Set([run.policy.base,...pins.map(p=>p.revision)]).size!==pins.length+1)return false;
	const steps=pins.flatMap((p,i)=>[{p,i,id:p.recheck,source:/** @type {Product|undefined} */ (undefined)},
		...(p.amendments??[]).map(a=>({p,i,id:a.recheck,source:a.prior}))]);
	let next=0,applied=0,retained=run.policy.ownership===retainedMode;
	/** @type {string|undefined} */ let pin;
	/** @type {import("./model.js").Effect|undefined} */ let lastGoal;
	/** @type {Product|undefined} */ let needsGoal;
	const captures=new Map();
	for(const e of run.effects){
		if(e.kind==="component" && checkReceipt(e)?.exit===0)captures.set(`${e.grain}@${e.commit}`,e.check);
		const step=steps[next];
		if(step?.id===e.id){
			const {p,i,source}=step, after=verificationAssembly(p,e.id,products,run.join);
			if(e.kind!=="product" || e.issuer!==run.owner || e.check!==run.policy.productCheck || !after || after.commit!==e.commit)return false;
			if(source){
				if(!p.targetFrom || needsGoal?.check!==source.check || source.qualifiedAt || products.has(source.check) ||
					!failedComponent(effects.get(source.check)) || source.target!==after.target || source.commit===after.commit ||
					digest([source.outputs,source.ownership])!==digest([after.outputs,after.ownership]))return false;
			}else{
				const prior=run.products[applied-1];
				if(needsGoal || !prior || prior.check!==p.checkpoint || lastGoal?.id!==p.goal || lastGoal.commit!==prior.commit ||
					lastGoal.check!==run.policy.goalCheck || ![1,2].includes(checkReceipt(lastGoal)?.exit??-1) ||
					p.from!==(pin??run.policy.base) || !p.files.length || new Set(p.files).size!==p.files.length)return false;
				if(!!p.targetFrom!==!!p.acceptance || p.resolutions && (!p.targetFrom || p.resolutions.some(r=>!outside(r.file,[".foundry",...run.policy.files]))))return false;
				if(p.targetFrom){
					const g=run.repins?.find(g=>g.revision===p.revision);
					if(retained!==(p.ownership===retainedMode) || !g || digest(g.files)!==digest(p.files) || g.from!==(lastGoal.evaluatorRevision??run.policy.base) ||
						p.files.includes(run.policy.source) || !p.files.every(f=>f.startsWith(".foundry/") || run.policy.files.includes(f)) ||
						p.targetFrom!==(pins.slice(0,i).findLast(q=>q.targetFrom)?.revision??run.policy.base) ||
						after.target!==p.revision || after.target===prior.target || after.commit===prior.commit)return false;
				}else if(e.commit!==prior.commit || after.target!==prior.target || digest(after.outputs)!==digest(prior.outputs) || !productOverlayPaths(run,p.files))return false;
				retained=p.ownership===retainedMode;pin=p.revision;
			}
			if(p.targetFrom && e.receipt && !observed(p,e.receipt,after,captures))return false;
			next++;needsGoal=after;
		}else if(needsGoal){
			if(e.kind==="goal"){
				if(!products.has(needsGoal.check) || e.commit!==needsGoal.commit || e.check!==run.policy.goalCheck)return false;
				needsGoal=undefined;
			}else if(["product","component","writer","repair","scout"].includes(e.kind))return false;
		}
		if(e.kind==="product" && e.evaluatorRevision!==pin || e.productEvaluatorRevision!==(e.kind==="goal" || e.kind==="scout" ? pin : undefined))return false;
		if(e.kind==="goal")lastGoal=e;
		if(products.has(e.id) && run.products[applied++]?.check!==e.id)return false;
	}
	return next===steps.length && applied===products.size && lastGoal?.id===run.goal.check && (!run.join || !products.has(run.join.check));
}

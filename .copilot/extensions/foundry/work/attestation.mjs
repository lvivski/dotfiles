import { contractHold, evaluatorOverlay } from "./contract.mjs";
import { changedFiles, rootAt } from "./product.mjs";
import { digest } from "./values.mjs";
import { heldOutcome } from "./revision.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** Evidence established for this decoded snapshot, never written back onto an old receipt.
 * @type {WeakSet<import("./model.js").Receipt>} */
const proven=new WeakSet();
/** @param {{revision:string,paths:string[]}} overlay */
export const overlaySeal=overlay=>digest([overlay.revision,[...overlay.paths].sort()]);
/** @param {import("./model.js").Receipt|undefined} r */
export const observedOverlay=r=>r?.inputs?(r.inputs.overlay?overlaySeal(r.inputs.overlay):undefined):r?.overlay;

/** The old materializer used the .foundry net diff. A path selected on only one side
 * is equivalent only if its absence, bytes and mode already agree on both sources.
 * @param {string} cwd @param {string} base @param {string} commit @param {{revision:string,paths:string[]}} overlay */
export function equivalentOverlay(cwd,base,commit,overlay){
	const old=new Set(changedFiles(cwd,base,overlay.revision,[".foundry"])),wanted=new Set(overlay.paths);
	const difference=[...new Set([...old,...wanted])].filter(p=>old.has(p)!==wanted.has(p));
	return !difference.length || !changedFiles(cwd,commit,overlay.revision,difference).length;
}

/** Only a rollout could have placed different conserved inputs in the assembled product.
 * Check the two exact passing observations, never infer what ran from evaluator stdout.
 * @param {Run} run */
function candidates(run){
	const p=run.products.at(-1),g=run.goal;
	if(!p || !g || p.commit!==g.commit || p.target!==g.target ||
		!run.productRepins?.some(pin=>pin.amendments?.some(a=>a.harness)) ||
		run.products.some(prior=>prior.withdrawnHandoff?.goal===g.check) || contractHold(run))return [];
	const product=run.effects.find(e=>e.id===p.check),goal=run.effects.find(e=>e.id===g.check);
	if(product?.kind!=="product" || goal?.kind!=="goal" || goal.evaluatorRevision!==run.repins?.at(-1)?.revision ||
		product.evaluatorRevision!==goal.productEvaluatorRevision ||
		![product,goal].every(e=>e.state==="done" && e.receipt?.exit===0))return [];
	return [product,goal].flatMap(e=>(e.kind==="product" || e.kind==="goal") && e.evaluatorRevision && e.evaluatorRevision!==run.policy.contractTarget && e.receipt
		? [{e,receipt:e.receipt,overlay:evaluatorOverlay(run,e.kind,e.evaluatorRevision)}]:[]);
}

/** @param {Run} run */
export function unprovenExports(run){
	return candidates(run).filter(({receipt})=>!proven.has(receipt)).map(({e})=>e.id);
}

/** Compare the two materializers on paths whose bytes, modes or presence actually differ.
 * Missing objects leave the affected handoff unproven. Never run Git in a write transaction.
 * @param {string} cwd @param {Run} run @param {Map<string,boolean>} cache @param {boolean} probe
 * @param {(id:string,e:Check)=>void} signed */
export function inspectExports(cwd,run,cache,probe,signed){
	for(const {e,receipt,overlay} of candidates(run)){
		if(heldOutcome(e))continue;
		const seal=overlaySeal(overlay);
		const observed=observedOverlay(receipt);
		if(observed===undefined){
			if(receipt.inputs)continue;
			const base=run.policy.contractTarget??run.policy.base,key=digest([base,receipt.commit,seal]);
			let same=cache.get(key);
			if(same===undefined && probe){
				try{
					same=equivalentOverlay(rootAt(cwd),base,receipt.commit,overlay);
				}catch(error){
					if(!(error instanceof Error && "status" in error && error.status===128))throw error;
					continue;
				}
				cache.set(key,same);
			}
			if(!same)continue;
		}else if(observed!==seal)continue;
		try{signed(run.id,e);proven.add(receipt);}
		catch(error){
			if(!(error instanceof Error && "code" in error && error.code==="missing_receipt"))throw error;
		}
	}
}

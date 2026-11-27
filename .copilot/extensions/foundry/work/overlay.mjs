import { changedFiles, outside } from "./objects.mjs";
import { signedFact } from "./receipt.mjs";
import { effectAt, productAt } from "./revision.mjs";
import { digest, fail, roots } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").Requirement} Fact */

/** A prospective edit does not cancel the already-issued goal it names.
 * @param {Run} run @param {Check} e */
export const selectedGoal=(run,e)=>e.evaluatorRevision===run.repins?.at(-1)?.revision || !!e.callId &&
	["issued","uncertain"].includes(e.state) && !!run.repins?.some(p=>p.assessment===e.id && p.from===(e.evaluatorRevision??run.policy.base));

/** Product overlays must stay inside the evaluator's private namespace and outside all other grants.
 * @param {Run} run @param {string[]} files */
export function productOverlayPaths(run,files) {
	const p = run.policy, check = p.productCheck;
	const protectedFiles = [p.source, ...p.files.filter(f=>f!==check), ...p.squads.flatMap(s=>"areas" in s ? [s.charter,...s.areas,...s.boundary,...s.checks] : [s.charter]),
		...Object.values(run.nodes).flatMap(n=>[n.grain.check,n.grain.specification,...n.grain.boundary,...roots(n.grain.directory)])];
	return check.startsWith(".foundry/") && files.length > 0 && files.every(f=>(f===check || f.startsWith(`${check}.d/`)) && !/^\.foundry\/[^/]+\.json$/i.test(f) && outside(f,protectedFiles));
}

/** @param {import("./model.js").Run} run @param {"product"|"goal"} kind @param {string[]} files @param {boolean} [certified] */
export function evaluatorPaths(run,kind,files,certified=false){
	const p=run.policy, evaluator=kind==="goal"?p.goalCheck:p.productCheck, other=kind==="goal"?p.productCheck:p.goalCheck;
	const protectedFiles=[p.source,...(other?[other]:[]),...p.squads.flatMap(s=>"areas" in s?[s.charter,...s.boundary,...s.checks]:[s.charter]),
		...Object.values(run.nodes).flatMap(n=>[n.grain.specification,...n.grain.boundary,n.grain.check])];
	return files.length>0 && files.every(f=>(certified?f===evaluator:f.startsWith(".foundry/")) && !/^\.foundry\/[^/]+\.json$/i.test(f) && outside(f,protectedFiles));
}

/** Only follow the approved chain for this evaluator, ending at its contract.
 * @param {import("./model.js").Run} run @param {"goal"|"product"} kind @param {string} revision */
function approvedEdits(run,kind,revision){
	const base=run.policy.contractTarget??run.policy.base,goals=run.repins??[],products=run.productRepins??[];
	const harnesses=new Set(products.flatMap(p=>p.amendments?.flatMap(s=>s.harness?[s.harness]:[])??[]));
	const chain=new Map((kind==="goal"?goals:[...products,...goals.filter(p=>harnesses.has(p.revision))]).map(p=>[p.revision,p]));
	const edits=[];
	for(let at=revision;at!==base;){
		const pin=chain.get(at)??fail("stale_pin","Evaluator history does not reach the selected contract");
		edits.push(pin);
		chain.delete(at);at=pin.from;
	}
	return edits;
}
/** Each isolated checker edit names the work the owner authorized. A product
 * edit is first tested on that exact checkpoint; only its signed pass can carry
 * the edited checker forward. A goal-only edit cannot amend a product checker.
 * @param {Run} run @param {Check} e @param {"product"|"goal"} kind @param {string} revision @param {string} [cwd] */
export function evaluatorFacts(run,e,kind,revision,cwd){
	const end=run.effects.indexOf(e);
	/** @type {Fact[]} */ const facts=[];
	for(const p of approvedEdits(run,kind,revision)){
		if(!evaluatorPaths(run,kind,p.files) || cwd && digest([...p.files].sort())!==digest(changedFiles(cwd,p.from,p.revision).sort()))
			fail("invalid_inputs","The evaluator paths differ from the approved diff");
		const pin=kind==="product" && run.productRepins?.find(upgrade=>upgrade.revision===p.revision);
		const assessment=pin?pin.checkpoint:"assessment" in p?p.assessment:undefined,old=effectAt(run,assessment);
		if(!assessment || !old || old.tool!=="bash" || old.kind!==kind || old.check!==(kind==="product"?run.policy.productCheck:run.policy.goalCheck) ||
			run.effects.indexOf(old)>=end || (old.evaluatorRevision??run.policy.base)!==p.from)
			fail("invalid_inputs","Missing the original assessment of the approved evaluator edit");
		if(pin){
			const before=productAt(run,pin.checkpoint),goal=effectAt(run,pin.goal),first=effectAt(run,pin.recheck),at=first && run.effects.indexOf(first);
			if(!before || !first || at===undefined || first.kind!=="product" || first.issuer!==run.owner || first.commit!==before.commit ||
				first.check!==run.policy.productCheck || first.evaluatorRevision!==pin.revision || !productOverlayPaths(run,pin.files) ||
				!Object.keys(pin).every(k=>["from","revision","files","checkpoint","goal","recheck","ownership"].includes(k)) ||
				goal?.kind!=="goal" || goal.check!==run.policy.goalCheck || goal.productEvaluatorRevision!==old.evaluatorRevision)
				fail("invalid_inputs","Missing the original product-only authorization");
			const product=signedFact(run,at,old,"product",before.commit),unmet=signedFact(run,at,goal,"goal",before.commit);
			if(product?.exit!==0 || unmet?.exit!==1 && unmet?.exit!==2)fail("missing_receipt","Product repinning needs the original checkpoint and unsettled goal");
			facts.push(product,unmet);
			const original=run.join?.check===first.id?run.join:productAt(run,first.id);
			if(!original || original.target!==before.target || digest(original.outputs)!==digest(before.outputs) ||
				digest(original.ownership??null)!==digest(before.ownership??null))
				fail("invalid_inputs","The original checkpoint's ownership or output versions changed");
			if(first!==e){
				const pass=signedFact(run,end,first,"product",before.commit);
				if(pass?.exit!==0 || !productAt(run,first.id))fail("missing_receipt","The new checker has not passed on its original checkpoint");
				facts.push(pass);
			}
		}
		facts.push({kind:"evaluator",assessment,terms:digest(pin||p),from:p.from,revision:p.revision,files:p.files});
	}
	return facts;
}
/** Keep reverted and deleted paths. A goal must never inherit a product-only repin.
 * @param {import("./model.js").Run} run @param {"goal"|"product"} kind @param {string} revision */
export function evaluatorOverlay(run,kind,revision){
	const paths=new Set(approvedEdits(run,kind,revision).flatMap(p=>p.files));
	const exact=run.policy.goalCheck;
	return {revision,paths:[...paths],...(kind==="goal" && exact && !exact.startsWith(".foundry/") && paths.has(exact) &&
		run.testRepairs?.some(j=>j.state==="applied" && j.rule.check===exact && !j.grain) && {exact})};
}

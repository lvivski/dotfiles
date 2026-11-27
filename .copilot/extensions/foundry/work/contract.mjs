import { outside } from "./product.mjs";
import { fail, roots } from "./values.mjs";

/** @param {unknown} outcome @param {number} grains @returns {outcome is import("./model.js").Observation["outcome"]} */
export const validOutcome = (outcome, grains) => grains > 0 ? outcome === "regenerate" :
	outcome === "no-gap" || outcome === "needs-decision" || outcome === "waiting" || outcome === "needs-evidence" ||
	outcome === "needs-research" || outcome === "researched" || outcome === "unresolved";

/** @param {string} filename */
export const planDirectory = filename => filename.replace(/\.json$/, "");

/** @param {import("./model.js").Run} run @param {{file:string}[]} files */
export function changesFixedContract(run,files){
	const paths=Object.values(run.nodes).flatMap(({grain:g})=>g.task===undefined?[g.specification,...g.boundary]:[]);
	return paths.length>0 && files.some(f=>!outside(f.file,paths));
}
/** An old approval is still inspectable evidence, not authority to change this contract.
 * @param {import("./model.js").Run} run */
export function contractHold(run){
	const unsafe=run.adoptions?.find(a=>a.rollout && a.decision?.status==="answered" &&
		(changesFixedContract(run,a.rollout.files) || a.rollout.followup && changesFixedContract(run,a.rollout.followup.files)));
	if(unsafe)return `Approved rollout ${unsafe.id} changes a conserved fixed specification or boundary. This run is read-only; its historical receipts are not a handoff.`;
}

/** A reverted or deleted input still belongs to this evaluator's approved overlay,
 * even when it no longer differs from the target. Do not overlay the other evaluator's repins.
 * @param {import("./model.js").Run} run @param {"goal"|"product"} kind @param {string} revision */
export function evaluatorOverlay(run,kind,revision){
	const base=run.policy.contractTarget??run.policy.base, goals=run.repins??[], products=run.productRepins??[];
	const harnesses=new Set(products.flatMap(p=>p.amendments?.flatMap(s=>s.harness?[s.harness]:[])??[]));
	const chain=new Map((kind==="goal"?goals:[...products,...goals.filter(p=>harnesses.has(p.revision))]).map(p=>[p.revision,p]));
	/** @type {Set<string>} */ const paths=new Set();
	for(let at=revision;at!==base;){
		const pin=chain.get(at)??fail("stale_pin","Evaluator history does not reach the selected contract");
		for(const file of pin.files)paths.add(file);
		chain.delete(at);at=pin.from;
	}
	const exact=run.policy.goalCheck;
	return {revision,paths:[...paths],...(kind==="goal" && exact && !exact.startsWith(".foundry/") && paths.has(exact) &&
		run.testRepairs?.some(j=>j.state==="applied" && j.rule.check===exact && !j.grain) && {exact})};
}

/** Product overlays must stay inside the evaluator's private namespace and outside all other grants.
 * @param {import("./model.js").Run} run @param {string[]} files */
export function productOverlayPaths(run,files) {
	const p = run.policy, check = p.productCheck;
	const protectedFiles = [p.source, ...p.files.filter(f=>f!==check), ...p.squads.flatMap(s=>"areas" in s ? [s.charter,...s.areas,...s.boundary,...s.checks] : [s.charter]),
		...Object.values(run.nodes).flatMap(n=>[n.grain.check,n.grain.specification,...n.grain.boundary,...roots(n.grain.directory)])];
	return check.startsWith(".foundry/") && files.length > 0 && files.every(f=>(f===check || f.startsWith(`${check}.d/`)) && !/^\.foundry\/[^/]+\.json$/i.test(f) && outside(f,protectedFiles));
}

import { checkReceipt } from "./evidence.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Subset} Subset */
/** @param {Subset} s */
export function isolationSeal({assessment, ...approval}) { return digest(approval); }

/** Only the two new observations and the selected nodes' promotion may change.
 * The old product, failed assemblies, grants, reviews and effective inputs stay frozen.
 * @param {Run} run @param {string} product @param {Subset["selected"]} selected */
export function isolationBasis(run,product,selected) {
	const i=run.effects.findIndex(e=>e.id===product), j=run.products.findIndex(p=>p.check===product);
	const nodes={...run.nodes};
	if (j>=0) for (const {grain} of selected) if (nodes[grain]?.state==="qualified") nodes[grain]={...nodes[grain],state:"published"};
	return digest([run.policy,nodes,run.effects.slice(0,i<0?undefined:i),run.products.slice(0,j<0?undefined:j),
		run.repins,run.productRepins,run.artifacts,run.references,run.attributions,run.pendingReviewNotes]);
}

/** Independent progress has its own lineage; never reinterpret the original pair
 * as applicable to a descendant. Used by the reader, scheduler and exclusive runner.
 * @param {Run} run */
export function validIsolation(run) {
	const s=run.independent;
	if (!s) return !run.effects.some(e=>e.tool==="bash" && e.isolation);
	const p=run.products.find(p=>p.check===s.checkpoint), applied=run.products.at(-1)?.check===s.product;
	const join=applied ? run.products.at(-1) : run.join, held=run.effects.find(e=>e.id===s.observer);
	const pair=held?.kind==="component" ? run.effects.find(e=>e.id===held.observer?.pair) : undefined;
	const checks=run.effects.slice(run.effects.findIndex(e=>e.id===s.product)), [product,goal]=checks;
	const selected=new Set(s.selected.map(n=>n.grain)), pins=Object.fromEntries(s.selected.map(n=>[n.grain,n.candidate]));
	const checksNeeded=new Set([s.hold.original,s.hold.pair,s.observer,s.hold.component,...s.selected.map(n=>n.component)]);
	if (!p || p.target!==s.target || (applied ? run.products.at(-2)!==p || run.join : run.products.at(-1)!==p) ||
		pair?.kind!=="component" || !pair.pair || pair.pair.checkpoint!==s.checkpoint ||
		pair.pair.goal!==s.goal || pair.pair.target!==s.target || !held?.grain || run.nodes[held.grain]?.check!==held.id ||
		pair.id!==s.hold.pair || s.hold.grain!==held.grain || s.hold.historical!==run.nodes[held.grain]?.restoration?.historical ||
		pair.pair.failed!==s.hold.original || pair.pair.retainer!==s.hold.retainer || pair.pair.candidate!==s.hold.candidate || pair.pair.component!==s.hold.component ||
		checkReceipt(held)?.exit!==1 || run.nodes[held.grain].state!=="blocked" ||
		run.nodes[pair.pair.retainer]?.check!==pair.pair.component || run.nodes[pair.pair.retainer]?.state!=="published" ||
		!selected.size || selected.size!==s.selected.length || selected.has(held.grain) || selected.has(pair.pair.retainer) ||
		checksNeeded.size!==s.evidence.length || s.evidence.some(x=>!checksNeeded.delete(x.component) ||
			!run.effects.some(e=>e.kind==="component" && e.id===x.component && e.commit===x.commit) ||
			Object.values(x.stages).some(notes=>!notes.length)) ||
		s.selected.some(n=>run.nodes[n.grain]?.candidate!==n.candidate || run.nodes[n.grain].check!==n.component ||
			run.nodes[n.grain].state!==(applied?"qualified":"published")) ||
		!join || join.qualifiedAt || join.check!==s.product || join.commit!==s.assembly || join.target!==s.target ||
		digest(join.outputs)!==digest({...p.outputs,...pins}) || !join.ownership || digest(join.ownership)!==digest(s.ownership) ||
		!product || product.kind!=="product" || product.issuer!==run.owner || product.commit!==s.assembly ||
		product.isolation!==isolationSeal(s) || checks.length!==(applied?2:1) ||
		isolationBasis(run,s.product,s.selected)!==s.basis) return false;
	return applied ? !!goal && goal.kind==="goal" && goal.issuer===run.owner && goal.isolation===product.isolation &&
		goal.id===s.assessment && goal.id===run.goal?.check && goal.commit===s.assembly && run.goal.commit===s.assembly &&
		run.goal.target===s.target && checkReceipt(product)?.exit===0 :
		!s.assessment && run.goal?.check===s.goal && run.goal.commit===p.commit;
}

/** A dialog or late callback prepared before consent must not mutate the held
 * snapshot and leave the next reader with an undecodable run.
 * @param {Run} run @param {string|undefined} prior */
export function keepsIsolation(run,prior) {
	if (!run.independent) return !prior;
	return (!prior || isolationSeal(run.independent)===prior) && validIsolation(run);
}

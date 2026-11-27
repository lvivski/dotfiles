import { outside } from "./product.mjs";
import { checkReceipt } from "./evidence.mjs";
import { producingGrant, submittedBy } from "./lineage.mjs";
import { touchesCut } from "./transfer.mjs";
import { passingRemedy, productionWriter } from "./remedy.mjs";
import { carriedInput, publishedComponent } from "./publication.mjs";
import { effectAt, productAt } from "./revision.mjs";
import { contains, covers, digest, mixed, roots, sameScope, scopeLabel } from "./values.mjs";

/** @param {import("./model.js").Run} run @param {string} from @param {string} historical */
export function historicalGrant(run,from,historical) {
	const product=productAt(run,historical), candidate=product?.outputs[from];
	if (!product || !candidate) return;
	const index=run.effects.findIndex(e=>e.id===historical), prior=run.effects.slice(0,index);
	const component=prior.findLast(e=>e.kind==="component" && e.grain===from && e.commit===candidate && checkReceipt(e)?.exit===0);
	const launch=component && prior.slice(0,prior.indexOf(component)).findLast(e=>e.kind==="writer" && e.grain===from && e.nativeId===component.issuer && e.state==="done");
	const origin=producingGrant(run,launch),g=origin?.output;
	if(!component?.commit || !origin || !g || typeof g==="string" || !mixed(g.directory) || !submittedBy(component,origin) ||
		origin.writer.finished && !sameScope(origin.writer.finished.directory,g.directory))return;
	// This is the historical owner, not permission to publish today. A later review
	// list cannot impose a new review contract on a component already in this checkpoint.
	const checkpoint=effectAt(run,product.check);
	if(component.runnerClaim ? checkpoint?.kind==="product" && checkpoint.runnerClaim && checkpoint.commit===product.commit && checkReceipt(checkpoint)?.exit===0 :
		carriedInput(run,product,component,from,candidate))
		return {product,component,candidate,scope:g.directory,grain:g,squad:origin.review.squad,review:origin.review};
}

/** @param {import("./model.js").Run} run @param {import("./model.js").Node} n */
export function validRestoration(run,n) {
	const r=n.restoration;
	if (!r) return false;
	const h=historicalGrant(run,r.from,r.historical), p=run.products.find(p=>p.check===r.checkpoint), owner=run.nodes[r.retainer];
	const goal=run.effects.find(e=>e.id===r.goal);
	return h && p && run.products.indexOf(h.product)<=run.products.indexOf(p) && owner && !run.nodes[r.from] &&
		goal?.kind==="goal" && goal.commit===p.commit && [1,2].includes(checkReceipt(goal)?.exit ?? -1) &&
		n.grain.directory===h.scope.primary && n.grain.check===h.component.check && !n.grain.revision && !n.review && !n.reuse &&
		digest(n.grain.needs)===digest(h.grain.needs) && h.scope.files.every(f=>covers(owner.grain.directory,f) && !touchesCut(owner.retained ?? [],f)) &&
		n.base===p.commit && !Array.isArray(n.priorSource) && n.priorSource?.tree===r.tree &&
		outside(owner.grain.directory,[h.scope.primary]);
}

/** @param {import("./model.js").Run} run @param {import("./model.js").Pairing} pair @param {string} [target] */
export function matchesPair(run,pair,target) {
	const owner=run.nodes[pair.retainer], p=run.products.at(-1);
	return !!p && p.target===pair.target && (target===undefined || target===pair.target) &&
		p.check===pair.checkpoint && run.goal?.check===pair.goal && owner?.state==="published" &&
		owner.candidate===pair.candidate && owner.check===pair.component && !!publishedComponent(run,pair.component,pair.retainer,pair.candidate);
}

/** @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e */
export function pairedInput(run,e) {
	const old=e.observer && run.effects.find(x=>x.id===e.observer?.pair);
	return e.pair ?? (old?.kind==="component" ? old.pair : undefined);
}

/** The only successor of an observer starts on the first writer's signed,
 * failed candidate. Never walk a chain of diagnostic assignments.
 * @param {import("./model.js").Effect[]} history @param {import("./model.js").Observer} o */
export function observerInput(history,o) {
	const p=o.previous, pair=history.find(e=>e.id===o.pair);
	if (pair?.kind!=="component" || !pair.pair || !pair.runnerClaim || checkReceipt(pair)?.exit!==1) return;
	if (!p) return pair;
	const prior=history.find(e=>e.id===p.check);
	if (prior?.kind==="component" && prior.observer && !prior.observer.previous && prior.observer.pair===pair.id &&
		prior.grain===pair.grain && prior.check===pair.check && prior.commit===p.candidate && prior.observer.file===o.file &&
		prior.observer.after===o.before && prior.runnerClaim && checkReceipt(prior)?.exit===1) return prior;
}

/** The prior grant is superseded only by a later passing product which included the fresh
 * writer's own check and froze both new owners. A component alone cannot release the hold.
 * @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} writer */
export function restoredProduct(run,writer) {
	const r=writer.restoration,to=writer.grain;
	if (!r || !to || !writer.nativeId || writer.state!=="done") return;
	const index=run.products.findIndex(p=>p.check===r.checkpoint);
	if (index<0) return;
	const later=run.effects.slice(run.effects.indexOf(writer)+1);
	const checks=later.filter(e=>{
		if (e.kind!=="component" || e.grain!==to || checkReceipt(e)?.exit!==0) return false;
		if (e.remedy) {
			const b=passingRemedy(run,e);
			return b && b.pair.checkpoint===r.checkpoint && b.retainer===r.retainer &&
				later.some(old=>old.id===b.pair.failed && old.issuer===writer.nativeId);
		}
		const pair=pairedInput(run,e);
		const observer=e.observer;
		return pair ? (observer ? !!observer.after && later.some(w=>w.kind==="writer" && w.observer?.pair===observer.pair &&
			w.nativeId===e.issuer && digest(w.observer)===digest(observer)) : e.issuer===run.owner) && pair.checkpoint===r.checkpoint && pair.retainer===r.retainer &&
			later.some(old=>old.id===pair.failed && old.issuer===writer.nativeId) : e.issuer===writer.nativeId;
	});
	return run.products.slice(index+1).find(p=>p.ownership?.[to] && p.outputs[r.retainer] && p.ownership[r.retainer] &&
		checks.some(e=>{
			if (e.kind!=="component" || e.commit!==p.outputs[to] || !publishedComponent(run,e.id,to,e.commit)) return false;
			if (e.remedy) {
				const b=passingRemedy(run,e), at=run.effects.findIndex(c=>c.id===p.check);
				return b && p.target===b.pair.target && b.checks.every(c=>c.grain && p.outputs[c.grain]===c.commit &&
					publishedComponent(run,c.id,c.grain,c.commit) && run.effects.indexOf(c)<at);
			}
			const pair=pairedInput(run,e);
			return (!pair || p.outputs[r.retainer]===pair.candidate && p.target===pair.target && publishedComponent(run,pair.component,pair.retainer,pair.candidate)) &&
				run.effects.indexOf(e)<run.effects.findIndex(c=>c.id===p.check);
		}));
}

/** Detect a pre-guard, already-issued replacement. Old products need not have a
 * frozen ownership map: the confirmed writer's finished record binds its grant to
 * the passing product. A single unambiguous observed grant can also be matched to
 * its checked candidate if the writer had not yet been marked finished.
 * @param {import("./model.js").Run} run */
export function* displacements(run) {
	if (!run.products.length) return;
	/** @type {Map<string,import("./model.js").FileScope>} */
	const grants=new Map();
	/** @type {Map<string,import("./model.js").FileScope[]>} */
	const proposals=new Map();
	const ordinary=new Set();
	for (const e of run.effects) {
		if (e.kind==="writer" && e.grain && e.finished && mixed(e.finished.directory)) grants.set(e.grain,e.finished.directory);
		if (e.kind!=="scout" || e.state!=="observed") continue;
		for (const g of e.observation?.grains ?? []) if (typeof g!=="string") {
			if (mixed(g.directory)) proposals.set(g.id,[...proposals.get(g.id) ?? [],g.directory]);
			else ordinary.add(g.id);
		}
	}
	for (const p of run.products) if (p.ownership) for (const [id,scope] of Object.entries(p.ownership))
		if (scope.files.length && scope.directories.length===1) grants.set(id,{primary:scope.directories[0],files:scope.files});
	if (!grants.size && !proposals.size) return;
	for (const [id,scopes] of proposals) {
		if (ordinary.has(id) || grants.has(id) || run.nodes[id] && sameScope(run.nodes[id].grain.directory,scopes[0])) continue;
		const writers=run.effects.filter(e=>e.kind==="writer" && e.grain===id && e.nativeId);
		if (writers.length===1 && scopes.every(s=>sameScope(s,scopes[0])) && run.products.some(p=>p.outputs[id] &&
			run.effects.some(e=>e.kind==="component" && e.grain===id && e.issuer===writers[0].nativeId &&
				e.commit===p.outputs[id] && checkReceipt(e)?.exit===0))) grants.set(id,scopes[0]);
	}
	const nodes=Object.values(run.nodes);
	for (const [id,scope] of grants) {
		if (nodes.some(n=>sameScope(n.grain.directory,scope))) continue;
		if (run.effects.some(e=>{
			if (e.kind!=="writer" || e.restoration?.from!==id || !e.grain) return false;
			const p=restoredProduct(run,e), owner=p?.ownership?.[e.restoration.retainer], primary=p?.ownership?.[e.grain];
			return p && owner && primary?.directories.length===1 && primary.directories[0]===scope.primary && !primary.files.length &&
				scope.files.every(f=>owner.files.includes(f) || owner.directories.some(d=>contains(d,f))) &&
				!run.products.slice(run.products.indexOf(p)).some(product=>product.outputs[id]);
		})) continue;
		const replacements=nodes.filter(n=>!n.restoration && !outside(n.grain.directory,roots(scope)));
		if (replacements.length) yield {id,scope,replacements};
	}
}

/** @param {import("./model.js").Run} run @param {string} from */
export const displacement=(run,from)=>[...displacements(run)].find(d=>d.id===from);

/** @param {import("./model.js").Run} run @param {Record<string,string>} [outputs] @param {string} [target] */
export function partitionConflict(run,outputs,target) {
	for (const {id,scope,replacements} of displacements(run)) {
		const receiver=Object.values(run.nodes).find(n=>n.restoration?.from===id && n.grain.directory===scope.primary);
		const retainer=replacements.find(n=>n.grain.id===receiver?.restoration?.retainer);
		const check=receiver?.check && run.effects.find(e=>e.id===receiver.check);
		const producing=[receiver,retainer].find(n=>n && (n.state==="writing" || n.state==="checking") && productionWriter(run,n.token));
		if (producing) return `Production repair of ${id} is in progress in ${producing.grain.id}; release still needs both components${run.inspections ? " and their independent reviews" : ""}, product and goal.`;
		const pair=check && check.kind==="component" && pairedInput(run,check);
		if (check && check.kind==="component" && check.remedy) {
			const b=passingRemedy(run,check);
			if (!b || b.pair.checkpoint!==run.products.at(-1)?.check || b.pair.goal!==run.goal?.check ||
				target!==undefined && b.pair.target!==target || b.checks.some(c=>!c.grain || run.nodes[c.grain]?.check!==c.id))
				return `The production repair for ${id} needs both current components on the approved assembly.`;
		}
		if (pair && !matchesPair(run,pair,target))
			return `The approved pair for ${id} no longer matches the target, checkpoint, goal or retaining component.`;
		if (receiver?.state==="blocked" && check && check.kind==="component" && check.observer?.previous && checkReceipt(check)?.exit===1)
			return `Final diagnostic ${check.id} failed. Release is held. The owner may request the production form of foundry_grant for exact production and regression files in ${receiver.grain.id} or ${retainer?.grain.id}; a local observation is not a passing receipt.`;
		if (receiver && retainer && replacements.length===1 && [receiver,retainer].every(n=>n.candidate && publishedComponent(run,n.check,n.grain.id,n.candidate) &&
			["published","qualified"].includes(n.state) && (!outputs || outputs[n.grain.id]===n.candidate))) continue;
		return receiver ? `Ownership restoration of ${scope.primary} requires fresh included evidence from ${receiver.grain.id} and its paired owner ${receiver.restoration?.retainer}.` :
			`Checked mixed grant ${id} (${scopeLabel(scope)}) lost its owner to ${replacements.map(n=>`${n.grain.id} (${scopeLabel(n.grain.directory)})`).join(", ")}. Keep the issued work and receipts; product integration requires an explicit ownership resolution.`;
	}
}

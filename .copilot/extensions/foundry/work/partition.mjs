import { outside } from "./product.mjs";
import { checkReceipt } from "./evidence.mjs";
import { contains, mixed, roots, sameScope, scopeLabel } from "./values.mjs";

/** The prior grant is superseded only by a later passing product which included the fresh
 * writer's own check and froze both new owners. A component alone cannot release the hold.
 * @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} writer */
export function restoredProduct(run,writer) {
	const r=writer.restoration,to=writer.grain;
	if (!r || !to || !writer.nativeId || writer.state!=="done") return;
	const index=run.products.findIndex(p=>p.check===r.checkpoint);
	if (index<0) return;
	const checks=run.effects.slice(run.effects.indexOf(writer)+1).filter(e=>e.kind==="component" && e.grain===to &&
		e.issuer===writer.nativeId && checkReceipt(e)?.exit===0);
	return run.products.slice(index+1).find(p=>p.ownership?.[to] && p.outputs[r.retainer] && p.ownership[r.retainer] &&
		checks.some(e=>e.commit===p.outputs[to] && run.effects.indexOf(e)<run.effects.findIndex(c=>c.id===p.check)));
}

/** Detect a pre-guard, already-issued replacement. Old products need not have a
 * frozen ownership map: the confirmed writer's finished record binds its grant to
 * the passing product. A single unambiguous observed grant can also be matched to
 * its checked candidate if the writer had not yet been marked finished.
 * @param {import("./model.js").Run} run */
function* displacements(run) {
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

/** @param {import("./model.js").Run} run @param {Record<string,string>} [outputs] */
export function partitionConflict(run,outputs) {
	for (const {id,scope,replacements} of displacements(run)) {
		const receiver=Object.values(run.nodes).find(n=>n.restoration?.from===id && n.grain.directory===scope.primary);
		const retainer=replacements.find(n=>n.grain.id===receiver?.restoration?.retainer);
		if (receiver && retainer && replacements.length===1 && [receiver,retainer].every(n=>n.candidate &&
			["published","qualified"].includes(n.state) && (!outputs || outputs[n.grain.id]===n.candidate))) continue;
		return receiver ? `Ownership restoration of ${scope.primary} requires fresh included evidence from ${receiver.grain.id} and its paired owner ${receiver.restoration?.retainer}.` :
			`Checked mixed grant ${id} (${scopeLabel(scope)}) lost its owner to ${replacements.map(n=>`${n.grain.id} (${scopeLabel(n.grain.directory)})`).join(", ")}. Keep the issued work and receipts; product integration requires an explicit ownership resolution.`;
	}
}

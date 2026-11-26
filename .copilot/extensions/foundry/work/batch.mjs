import { checkReceipt } from "./evidence.mjs";
import { publicationVerdict } from "./publication.mjs";
import { grant } from "./transfer.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Delivery} Delivery */
/** @typedef {import("./model.js").NativeCall} Call */
/** @param {Run} run */
export function activeDelivery(run) {
	const d=run.deliveries?.at(-1);
	return d && !d.error && !d.assessment ? d : undefined;
}
/** @param {Pick<Delivery,"assembly"|"checkpoint"|"goal"|"selected">} d */
export const seal=({assembly,checkpoint,goal,selected})=>digest({assembly,checkpoint,goal,selected});
/** @param {Run} run @param {Delivery} d */
export const checks=(run,d)=>run.effects.filter(/** @returns {e is Call} */ e=>e.tool==="bash" && e.delivery===d.id);

/** @param {Run} run @param {Delivery} d @param {Call|undefined} c @param {import("./model.js").Node} node */
function passedMember(run,d,c,node) {
	const receipt=checkReceipt(c);
	return c?.kind==="component" && c.delivery===d.id && c.issuer===run.owner && c.commit===d.assembly &&
		c.grain===node.grain.id && c.check===node.grain.check && !!c.runnerClaim && receipt?.exit===0 && !receipt.failure;
}

/** A delivery contributes the entire previously absent directory, not the delta from the failed writer's draft.
 * @param {Run} run @param {import("./model.js").Node} node @param {string} base */
function deliveryBinding(run,node,base) {
	return {node,overrides:{base,generation:base,scope:grant(node),
		task:`Deliver the original, unchanged test directory from stopped check ${node.check} on this checkpoint. ${node.grain.task??run.policy.direction}`}};
}

/** Unlike an ordinary checking writer, each selected node stays on its original failed component.
 * @param {Run} run @param {Call} c */
export function deliveryInspection(run,c) {
	const d=activeDelivery(run), p=run.products.at(-1);
	if (!d || !p || run.join || !currentDelivery(run,d,p.target) || run.effects.some(e=>e.permissionHold)) return;
	const jobs=checks(run,d), i=jobs.indexOf(c);
	if (i>=0 && jobs.length===d.selected.length && d.selected.every(({prior},k)=>passedMember(run,d,jobs[k],prior) &&
		Object.entries(prior.inputs??{}).every(([id,pin])=>p.outputs[id]===pin && run.nodes[id]?.state==="qualified" && run.nodes[id].candidate===pin)))
		return deliveryBinding(run,d.selected[i].prior,p.commit);
}

/** Check historical approvals as well as current ones: a failed or completed product still used them.
 * @param {Run} run @param {Delivery} d @param {Call[]} jobs @param {string} base */
function reviewedBatch(run,d,jobs,base) {
	if (!run.inspections) return true;
	const reviews=new Map(run.inspections.map(i=>[i.component,i]));
	return d.selected.every(({prior},j)=>{
		const c=jobs[j], i=reviews.get(c?.id);
		if (!passedMember(run,d,c,prior) || !i || publicationVerdict(i)!=="approved" || i.issuer!==run.owner ||
			i.grain!==c.grain || i.candidate!==c.commit || i.generation!==base || i.base!==base) return false;
		const {overrides}=deliveryBinding(run,prior,base);
		return i.task===overrides.task && digest(i.scope)===digest(overrides.scope);
	});
}
/** @param {Run} run @param {Delivery} d @param {string} target */
export function currentDelivery(run,d,target) {
	const p=run.products.at(-1);
	return activeDelivery(run)?.id===d.id && p?.check===d.checkpoint && p.target===target && run.goal?.check===d.goal &&
		!run.conflict && !run.blocker && !run.independent && (!run.join || run.join.commit===d.assembly &&
			run.effects.some(e=>e.kind==="product" && e.id===run.join?.check && e.delivery===d.id) && reviewedBatch(run,d,checks(run,d),p.commit)) &&
		d.selected.every(s=>digest(run.nodes[s.prior.grain.id] ?? null)===digest(s.prior));
}

/** Validate historical authority without interpreting old work as a current permission.
 * @param {Run} run */
export function validDeliveries(run) {
	const list=run.deliveries ?? [], marked=run.effects.filter(e=>e.tool==="bash" && e.delivery);
	if (!list.length) return !marked.length;
	const effects=new Map(run.effects.map(e=>[e.id,e]));
	if (new Set(list.map(d=>d.id)).size!==list.length || marked.some(e=>e.tool!=="bash" || !list.some(d=>d.id===e.delivery))) return false;
	return list.every((d,i)=>{
		const p=run.products.find(p=>p.check===d.checkpoint), at=effects.get(d.goal), jobs=checks(run,d);
		if (d.id!==seal(d) || !d.selected.length || !jobs.length || jobs.length>d.selected.length+1 || !p || !at || at.kind!=="goal" ||
			at.commit!==p.commit || ![1,2].includes(checkReceipt(at)?.exit ?? -1) || run.effects.indexOf(at)>=run.effects.indexOf(jobs[0]) ||
			!d.error && !d.assessment && i!==list.length-1 || d.error && d.assessment ||
			new Set(d.selected.map(s=>s.prior.grain.id)).size!==d.selected.length) return false;
		for (const [i,{prior:n,rerun}] of d.selected.entries()) {
			const pass=effects.get(rerun), old=n.check && effects.get(n.check), dir=n.grain.directory;
			if (!old || old.kind!=="component" || !old.runnerClaim || !checkReceipt(old)?.exit || old.issuer!==n.worker ||
				n.state!=="blocked" || typeof dir!=="string" || pass?.kind!=="rerun" || pass.rerun?.of!==old.id ||
				pass.grain!==n.grain.id || pass.check!==n.grain.check || pass.rerun.directory!==dir || digest(pass.rerun.harness)!==digest([dir]) ||
				pass.commit!==p.commit || Object.hasOwn(p.outputs,n.grain.id) || !pass.runnerClaim || checkReceipt(pass)?.exit!==0 ||
				run.effects.indexOf(pass)>=run.effects.indexOf(jobs[0])) return false;
			const c=jobs[i];
			if (c && (c.kind!=="component" || c.grain!==n.grain.id || c.check!==n.grain.check)) return false;
		}
		if (jobs.some((e,i)=>e.issuer!==run.owner || e.commit!==d.assembly || e.pair || e.remedy || e.rerun || e.observer ||
			e.isolation || e.recheck || e.inlineRepair || (i<jobs.length-1 || d.assessment) && (!e.runnerClaim || checkReceipt(e)?.exit!==0))) return false;
		const prod=jobs[d.selected.length], joined=prod && (run.join?.check===prod.id ? run.join : run.products.find(p=>p.check===prod.id));
		if (prod && (prod.kind!=="product" || prod.check!==run.policy.productCheck || !joined && !d.error || !reviewedBatch(run,d,jobs,p.commit))) return false;
		if (joined && (joined.target!==p.target || joined.commit!==d.assembly ||
			digest(joined.outputs)!==digest({...p.outputs,...Object.fromEntries(d.selected.map(s=>[s.prior.grain.id,d.assembly]))}))) return false;
		const goal=d.assessment && effects.get(d.assessment);
		return d.assessment ? !!joined && run.products.includes(joined) && !!goal && goal.kind==="goal" && goal.commit===d.assembly &&
			run.effects.indexOf(goal)>run.effects.indexOf(prod) : !joined || joined===run.join;
	});
}

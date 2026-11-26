import { checkReceipt, generationOf } from "./evidence.mjs";
import { writerInputs } from "./plan.mjs";
import { approvedPublication } from "./publication.mjs";
import { grant } from "./transfer.mjs";
import { covers, digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @param {Run} run @param {Call} job */
export function origin(run,job) {
	const grant=job.production, failed=grant && run.effects.find(e=>e.id===grant.diagnostic);
	const pair=failed?.kind==="component" && failed.observer ? run.effects.find(e=>e.id===failed.observer?.pair) : undefined;
	if (job.kind==="writer" && grant && failed?.kind==="component" && failed.grain && failed.observer?.previous &&
		failed.runnerClaim && checkReceipt(failed)?.exit===1 && !failed.receipt?.failure && failed.commit===grant.candidate &&
		pair?.kind==="component" && pair.pair && pair.grain===failed.grain && pair.pair.checkpoint===grant.checkpoint &&
		pair.pair.goal===grant.goal && [failed.grain,pair.pair.retainer].includes(job.grain??""))
		return {failed,primary:failed.grain,retainer:pair.pair.retainer,pair:pair.pair,paired:pair};
}

/** @param {Run} run @param {string|undefined} token */
export function productionWriter(run,token) {
	const w=token && run.effects.find(e=>e.kind==="writer" && e.production && e.token===token);
	return w && w.kind==="writer" ? w : undefined;
}

/** @param {Run} run @param {Call} check */
export function remedyWriter(run,check) {
	const w=check.remedy && run.effects.find(e=>e.id===check.remedy?.writer);
	if (w?.kind==="writer" && w.production && check.remedy?.basis===digest(w.production)) return w;
}

/** @param {Run} run @param {Call} job */
export const remedyChecks=(run,job)=>run.effects.filter(
	/** @returns {e is Call} */ e=>e.kind==="component" && e.remedy?.writer===job.id);

/** @param {Run} run @param {Call} check */
export function currentRemedy(run,check) {
	const job=remedyWriter(run,check), n=job?.grain && run.nodes[job.grain];
	const checks=job && remedyChecks(run,job), b=job && origin(run,job);
	const peer=b && (job?.grain===b.primary ? run.nodes[b.retainer] : run.nodes[b.primary]);
	return !!job && !!n && !!b && peer?.check===(job.grain===b.primary?b.pair.component:b.failed.id) &&
		peer?.candidate===(job.grain===b.primary?b.pair.candidate:b.failed.commit) &&
		peer?.state===(job.grain===b.primary?"published":"blocked") &&
		n.token===job.token && n.worker===job.nativeId && n.state==="checking" &&
		n.candidate===check.commit && !!checks?.some(c=>c.id===n.check && c.grain===job.grain) &&
		(!["ready","ordinary"].includes(check.state) || !checks.some(c=>c.state==="refused" || c.launcherExit!==undefined));
}

/** Structural authority survives reload and product promotion, independently of current node state.
 * @param {Run} run @param {Call} e */
export function validRemedy(run,e) {
	const job=e.production?e:remedyWriter(run,e);
	if (!job?.production || !job.grain || e.observer || e.pair || e.restoration || e.reuse || e.recheck || e.inlineRepair) return false;
	const g=job.production, basis=origin(run,job);
	if (!basis || run.effects.indexOf(basis.failed)>=run.effects.indexOf(job) || g.prior.grain.id!==job.grain ||
		g.prior.check!==(job.grain===basis.primary ? basis.failed.id : basis.pair.component) ||
		g.prior.candidate!==(job.grain===basis.primary ? g.candidate : basis.pair.candidate) ||
		g.prior.state!==(job.grain===basis.primary ? "blocked" : "published") ||
		!g.files.length || new Set(g.files).size!==g.files.length || g.files.some(f=>f===basis.failed.observer?.file ||
			!covers(g.prior.grain.directory,f) || run.policy.files.includes(f))) return false;
	if (e===job) return !e.remedy && generationOf(job)===g.candidate && job.issuer===run.owner;
	if (e.kind!=="component" || !e.grain || !e.commit || e.commit===g.candidate || job.nativeId!==e.issuer ||
		job.state!=="done" || run.effects.indexOf(job)>=run.effects.indexOf(e)) return false;
	if (run.inspections?.some(i=>i.component===e.id && (i.issuer!==run.owner || i.previous?.some(a=>a.issuer!==run.owner)))) return false;
	const old=run.effects.find(x=>x.id===(e.grain===basis.primary?basis.failed.id:basis.pair.component));
	const cohort=remedyChecks(run,job);
	return old?.kind==="component" && old.grain===e.grain && old.check===e.check && cohort.length===2 &&
		[basis.primary,basis.retainer].every(id=>cohort.some(c=>c.grain===id && c.commit===e.commit && c.remedy?.basis===e.remedy?.basis));
}

/** Both components must pass on the same new assembly before either publication can enter a join.
 * @param {Run} run @param {Call} check */
export function passingRemedy(run,check) {
	const job=remedyWriter(run,check), basis=job && origin(run,job);
	if (!job || !basis) return;
	const checks=remedyChecks(run,job);
	if (checks.length===2 && [basis.primary,basis.retainer].every(id=>checks.some(c=>c.grain===id && c.commit===check.commit &&
		c.runnerClaim && checkReceipt(c)?.exit===0))) return {...basis,checks};
}

/** Reconstruct the two original owners without lending the producer's token to its peer.
 * The primary's approved observer edit lived on a failed candidate, so include it even when
 * the production editor worked entirely in the retaining directory.
 * @param {Run} run @param {Call} c */
export function remedyInspection(run,c) {
	const b=passingRemedy(run,c), job=remedyWriter(run,c), g=job?.production, p=run.products.at(-1);
	if (!b || !job?.grain || !g || !p || !b.paired.commit || !b.failed.observer || !currentRemedy(run,c) ||
		run.independent || run.blocker || run.conflict || run.join || run.effects.some(e=>e.permissionHold) ||
		p.check!==g.checkpoint || p.target!==b.pair.target || run.goal?.check!==g.goal ||
		!approvedPublication(run,b.pair.component,b.retainer,b.pair.candidate) ||
		!b.checks.includes(c) || b.checks.some(e=>!validRemedy(run,e) || checkReceipt(e)?.failure)) return;
	const writer=run.nodes[job.grain], editor=job.grain===c.grain;
	if (writer.generation!==g.candidate || digest(writer.grain)!==digest(g.prior.grain) || digest(writer.inputs)!==digest(g.prior.inputs)) return;
	for (const id of [b.primary,b.retainer]) {
		const n=run.nodes[id], inputs=writerInputs(run.nodes,{...n,state:"waiting"});
		if (!inputs || digest(inputs)!==digest(n.inputs) || Object.entries(inputs).some(([key,pin])=>p.outputs[key]!==pin || run.nodes[key]?.state!=="qualified")) return;
	}
	const node=editor ? g.prior : run.nodes[c.grain??""];
	if (!node?.base || !node.generation) return;
	const task=editor ? `${g.task} Production edits are restricted to ${JSON.stringify(g.files)}.` : node.grain.task??run.policy.direction;
	if (c.grain===b.primary) {
		const file=b.failed.observer.file;
		return {node,overrides:{base:p.commit,generation:b.paired.commit,scope:{directories:[],files:[...(editor ? g.files : []),file]},
			task:`${task} Also assess the preserved diagnostic edit to ${file} from ${b.failed.id}; the production writer cannot edit this observer.`}};
	}
	if (editor) return {node,overrides:{base:p.commit,generation:g.candidate,scope:{directories:[],files:g.files},task}};
	return {node,overrides:{base:node.base,generation:node.generation,scope:grant(node),task}};
}

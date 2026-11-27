import { corroborated, rolloutSlots, within } from "./campaign.mjs";
import { changeOffer, checkReceipt, componentOrigins, failedComponent } from "./evidence.mjs";
import { citedLine, priorReview } from "./inspection.mjs";
import { assigningGrant } from "./lineage.mjs";
import { verificationAssembly } from "./migrations.mjs";
import { historicalGrant } from "./partition.mjs";
import { observedComponent, publicationVerdict, publishedComponent } from "./publication.mjs";
import { outside } from "./product.mjs";
import { assigningCharter } from "./replacement.mjs";
import { effectAt, inspectionAt, productAt } from "./revision.mjs";
import { contains, covers, digest, ownership } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").CorrectionDraft} Draft */
/** @param {Run} run */
export const checkerPaths=run=>[...new Set([run.policy.productCheck,run.policy.goalCheck,...run.policy.squads.flatMap(s=>"checks" in s?s.checks:[]),
	...Object.values(run.nodes).map(n=>n.grain.check)]
	.filter(/** @returns {p is string} */ p=>!!p))];
/** @param {Run} run @param {string} file @param {import("./model.js").ProductPin|undefined} pin @param {string|undefined} evaluator */
export function protectedDraftPath(run,file,pin,evaluator){
	const checks=checkerPaths(run),protectedFiles=[run.policy.source,...(run.policy.sharedBrief?[run.policy.sharedBrief]:[]),
		...run.policy.squads.flatMap(s=>[s.charter,...("boundary" in s?s.boundary:[])]),...Object.values(run.nodes).flatMap(n=>[n.grain.specification,...n.grain.boundary]),
		...(pin?.resolutions??[]).map(r=>r.file),...checks.map(c=>c+".control")];
	return !outside(file,protectedFiles) || /^\.foundry\/[^/]+\.json$/i.test(file) || (evaluator?
		!file.startsWith(".foundry/") || !outside(file,checks.filter(c=>c!==evaluator)) || checks.some(c=>c!==evaluator && contains(c+".d",file)) ||
		evaluator===run.policy.productCheck && file!==evaluator && !contains(evaluator+".d",file) :
		!file.startsWith(".foundry/") && !outside(file,run.policy.files));
}
/** The checking issuer is not necessarily the writer. Trace only actual writer bindings, including across a replacement.
 * @param {Run} run @param {string} grain @param {import("./model.js").NativeCall} check @returns {string|undefined} */
export function originalProducer(run,grain,check){
	for(const c of componentOrigins(run,grain,check))
		if(run.effects.slice(0,run.effects.indexOf(c)).some(w=>w.kind==="writer" && w.state==="done" && w.grain===grain && w.nativeId===c.issuer))return c.issuer;
}
/** A later permission hold changes whether the issuer may act, not what the original
 * workflow reported. Authenticate that frozen record without clearing the live hold.
 * @param {Run} run @param {import("./model.js").Effect} check @param {NonNullable<Draft["finding"]>} finding */
function recordedFinding(run,check,finding){
	const i=inspectionAt(run,check.id);
	if(!i || i.id!==finding.inspection || i.issuer!==run.owner || !observedComponent(check,i.grain,i.candidate))return;
	const {permissionHold,...original}=i;
	if(publicationVerdict(original)==="changes" && digest(original)===finding.stamp)return i;
}

/** Validate the historical grant, not today's mutable node or a directory selected by a writer.
 * @param {Run} run @param {Draft} d */
export function validDraftScope(run,d){
	const e=effectAt(run,d.check),goal=effectAt(run,d.goal),p=productAt(run,d.checkpoint),checkpoint=effectAt(run,d.checkpoint);
	if(!e?.runnerClaim || !checkReceipt(e) || !p || checkpoint?.kind!=="product" || !checkpoint.runnerClaim ||
		checkpoint.commit!==p.commit || checkReceipt(checkpoint)?.exit!==0 || goal?.kind!=="goal" || !goal.runnerClaim ||
		goal.commit!==p.commit || ![1,2].includes(checkReceipt(goal)?.exit??-1))return false;
	const pin=run.productRepins?.find(p=>p.revision===d.target && p.targetFrom);
	const parent=e.kind==="component" && e.rollout?changeOffer(run,e):undefined,joined=parent?.failed??e.id;
	const join=pin && verificationAssembly(run,pin,joined,new Map(run.products.map(p=>[p.check,p])));
	const failGrain=parent?e.grain:failedComponent(e);
	if(d.previousCheck){
		const previous=effectAt(run,d.previousCheck),a=previous?.kind==="component" && changeOffer(run,previous);
		if(d.evaluator || !a || a.failed!==e.id || !previous?.runnerClaim || previous.commit!==a.assembly || a.decision?.status!=="answered" ||
			!a.patch?.owner || !(checkReceipt(previous)?.exit===1 || checkReceipt(previous)?.exit===0 && inspectionAt(run,previous.id)?.state==="changes"))return false;
	}
	if(d.evaluator){
		if(d.automatic || ![run.policy.goalCheck,run.policy.productCheck].includes(d.evaluator) || goal.id!==e.id || p.target!==d.target || d.product!==p.commit || d.parts.length!==1 ||
			d.assembly!==((d.evaluator===run.policy.goalCheck?goal.evaluatorRevision:goal.productEvaluatorRevision)??run.policy.base))return false;
	}else if(!join || !failGrain || !pin || pin.goal!==d.goal || pin.checkpoint!==p.check || join.target!==pin.revision ||
		d.product!==d.assembly || d.assembly!==(parent?.assembly??join.commit) || d.assembly!==e.commit || parent &&
		(parent.decision?.status!=="answered" || parent.decision.answer!==parent.rollout?.blob || !failedComponent(effectAt(run,joined)) || !d.finding && checkReceipt(e)?.exit!==1))return false;
	if(d.finding){
		const r=parent?.rollout,i=recordedFinding(run,e,d.finding),[part]=d.parts;
		if(!r || !i || !failGrain || e.kind!=="component" ||
			d.automatic || d.evaluator || d.previousCheck || d.parts.length!==1 || part.source.kind!=="owned" || part.source.grain!==failGrain)return false;
		// The draft records the signed prefix, not its time relative to later claims.
		// Whether the remaining slots are still unissued is a live spend check.
		const {checks}=rolloutSlots(run,parent),members=Object.keys(r.owners);
		const prefix=checks.slice(0,checks.findIndex(c=>c.id===d.finding?.frontier)+1);
		if(!prefix.includes(e) || prefix.some((c,k)=>c.issuer!==run.owner || c.check!==effectAt(run,r.owners[members[k]]?.component)?.check ||
			!observedComponent(c,members[k],d.assembly)))return false;
		const owner=r.owners[failGrain],changes=r.files.filter(f=>within(i.scope,f.file));
		if(!owner || part.source.component!==owner.component || part.source.output!==owner.output || part.files.some(f=>{
			const delta=changes.find(d=>d.file===f.file);
			return !f.before || !within(i.scope,f.file) || !citedLine(i.summary??"",f.file) || changes.length>0 && (delta?.result!==f.before || delta.mode!==f.mode);
		}))return false;
	}
	return d.parts.every(({source:s,files})=>{
		if(files.some(f=>protectedDraftPath(run,f.file,pin,d.evaluator)))return false;
		if(s.kind==="evaluator")return !!d.evaluator && s.grant===d.evaluator;
		if(d.evaluator || !join || !failGrain)return false;
		if(s.kind==="harness")return !d.automatic && files.every(f=>f.file.startsWith(".foundry/") &&
			s.grant===(checkerPaths(run).find(c=>c===f.file || contains(c+".d",f.file))??f.file));
		const grain=s.kind==="owned"?s.grain:failGrain;
		if(!grain || !Object.hasOwn(join.outputs,grain))return false;
		const origin=effectAt(run,s.grant),declared=origin && assigningGrant(run,origin,grain),r=declared?.output;
		const restored=origin?.kind==="writer" && origin.restoration && historicalGrant(run,origin.restoration.from,origin.restoration.historical);
		const c=s.kind==="owned"?effectAt(run,s.component):undefined;
		// A fixed scout names its grain, not its directory. Trace that grant through the
		// rollout's original published inspection instead of borrowing today's node.
		const fixed=d.finding && typeof r==="string" && e.kind==="component" ? priorReview(run,e)?.scope : undefined;
		const directory=r && typeof r==="object"?r.directory:restored?restored.scope.primary:d.finding?undefined:run.nodes[grain]?.grain.directory;
		const checker=c?.check??(r && typeof r==="object"?r.check:restored?restored.grain.check:run.nodes[grain]?.grain.check);
		const charter=directory && checker && assigningCharter(run,grain,directory,checker,origin,true),scope=fixed??(directory && ownership(directory));
		if(!scope || !fixed && !charter || !origin || run.effects.indexOf(origin)>=run.effects.indexOf(e))return false;
		if(s.kind==="inherited")return !d.automatic && !!charter && files.every(f=>!!f.before && covers(charter.areas,f.file) &&
			!Object.entries(join.outputs).some(([id])=>join.ownership?.[id]?within(join.ownership[id],f.file):run.nodes[id] && covers(run.nodes[id].grain.directory,f.file)));
		return c?.kind==="component" && s.producer===originalProducer(run,grain,c) &&
			(c.runnerClaim ? !!publishedComponent(run,c.id,grain,s.output) : corroborated(run,join,p.check,grain,c,join.ownership?.[grain]??scope)) &&
			run.effects.indexOf(origin)<run.effects.indexOf(c) && run.effects.indexOf(c)<run.effects.indexOf(e) && join.outputs[grain]===s.output &&
			(!d.automatic || failGrain===grain) && files.every(f=>!f.file.startsWith(".foundry/") && within(scope,f.file) &&
				(!join.ownership || within(join.ownership[grain],f.file)));
	});
}

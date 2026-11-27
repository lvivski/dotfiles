import { corroborated, within } from "./campaign.mjs";
import { changeOffer, checkReceipt, failedComponent } from "./evidence.mjs";
import { verificationAssembly } from "./migrations.mjs";
import { historicalGrant } from "./partition.mjs";
import { publishedComponent } from "./publication.mjs";
import { outside } from "./product.mjs";
import { assigningCharter } from "./replacement.mjs";
import { contains, covers, ownership } from "./values.mjs";

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
	const path=new Set();
	for(let c=check;!path.has(c.id);){
		path.add(c.id);
		if(run.effects.slice(0,run.effects.indexOf(c)).some(w=>w.kind==="writer" && w.state==="done" && w.grain===grain && w.nativeId===c.issuer))return c.issuer;
		const a=changeOffer(run,c),prior=a?.patch?.owner?.component??a?.rollout?.owners[grain]?.component;
		const prev=run.effects.find(e=>e.id===prior);
		if(prev?.kind!=="component" || prev.grain!==grain)return;c=prev;
	}
}
/** Validate the historical grant, not today's mutable node or a directory selected by a writer.
 * @param {Run} run @param {Draft} d */
export function validDraftScope(run,d){
	const e=run.effects.find(c=>c.id===d.check),goal=run.effects.find(c=>c.id===d.goal),p=run.products.find(p=>p.check===d.checkpoint);
	if(!e?.receipt || !e.runnerClaim || goal?.kind!=="goal" || !p || goal.commit!==p.commit || ![1,2].includes(checkReceipt(goal)?.exit??-1))return false;
	const pin=run.productRepins?.find(p=>p.revision===d.target && p.targetFrom);
	const parent=e.kind==="component" && e.rollout?changeOffer(run,e):undefined,joined=parent?.failed??e.id;
	const join=pin && verificationAssembly(run,pin,joined,new Map(run.products.map(p=>[p.check,p])));
	const failGrain=parent?e.grain:failedComponent(e);
	if(d.previousCheck){
		const previous=run.effects.find(c=>c.id===d.previousCheck),a=previous?.kind==="component" && run.adoptions?.find(a=>a.id===previous.replacement);
		if(d.evaluator || !a || a.failed!==e.id || !previous?.runnerClaim || previous.commit!==a.assembly || a.decision?.status!=="answered" ||
			!(checkReceipt(previous)?.exit===1 || checkReceipt(previous)?.exit===0 && run.inspections?.some(i=>i.component===previous.id && i.state==="changes")))return false;
	}
	if(d.evaluator){
		if(d.automatic || goal.id!==e.id || p.target!==d.target || d.product!==p.commit || d.parts.length!==1 ||
			d.assembly!==((d.evaluator===run.policy.goalCheck?goal.evaluatorRevision:goal.productEvaluatorRevision)??run.policy.base))return false;
	}else if(!join || !failGrain || !pin || pin.goal!==d.goal || pin.checkpoint!==p.check || join.target!==pin.revision ||
		d.assembly!==(parent?.assembly??join.commit) || d.assembly!==e.commit || parent && (parent.decision?.status!=="answered" || checkReceipt(e)?.exit!==1))return false;
	return d.parts.every(({source:s,files})=>{
		if(files.some(f=>protectedDraftPath(run,f.file,pin,d.evaluator)))return false;
		if(s.kind==="evaluator")return !!d.evaluator && s.grant===d.evaluator;
		if(d.evaluator || !join || !failGrain)return false;
		if(s.kind==="harness")return !d.automatic && files.every(f=>f.file.startsWith(".foundry/") &&
			s.grant===(checkerPaths(run).find(c=>c===f.file || contains(c+".d",f.file))??f.file));
		const grain=s.kind==="owned"?s.grain:failGrain;
		if(!grain || !Object.hasOwn(join.outputs,grain))return false;
		const origin=run.effects.find(e=>e.id===s.grant),r=origin?.kind==="scout" && origin.observation?.grains.find(g=>typeof g==="object" && g.id===grain);
		const restored=origin?.kind==="writer" && origin.restoration && historicalGrant(run,origin.restoration.from,origin.restoration.historical);
		const directory=r && typeof r==="object"?r.directory:restored?restored.scope.primary:run.nodes[grain]?.grain.directory;
		const c=s.kind==="owned"?run.effects.find(e=>e.id===s.component):undefined;
		const checker=c?.check??(r && typeof r==="object"?r.check:restored?restored.grain.check:run.nodes[grain]?.grain.check);
		const charter=directory && checker && assigningCharter(run,grain,directory,checker,origin,true);
		if(!charter || !directory || !origin || run.effects.indexOf(origin)>=run.effects.indexOf(e))return false;
		if(s.kind==="inherited")return !d.automatic && files.every(f=>!!f.before && covers(charter.areas,f.file) &&
			!Object.entries(join.outputs).some(([id])=>join.ownership?.[id]?within(join.ownership[id],f.file):run.nodes[id] && covers(run.nodes[id].grain.directory,f.file)));
		return c?.kind==="component" && s.producer===originalProducer(run,grain,c) &&
			(c.runnerClaim ? !!publishedComponent(run,c.id,grain,s.output) : corroborated(run,join,p.check,grain,c,join.ownership?.[grain]??ownership(directory))) &&
			run.effects.indexOf(origin)<run.effects.indexOf(c) && run.effects.indexOf(c)<run.effects.indexOf(e) && join.outputs[grain]===s.output &&
			(!d.automatic || failGrain===grain) && files.every(f=>!f.file.startsWith(".foundry/") && covers(directory,f.file) &&
				(!join.ownership || within(join.ownership[grain],f.file)));
	});
}

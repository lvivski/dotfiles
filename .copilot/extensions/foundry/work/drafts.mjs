import { drafting } from "./rules/drafts.mjs";
import { transition } from "./machine.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").CorrectionDraft} Draft */
/** @typedef {import("./model.js").DraftPart} Part */
/** @typedef {import("./model.js").Artifact & {draft?:Draft,index?:number}} Ref */
/** @typedef {Pick<Part,"dispatch"|"workflow"|"reason"|"changes"|"awaitingPacket"|"continued">} Context */
/** @param {Part} part @param {string} type @param {Context} [data] */
export function movePart(part,type,data={}){
	const {dispatch,workflow,reason,changes,awaitingPacket,continued}=part;
	const result=transition(drafting,{value:part.state,context:{dispatch,workflow,reason,changes,awaitingPacket,continued}},{type,...data},{},true);
	part.state=result.snapshot.value;
	for(const k of /** @type {const} */(["dispatch","workflow","reason","changes","awaitingPacket","continued"])){
		const v=result.snapshot.context[k];if(v===undefined)delete part[k];else Object.assign(part,{[k]:v});
	}
	return result;
}
/** @param {Omit<Draft,"id">} d */
export const draftId=d=>digest([d.check,d.checkpoint,d.goal,d.target,d.product,d.assembly,d.evaluator??null,d.previousCheck??null,d.automatic,d.parts.map(p=>[p.source,p.files])]);
/** @param {Draft} d @param {Part} p */
export const partId=(d,p)=>digest([d.id,p.source,p.files]);
/** @param {Draft} d */
export const draftAllowed=d=>d.automatic ? !d.decision : d.decision?.status==="answered" && d.decision.answer===d.id;
/** @param {Draft} d */
export const draftChanges=d=>d.parts.flatMap(p=>p.changes??[]).sort((a,b)=>a.file<b.file?-1:1);
/** The imported references and checked workflow answers are separate inventories. No writer-published artifact can enter this projection.
 * @param {Run} run @returns {Ref[]} */
export function correctionRefs(run){
	return [...(run.artifacts??[]).flatMap((a,index)=>a.publisher===run.owner?[{...a,index,draft:undefined}]:[]),
		...(run.correctionDrafts??[]).flatMap(d=>d.blob && draftAllowed(d) && d.parts.every(p=>p.state==="returned" && !!p.workflow)?
			[{draft:d,base:d.target,file:"writer-correction.diff",blob:d.blob,publisher:d.parts.map(p=>p.workflow).join(", "),
				to:d.evaluator?[d.evaluator]:draftChanges(d).map(f=>f.file),...(d.evaluator?
					{evaluation:{from:d.assembly,checkpoint:d.checkpoint,goal:d.goal}}:{assembly:d.assembly})}]:[])];
}
/** @param {Ref} ref @param {string} check @param {string} assembly @param {import("./model.js").HarnessRollout["files"]} [delta] */
export const matchesDraft=(ref,check,assembly,delta)=>!ref.draft || ref.draft.check===check && ref.draft.assembly===assembly &&
	(!delta || digest(draftChanges(ref.draft))===digest([...delta].sort((a,b)=>a.file<b.file?-1:1)));
/** @param {Run} run */
export function validDrafts(run){
	const drafts=run.correctionDrafts??[];if(!drafts.length)return true;
	const workflows=new Set([...run.effects.flatMap(e=>e.workflowId?[e.workflowId]:[]),
		...(run.inspections??[]).flatMap(i=>[i.workflow,...(i.previous??[]).map(p=>p.workflow)]),
		...(run.testRepairs??[]).flatMap(j=>[j.author,j.reviewer,j.workflow])]);
	const tickets=new Set(),ids=new Set();
	for(const d of drafts){
		const c=run.effects.find(c=>c.id===d.check),checkpoint=run.products.find(p=>p.check===d.checkpoint),goal=run.effects.find(e=>e.id===d.goal);
		if(ids.has(d.id) || d.id!==draftId(d) || !c?.runnerClaim || !c.receipt || !checkpoint || goal?.kind!=="goal" || goal.commit!==checkpoint.commit ||
			!d.parts.length || d.automatic===!!d.decision || d.decision?.status==="answered" && d.decision.answer!==d.id ||
			d.previous && (d.automatic || d.previous.some(p=>p.status!=="unavailable" && p.status!=="dismissed")) ||
			(d.evaluator ? d.check!==d.goal || d.product!==checkpoint.commit || ![run.policy.goalCheck,run.policy.productCheck].includes(d.evaluator) :
				d.assembly!==c.commit || d.product!==d.assembly || !(c.kind==="product" || c.kind==="component" && c.rollout)))return false;
		ids.add(d.id);
		const files=d.parts.flatMap(p=>p.files.map(f=>f.file)),sources=new Set();
		if(new Set(files).size!==files.length)return false;
		for(const p of d.parts){
			const key=digest(p.source);
			if(sources.has(key) || !p.files.length ||
				p.source.kind==="owned" && (!p.source.grain || !p.source.output || !p.source.component ||
					!run.effects.some(e=>e.id===p.source.component && e.kind==="component" && e.grain===p.source.grain && e.commit===p.source.output)) ||
				d.automatic && (p.source.kind!=="owned" || d.parts.length!==1 || p.files.some(f=>!f.before)) ||
				p.state!=="ready" && !draftAllowed(d) || !!p.changes!==(p.state==="returned") ||
				(p.state==="issued" || p.state==="returned") && !p.dispatch || p.state==="ready" && (p.dispatch || p.workflow) ||
				p.workflow && (!p.dispatch || workflows.has(p.workflow)) || p.dispatch && tickets.has(p.dispatch) ||
				(p.awaitingPacket || p.continued) && !p.workflow || p.awaitingPacket && p.state==="returned" ||
				p.state==="returned" && (!p.workflow || !p.changes?.length) ||
				p.changes && (new Set(p.changes.map(f=>f.file)).size!==p.changes.length || p.changes.some(f=>f.result===f.before ||
					!p.files.some(b=>b.file===f.file && b.before===f.before && b.mode===f.mode))))return false;
			sources.add(key);if(p.workflow)workflows.add(p.workflow);if(p.dispatch)tickets.add(p.dispatch);
		}
		if(!!d.blob!==d.parts.every(p=>p.state==="returned"))return false;
	}
	return true;
}

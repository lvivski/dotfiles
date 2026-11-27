import { drafting } from "./rules/drafts.mjs";
import { transition } from "./machine.mjs";
import { digest } from "./values.mjs";
import { memberApproval } from "./receipt.mjs";
import { draftAllowed, draftId, sameDraft } from "./consent.mjs";
export { correctionRefs, draftAllowed, draftChanges, draftId } from "./consent.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").CorrectionDraft} Draft */
/** @typedef {import("./model.js").DraftPart} Part */
/** @typedef {import("./consent.mjs").Ref} Ref */
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
/** @param {Draft} d @param {Part} p */
export const partId=(d,p)=>digest([d.id,p.source,p.files]);
/** @param {Ref} ref @param {string} check @param {string} assembly @param {import("./model.js").HarnessRollout["files"]} [delta] */
export const matchesDraft=(ref,check,assembly,delta)=>!ref.draft || sameDraft(ref.draft,check,assembly,delta);
/** @param {Run} run */
export function validDrafts(run){
	const drafts=run.correctionDrafts??[];if(!drafts.length)return true;
	const tickets=new Set(),ids=new Set();
	for(const d of drafts){
		const c=run.effects.find(c=>c.id===d.check),checkpoint=run.products.find(p=>p.check===d.checkpoint),goal=run.effects.find(e=>e.id===d.goal);
		if(ids.has(d.id) || d.id!==draftId(d) || !c?.runnerClaim || !c.receipt || !checkpoint || goal?.kind!=="goal" || goal.commit!==checkpoint.commit ||
			!d.parts.length || d.automatic===!!d.decision || d.decision?.status==="answered" && d.decision.answer!==d.id ||
			d.previous && (d.automatic || d.previous.some(p=>p.status!=="unavailable" && p.status!=="dismissed")) ||
			(d.evaluator ? d.check!==d.goal || d.product!==checkpoint.commit || ![run.policy.goalCheck,run.policy.productCheck].includes(d.evaluator) :
				d.assembly!==c.commit || d.product!==d.assembly || !(c.kind==="product" || memberApproval(c))))return false;
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
				p.workflow && !p.dispatch || p.dispatch && tickets.has(p.dispatch) ||
				(p.awaitingPacket || p.continued) && !p.workflow || p.awaitingPacket && p.state==="returned" ||
				p.state==="returned" && (!p.workflow || !p.changes?.length) ||
				p.changes && (new Set(p.changes.map(f=>f.file)).size!==p.changes.length || p.changes.some(f=>f.result===f.before ||
					!p.files.some(b=>b.file===f.file && b.before===f.before && b.mode===f.mode))))return false;
			sources.add(key);if(p.dispatch)tickets.add(p.dispatch);
		}
		if(!!d.blob!==d.parts.every(p=>p.state==="returned"))return false;
	}
	return true;
}

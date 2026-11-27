import { fail, text } from "./values.mjs";

/** @typedef {import("./model.js").Review|import("./model.js").Inspection|import("./model.js").TestRepair|import("./model.js").DraftPart} Holder */
/** Only scouts in the same issuer's native call share an identity. Other owners use object
 * identity within this snapshot, including each inspection's retained prior attempts.
 * @param {import("./model.js").Review} scout */
const batch=scout=>scout.callId?JSON.stringify([scout.issuer,scout.callId]):scout;

/** An acknowledgment can bind a ticket, but it is neither packet delivery nor a verdict.
 * @param {{runId:string,workflowName?:string}|undefined} reply @param {string} definition @param {string} [expected] */
export const repliedWorkflow=(reply,definition,expected)=>reply && typeof reply.runId==="string" && reply.runId.length &&
	(reply.workflowName===undefined || reply.workflowName===definition) && (expected===undefined || reply.runId===expected)?reply.runId:undefined;

/** @param {string} status */
export const terminalWorkflow=status=>["completed","failed","error","cancelled"].includes(status);

/** One rule for an incoming binding and a restored ledger. On admission only collect the
 * requested ID, not a second full workflow index for a mutable draft.
 * @param {import("./model.js").Run} run @param {{holder:Holder,id:string}} [proposed] */
export function validWorkflows(run,proposed){
	/** @type {Map<string,object|string>} */ const owners=new Map();
	/** @param {string|undefined} id @param {object|string} owner */
	function bind(id,owner){
		if(!id || proposed && id!==proposed.id)return true;
		if(owners.has(id))return owners.get(id)===owner;
		owners.set(id,owner);return true;
	}
	for(const e of run.effects)if(e.kind==="scout" && e.workflowId && (!proposed || proposed.id===e.workflowId) && !bind(e.workflowId,batch(e)))return false;
	for(const i of run.inspections??[])if(!bind(i.workflow,i) || i.previous?.some(p=>!bind(p.workflow,p)))return false;
	for(const j of run.testRepairs??[]){
		if(j.author && (j.author===j.reviewer || j.state==="reviewing" && j.author===j.workflow))return false;
		if(!bind(j.workflow,j) || !bind(j.author,j) || !bind(j.reviewer,j))return false;
	}
	for(const d of run.correctionDrafts??[])if(d.parts.some(p=>!bind(p.workflow,p)))return false;
	if(!proposed)return true;
	const {holder,id}=proposed,scout="kind" in holder && holder.kind==="scout" && run.effects.includes(holder);
	const original="workflowId" in holder?holder.workflowId:"workflow" in holder?holder.workflow:undefined;
	return (!original || original===id) && !("controls" in holder && (holder.author===id || holder.reviewer===id)) &&
		bind(id,scout?batch(holder):holder);
}

/** @param {import("./model.js").Run} run @param {Holder} holder @param {string} id */
export function workflowIdentity(run,holder,id){
	text(id,"native workflow ID");
	if(!validWorkflows(run,{holder,id}))
		fail("wrong_workflow","Native workflow already belongs to another subject or dispatch");
	return id;
}

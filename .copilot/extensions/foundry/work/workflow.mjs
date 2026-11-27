import { fail, text } from "./values.mjs";

/** @typedef {import("./model.js").Review|import("./model.js").Inspection|import("./model.js").TestRepair|import("./model.js").DraftPart} Holder */
/** Bind only an admitted native identity. Scouts in one issuer's original dispatch share a workflow;
 * all other subjects (including saved prior reviews and completed authors) are exclusive.
 * @param {import("./model.js").Run} run @param {Holder} holder @param {string} id */
export function workflowIdentity(run,holder,id){
	text(id,"native workflow ID");
	const original="kind" in holder?holder.workflowId:holder.workflow;
	if(original && original!==id || run.effects.some(e=>e.workflowId===id &&
		!("kind" in holder && e.kind==="scout" && holder.callId && e.callId===holder.callId && holder.issuer===e.issuer)) ||
		run.inspections?.some(i=>i!==holder && i.workflow===id || i.previous?.some(p=>p.workflow===id)) ||
		run.testRepairs?.some(j=>j!==holder && j.workflow===id || j.author===id || j.reviewer===id) ||
		run.correctionDrafts?.some(d=>d.parts.some(p=>p!==holder && p.workflow===id)))
		fail("wrong_workflow","Native workflow already belongs to another subject or dispatch");
	return id;
}

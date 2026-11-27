import { heldOutcome } from "./revision.mjs";

/** @typedef {Pick<import("./model.js").Effect,"evaluatorRevision"|"productEvaluatorRevision">} Evaluation */
/** @param {Evaluation} a @param {Evaluation} b */
export const sameEvaluation=(a,b)=>a.evaluatorRevision===b.evaluatorRevision && a.productEvaluatorRevision===b.productEvaluatorRevision;

/** @param {import("./model.js").NativeCall} e */
export const approvalId=e=>e.attempt?.version===3 && e.attempt.source.kind==="approval"?e.attempt.source.id:undefined;
/** The approval is an evidence reference, not permission to resume the member.
 * @param {import("./model.js").Effect|undefined} e */
export const memberApproval=e=>e?.kind==="component"?(e.attempt?.version===3?approvalId(e):e.rollout):undefined;

/** @param {import("./model.js").NativeCall[]} batch @param {string} id @param {boolean} withdrawn @param {boolean} [allowPass] */
export function stoppedMembers(batch,id,withdrawn,allowPass=false){
	const pos=batch.findIndex(c=>c.id===id);
	if(pos>=0 && batch.every((c,i)=>i<=pos ? c.runnerClaim && (i<pos?checkReceipt(c)?.exit===0:[1,2,...allowPass?[0]:[]].includes(checkReceipt(c)?.exit??-1)) :
		c.state===(withdrawn?"withdrawn":"ready") && !c.callId && !c.runnerStarted && !c.runnerClaim && !c.receipt && !c.permissionHold))return batch;
}

/** Native shell completion alone does not identify an evaluator outcome.
 * @param {import("./model.js").Effect|undefined} e */
export function checkReceipt(e){
	if(e?.tool==="bash" && !heldOutcome(e) && e.runnerStarted && (e.attempt===undefined || e.attempt.version===1 || e.runnerClaim) && e.state==="done" && e.receipt &&
		e.receipt.commit===e.commit && e.receipt.check===e.check && sameEvaluation(e.receipt,e))return e.receipt;
}

/** One fact for different powers: exact positive role and signed observation, in
 * the recipient's historical prefix. Approving an output remains a separate fact.
 * @param {import("./model.js").Run} run @param {number} before @param {import("./model.js").Effect|undefined} e
 * @param {"component"|"product"|"goal"} use @param {string} commit */
export function signedFact(run,before,e,use,commit){
	const r=e?.kind===use && checkReceipt(e);
	if(r && e?.runnerClaim && e.commit===commit && run.effects.indexOf(e)>=0 && run.effects.indexOf(e)<before)
		return {kind:/** @type {const} */("signed"),check:e.id,use,commit,exit:r.exit};
}

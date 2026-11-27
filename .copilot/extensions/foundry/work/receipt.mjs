import { heldOutcome } from "./revision.mjs";

/** @typedef {Pick<import("./model.js").Effect,"evaluatorRevision"|"productEvaluatorRevision">} Evaluation */
/** @param {Evaluation} a @param {Evaluation} b */
export const sameEvaluation=(a,b)=>a.evaluatorRevision===b.evaluatorRevision && a.productEvaluatorRevision===b.productEvaluatorRevision;

/** Native shell completion alone does not identify an evaluator outcome.
 * @param {import("./model.js").Effect|undefined} e */
export function checkReceipt(e){
	if(e?.tool==="bash" && !heldOutcome(e) && e.runnerStarted && (e.attempt?.version!==2 || e.runnerClaim) && e.state==="done" && e.receipt &&
		e.receipt.commit===e.commit && e.receipt.check===e.check && sameEvaluation(e.receipt,e))return e.receipt;
}

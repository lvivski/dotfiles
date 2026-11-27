import { activity } from "./rules/activity.mjs";
import { randomUUID } from "node:crypto";
import { executor } from "./adapter.mjs";
import { invalidatePresentation } from "./dialog.mjs";
import { transition } from "./machine.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {Pick<Run,"policyHold"|"pauseReason">} Context */
/** @typedef {{type:"pause"|"resume"|"goal-met"} | {type:"policy-hold",hold:NonNullable<Run["policyHold"]>,reason:string} |
 * {type:"policy-ready",issuer:string,token:string}} ActivityEvent */

const applyActivity=executor(activity,{"withdraw-target-proposal":(/** @type {Run} */ run)=>{
	if(!run.targetProposal)return;
	invalidatePresentation(run.adoptions?.at(-1),"Run stopped during target approval. No target was adopted.");
	delete run.targetProposal;
}});

/** Project the ledger; a qualified one-off product does not terminate a goal-less run.
 * @param {Run} run @param {ActivityEvent} event */
export function sendActivity(run,event) {
	const value=run.active ? "active" : run.goal && run.products.at(-1)?.qualifiedAt ? "qualified" : run.policyHold ? "held" : "paused";
	/** @type {Context} */ const context={...(run.policyHold && {policyHold:run.policyHold}),
		...(run.pauseReason!==undefined && {pauseReason:run.pauseReason})};
	const result=transition(activity,{value,context},event,{},event.type!=="policy-ready");
	if (result.edge) {
		const {policyHold,pauseReason}=result.snapshot.context;
		run.active=result.snapshot.value==="active";
		if (policyHold===undefined) delete run.policyHold; else run.policyHold=policyHold;
		if (pauseReason===undefined) delete run.pauseReason; else run.pauseReason=pauseReason;
		applyActivity(result,run);
	}
	return result;
}

/** @param {Run} run @param {"pause"|"resume"|"goal-met"} signal */
export function activate(run,signal) {
	sendActivity(run,{type:signal});
}
/** @param {Run} run @param {NonNullable<Run["policyHold"]>} hold @param {string} reason */
export function hold(run,hold,reason) {
	sendActivity(run,{type:"policy-hold",hold,reason});
}
/** Both native dispatch and candidate review record a managed hold on the exact blocked reservation.
 * @param {Run} run @param {{id:string,issuer:string}} effect @param {string} reason */
export function holdFor(run,effect,reason){
	hold(run,{issuer:effect.issuer,effect:effect.id,token:randomUUID()},reason);
}
/** @param {Run} run @param {string} actor @param {string} token */
export function permitted(run,actor,token) {
	sendActivity(run,{type:"policy-ready",issuer:actor,token});
}

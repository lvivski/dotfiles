import { randomUUID } from "node:crypto";
import { executor } from "./adapter.mjs";
import { invalidatePresentation } from "./dialog.mjs";
import { machine, guard, to, transition, update } from "./machine.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {Pick<Run,"policyHold"|"pauseReason">} Context */
/** @typedef {{type:"pause"|"resume"|"goal-met"} | {type:"policy-hold",hold:NonNullable<Run["policyHold"]>,reason:string} |
 * {type:"policy-ready",issuer:string,token:string}} ActivityEvent */

const clearHold=update("clearHold",(/** @type {Context} */ {policyHold,pauseReason,...rest})=>rest);
const recordHold=update("recordHold",(/** @type {Context} */ ctx,/** @type {Extract<ActivityEvent,{type:"policy-hold"}>} */ e)=>{
	const {issuer,effect,token}=e.hold ?? {};
	if (![issuer,effect,token].every(v=>typeof v==="string" && v.length) || typeof e.reason!=="string")
		throw Error("A policy hold needs its issuer, effect, token and reason");
	return {...ctx,policyHold:{issuer,effect,token},pauseReason:e.reason};
});
const pause={...to("pause","paused","Stop new work without discarding issued calls or checked outputs."),...clearHold},
	resume={...to("resume","active","Continue eligible work on the original run under the operator's direction."),...clearHold};
export const activity=machine("activity","active",{
	active:[{...pause,action:"withdraw-target-proposal"},resume,{...to("policy-hold","held","Suspend dispatch while the issuing session cannot confirm managed permissions."),...recordHold,action:"withdraw-target-proposal"},
		{...to("goal-met","qualified","End dispatch after the accepted product meets the release conditions."),...clearHold,action:"withdraw-target-proposal"}],
	held:[pause,resume,{...to("policy-ready","active","Clear only the issuing session's matching permission hold."),
		...guard("sameHold",(/** @type {Context} */ ctx,/** @type {Extract<ActivityEvent,{type:"policy-ready"}>} */ e)=>
			!!ctx.policyHold && ctx.policyHold.issuer===e.issuer && ctx.policyHold.token===e.token),...clearHold}],
	paused:[pause,resume],
	qualified:[{...to("pause","qualified","Keep the finished product qualified; pausing it creates no new work."),...clearHold}],
},{description:"Controls whether this run may schedule work.",states:{
	active:"The scheduler may admit work within the current brief, budget and permissions.",
	held:"Dispatch is suspended by a recorded permission hold. Its issuer can observe when that same hold clears.",
	paused:"The run keeps its work and receipts. Only an operator-directed resume can restart scheduling.",
	qualified:"The accepted commit is ready for handoff. No more work is scheduled.",
}});

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

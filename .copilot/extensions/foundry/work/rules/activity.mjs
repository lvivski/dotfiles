import { guard, machine, to, update } from "../machine.mjs";

/** @typedef {import("../activity.mjs").Context} Context */
/** @typedef {import("../activity.mjs").ActivityEvent} ActivityEvent */
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

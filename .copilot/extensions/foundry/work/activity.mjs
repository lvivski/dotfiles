import { chart, select, step, to } from "./chart.mjs";

const pause=to("pause","paused","Stop new work without discarding issued calls or checked outputs."),
	resume=to("resume","active","Continue eligible work on the original run under the operator's direction.");
export const activity=chart("activity","active",{
	active:[pause,resume,to("policy-hold","held","Suspend dispatch while the issuing session cannot confirm managed permissions."),
		to("goal-met","qualified","End dispatch after the accepted product meets the release conditions.")],
	held:[pause,resume,{...to("policy-ready","active","Clear only the issuing session's matching permission hold."),when:["sameHold"]}],
	paused:[pause,resume],
	qualified:[to("pause","qualified","Keep the finished product qualified; pausing it creates no new work.")],
},{description:"Controls whether this run may schedule work.",states:{
	active:"The scheduler may admit work within the current brief, budget and permissions.",
	held:"Dispatch is suspended by a recorded permission hold. Its issuer can observe when that same hold clears.",
	paused:"The run keeps its work and receipts. Only an operator-directed resume can restart scheduling.",
	qualified:"The accepted commit is ready for handoff. No more work is scheduled.",
}});
/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run */
const phase=run=>run.active ? "active" : run.goal && run.products.at(-1)?.qualifiedAt ? "qualified" : run.policyHold ? "held" : "paused";
/** @param {Run} run @param {"pause"|"resume"|"goal-met"} signal */
export function activate(run,signal) {
	run.active=select(activity,phase(run),signal).target==="active";
	delete run.policyHold;delete run.pauseReason;
}
/** @param {Run} run @param {NonNullable<Run["policyHold"]>} hold @param {string} reason */
export function hold(run,hold,reason) {
	const edge=select(activity,phase(run),"policy-hold");
	run.active=edge.target==="active";run.policyHold=hold;run.pauseReason=reason;
}
/** @param {Run} run @param {string} actor @param {string} token */
export function permitted(run,actor,token) {
	const edge=step(activity,phase(run),"policy-ready",{sameHold:run.policyHold?.issuer===actor && run.policyHold.token===token});
	if (edge) {run.active=edge.target==="active";delete run.policyHold;delete run.pauseReason;}
}

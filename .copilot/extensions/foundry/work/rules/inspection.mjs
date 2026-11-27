import { guard, machine, to, update } from "../machine.mjs";
import { text } from "../values.mjs";

/** @typedef {import("../inspection.mjs").Context} Context */
/** @typedef {import("../inspection.mjs").Data} Data */
const issue=update("claim-review",(/** @type {Context} */ c,/** @type {Data} */ e)=>({
	issuer:c.issuer,...(c.previous && {previous:c.previous}),dispatch:text(e.dispatch,"review dispatch"),
}));
const bind=update("bind-workflow",(/** @type {Context} */ {summary,...c},/** @type {Data} */ e)=>({
	...c,workflow:text(e.workflow,"bound review workflow"),
}));
const verdict=update("record-review",(/** @type {Context} */ c,/** @type {Data} */ e)=>({...c,summary:text(e.summary,"review finding or conclusion")}));
const ready=update("release-unstarted-review",(/** @type {Context} */ c)=>({issuer:c.issuer,...(c.previous && {previous:c.previous})}));
const retry=update("retain-unavailable-review",(/** @type {Context} */ c,/** @type {{issuer:string}} */ e)=>({
	issuer:text(e.issuer,"next issuer"),previous:[...c.previous??[],{issuer:c.issuer,dispatch:text(c.dispatch,"original dispatch"),
		workflow:text(c.workflow,"terminal review workflow"),summary:text(c.summary,"original diagnostic")}],
}));
const bound=guard("bound",(/** @type {Context} */ c)=>!!c.dispatch && !!c.workflow);
export const inspection=machine("inspection","ready",{
	ready:[{...to("issue","issued","Claim this exact candidate before starting its independent review."),...issue},
		{...to("resume","ready","The owner may take an unissued review after checking permission, never another issuer's hold or ticket."),
			...guard("unticketed",(/** @type {Context} */ c)=>!c.dispatch && !c.workflow),when:["transferable","unticketed"],
			...update("transfer-unissued-review",(/** @type {Context} */ c,/** @type {{issuer:string}} */ e)=>({...c,issuer:text(e.issuer,"resuming owner")}))}],
	issued:[
		{...to("bind","issued","Bind the original native workflow; a second identity cannot replace it."),
			...guard("sameWorkflow",(/** @type {Context} */ c,/** @type {Context} */ e)=>!!c.dispatch && (!c.workflow || c.workflow===e.workflow)),...bind},
		{...to("capacity","ready","The host confirmed no workflow was admitted; retain the review for an available slot."),
			...guard("unbound",(/** @type {Context} */ c)=>!!c.dispatch && !c.workflow),...ready},
		{...to("approved","approved","Record the bound reviewer's approval for these bytes."),...bound,...verdict},
		{...to("changes","changes","Return the bound reviewer's blocking findings to this assignment."),...bound,...verdict},
		{...to("unavailable","unavailable","Record why the bound workflow could not return a usable review; keep the candidate unpublished."),...bound,...verdict},
	],
	unavailable:[{...to("resume","ready","On explicit resume, retain the bound unavailable attempt before reviewing the same pins again."),...bound,...retry}],
	approved:[],changes:[],
},{description:"Records one independent Rubber Duck code review of an immutable component candidate.",states:{
	ready:"A component passed; no review has been issued for this candidate.",
	issued:"Only the original dispatch may bind or return a review; missing history is not a verdict.",
	approved:"This review found no blocking issue. Other component, product and goal checks still apply.",
	changes:"This exact candidate has blocking findings and cannot be consumed.",
	unavailable:"No usable review was obtained. This is not a code defect or permission to publish.",
}});

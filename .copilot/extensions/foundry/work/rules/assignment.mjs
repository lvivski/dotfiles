import { machine, to, update } from "../machine.mjs";

/** @typedef {import("../assignment.mjs").Context} Context */
/** @typedef {import("../assignment.mjs").Outcome} Outcome */
const clearReason=update("clearReason",(/** @type {Context} */ {reason,...rest})=>rest);
const recordReason=update("recordReason",(/** @type {Context} */ ctx,/** @type {{reason?:string}} */ event)=>
	event.reason===undefined ? ctx : {...ctx,reason:event.reason});
const queueRepair=update("queueRepair",(/** @type {Context} */ ctx,/** @type {Outcome} */ event)=>({...ctx,reason:event.reason}));
const replacePublished=update("replaceIntegratedOutput",(/** @type {Context} */ {replaces,...ctx},/** @type {Outcome} */ event)=>({
	...ctx,reason:event.reason,...(event.candidate!==undefined && {replaces:event.candidate}),
}));
const noMoreRepairs=update("recordRepairLimit",(/** @type {Context} */ ctx,/** @type {Outcome} */ e)=>({...ctx,reason:`${e.id}: repair limit exhausted: ${e.reason}`}));
const failedAttestation=update("recordAttestationFailure",(/** @type {Context} */ ctx,/** @type {Outcome} */ e)=>({...ctx,reason:e.observer?.final ?
	`Final diagnostic ${e.observer.check} stopped on ${e.id}. Run owner: request the production form of foundry_grant for a repository regression and evidence-backed fix in the owning directory. A missing phase is not a production diagnosis. No observer replay: ${e.reason}` :
	e.observer ? `The approved observer change failed. Inspect this new receipt; do not replay it: ${e.reason}` :
	`The approved unchanged directory did not pass; this ownership attestation cannot change the bytes or replay the check: ${e.reason}`}));

/** @template {string} E @param {E} on @param {typeof queueRepair | typeof replacePublished} [queue] */
const repair=(on,queue=queueRepair)=>[
	{...to(on,"blocked","Keep the failed attestation: its grant forbids changing the bytes."),when:["attestation"],...failedAttestation,action:"invalidate-consumers"},
	{...to(on,"blocked","Preserve the candidate and failure when the repair allowance is spent."),when:["exhausted"],...noMoreRepairs,action:"invalidate-consumers"},
	{...to(on,"waiting","Queue the permitted repair; the queue itself is not a write grant."),...queue,action:"invalidate-consumers"},
];
const stop={...to("stop","blocked","Record why this assignment cannot proceed under its current grant."),...recordReason},
	staff=to("staff","writing","Reserve the writer's scoped generation on its checked inputs."),
	submit=to("submit","checking","Send the submitted candidate to its component evaluator."),
	integrate=to("integrate","qualified","Record this output's inclusion in the checked product, not a release verdict."),
	paired={...to("paired-pass","published","Publish the exact output supported by the fresh component observation."),...clearReason},
	amend={...to("amend","published","Publish only the approved replacement after its own passing component and required review."),...clearReason},
	request=to("request","waiting","Put the requested output in the queue for input and writer admission.");
export const assignment=machine("assignment","idle",{
	idle:[request],
	waiting:[staff,stop,{...to("recheck","checking","Recheck the unchanged candidate with its independently certified observer before staffing a writer."),...clearReason}],
	writing:[submit,stop],
	checking:[{...to("component","reviewing","Reserve an independent review of the exact passing component before publication."),when:["passed","reviewRequired"],...clearReason,action:"reserve-inspection"},
		{...to("component","published","Honor a run activated under its original component-only contract."),when:["passed"],...clearReason},
		{...to("component","blocked","Keep the incomplete observation without treating it as a verdict."),when:["incomplete"],
			...update("recordIncompleteCheck",(/** @type {Context} */ ctx,/** @type {Outcome} */ e)=>({...ctx,reason:`Evaluation did not complete: ${e.reason}`}))},
		{...to("component","blocked","Stop because the run has no assignment budget for repair."),when:["unfunded"],
			...update("recordMissingBudget",(/** @type {Context} */ ctx,/** @type {Outcome} */ e)=>({...ctx,reason:`No assignment remains to repair ${e.id}: ${e.reason}`}))},
		...repair("component"),stop,paired],
	reviewing:[{...to("inspection","published","Publish only the candidate approved by the bound independent reviewer."),when:["approved"],...clearReason},
		{...to("inspection","blocked","The reviewer requested changes but this grant does not permit a repair."),when:["readOnly"],...recordReason},
		{...to("inspection","blocked","Keep the findings when no repair assignment remains."),when:["unfunded"],...recordReason},
		{...to("inspection","blocked","Keep the findings when the repair allowance is spent."),when:["exhausted"],...noMoreRepairs},
		{...to("inspection","waiting","Return the blocking findings to the same writer within its existing grant."),...queueRepair}],
	published:[integrate,{...to("repeat","repeated","Retain the checked output without treating an unchanged product as progress."),...recordReason},...repair("repair"),stop,staff,paired,amend],
	qualified:[integrate,...repair("repair",replacePublished),request,amend],repeated:[integrate,...repair("repair"),request,amend],
	blocked:[staff,{...to("recheck","checking","Observe the retained candidate under an authorized check."),...clearReason},...repair("repair"),paired,
		to("deliver","qualified","Record inclusion after the separately approved delivery checks pass."),stop],
},{description:"Tracks one scoped output from request through checking and integration.",states:{
	idle:"The output is known but has not been requested.",
	waiting:"The output or its repair has been requested. Inputs, a reservation or permission may still be missing.",
	writing:"A writer reservation owns this generation. Its native binding is a separate fact.",
	checking:"The candidate is frozen for its component evaluation; the writer cannot keep editing that submission.",
	reviewing:"The writer's assignment stays open while its frozen candidate awaits independent approval. Dependents cannot use it yet.",
	published:"The candidate passed its required checks and can be consumed. It is not yet an integrated product.",
	qualified:"This output was included in a checked product. The whole run has a separate release decision.",
	repeated:"This checked output would reproduce an already assessed product.",
	blocked:"A recorded stop prevents this assignment from continuing on its current terms.",
}});

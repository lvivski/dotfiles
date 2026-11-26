import { executor } from "./adapter.mjs";
import { machine, to, transition, update } from "./machine.mjs";
import { publicationVerdict } from "./publication.mjs";

/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {Pick<Node,"reason"|"replaces">} Context */
/** @typedef {{type:"component"|"repair"|"inspection",id:string,reason:string,candidate?:string,observer?:{check:string,final:boolean}}} Outcome */
/** @typedef {{passed:boolean,incomplete:boolean,unfunded:boolean}} Component */

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
	request=to("request","waiting","Put the requested output in the queue for input and writer admission.");
export const assignment=machine("assignment","idle",{
	idle:[request],
	waiting:[staff,stop],
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
	published:[integrate,{...to("repeat","repeated","Retain the checked output without treating an unchanged product as progress."),...recordReason},...repair("repair"),stop,staff,paired],
	qualified:[integrate,...repair("repair",replacePublished),request],repeated:[integrate,...repair("repair"),request],
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

/** Checking and independent review freeze submissions without releasing the writer's assignment.
 * @param {Node} n */
export const frozenSubmission=n=>n.state==="checking" || n.state==="reviewing";
/** @param {Node} n */
export const working=n=>n.state==="writing" || frozenSubmission(n);

/** @param {Node} node */
const snapshot=node=>({value:node.state,context:{
	...(node.reason!==undefined && {reason:node.reason}),...(node.replaces!==undefined && {replaces:node.replaces}),
}});
/** @param {Node} node @param {{value:Node["state"],context:Context}} next */
function apply(node,{value,context}) {
	node.state=value;
	if (context.reason===undefined) delete node.reason; else node.reason=context.reason;
	if (context.replaces===undefined) delete node.replaces; else node.replaces=context.replaces;
}

/** @typedef {Exclude<(typeof assignment.states)[keyof typeof assignment.states][number]["on"],"component"|"repair"|"inspection">} Command */
/** @param {Node} node @param {Command|{type:"stop"|"repeat",reason:string}} signal */
export function assign(node,signal) {
	const event=typeof signal==="string" ? {type:signal} : signal;
	const result=transition(assignment,snapshot(node),event,{},true);
	apply(node,result.snapshot);
	return result;
}

/** @typedef {{invalidate:()=>void,reserve?:()=>void}} Actions */
const carryOut=executor(assignment,{"invalidate-consumers":(/** @type {Actions} */ a)=>a.invalidate(),
	"reserve-inspection":(/** @type {Actions} */ a)=>{if(!a.reserve)throw Error("Missing independent review reservation");a.reserve();}});

/** The caller verifies the exact check/attempt. Invalidation must succeed on the old pins
 * before installing the producer's new state; it cannot change the selected transition.
 * @param {Run} run @param {string} id @param {string} reason @param {Component|undefined} component
 * @param {(run:Run,id:string,version:string|undefined)=>void} invalidateConsumers @param {()=>void} [reserve] */
export function componentOutcome(run,id,reason,component,invalidateConsumers,reserve) {
	const node=run.nodes[id], candidate=node.candidate;
	const check=node.restoration && run.effects.find(e=>e.id===node.check);
	/** @type {Outcome} */ const event={type:component ? "component" : "repair",id,reason,candidate,
		...(check?.kind==="component" && check.observer && {observer:{check:check.id,final:!!check.observer.previous}})};
	const result=transition(assignment,snapshot(node),event,{...component,reviewRequired:!!run.inspections,attestation:!!node.restoration,exhausted:node.repairs>=run.policy.repairs},true);
	carryOut(result,{invalidate:()=>invalidateConsumers(run,id,candidate),reserve});
	apply(node,result.snapshot);
	return result;
}

/** @param {Run} run @param {Node} node @param {import("./model.js").Inspection} i @param {number} remaining */
export function inspectionOutcome(run,node,i,remaining) {
	const verdict=publicationVerdict(i);
	if(!verdict)return;
	const readOnly=!!node.restoration || !node.worker;
	const reason=`Rubber Duck requested changes on ${i.candidate}: ${i.summary}`+
		(readOnly ? " This grant does not authorize changing those bytes." : !remaining ? " No repair assignment remains." : "");
	const result=transition(assignment,snapshot(node),{type:"inspection",id:node.grain.id,reason},{
		approved:verdict==="approved",unfunded:!remaining,exhausted:node.repairs>=run.policy.repairs,readOnly,
	},true);
	apply(node,result.snapshot);
}

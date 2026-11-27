import { assignment } from "./rules/assignment.mjs";
import { executor } from "./adapter.mjs";
import { transition } from "./machine.mjs";
import { componentDecision } from "./publication.mjs";

/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {Pick<Node,"reason"|"replaces">} Context */
/** @typedef {{type:"component"|"repair"|"inspection",id:string,reason:string,candidate?:string,observer?:{check:string,final:boolean}}} Outcome */
/** @typedef {{passed:boolean,incomplete:boolean,unfunded:boolean}} Component */

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
	const decision=componentDecision(run,node.check,node.grain.id,node.candidate);
	if(!decision?.review || decision.review.id!==i.id)return;
	const readOnly=!!node.restoration || !node.worker;
	const reason=`Rubber Duck requested changes on ${decision.review.candidate}: ${decision.review.summary}`+
		(readOnly ? " This grant does not authorize changing those bytes." : !remaining ? " No repair assignment remains." : "");
	const result=transition(assignment,snapshot(node),{type:"inspection",id:node.grain.id,reason},{
		approved:decision.verdict==="approved",unfunded:!remaining,exhausted:node.repairs>=run.policy.repairs,readOnly,
	},true);
	apply(node,result.snapshot);
}

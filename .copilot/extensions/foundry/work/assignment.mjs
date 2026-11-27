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

/** @typedef {{invalidate:()=>void,reserve?:()=>void}} Actions */
const carryOut=executor(assignment,{"invalidate-consumers":(/** @type {Actions} */ a)=>a.invalidate(),
	"reserve-inspection":(/** @type {Actions} */ a)=>{if(!a.reserve)throw Error("Missing independent review reservation");a.reserve();}});

/** @template {{type:string}} E @param {Node} node @param {E} event @param {import("./machine.mjs").Facts} [facts] @param {Actions} [actions] */
function advance(node,event,facts={},actions) {
	const result=transition(assignment,{value:node.state,context:{
		...(node.reason!==undefined && {reason:node.reason}),...(node.replaces!==undefined && {replaces:node.replaces}),
	}},event,facts,true);
	if(actions)carryOut(result,actions);else if(result.effects.length)throw Error(`Missing assignment action for ${event.type}`);
	const {value,context}=result.snapshot;
	node.state=value;
	if (context.reason===undefined) delete node.reason; else node.reason=context.reason;
	if (context.replaces===undefined) delete node.replaces; else node.replaces=context.replaces;
	return result;
}

/** @typedef {Exclude<(typeof assignment.states)[keyof typeof assignment.states][number]["on"],"component"|"repair"|"inspection">} Command */
/** @param {Node} node @param {Command|{type:"stop"|"repeat",reason:string}} signal */
export const assign=(node,signal)=>advance(node,typeof signal==="string" ? {type:signal} : signal);
/** @param {Run} run @param {Node} node */
const repairsSpent=(run,node)=>node.repairs>=run.policy.repairs;

/** The caller verifies the exact check/attempt. Invalidation must succeed on the old pins
 * before installing the producer's new state; it cannot change the selected transition.
 * @param {Run} run @param {string} id @param {string} reason @param {Component|undefined} component
 * @param {(run:Run,id:string,version:string|undefined)=>void} invalidateConsumers @param {()=>void} [reserve] */
export function componentOutcome(run,id,reason,component,invalidateConsumers,reserve) {
	const node=run.nodes[id], candidate=node.candidate;
	const check=node.restoration && run.effects.find(e=>e.id===node.check);
	/** @type {Outcome} */ const event={type:component ? "component" : "repair",id,reason,candidate,
		...(check?.kind==="component" && check.observer && {observer:{check:check.id,final:!!check.observer.previous}})};
	return advance(node,event,{...component,reviewRequired:!!run.inspections,attestation:!!node.restoration,exhausted:repairsSpent(run,node)},
		{invalidate:()=>invalidateConsumers(run,id,candidate),reserve});
}

/** @param {Run} run @param {Node} node @param {import("./model.js").Inspection} i @param {number} remaining */
export function inspectionOutcome(run,node,i,remaining) {
	const decision=componentDecision(run,node.check,node.grain.id,node.candidate);
	if(!decision?.review || decision.review.id!==i.id)return;
	const reason=`Rubber Duck requested changes on ${decision.review.candidate}: ${decision.review.summary}`;
	advance(node,{type:"inspection",id:node.grain.id,reason},{
		approved:decision.verdict==="approved",unfunded:!remaining,readOnly:!!node.restoration || !node.worker,exhausted:repairsSpent(run,node),
	});
}

import { machine, to, transition, update } from "./machine.mjs";
import { checkReceipt, generationOf } from "./evidence.mjs";
import { assignmentCalls, liveNeeds } from "./plan.mjs";

/** @typedef {NonNullable<ReturnType<typeof unavailable>>} Check */
/** @typedef {{held:string[],retained:Check[]}} Queue */
/** @param {string} reason */
const hold=reason=>({on:"inspect",reason,...update("hold-assignment",
	(/** @type {Queue} */ q,/** @type {{label:string}} */ e)=>({...q,held:[e.label]}))});
const retain={on:"inspect",when:["retarget","unissuedUnavailable"],reason:"Keep the unavailable attempt outside the adopted product",
	...update("retain-unavailable-check",(/** @type {Queue} */ q,/** @type {{check?:Check}} */ e)=>{
		if (!e.check) throw Error("Missing observation to retain during target adoption");
		return {...q,retained:[e.check]};
	})};
/** @param {string} state */
const settled=state=>[to("inspect",state,"No mutable assignment")];
export const quiescence=machine("quiescence","idle",{
	idle:settled("idle"),qualified:settled("qualified"),repeated:settled("repeated"),blocked:settled("blocked"),
	writing:[hold("Current writer reservation")],checking:[hold("Current component observation")],
	reviewing:[hold("The passing candidate still needs independent review")],
	waiting:[retain,hold("A pending assignment still needs scheduler admission")],
	published:[{...to("inspect","published","Recheck the published output on the adopted assembly"),when:["retarget"]},hold("Pending integration")],
},{description:"Determines whether an assignment needs current authority before a checkpoint or target can change.",states:{
	idle:"No work was requested for this output.",qualified:"The output already belongs to a checked product.",
	repeated:"The output was retained without a changed product.",blocked:"The stop is recorded; it is not an active writer or evaluator.",
	writing:"A writer reservation must be accounted for before changing the assembly.",checking:"An outstanding component observation must keep its original inputs.",
	reviewing:"A candidate in code review cannot be adopted or treated as a published output.",
	waiting:"Distinguish a live queue obligation from an unavailable observation that nobody can act on.",
	published:"A component passed but awaits integration; adoption requires observing it on the new assembly.",
}});

/** An unavailable first observation is not a writable repair or a checked output.
 * Never retire a live grant, a consumed pin or special ownership through target adoption.
 * @param {import("./model.js").Run} run @param {import("./model.js").Node} n */
function unavailable(run,n) {
	const {id,directory}=n.grain;
	if (n.state!=="waiting" || n.repairs || !n.worker || !n.token || !n.generation || !n.candidate || !n.check ||
		typeof directory!=="string" || n.replaces || n.restoration || n.retained || n.successor || n.reuse || n.stop) return;
	const last=run.products.at(-1);
	if (!last || Object.hasOwn(last.outputs,id) || Object.values(last.outputs).includes(n.candidate) ||
		Object.values(run.nodes).some(other=>other!==n && (liveNeeds(other).includes(id) || Object.hasOwn(other.inputs ?? {},id)))) return;
	const calls=assignmentCalls(run,n), writers=calls.filter(e=>e.kind==="writer"), observations=calls.filter(e=>e.kind==="component");
	const [w]=writers,[e]=observations;
	if (writers.length!==1 || w.kind!=="writer" || w.nativeId!==n.worker || w.token!==n.token || generationOf(w)!==n.generation ||
		w.finished || w.observer || w.production || w.reuse || observations.length!==1 || e.kind!=="component" || e.id!==n.check || e.issuer!==n.worker ||
		e.commit!==n.candidate || e.check!==n.grain.check || e.inlineRepair || e.remedy || e.delivery || e.observer || e.pair || e.recheck ||
		!e.runnerClaim || calls.some(c=>!c.callId || c.state!=="done" || c.error || c.permissionHold ||
			c!==w && c!==e && c.kind!=="artifact")) return;
	const receipt=checkReceipt(e);
	if (receipt?.exit===2 && !receipt.failure) return e;
}

/** @param {import("./model.js").Run} run @param {boolean} retarget */
export function checkpointQueue(run,retarget) {
	/** @type {Queue} */ const queue={held:[],retained:[]};
	for (const n of Object.values(run.nodes)) {
		const check=retarget ? unavailable(run,n) : undefined;
		const {snapshot}=transition(quiescence,{value:n.state,context:/** @type {Queue} */ ({held:[],retained:[]})},
			{type:"inspect",label:`${n.grain.id} (${n.state})`,check},{retarget,unissuedUnavailable:!!check},true);
		queue.held.push(...snapshot.context.held);
		queue.retained.push(...snapshot.context.retained);
	}
	return queue;
}

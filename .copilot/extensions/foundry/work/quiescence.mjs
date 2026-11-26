import { chart, select } from "./chart.mjs";
import { checkReceipt, generationOf } from "./evidence.mjs";
import { assignmentCalls, liveNeeds } from "./plan.mjs";

/** @param {"hold"|"retain"|"settled"} action @param {string} reason @param {...("retarget"|"unissuedUnavailable")} when */
const edge=(action,reason,...when)=>({on:"inspect",action,reason,when});
const settled=[edge("settled","No mutable assignment")];
export const quiescence=chart("quiescence","idle",{
	idle:settled,qualified:settled,repeated:settled,blocked:settled,
	writing:[edge("hold","Current writer reservation")],checking:[edge("hold","Current component observation")],
	waiting:[edge("retain","Keep the unavailable attempt outside the adopted product","retarget","unissuedUnavailable"),
		edge("hold","A pending assignment still needs scheduler admission")],
	published:[edge("settled","Recheck the published output on the adopted assembly","retarget"),edge("hold","Pending integration")],
},{description:"Determines whether an assignment needs current authority before a checkpoint or target can change.",states:{
	idle:"No work was requested for this output.",qualified:"The output already belongs to a checked product.",
	repeated:"The output was retained without a changed product.",blocked:"The stop is recorded; it is not an active writer or evaluator.",
	writing:"A writer reservation must be accounted for before changing the assembly.",checking:"An outstanding component observation must keep its original inputs.",
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
	const held=[], retained=[];
	for (const n of Object.values(run.nodes)) {
		const check=retarget && unavailable(run,n);
		const {action}=select(quiescence,n.state,"inspect",{retarget,unissuedUnavailable:!!check});
		if (action==="hold") held.push(`${n.grain.id} (${n.state})`);
		if (action==="retain" && check) retained.push(check);
	}
	return {held,retained};
}

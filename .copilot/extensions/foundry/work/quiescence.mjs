import { quiescence } from "./rules/quiescence.mjs";
import { transition } from "./machine.mjs";
import { checkReceipt, generationOf } from "./evidence.mjs";
import { assignmentCalls, liveNeeds } from "./lineage.mjs";

/** @typedef {NonNullable<ReturnType<typeof unavailable>>} Check */
/** @typedef {{held:string[],retained:Check[]}} Queue */

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

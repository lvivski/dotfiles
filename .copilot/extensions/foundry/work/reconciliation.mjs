import { reconciliation } from "./rules/reconciliation.mjs";
import { executor } from "./adapter.mjs";
import { transition } from "./machine.mjs";

/** @typedef {Promise<void>|void} Work */
/** @typedef {(type:string,facts?:import("./machine.mjs").Facts)=>Work} Signal */
/** Join actual asynchronous work, not an extra microtask per synchronous microstep.
 * The native workflow launch is detached; caller flush does not wait for its body.
 * @param {Work[]} work @returns {Work} */
function join(work) {
	const pending=work.filter(p=>p!==undefined);
	if(pending.length>1)return Promise.all(pending).then(()=>{});
	return pending[0];
}
/** Each effect receives a continuation from its accepted snapshot. Declared sibling signals
 * fork that snapshot, not a mutable cursor; the bindings contribute facts, not destinations.
 * @param {Record<string,(send:Signal)=>void|Promise<void>>} handlers @param {{type:"wake",executable:boolean}|{type:"verify-batch"}} event
 * @param {Record<string,()=>import("./machine.mjs").Facts>} inputs */
export function reconcileWake(handlers,event,inputs) {
	const apply=executor(reconciliation,handlers);
	/** @param {{value:string,context:null}} before @param {string} type @param {import("./machine.mjs").Facts} [facts] */
	function send(before,type,facts) {
		const result=transition(reconciliation,before,{type},facts,true);
		const work=join(apply(result,(signal,facts)=>send(result.snapshot,signal,facts)));
		if (!result.fork.length) return work;
		return work ? work.then(fork) : fork();
		/** @returns {Work} */
		function fork(){
			const lanes=result.fork.map(signal=>{
				if (!Object.hasOwn(inputs,signal)) throw Error(`Missing reconciliation lane inputs: ${signal}`);
				return {signal,facts:inputs[signal]()};
			});
			return join(lanes.map(({signal,facts})=>{
				// A synchronous ledger failure is this lane's rejection, not cancellation of its peers.
				try{return send(result.snapshot,signal,facts);}catch(error){return Promise.reject(error);}
			}));
		}
	}
	return send({value:reconciliation.initial,context:null},event.type,event);
}

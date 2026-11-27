import { call, review } from "./rules/dispatch.mjs";
import { executor } from "./adapter.mjs";
import { step, transition } from "./machine.mjs";

/** @typedef {import("./model.js").Review} Review */
/** @typedef {import("./model.js").NativeCall} NativeCall */
/** @typedef {Pick<Review,"callId"|"error"|"permissionHold"|"workflowId"|"packet"|"observation"|"deferred"|"providerRecovery">} ReviewFields */
/** @typedef {Pick<NativeCall,"callId"|"error"|"nativeId"|"boundAt"|"retirement">} CallFields */
/** @typedef {ReviewFields & CallFields} Context */
export const disabledRoute="Native route disabled; execute the exact prepared call in its owner session";

/** @param {string} issuer @param {string} recipient @param {string} message
 * @returns {Pick<NativeCall,"tool"|"args">} */
export const messageTo=(issuer,recipient,message)=>issuer===recipient?{tool:"session.send",args:{message}}:
	{tool:"send_session_message",args:{session_id:recipient,delivery_mode:"immediate",message}};

const reviewKeys=/** @type {const} */ (["callId","error","permissionHold","workflowId","packet","observation","deferred","providerRecovery"]);
const callKeys=/** @type {const} */ (["callId","error","nativeId","boundAt","retirement"]);

/** An ordinary prepared call is unsent only with the recorded native route-disabled reply.
 * @param {NativeCall} e */
export const unsentRepair=e=>e.kind==="repair" && !!(e.input || e.continuation && e.baselineStop) && !e.permissionHold &&
	(e.state==="ready" && !e.callId || e.state==="ordinary" && !!e.callId && e.error===disabledRoute);

/** @template {import("./machine.mjs").States} T @template {{type:string}} E
 * @param {import("./machine.mjs").Machine<T>} model @param {Context & {state:keyof T & string}} job @param {readonly (keyof Context)[]} keys
 * @param {E} event @param {import("./machine.mjs").Facts} facts @param {boolean} required */
function send(model,job,keys,event,facts,required) {
	/** @type {Context} */ const context={};
	for (const key of keys) if (job[key]!==undefined) Object.assign(context,{[key]:job[key]});
	const result=transition(model,{value:job.state,context},event,facts,required);
	if (result.edge) {
		job.state=result.snapshot.value;
		const next=result.snapshot.context;
		for (const key of keys) if (next[key]!==context[key]) {
			if (next[key]===undefined) delete job[key]; else Object.assign(job,{[key]:next[key]});
		}
	}
	return result;
}

/** @typedef {(typeof review.states)[keyof typeof review.states][number]["on"]} ReviewSignal */
/** @typedef {(typeof call.states)[keyof typeof call.states][number]["on"]} CallSignal */
/** @typedef {{type:"issue",callId:string}|{type:"unconfirmed"|"block",error:string}|{type:"requeue",error?:string,permissionHold?:string}|
 * {type:"bind",workflowId:string}|{type:"suspend",disconnected?:boolean,error?:string}|
 * {type:"report",observation:NonNullable<Review["observation"]>,packet:NonNullable<Review["packet"]>}|
 * {type:"admit",observation:NonNullable<Review["observation"]>}|{type:"defer",observation:NonNullable<Review["observation"]>,deferred:NonNullable<Review["deferred"]>}} ReviewEvent */
/** @typedef {{type:"issue",callId:string}|{type:"unconfirmed"|"deny"|"prepare",error:string}|{type:"confirm",nativeId?:string,boundAt?:number,error?:string}|
 * {type:"retire",retirement:NonNullable<NativeCall["retirement"]>}|{type:"withdraw"}} CallEvent */
/** Required charter command, following validation of its issuer and native evidence.
 * @param {Review} job @param {ReviewSignal|ReviewEvent} signal */
export function survey(job,signal) {
	const result=send(review,job,reviewKeys,typeof signal==="string" ? {type:signal} : signal,{},true);
	if(job.state!=="blocked")delete job.obstacle;
	return result;
}
/** Required native journal command; never replay an unsupported request.
 * @param {NativeCall} job @param {CallSignal|CallEvent} signal */
export function journal(job,signal) {
	return send(call,job,callKeys,typeof signal==="string" ? {type:signal} : signal,
		{unsentInput:unsentRepair(job)},true);
}

const readmit=executor(review,{"readmit-report":(/** @type {()=>void} */ admit)=>admit()});
/** Observe late producer declarations. Only a selected transition reconsiders the saved report.
 * @param {Review} job @param {boolean} inputsCurrent @param {()=>void} admit */
export function producersDeclared(job,inputsCurrent,admit) {
	const result=send(review,job,reviewKeys,{type:"producers-declared"},{inputsCurrent},false);
	readmit(result,admit);
	return result;
}

/** Inspect eligibility without dispatching a command or running its update.
 * @param {import("./model.js").Effect} e @param {"issue"|"unconfirmed"} signal */
export function accepts(e,signal) { return !!(e.kind==="scout" ? step(review,e.state,signal) : step(call,e.state,signal)); }

/** @param {import("./model.js").Effect} e */
export const unissued = e => accepts(e,"issue");
/** @param {import("./model.js").Effect} e */
export const awaitingReply = e => accepts(e,"unconfirmed");

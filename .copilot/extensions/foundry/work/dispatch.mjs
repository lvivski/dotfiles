import { executor } from "./adapter.mjs";
import { machine, step, to, transition, update } from "./machine.mjs";

/** @typedef {import("./model.js").Review} Review */
/** @typedef {import("./model.js").NativeCall} NativeCall */
/** @typedef {Pick<Review,"callId"|"error"|"permissionHold"|"workflowId"|"packet"|"observation"|"deferred"|"providerRecovery">} ReviewFields */
/** @typedef {Pick<NativeCall,"callId"|"error"|"nativeId"|"boundAt"|"retirement">} CallFields */
/** @typedef {ReviewFields & CallFields} Context */

/** @param {Context} context @param {Context} changes */
function amend(context,changes) {
	const next={...context,...changes};
	for (const key of /** @type {(keyof Context)[]} */ (Object.keys(changes))) if (changes[key]===undefined) delete next[key];
	return next;
}

const diagnostic=update("recordDispatchError",(/** @type {Context} */ ctx,/** @type {{error?:string}} */ e)=>e.error===undefined ? ctx : amend(ctx,{error:e.error}));
const issue={...to("issue","issued","Claim this reservation before making its native request."),
		...update("claimReservation",(/** @type {Context} */ ctx,/** @type {CallFields} */ e)=>amend(ctx,{callId:e.callId ?? ctx.callId,error:undefined}))},
	uncertain={...to("unconfirmed","uncertain","Keep the original request observable when its reply cannot yet be confirmed."),...diagnostic},
	refuse={...to("deny","refused","Record the host's explicit refusal without issuing a replacement."),...diagnostic},
	confirm={...to("confirm","done","Attach the matching completion to this reservation."),
		...update("recordCompletion",(/** @type {Context} */ ctx,/** @type {CallFields} */ e)=>amend(ctx,{
			nativeId:e.nativeId ?? ctx.nativeId,boundAt:e.boundAt ?? ctx.boundAt,error:e.error,
		}))};
const pending=[uncertain,refuse,confirm,{...to("prepare","ordinary","Expose the exact call to its issuer after the automatic route was confirmed disabled."),...diagnostic},
	{...to("retire","retired","Close a proven dead reservation without manufacturing a verdict."),
		...update("recordRetirement",(/** @type {Context} */ ctx,/** @type {CallFields} */ e)=>amend(ctx,{retirement:e.retirement ?? ctx.retirement,error:undefined}))}];
export const call=machine("call","ready",{
	ready:[issue,to("withdraw","withdrawn","Remove an unissued reservation that is no longer needed.")],ordinary:[issue],issued:pending,uncertain:pending,
	done:[],refused:[],retired:[],withdrawn:[],
},{description:"Journals one external request so a missing reply cannot cause duplicate work.",states:{
	ready:"The call is reserved but has not been issued.",ordinary:"The issuing session must make the exact prepared call through its ordinary tool route.",
	issued:"The request was claimed; wait for evidence of its original completion.",uncertain:"Delivery or completion is unknown. Look up the original call instead of replaying it.",
	done:"The matching native completion was recorded. That alone is not a passing evaluator verdict.",refused:"The host explicitly refused this request.",
	retired:"The reservation was closed on evidence that its runner ended without a verdict.",withdrawn:"The reservation was removed before it was issued.",
}});

const block={...to("block","blocked","Preserve the review and the reason its observation cannot proceed."),
		...update("blockReview",(/** @type {Context} */ ctx,/** @type {ReviewFields} */ e)=>amend(ctx,{error:e.error ?? ctx.error,permissionHold:undefined}))},
	admit={...to("admit","observed","Apply the saved observation to discovery on validated inputs."),
		...update("admitObservation",(/** @type {Context} */ ctx,/** @type {ReviewFields} */ e)=>amend(ctx,{observation:e.observation ?? ctx.observation}))},
	defer={...to("defer","deferred","Keep the observation without displacing work that is still needed."),
		...update("deferObservation",(/** @type {Context} */ ctx,/** @type {ReviewFields} */ e)=>amend(ctx,{observation:e.observation ?? ctx.observation,deferred:e.deferred ?? ctx.deferred}))},
	requeue={...to("requeue","ready","Return an eligible review to the queue on confirmed evidence, not a missing reply."),
		...update("releaseReviewTicket",(/** @type {Context} */ ctx,/** @type {ReviewFields} */ e)=>amend(ctx,{callId:undefined,error:e.error,permissionHold:e.permissionHold ?? ctx.permissionHold}))};
const reading=[uncertain,block,requeue,{...to("bind","issued","Associate this review with its confirmed native workflow."),
		...update("bindWorkflow",(/** @type {Context} */ ctx,/** @type {ReviewFields} */ e)=>amend(ctx,{workflowId:e.workflowId ?? ctx.workflowId,error:undefined}))},
	{...to("suspend","suspended","Remember the halted workflow for possible continuation on its original identity."),
		...update("suspendWorkflow",(/** @type {Context} */ ctx,/** @type {{disconnected?:boolean,error?:string}} */ e)=>amend(ctx,{
			error:e.error ?? ctx.error,providerRecovery:e.disconnected===undefined ? ctx.providerRecovery :
				e.disconnected ? ctx.providerRecovery ?? "needed" : ctx.providerRecovery==="needed" ? undefined : ctx.providerRecovery,
		}))},
	{...to("report","reported","Save the scout's complete observation before deciding whether to admit it."),
		...update("recordReport",(/** @type {Context} */ ctx,/** @type {ReviewFields} */ e)=>amend(ctx,{observation:e.observation ?? ctx.observation,packet:e.packet ?? ctx.packet,error:undefined}))}];
const disposition=[admit,defer,block];
export const review=machine("review","ready",{
	ready:[issue,block],issued:reading,uncertain:reading,suspended:reading,
	reported:disposition,blocked:[...disposition,
		{...to("producers-declared","reported","Reconsider the original missing-producer report on its still-current inputs."),when:["inputsCurrent"],action:"readmit-report"}],
	observed:[admit,defer],deferred:[],
},{description:"Turns one charter review into an evidence-backed scheduling decision.",states:{
	ready:"The charter is queued for a scout.",issued:"The scout request is outstanding or bound to its native workflow.",
	uncertain:"The original scout launch is unconfirmed; another scout cannot stand in for it.",
	suspended:"The bound workflow halted. Its cause and inputs determine whether it may continue.",
	reported:"The report was saved but has not yet been admitted.",blocked:"The review has a recorded obstacle; any saved evidence stays attached.",
	observed:"The charter's observation has been admitted. It is not a product verdict.",deferred:"The observation was set aside rather than replacing work still in use.",
}});

const reviewKeys=/** @type {const} */ (["callId","error","permissionHold","workflowId","packet","observation","deferred","providerRecovery"]);
const callKeys=/** @type {const} */ (["callId","error","nativeId","boundAt","retirement"]);

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
	return send(review,job,reviewKeys,typeof signal==="string" ? {type:signal} : signal,{},true);
}
/** Required native journal command; never replay an unsupported request.
 * @param {NativeCall} job @param {CallSignal|CallEvent} signal */
export function journal(job,signal) {
	return send(call,job,callKeys,typeof signal==="string" ? {type:signal} : signal,{},true);
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

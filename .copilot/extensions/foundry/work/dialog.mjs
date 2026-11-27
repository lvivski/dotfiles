import { dialog } from "./rules/dialog.mjs";
import { executor } from "./adapter.mjs";
import { transition } from "./machine.mjs";

/** @typedef {Pick<import("./model.js").Review,"id"|"decision">} Question */
/** @typedef {import("./model.js").OwnerDecision} Decision */
/** @typedef {Exclude<Decision,{status:"presenting"}>} Reply */
/** @typedef {{question:string,presentation?:string,presenter?:{host:string;pid:number},answer?:string,reason?:string,selected?:string}} Context */

/** @param {Question} review @param {Decision} next @param {"reopen"|"redisplay"|undefined} recovery @param {string|undefined} expected @param {boolean} required
* @param {import("./machine.mjs").Facts} [facts] */
function send(review,next,recovery,expected,required,facts={}) {
	const {status:value,...data}=review.decision ?? {status:"pending"};
	/** @type {Context} */ const context={...data,question:review.id};
	const {status,...fields}=next;
	if (!Object.hasOwn(dialog.states,status) || recovery && status!=="presenting" || !required && (status==="presenting" && !recovery || typeof expected!=="string"))
		throw Error("The dialog reply does not match its transition");
	const result=transition(dialog,{value,context},{...fields,type:recovery ?? status,expected},facts,required);
	if (result.edge) {
		const {question,...payload}=result.snapshot.context;
		// Each target declares the payload appropriate to its discriminant.
		review.decision=/** @type {Decision} */ ({status:result.snapshot.value,...payload});
	}
	return result;
}

/** Issue a required command. Only explicit recovery may reopen a lost presentation.
 * @param {Question} review @param {Decision} next @param {boolean} [recover] @param {string} [presentation] */
export function decide(review,next,recover=false,presentation) {
	const prior=review.decision;
	return send(review,next,recover?"reopen":undefined,presentation ?? (prior?.status==="presenting" ? prior.presentation ?? review.id :
		prior?.status==="unavailable" ? prior.presentation : undefined),true);
}

/** @param {Question} review @param {Extract<Decision,{status:"presenting"}>} next @param {string} previous
 * @param {{issuerGone:boolean,nativeVacant:boolean}} facts */
export const redisplay=(review,next,previous,facts)=>send(review,next,"redisplay",previous,false,facts);

const presentQuestion=executor(dialog,{"present-question":(/** @type {()=>Promise<string|null>} */ ask)=>ask()});
/** Run the claimed presentation only after its ledger transaction has committed.
 * @param {ReturnType<typeof decide>} claim @param {()=>Promise<string|null>} ask */
export function presentDialog(claim,ask) {
	const replies=presentQuestion(claim,ask);
	if (!replies.length) throw Error("No dialog presentation was claimed");
	return replies[0];
}

/** An asynchronous reply is an observation: a stale or duplicate reply changes nothing.
 * @param {Question} review @param {string} presentation @param {Reply} reply */
export function observeReply(review,presentation,reply) {
	return send(review,reply,undefined,presentation,false);
}

/** @param {Question|undefined} q @param {string} reason */
export function invalidatePresentation(q,reason) {
	if(q?.decision?.status!=="presenting")return;
	const presentation=q.decision.presentation??q.id;
	observeReply(q,presentation,{status:"unavailable",presentation,reason});
}

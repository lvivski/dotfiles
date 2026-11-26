import { executor } from "./adapter.mjs";
import { machine, guard, to, transition, update } from "./machine.mjs";

/** @typedef {import("./model.js").Review} Review */
/** @typedef {NonNullable<Review["decision"]>} Decision */
/** @typedef {Exclude<Decision,{status:"presenting"}>} Reply */
/** @typedef {{question:string,presentation?:string,answer?:string,reason?:string}} Context */

const present=update("recordPresentation",(/** @type {Context} */ {question},/** @type {{presentation?:string}} */ e)=>
	({question,...(e.presentation!==undefined && {presentation:e.presentation})}));
const samePresentation=guard("samePresentation",(/** @type {Context} */ ctx,/** @type {{expected?:string,type:string,presentation?:string}} */ e)=>
	e.expected===(ctx.presentation ?? ctx.question) && (e.type!=="unavailable" || e.presentation===undefined || e.presentation===e.expected));
const open={...to("presenting","presenting","Present this unanswered question to its owner."),...present,action:"present-question"},
	reopen={...to("reopen","presenting","Present the same lost question again on explicit recovery."),...present,action:"present-question"},
	unavailable={...to("unavailable","unavailable","Retain the question and delivery failure without inferring an answer."),
		...update("recordDeliveryFailure",(/** @type {Context} */ {question},/** @type {{presentation?:string,expected?:string,reason:string}} */ e)=>{
			const presentation=e.presentation ?? e.expected;
			return {question,reason:e.reason,...(presentation!==undefined && {presentation})};
		})};
export const dialog=machine("dialog","pending",{
	pending:[open,{...unavailable,...guard("unpresented",(_,/** @type {{expected?:string}} */ e)=>e.expected===undefined)}],
	presenting:[{...to("answered","answered","Record the reply to this exact presentation."),...samePresentation,
		...update("recordAnswer",(/** @type {Context} */ {question},/** @type {{answer:string}} */ e)=>({question,answer:e.answer}))},
		{...to("dismissed","dismissed","Preserve the dismissal; silence is not approval."),...samePresentation,
			...update("dismissQuestion",(/** @type {Context} */ {question})=>({question}))},
		{...unavailable,...samePresentation},{...reopen,...samePresentation}],
	unavailable:[{...reopen,...guard("samePresentation",(/** @type {Context} */ ctx,/** @type {{expected?:string}} */ e)=>e.expected===ctx.presentation)}],
	answered:[],dismissed:[],
},{description:"Tracks delivery of one question whose answer belongs to the operator.",states:{
	pending:"The question has not been presented.",presenting:"A presentation is outstanding; its reply must match its identity.",
	unavailable:"Delivery was unavailable. The question and original scope are retained.",answered:"The operator's answer was recorded for this question.",
	dismissed:"The operator closed the question without an answer.",
}});

/** @param {Review} review @param {Decision} next @param {boolean} recover @param {string|undefined} expected @param {boolean} required */
function send(review,next,recover,expected,required) {
	const {status:value,...data}=review.decision ?? {status:"pending"};
	/** @type {Context} */ const context={...data,question:review.id};
	const {status,...fields}=next;
	if (!Object.hasOwn(dialog.states,status) || recover && status!=="presenting" || !required && (status==="presenting" || typeof expected!=="string"))
		throw Error("The dialog reply does not match its transition");
	const result=transition(dialog,{value,context},{...fields,type:recover ? "reopen" : status,expected},{},required);
	if (result.edge) {
		const {question,...payload}=result.snapshot.context;
		// Each target declares the payload appropriate to its discriminant.
		review.decision=/** @type {Decision} */ ({status:result.snapshot.value,...payload});
	}
	return result;
}

/** Issue a required command. Only explicit recovery may reopen a lost presentation.
 * @param {Review} review @param {Decision} next @param {boolean} [recover] @param {string} [presentation] */
export function decide(review,next,recover=false,presentation) {
	const prior=review.decision;
	return send(review,next,recover,presentation ?? (prior?.status==="presenting" ? prior.presentation ?? review.id :
		prior?.status==="unavailable" ? prior.presentation : undefined),true);
}

const presentQuestion=executor(dialog,{"present-question":(/** @type {()=>Promise<string|null>} */ ask)=>ask()});
/** Run the claimed presentation only after its ledger transaction has committed.
 * @param {ReturnType<typeof decide>} claim @param {()=>Promise<string|null>} ask */
export function presentDialog(claim,ask) {
	const replies=presentQuestion(claim,ask);
	if (!replies.length) throw Error("No dialog presentation was claimed");
	return replies[0];
}

/** An asynchronous reply is an observation: a stale or duplicate reply changes nothing.
 * @param {Review} review @param {string} presentation @param {Reply} reply */
export function observeReply(review,presentation,reply) {
	return send(review,reply,false,presentation,false);
}

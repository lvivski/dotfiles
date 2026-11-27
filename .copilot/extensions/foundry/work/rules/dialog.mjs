import { guard, machine, to, update } from "../machine.mjs";

/** @typedef {import("../dialog.mjs").Context} Context */
const present=update("recordPresentation",(/** @type {Context} */ {question,selected},/** @type {Context} */ e)=>
	({question,...(e.presentation!==undefined && {presentation:e.presentation}),...(e.presenter && {presenter:e.presenter}),...((e.selected??selected) && {selected:e.selected??selected})}));
const samePresentation=guard("samePresentation",(/** @type {Context} */ ctx,/** @type {{expected?:string,type:string,presentation?:string}} */ e)=>
	e.expected===(ctx.presentation ?? ctx.question) && (e.type!=="unavailable" || e.presentation===undefined || e.presentation===e.expected));
const open={...to("presenting","presenting","Present this unanswered question to its owner."),...present,action:"present-question"},
	reopen={...to("reopen","presenting","Present the same lost question again on explicit recovery."),...present,action:"present-question"},
	restore={...to("redisplay","presenting","Restore the same decision after its presenter is gone and both native input queues are clear. A new display is not a reply."),
		...samePresentation,when:[...samePresentation.when,"issuerGone","nativeVacant"],...present,action:"present-question"},
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
		{...unavailable,...samePresentation},{...reopen,...samePresentation},restore],
	unavailable:[{...reopen,...guard("samePresentation",(/** @type {Context} */ ctx,/** @type {{expected?:string}} */ e)=>e.expected===ctx.presentation)}],
	answered:[],dismissed:[],
},{description:"Tracks delivery of one question whose answer belongs to the operator.",states:{
	pending:"The question has not been presented.",presenting:"A presentation is outstanding; its reply must match its identity.",
	unavailable:"Delivery was unavailable. The question and original scope are retained.",answered:"The operator's answer was recorded for this question.",
	dismissed:"The operator closed the question without an answer.",
}});

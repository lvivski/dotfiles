import { chart, select, to } from "./chart.mjs";

const open=to("presenting","presenting","Present this unanswered question to its owner."),
	reopen=to("reopen","presenting","Present the same lost question again on explicit recovery."),
	unavailable=to("unavailable","unavailable","Retain the question and delivery failure without inferring an answer.");
export const dialog=chart("dialog","pending",{
	pending:[open,unavailable],
	presenting:[to("answered","answered","Record the reply to this exact presentation."),to("dismissed","dismissed","Preserve the dismissal; silence is not approval."),unavailable,reopen],
	unavailable:[reopen],answered:[],dismissed:[],
},{description:"Tracks delivery of one question whose answer belongs to the operator.",states:{
	pending:"The question has not been presented.",presenting:"A presentation is outstanding; its reply must match its identity.",
	unavailable:"Delivery was unavailable. The question and original scope are retained.",answered:"The operator's answer was recorded for this question.",
	dismissed:"The operator closed the question without an answer.",
}});

/** The immutable presentation identity is verified by the caller before recording a reply.
 * Only an explicit recovery may reopen a dialog whose delivery is unknown.
 * @param {import("./model.js").Review} review @param {NonNullable<import("./model.js").Review["decision"]>} next @param {boolean} [recover] */
export function decide(review,next,recover=false) {
	const edge=select(dialog,review.decision?.status ?? "pending",recover ? "reopen" : next.status);
	if (edge.target!==next.status) throw Error("The dialog reply does not match its transition");
	review.decision=next;
}

import { chart, select, step, to } from "./chart.mjs";

const issue=to("issue","issued","Claim this reservation before making its native request."),
	uncertain=to("unconfirmed","uncertain","Keep the original request observable when its reply cannot yet be confirmed."),
	refuse=to("deny","refused","Record the host's explicit refusal without issuing a replacement."),
	confirm=to("confirm","done","Attach the matching completion to this reservation.");
const pending=[uncertain,refuse,confirm,to("prepare","ordinary","Expose the exact call to its issuer after the automatic route was confirmed disabled."),
	to("retire","retired","Close a proven dead reservation without manufacturing a verdict.")];
export const call=chart("call","ready",{
	ready:[issue,to("withdraw","withdrawn","Remove an unissued reservation that is no longer needed.")],ordinary:[issue],issued:pending,uncertain:pending,
	done:[],refused:[],retired:[],withdrawn:[],
},{description:"Journals one external request so a missing reply cannot cause duplicate work.",states:{
	ready:"The call is reserved but has not been issued.",ordinary:"The issuing session must make the exact prepared call through its ordinary tool route.",
	issued:"The request was claimed; wait for evidence of its original completion.",uncertain:"Delivery or completion is unknown. Look up the original call instead of replaying it.",
	done:"The matching native completion was recorded. That alone is not a passing evaluator verdict.",refused:"The host explicitly refused this request.",
	retired:"The reservation was closed on evidence that its runner ended without a verdict.",withdrawn:"The reservation was removed before it was issued.",
}});

const block=to("block","blocked","Preserve the review and the reason its observation cannot proceed."),
	admit=to("admit","observed","Apply the saved observation to discovery on validated inputs."),
	defer=to("defer","deferred","Keep the observation without displacing work that is still needed."),
	requeue=to("requeue","ready","Return an eligible review to the queue on confirmed evidence, not a missing reply.");
const reading=[uncertain,block,requeue,to("bind","issued","Associate this review with its confirmed native workflow."),
	to("suspend","suspended","Remember the halted workflow for possible continuation on its original identity."),
	to("report","reported","Save the scout's complete observation before deciding whether to admit it.")];
const disposition=[admit,defer,block];
export const review=chart("review","ready",{
	ready:[issue,block],issued:reading,uncertain:reading,suspended:reading,
	reported:disposition,blocked:[...disposition,
		{...to("producers-declared","reported","Reconsider the original missing-producer report on its still-current inputs."),when:["inputsCurrent"]}],
	observed:[admit,defer],deferred:[],
},{description:"Turns one charter review into an evidence-backed scheduling decision.",states:{
	ready:"The charter is queued for a scout.",issued:"The scout request is outstanding or bound to its native workflow.",
	uncertain:"The original scout launch is unconfirmed; another scout cannot stand in for it.",
	suspended:"The bound workflow halted. Its cause and inputs determine whether it may continue.",
	reported:"The report was saved but has not yet been admitted.",blocked:"The review has a recorded obstacle; any saved evidence stays attached.",
	observed:"The charter's observation has been admitted. It is not a product verdict.",deferred:"The observation was set aside rather than replacing work still in use.",
}});

/** @param {import("./model.js").Review} job @param {(typeof review.states)[keyof typeof review.states][number]["on"]} signal */
export function survey(job,signal) {job.state=select(review,job.state,signal).target;}
/** @param {import("./model.js").NativeCall} job @param {(typeof call.states)[keyof typeof call.states][number]["on"]} signal */
export function journal(job,signal) {job.state=select(call,job.state,signal).target;}
/** @param {import("./model.js").Effect} e @param {"issue"|"unconfirmed"} signal */
export function accepts(e,signal) { return !!(e.kind==="scout" ? step(review,e.state,signal) : step(call,e.state,signal)); }

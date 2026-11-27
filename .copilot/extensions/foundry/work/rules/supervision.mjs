import { machine, compose, transition } from "../machine.mjs";

/** @typedef {import("../supervision.mjs").Gate} Gate */
/** @typedef {import("../supervision.mjs").Signal} Signal */
/** @template {Gate|"dispatch"} T @param {T} target @param {"reconcile"|"reactivate"|"wait"|"stop"} action @param {string} reason @param {...Signal} when */
const edge=(target,action,reason,...when)=>({on:"sample",target,action,reason,when});
/** @template {Gate} T @param {T} target @param {string} reason @param {...Signal} when */
const route=(target,reason,...when)=>({on:"sample",target,reason,when});
export const supervision=machine("supervision","dispatch",{
	dispatch:[route("dormant","Deadline elapsed","expired"),route("managed-policy","This issuer recorded the managed hold","managed"),
		route("issuer-permission","This issuer has held work","local"),route("missing-target","The target ref is unavailable","missing"),
		route("workflow-status","A transient failure interrupted the original workflow lookup","retryRead"),
		route("approval-delivery","An automatic or restored approval is waiting for its owner's display","formDue"),
		route("ledger","Watch for changed evidence or reservations","participant"),route("dormant","No automatic obligation")],
	"managed-policy":[edge("dispatch","reactivate","Recheck this issuer and continue the original run","permitted"),edge("managed-policy","wait","Await permitted settings in the issuer")],
	"issuer-permission":[edge("dispatch","reconcile","Dispatch the original eligible reservations","permitted"),edge("issuer-permission","wait","Await permitted settings in the issuer")],
	"workflow-status":[edge("dispatch","reconcile","Read the original workflow again, without issuing a continuation on missing evidence")],
	"missing-target":[edge("dispatch","reconcile","Reassess the restored target and all input pins","available"),edge("missing-target","wait","Wait for the target ref")],
	"approval-delivery":[edge("dispatch","reconcile","Invalidate a changed target or decision before considering any redisplay","changed"),
		edge("dispatch","reconcile","Show a ready proposal after turn cleanup, or restore a proven orphan on a clear display","presentable"),
		edge("approval-delivery","wait","Preserve the original through a busy turn, a pending native request or an unknown delivery status")],
	ledger:[edge("dispatch","reconcile","Reassess changed ledger evidence or target revision","changed"),edge("ledger","wait","Wait for new evidence")],
	dormant:[edge("dormant","stop","No automatic wake")],
},{description:"Selects the signal an issuing session can observe to continue its existing work.",states:{
	dispatch:"Choose an observation from the issuer's current obligations; a timer is not evidence.",
	"managed-policy":"Watch for this issuer's recorded managed-policy hold to clear.",
	"issuer-permission":"Only this session's unissued work is waiting for a permitted tool mode.",
	"workflow-status":"Retry a read of the original workflow after a transient lookup failure.",
	"missing-target":"Wait for the original target ref to become readable before reassessing its pins.",
	"approval-delivery":"Observe turn readiness and native input queues without answering, dismissing or repeating a live request.",
	ledger:"Watch the ledger and target for changes relevant to this participant.",dormant:"No dispatch wake is owed. Outstanding native history is observed independently.",
}});
/** @param {Record<"expired"|"managed"|"local"|"missing"|"retryRead"|"participant"|"formDue",boolean>} facts @returns {Gate} */
export function watchState(facts){
	const {value}=transition(supervision,{value:"dispatch",context:null},{type:"sample"},facts,true).snapshot;
	if(value==="dispatch")throw Error("A dispatch sample must select an observation");
	return value;
}

const workflowEdge=/** @param {"continue"|"wait"} action @param {string} reason @param {...("disconnected"|"current"|"unused")} when */
	(action,reason,...when)=>({on:"verified",action,reason,when});
export const workflow=machine("workflow","suspended",{
	suspended:[workflowEdge("continue","Continue the same native workflow","disconnected","current","unused"),
		{on:"verified",action:"record-status",reason:"Record the verified non-disconnect outcome without issuing another workflow.",when:["!disconnected"]},
		workflowEdge("wait","No proven, unused provider recovery")],
},{description:"Decides whether a halted scout can continue on its original workflow identity.",states:{
	suspended:"Verify the cause of the halt, current inputs and unused continuation before continuing the scout.",
}});

export const history=machine("history","idle",{
	idle:[],
	pending:[{on:"sample",action:"lookup",reason:"Read the original call's completion or its bound workflow's status; never replay the call"}],
},{description:"Observes original call and workflow outcomes independently of scheduler recovery.",states:{
	idle:"No outcome lookup is owed.",pending:"An original completion or bound workflow status is outstanding. Retry the observation, not the request.",
}});
export const monitors=compose(supervision,history);

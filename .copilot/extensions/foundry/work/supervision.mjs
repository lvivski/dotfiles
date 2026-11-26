import { machine, compose, transition } from "./machine.mjs";
import { executor } from "./adapter.mjs";

/** @typedef {"managed-policy"|"issuer-permission"|"workflow-status"|"missing-target"|"ledger"|"dormant"} Gate */
/** @typedef {"permitted"|"available"|"changed"|"expired"|"managed"|"local"|"retryRead"|"missing"|"participant"} Signal */
/** @template {Gate|"dispatch"} T @param {T} target @param {"reconcile"|"reactivate"|"wait"|"stop"} action @param {string} reason @param {...Signal} when */
const edge=(target,action,reason,...when)=>({on:"sample",target,action,reason,when});
/** @template {Gate} T @param {T} target @param {string} reason @param {...Signal} when */
const route=(target,reason,...when)=>({on:"sample",target,reason,when});
export const supervision=machine("supervision","dispatch",{
	dispatch:[route("dormant","Deadline elapsed","expired"),route("managed-policy","This issuer recorded the managed hold","managed"),
		route("issuer-permission","This issuer has held work","local"),route("missing-target","The target ref is unavailable","missing"),
		route("workflow-status","A transient failure interrupted the original workflow lookup","retryRead"),
		route("ledger","Watch for changed evidence or reservations","participant"),route("dormant","No automatic obligation")],
	"managed-policy":[edge("dispatch","reactivate","Recheck this issuer and continue the original run","permitted"),edge("managed-policy","wait","Await permitted settings in the issuer")],
	"issuer-permission":[edge("dispatch","reconcile","Dispatch the original eligible reservations","permitted"),edge("issuer-permission","wait","Await permitted settings in the issuer")],
	"workflow-status":[edge("dispatch","reconcile","Read the original workflow again, without issuing a continuation on missing evidence")],
	"missing-target":[edge("dispatch","reconcile","Reassess the restored target and all input pins","available"),edge("missing-target","wait","Wait for the target ref")],
	ledger:[edge("dispatch","reconcile","Reassess changed ledger evidence or target revision","changed"),edge("ledger","wait","Wait for new evidence")],
	dormant:[edge("dormant","stop","No automatic wake")],
},{description:"Selects the signal an issuing session can observe to continue its existing work.",states:{
	dispatch:"Choose an observation from the issuer's current obligations; a timer is not evidence.",
	"managed-policy":"Watch for this issuer's recorded managed-policy hold to clear.",
	"issuer-permission":"Only this session's unissued work is waiting for a permitted tool mode.",
	"workflow-status":"Retry a read of the original workflow after a transient lookup failure.",
	"missing-target":"Wait for the original target ref to become readable before reassessing its pins.",
	ledger:"Watch the ledger and target for changes relevant to this participant.",dormant:"No dispatch wake is owed. Outstanding native history is observed independently.",
}});
/** @param {Record<"expired"|"managed"|"local"|"missing"|"retryRead"|"participant",boolean>} facts @returns {Gate} */
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
/** @param {boolean|undefined} pending @param {number} workflowReads */
export const historyState=(pending,workflowReads)=>pending || workflowReads ? "pending" : "idle";

/** @typedef {{state:Gate,ref:string,token?:string,pending?:boolean}} Observation */
/** @typedef {{stop:()=>void,busy:boolean,delay:number,skip:number,seen:{stamp?:string,tip?:string},
 * state:Gate,pending:boolean,workflows:Map<string,string>}} Watch */
/** One non-overlapping, backed-off observer per issuer/run. Only a positive signal
 * wakes dispatch. Time itself never authorizes a transition or a repeated call.
 * @param {{clock:(tick:()=>void)=>()=>void,track:(p:Promise<void>)=>void,
 * sample:(id:string,actor:string,previous:Gate)=>Observation,stamp:(id:string)=>string,
 * permitted:()=>Promise<boolean>,tip:(ref:string)=>string|undefined,
 * wake:(id:string,actor:string,token?:string)=>Promise<boolean>,lookup:(id:string,actor:string)=>Promise<void>,retryRead:(e:unknown)=>boolean,log:(e:unknown)=>void}} io */
export function supervise(io) {
	/** @type {Map<string,Watch>} */ const watches=new Map();
	/** @type {Map<string,()=>void>} */ const registrations=new Map();
	const readHistory=executor(history,{lookup:(/** @type {{id:string,actor:string}} */ c)=>io.track(io.lookup(c.id,c.actor))});
	/** Until the ledger is readable there is no run ID to watch. Retry only the
	 * issuer's registration scan, and disarm it on success or a permanent error.
	 * @param {string} actor @param {()=>void} scan */
	function register(actor,scan){
		if(registrations.has(actor))return;
		/** @param {boolean} first */
		function finished(first){
			try{scan();return true;}
			catch(error){
				const transient=io.retryRead(error);
				if(first || !transient)io.log(error);
				return !transient;
			}
		}
		if(finished(true))return;
		let skip=0,delay=1;
		const stop=io.clock(()=>{
			if(registrations.get(actor)!==stop || skip-- > 0)return;
			if(finished(false)){stop();registrations.delete(actor);return;}
			delay=Math.min(4,delay*2);skip=delay-1;
		});
		registrations.set(actor,stop);
	}
	/** @param {string} id @param {string} actor @param {Observation} observation @param {boolean} [startup] */
	function observe(id,actor,observation,startup=false) {
		const key=JSON.stringify([id,actor]), prior=watches.get(key);
		if (observation.state==="dormant" && !observation.pending) {prior?.stop(); watches.delete(key); return;}
		if (prior) {
			prior.pending=!!observation.pending;
			if (prior.state!==observation.state) {prior.state=observation.state; prior.delay=1; prior.skip=0;}
			return;
		}
		const ref=observation.ref;
		/** @type {Watch} */
		const w={stop:()=>{},busy:false,delay:1,skip:0,seen:startup?{}:{stamp:io.stamp(id),tip:io.tip(ref)},
			state:observation.state,pending:!!observation.pending,workflows:new Map()};
		watches.set(key,w);
		/** @typedef {{state:Gate,pending?:boolean,token?:string,seen:Watch["seen"],stamp:string,tip?:string}} Sample */
		/** Keep the sampled stamp unacknowledged until the issuer has accepted this wake.
		 * @param {Sample} s @param {string} [token] */
		async function wake(s,token){
			const delay=w.delay;
			if(!await io.wake(id,actor,token)){backoff(delay);return;}
			if(w.state==="workflow-status")backoff(delay);else {w.skip=0;w.delay=1;}
			s.seen.stamp=s.stamp;s.seen.tip=s.tip;
		}
		const execute=executor(supervision,{
			wait:()=>backoff(),stop:(/** @type {Sample} */ s)=>observe(id,actor,{state:"dormant",ref,pending:s.pending}),
			reconcile:(/** @type {Sample} */ s)=>wake(s),reactivate:(/** @type {Sample} */ s)=>wake(s,s.token),
		});
		w.stop=io.clock(()=>{
			if (watches.get(key)!==w || w.skip-- > 0) return;
			try{sample();}catch(error){failed(error);}
		});
		/** @param {unknown} error */
		function failed(error){
			io.log(error);
			if (watches.get(key)!==w)return;
			if(io.retryRead(error))backoff();else {w.stop();watches.delete(key);}
		}
		function backoff(delay=w.delay) {w.skip=delay-1; w.delay=Math.min(4,delay*2);}
		function sample() {
			const seen=w.seen,stamp=io.stamp(id),tip=io.tip(ref),changed=seen.stamp!==stamp || seen.tip!==tip;
			if (w.state==="ledger" && !changed && !w.pending && !w.workflows.size) {backoff();return;}
			const {state,token,pending}=io.sample(id,actor,w.state);
			w.pending=!!pending;
			if (state!=="dormant") w.state=state;
			const observation=transition(history,{value:historyState(pending,w.workflows.size),context:null},{type:"sample"});
			readHistory(observation,{id,actor});
			if(w.busy){
				if(state==="dormant")observe(id,actor,{state,ref,pending});
				return; // Only the scheduler region waits for this permission sample.
			}
			w.busy=true;
			io.track(dispatch().catch(failed).finally(()=>{w.busy=false;}));
			async function dispatch(){
				const permitted=(state==="managed-policy" || state==="issuer-permission") && await io.permitted();
				if (watches.get(key)!==w || state!=="dormant" && w.state!==state)return;
				const result=transition(supervision,{value:state,context:null},{type:"sample"},{permitted,available:tip!==undefined,changed},true);
				await Promise.all(execute(result,{state,pending,token,seen,stamp,tip}));
			}
		}
	}
	return {register,observe,
		/** @param {string} id @param {string} actor */
		invalidate(id,actor){const w=watches.get(JSON.stringify([id,actor]));if(w)w.seen={};},
		/** Failed status reads belong to this watch. Its issuer must revalidate the ticket and workflow before reattaching.
		 * @param {string} id @param {string} actor */
		statusReads:(id,actor)=>watches.get(JSON.stringify([id,actor]))?.workflows,
		close(){for(const stop of registrations.values())stop();registrations.clear();for(const w of watches.values())w.stop();watches.clear();}};
}

import { hostname } from "node:os";
import { digest, record } from "./values.mjs";
import { currentOffer } from "./offers.mjs";

/** @typedef {import("./model.js").Adoption} Adoption */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").OwnerDecision} Decision */

/** @param {Record<string,unknown>} ui */
const clearQueues=ui=>[ui.pendingElicitationRequests,ui.pendingUserInputRequests,ui.pendingExitPlanModeRequests].every(q=>Array.isArray(q) && q.length===0);
/** Automatic requests are not awaited by an agent tool call. Don't offer one to a
 * composer that is about to clear its current-turn prompts.
 * @param {unknown} snapshot */
export function formIdle(snapshot){
	const ui=record(snapshot);
	return ui.agentTurnActive===false && ui.processing===false && clearQueues(ui);
}
/** The native runtime and desktop callback have different lifetimes. An empty or omitted
 * field in just one service does not establish that the presentation is gone.
 * @param {string} id @param {()=>Promise<unknown>} snapshot @param {()=>Promise<unknown>} lookup */
export async function formVacant(id,snapshot,lookup){
	const ui=record(await snapshot());
	if(!clearQueues(ui))return false;
	const raw=await lookup(),result=typeof raw==="string"?{resultType:"success",textResultForLlm:raw}:record(raw);
	if(result.resultType!=="success")return false;
	const data=result.structuredContent??(typeof result.textResultForLlm==="string" && result.textResultForLlm.trimStart().startsWith("{") ? JSON.parse(result.textResultForLlm) : undefined);
	if(!data || typeof data!=="object")return false;
	const s=record(data),activity=s.activity && typeof s.activity==="object"?record(s.activity):{};
	return s.id===id && s.active_session_id===id && !s.archived_at && !s.archived && s.was_interrupted===false &&
		(activity.status==="idle" || activity.status==="busy") && !activity.waiting_on && !s.repository_trust && !s.pending_plan && !s.last_error &&
		s.awaiting_user_input===false && !s.awaiting_input && (s.awaiting_inputs===undefined || Array.isArray(s.awaiting_inputs) && !s.awaiting_inputs.length);
}

// A ledger claim precedes the SDK call. An empty native snapshot in that interval
// must not let a second runtime displace a still-live presenter, including on reload.
export const presenter=Object.freeze({host:digest(hostname()),pid:process.pid});
/** @type {Map<string,()=>boolean>} */ const live=new Map();
/** @template T @param {string} id @param {()=>boolean} closed @param {()=>Promise<T>} fn */
export async function whilePresenting(id,closed,fn){
	live.set(id,closed);
	try{return await fn();}finally{live.delete(id);}
}
/** Only for a claim that already existed when the owner attached. Reader 80 did not stamp a process.
 * @param {Extract<Decision,{status:"presenting"}>} d */
export function issuerGone(d){
	if(!d.presentation || live.get(d.presentation)?.()===false)return false;
	if(!d.presenter)return true;
	if(d.presenter.host!==presenter.host)return false;
	if(d.presenter.pid===presenter.pid)return true;
	try{process.kill(d.presenter.pid,0);return false;}
	catch(error){return error instanceof Error && "code" in error && error.code==="ESRCH";}
}

/** Only the originally captured presentation can be recovered, once for that identity.
 * The scheduler watches this identity; it never learns a new one from a timer.
 * @param {Adoption|undefined} a */
export function restorableForm(a){
	const d=a?.decision;
	return a?.assembly && d?.status==="presenting" && issuerGone(d) ? d.presentation : undefined;
}

/** Snapshot only pre-existing claims at the primary owner's attachment. A later wake
 * cannot adopt a new presentation, even if it is for the same immutable proposal.
 * @param {Pick<Parameters<typeof import("./runtime.mjs").createRuntime>[1],"formVacant"|"formIdle"|"log">} host */
export function formDelivery(host){
	/** @type {Map<string,{id:string,basis:string,presentation:string}|undefined>} */ const captured=new Map();
	/** @param {()=>Promise<boolean>} read */
	async function sample(read){
		try{return await read()===true;}
		catch(error){host.log?.(`Foundry cannot verify the owner's approval display; retaining the original proposal: ${String(error)}`);return false;}
	}
	return {
		/** An old unstamped claim needs a real primary activation, not an ordinary reconciliation.
		 * @param {Run} run @param {string} actor @param {boolean} [startup] */
		attach(run,actor,startup=false){
			if(!host.formVacant || actor!==run.owner || captured.has(run.id))return;
			const a=currentOffer(run),d=a?.decision;
			if(!startup && d?.status==="presenting" && !d.presenter)return;
			captured.set(run.id,a && d?.status==="presenting" && d.presentation ? {id:a.id,basis:a.basis,presentation:d.presentation} : undefined);
		},
		/** @param {Run} run @param {string} actor */
		current(run,actor){
			const lost=captured.get(run.id);
			if(!lost || !run.active || actor!==run.owner)return;
			const a=currentOffer(run);
			if(a?.id===lost.id && (a.failed || a.evaluator || a.basis===lost.basis) && a.decision?.status==="presenting" && a.decision.presentation===lost.presentation)return a;
		},
		/** @param {Adoption|undefined} a */
		async vacant(a){
			return !!host.formVacant && !!restorableForm(a) && sample(host.formVacant);
		},
		idle:()=>host.formIdle ? sample(host.formIdle) : true,
	};
}

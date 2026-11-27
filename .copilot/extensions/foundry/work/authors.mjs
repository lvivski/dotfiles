import { randomUUID } from "node:crypto";
import { executor } from "./adapter.mjs";
import { permissionKey } from "./critique.mjs";
import { acceptAuthor, authorPacket, verifyDraft } from "./authorship.mjs";
import { availableReservations, noWorkflowSlot } from "./capacity.mjs";
import { draftAllowed, movePart, partId } from "./drafts.mjs";
import { drafting } from "./rules/drafts.mjs";
import { commitAt } from "./product.mjs";
import { expired } from "./native.mjs";
import { fail, FoundryError, text } from "./values.mjs";
import { repliedWorkflow, terminalWorkflow, workflowIdentity } from "./workflow.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./author.mjs").Ticket} Ticket */
/** @typedef {import("./auditor.mjs").Envelope & {pauseInfo?:{type:string,key?:string}}} Envelope */
/** @param {Run} r */
export function nextAuthor(r){
	if(!r.active || expired(r) || r.policyHold || r.independent || r.conflict || r.blocker ||
		r.effects.some(e=>e.permissionHold) || r.inspections?.some(i=>i.permissionHold))return;
	for(const d of r.correctionDrafts??[]){
		if(!draftAllowed(d) || d.blob || d.parts.some(p=>p.state==="held") || d.goal!==r.goal?.check ||
			(d.evaluator?!!r.join:!r.join || !r.effects.some(e=>e.id===d.check && (e.id===r.join?.check || e.kind==="component" && e.rollout &&
				r.adoptions?.some(a=>a.id===e.rollout && a.failed===r.join?.check)))))continue;
		const p=d.parts.find(p=>p.state!=="returned");
		if(p && (p.state==="ready" && availableReservations(r)>0 || p.state==="issued" && p.workflow))return {d,p};
	}
}
/** @param {Run} r @param {Ticket} t */
function locate(r,t){
	const d=r.correctionDrafts?.find(d=>d.id===t.draft),p=d?.parts.find(p=>p.dispatch===t.dispatch && partId(d,p)===t.subject);
	if(d && p && draftAllowed(d) && p.state==="issued")return {d,p};
}
/** A native identity can be recorded without releasing a packet or authorizing work.
 * @param {Run} r @param {import("./model.js").DraftPart} p @param {string} workflow @param {boolean} withheld */
function bind(r,p,workflow,withheld){
	movePart(p,"bind",{workflow:workflowIdentity(r,p,workflow),...(withheld && {awaitingPacket:true})});
}
/** @param {{cwd:()=>string,store:()=>Pick<ReturnType<typeof import("./database.mjs").openDatabase>,"planAndSwap"|"reserve"|"verifySigned">,
 * closed:()=>boolean,permitted:()=>Promise<boolean>,start?: (t:Ticket)=>Promise<Envelope>,observe?:(id:string)=>Promise<Envelope>,resume?:(id:string)=>Promise<Envelope>,budget?:()=>Promise<number>,
 * persist:<T>(write:()=>T|Promise<T>)=>Promise<T|undefined>,queued:(run:string,actor:string)=>boolean,
 * queue:(run:string,actor:string)=>void,wait:(run:string,actor:string)=>void,wake:(run:string,actor:string)=>Promise<void>}} io */
export function draftDispatcher(io){
	const running=new Set();
	const perform=executor(drafting,{
		"start-author":(/** @type {{ticket:Ticket,original?:string}} */ c)=>(io.start??fail("unavailable","No correction author host"))(c.ticket),
		"observe-author":(/** @type {{ticket:Ticket,original?:string}} */ c)=>(io.observe??fail("unavailable","No correction outcome reader"))(text(c.original,"original workflow")),
		"continue-author":(/** @type {{ticket:Ticket,original?:string}} */ c)=>(io.resume??fail("unavailable","No correction author continuation host"))(text(c.original,"original workflow")),
	});
	/** @param {Ticket} ticket @param {string} actor @param {string} workflow */
	async function packet(ticket,actor,workflow){
		if(io.closed())fail("dispatch_held","The issuing runtime closed");
		const permitted=await io.permitted();let waiting=false;
		/** @type {import("./author.mjs").Packet|undefined} */ let result;
		io.store().planAndSwap(ticket.run,r=>{
			result=undefined;waiting=false;const {d,p}=locate(r,ticket)??fail("wrong_workflow","No issued correction writer matches this subject and dispatch");
			if(actor!==r.owner)fail("wrong_workflow","Only the original issuer can supply this frozen packet");
			waiting=!permitted || !r.active || !!r.policyHold || expired(r);
			bind(r,p,workflow,waiting);
			if(waiting)return;
			verifyDraft(io.cwd(),r,d,c=>io.store().verifySigned(r.id,c));
			result=authorPacket(io.cwd(),r,d,p);
			return ()=>!io.closed() && !expired(r) && commitAt(io.cwd(),r.policy.target)===d.target;
		});
		if(waiting)fail("draft_wait","The original author is bound. No packet was delivered; wait for the original issuer's permission.");
		return result??fail("wrong_workflow","No frozen author packet");
	}
	/** @param {Run} run @param {string} actor */
	async function launch(run,actor){
		const eligible=nextAuthor(run);if(!eligible || actor!==run.owner)return;
		const key=partId(eligible.d,eligible.p);if(running.has(key) || io.queued(run.id,actor))return;
		running.add(key);let progressed=false;
		/** @type {Ticket|undefined} */ let ticket;
		try{
			if(io.closed())return;
			const budget=await io.budget?.();
			if(io.closed() || !await io.permitted()){if(!io.closed())io.wait(run.id,actor);return;}
			const claim=io.store().reserve(run.id,r=>{
				progressed=false;const job=nextAuthor(r);
				if(!job || partId(job.d,job.p)!==key)return;
				const {d,p}=job,original=p.workflow;
				try{
					verifyDraft(io.cwd(),r,d,c=>io.store().verifySigned(r.id,c));
					if(!original){
						const packet=authorPacket(io.cwd(),r,d,p);
						if(budget!==undefined && Buffer.byteLength(JSON.stringify(packet))>budget)fail("unavailable","The complete frozen author packet exceeds the host's context budget.");
					}
					if(!(original?io.observe:io.start))fail("unavailable","No native host for the bound correction author.");
					const selected=original?movePart(p,"observe"):movePart(p,"claim",{dispatch:randomUUID()});
					const ticket={run:r.id,draft:d.id,subject:key,dispatch:text(p.dispatch,"correction dispatch")};
					return {value:{ticket,selected,original},guard:()=>!io.closed() && !expired(r) && commitAt(io.cwd(),r.policy.target)===d.target};
				}catch(e){if(!(e instanceof FoundryError))throw e;movePart(p,"hold",{reason:e.message});progressed=true;return;}
			});
			if(!claim || io.closed())return;
			const {ticket:t,selected,original}=claim;ticket=t;
			let envelope=await perform(selected,{ticket:t,original})[0];
			if(io.closed())return;
			const permission=envelope?.status==="paused" && envelope.pauseInfo?.type==="checkpoint" && envelope.pauseInfo.key===permissionKey(t);
			const dropped=envelope?.status==="halted" && envelope.failure?.type==="workflow_provider_disconnected";
			if(io.resume && !envelope?.error && repliedWorkflow(envelope,"foundry-draft") && (permission || dropped) && await io.permitted()){
				const continuation=io.store().reserve(run.id,r=>{
					const b=locate(r,t);
					if(!b || !r.active || expired(r) || r.policyHold || !b.p.workflow || b.p.workflow!==envelope.runId || b.p.continued || permission && !b.p.awaitingPacket)return;
					verifyDraft(io.cwd(),r,b.d,c=>io.store().verifySigned(r.id,c));
					return {value:movePart(b.p,"continue"),guard:()=>!io.closed() && !expired(r) && commitAt(io.cwd(),r.policy.target)===b.d.target};
				});
				if(continuation && !io.closed())envelope=await perform(continuation,{ticket:t,original:envelope.runId})[0];
			}
			await io.persist(async()=>{
				const allowed=await io.permitted();if(!allowed)io.wait(run.id,actor);
				return io.store().planAndSwap(run.id,r=>{
					const live=locate(r,t);progressed=false;if(!live)return;const {d,p}=live;
					const workflow=repliedWorkflow(envelope,"foundry-draft",p.workflow);
					if(!original && !p.workflow && workflow){
						bind(r,p,workflow,true);
						if(terminalWorkflow(envelope.status)){
							movePart(p,"hold",{reason:`The original author ended (${envelope.status}) without receiving a packet. No edits accepted. A new scoped author requires a separate decision.`});
							progressed=allowed && r.active;return;
						}
					}
					if(!allowed || !r.active || expired(r) || r.policyHold)return; // Reobserve this workflow, not another launch.
					if(!p.workflow || !workflow){
						movePart(p,"uncertain",{reason:"No matching reply from the original correction author. Do not start another workflow."});return;
					}
					if(!terminalWorkflow(envelope.status)){
						movePart(p,"uncertain",{reason:`Original author ${p.workflow}: ${envelope.status}. Await that workflow in its issuer; no replacement launch.`});return;
					}
					try{
						verifyDraft(io.cwd(),r,d,c=>io.store().verifySigned(r.id,c));
						if(envelope.status!=="completed" || envelope.error || envelope.failure || p.awaitingPacket)
							fail("unavailable",`Original author ${p.workflow} ended without a proposal: ${envelope.failure?.type??envelope.error??envelope.status}.`);
						acceptAuthor(io.cwd(),d,p,envelope.result);
					}catch(e){if(!(e instanceof FoundryError))throw e;movePart(p,"hold",{reason:e.message});progressed=true;return;}
					progressed=true;
					return ()=>!io.closed() && !expired(r) && commitAt(io.cwd(),r.policy.target)===d.target;
				});
			});
		}catch(error){
			const t=ticket;
			if(!io.closed() && t){
				const queued=await io.persist(()=>io.store().planAndSwap(run.id,r=>{
					const p=locate(r,t)?.p;if(!p)return;
					if(!p.workflow && noWorkflowSlot(error)){
						movePart(p,"capacity");return;
					}
					movePart(p,"uncertain",{reason:`Original author delivery is unconfirmed: ${String(error)}. No replacement launch.`});
					// Preserve the issued call: the same late workflow may still bind and return.
				}));
				if(queued?.correctionDrafts?.some(d=>d.id===t.draft && d.parts.some(p=>partId(d,p)===key && p.state==="ready")))io.queue(run.id,actor);
			}else if(!io.closed())throw error;
		}finally{running.delete(key);if(!io.closed() && progressed)await io.wake(run.id,actor);}
	}
	return {launch,packet,ready:(/** @type {Run} */ run)=>{const e=nextAuthor(run);return !!e && !running.has(partId(e.d,e.p));}};
}

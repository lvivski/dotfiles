import { randomUUID } from "node:crypto";
import { holdFor } from "./activity.mjs";
import { noWorkflowSlot } from "./capacity.mjs";
import { candidatePacket } from "./critique.mjs";
import { currentInspection, inspectionResult, priorReview } from "./inspection.mjs";
import { boundInspections, markInspection, matchingInspections, readyInspections } from "./inspections.mjs";
import { expired } from "./native.mjs";
import { changeOffer } from "./evidence.mjs";
import { integrityHolds } from "./revision.mjs";
import { digest, fail, record } from "./values.mjs";
import { repliedWorkflow, terminalWorkflow, workflowIdentity } from "./workflow.mjs";

/** @typedef {import("./model.js").Inspection} Inspection */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./resume.mjs").ScoutEnvelope & {result?:unknown,workflowName?:string}} Envelope */
/** @typedef {(run:string,inspection:string,dispatch:string,issuer:string)=>Promise<Envelope>} StartInspection */
/** @typedef {<T>(id:string,fn:(run:Run)=>T)=>T} Mutate */
/** @typedef {<T>(fn:()=>T)=>Promise<T|undefined>} Persist */

const inspectionCapacity="Queued for native inspection capacity; the issuer will retry automatically.";
/** @param {Inspection} i */
const pins=i=>digest([i.id,i.issuer,i.component,i.grain,i.base,i.generation,i.candidate,i.scope,i.task,i.specification,i.assignment]);
/** These exceptional grants name a live checkpoint target. Ordinary reviews
 * inspect immutable bytes and do not inherit a moved-target ban.
 * @param {Run} run @param {Inspection} i */
function protectedTarget(run,i) {
	const c=run.effects.find(e=>e.id===i.component);
	if(c?.kind==="component")return changeOffer(run,c)?.revision??(c.delivery || c.remedy?run.products.at(-1)?.target:undefined);
}
/** @param {Run} run @param {string} id @param {string} ticket @param {string} actor @param {Inspection} [expected] */
function dispatched(run,id,ticket,actor,expected) {
	const i=run.inspections?.find(i=>i.id===id);
	if (i?.state==="issued" && i.issuer===actor && i.dispatch===ticket && (!expected || pins(i)===pins(expected))) return i;
}
/** @param {Run} run @param {string} id @param {string} ticket @param {string} actor @param {Inspection} [expected] */
function issued(run,id,ticket,actor,expected) {
	const i=dispatched(run,id,ticket,actor,expected);
	if (i && currentInspection(run,i)) return i;
}
/** A start acknowledgment or the actual workflow body can establish the same original binding.
 * Neither is a verdict. Never substitute a different ID or import a previous attempt's workflow.
 * @param {Run} run @param {Inspection} i @param {string} workflow */
function bind(run,i,workflow) {
	workflowIdentity(run,i,workflow);
	if (!i.workflow) markInspection(i,"bind",{workflow});
	return i;
}
/** Only an original workflow's terminal status can conclude its inspection. A resumable
 * halt, transient read, unbound start, or unknown future SDK status is not a terminal failure.
 * @param {Inspection} i @param {Envelope} e */
function verdict(i,e) {
	if (e.status==="completed" && !e.failure && !e.error) {
		try {
			const {inspection,component,candidate,...review}=record(e.result);
			if (inspection!==i.id || component!==i.component || candidate!==i.candidate)
				fail("wrong_inspection","Result does not identify this exact inspection, component and candidate");
			return inspectionResult(review);
		} catch(error) {
			return {outcome:/** @type {const} */("unavailable"),summary:`Invalid terminal inspection result: ${String(error)}`};
		}
	}
	if (terminalWorkflow(e.status))
		return {outcome:/** @type {const} */("unavailable"),summary:`Inspection ${e.status}: ${e.failure?.type ?? e.error ?? e.reason ?? "no review was returned"}`};
}

/** Transport for a single already-reserved candidate. Reconciliation owns all admission,
 * policy and wake scheduling. An outstanding SDK wait is detached, like a scout workflow.
 * @param {{start?:StartInspection,lookup?:(workflow:string)=>Promise<Envelope>,budget?:()=>Promise<number>,
 * cwd:()=>string,read:(id:string)=>Run,tip:(run:Run)=>string|undefined,mutate:Mutate,persist:Persist,closed:()=>boolean,
 * reserve:ReturnType<typeof import("./database.mjs").openDatabase>["reserve"],
 * verifySigned:(id:string,component:import("./model.js").NativeCall)=>void,
 * executable:()=>Promise<boolean>,permissionBlocker:()=>Promise<import("./permissions.mjs").PermissionBlock|null>,track:(p:Promise<void>)=>void,
 * wake:(id:string,actor:string)=>void,queue:(id:string,actor:string)=>void,log?:(message:string)=>void}} io */
export function auditor(io) {
	const reading=new Set();
	/** @param {string} id @param {string} actor @param {Inspection[]} expected @param {import("./permissions.mjs").PermissionBlock|null} block */
	function permission(id,actor,expected,block){
		const message=block ? `${block.message} Check session ${actor}. Foundry watches for permitted settings.` : null;
		if(!block && !expected.some(i=>i.permissionHold))return null;
		io.mutate(id,run=>{
			if(!run.active || expired(run))return;
			const live=matchingInspections(run,expected).filter(i=>i.issuer===actor);
			for(const i of live){
				if(message)i.permissionHold=message;else delete i.permissionHold;
			}
			if(live.length && message && block?.scope==="run")holdFor(run,live[0],message);
		});
		return message;
	}
	/** @param {string} id @param {Inspection} expected */
	function observe(id,expected) {
		const {dispatch,workflow,issuer}=expected,lookup=io.lookup;
		if (!workflow || !dispatch || io.closed() || reading.has(dispatch)) return;
		if (!lookup) {
			const summary=`Cannot observe bound inspection workflow ${workflow} in session ${issuer}. Reload an issuer with native workflow status support; do not launch a replacement.`;
			if (expected.summary!==summary) io.track(io.persist(()=>io.mutate(id,run=>{
				const i=issued(run,expected.id,dispatch,issuer,expected);
				if (i?.workflow===workflow) i.summary=summary;
			})));
			return;
		}
		reading.add(dispatch);
		const original=()=>issued(io.read(id),expected.id,dispatch,issuer,expected)?.workflow===workflow;
		// Arm the continuation on the issuer's call path, never from a workflow body.
		void Promise.resolve().then(()=>!io.closed() && original() ? lookup(workflow) : undefined).then(
			result=>finish(async()=>{
				if (!result) return;
				const settled=await io.persist(()=>io.mutate(id,run=>{
					const i=issued(run,expected.id,dispatch,issuer,expected);
					if (i?.workflow!==workflow) return false;
					if (!repliedWorkflow(result,"foundry-inspect",workflow)) {
						i.summary=`Native lookup did not return the original inspection workflow ${workflow}. Await that workflow in session ${issuer}; do not start another.`;
						return false;
					}
					const reply=verdict(i,result);
					if (!reply) {
						if (result.status==="paused" || result.status==="halted") {
							const reason=result.failure?.type ?? result.reason ?? result.error;
							i.summary=`Original inspection workflow ${workflow} ${result.status}${reason ? ` (${reason})` : ""}. `+
								`On explicit request, resume that same native workflow ID in issuing session ${issuer} with its existing limits; Foundry will observe it, not start another.`;
						}
						return false;
					}
					markInspection(i,reply.outcome,{summary:reply.summary});return true;
				}));
				if (settled && !io.closed()) io.wake(id,issuer);
			}),
			error=>finish(async()=>{if (!io.closed()) io.log?.(`Foundry cannot observe inspection workflow ${workflow}: ${String(error)}`);}),
		);
		/** @param {()=>Promise<void>} fn */
		function finish(fn) {io.track(fn().finally(()=>reading.delete(dispatch)));}
	}
	/** @param {string} id @param {Inspection} expected */
	function launch(id,expected) {
		const start=io.start;
		const unsupported=!start || !io.lookup ? `Independent review is waiting: this issuer cannot ${!start ? "start" : "observe"} native inspection workflows. Reload a host with Rubber Duck review support.` : undefined;
		if (io.closed() || unsupported && expected.summary===unsupported) return;
		const dispatch=randomUUID(),{issuer}=expected;
		const claimed=io.reserve(id,run=>{
			const i=readyInspections(run,issuer).find(i=>i.id===expected.id && pins(i)===pins(expected));
			if (!i || io.closed() || !run.active || expired(run) || i.permissionHold || run.effects.some(e=>e.issuer===issuer && e.permissionHold)) return;
			const target=protectedTarget(run,i);
			if (target && io.tip(run)!==target) return;
			const c=run.effects.find(e=>e.id===i.component);
			let task;
			if(c?.kind==="component" && (c.rollout || c.replacement) && run.nodes[i.grain].grain.task){
				task=priorReview(run,c)?.task;
				if(!task || i.assignment && i.assignment!==task){
					// Status already names withheld receipts. Even a diagnostic may not modify their dependent review.
					if(!integrityHolds(run).length)i.summary=`Review of ${c.id} is waiting for the original published task for ${i.grain}; no workflow was issued.`;
					return;
				}
			}
			if(unsupported){i.summary=unsupported;return;}
			if(task)i.assignment=task;
			markInspection(i,"issue",{dispatch});
			i.summary="Awaiting the original native inspection workflow ID. Without confirmed admission do not repeat this dispatch.";
			return {value:i,guard:()=>!io.closed() && !expired(run) && (!target || io.tip(run)===target)};
		});
		if (!claimed || !start) return;
		let starting;
		try {starting=start(id,claimed.id,dispatch,issuer);}
		catch(error) {starting=Promise.reject(error);}
		void starting.then(result=>io.track(acknowledge(claimed,result)),error=>io.track(rejected(claimed,error)));
		/** @param {Inspection} subject @param {Envelope} result */
		async function acknowledge(subject,result) {
			const bound=await io.persist(()=>io.mutate(id,run=>{
				// Pin the actual admission even if current scheduling authority was lost
				// during the SDK call. Neither this write nor the ID authorizes another launch.
				const i=dispatched(run,subject.id,dispatch,issuer,subject);
				if (!i) return;
				const workflow=repliedWorkflow(result,"foundry-inspect");
				if (!workflow) {
					if (!i.workflow) i.summary="No confirmed native inspection workflow ID in the start acknowledgment. Do not retry this dispatch.";
					return;
				}
				return bind(run,i,workflow);
			}));
			if (bound) observe(id,bound); // Even a "completed" start response is not the observed result.
		}
		/** @param {Inspection} subject @param {unknown} error */
		async function rejected(subject,error) {
			const queued=await io.persist(()=>io.mutate(id,run=>{
				const i=issued(run,subject.id,dispatch,issuer,subject);
				if (!i) return false;
				if (!i.workflow && noWorkflowSlot(error)) {
					markInspection(i,"capacity");i.summary=inspectionCapacity;return true;
				}
				i.summary=i.workflow ? "Start reply unconfirmed; observing the original bound workflow." :
					"No confirmed inspection workflow ID. Do not retry this dispatch without native admission evidence.";
				return false;
			}));
			if (queued && !io.closed()) io.queue(id,issuer);
		}
	}
	/** @param {string} id @param {string} job @param {string} ticket @param {string} actor @param {string} workflow */
	async function packet(id,job,ticket,actor,workflow) {
		const bound=await io.persist(()=>io.mutate(id,run=>{
			const i=issued(run,job,ticket,actor);
			if(!i){
				const known=run.inspections?.find(i=>i.id===job && i.dispatch===ticket && i.issuer===actor && i.workflow===workflow);
				const c=known && run.effects.find(e=>e.id===known.component);
				if(c?.kind==="component" && c.receipt)io.verifySigned(id,c);
				fail("foreign_assignment","No current inspection matches this issuer and dispatch");
			}
			return bind(run,i,workflow);
		}));
		if (!bound || io.closed()) fail("runtime_closed","Foundry is closed");
		const budget=await io.budget?.();
		if (io.budget && (typeof budget!=="number" || !Number.isSafeInteger(budget) || budget<0))
			fail("packet_budget","Missing a valid native inspection prompt budget");
		const block=await io.permissionBlocker();
		if(!await io.executable())fail("unsupported_mode","Candidate inspection requires an executable issuer");
		const reason=permission(id,actor,[bound],block);
		if(reason)fail("inspection_held",reason);
		/** The checkout may share its common Git directory with another active issuer.
		 * Read and size the pinned candidate outside the lock; validate again before handing it out. */
		function live(verify=false) {
			const run=io.read(id),i=issued(run,job,ticket,actor,bound);
			if (!run.active || expired(run) || i?.workflow!==workflow || i.permissionHold || run.effects.some(e=>e.issuer===actor && e.permissionHold))
				fail("inspection_held","Inspection cannot execute: the dispatch is no longer current, active and permitted");
			const target=protectedTarget(run,i);
			if (target && io.tip(run)!==target) fail("inspection_held","The authorized checkpoint target moved before its candidate could be reviewed");
			if (verify || i.assignment) {
				const c=run.effects.find(e=>e.id===i.component);
				if (c?.kind!=="component") fail("missing_receipt","Missing original reviewed component");
				if(i.assignment && priorReview(run,c)?.task!==i.assignment)
					fail("inspection_held",`The original published task for ${i.grain} is not verifiable; the review packet is withheld.`);
				if(verify)io.verifySigned(id,c);
			}
			return i;
		}
		const result=candidatePacket(io.cwd(),live(),budget);
		live(true);
		return result;
	}
	return {launch,packet,permission,canReceive:!!(io.start && io.lookup),canObserve:!!io.lookup,
		/** @param {Run} run @param {string} actor */
		observe(run,actor){for(const i of boundInspections(run,actor))observe(run.id,i);},
		/** @param {Run} run @param {string} actor */
		queued(run,actor){return readyInspections(run,actor).some(i=>i.summary===inspectionCapacity);},
	};
}

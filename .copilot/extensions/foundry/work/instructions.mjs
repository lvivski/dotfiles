import { instructionMessage } from "./notice.mjs";
import { messageTo } from "./dispatch.mjs";
import { routedBlockers } from "./routing.mjs";
import { activeDelivery } from "./batch.mjs";
import { currentDiagnostic, diagnosticRequest, diagnosticTasks, footprintProgress, subsetRequest } from "./diagnostics.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { contractHold } from "./contract.mjs";
import { generationOf, missingInput, qualifiedProduct } from "./evidence.mjs";
import { referenceAttempt, stalePins, writerVersion } from "./lineage.mjs";
import { supplierRequests } from "./supplier.mjs";
import { deadlineAt, digest, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {import("./model.js").Instruction} Instruction */
/** @param {Run} run */
export const dispatches=run=>run.instructions?.length ? [...run.effects,...run.instructions] : run.effects;

/** Instructions have no capacity, ownership or release semantics; their only effect is a native message.
 * @param {Run} run */
const active=run=>run.active && !run.policyHold && !run.independent && !activeDelivery(run) && !contractHold(run) &&
	!(run.policy.deadline && Date.now()>=(deadlineAt(run.policy.deadline)??0)) && !(run.goal && qualifiedProduct(run));

/** @param {Run} run @param {Node} n @param {Instruction["kind"]} kind @param {Call} w @param {string} source @param {string} evidence @param {string} [step] */
function subject(run,n,kind,w,source,evidence,step){
	const instruction={kind,assignment:w.id,source,evidence,...(step && {step})};
	const grain=n.grain.id,token=n.token;
	return {id:digest([run.id,grain,token,instruction]),grain,token,instruction};
}

/** @param {Run} run @param {Node[]} nodes
 * @returns {Generator<ReturnType<typeof subject> & {publish?:{file:string,to:string[],forInput:string}}>} */
function* subjects(run,nodes){
	if(!active(run) || !nodes.length)return;
	const rows=routedBlockers(run,remainingAssignments(run));
	const launches=new Map(run.effects.flatMap(w=>w.kind==="writer" && w.state==="done" && w.nativeId?[[w.grain,w]]:[]));
	const reviews=new Map(run.effects.flatMap(r=>r.kind==="scout"?[[r.id,r]]:[]));
	const requests=run.footprintRequests?.flatMap(q=>{const needs=footprintProgress(run,q);return needs?[{q,needs}]:[];})??[];
	for(const {producer,consumer,assignment,file,blob,revision,component,to} of supplierRequests(run)){
		if(!nodes.includes(producer) && !nodes.includes(consumer))continue;
		const w=launches.get(producer.grain.id),request=referenceAttempt(run,consumer);
		if(!w || w.id!==assignment || !request)continue;
		yield {...subject(run,producer,"supply",w,request.id,blob,digest([writerVersion(consumer),consumer.stop?.input?.after,file,revision,component??null,to])),
			publish:{file,to,forInput:consumer.grain.id}};
	}
	for(const n of nodes){
		const w=launches.get(n.grain.id);
		if(!n.worker || !n.token || !w || w.nativeId!==n.worker || generationOf(w)!==n.generation)continue;
		for(const {q,needs} of requests){
			for(const id of needs.missing)if(run.effects.find(e=>e.id===id)?.grain===n.grain.id)
				yield subject(run,n,"footprint",w,id,q.id);
			if(!needs.missing.length && !needs.ambiguous.length && needs.grain===n.grain.id)yield subject(run,n,"subset",w,q.observer,q.id);
		}
		const proposals=run.diagnostics?.filter(d=>d.assignment===w.id && currentDiagnostic(run,d))??[];
		for(const d of proposals)if(d.kind!=="footprint")yield subject(run,n,"proposal",w,d.check,d.id);
		for(const d of diagnosticTasks(run,n))if(!proposals.some(p=>p.check===d.check && p.kind===d.kind)){
			const p=run.products.at(-1);if(p)yield subject(run,n,"diagnosis",w,d.check,p.check,d.kind);
		}
		if(n.state==="blocked" && missingInput(n)!==undefined && w.token===n.token && w.readGrant)
			yield subject(run,n,"read",w,w.id,digest(w.readGrant));
		if(n.state!=="writing" || stalePins(run,n).length ||
			run.effects.some(e=>e.grain===n.grain.id && (e.permissionHold || e.kind==="repair" && e.token===n.token && (e.state!=="done" || e.error))))continue;
		if(w.observer){
			if(w.token===n.token && w.observer.after && n.preview)yield subject(run,n,"observer",w,w.id,w.observer.after);
			if(w.token===n.token && !w.observer.after && n.preview)yield subject(run,n,"preview",w,w.id,n.preview);
			continue;
		}
		if(n.restoration || w.production || n.successor)continue;
		const r=n.review && reviews.get(n.review);
		if(r && r.correction?.worker===n.worker && !(r.correction.ordinary && r.correction.resumed) && w.token===n.token)
			yield subject(run,n,"correction",w,r.id,digest(n.grain.task));
		for(const gap of rows){
			if(run.conflict || gap.state!=="assigned" || gap.receipt!==run.goal?.check || gap.grain!==n.grain.id || gap.worker!==n.worker || !gap.review)continue;
			const linked=reviews.get(gap.review)?.observation?.addresses?.some(a=>a.id===gap.id && a.grain===gap.grain && a.worker===n.worker);
			if(linked)yield subject(run,n,"blocker",w,gap.review,gap.receipt,gap.id);
		}
	}
}

/** @param {Run} run @param {Call} e */
export function currentInstruction(run,e) {
	const n=e.grain && run.nodes[e.grain];
	return !!n && !!e.instruction && n.token===e.token && [...subjects(run,[n])].some(s=>s.id===e.id && !!instructionMessage(run,s));
}

/** Reconcile the same material event once across issuer/recipient wakes and reader upgrades.
 * @param {Run} run @param {string} issuer */
export function queueInstructions(run,issuer) {
	const seen=new Set(run.instructions?.map(c=>c.id)),nodes=Object.values(run.nodes);
	for(const s of subjects(run,issuer===run.owner?nodes:nodes.filter(n=>n.worker===issuer))){
		if(seen.has(s.id))continue;
		const obj=instructionMessage(run,s);if(!obj)continue; // Scoped status reports this unsupported subject; unrelated reservations still run.
		(run.instructions??=[]).push({id:s.id,grain:s.grain,token:s.token,instruction:s.instruction,kind:"instruction",issuer,state:"ready",
			...messageTo(issuer,obj.recipient,obj.message)});
		seen.add(s.id);
	}
}

/** @typedef {{id:string,kind:string,disposition:"act"|"wait"|"decision"|"unsupported",role:"writer"|"issuer"|"owner"|"operator",session?:string,
 * grain?:string,message:string,tool?:string,arguments?:Record<string,import("./model.js").Json>,delivery?:string,source?:string,
 * prepare?:{tool:string,known:Record<string,import("./model.js").Json>,supply:string}}} Advice */
/** @typedef {(frozen?:boolean)=>string|undefined} Tip */
/** Advice follows the operation it names. A historical observation may use the same verified frozen checkpoint as the check itself.
 * @param {Run} run @param {Instruction|undefined} a @param {Tip} tip */
export function instructionPermitted(run,a,tip){
	if(!a || !run.goal || ["read","correction","supply"].includes(a.kind) || run.goal.target===tip())return true;
	const historical=a.kind==="diagnosis" && a.step==="observe" ||
		a.kind==="proposal" && run.diagnostics?.some(d=>d.id===a.evidence && d.kind==="observe");
	return !!historical && run.goal.target===tip(true);
}

/** @param {Run} run @param {Node[]} nodes @param {string} actor @param {Tip} [tip] @returns {Advice[]} */
export function writerInstructions(run,nodes,actor,tip){
	const sent=new Map(run.instructions?.map(e=>[e.id,e]));
	return [...subjects(run,nodes)].flatMap(/** @returns {Advice[]} */ s=>{
		const obj=instructionMessage(run,s);
		if(!obj)return [{id:s.id,kind:s.instruction.kind,grain:s.grain,role:"issuer",source:s.instruction.source,disposition:"unsupported",
			message:`No instruction was sent: the frozen ${s.instruction.kind} evidence does not establish a recipient and an executable action. Preserve the original grant and report source ${s.instruction.source}.`}];
		const e=sent.get(s.id),refused=e?.state==="refused";
		const proposal=s.instruction.kind==="proposal" && run.diagnostics?.find(d=>d.id===s.instruction.evidence);
		const subset=s.instruction.kind==="subset" && run.footprintRequests?.find(q=>q.id===s.instruction.evidence);
		const preview=s.instruction.kind==="preview" && run.effects.find(e=>e.id===s.instruction.assignment);
		const o=preview && preview.kind==="writer" && preview.observer;
		/** @type {{tool:string,arguments:Record<string,import("./model.js").Json>}|undefined} */
		const request=proposal?diagnosticRequest(run,proposal):subset?{tool:"foundry_checkpoint",arguments:subsetRequest(run.id,subset)}:
			o?{tool:"foundry_grant",arguments:{run:run.id,approveObserver:{grain:s.grain,pair:o.pair,file:o.file,blob:o.before,...(o.previous && {previous:{...o.previous}}),preview:s.instruction.evidence}}}:undefined;
		const prepare=s.instruction.kind==="diagnosis" ? s.instruction.step : s.instruction.kind==="footprint" ? "footprint" : undefined;
		/** @type {Record<string,import("./model.js").Json>} */ const args={run:run.id};
		if(obj.tool==="foundry_submit" || s.publish)args.token=text(s.token,"writer token");
		if(s.publish)Object.assign(args,s.publish);
		const moved=!!tip && !instructionPermitted(run,s.instruction,tip);
		return [{id:s.id,kind:s.instruction.kind,grain:s.grain,role:request?"owner":"writer",session:obj.recipient,
			disposition:refused?"unsupported":moved?"wait":request?"decision":"act",source:s.instruction.source,delivery:e?.state,
			message:refused?"Instruction delivery was refused; do not send it again.":moved?`Wait for a current assessment; the instruction was based on target ${run.goal?.target}.`:obj.message,
			...(!refused && !moved && actor===obj.recipient && (request || (prepare?{prepare:{tool:"foundry_propose",
				known:{run:run.id,token:text(s.token,"writer token"),check:s.instruction.source},supply:prepare}}:{tool:obj.tool,arguments:args})))}];
	});
}

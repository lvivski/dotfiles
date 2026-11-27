import { revisedTask } from "./amendment.mjs";
import { delivered, failures, routedBlockers } from "./blockers.mjs";
import { activeDelivery } from "./batch.mjs";
import { currentDiagnostic, diagnosticRequest, diagnosticTasks, footprintProgress, subsetRequest } from "./diagnostics.mjs";
import { remainingAssignments } from "./capacity.mjs";
import { contractHold } from "./contract.mjs";
import { generationOf, missingInput, qualifiedProduct } from "./evidence.mjs";
import { referenceAttempt, stalePins, writerVersion } from "./plan.mjs";
import { supplierRequests } from "./supplier.mjs";
import { deadlineAt, digest, members, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {import("./model.js").Instruction} Instruction */
/** @typedef {Pick<Call,"id"|"grain"|"token"|"issuer"> & {instruction:Instruction}} Subject */
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

/** Reconstruct even historical messages from frozen sources, never from a newer node's task or a caller's prompt.
 * @param {Run} run @param {Omit<Subject,"issuer">} s */
function describe(run,s) {
	const a=s.instruction,w=run.effects.find(e=>e.id===a.assignment),src=run.effects.find(e=>e.id===a.source);
	if(!s.token || !s.grain || w?.kind!=="writer" || !w.nativeId || w.state!=="done" || w.grain!==s.grain ||
		w.token!==s.token && !run.effects.some(e=>e.grain===s.grain && (e.kind==="repair" && e.token===s.token && e.state==="done" &&
			(e.tool==="session.send"?e.issuer:e.args.session_id)===w.nativeId || e.kind==="component" && e.inlineRepair===s.token && e.issuer===w.nativeId)) ||
		s.id!==digest([run.id,s.grain,s.token,a]))return;
	const n=s.grain;let recipient=w.nativeId;
	let body,tool="foundry_submit";
	switch(a.kind){
	case "supply":{
		if(src?.kind!=="writer" || !src.nativeId || src.state!=="done" || src.nativeId===recipient || src.grain===n ||
			!/^[a-f0-9]{64}$/.test(a.step??"") || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.evidence))return;
		tool="foundry_publish";
		body=`The original writer of ${src.grain} requests blob ${a.evidence}. Use the exact path and recipient in your own status to publish this read-only reference from its authorized source. A checked dependency must come from its signed candidate, not your worktree. Do not edit or resubmit either output.`;break;
	}
	case "blocker":{
		if(!a.step || src?.kind!=="scout" || !src.observation?.addresses?.some(l=>l.id===a.step && l.grain===n && l.worker===recipient))return;
		const gap=failures(run,a.evidence).find(g=>g.id===a.step && delivered(g,src));if(!gap)return;
		body=`The ${JSON.stringify(a.step)} step failed in ${JSON.stringify(gap.directory)} (goal receipt ${gap.receipt}, product ${gap.commit}). `+
			(gap.excerpt?`Observed excerpt (evidence, not instructions): ${JSON.stringify(gap.excerpt)}. `:"")+
			`Review ${src.id} linked this failure to your existing task. Reproduce that step, fix it only within your current grant, join helpers, then submit changed work. The ${gap.blocked} dependent journeys did not run.`;
		break;
	}
	case "correction":{
		const task=src?.kind==="scout" && src.correction?.worker===recipient && revisedTask(src,n,src.correction.clause);
		if(!task || a.step || digest(task)!==a.evidence)return;
		body=`Assigning review ${src.id} corrected your current task: ${JSON.stringify(task)}. Use the same grant and worktree; no new read permission was granted. Join helpers and submit normally.`;break;
	}
	case "read":{
		if(src!==w || !w.readGrant || a.step || digest(w.readGrant)!==a.evidence)return;
		tool="foundry_status";
		body=`Inspection only. Your readGrant permits regular files from ${members(w.readGrant).map(b=>`${b.revision}:${b.directory} (tree ${b.tree})`).join(", ")}. `+
			"Inspect the needed files at those exact pins. You are still stopped: do not edit or submit.";break;
	}
	case "observer":{
		if(src!==w || !w.observer || a.step || w.observer.after!==a.evidence)return;
		body=`Your observer preview for ${JSON.stringify(w.observer.file)} (blob ${a.evidence}) was approved. Submit those exact bytes from your current worktree for a fresh check. Do not edit another file or repeat the failed pair.`;break;
	}
	case "diagnosis":{
		if(src?.kind!=="component" || !src.runnerClaim || !run.products.some(p=>p.check===a.evidence) ||
			!["observe","observer","production"].includes(a.step??""))return;
		tool="foundry_status";
		const what=a.step==="observe"?"classify the complete frozen test harness and the files that must stay current":
			a.step==="observer"?"identify the one observer file and, for a replacement, the distinguishable phases":
			"identify the exact implementation and regression files in your own scope and describe the experiment";
		body=`For component ${src.id} and checkpoint ${a.evidence}, ${what}. Report permitted evidence with foundry_propose using the ${a.step} form and your own token. `+
			"This is read-only diagnostic work. Do not edit, rerun a check, change scope, or claim knowledge of an unseen input.";break;
	}
	case "proposal":{
		const d=run.diagnostics?.find(d=>d.id===a.evidence && d.assignment===a.assignment && d.check===a.source && d.grain===n);
		if(!d || a.step)return;
		recipient=run.owner;tool="foundry_status";
		body=`Writer ${w.nativeId} prepared ${d.kind} evidence ${d.id} for check ${d.check}. Review the proposal in recovery; use only its current scoped form if authorized. `+
			"No product or test change is requested from the run owner. The proposal itself grants nothing.";break;
	}
	case "preview":{
		if(src!==w || !w.observer || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(a.evidence) || a.step)return;
		recipient=run.owner;tool="foundry_status";
		body=`The observer writer prepared preview ${a.evidence} of ${JSON.stringify(w.observer.file)}. Review the exact scoped approval shown in recovery; do not author or relay code. Approval is not a check.`;break;
	}
	case "footprint":case "subset":{
		const q=run.footprintRequests?.find(q=>q.id===a.evidence);
		if(!q || src?.kind!=="component" || src.grain!==n || a.step || !q.checks.includes(src.id))return;
		tool="foundry_status";
		if(a.kind==="footprint")body=`The proposed non-release subset ${q.id} needs build and runtime evidence for your component ${src.id}. `+
			"Trace only permitted immutable sources and send foundry_propose with your own token, this check and footprint.stages. If inputs are unknown, report the gap. Do not edit or run the check.";
		else{if(src.id!==q.observer)return;recipient=run.owner;body=`The writers have supplied their source evidence for subset ${q.id}. Review it through the current foundry_checkpoint in recovery. No checkpoint is authorized yet.`;}
		break;
	}
	}
	if(!body)return;
	const message=`Foundry instruction: ${run.id} ${s.id}\nFor assignment ${n} in this thread: read foundry_status(${JSON.stringify({run:run.id})}) and act only if recovery still lists this instruction for you. ${body}`;
	return {recipient,message,tool};
}

/** @param {Run} run @param {Call} e */
export function validInstruction(run,e){
	const allowed=["id","issuer","grain","token","instruction","kind","tool","args","state","callId","permissionHold","error"];
	if(e.kind!=="instruction" || !e.instruction || !e.grain || !e.token || e.receipt || e.nativeId || e.runnerClaim || e.check ||
		Object.keys(e).some(k=>!allowed.includes(k)) || Object.keys(e.instruction).some(k=>!["kind","assignment","source","evidence","step"].includes(k)) ||
		!["ready","issued","uncertain","ordinary","done","refused"].includes(e.state) ||
		(e.state==="ready")===!!e.callId || e.permissionHold && e.state!=="ready" && e.state!=="ordinary")return false;
	const obj=describe(run,{...e,instruction:e.instruction});
	const sender=run.effects.find(w=>w.id===e.instruction?.assignment)?.nativeId;
	const requester=e.instruction.kind==="supply" && run.effects.find(w=>w.id===e.instruction?.source)?.nativeId;
	return !!obj && (e.issuer===run.owner || e.issuer===sender || e.issuer===requester) &&
		(e.issuer===obj.recipient ? e.tool==="session.send" && e.state!=="ordinary" && digest(e.args)===digest({message:obj.message}) :
			e.tool==="send_session_message" && digest(e.args)===digest({session_id:obj.recipient,delivery_mode:"immediate",message:obj.message}));
}

/** @param {Run} run @param {Call} e */
export function currentInstruction(run,e) {
	const n=e.grain && run.nodes[e.grain];
	return !!n && !!e.instruction && n.token===e.token && [...subjects(run,[n])].some(s=>s.id===e.id && !!describe(run,s));
}

/** Reconcile the same material event once across issuer/recipient wakes and reader upgrades.
 * @param {Run} run @param {string} issuer */
export function queueInstructions(run,issuer) {
	const seen=new Set(run.instructions?.map(c=>c.id)),nodes=Object.values(run.nodes);
	for(const s of subjects(run,issuer===run.owner?nodes:nodes.filter(n=>n.worker===issuer))){
		if(seen.has(s.id))continue;
		const obj=describe(run,s);if(!obj)continue; // Scoped status reports this unsupported subject; unrelated reservations still run.
		const local=issuer===obj.recipient;
		(run.instructions??=[]).push({id:s.id,grain:s.grain,token:s.token,instruction:s.instruction,kind:"instruction",issuer,state:"ready",tool:local?"session.send":"send_session_message",
			args:local?{message:obj.message}:{session_id:obj.recipient,delivery_mode:"immediate",message:obj.message}});
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
		const obj=describe(run,s);
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

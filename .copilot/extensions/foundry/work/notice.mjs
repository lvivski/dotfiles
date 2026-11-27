import { revisedTask } from "./amendment.mjs";
import { delivered, failures } from "./blockers.mjs";
import { messageTo } from "./dispatch.mjs";
import { tokenSource } from "./lineage.mjs";
import { effectAt } from "./revision.mjs";
import { digest, members } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Call */
/** @typedef {Pick<Call,"id"|"grain"|"token"> & {instruction:import("./model.js").Instruction}} Subject */
/** Reconstruct even historical messages from frozen sources, never from a newer node's task or a caller's prompt.
 * @param {Run} run @param {Subject} s */
export function instructionMessage(run,s) {
	const a=s.instruction,w=effectAt(run,a.assignment),src=effectAt(run,a.source);
	if(!s.token || !s.grain || w?.kind!=="writer" || !w.nativeId || w.state!=="done" || w.grain!==s.grain ||
		!tokenSource(run.effects,w,t=>t===s.token) ||
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
	const obj=instructionMessage(run,{...e,instruction:e.instruction});
	const sender=effectAt(run,e.instruction.assignment)?.nativeId;
	const requester=e.instruction.kind==="supply" && effectAt(run,e.instruction.source)?.nativeId;
	if(!obj || !(e.issuer===run.owner || e.issuer===sender || e.issuer===requester))return false;
	const expected=messageTo(e.issuer,obj.recipient,obj.message);
	return e.tool===expected.tool && !(e.tool==="session.send" && e.state==="ordinary") && digest(e.args)===digest(expected.args);
}

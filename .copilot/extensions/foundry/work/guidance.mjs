import { changedFrom, inconclusiveRepair, missingInput, relinquishable } from "./evidence.mjs";
import { stalePins } from "./lineage.mjs";
import { writerInstructions } from "./instructions.mjs";
import { inputChoices } from "./resupply.mjs";
import { contractHold } from "./contract.mjs";
import { draftAllowed, partId } from "./drafts.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./instructions.mjs").Advice} Advice */
/** A status read projects the actor who can act. It never dispatches, reserves or approves.
 * @param {Run} run @param {string} actor @param {ReturnType<typeof import("./visibility.mjs").visible>} view @param {import("./instructions.mjs").Tip} [tip] */
export function guidance(run,actor,view,tip) {
	const {owner,nodes,pending,summary}=view;
	/** @type {Advice[]} */ const rows=[];
	/** @param {Omit<Advice,"id">} row */
	const add=row=>rows.push({...row,id:digest([run.id,row.kind,row.source,row.grain,row.session])});
	const query={tool:"foundry_status",arguments:{run:run.id}};
	const quarantine=contractHold(run);
	if(summary.qualified || run.products.at(-1)?.qualifiedAt && !run.active && !quarantine)return rows;
	if(quarantine || summary.expired || !run.active){
		const hold=run.policyHold;
		add(quarantine || summary.expired?{kind:"contract",disposition:"unsupported",role:"operator",message:quarantine??"The deadline has elapsed. Do not start new work or retry an issued call."}:
			hold?{kind:"permission",disposition:"decision",role:"issuer",session:hold.issuer,source:hold.effect,
				message:"Resolve the managed setting in the named issuer. Its normal permission observer handles the same run; do not restart it.",
				...(actor===hold.issuer && {tool:"foundry_status",arguments:{run:run.id,detail:"permissions"}})}:
			{kind:"pause",disposition:"decision",role:"operator",session:run.owner,message:"The operator paused this run. Only an explicit decision to resume the original run allows more work."});
		return rows;
	}
	for(const e of pending){
		if(e.permissionHold)add({kind:"permission",disposition:"decision",role:"issuer",session:e.issuer,grain:e.grain,source:e.id,
			message:`${e.permissionHold} Resolve this only in the issuing session.`,...(actor===e.issuer && {tool:"foundry_status",arguments:{run:run.id,detail:"permissions"}})});
		else if(e.state==="issued" || e.state==="uncertain")
			add({kind:e.kind,disposition:"wait",role:"issuer",session:e.issuer,grain:e.grain,source:e.id,
				message:`Wait for the original ${e.kind} ${e.id} in its issuing session. A missing reply is not a failed check or permission to retry.`});
		else if(e.state==="ordinary")add({kind:"prepared",disposition:"act",role:"issuer",session:e.issuer,grain:e.grain,source:e.id,
			message:"Only the original issuer may use the exact entry in its current prepared list, once. Do not reconstruct the call.",...(actor===e.issuer && query)});
	}
	rows.push(...writerInstructions(run,nodes,actor,tip));
	if(owner)for(const d of run.correctionDrafts??[]){
		if(d.blob || d.goal!==run.goal?.check)continue;
		for(const p of d.parts){
			if(p.state==="returned")continue;
			const blocked=p.state==="held",scope=!draftAllowed(d),ended=scope && (d.decision?.status==="dismissed" || d.decision?.status==="unavailable");
			rows.push({id:partId(d,p),kind:"author",disposition:blocked || ended?"unsupported":scope?"decision":"wait",
				role:scope?"operator":"issuer",session:run.owner,source:d.check,grain:p.source.grain,
				message:blocked?`No proposal for this source: ${p.reason}. The failed check and original grant are unchanged.`:
					ended?"The scope decision was declined or unconfirmed. No author was granted access; do not repeat it automatically.":
					scope?`Scope decision ${d.decision?.status??"pending"} for the exact files. Do not write or relay code.`:
					p.workflow?`Wait for original author ${p.workflow}. ${p.reason??"No second launch is authorized."}`:
					p.dispatch?`Author dispatch ${p.dispatch} has no confirmed workflow identity. Keep the original call; do not replay.`:
					`The bounded author is queued for ${d.check}. ${p.reason??"No owner patch is needed."}`});
		}
	}
	for(const n of nodes){
		const g=n.grain.id,source=n.check??n.review,session=n.worker;
		if(n.state==="checking" || n.state==="reviewing"){
			if(!rows.some(a=>a.source===n.check))add({kind:n.state,disposition:"wait",role:"writer",session,grain:g,source,
				message:n.state==="checking"?"This submission is frozen for its component check. Wait for the original receipt; do not edit or resubmit.":
					"Wait for the independent review of these exact bytes. Do not edit the frozen candidate or review it yourself."});
			continue;
		}
		if(!n.worker || !n.token)continue;
		const c=run.effects.find(e=>e.id===n.check), args={run:run.id,token:n.token}, actual=n.worker===actor;
		if(n.state==="writing" && n.check && inconclusiveRepair(n,c))add({kind:"cannot-repair",disposition:"act",role:"writer",session,grain:g,source,
			message:"If the grant forbids another repair, report cannotRepair with this check and your reason. Otherwise make the permitted repair.",...(actual && query)});
		else if(n.state==="writing" && relinquishable(run,n))add({kind:"relinquish",disposition:"act",role:"writer",session,grain:g,source,
			message:"Repair within the current grant. If no scoped fix or missing input exists, use the relinquish check from your status; do not repeat the observation.",...(actual && query)});
		if(n.state!=="blocked")continue;
		const stale=stalePins(run,n),missing=missingInput(n),from=changedFrom(n,c);
		if(stale.length)add({kind:"dependency",disposition:"decision",role:"owner",session:run.owner,grain:g,source,
			message:`Review the changed producer bindings: ${stale.map(([id,pin])=>`${id}@${pin}`).join(", ")}. Do not substitute a path, matching bytes or a different producer. Do not edit code in the owner session.`});
		else if(from)add({kind:"changed-candidate",disposition:"act",role:"writer",session,grain:g,source,message:"If you have a scoped correction, change the original directory before submitting. The original incomplete check is not replayed.",
			...(actual && {tool:"foundry_submit",arguments:{...args,changedFrom:from}})});
		else if(missing!==undefined && !rows.some(a=>a.grain===g && a.kind==="read")){
			const need=n.stop?.input;
			const choices=inputChoices(run,n);
			if(choices.length){
				for(const a of choices)add({kind:"input",disposition:"decision",role:"owner",session:run.owner,grain:g,source:a.blob,
					message:`Decide whether ${JSON.stringify(a.file)} (${a.blob}) resolves ${JSON.stringify(missing)} for ${session}. ${need?.hold??"The native form verifies the original grant before asking."} Do not copy or republish the file.`,
					...(owner && {tool:"foundry_grant",arguments:{run:run.id,input:{grain:g,blob:a.blob}}})});
				continue;
			}
			add({kind:"missing-input",disposition:need?"wait":"decision",role:need?"writer":"owner",session:need?session:run.owner,grain:g,source,
				message:need?.hold??(need?`Waiting for the permitted reference ${need.blob}. Keep the stopped token; do not edit or submit.`:
					`Original writer reports: ${JSON.stringify(missing)}. Match an offered reference with grant.input, or use grant.repairBaseline only for this writer's genuine unchanged prior directory. Those actions recheck authority; neither requires an owner-authored fix.`)});
		}else if(missing===undefined && !rows.some(a=>a.grain===g))
			add({kind:"stopped",disposition:"unsupported",role:"writer",session,grain:g,source,message:`${n.reason??"No writable assignment."} Preserve the original evidence. A prior check or preview is not permission to edit or resubmit.`});
	}
	const latest=owner?new Map(run.effects.flatMap(r=>r.kind==="scout"?[[r.squad,r]]:[])).values():[];
	for(const r of latest){
		if(r.state!=="blocked" || !r.obstacle)continue;
		add({kind:r.obstacle.kind,disposition:r.obstacle.kind==="other"?"unsupported":"wait",role:"owner",session:r.issuer,source:r.id,
			message:`${r.error??"Charter review stopped."} ${r.obstacle.kind==="other"?"No automatic retry follows from this diagnostic.":"Keep the saved report; Foundry revalidates its evidence on the original run. Do not launch a duplicate scout."}`});
	}
	if(owner && !rows.length && summary.blocker)add({kind:"run",disposition:"unsupported",role:"owner",session:run.owner,source:run.join?.check??run.goal?.check,
		message:`${summary.blocker} Read the original proof. If no current action is authorized, report this run, check and missing decision; do not supply a product patch from the owner checkout.`,
		tool:"foundry_status",arguments:{run:run.id,detail:"proof"}});
	return rows;
}

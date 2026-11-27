import { mending } from "./rules/mending.mjs";
import { randomUUID } from "node:crypto";
import { transition } from "./machine.mjs";
import { controlRule, controlSubject, failedTest, repairStop, repairTip, stoppedTest } from "./calibration.mjs";
import { checkReceipt, currentEvaluation } from "./evidence.mjs";
import { expired, reserveCheck } from "./native.mjs";
import { prepareRepin } from "./repin.mjs";
import { changedFiles, commitAt, committedFile, git, regularFiles, retain, stageTest } from "./product.mjs";
import { digest, fail, FoundryError, text } from "./values.mjs";
import { safeEvidence } from "./critique.mjs";
import { assign } from "./assignment.mjs";
import { evaluatorOverlay } from "./contract.mjs";
import { observedOverlay, overlaySeal } from "./attestation.mjs";
import { noWorkflowSlot } from "./capacity.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").TestRepair} Repair */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {"author"|"review"} Phase */
/** @typedef {{message:string;subject:string}} Packet */
/** @typedef {{run:string;stop:string;dispatch:string;phase:Phase;subject:string}} Ticket */
/** @typedef {{id:string;subject:string;reason:string;change?:string;approved?:boolean}} Answer */
/** @param {Repair} j @param {string} type @param {Record<string,boolean>} [facts] */
function move(j,type,facts={}){j.state=transition(mending,{value:j.state,context:null},{type},facts,true).snapshot.value;}
/** @param {Repair} j @param {string} why */
export function holdRepair(j,why){move(j,"hold");j.reason=why;}
/** @param {Repair} j @param {unknown} error */
export function queueMechanic(j,error){
	if(j.workflow){
		if(j.continuation!==j.workflow || !(error instanceof FoundryError) || error.code!=="repair_capacity")return false;
		delete j.continuation;delete j.continuationAttempt;
	}else{
		if(!noWorkflowSlot(error))return false;
		move(j,"capacity");delete j.dispatch;delete j.subject;
	}
	j.reason="Waiting for native workflow capacity.";return true;
}
/** @param {Repair} j */
export const queuedMechanic=j=>j.reason==="Waiting for native workflow capacity.";
/** @param {Run} run @param {Repair} j @param {string} cwd @param {keyof Repair["controls"]} role */
function reserve(run,j,cwd,role){
	const commit=role==="oldGood"?j.product:text(j.candidate,"control subject");
	const c=reserveCheck(run,run.owner,cwd,commit,j.rule.probe,{kind:"control",calibration:{role,stop:j.stop,subject:controlSubject(j,role)}});
	c.args.description=`Control ${role}: ${j.rule.check}`;j.controls[role]=c.id;
}
/** @param {Run} run @param {Repair} j @param {keyof Repair["controls"]} role @param {(c:Check)=>void} verify */
function observation(run,j,role,verify){
	const c=run.effects.find(e=>e.id===j.controls[role]);
	if(c?.kind!=="control" || c.calibration?.subject!==controlSubject(j,role))fail("stale_assignment","Control subject changed");
	const receipt=checkReceipt(c);
	if(!receipt){
		if(c.state==="done" || c.state==="refused")fail("unavailable_control",c.error??"Control finished without signed evidence");
		return;
	}
	verify(c);
	if(!receipt.control || j.assertion && receipt.control.assertion!==j.assertion || receipt.control.matched!==(receipt.exit===0) || !(receipt.exit===0 || receipt.exit===1))
		fail("unavailable_control",`Control ${role} did not observe the expected assertion: ${receipt.output}`);
	if(role==="oldGood")j.assertion=receipt.control.assertion;
	return receipt.exit;
}
/** @param {string} cwd @param {Run} run @param {Repair} j @param {string} [target] */
export function repairCurrent(cwd,run,j,target){
	const c=repairStop(run,j);
	const tip=repairTip(cwd,run,j,target);
	if(!c || !stoppedTest(run,c) || c.commit!==j.product || !tip || run.owner!==j.owner ||
		c.kind==="goal" && (!currentEvaluation(run,c) || run.goal?.target!==j.target || run.join) ||
		(c.kind==="product" || c.rollout) && run.join?.target!==j.target)return;
	const rule=controlRule(cwd,run,j.rule.check);
	if(!rule || rule.driver!==j.driver || digest(rule.rule)!==digest(j.rule))return false;
	const contract=[run.policy.source,j.rule.probe,...new Set(run.policy.squads.flatMap(s=>[s.charter,...("boundary" in s?s.boundary:[])])),
		...Object.values(run.nodes).flatMap(n=>[n.grain.specification,...n.grain.boundary])];
	// A changed contract needs its own authority. Test implementations may have changed since activation.
	if(![j.target,j.product,j.pin].some(c=>changedFiles(cwd,run.policy.base,c,contract).length))return tip;
}
/** @param {Run} run */
export const repairPermitted=run=>run.active && !expired(run) && !run.policyHold && !run.conflict && !run.independent && !run.blocker &&
	!run.effects.some(e=>e.permissionHold) && !run.inspections?.some(i=>i.permissionHold);
/** Called on the ordinary private planning snapshot. Returning true holds product scheduling for this stop.
 * No model or evaluator runs inside this planner.
 * @param {string} cwd @param {Run} run @param {string} actor @param {(c:Check)=>void} verify @param {Set<string>} allowed */
export function planMending(cwd,run,actor,verify,allowed){
	if(!run.active || expired(run) || run.policyHold || run.conflict || run.independent || run.blocker)return false;
	if(actor===run.owner)for(const j of run.testRepairs??[]){
		if(j.state!=="applied" || !j.recheck)continue;
		const e=run.effects.find(c=>c.id===j.recheck);
		if(e?.state==="ready" && !repairTip(cwd,run,j))j.wait="The original test contract or adopted target changed before the recheck. No new verdict was issued.";
		else delete j.wait;
	}
	const terminal=new Set(run.testRepairs?.filter(j=>j.state==="product" || j.state==="unobserved" || j.state==="applied").map(j=>j.stop));
	let blocked=false;
	for(const c of [...run.effects]){
		if(c.tool!=="bash" || terminal.has(c.id) || !stoppedTest(run,c))continue;
		const subject=failedTest(c);
		if(!c.commit || !subject)continue;
		const rule=controlRule(cwd,run,subject.check);
		if(rule && planStop(cwd,run,actor,verify,c,rule,subject.grain,allowed) && (c.kind!=="component" || c.rollout))blocked=true;
	}
	return blocked;
}
/** @param {string} cwd @param {Run} run @param {string} actor @param {(c:Check)=>void} verify @param {Check} c
 * @param {NonNullable<ReturnType<typeof controlRule>>} rule @param {string|undefined} grain @param {Set<string>} allowed */
function planStop(cwd,run,actor,verify,c,rule,grain,allowed){
	let j=run.testRepairs?.find(j=>j.stop===c.id);
	const target=commitAt(cwd,run.policy.target);
	if(c.kind==="product" && run.join?.target!==target || c.kind==="goal" && run.goal?.target!==target ||
		c.rollout && run.join?.target!==target)return false; // The ordinary graph owns target reconciliation.
	if(actor!==run.owner || !repairPermitted(run))return true;
	if(!j){
		verify(c);
		if(!c.commit)return false;
		const pin=grain?c.commit:c.evaluatorRevision??(c.kind==="goal"?run.policy.base:c.commit);
		const from=!grain && c.evaluatorRevision && (c.kind==="goal" || c.kind==="product") && evaluatorOverlay(run,c.kind,pin).paths.includes(rule.rule.check)?pin:c.commit;
		const before=regularFiles(cwd,from,[rule.rule.check])[0].oid;
		j={...rule,stop:c.id,owner:actor,target,product:c.commit,pin,before,grain,state:"diagnosing",controls:{oldGood:""}};
		(run.testRepairs??=[]).push(j);reserve(run,j,cwd,"oldGood");
		if(!repairCurrent(cwd,run,j))holdRepair(j,"Frozen contract, controls, or permission changed; no test repair is authorized.");
		else if(!grain && c.evaluatorRevision && (c.kind==="goal" || c.kind==="product") && c.evaluatorRevision!==(run.policy.contractTarget??run.policy.base) &&
			observedOverlay(checkReceipt(c))!==overlaySeal(evaluatorOverlay(run,c.kind,c.evaluatorRevision)))
			holdRepair(j,"The historical receipt does not establish the evaluator inputs that actually failed.");
		return true;
	}
	if(j.state==="held")return failedTest(c)?.missing!==true;
	if(!repairCurrent(cwd,run,j)){holdRepair(j,"Test-repair inputs, target or permission changed; no new test pin was adopted.");return true;}
	try{
		if(j.state==="diagnosing"){
			const exit=observation(run,j,"oldGood",verify);
			const missing=failedTest(c)?.missing===true;
			if(exit!==undefined)move(j,"control",{rejectsGood:exit===1,acceptsGood:exit===0,missing});
			if(exit===0 && missing)j.reason="The unchanged observer accepts the known-good case. The original observation is still missing; no product repair or automatic retry.";
			if(exit===0)return false;
			if(exit===1 && run.testRepairs?.some(other=>other!==j && other.state==="applied" && other.product===j.product && other.rule.check===j.rule.check))
				holdRepair(j,"A certified repair already ran on this unchanged product. Review the remaining failure.");
		}else if(j.state==="checking"){
			const good=observation(run,j,"newGood",verify),bad=observation(run,j,"newBad",verify);
			if(good!==undefined && bad!==undefined){
				if(good===0 && bad===1)move(j,"control",{discriminates:true});
				else holdRepair(j,"The proposed test does not distinguish the known-good and known-bad cases.");
			}
		}else if(j.state==="approved"){
			if(!allowed.has(j.subject??""))return true;
			if(!j.author || !j.reviewer || j.author===j.reviewer || !j.revision ||
				observation(run,j,"oldGood",verify)!==1 || observation(run,j,"newGood",verify)!==0 || observation(run,j,"newBad",verify)!==1)
				fail("unproven_repair","Missing independent evidence for test adoption");
			verify(c);
			if(c.kind==="goal"){
				const p=prepareRepin(cwd,run,actor,{from:j.pin,revision:j.revision,files:[j.rule.check]},verify,j);p.apply(run);
			}else{
				const fresh=reserveCheck(run,actor,cwd,j.product,text(c.check,"original check"),c.grain?{kind:"component",grain:c.grain}:{kind:"product"});
				fresh.testPin=c.id;j.recheck=fresh.id;
				if(c.rollout)fresh.rollout=c.rollout;
				else if(c.kind==="component" && c.grain){
					const n=run.nodes[c.grain];if(n.state==="blocked" || n.state==="waiting")assign(n,"recheck");n.check=fresh.id;
				}else if(c.kind==="product" && run.join)run.join={...run.join,check:fresh.id};
				else throw Error("Missing original check for repair");
			}
			move(j,"install");return false;
		}
	}catch(e){
		if(!(e instanceof FoundryError))throw e;
		if(j.state==="diagnosing" && e.code==="unavailable_control" && failedTest(c)?.missing){
			move(j,"unavailable",{missing:true});j.reason=`Observation still missing: ${e.message}. No product change or automatic retry.`;return false;
		}
		holdRepair(j,e.message);
	}
	return true;
}
/** @param {string} cwd @param {Run} run @param {Repair} j @param {Phase} phase */
export function repairPacket(cwd,run,j,phase){
	const original=checkReceipt(run.effects.find(e=>e.id===j.stop));
	const source=(/** @type {string} */ rev,/** @type {string} */ file)=>{
		return safeEvidence(file,committedFile(cwd,rev,file),"invalid_controls");
	};
	const requirements=[...new Set([run.policy.sharedBrief,...run.policy.squads.flatMap(s=>[s.charter,...("boundary" in s?s.boundary:[])]),
		...Object.values(run.nodes).flatMap(n=>[n.grain.specification,...n.grain.boundary])].filter(/** @returns {p is string} */ p=>!!p))];
	const describe=(/** @type {keyof Repair["controls"]} */ role)=>{const r=checkReceipt(run.effects.find(e=>e.id===j.controls[role]));return r && {role,check:j.controls[role],commit:r.commit,exit:r.exit,observation:r.control,output:safeEvidence(j.rule.probe,r.output)};};
	const prior=safeEvidence(j.rule.check,git(cwd,["cat-file","blob",j.before]),"invalid_controls");
	const acceptance=run.productRepins?.flatMap(p=>p.targetFrom && p.acceptance?[{target:p.revision,change:safeEvidence(run.policy.source,p.acceptance)}]:[]);
	const data={run:run.id,direction:safeEvidence(run.policy.source,run.policy.direction),acceptance,stop:j.stop,product:j.product,evaluator:j.pin,check:j.rule.check,grain:j.grain,assertion:j.assertion,
		requirements:requirements.map(p=>[p,source(run.policy.base,p)]),before:prior,
		failure:original && safeEvidence(j.rule.check,original.output),...(phase==="review" && {after:source(text(j.revision,"proposed revision"),j.rule.check),
			probe:source(run.policy.base,j.rule.probe),controls:[describe("oldGood"),describe("newGood"),describe("newBad")],candidate:j.candidate})};
	const message=safeEvidence(j.rule.check,JSON.stringify(data));
	return {subject:digest([phase,data]),message};
}
/** @param {Repair} j @param {Phase} phase @param {string} subject */
export function claimRepair(j,phase,subject){
	if(j.state!==(phase==="author"?"draft":"review"))fail("stale_assignment","The repair phase was already claimed");
	move(j,"claim");j.subject=subject;j.dispatch=randomUUID();delete j.workflow;delete j.reason;delete j.continuation;delete j.continuationAttempt;delete j.awaitingPermission;
}
/** @param {string} cwd @param {Run} run @param {Repair} j @param {Phase} phase @param {Packet} packet @param {Answer} answer */
export function repairAnswer(cwd,run,j,phase,packet,answer){
	if(!repairCurrent(cwd,run,j) || j.subject!==packet.subject || answer.subject!==packet.subject || !answer.id || j.workflow!==answer.id ||
		j.state!==(phase==="author"?"authoring":"reviewing"))fail("stale_assignment","Test repair response is no longer current");
	j.reason=text(answer.reason,"test repair rationale");
	if(phase==="review"){
		if(answer.id===j.author || answer.approved!==true){holdRepair(j,j.reason);return;}
		j.reviewer=answer.id;move(j,"endorse");return;
	}
	if(!answer.change){holdRepair(j,j.reason);return;}
	j.author=answer.id;
	const blob=git(cwd,["hash-object","-w","--stdin"],answer.change).toString().trim();
	const revision=stageTest(cwd,j.pin,j.rule.check,blob);
	j.revision=retain(cwd,revision);j.candidate=regularFiles(cwd,j.product,[j.rule.check])[0].oid===blob?j.product:retain(cwd,stageTest(cwd,j.product,j.rule.check,blob));j.blob=blob;
	move(j,"submit");reserve(run,j,cwd,"newGood");reserve(run,j,cwd,"newBad");
}

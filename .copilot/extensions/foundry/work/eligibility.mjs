import { currentDelivery, activeDelivery } from "./batch.mjs";
import { pendingSuccessor, rolloutSlots } from "./campaign.mjs";
import { currentControl, repairStop } from "./calibration.mjs";
import { awaitingReply, unissued } from "./dispatch.mjs";
import { checkReceipt, milestoneBlocker, productPin, qualifiedProduct } from "./evidence.mjs";
import { frozenCheckpoint } from "./frozen.mjs";
import { validIsolation } from "./isolation.mjs";
import { matchesPair, pairedInput, partitionConflict } from "./partition.mjs";
import { commitAt, verifyContracts } from "./product.mjs";
import { currentChange } from "./replacement.mjs";
import { currentRemedy, origin, remedyWriter } from "./remedy.mjs";
import { fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {(cwd:string,run:Run,e:Check,tip:string)=>void} LiveGuard */
/** @typedef {{target?:string,contract?:string,sample?:LiveGuard,preparation?:{group:string,attempts:Check[]}}} Requirements */

/** A current obligation either runs on its immutable pins (true), or names the guard
 * that must still pass immediately before preparation and evaluation. @param {Run} run @param {Check} e
 * @returns {boolean|Requirements} */
function authority(run,e){
	if(e.tool!=="bash" || e.lane || e.state==="retired" || e.state==="withdrawn")return false;
	const pending=()=>unissued(e) || awaitingReply(e);
	if(e.kind==="control")return currentControl(run,e) && pending();
	const delivery=activeDelivery(run);
	if(delivery || e.delivery)return !!delivery && delivery.id===e.delivery && pending() && {sample:guardDelivery};
	if(e.kind==="rerun")return !!e.rerun && pending() && !run.independent && {sample:guardObservation};
	if(e.kind==="component"){
		if(e.rollout || e.replacement){
			const change=currentChange(run,e);
			if(!change)return false;
			const contract=change.rollout?.harness??productPin(run)??fail("stale_pin","No approved component contract");
			if(change.rollout){
				const {attempts,checks}=rolloutSlots(run,change),i=checks.indexOf(e);
				if(i<0 || unissued(e) && pendingSuccessor(run,change) ||
					!checks.slice(0,i).every(c=>c.runnerClaim && checkReceipt(c)?.exit===0))return false;
				return {target:change.revision,contract,preparation:{group:change.id,attempts}};
			}
			return {target:change.revision,contract};
		}
		if(e.remedy)return currentRemedy(run,e);
		const n=e.grain && run.nodes[e.grain];
		return !!n && n.state==="checking" && n.check===e.id;
	}
	if(e.kind!=="goal" && e.kind!=="product" || run.conflict && e.state==="ready" || run.blocker)return false;
	if(run.independent)return !!e.isolation && validIsolation(run) && !run.conflict &&
		(e.kind==="product"?run.join?.check===e.id && !milestoneBlocker(run):run.independent.assessment===e.id);
	if(unissued(e) && partitionConflict(run,e.kind==="product"?run.join?.outputs:undefined))return false;
	return e.kind==="goal"?!qualifiedProduct(run) && run.goal?.check===e.id:run.join?.check===e.id && !milestoneBlocker(run);
}

/** @param {Run} run @param {Check} e */
export const currentCheck=(run,e)=>!!authority(run,e);

/** @type {LiveGuard} */
function guardDelivery(cwd,run,e,tip){
	const d=activeDelivery(run);
	if(!d || d.id!==e.delivery || !currentDelivery(run,d,tip))fail("stale_assignment","Test delivery authority changed; no evaluator was run");
}
/** @type {LiveGuard} */
function guardObservation(cwd,run,e,tip){
	const pin=e.rerun,p=run.products.at(-1),n=e.grain && run.nodes[e.grain];
	if(!pin || run.blocker || run.independent || !p || p.qualifiedAt || p.check!==pin.checkpoint || !n || n.state!=="blocked" || n.check!==pin.of ||
		(pin.observedTarget?tip!==pin.observedTarget || !frozenCheckpoint(cwd,run,pin.observedTarget):run.conflict || p.target!==tip))
		fail("stale_assignment","The approved checkpoint, stopped assignment or run permissions changed; no evaluator was run");
}

/** Claim gates live here, not in the runner. Return only the continuing check on the
 * *original* grant; ordinary already-claimed work needs no subsequent ledger read.
 * @param {string} cwd @param {Run} run @param {Check} e */
export function claimable(cwd,run,e){
	const guard=authority(run,e);
	if(!guard || !awaitingReply(e) || e.runnerStarted)
		fail("unissued_check","Checks are exclusive to the current issued attempt");
	const k=e.calibration,governed=k?run.testRepairs?.find(j=>j.stop===k.stop):e.testPin?run.testRepairs?.find(j=>j.recheck===e.id && j.stop===e.testPin):undefined;
	const stopped=governed && repairStop(run,governed);
	const tip=()=>commitAt(cwd,run.policy.target);
	if((e.kind==="control" || e.testPin) && (!governed || !stopped || (stopped.kind!=="component" || stopped.rollout) && tip()!==governed.target))
		fail("stale_assignment","The issued evaluator no longer has its original assembly");
	if(e.isolation && (tip()!==run.independent?.target || run.effects.some(x=>x.permissionHold)))
		fail("stale_assignment","The approved independent checkpoint target or permissions changed");
	const pair=pairedInput(run,e);
	const job=e.remedy && remedyWriter(run,e),b=job && origin(run,job);
	if(e.remedy && (!b || b.pair.target!==tip() || b.pair.goal!==run.goal?.check || b.pair.checkpoint!==run.products.at(-1)?.check) ||
		pair && !matchesPair(run,pair,tip()) || (e.remedy || pair) && (run.join || run.conflict || run.blocker || run.effects.some(x=>x.permissionHold)))
		fail("stale_assignment","Approved paired inputs are no longer current; no observation was made");
	const ref=run.policy.target,target=(typeof guard==="object"?guard.target:undefined)??(e.verification?.joined?e.verification.target:undefined),id=e.id;
	/** @param {Run} r */
	const clear=r=>r.active && !r.policyHold && !r.effects.some(x=>x.permissionHold);
	const targetCurrent=()=>{
		if(target && commitAt(cwd,ref)!==target)fail("stale_pin","The approved target moved before verification");
	};
	targetCurrent();
	if(typeof guard==="object" && !clear(run))fail("stale_assignment","The original grant is paused or held");
	const shared=typeof guard==="object" && guard.preparation;
	const batch=shared?{group:shared.group,prior:shared.attempts.flatMap(c=>c.commit===e.commit && c.runnerClaim && checkReceipt(c)?
		[{id:c.id,claim:c.runnerClaim}]:[]).reverse()}:undefined;
	return {batch,guard(/** @type {()=>Run|undefined} */ read){
		targetCurrent();
		if(guard===true)return;
		const r=read(),c=r?.effects.find(c=>c.id===id);
		if(!r || c?.tool!=="bash" || !c.runnerStarted)fail("stale_assignment","Original grant unavailable");
		const fresh=authority(r,c);
		if(!clear(r) || typeof fresh!=="object" || fresh.target!==guard.target || fresh.contract!==guard.contract || fresh.sample!==guard.sample)
			fail("stale_assignment","The original grant, ordered prerequisite or permissions changed; no evaluator was run");
		if(fresh.contract)verifyContracts(cwd,{...r.policy,contractTarget:fresh.contract},c.commit??fail("missing_commit","Missing component commit"));
		fresh.sample?.(cwd,r,c,commitAt(cwd,r.policy.target));
	}};
}

import { currentDelivery, activeDelivery } from "./batch.mjs";
import { currentRollout, rolloutOffer } from "./campaign.mjs";
import { repairStop } from "./calibration.mjs";
import { productPin } from "./evidence.mjs";
import { frozenCheckpoint } from "./frozen.mjs";
import { matchesPair, pairedInput } from "./partition.mjs";
import { commitAt, verifyContracts } from "./product.mjs";
import { currentReplacement } from "./replacement.mjs";
import { origin, remedyWriter } from "./remedy.mjs";
import { awaitingReply, currentCheck } from "./reservation.mjs";
import { fail } from "./values.mjs";

/** Live authority may expire, even though the bytes described by an obligation cannot change.
 * @param {string} cwd @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e */
export function claimable(cwd,run,e){
	if(e.tool!=="bash" || !awaitingReply(e) || e.runnerStarted || !currentCheck(run,e))
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
}

/** Mutable preconditions that must still hold after export and preparation. A historical receipt
 * and a verified immutable description never confer an unconditional right to run a checker.
 * @param {string} cwd @param {import("./model.js").Run} run @param {import("./model.js").NativeCall} e */
export function executionAllowed(cwd,run,e){
	const tip=commitAt(cwd,run.policy.target),p=run.products.at(-1);
	if(!run.active || run.effects.some(x=>x.permissionHold))fail("stale_assignment","The original grant is paused or held");
	if(e.rollout || e.replacement){
		if(!(e.rollout?currentRollout(run,e):currentReplacement(run,e)) || tip!==run.policy.contractTarget)
			fail("stale_assignment","The approved owned correction or its target changed; no component was run");
		verifyContracts(cwd,{...run.policy,contractTarget:rolloutOffer(run,e)?.rollout?.harness??productPin(run)},e.commit??fail("missing_commit","Missing component commit"));
	}
	if(e.delivery){
		const d=activeDelivery(run);
		if(!d || d.id!==e.delivery || !currentDelivery(run,d,tip))fail("stale_assignment","Test delivery authority changed; no evaluator was run");
	}
	if(e.rerun){
		const {checkpoint,observedTarget,of}=e.rerun,n=e.grain && run.nodes[e.grain];
		if(run.blocker || run.independent || !p || p.qualifiedAt || p.check!==checkpoint || !n || n.state!=="blocked" || n.check!==of ||
			(observedTarget?tip!==observedTarget || !frozenCheckpoint(cwd,run,observedTarget):run.conflict || p.target!==tip))
			fail("stale_assignment","The approved checkpoint, stopped assignment or run permissions changed; no evaluator was run");
	}
}

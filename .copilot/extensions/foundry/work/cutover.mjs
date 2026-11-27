import { runnerBinding } from "./abi.mjs";
import { resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { pendingSuccessor, rolloutSlots } from "./campaign.mjs";
import { currentChange, currentCheck } from "./eligibility.mjs";
import { boundChange, checkReceipt, productPin } from "./evidence.mjs";
import { historical, submissionEvidence } from "./historical.mjs";
import { originalScope, stalePins } from "./lineage.mjs";
import { originalGrant } from "./ancestry.mjs";
import { expired, reserveCheck } from "./native.mjs";
import { effectAt, heldOutcome } from "./revision.mjs";
import { declareAssessment } from "./requirements.mjs";
import { approvedOrder } from "./approved.mjs";
import { digest } from "./values.mjs";
import { verifyContracts } from "./product.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** A proven original slot is an input to the *new granting operation*, not its result.
 * Never issue/execute a legacy command, promote a description to a grant, or infer a
 * normal release/writer from a missing family field. An unknown field withholds mapping. */
const common=new Set(["id","issuer","kind","tool","args","state","attempt","verification","commit","check","grain","callId","error",
	"permissionHold","usedArtifacts","comparedArtifacts","evaluatorRevision","productEvaluatorRevision","rollout","replacement"]);
const missing=Object.freeze({
	rerun:"the original observation, retained checkpoint and exact replacement overlay",
	calibration:"the approved calibration driver, control role and governed repair",
	testPin:"the certified observer and its original stopped assessment",
	pair:"the two original observers and the exact pinned comparison",
	observer:"the approved test correction and its historical pairing",
	remedy:"the production writer's approved pair, candidate and basis",
	delivery:"the approved test-directory transfer and non-release use",
	isolation:"the selected and withheld ownership/footprint proof",
	lane:"the scoped native foreground authorization",
	recheck:"the original failure and separately admitted recheck",
});
/** @param {string} reason */
const wait=reason=>({reason});
/** Project only original facts of the validated revision. No checkout, hash-object, pin,
 * reservation, signature or native observation occurs on a read.
 * @param {Run} run @param {Check} e */
export function historicalSlot(run,e){
	if(!historical(e) || e.receipt || e.state==="retired" || e.state==="withdrawn" && !run.history?.[e.id])return;
	if(e.state==="refused")return wait("The original native call was refused; no successor is authorized");
	if(e.runnerStarted || e.runnerClaim)return wait("Already claimed; waiting for the original signed outcome, never another runner");
	if(heldOutcome(e))return wait("The original outcome journal contradicts this slot");
	const slot=run.history?.[e.id];
	if(!slot)return wait("No durable pre-claim closure for this exact command; do not replay it");
	if(slot.settlement?.kind==="declined")return wait("The original native call was declined");
	if(slot.closure==="closed-before-runner-claim" && slot.settlement?.kind!=="terminal")
		return wait("Closed before runner claim; awaiting matched terminal history for the original native call");
	if(!run.active || expired(run) || run.conflict || run.blocker || run.policyHold || run.effects.some(c=>c.permissionHold) || run.inspections?.some(i=>i.permissionHold))
		return wait("The original run is paused, expired, conflicted or held");
	const extra=Object.keys(e).find(k=>!common.has(k));
	if(extra)return wait(`No current typed binding for ${Object.hasOwn(missing,extra)?Reflect.get(missing,extra):`original field ${extra}`}`);
	const binding=runnerBinding(run,e);
	if(!binding || !e.commit || !e.check)return wait("The original runner or evaluator pin is not established");
	const n=e.grain && run.nodes[e.grain],at=e.kind==="goal"?run.goal:e.kind==="product"?run.join:undefined;
	const base={original:e.id,issuer:e.issuer,commit:e.commit,check:e.check,cwd:binding.cwd};
	if(e.rollout || e.replacement){
		const b=boundChange(run,e),a=b?.offer;
		if(!b || !a || a.foreground || a.rollout && pendingSuccessor(run,a) || currentChange(run,e)!==a)
			return wait("The original approved bytes, target, output owner or active batch are no longer established");
		const calls=a.rollout?rolloutSlots(run,a).checks:[e],ids=a.rollout?Object.keys(a.rollout.owners):[b.grain],position=calls.indexOf(e);
		if(position<0 || ids.length!==calls.length || !ids.every((id,i)=>calls[i].grain===id && calls[i].commit===a.assembly))
			return wait("The complete original slot order cannot be reconstructed from the approval");
		const prior=calls.slice(0,position);
		for(const c of prior)if(!c.runnerClaim || checkReceipt(c)?.exit!==0)return wait(`Ordered behind original component ${c.id}, without a signed pass`);
		const source=effectAt(run,b.owner.component);
		if(!source?.runnerClaim || checkReceipt(source)?.exit!==0)
			return wait("The original component lacks a signed output; a historical checkpoint corroboration is required");
		if(!currentCheck(run,e))return wait("The original component is not the active approved slot");
		return {reason:"Original slot available for current authorization; no native permission or outcome transfers",
			obligation:{...base,role:"component",grain:b.grain,target:a.revision,approval:a.id,output:b.owner.component,
				members:calls.map(c=>c.id),position,predecessors:prior.map(c=>c.id)}};
	}

	if(at && at.check===e.id && at.commit===e.commit && e.issuer===run.owner && !run.independent &&
		e.check===(e.kind==="goal"?run.policy.goalCheck:run.policy.productCheck) &&
		e.evaluatorRevision===(e.kind==="goal"?run.repins?.at(-1)?.revision:productPin(run)) &&
		e.productEvaluatorRevision===(e.kind==="goal"?productPin(run):undefined) && currentCheck(run,e)){
		if(e.verification?.joined || run.productRepins?.some(p=>p.recheck===e.id || p.amendments?.some(s=>s.recheck===e.id)))
			return wait("The adopted product requires its mixed-target approval, complete ownership and resolution pins");
		return {reason:"Original assessment available for current authorization",obligation:{...base,role:e.kind,target:at.target}};
	}
	if(n && e.kind==="component" && n.state==="checking" && n.worker===e.issuer && n.check===e.id && n.candidate===e.commit &&
		n.grain.check===e.check && !stalePins(run,n).length && originalScope(run,n,effectAt(run,n.review))){
		const prefix=run.effects.slice(0,run.effects.indexOf(e));
		const launch=prefix.filter(c=>c.kind==="writer" && c.grain===e.grain && c.nativeId===e.issuer && c.token===n.token);
		const w=launch[0],source=originalGrant(run,w);
		if(launch.length===1 && w && source && source.review.id===n.review && source.generation===n.generation)
			return {reason:"Original assignment available for current authorization",obligation:{...base,role:"component",grain:n.grain.id,
				writer:w.id,review:n.review,generation:n.generation}};
	}

	return wait("The original assigning grant, active assessment or input pins are not established for this use");
}

/** @param {string} cwd @param {Run} run @param {string} actor */
export function continueSubmission(cwd,run,actor){
	const n=Object.values(run.nodes).find(n=>n.state==="checking" && n.worker===actor),old=effectAt(run,n?.check);
	if(!n || !n.token || old?.kind!=="component" || old.attempt?.version!==2 || !old.commit || !old.check || !old.grain)return false;
	const selected=historicalSlot(run,old);
	if(!selected || !("obligation" in selected) || !("writer" in selected.obligation) || !selected.obligation.writer || selected.obligation.cwd!==cwd)return false;
	const c=reserveCheck(run,actor,cwd,old.commit,old.check,{kind:"component",grain:old.grain},
		{...(old.usedArtifacts && {usedArtifacts:old.usedArtifacts}),...(old.comparedArtifacts && {comparedArtifacts:old.comparedArtifacts})});
	n.check=c.id;
	const source={kind:/** @type {const} */("writer"),id:selected.obligation.writer,policy:run.policy.base,target:run.policy.base,commit:old.commit};
	const evidence=submissionEvidence(run,c,old.id,source,cwd);
	if(!evidence || evidence.slot!==c.id){n.check=old.id;run.effects.pop();return false;}
	c.attempt=evidence.expected;return true;
}

/** The first assessment of a committed brief has no previous feedback, overlay,
 * or prepared inputs. Re-derive those bytes before spending its proven closure.
 * @param {string} cwd @param {Run} r @param {string} actor @param {string} tip */
export function continueActivation(cwd,r,actor,tip){
	const g=r.goal,e=effectAt(r,g?.check);
	if(e?.kind!=="goal" || !g || r.effects[0]!==e || r.owner!==actor || e.issuer!==actor || tip!==r.policy.base ||
		g.target!==tip || g.commit!==tip || r.products.length || r.join || r.independent || r.productRepins?.length || r.repins?.length ||
		(e.attempt?.version!==1 && e.attempt?.version!==2) || !e.check || !e.commit || r.effects.some(x=>x.tool==="bash" && x.attempt?.version===3 && x.attempt.previous===e.id))return false;
	const original=historicalSlot(r,e),d=e.verification;
	if(!original || !("obligation" in original) || original.obligation.role!=="goal" || e.evaluatorRevision || e.productEvaluatorRevision ||
		!Object.keys(e).every(k=>["id","issuer","kind","tool","args","state","callId","error","permissionHold","attempt","verification","commit","check"].includes(k)))return false;
	verifyContracts(cwd,r.policy,tip);
	const inputs=resolveInputs(cwd,{commit:tip,check:e.check,scope:{kind:"goal"}});
	// The pre-description activation still positively names its original
	// policy, target and committed checker. It has no earlier goal feedback.
	if(e.attempt.version===1?!!d:!d || d.steps.length!==1 || d.privateInput || d.joined || d.resolutions ||
		d.use!=="goal" || d.contract!==tip || d.target!==tip || digest(d.steps)!==digest([{member:null,inputs,build:null}]) ||
		digest(d.evaluation)!==digest({kind:"goal",squads:r.policy.squads.map(s=>s.id)}))return false;
	const fresh=reserveCheck(r,actor,cwd,tip,e.check,{kind:"goal"});
	fresh.attempt={...declareAssessment(r,fresh,tip),previous:e.id};g.check=fresh.id;return true;
}

/** Select the exact closed historical slot; the approving operation alone can
 * turn it into a new grant. @param {Run} run @param {string} actor @param {string} tip */
export function nextApprovedSlot(run,actor,tip){
	if(actor!==run.owner || !run.history || !run.join)return;
	const a=run.adoptions?.findLast(a=>a.failed===run.join?.check && a.rollout && a.decision?.status==="answered");
	if(!a || a.revision!==tip)return;
	const order=approvedOrder(run,a);if(!order)return;
	for(const [i,old] of order.originals.entries()){
		if(order.checks[i]!==old || !old.commit || !old.check || !old.grain)continue;
		const selected=historicalSlot(run,old);
		if(!selected || !("obligation" in selected) || !("approval" in selected.obligation) || selected.obligation.approval!==a.id)continue;
		return {approval:a,original:old};
	}
}

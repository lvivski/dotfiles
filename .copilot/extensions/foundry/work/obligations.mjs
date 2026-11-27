import { componentBatch } from "./inspections.mjs";
import { assign } from "./assignment.mjs";
import { verifyJoinedInputs } from "./assembly.mjs";
import { pendingSuccessor, rolloutSlots, rolloutPaths, stoppedBatch } from "./campaign.mjs";
import { currentChange } from "./eligibility.mjs";
import { journal } from "./dispatch.mjs";
import { changeOffer } from "./evidence.mjs";
import { admitted, expired, reserveCheck, reserveProduct } from "./native.mjs";
import { checked, producingGrant, submittedBy } from "./lineage.mjs";
import { commitAt, retain } from "./product.mjs";
import { publishedNodes } from "./publication.mjs";
import { replaceable, replacementChecks } from "./replacement.mjs";
import { grant, productOwnership } from "./transfer.mjs";
import { digest, fail, text } from "./values.mjs";
import { activeApproval, approvalId, declareApproved } from "./approved.mjs";
import { currentOrder, memberDeclaration, scheduleMembers } from "./series.mjs";
import { effectAt } from "./revision.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Adoption} Change */
/** @typedef {import("./model.js").NativeCall} Check */
/** A rollout names every output it may rebind; an owned patch names exactly one.
 * An inherited patch changes none. @param {Change} a */
const owners=a=>a.rollout?.owners??(a.patch?a.patch.owner?{[a.patch.grain]:a.patch.owner}:{}:fail("invalid_patch","Missing authorized change"));

/** The original answered approval owns its continuation, not the storage fence,
 * selector or executor. Verify the actual historical producer and original signed
 * rows before admitting a new component. This never creates a writer grant.
 * @param {string} cwd @param {Run} run @param {string} actor @param {string} tip
 * @param {{approval:Change,original:Check}} slot @param {(c:Check)=>void} verify */
export function reserveApprovedMember(cwd,run,actor,tip,{approval:a,original:old},verify){
	const id=old.grain,n=id && run.nodes[id],owner=id && a.rollout?.owners[id];
	if(!id || !n || !owner || !old.commit || !old.check || actor!==run.owner || old.issuer!==actor || !run.active || expired(run) ||
		!run.adoptions?.includes(a) || a.revision!==tip || commitAt(cwd,run.policy.target)!==tip || digest(n)!==owner.binding ||
		run.effects.some(c=>c.permissionHold) || run.inspections?.some(i=>i.permissionHold))return false;
	const original=effectAt(run,owner.component),launches=run.effects.slice(0,original?run.effects.indexOf(original):0)
		.filter(w=>w.kind==="writer" && w.nativeId===n.worker && w.grain===id && w.token===n.token);
	const origin=launches.length===1 && producingGrant(run,launches[0]);
	if(!origin || origin.review.id!==n.review || origin.generation!==n.generation || !submittedBy(original,origin))return false;
	const c=reserveCheck(run,actor,cwd,old.commit,old.check,{kind:"component",grain:id});
	const declaration=declareApproved(run,c,a,old.id);
	if(!declaration){run.effects.pop();return false;}
	for(const f of declaration.facts)if(f.kind==="signed"){
		const previous=effectAt(run,f.check);
		if(previous?.tool!=="bash")fail("missing_receipt","Missing signed input to the original approval");
		verify(previous);
	}
	c.attempt=declaration;
	if(!activeApproval(run,c,a)){run.effects.pop();return false;}
	return true;
}

/** Reserve fresh evidence, not a fresh writer. Existing attempt bindings stay
 * intact; a product amendment with no replaced output has no standalone component.
 * Called only after the proposal was freshly rederived and matched inside the committing transaction.
 * @param {string} cwd @param {Run} run @param {Change} a @param {string} answer */
export function reserveChange(cwd,run,a,answer){
	admitted(run);
	const assembly=text(a.assembly,"approved assembly");
	if(answer!==(a.rollout??a.patch)?.blob || commitAt(cwd,run.policy.target)!==a.revision)fail("stale_pin","The approved bytes or target changed");
	if(a.rollout && a.accepted)scheduleMembers(a);
	const ids=a.accepted?.order??Object.keys(owners(a));
	retain(cwd,assembly);
	if(a.rollout)retain(cwd,a.rollout.harness);
	const f=a.rollout?.followup;
	if(f){
		const parent=run.adoptions?.find(p=>p.id===f.proposal),batch=parent && stoppedBatch(run,parent,f.check,false,f.observation===0);
		if(!batch)fail("stale_pin","Cannot displace an unknown or issued serial suffix");
		for(const c of batch)if(c.state==="ready")journal(c,"withdraw");
	}
	if(!ids.length)joinChange(cwd,run,a);
	for(const id of ids){
		const c=reserveCheck(run,run.owner,cwd,assembly,run.nodes[id].grain.check,{kind:"component",grain:id});
		if(a.rollout)c.attempt=memberDeclaration(run,c,a,currentOrder(run,a,c))??fail("current_authority_required","Missing ordered, approved member declaration");
		else c.replacement=a.id;
	}
	return ()=>commitAt(cwd,run.policy.target)===a.revision;
}

/** @param {string} cwd @param {Run} run @param {Change} a */
function joinChange(cwd,run,a){
	const prior=run.join,p=run.productRepins?.at(-1),assembly=text(a.assembly,"approved assembly");
	if(!prior || !p?.targetFrom || p.revision!==prior.target || prior.check!==a.failed)fail("stale_pin","The original failed assembly changed");
	const outputs={...prior.outputs},harness=a.rollout?.harness;
	for(const [id,owner] of Object.entries(owners(a))){if(outputs[id]!==owner.output)fail("stale_pin",`Included output changed: ${id}`);outputs[id]=assembly;}
	if(digest(productOwnership(run.nodes,outputs)??null)!==digest(prior.ownership??null))fail("ownership_transition","The included grants changed");
	if(harness && harness!==a.revision)(run.repins??=[]).push({from:a.revision,revision:harness,files:rolloutPaths(run,a)});
	const {check:c}=reserveProduct(run,run.owner,cwd,prior.target,assembly,outputs);
	if(harness)c.evaluatorRevision=harness;
	(p.amendments??=[]).push({prior,proposal:a.id,recheck:c.id,...(harness && {harness})});
	if(a.rollout && run.effects.some(e=>e.kind==="component" && approvalId(e)===a.id)){
		c.attempt=declareApproved(run,c,a)??fail("current_authority_required","Missing signed and reviewed members for the approved join");
	}
}

/** @param {string} cwd @param {Run} run @param {string} failed @param {((c:Check)=>void)|undefined} verify */
export function settleChange(cwd,run,failed,verify){
	const j=run.join;
	if(!j || j.check!==failed || expired(run) || run.effects.some(c=>c.permissionHold))return;
	const rollout=run.adoptions?.findLast(a=>a.failed===failed && a.rollout && a.decision?.status==="answered");
	const single=!rollout && replacementChecks(run,failed).at(-1);
	const a=rollout || single && changeOffer(run,single);
	if(!a || !a.assembly || commitAt(cwd,run.policy.target)!==a.revision || a.rollout && pendingSuccessor(run,a))return;
	const checks=a.rollout?rolloutSlots(run,a).checks:single?[single]:[],required=owners(a);
	if(!checks.length || !checks.every(c=>c.attempt?.version===3?approvalId(c)===a.id && activeApproval(run,c,a):currentChange(run,c)?.id===a.id))return;
	const result=componentBatch(run,a.assembly,a.accepted?.order??Object.keys(required),checks,observed=>{
		if(!verify)fail("missing_receipt","This verification plan requires its original signed component observations");
		for(const [id,pin] of Object.entries(a.rollout?.included??{})){
			const n=run.nodes[id];
			if(!n || !checked(n) || n.candidate!==j.outputs[id] || pin.legacy && n.check!==pin.legacy ||
				digest([pin.scope,pin.inputs])!==digest([grant(n),n.inputs??{}]))fail("stale_assignment",`Included output or dependency changed: ${id}`);
		}
		for(const c of observed)verify(c);
	});
	if(result.state!=="ready")return;
	if(a.patch?.owner){
		replaceable(cwd,run,j,run.nodes[a.patch.grain],a.patch.files.map(f=>f.file));
		verifyJoinedInputs(cwd,run,j.outputs,null,a.assembly);
	}
	const nodes=publishedNodes(run,checks,old=>{
		const o=required[old.grain.id];
		const pins="inputs" in o?{inputs:o.inputs,retained:old.retained,successor:old.successor}:{inputs:old.inputs,supporting:old.supporting};
		/** @type {Node} */ const n={grain:old.grain,state:old.state,review:old.review,repairs:old.repairs,base:j.commit,generation:j.commit,
			replaces:o.output,...pins};
		assign(n,"amend");return n;
	});
	// A rejected join must not leak two newly published owners into the scheduler's conflict snapshot.
	const pins=[...run.productRepins??[]],last=pins.at(-1)??fail("stale_pin","No approved product pin");
	pins[pins.length-1]={...last,amendments:[...last.amendments??[]]};
	const next={...run,nodes,effects:[...run.effects],productRepins:pins,...(run.repins && {repins:[...run.repins]})};
	joinChange(cwd,next,a);
	run.nodes=nodes;run.effects=next.effects;run.productRepins=pins;run.join=next.join;
	if(next.repins)run.repins=next.repins;
}

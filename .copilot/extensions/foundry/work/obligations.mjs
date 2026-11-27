import { assign } from "./assignment.mjs";
import { verifyJoinedInputs } from "./assembly.mjs";
import { currentRollout, pendingSuccessor, rolloutChecks, rolloutPaths } from "./campaign.mjs";
import { journal } from "./dispatch.mjs";
import { componentBatch } from "./inspection.mjs";
import { admitted, expired, reserveCheck, reserveProduct } from "./native.mjs";
import { checked } from "./plan.mjs";
import { commitAt, retain } from "./product.mjs";
import { publishedNodes } from "./publication.mjs";
import { currentReplacement, replaceable, replacementChecks, replacementOffer } from "./replacement.mjs";
import { grant, productOwnership } from "./transfer.mjs";
import { digest, fail, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Adoption} Change */
/** @typedef {import("./model.js").NativeCall} Check */
/** A rollout names every output it may rebind; an owned patch names exactly one.
 * An inherited patch changes none. @param {Change} a */
const owners=a=>a.rollout?.owners??(a.patch?a.patch.owner?{[a.patch.grain]:a.patch.owner}:{}:fail("invalid_patch","Missing authorized change"));

/** Reserve fresh evidence, not a fresh writer. Existing attempt bindings stay
 * intact; a product amendment with no replaced output has no standalone component.
 * Called only after the proposal was freshly rederived and matched inside the committing transaction.
 * @param {string} cwd @param {Run} run @param {Change} a @param {string} answer */
export function reserveChange(cwd,run,a,answer){
	admitted(run);
	const assembly=text(a.assembly,"approved assembly"),ids=Object.keys(owners(a));
	if(answer!==(a.rollout??a.patch)?.blob || commitAt(cwd,run.policy.target)!==a.revision)fail("stale_pin","The approved bytes or target changed");
	retain(cwd,assembly);
	if(a.rollout)retain(cwd,a.rollout.harness);
	const parent=a.rollout?.followup?.proposal;
	if(parent)for(const c of run.effects)if(c.kind==="component" && c.rollout===parent && c.state==="ready")journal(c,"withdraw");
	if(!ids.length)joinChange(cwd,run,a);
	for(const id of ids){
		reserveCheck(run,run.owner,cwd,assembly,run.nodes[id].grain.check,id);
		const c=run.effects.at(-1);if(c?.kind!=="component")throw Error("Missing required component reservation");
		if(a.rollout)c.rollout=a.id;else c.replacement=a.id;
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
	reserveProduct(run,run.owner,cwd,prior.target,assembly,outputs);
	const c=run.effects.at(-1);if(c?.kind!=="product")throw Error("Missing required joined product reservation");
	if(harness)c.evaluatorRevision=harness;
	(p.amendments??=[]).push({prior,proposal:a.id,recheck:c.id,...(harness && {harness})});
}

/** @param {string} cwd @param {Run} run @param {string} failed @param {((c:Check)=>void)|undefined} verify */
export function settleChange(cwd,run,failed,verify){
	const j=run.join;
	if(!j || j.check!==failed || expired(run) || run.effects.some(c=>c.permissionHold))return;
	const rollout=run.adoptions?.findLast(a=>a.failed===failed && a.rollout && a.decision?.status==="answered");
	const single=!rollout && replacementChecks(run,failed).at(-1);
	const a=rollout || single && replacementOffer(run,single);
	if(!a || !a.assembly || commitAt(cwd,run.policy.target)!==a.revision || a.rollout && pendingSuccessor(run,a))return;
	const checks=a.rollout?rolloutChecks(run,a):single?[single]:[],required=owners(a);
	if(!checks.length || !checks.every(c=>a.rollout?currentRollout(run,c):currentReplacement(run,c)))return;
	const result=componentBatch(run,a.assembly,Object.keys(required),checks,()=>{
		if(!verify)fail("missing_receipt","This verification plan requires its original signed component observations");
		for(const [id,pin] of Object.entries(a.rollout?.included??{})){
			const n=run.nodes[id];
			if(!n || !checked(n) || n.candidate!==j.outputs[id] || pin.legacy && n.check!==pin.legacy ||
				digest([pin.scope,pin.inputs])!==digest([grant(n),n.inputs??{}]))fail("stale_assignment",`Included output or dependency changed: ${id}`);
		}
		for(const c of checks)verify(c);
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

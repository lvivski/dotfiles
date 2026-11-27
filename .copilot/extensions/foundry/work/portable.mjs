import { equivalentOverlay, overlaySeal } from "./attestation.mjs";
import { evaluatorOverlay, verifyFixedGrant } from "./contract.mjs";
import { priorGoal } from "./feedback.mjs";
import { checkedOverlay, entries } from "./product.mjs";
import { checkedOwnership, componentScope, productScope } from "./inputs.mjs";
import { describeDisclosure, hook, resolveInputs } from "../../../skills/foundry/scripts/materialize.mjs";
import { digest, fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").ComponentObservation} Observation */
/** @typedef {{cwd:string,verify:(e:Check)=>void}} Evidence */
/** @param {string} reason @returns {never} */
const unknown=reason=>fail("unproven_inputs",reason);

/** A signed file witness and a unique retained source can recover historical inputs, not
 * a signature over the reconstructed description. Do not run a hook or an evaluator here.
 * @param {string} cwd @param {Run} run @param {Check} e @param {Observation} observation
 * @param {import("./model.js").Product} product @param {string} [grain] */
function historical(cwd,run,e,observation,product,grain){
	const commit=e.commit??unknown("Missing checked commit"),check=observation.check;
	const joined=e.kind==="product" && grain!==undefined;
	// These activation contracts or signed observation fields postdate the legacy
	// single-directory wire. A present-day runner path or a later sibling check does not.
	if(!run.inspections && !run.policy.ownership && !observation.test && !e.receipt?.overlay && !e.receipt?.components &&
		!(e.kind==="goal" && e.receipt?.feedbackFile && !e.receipt.feedbackFile.legacy))
		unknown(`The original ${grain??e.kind} check (${check} at ${commit}) has no witness for its historical scope protocol`);
	if(grain){
		const n=run.nodes[grain],i=run.inspections?.find(i=>i.component===n?.check && i.candidate===product.outputs[grain] && i.grain===grain && i.state==="approved");
		if(!n)unknown("Missing historical component grant");
		if(i){
			if(digest(componentScope(grain,n.grain.directory))!==digest({kind:"component",grain,directories:i.scope.directories,files:i.scope.files}))
				unknown("Historical review and component scopes disagree");
		}else if(n.grain.task===undefined)verifyFixedGrant(cwd,run,n);
		else{
			const review=run.effects.find(c=>c.id===n.review),g=review?.kind==="scout" && review.observation?.grains.find(g=>typeof g==="object" && g.id===grain);
			if(!g || typeof g!=="object" || g.check!==check || digest(g.directory)!==digest(n.grain.directory))
				unknown("Cannot establish the grant used for the historical component scope");
		}
	}
	if((joined || e.rollout || e.replacement) && entries(cwd,commit,false,[hook]).length)
		unknown("The old observation did not identify the actual prepared bytes");
	if(e.kind==="goal" && priorGoal(run,e))
		unknown("The old goal did not identify whether its private scheduling input was supplied");
	const scope=grain?componentScope(grain,run.nodes[grain].grain.directory):e.kind==="product"?productScope(run,product):/** @type {const} */ ({kind:"goal"});
	if(scope.kind==="product" && product.ownership && JSON.stringify(checkedOwnership(scope))!==JSON.stringify(product.ownership))
		unknown("The recorded ownership map has a different historical environment spelling");
	const overlay=!joined && e.evaluatorRevision && (e.kind==="product" || e.kind==="goal")?checkedOverlay(evaluatorOverlay(run,e.kind,e.evaluatorRevision)):undefined;
	if(overlay && (e.receipt?.overlay!==undefined?e.receipt.overlay!==overlaySeal(overlay):
		!equivalentOverlay(cwd,run.policy.contractTarget??run.policy.base,commit,overlay)))
		unknown("Historical selection and the authorized overlay cannot be shown to be identical");
	let test;
	if(observation.test){
		const sources=new Map(run.testRepairs?.filter(j=>j.state==="applied" && j.rule.check===check && j.grain===grain &&
			j.blob===observation.test && j.revision && (!e.testPin || joined && run.testRepairs?.find(j=>j.recheck===e.id)?.grain!==grain || j.stop===e.testPin))
			.map(j=>[digest([j.revision,j.before]),j]));
		const [j]=sources.values();
		if(sources.size!==1 || !j.revision)unknown("No unique retained source for the signed replacement checker");
		test={file:check,revision:/** @type {string} */ (j.revision),blob:observation.test,before:j.before};
	}
	return resolveInputs(cwd,{commit,check,scope,overlay,test});
}

/** @param {Evidence} evidence @param {Run} run @param {Check} e @param {import("./model.js").Product} product */
export function portableReceipt(evidence,run,e,product){
	const r=e.receipt;
	if(!e.runnerClaim || !r || r.exit!==0 || !e.check || !e.commit)unknown("Missing original exclusive passing observation");
	evidence.verify(e);
	// A product lane affected its joined components even when the aggregate received no switch.
	if(e.lane)unknown(`${e.kind==="product"?"Joined components":`Component ${e.grain}`} at ${r.commit} used a historical foreground environment that v5 cannot represent`);
	/** @param {Observation} observation @param {string} [grain] */
	const verified=(observation,grain)=>{
		const inputs=observation.inputs??historical(evidence.cwd,run,e,observation,product,grain);
		const disclosure=describeDisclosure(evidence.cwd,inputs);
		if(inputs.scope.kind==="product"){
			const owned=checkedOwnership(inputs.scope);
			if(digest(Object.keys(owned).sort())!==digest(Object.keys(product.outputs).sort()) || product.ownership && digest(owned)!==digest(product.ownership))
				unknown("The verified ownership does not describe the accepted checkpoint");
		}
		return {inputs,disclosure,inputEvidence:observation.inputs?"signed":"reconstructed"};
	};
	return {commit:r.commit,check:r.check,exit:0,...(r.evaluatorRevision && {evaluatorRevision:r.evaluatorRevision}),
		...(r.productEvaluatorRevision && {productEvaluatorRevision:r.productEvaluatorRevision}),...verified(r,e.grain),
		...(r.components && {components:Object.fromEntries(Object.entries(r.components).map(([id,c])=>[id,{check:c.check,exit:c.exit,...verified(c,id)}]))})};
}

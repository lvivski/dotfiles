import {digest,fail,ownership} from "./values.mjs";
import {validInputs} from "../../../skills/foundry/scripts/recipe.mjs";
export {validInputs,checkedOwnership,verificationEnvironment} from "../../../skills/foundry/scripts/recipe.mjs";
/** @typedef {import("./model.js").VerificationInputs} Inputs */
/** @typedef {import("./model.js").VerificationScope} Scope */
/** @param {string} grain @param {import("./model.js").Scope} original @returns {Scope} */
export const componentScope=(grain,original)=>({kind:"component",grain,...ownership(original)});
/** @param {import("./model.js").Run} run @param {Pick<import("./model.js").Product,"outputs"|"ownership">} [join] @returns {Scope} */
export function productScope(run,join){
	const ids=Object.keys(join?.outputs??{}),frozen=join?.ownership;
	if(frozen && (ids.length!==Object.keys(frozen).length || !ids.every(id=>Object.hasOwn(frozen,id))))
		fail("unproven_inputs","The frozen product scope and included outputs do not agree");
	return {kind:"product",outputs:ids.map(id=>({id,...(frozen?frozen[id]:ownership(run.nodes[id].grain.directory))}))};
}
/** Read old evidence in place. Never backfill an earlier signed document.
 * @param {{inputs?:Inputs,test?:string}|undefined} receipt */
export const replacementBlob=receipt=>receipt?.inputs?(receipt.inputs.checker.replacement?receipt.inputs.checker.blob:undefined):receipt?.test;

/** @param {import("./model.js").NativeCall} e @returns {import("./model.js").CheckDescription["use"]|undefined} */
export const checkUse=e=>e.kind==="control"?"calibration":e.isolation?"subset":e.kind==="rerun"?"historical-observation":
	e.kind==="component"?e.pair || e.observer?"attestation":"component":e.kind==="goal" || e.kind==="product"?e.kind:undefined;

/** Validate a reserved recipe before it reaches a claimant, not only after it signs something.
 * @param {import("./model.js").NativeCall} e */
export function described(e){
	const d=e.verification,main=d?.steps.at(-1);
	if(!d || !main || main.member!==null || d.use!==checkUse(e))return false;
	const {inputs:v}=main,scope=v.scope,control=v.control,members=d.steps.slice(0,-1);
	if(!!v.delta!==!!d.privateInput || !!control!==(e.kind==="control") || (control?control.checker.path:v.checker.path)!==e.check ||
		(!control && (v.commit!==e.commit || scope.kind!==(e.kind==="rerun"?"component":e.kind) ||
			scope.kind==="component" && scope.grain!==e.grain)) || d.evaluation.kind!==(control?"component":scope.kind) ||
		(d.evaluation.kind==="product" && !(scope.kind==="product" && digest(d.evaluation.outputs)===digest(scope.outputs.map(o=>o.id)))) ||
		(main.build && (scope.kind!=="component" || main.build.commit!==v.commit)))return false;
	return d.joined ? e.kind==="product" && scope.kind==="product" && members.length===scope.outputs.length &&
		members.every((s,i)=>s.member===scope.outputs[i].id && s.inputs.scope.kind==="component" && s.inputs.scope.grain===s.member &&
			s.inputs.commit===e.commit && s.build?.commit===e.commit && !s.inputs.control && !s.inputs.delta && !s.inputs.overlay &&
			digest(s.build)===digest(members[0].build)) : !members.length && !d.resolutions;
}

/** The reservation still identifies the obligation; only the signed document identifies
 * the observed inputs. Missing recipes on earlier documents are never filled in here.
 * @param {import("./model.js").Effect} e @param {import("./model.js").Receipt} r */
export function boundInputs(e,r){
	const v=r.inputs;
	if(e.tool==="bash" && e.verification && !observedSteps(e.verification,r))return false;
	if(v && (!validInputs(v) || !e.runnerClaim || r.test!==undefined || r.overlay!==undefined ||
		(e.kind==="control"?!v.control || v.control.checker.path!==e.check || v.control.example!==(e.calibration?.role==="newBad"?"bad":"good"):
			v.control || v.commit!==e.commit || v.checker.path!==e.check || v.scope.kind!==(e.kind==="rerun"?"component":e.kind) ||
			v.scope.kind==="component" && v.scope.grain!==e.grain || e.kind!=="rerun" && v.overlay?.revision!==e.evaluatorRevision)))return false;
	return Object.entries(r.components??{}).every(([grain,c])=>!c.inputs || validInputs(c.inputs) && e.kind==="product" && e.runnerClaim &&
		c.test===undefined && !c.inputs.control && c.inputs.commit===e.commit && c.inputs.checker.path===c.check && !c.inputs.overlay &&
		c.inputs.scope.kind==="component" && c.inputs.scope.grain===grain);
}

/** A prepared tree is learned only by executing its pinned build. Everything else is already fixed.
 * @param {import("./model.js").CheckDescription["steps"][number]} step @param {Inputs|undefined} observed */
function observedStep(step,observed){
	if(!observed || !validInputs(observed))return false;
	const {prepared,...fixed}=observed;
	return !!step.build?.hook===!!prepared && digest(fixed)===digest(step.inputs);
}

/** Missing joined work is not a passing phase. The actual ordered prefix may stop, but cannot skip,
 * fabricate or exchange a step. A later result never changes the reserved evaluation role.
 * @param {import("./model.js").CheckDescription} description @param {import("./model.js").Receipt} r */
function observedSteps(description,r){
	const {steps,resolutions}=description,main=steps.at(-1);
	if(!main || main.member!==null || r.resolutionDigest!==resolutions || !!description.joined!==(r.components!==undefined))return false;
	const observed=r.components??{},members=steps.slice(0,-1),names=new Set(members.map(s=>s.member));
	if(Object.keys(observed).some(id=>!names.has(id)))return false;
	let stopped=false;
	for(const step of members){
		const c=step.member && observed[step.member];
		if(!c){stopped=true;continue;}
		if(stopped || c.check!==step.inputs.checker.path || (c.inputs || c.exit!==null) && !observedStep(step,c.inputs))return false;
		if(c.exit!==0)stopped=true;
	}
	return (r.inputs || r.exit!==null)?!stopped && observedStep(main,r.inputs):true;
}

import {digest} from "./values.mjs";
import {validInputs} from "../../../skills/foundry/scripts/recipe.mjs";
/** @typedef {import("./model.js").VerificationInputs} Inputs */

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
export function observedSteps(description,r){
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

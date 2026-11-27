import { outside } from "./product.mjs";
import { fail } from "./values.mjs";

/** @param {unknown} outcome @param {number} grains @returns {outcome is import("./model.js").Observation["outcome"]} */
export const validOutcome = (outcome, grains) => grains > 0 ? outcome === "regenerate" :
	outcome === "no-gap" || outcome === "needs-decision" || outcome === "waiting" || outcome === "needs-evidence" ||
	outcome === "needs-research" || outcome === "researched" || outcome === "unresolved";

/** @param {string} filename */
export const planDirectory = filename => filename.replace(/\.json$/, "");

/** @param {import("./model.js").Run} run @param {{file:string}[]} files */
export function changesFixedContract(run,files){
	const paths=Object.values(run.nodes).flatMap(({grain:g})=>g.task===undefined?[g.specification,...g.boundary]:[]);
	return paths.length>0 && files.some(f=>!outside(f.file,paths));
}
/** An old approval is still inspectable evidence, not authority to change this contract.
 * @param {import("./model.js").Run} run */
export function contractHold(run){
	const unsafe=run.adoptions?.find(a=>a.rollout && a.decision?.status==="answered" &&
		(changesFixedContract(run,a.rollout.files) || a.rollout.followup && changesFixedContract(run,a.rollout.followup.files)));
	if(unsafe)return `Approved rollout ${unsafe.id} changes a conserved fixed specification or boundary. This run is read-only; its historical receipts are not a handoff.`;
}

export { evaluatorOverlay, productOverlayPaths } from "./overlay.mjs";

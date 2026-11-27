import { candidateHandoff } from "./lineage.mjs";
import { comparison, taskBasis } from "./origin.mjs";
import { covers, sameScope } from "./values.mjs";

export { revisedTask } from "./origin.mjs";

/** @param {import("./model.js").Run} run @param {import("./model.js").Review} review @param {string} file
 * @returns {import("./model.js").CorrectionBasis|undefined} */
export function correctionBasis(run,review,file) {
	const g=review.observation?.grains[0];
	if (typeof g!=="object") return;
	const basis=taskBasis(run,review);
	if(basis)return basis;
	const n=review.predecessor;
	if (n?.stop?.kind==="writer-cannot-repair" && !comparison(run,review) && n.check && sameScope(n.grain.directory,g.directory) &&
		g.check===n.grain.check && covers(g.directory,file) && candidateHandoff(run,n,g,review)) return {predecessorCheck:n.check};
}

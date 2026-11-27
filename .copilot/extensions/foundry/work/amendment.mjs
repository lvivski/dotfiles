import { candidateHandoff } from "./lineage.mjs";
import { comparison } from "./charter.mjs";
import { comparisonScope, covers, sameScope } from "./values.mjs";

/** Remove exactly one literal occurrence from the original scoped proposal; never accept replacement instructions.
 * @param {import("./model.js").Review} review @param {string} grain @param {string} clause */
export function revisedTask(review, grain, clause) {
	const report = review.observation, g = report?.grains[0];
	if (review.state !== "observed" || report?.outcome !== "regenerate" || report.grains.length !== 1 ||
		typeof g !== "object" || g.id !== grain) return;
	const at = g.task.indexOf(clause);
	if (at < 0 || g.task.indexOf(clause, at + 1) >= 0) return;
	const task = g.task.slice(0, at) + g.task.slice(at + clause.length);
	if (task.trim()) return task;
}

/** @param {import("./model.js").Run} run @param {import("./model.js").Review} review @param {string} file */
export function correctionBasis(run,review,file) {
	const g=review.observation?.grains[0];
	if (typeof g!=="object") return;
	const i=comparison(run,review);
	if (i && sameScope(comparisonScope(i),g.directory)) return {blob:i.blob};
	const n=review.predecessor;
	if (!i && n?.stop?.kind==="writer-cannot-repair" && n.check && sameScope(n.grain.directory,g.directory) &&
		g.check===n.grain.check && covers(g.directory,file) && candidateHandoff(run,n,g,review)) return {predecessorCheck:n.check};
	if (!i && !n && typeof g.directory==="string" && !review.observation?.replace?.length)
		return {ordinary:/** @type {const} */ (true)};
}

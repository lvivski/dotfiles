import { isUtf8 } from "node:buffer";
import { generationOf } from "./evidence.mjs";
import { admitted } from "./native.mjs";
import { candidateHandoff, originalAttempt, stalePins } from "./plan.mjs";
import { changedFiles, commitAt, committedFile, verifyContracts } from "./product.mjs";
import { comparison } from "./reviews.mjs";
import { comparisonScope, covers, digest, fail, fields, name, relative, roots, sameScope, scopeLabel, text } from "./values.mjs";

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

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {import("./model.js").Review} review @param {string} file */
export function correctionBasis(run,review,file) {
	const g=review.observation?.grains[0];
	if (typeof g!=="object") return;
	const i=comparison(run,review);
	if (i && sameScope(comparisonScope(i),g.directory)) return {blob:i.blob};
	const n=review.predecessor;
	if (!i && n?.stop?.kind==="writer-cannot-repair" && n.check && sameScope(n.grain.directory,g.directory) &&
		g.check===n.grain.check && covers(g.directory,file) && candidateHandoff(run,n,g,review)) return {predecessorCheck:n.check};
}
/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a */
export function prepareCorrection(cwd, run, actor, a) {
	fields(a, ["run","grain","review","worker","clause","file","excerpt"]);
	const grain = name(a.grain,"assignment"), review = name(a.review,"assigning review"), worker = text(a.worker,"bound worker");
	const clause = text(a.clause,"verbatim clause to remove"), file = relative(a.file), excerpt = text(a.excerpt,"verbatim product excerpt");
	/** @param {Run} current */
	function select(current) {
		if (current.owner !== actor) fail("foreign_run","Only the run owner can correct an assignment");
		admitted(current);
		const n = current.nodes[grain], r = current.effects.find(e => e.id === review);
		if (!n || n.state !== "writing" || n.worker !== worker || !n.token || !n.generation || n.candidate || n.check ||
			n.review !== review || r?.kind !== "scout" || r.correction || n.base !== r.base ||
			generationOf(originalAttempt(current,n)) !== n.generation || stalePins(current,n).length)
			fail("stale_assignment","Need the original writable, bound assignment and its exact assigning review, before submission");
		const basis=correctionBasis(current,r,file), task = revisedTask(r,grain,clause), original = r.observation?.grains[0];
		if (!basis) fail("invalid_correction","Need the assigning scoped comparison or a checked stopped-predecessor handoff with evidence inside its grant");
		if (!task || typeof original !== "object" || original.task !== n.grain.task || !sameScope(original.directory,n.grain.directory) ||
			r.predecessor && task.trim()===r.predecessor.grain.task?.trim())
			fail("invalid_correction","Need a unique clause from the unaltered scoped comparison task; cannot remove the entire task");
		const target = commitAt(cwd,current.policy.target);
		if (target !== current.goal?.target || current.blocker || current.conflict ||
			current.effects.some(e => (e.issuer === actor || e.issuer === worker) && e.permissionHold))
			fail("dispatch_held","Resolve the target change, conflict or permission hold before correcting this assignment");
		verifyContracts(cwd,current.policy,target);
		for (const product of [current.products.at(-1),current.join])
			if (product && product.commit !== r.base && changedFiles(cwd,r.base,product.commit,[file,...roots(n.grain.directory)]).length)
				fail("stale_assignment","The cited evidence or assigned directory changed since the review");
		const bytes = committedFile(cwd,r.base,file);
		if (bytes.includes(0) || !isUtf8(bytes) || !bytes.toString("utf8").includes(excerpt))
			fail("invalid_correction","The excerpt must appear verbatim in the selected UTF-8 file at the reviewed product");
		return { n, r, target, task, correction:{ worker, clause, file, excerpt, ...basis } };
	}
	const before = select(run), identity = digest(before);
	return {
		prompt: `Correct ${grain} for its existing writer ${worker} in ${scopeLabel(before.n.grain.directory)}?\nBefore: ${before.n.grain.task}\nAfter: ${before.task}\n` +
			`Evidence at ${before.r.base}:${file}:\n${excerpt}\n${before.correction.blob ? `Offered comparison: ${before.correction.blob}` : `Stopped predecessor component: ${before.correction.predecessorCheck}`}\n` +
			"Approve only if the removed clause contradicts the existing contract. No new behavior, reads, checks, ownership or permissions are authorized.",
		/** @param {Run} live */
		apply(live) {
			const fresh = select(live);
			if (digest(fresh) !== identity) fail("stale_assignment","The assignment or its evidence changed during approval");
			fresh.r.correction = fresh.correction;
			fresh.n.grain.task = fresh.task;
			return () => commitAt(cwd,live.policy.target) === fresh.target;
		}
	};
}

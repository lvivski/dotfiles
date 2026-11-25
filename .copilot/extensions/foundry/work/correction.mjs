import { isUtf8 } from "node:buffer";
import { correctionBasis, revisedTask } from "./amendment.mjs";
import { generationOf } from "./evidence.mjs";
import { admitted } from "./native.mjs";
import { originalAttempt, stalePins } from "./plan.mjs";
import { changedFiles, commitAt, committedFile, verifyContracts } from "./product.mjs";
import { digest, fail, fields, name, relative, roots, sameScope, scopeLabel, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
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

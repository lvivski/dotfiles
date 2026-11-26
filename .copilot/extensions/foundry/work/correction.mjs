import { isUtf8 } from "node:buffer";
import { randomUUID } from "node:crypto";
import { assign } from "./assignment.mjs";
import { correctionBasis, revisedTask } from "./amendment.mjs";
import { availableReservations } from "./capacity.mjs";
import { generationOf, goalReceipt, missingInput } from "./evidence.mjs";
import { frozenCheckpoint } from "./goal.mjs";
import { verifyRepairInputs } from "./graph.mjs";
import { admitted, reserveNotice } from "./native.mjs";
import { originalAttempt, stalePins, writerInputs } from "./plan.mjs";
import { changedFiles, commitAt, committedFile, verifyContracts } from "./product.mjs";
import { digest, fail, fields, name, relative, roots, sameScope, scopeLabel, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} a */
export function prepareCorrection(cwd, run, actor, a) {
	fields(a, ["run","grain","review","worker","clause","file","excerpt","preview"]);
	const grain = name(a.grain,"assignment"), review = name(a.review,"assigning review"), worker = text(a.worker,"bound worker");
	const clause = text(a.clause,"verbatim clause to remove"), file = relative(a.file), excerpt = text(a.excerpt,"verbatim product excerpt");
	/** @param {Run} current */
	function select(current) {
		if (current.owner !== actor) fail("foreign_run","Only the run owner can correct an assignment");
		admitted(current);
		const n = current.nodes[grain], r = current.effects.find(e => e.id === review);
		const stopped=a.preview!==undefined;
		if (!n || (stopped ? !n.preview || n.preview!==a.preview || missingInput(n)===undefined : n.state!=="writing") ||
			n.worker !== worker || !n.token || !n.generation || n.candidate || n.check ||
			n.review !== review || r?.kind !== "scout" || r.correction || n.base !== r.base ||
			generationOf(originalAttempt(current,n)) !== n.generation || stalePins(current,n).length)
			fail("stale_assignment","Need the original writable, bound assignment and its exact assigning review, before submission");
		const basis=correctionBasis(current,r,file), task = revisedTask(r,grain,clause), original = r.observation?.grains[0];
		if (!basis || stopped && !basis.ordinary) fail("invalid_correction","Need the original ordinary assignment, scoped comparison, or checked predecessor handoff with in-grant evidence");
		if (!task || typeof original !== "object" || original.task !== n.grain.task || !sameScope(original.directory,n.grain.directory) ||
			r.predecessor && task.trim()===r.predecessor.grain.task?.trim())
			fail("invalid_correction","Need a unique clause from the unaltered scoped comparison task; cannot remove the entire task");
		const target = commitAt(cwd,current.policy.target);
		const frozen=target!==current.goal?.target && frozenCheckpoint(cwd,current,target);
		if (!frozen && (target !== current.goal?.target || current.blocker || current.conflict) ||
			current.effects.some(e => (e.issuer === actor || e.issuer === worker) && e.permissionHold))
			fail("dispatch_held","Resolve the target change, conflict or permission hold before correcting this assignment");
		verifyContracts(cwd,current.policy,frozen ? frozen.target : target);
		if (basis.ordinary) {
			const launch=originalAttempt(current,n);
			if (!launch || launch.production || launch.observer || launch.restoration || launch.reuse || launch.finished ||
				n.reuse || n.retained || n.restoration || n.successor || n.excluded)
				fail("invalid_correction","Not an ordinary production writer with its original grant");
		}
		if (stopped) {
			const goal=current.goal, base=current.products.at(-1)?.commit ?? target;
			if (!goal || goal.commit!==base || ![1,2].includes(goalReceipt(current)?.exit ?? -1) || current.join || current.independent)
				fail("stale_assignment","Wait for a settled unmet or unavailable goal on the current product");
			if (n.repairs>=current.policy.repairs || !availableReservations(current))
				fail("limit","No authorized repair, assignment or worker slot remains");
		}
		if (stopped || frozen) {
			const base=current.products.at(-1)?.commit ?? target, required=writerInputs(current.nodes,{...n,state:"waiting"});
			if (!required) fail("stale_assignment","The original prerequisites are no longer available");
			verifyRepairInputs(cwd,current,n,required,base);
		}
		for (const product of [current.products.at(-1),current.join])
			if (product && product.commit !== r.base && changedFiles(cwd,r.base,product.commit,[file,...roots(n.grain.directory)]).length)
				fail("stale_assignment","The cited evidence or assigned directory changed since the review");
		const bytes = committedFile(cwd,r.base,file);
		if (bytes.includes(0) || !isUtf8(bytes) || !bytes.toString("utf8").includes(excerpt))
			fail("invalid_correction","The excerpt must appear verbatim in the selected UTF-8 file at the reviewed product");
		return { n, r, target, task, ...(frozen && {frozen:[frozen.check,current.goal?.check]}), correction:{ worker, clause, file, excerpt, ...basis },
			...(stopped && {goal:current.goal?.check,checkpoint:current.products.at(-1)?.check}) };
	}
	const before = select(run), identity = digest(before);
	return {
		prompt: `Correct ${grain} for its existing writer ${worker} in ${scopeLabel(before.n.grain.directory)}?\nBefore: ${before.n.grain.task}\nAfter: ${before.task}\n` +
			`Evidence at ${before.r.base}:${file}:\n${excerpt}\n${before.correction.ordinary ? "Owner-only verification; this citation grants no writer read." :
				before.correction.blob ? `Offered comparison: ${before.correction.blob}` : `Stopped predecessor component: ${before.correction.predecessorCheck}`}\n` +
			(before.goal ? `Reopen preview ${before.n.preview} for the same writer using one bounded repair; deliver the corrected task without running any check.\n` : "") +
			"Approve only if the removed clause contradicts the existing contract. No new behavior, reads, ownership or permissions are authorized.",
		/** @param {Run} live */
		apply(live) {
			const fresh = select(live);
			if (digest(fresh) !== identity) fail("stale_assignment","The assignment or its evidence changed during approval");
			if (fresh.correction.ordinary && fresh.goal) {
				const n=fresh.n, token=randomUUID();
				fresh.r.correction={...fresh.correction,resumed:{prior:structuredClone(n),token}};
				assign(n,"staff"); n.repairs++; n.token=token;
				delete n.reason; delete n.stop;
				reserveNotice(live,actor,token,"repair",`One clause was removed. Read your Foundry status, continue your existing work in ${scopeLabel(n.grain.directory)} and submit normally. Your scope, inputs and evaluator are unchanged. Corrected task: ${fresh.task}`,n);
				if (live.goal) delete live.goal.stall;
			} else fresh.r.correction = fresh.correction;
			fresh.n.grain.task = fresh.task;
			return () => commitAt(cwd,live.policy.target) === fresh.target;
		}
	};
}

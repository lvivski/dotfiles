import { offered } from "./artifacts.mjs";
import { availableReservations } from "./capacity.mjs";
import { currentEvaluation, exhaustedCandidate, goalReceipt } from "./evidence.mjs";
import { checkpointCurrent, pendingGoal } from "./facts.mjs";
import { reserveWriter, verifyRepairInputs } from "./graph.mjs";
import { admitted } from "./native.mjs";
import { assignmentCalls, waiting, writerInputs } from "./plan.mjs";
import { changedFiles, commitAt, inventory, verifyContracts } from "./product.mjs";
import { digest, fail, fields, name } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args */
export function prepareReuse(cwd, run, actor, args) {
	fields(args, ["run","grain","candidate","check","blob"]);
	const id = name(args.grain,"assignment"), candidate = name(args.candidate,"retained candidate");
	const check = name(args.check,"failed component reservation"), blob = name(args.blob,"offered correction");
	/** @param {Run} current */
	function select(current) {
		if (actor !== current.owner) fail("foreign_run","Only the run owner can request candidate reuse");
		admitted(current);
		const n = current.nodes[id], last = current.products.at(-1), goal = current.goal, target = commitAt(cwd,current.policy.target);
		if (n?.retained) fail("ownership_transition","Cannot seed a successor from the former whole-package grant");
		if (Object.values(current.nodes).some(parent=>parent.successor?.to===id))
			fail("invalid_successor","A stopped assignment authorizes one fresh successor, not candidate reuse");
		if (!n || n.candidate !== candidate || n.check !== check || !exhaustedCandidate(current,n) ||
			current.effects.some(e => e.kind === "writer" && e.reuse?.predecessor.check === check))
			fail("stale_assignment","Need the exact exhausted assignment, retained candidate and conclusive component failure, without a prior successor");
		if (!last || !goal || !checkpointCurrent(current,last.check,target) || !(pendingGoal(current) || [1,2].includes(goalReceipt(current)?.exit ?? -1)))
			fail("stale_assignment","Need the current checked checkpoint with its goal pending, unmet or missing evidence, and no outstanding join or conflict");
		const review = current.effects.find(e => e.id === n.review);
		if (review?.kind !== "scout" || review.state !== "observed" || !currentEvaluation(current,review) ||
			!current.artifacts?.some(a => a.blob === blob && offered(a,n))) fail("invalid_reuse","Missing current review or correction not offered to this assignment");
		if (assignmentCalls(current,n).some(e => e.state !== "done" && e.state !== "refused" || e.permissionHold) ||
			current.effects.some(e => e.issuer === actor && e.permissionHold))
			fail("dispatch_held","Resolve outstanding assignment calls and permission holds before reuse");
		if (!availableReservations(current)) fail("limit","No authorized assignment or worker slot remains");
		const inputs = writerInputs(current.nodes,waiting(n.grain));
		if (!inputs || Object.entries(inputs).some(([dep,pin]) => current.nodes[dep].state !== "qualified" || last.outputs[dep] !== pin))
			fail("stale_assignment","Need the original prerequisites in the checked product");
		verifyContracts(cwd,current.policy,target);
		verifyRepairInputs(cwd,current,n,inputs,last.commit);
		if (review.correction && changedFiles(cwd,review.base,last.commit,[review.correction.file]).length)
			fail("stale_assignment","The frozen evidence for the original task correction changed");
		if (!inventory(cwd,candidate,n.grain.directory)) fail("invalid_reuse","No retained directory to seed the successor");
		return {n,inputs,base:last.commit,target,checkpoint:last.check,goal:goal.check};
	}
	const before = select(run);
	return {
		prompt:`Run ${run.id}: authorize one successor to ${id} on checked product ${before.base}?\n` +
			`Seed only ${candidate}:${before.n.grain.directory}/; correct failed component ${check} using offered blob ${blob}.\n` +
			`Keep the same task and evaluator ${before.n.grain.check}. Approve only if reusing this assignment's own work is consistent with its charter. The previous receipt and spent repairs stand. Only changed bytes may enter a new check.`,
		/** @param {Run} live */
		apply(live) {
			const fresh = select(live);
			if (digest(fresh) !== digest(before)) fail("stale_assignment","The candidate, goal or approved inputs changed during approval");
			const {n,base,inputs,checkpoint,goal,target} = fresh;
			const successor = waiting(n.grain,n.review,n.repairs);
			live.nodes[id] = successor;
			reserveWriter(cwd,live,successor,inputs,base,actor,undefined,undefined,{predecessor:n,blob,checkpoint,goal});
			if (live.goal) delete live.goal.stall;
			return () => commitAt(cwd,live.policy.target) === target;
		}
	};
}

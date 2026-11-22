import { goalReceipt } from "./evidence.mjs";
import { reserveWriter, verifyRepairInputs } from "./graph.mjs";
import { admitted, assignmentCount } from "./native.mjs";
import { assignmentCalls, stalePins, validateNodes, waiting, working, writerInputs } from "./plan.mjs";
import { commitAt, directoryBaseline, entries, verifyContracts } from "./product.mjs";
import { reading, reviews } from "./reviews.mjs";
import { digest, fail, names } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {import("./model.js").Node} n */
function originalAttempt(run, n) {
	const calls = assignmentCalls(run, n), launch = calls.find(e => e.kind === "writer" && e.token === n.token);
	if (!launch?.callId || launch.state !== "done" || launch.nativeId !== n.worker) return false;
	return calls.every(e => e === launch || e.kind === "artifact" && e.state === "done");
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string[]} ids */
function manifest(cwd, run, actor, ids) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner may request a baseline grant");
	admitted(run);
	const goal = run.goal, target = commitAt(cwd, run.policy.target);
	if (!goal || goal.target !== target || goalReceipt(run)?.exit !== 1 || (run.products.at(-1)?.commit ?? target) !== goal.commit ||
		run.join || run.blocker || run.conflict) fail("stale_assignment", "Need a settled, current unmet goal");
	verifyContracts(cwd, run.policy, target);
	if (!ids.length || run.policy.assignments !== undefined && assignmentCount(run) + ids.length > run.policy.assignments ||
		run.policy.workers !== undefined && Object.values(run.nodes).filter(working).length + reviews(run).filter(reading).length + ids.length > run.policy.workers)
		fail("limit", "Select assignments within the remaining worker and assignment limits");
	return ids.map(id => {
		const n = run.nodes[id];
		if (!n?.worker || n.state !== "blocked" || !n.generation || !n.token || !n.base || n.check || n.candidate ||
			!n.reason?.startsWith("Writer reports missing input: ") || !originalAttempt(run, n) ||
			run.effects.some(e => (e.issuer === actor || e.issuer === n.worker) && e.permissionHold))
			fail("stale_assignment", `${id}: not an original bound missing-input attempt`);
		if (n.repairs >= run.policy.repairs) fail("limit", `${id}: repair limit exhausted`);
		if (n.grain.revision && n.grain.revision !== n.base) fail("stale_assignment", `${id}: a grant cannot replace the assignment's explicit revision`);
		const inputs = !stalePins(run, n).length && writerInputs(run.nodes, waiting(n.grain));
		if (!inputs) fail("stale_assignment", `${id}: a pinned prerequisite changed`);
		verifyRepairInputs(cwd, run, n, inputs, goal.commit);
		const directory = n.grain.directory, baseline = directoryBaseline(cwd, n.base, directory);
		if (!baseline || entries(cwd, goal.commit, false, [directory])[0]?.oid !== baseline.tree ||
			entries(cwd, n.base, true, [directory]).some(e => !["100644", "100755"].includes(e.mode)))
			fail("stale_assignment", `${id}: need the original unchanged regular-file inventory`);
		return { id, token: n.token, worker: n.worker, generation: n.generation, inputs, specification: n.grain.specification, baseline };
	});
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {unknown} selections */
export function prepareBaselines(cwd, run, actor, selections) {
	const ids = names(selections, "blocked assignment"), before = manifest(cwd, run, actor, ids);
	return {
		prompt: `Run ${run.id}: allow these original writers to consult only their own prior directories, read-only?\n` +
			before.map(({ id, worker, baseline: b, specification }) => `${id} (${worker}): ${b.revision}:${b.directory}/\nTree: ${b.tree}; charter: ${specification}`).join("\n") +
			"\nApprove only if the charter omitted this permission, not if it forbids the read. Each writer receives one bounded repair. No checkout, other revisions, host permissions, evaluators or goals change.",
		/** @param {Run} live */
		apply(live) {
			const fresh = manifest(cwd, live, actor, ids);
			if (digest(fresh) !== digest(before)) fail("stale_assignment", "The approved assignments or baseline pins changed");
			for (const row of fresh)
				reserveWriter(cwd, live, live.nodes[row.id], row.inputs, row.baseline.revision, actor, undefined, row.baseline);
			validateNodes(live.nodes);
			if (live.goal) delete live.goal.stall;
			return () => commitAt(cwd, live.policy.target) === live.goal?.target;
		}
	};
}

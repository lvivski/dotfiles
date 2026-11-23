import { goalReceipt, missingInput } from "./evidence.mjs";
import { availableReservations } from "./capacity.mjs";
import { reserveWriter, verifyRepairInputs } from "./graph.mjs";
import { admitted } from "./native.mjs";
import { assignmentCalls, stalePins, validateNodes, waiting, writerInputs } from "./plan.mjs";
import { commitAt, directoryBaseline, entries, verifyContracts } from "./product.mjs";
import { digest, fail, names } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {import("./model.js").Node} n */
function originalAttempt(run, n) {
	const calls = assignmentCalls(run, n), launch = calls.find(e => e.kind === "writer" && e.token === n.token);
	if (launch?.kind === "writer" && launch.callId && launch.state === "done" && launch.nativeId === n.worker &&
		calls.every(e => e === launch || e.kind === "artifact" && e.state === "done")) return launch;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string[]} ids @param {boolean} inspect */
function manifest(cwd, run, actor, ids, inspect) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner may request a baseline grant");
	admitted(run);
	const goal = run.goal, target = commitAt(cwd, run.policy.target);
	if (!goal || goal.target !== target || run.blocker || run.conflict ||
		(!inspect && (goalReceipt(run)?.exit !== 1 || (run.products.at(-1)?.commit ?? target) !== goal.commit || run.join)))
		fail("stale_assignment", inspect ? "Need the current goal target without a conflict" : "Need a settled, current unmet goal");
	verifyContracts(cwd, run.policy, target);
	if (!ids.length) fail("invalid_field", "Select at least one blocked assignment");
	if (!inspect && ids.length > availableReservations(run))
		fail("limit", "Select assignments within the remaining worker and assignment limits");
	return ids.map(id => {
		const n = run.nodes[id], launch = n && originalAttempt(run, n);
		if (!n?.worker || n.state !== "blocked" || !n.generation || !n.token || !n.base || n.check || n.candidate ||
			missingInput(n) === undefined || !launch ||
			run.effects.some(e => (e.issuer === actor || e.issuer === n.worker) && e.permissionHold))
			fail("stale_assignment", `${id}: not an original bound missing-input attempt`);
		if (inspect && launch.readGrant) fail("already_approved", `${id}: inspection already approved; check writer status`);
		if (!inspect && n.repairs >= run.policy.repairs) fail("limit", `${id}: repair limit exhausted`);
		if (!inspect && n.grain.revision && n.grain.revision !== n.base) fail("stale_assignment", `${id}: a grant cannot replace the assignment's explicit revision`);
		const inputs = inspect ? n.inputs : !stalePins(run, n).length && writerInputs(run.nodes, waiting(n.grain));
		if (!inputs) fail("stale_assignment", `${id}: a pinned prerequisite changed`);
		if (!inspect) verifyRepairInputs(cwd, run, n, inputs, goal.commit);
		const directory = n.grain.directory, revision = n.grain.revision ?? n.base, baseline = directoryBaseline(cwd, revision, directory);
		if (!baseline || inspect && n.priorSource?.tree !== baseline.tree ||
			directoryBaseline(cwd, goal.commit, directory)?.tree !== baseline.tree ||
			run.join && directoryBaseline(cwd, run.join.commit, directory)?.tree !== baseline.tree ||
			entries(cwd, revision, true, [directory]).some(e => !["100644", "100755"].includes(e.mode)))
			fail("stale_assignment", `${id}: need the original unchanged regular-file inventory`);
		return { id, launch, token: n.token, worker: n.worker, generation: n.generation, inputs, specification: n.grain.specification, baseline };
	});
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {unknown} selections @param {boolean} [inspect] */
export function prepareBaselines(cwd, run, actor, selections, inspect = false) {
	const ids = names(selections, "blocked assignment"), before = manifest(cwd, run, actor, ids, inspect);
	return {
		prompt: `Run ${run.id}: allow these original writers to consult only their own prior directories, read-only?\n` +
			before.map(({ id, worker, baseline: b, specification }) => `${id} (${worker}): ${b.revision}:${b.directory}/\nTree: ${b.tree}; charter: ${specification}`).join("\n") +
			"\nApprove only if the charter omitted this permission, not if it forbids the read. " +
			(inspect ? "Inspection only: no repair, new token, edits or submission. Writers remain blocked."
				: "Each writer receives one bounded repair.") + " No checkout, other revisions, host permissions, evaluators or goals change.",
		/** @param {Run} live */
		apply(live) {
			const fresh = manifest(cwd, live, actor, ids, inspect);
			if (digest(fresh) !== digest(before)) fail("stale_assignment", "The approved assignments or baseline pins changed");
			if (inspect) {
				for (const row of fresh) row.launch.readGrant = row.baseline;
			} else {
				for (const row of fresh)
					reserveWriter(cwd, live, live.nodes[row.id], row.inputs, row.baseline.revision, actor, undefined, row.baseline);
				validateNodes(live.nodes);
				if (live.goal) delete live.goal.stall;
			}
			return () => commitAt(cwd, live.policy.target) === live.goal?.target;
		}
	};
}

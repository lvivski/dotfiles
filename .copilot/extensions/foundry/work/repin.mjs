import { remainingAssignments } from "./capacity.mjs";
import { productOverlayPaths } from "./contract.mjs";
import { checkpointReceipt, currentEvaluation, goalReceipt, productPin } from "./evidence.mjs";
import { admitted, current, reserveProduct } from "./native.mjs";
import { awaitingReply, unissued } from "./reservation.mjs";
import { changedFiles, commitAt, entries, outside, regularFiles, retain, verifyContracts } from "./product.mjs";
import { questions, releasedReviews, retireSuperseded, reviews } from "./reviews.mjs";
import { digest, fail, fields, relative, text } from "./values.mjs";
import { retainedMode } from "./transfer.mjs";
import { partitionConflict } from "./partition.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {string} actor @param {string} from @param {boolean} product */
function allowed(run, actor, from, product) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner can repin its evaluator");
	admitted(run);
	const evaluator = product ? run.policy.productCheck : run.policy.goalCheck;
	if (!run.goal || !evaluator?.startsWith(".foundry/")) fail("invalid_goal", "Repinning requires a goal run and a selected evaluator under .foundry/");
	if (((product ? productPin(run) : run.repins?.at(-1)?.revision) ?? run.policy.base) !== from) fail("stale_pin", "The evaluator pin changed; review the current diff");
	return evaluator;
}

/** @param {Run} run @param {string} target */
export function settledCheckpoint(run, target, operation="Product repinning") {
	const conflict=partitionConflict(run);
	if (conflict) fail("ownership_transition",conflict);
	const last = run.products.at(-1), goal = run.goal, receipt = goalReceipt(run);
	const history = reviews(run).filter(r=>currentEvaluation(run,r)), funded = remainingAssignments(run) > 0;
	const mutable = Object.values(run.nodes).filter(n=>["writing","checking","published","waiting"].includes(n.state));
	if (mutable.length) fail("unsettled_checkpoint",`${operation} must wait for current assignments: ${mutable.map(n=>`${n.grain.id} (${n.state})`).join(", ")}. Finish each original assignment under its existing grant; native idle does not release a writer.`);
	if (!goal || !last || last.target !== target || goal.target !== target || last.commit !== goal.commit ||
		!checkpointReceipt(run,last.check,last.commit) || !receipt || ![1,2].includes(receipt.exit ?? -1) ||
		run.join || run.conflict || run.blocker || questions(run).some(r=>r.decision?.status !== "answered") || run.pendingReviewNotes?.length ||
		funded && releasedReviews(run,history).length ||
		run.effects.some(e => awaitingReply(e) || (unissued(e) || e.permissionHold) && current(run,e) ||
			e.kind === "scout" && e.state === "reported" && currentEvaluation(run,e) && e.base === goal.commit))
		fail("unsettled_checkpoint", `${operation} requires a quiescent current checked product and settled unmet or missing goal; resolve pending work and holds first`);
	return {last, goal};
}

/** Prepare immutable inputs outside the transaction. The approval is for both revisions and the complete diff.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args */
export function prepareRepin(cwd, run, actor, args) {
	fields(args, ["run", "from", "revision", "files","kind","ownership"]);
	if (args.kind !== undefined && args.kind !== "product") fail("invalid_field","Omit kind for the goal evaluator or specify product");
	const product = args.kind === "product";
	if (args.ownership !== undefined && (!product || args.ownership !== retainedMode) ||
		product && Object.values(run.nodes).some(n=>n.retained) && args.ownership !== retainedMode)
		fail("unsupported_ownership","Transfers require a product checker explicitly supporting retain-except-transferred");
	const from = text(args.from, "current evaluator pin"), revision = text(args.revision, "new evaluator pin");
	const evaluator = allowed(run, actor, from, product), target = commitAt(cwd,run.policy.target);
	verifyContracts(cwd, run.policy, target);
	const checkpoint = product ? settledCheckpoint(run,target) : undefined, stamp = product && digest(run);
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) || commitAt(cwd, revision) !== revision)
		fail("invalid_pin", "Use the full object ID of the reviewed local commit");
	const files = changedFiles(cwd, from, revision).map(relative).sort();
	if (!files.length || !Array.isArray(args.files) || JSON.stringify(args.files.map(relative).sort()) !== JSON.stringify(files))
		fail("invalid_pin", "The file list must match the complete nonempty committed diff");
	const protectedFiles = [run.policy.source, product ? text(run.policy.goalCheck,"goal evaluator") : run.policy.productCheck, ...run.policy.squads.flatMap(s =>
		"areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter]),
		...Object.values(run.nodes).flatMap(n => [n.grain.specification, ...n.grain.boundary, n.grain.check])];
	if (product) {
		if (!productOverlayPaths(run,files))
			fail("contract_scope","Change only the named product evaluator or its private <evaluator>.d/ helpers");
	}
	if (files.some(p => !p.startsWith(".foundry/") || /^\.foundry\/[^/]+\.json$/i.test(p) || !outside(p, protectedFiles)))
		fail("contract_scope", "Only the selected evaluator and its .foundry helpers may change, not the brief, other checks, or product");
	regularFiles(cwd, revision, [evaluator]);
	for (const e of entries(cwd, revision, true, files))
		if (!["100644", "100755"].includes(e.mode)) fail("invalid_pin", `Not a regular evaluator file: ${e.name}`);
	/** @type {Pick<NonNullable<Run["productRepins"]>[number],"from"|"revision"|"files"|"ownership">} */
	const pin = { from, revision, files, ...(args.ownership === retainedMode ? {ownership:retainedMode} : {}) };
	return {
		prompt: (checkpoint ? `Run ${run.id}: authorize this diff for the product evaluator only (${evaluator}) and opt this run into exact-file ownership comparisons?\n` +
			(args.ownership ? `This checker must subtract FOUNDRY_OWNERSHIP exclude.directories and exclude.files for ${retainedMode}.\n` : "") +
			`Recheck ${checkpoint.last.commit}, checkpoint ${checkpoint.last.check}, unchanged target ${target}. The original goal will be assessed afresh only after a pass. No writer access is granted by this approval.\n` :
			`Run ${run.id}: authorize the following committed diff for goal checks only?\n`) +
			`git diff --no-ext-diff --no-textconv ${from} ${revision}\nFiles: ${JSON.stringify(files)}\n` +
			"Approve to recheck the existing product only if this fixes evaluation without changing the product requirements.",
		/** @param {Run} live */
		apply(live) {
			allowed(live, actor, from, product);
			const tip = commitAt(cwd, live.policy.target);
			verifyContracts(cwd, live.policy, tip);
			if (checkpoint && (tip !== target || digest(live) !== stamp)) fail("stale_pin","Checkpoint or run changed during product approval");
			if (revision === live.policy.base || (product ? live.productRepins : live.repins)?.some(p => p.revision === revision))
				fail("stale_pin", "Use a new reviewed commit, not a previously applied pin");
			retain(cwd, revision);
			if (checkpoint) {
				const {last,goal} = settledCheckpoint(live,tip);
				const upgrade = {...pin,checkpoint:last.check,goal:goal.check,recheck:""};
				(live.productRepins ??= []).push(upgrade);
				reserveProduct(live,actor,cwd,tip,last.commit,{...last.outputs});
				upgrade.recheck = text(live.join?.check,"new product check");
				return () => commitAt(cwd,live.policy.target) === tip;
			}
			(live.repins ??= []).push(pin);
			for (const r of reviews(live)) retireSuperseded(live, r);
		},
	};
}

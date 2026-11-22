import { admitted } from "./native.mjs";
import { changedFiles, commitAt, entries, outside, regularFiles, retain, verifyContracts } from "./product.mjs";
import { retireSuperseded, reviews } from "./reviews.mjs";
import { fail, fields, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {string} actor @param {string} from */
function allowed(run, actor, from) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner can repin its goal evaluator");
	admitted(run);
	if (!run.goal || !run.policy.goalCheck?.startsWith(".foundry/")) fail("invalid_goal", "Repinning requires a goal evaluator under .foundry/");
	if ((run.repins?.at(-1)?.revision ?? run.policy.base) !== from) fail("stale_pin", "The evaluator pin changed; review the current diff");
}

/** Prepare immutable inputs outside the transaction. The approval is for both revisions and the complete diff.
 * @param {string} cwd @param {Run} run @param {string} actor @param {Record<string,unknown>} args */
export function prepareRepin(cwd, run, actor, args) {
	fields(args, ["run", "from", "revision", "files"]);
	const from = text(args.from, "current evaluator pin"), revision = text(args.revision, "new evaluator pin");
	allowed(run, actor, from);
	verifyContracts(cwd, run.policy, commitAt(cwd, run.policy.target));
	if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision) || commitAt(cwd, revision) !== revision)
		fail("invalid_pin", "Use the full object ID of the reviewed local commit");
	const files = changedFiles(cwd, from, revision).map(relative).sort();
	if (!files.length || !Array.isArray(args.files) || JSON.stringify(args.files.map(relative).sort()) !== JSON.stringify(files))
		fail("invalid_pin", "The file list must match the complete nonempty committed diff");
	const goal = text(run.policy.goalCheck, "goal evaluator");
	const protectedFiles = [run.policy.source, run.policy.productCheck, ...run.policy.squads.flatMap(s =>
		"areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter]),
		...Object.values(run.nodes).flatMap(n => [n.grain.specification, ...n.grain.boundary, n.grain.check])];
	if (files.some(p => !p.startsWith(".foundry/") || /^\.foundry\/[^/]+\.json$/i.test(p) || !outside(p, protectedFiles)))
		fail("contract_scope", "Only the goal evaluator and its .foundry helpers may change, not the brief, other checks, or product");
	regularFiles(cwd, revision, [goal]);
	for (const e of entries(cwd, revision, true, files))
		if (!["100644", "100755"].includes(e.mode)) fail("invalid_pin", `Not a regular evaluator file: ${e.name}`);
	const pin = { from, revision, files };
	return {
		prompt: `Run ${run.id}: authorize the following committed diff for goal checks only?\n` +
			`git diff --no-ext-diff --no-textconv ${from} ${revision}\nFiles: ${JSON.stringify(files)}\n` +
			"Approve to recheck the existing product only if this fixes evaluation without changing the product requirements.",
		/** @param {Run} live */
		apply(live) {
			allowed(live, actor, from);
			verifyContracts(cwd, live.policy, commitAt(cwd, live.policy.target));
			if (revision === live.policy.base || live.repins?.some(p => p.revision === revision))
				fail("stale_pin", "Use a new reviewed commit, not a previously applied pin");
			retain(cwd, revision);
			(live.repins ??= []).push(pin);
			for (const r of reviews(live)) retireSuperseded(live, r);
		},
	};
}

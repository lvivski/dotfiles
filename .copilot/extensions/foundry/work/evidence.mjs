/** @typedef {import("./model.js").Run} Run */

const missingPrefix = "Writer reports missing input: ";
/** @param {import("./model.js").Node} n @param {string} detail */
export function stopForInput(n, detail) {
	n.state = "blocked";
	n.stop = { kind: "writer-missing-input", detail };
	n.reason = missingPrefix + detail;
}

/** Return the unmodified original detail; older snapshots recorded only the display reason.
 * @param {import("./model.js").Node} n */
export function missingInput(n) {
	if (n.state !== "blocked") return;
	if (n.stop) return n.stop.kind === "writer-missing-input" ? n.stop.detail : undefined;
	if (n.reason?.startsWith(missingPrefix)) return n.reason.slice(missingPrefix.length);
}

/** Native shell completion is not evidence. Only the runner can attest to its pinned input.
 * @param {import("./model.js").Effect|undefined} e */
export function checkReceipt(e) {
	if (e?.tool === "bash" && e.runnerStarted && e.state === "done" && e.receipt &&
		e.receipt.commit === e.commit && e.receipt.check === e.check && e.receipt.evaluatorRevision === e.evaluatorRevision) return e.receipt;
}

/** A prior reader's *terminal* component attempt, not a verdict about what caused it.
 * @param {import("./model.js").Node} n @param {import("./model.js").Effect|undefined} e */
export function blockedComponent(n, e) {
	const receipt = checkReceipt(e);
	if (n.state === "blocked" && e?.kind === "component" && e.id === n.check && e.grain === n.grain.id &&
		e.check === n.grain.check && e.issuer === n.worker && e.callId && !e.error && !e.inlineRepair &&
		receipt?.exit === null && receipt.commit === n.candidate &&
		(receipt.failure === "changed-export" || !receipt.failure && n.reason === `Evaluation did not complete: ${receipt.output}`)) return receipt;
}

/** @param {import("./model.js").Node} n @param {import("./model.js").Effect|undefined} e */
export function changedFrom(n, e) {
	const receipt = blockedComponent(n, e);
	if (receipt && !receipt.failure) return receipt.commit;
}

/** @param {Run} run @param {import("./model.js").Node} n */
export function baselineNotice(run, n) {
	const e = run.effects.findLast(e => e.kind === "repair" && e.token === n.token && e.grain === n.grain.id);
	return e?.kind === "repair" && e.baseline ? e : undefined;
}

/** @param {Run} run */
export function goalReceipt(run) {
	const at = run.goal;
	const e = at && run.effects.find(e => e.id === at.check);
	if (e?.kind === "goal" && e.commit === at?.commit && e.check === run.policy.goalCheck &&
		e.evaluatorRevision === run.repins?.at(-1)?.revision) return checkReceipt(e);
}

/** A terminal product check holds only its own candidate, not the goal on the assessed base.
 * @param {Run} run */
export function milestoneBlocker(run) {
	const e = run.join && run.effects.find(e => e.id === run.join?.check);
	if (e?.kind === "product" && (e.state === "done" || e.state === "refused")) return e.error;
}

/** @param {Run} run */
export function missingObservation(run) {
	const receipt = goalReceipt(run);
	if (!run.blocker && receipt?.exit === 2 && (!run.join || milestoneBlocker(run))) return receipt;
}

/** A goal milestone doesn't qualify until both exact receipts are applied to this product.
 * @param {Run} run */
export function qualifiedProduct(run) {
	const last = run.products.at(-1);
	return last?.qualifiedAt ? last : undefined;
}

/** Project the runner verdict, not native IDs, command arguments or evaluator output.
 * @param {import("./model.js").Effect|undefined} e @param {"product"|"goal"|"component"} kind
 * @param {string} commit @param {string} check @param {string} [grain] */
export function passingReceipt(e, kind, commit, check, grain) {
	if (e?.kind === kind && e.grain === grain && e.commit === commit && e.check === check && checkReceipt(e)?.exit === 0)
		return { commit, check, exit: 0, ...(e.evaluatorRevision ? { evaluatorRevision: e.evaluatorRevision } : {}) };
}

/** A milestone is authority for the reviewed inputs, never a goal verdict.
 * @param {Run} run @param {string} id @param {string} base */
export function checkpointReceipt(run, id, base) {
	return run.products.some(p => p.check === id && p.commit === base) &&
		passingReceipt(run.effects.find(e => e.id === id), "product", base, run.policy.productCheck);
}

/** The last *applied* product. A native success, a pending join, or two green checks
 * from different assessments do not make a goal handoff.
 * @param {Run} run */
export function acceptedChecks(run) {
	const last = qualifiedProduct(run);
	if (!last) return;
	const { productCheck, goalCheck } = run.policy;
	const product = passingReceipt(run.effects.find(e => e.id === last.check), "product", last.commit, productCheck);
	if (!product) return;
	if (!goalCheck && !run.goal) return { last, product };
	if (!goalCheck || goalCheck === productCheck || run.active || run.join || run.blocker || run.conflict ||
		run.goal?.commit !== last.commit || run.goal.target !== last.target || run.goal.stall) return;
	const goal = passingReceipt(run.effects.find(e => e.id === run.goal?.check), "goal", last.commit, goalCheck);
	if (goal && goalReceipt(run)?.exit === 0) return { last, product, goal };
}

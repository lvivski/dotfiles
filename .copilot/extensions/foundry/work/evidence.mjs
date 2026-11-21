/** @typedef {import("./model.js").Run} Run */

/** Native shell completion is not evidence. Only the runner can attest to its pinned input.
 * @param {import("./model.js").Effect|undefined} e */
export function checkReceipt(e) {
	if (e?.tool === "bash" && e.runnerStarted && e.state === "done" && e.receipt &&
		e.receipt.commit === e.commit && e.receipt.check === e.check) return e.receipt;
}

/** @param {Run} run */
export function goalReceipt(run) {
	const at = run.goal;
	const e = at && run.effects.find(e => e.id === at.check);
	if (e?.kind === "goal" && e.commit === at?.commit && e.check === run.policy.goalCheck) return checkReceipt(e);
}

/** @param {Run} run */
export function missingObservation(run) {
	const receipt = goalReceipt(run);
	if (!run.blocker && !run.join && receipt?.exit === 2) return receipt;
}

/** A goal milestone doesn't qualify until both exact receipts are applied to this product.
 * @param {Run} run */
export function qualifiedProduct(run) {
	const last = run.products.at(-1);
	return last?.qualifiedAt ? last : undefined;
}

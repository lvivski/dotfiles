import { randomUUID } from "node:crypto";
import { qualifiedProduct } from "./evidence.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @param {Run} run */
export const reviews = run => run.effects.filter(e => e.kind === "scout");
/** @param {Review} r */
export const reading = r => r.state === "ready" || r.state === "issued" || r.state === "uncertain";

/** A review *is* its workflow reservation. A received report may still await admission on resume.
 * @param {Run} run @param {string} issuer @param {string} squad @param {string} base @param {string} version */
export function reserveReview(run, issuer, squad, base, version) {
	run.effects.push({ id: randomUUID(), issuer, squad, base, version, kind: "scout", tool: "workflow", args: {}, state: "ready" });
}

/** @param {Review} r @param {string} reason */
export function blockReview(r, reason) {
	r.state = "blocked";
	r.error = reason;
	delete r.permissionHold;
}

/** @param {Review} r */
export function reviewStatus(r) {
	return { id: r.id, squad: r.squad, state: reading(r) ? "reading" : r.state, base: r.base, version: r.version,
		workflowId: r.workflowId, observation: r.observation, reason: r.state === "blocked" ? r.error : undefined, decision: r.decision };
}

/** Only the latest review can ask for input; historical questions remain in the reviews list.
 * @param {Run} run */
export function questions(run) {
	if (run.goal && qualifiedProduct(run)) return [];
	const latest = new Map(reviews(run).map(r => [r.squad, r]));
	return [...latest.values()].filter(r => r.state === "observed" && r.observation?.outcome === "needs-decision" &&
		(!run.goal || run.goal.commit === r.base && (!run.products.length || run.products.at(-1)?.commit === r.base)));
}

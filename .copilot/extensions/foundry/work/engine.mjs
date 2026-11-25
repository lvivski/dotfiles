/** @typedef {"absent"|"pending"|"retired"|"rejoining"|"superseded"|"repin"|"product-repin"|"new-product"|"incomplete"|"missing"|"unmet"|"met"} GoalState */
/** @typedef {{active:boolean, qualified:boolean, goal:GoalState, blocked:boolean, scoped:boolean, stalled:boolean,
 * moved:boolean, idle:boolean, product:boolean, exactProduct:boolean, join:boolean, held:boolean, review:boolean, work:boolean}} Facts */
/** @typedef {"wait"|"assess"|"retry"|"assess-target"|"undecided"|"rejoin"|"qualify"|"baseline"|"none"} Action */
/** @typedef {import("./admission.mjs").Admission} Admission */
/** @param {Action} action @param {Admission} admission @param {string} reason */
const decision = (action, admission, reason) => ({ action, admission, reason });

/** @param {never} state @returns {never} */
export function unhandled(state) { throw new Error(`Unhandled release state or action: ${state}`); }

/** @param {Pick<Facts, "review"|"scoped"|"work"|"product"|"join"|"exactProduct">} f */
function passingGoal(f) {
	if (f.review) return decision("wait", f.scoped ? "checkpoint" : "closed", "comparison-in-progress");
	if (f.work) return decision("none", "open", "include-admitted-work");
	if (!f.product) return f.join ? decision("wait", "closed", "awaiting-baseline-product") : decision("baseline", "closed", "verify-baseline-product");
	return f.exactProduct && !f.join ? decision("qualify", "closed", "exact-checks-passed") : decision("wait", "closed", "awaiting-exact-product");
}

/** @param {Pick<Facts, "product"|"idle"|"held">} f */
function heldOrMoved(f) {
	if (f.held) return decision("none", "open", "milestone-held");
	return !f.product && f.idle ? decision("assess-target", "closed", "new-target") : decision("rejoin", "open", "target-changed");
}

/** Reconcile is level-triggered: the same facts always yield the same intent. Only the
 * ledger adapter can apply it; the engine has no clock, repository or native host.
 * @param {Readonly<Facts>} f @param {boolean} [retryEvidence] */
export function transition(f, retryEvidence = false) {
	if (!f.active) return decision("wait", "closed", f.qualified ? "qualified" : "paused");
	if (f.goal === "absent") return decision("none", "open", "component-work");
	if (f.blocked) return decision("wait", "closed", "blocked");
	switch (f.goal) {
	case "product-repin": return decision("wait","closed",f.moved ? "product-repin-target-changed" : f.held ? "product-repin-held" : "awaiting-product-repin");
	case "superseded": return decision("wait", f.scoped ? "checkpoint" : "closed", "superseded-goal");
	case "pending": return decision("wait", f.scoped ? "checkpoint" : "closed", "awaiting-goal-receipt");
	case "retired": return decision("none", "open", "integrate-retained-work");
	case "rejoining": return decision("none", "join-only", "verify-current-product");
	case "repin": return decision("assess", "closed", "evaluator-changed");
	case "new-product": return decision("assess", "closed", "new-checkpoint");
	case "incomplete": return decision("undecided", "closed", "incomplete-goal");
	case "missing":
		if (!retryEvidence && f.scoped) return decision("wait", f.work ? "repaired-checkpoint" : "checkpoint", "missing-evidence");
		if (!retryEvidence && (!f.moved || !f.join || f.held)) return decision("wait", "closed", "missing-evidence");
		if (!f.moved) return decision("retry", "closed", "retry-evidence");
		return heldOrMoved(f);
	case "unmet":
	case "met":
		if (f.held || f.moved) return heldOrMoved(f);
		if (f.stalled) return decision("wait", "closed", "no-new-information");
		return f.goal === "met" ? passingGoal(f) : decision("none", "open", "goal-unmet");
	default: return unhandled(f.goal);
	}
}

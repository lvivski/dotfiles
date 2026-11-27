import { scopeLabel } from "./values.mjs";

/** Keep only the facts the map can display, not receipt bodies, delivery identities,
 * question answers, or the rest of a scout's report.
 * @param {import("./visibility.mjs").BoardSource} s @param {boolean} owner */
export function projectBoard(s, owner) {
	return {
		run: s.run, direction: s.direction, owner, active: s.active, expired: s.expired,
		qualified: s.qualified ?? null, checkpoint: s.checkpoint ?? null, blocker: s.blocker ?? s.discoveryError ?? "",
		timing: s.metrics ? { firstWriter: s.metrics.firstWriter.state, writerMs: s.metrics.firstWriter.elapsedMs,
			qualifiedMs: s.metrics.qualified.elapsedMs } : null,
		goal: s.goal ? { commit: s.goal.commit, result: s.goal.receipt ? { exit: s.goal.receipt.exit, output: s.goal.receipt.output } : null } : null,
		pending: s.pending.map(p => ({ kind: p.kind, grain: p.grain, evaluating: p.awaitingEvaluator === true, reason: p.reason })),
		reviews: s.reviews.map(r => ({ squad: r.squad, state: r.state, started: !!r.workflowId, reason: r.reason,
			observation: r.observation && { outcome: r.observation.outcome, reason: r.observation.reason, waitFor: r.observation.waitFor } })),
		questions: (s.questions ?? []).map(q => ({ question: q.question, delivery: q.delivery?.status,
			reason: q.delivery?.status === "unavailable" ? q.delivery.reason : undefined })),
		nodes: s.nodes.map(n => ({
			id: n.grain, task: n.task ?? "", directory: scopeLabel(n.directory), needs: n.requires,
			...(n.specification && {specification:n.specification}),
			state: n.writerBinding === "bound" ? "assigned" : n.writerBinding === "unconfirmed" ? "unconfirmed" : n.writerBinding === "pending" ? "starting" : n.state,
			reason: n.reason ?? (n.state==="reviewing" && (n.codeReview?.permissionHold ?? n.codeReview?.summary) || ""), check: n.evaluator, checked: n.checked ?? null,
			result: n.receipt ? { commit: n.receipt.commit, exit: n.receipt.exit } : null,
			...(owner && n.passedOnBuild && {passedOnBuild:n.passedOnBuild}),
			...(n.attempts && {attempts:n.attempts}),
		})),
	};
}

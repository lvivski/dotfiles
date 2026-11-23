import { assignmentCount } from "./capacity.mjs";
import { goalReceipt, milestoneBlocker, missingObservation, qualifiedProduct } from "./evidence.mjs";
import { timingFacts } from "./metrics.mjs";
import { awaitingReply, current, expired } from "./native.mjs";
import { checked, liveNeeds } from "./plan.mjs";
import { questions, reviews, reviewStatus } from "./reviews.mjs";
import { fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** Ledger-only facts shared by the board and chat. Nodes and effects stay inside the
 * query; each surface projects only the fields it exposes.
 * @param {Run} run @param {string} actor */
export function visible(run, actor) {
	const owner = run.owner === actor;
	const nodes = Object.values(run.nodes).filter(n => n.state !== "idle" && (owner || n.worker === actor));
	if (!owner && !nodes.length && !run.effects.some(e => e.nativeId === actor))
		fail("foreign_run", "No bound assignment in this run");

	const pending = run.effects.filter(e => (owner || e.issuer === actor) && e.state !== "done" && (awaitingReply(e) || current(run, e)));
	const receipts = new Map(run.effects.filter(e => e.receipt).map(e => [e.id, e.receipt]));
	const missing = missingObservation(run);
	const assignments = run.policy.assignments === undefined ? undefined : { limit: run.policy.assignments, used: assignmentCount(run) };
	const qualified = qualifiedProduct(run), finished = (run.goal || run.policy.seed) && qualified;
	const stop = !finished && assignments && assignments.used === assignments.limit
		? `Total assignment limit reached (${assignments.used}/${assignments.limit}); no new scouts, writers or repairs. Reserved work and checks can finish.` : undefined;
	const pin = run.repins?.at(-1)?.revision;
	const previous = pin && owner ? pending.find(e => e.id === run.goal?.check && e.evaluatorRevision !== pin &&
		e.runnerStarted && awaitingReply(e) && !e.receipt && !e.permissionHold) : undefined;
	const blocker = run.pauseReason ?? run.blocker ?? run.conflict ?? run.goal?.stall ?? (previous
		? `Approved evaluator ${pin} is waiting for the receipt of superseded goal ${previous.id} in session ${previous.issuer}. Verify the original runner before intervening; do not replay it.`
		: missing ? `Goal check at ${missing.commit} awaits external evidence (exit 2): ${missing.output.trim() || "no diagnostic"}. After supplying it, use /foundry resume ${run.policy.source}.` : milestoneBlocker(run));
	const openQuestions = owner ? questions(run).flatMap(r => r.observation ? [{ review: r, observation: r.observation,
		fact: { question: r.observation.reason, ...(r.decision ? { delivery: r.decision } : {}) } }] : []) : [];
	return { owner, nodes, pending, receipts, assignments, questions: openQuestions, summary: {
		run: run.id, active: run.active, direction: run.policy.direction, expired: expired(run),
		blocker: blocker && stop ? `${blocker}\n${stop}` : blocker ?? stop,
		reviews: owner ? reviews(run).map(reviewStatus) : [],
		...(owner ? { discoveryError: run.discoveryError, qualified: qualified?.commit ?? null,
			...(run.goal ? { checkpoint: run.products.at(-1)?.commit ?? null, goal: { commit: run.goal.commit,
				evaluator: run.policy.goalCheck, pin: pin ?? run.policy.base, receipt: goalReceipt(run) } } : {}) } : {}),
	} };
}

/** @param {import("./model.js").Node} n @param {ReturnType<typeof visible>["receipts"]} receipts */
export function nodeFact(n, receipts) {
	return { grain: n.grain.id, directory: n.grain.directory, task: n.grain.task, requires: liveNeeds(n), evaluator: n.grain.check,
		state: n.state, checked: checked(n) ? n.candidate : undefined, worker: n.worker, receipt: n.check && receipts.get(n.check), reason: n.reason };
}

/** @param {import("./model.js").Effect} e */
export function pendingFact(e) {
	return { id: e.id, issuer: e.issuer, kind: e.kind, state: e.state, ...(e.grain ? { grain: e.grain } : {}),
		...(e.tool === "bash" && e.runnerStarted && !e.receipt && awaitingReply(e) && !e.permissionHold ? { awaitingEvaluator: true } : {}),
		reason: e.permissionHold ?? e.error };
}

/** @typedef {ReturnType<typeof visible>["summary"] & {
 * metrics?: ReturnType<typeof timingFacts>, questions?: ReturnType<typeof visible>["questions"][number]["fact"][],
 * nodes: ReturnType<typeof nodeFact>[], pending: ReturnType<typeof pendingFact>[]
 * }} BoardSource */

/** Keep only the facts the map can display, not receipt bodies, delivery identities,
 * question answers, or the rest of a scout's report.
 * @param {BoardSource} s @param {boolean} owner */
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
			id: n.grain, task: n.task ?? "", directory: n.directory, needs: n.requires,
			state: n.state === "writing" ? (!("worker" in n) ? "assigned" : n.worker ? "writing" : "starting") : n.state,
			reason: n.reason ?? "", check: n.evaluator, checked: n.checked ?? null,
			result: n.receipt ? { commit: n.receipt.commit, exit: n.receipt.exit } : null,
		})),
	};
}

/** @param {Run} run @param {string} actor */
export function boardFacts(run, actor) {
	const { owner, summary, questions, nodes, pending, receipts } = visible(run, actor);
	return projectBoard({ ...summary, ...(owner ? { metrics: timingFacts(run), questions: questions.map(q => q.fact) } : {}),
		nodes: nodes.map(n => nodeFact(n, receipts)), pending: pending.map(pendingFact) }, owner);
}

import { materialize, offered } from "./artifacts.mjs";
import { goalReceipt, milestoneBlocker, missingObservation, qualifiedProduct } from "./evidence.mjs";
import { handoff, qualification } from "./handoff.mjs";
import { metricsFacts, timingFacts } from "./metrics.mjs";
import { assignmentCount, awaitingReply, canDispatch, current, expired } from "./native.mjs";
import { checked, liveNeeds } from "./plan.mjs";
import { presentation, questions, reviews, reviewStatus } from "./reviews.mjs";
import { fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {Map<string,import("./model.js").Receipt|undefined>} receipts @param {unknown} detail */
function ownerStatus(run, receipts, detail) {
	const last = run.products.at(-1);
	return {
		handoff: handoff(run, detail === "cleanup"),
		...(detail === "proof" ? { qualification: qualification(run) } : {}),
		metrics: detail === "usage" ? metricsFacts(run) : timingFacts(run),
		discoveryError: run.discoveryError,
		qualified: qualifiedProduct(run)?.commit ?? null, target: last?.target, outputs: last?.outputs ?? {},
		...(run.goal ? { checkpoint: last?.commit ?? null, goal: { commit: run.goal.commit, evaluator: run.policy.goalCheck,
			pin: run.repins?.at(-1)?.revision ?? run.policy.base, receipt: goalReceipt(run) } } : {}),
		...(run.repins ? { evaluatorChanges: run.repins, goalChecks: run.effects.filter(e => e.kind === "goal").map(e => ({
			commit: e.commit, evaluatorRevision: e.evaluatorRevision ?? e.commit, state: e.state, receipt: receipts.get(e.id) })) } : {}),
		questions: questions(run).flatMap(r => {
			const claim = presentation(r);
			return r.observation ? [{ squad: r.squad, base: r.base, question: r.observation.reason,
				evidence: r.observation.evidence, ...(r.decision ? { delivery: r.decision } : {}),
				...(r.observation.ownerInput && claim ? { recovery: { run: run.id, review: r.id, presentation: claim } } : {}) }] : [];
		}),
		products: run.products.map(p => ({ ...p, receipt: receipts.get(p.check) })),
		candidate: run.join && { ...run.join, receipt: receipts.get(run.join.check) },
	};
}

/** @param {Run} run @param {string} actor @param {unknown} [detail] */
export function status(run, actor, detail) {
	const owner = run.owner === actor;
	if (detail !== undefined) {
		if (!owner) fail("foreign_run", "Only the owner can request handoff details");
		if (detail !== "proof" && detail !== "cleanup" && detail !== "usage") fail("invalid_field", "Unknown status detail");
	}
	const nodes = Object.values(run.nodes).filter(n => n.state !== "idle" && (owner || n.worker === actor));
	if (!owner && !nodes.length && !run.effects.some(e => e.nativeId === actor))
		fail("foreign_run", "No bound assignment in this run");

	const pending = run.effects.filter(e => (owner || e.issuer === actor) && e.state !== "done" && (awaitingReply(e) || current(run, e)));
	const receipts = new Map(run.effects.filter(e => e.receipt).map(e => [e.id, e.receipt]));
	const missing = missingObservation(run);
	const assignments = run.policy.assignments === undefined ? undefined : { limit: run.policy.assignments, used: assignmentCount(run) };
	const finished = (run.goal || run.policy.seed) && qualifiedProduct(run);
	const stop = !finished && assignments && assignments.used === assignments.limit
		? `Total assignment limit reached (${assignments.used}/${assignments.limit}); no new scouts, writers or repairs. Reserved work and checks can finish.` : undefined;
	const pin = run.repins?.at(-1)?.revision;
	const previous = pin && owner ? pending.find(e => e.id === run.goal?.check && e.evaluatorRevision !== pin &&
		e.runnerStarted && awaitingReply(e) && !e.receipt && !e.permissionHold) : undefined;
	const blocker = run.pauseReason ?? run.blocker ?? run.conflict ?? run.goal?.stall ?? (previous
		? `Approved evaluator ${pin} is waiting for the receipt of superseded goal ${previous.id} in session ${previous.issuer}. Verify the original runner before intervening; do not replay it.`
		: missing ? `Goal check at ${missing.commit} awaits external evidence (exit 2): ${missing.output.trim() || "no diagnostic"}. After supplying it, use /foundry resume ${run.policy.source}.` : milestoneBlocker(run));
	return {
		run: run.id, active: run.active, direction: run.policy.direction, contract: { commit: run.policy.base, path: run.policy.source },
		limit: run.policy.workers ?? null, ...(assignments ? { assignments } : {}), deadline: run.policy.deadline, expired: expired(run),
		...(owner ? ownerStatus(run, receipts, detail) : {}),
		artifacts: (run.artifacts ?? []).filter(a => owner || a.publisher === actor || nodes.some(n => offered(a, n))).map(a => ({ ...a, extract: materialize(a) })),
		artifactReports: run.effects.flatMap(e => e.kind === "component" && (owner || e.issuer === actor) && (e.usedArtifacts || e.comparedArtifacts)
			? [{ grain: e.grain, worker: e.issuer, candidate: e.commit, usedArtifacts: e.usedArtifacts, comparedArtifacts: e.comparedArtifacts }] : []),
		blocker: blocker && stop ? `${blocker}\n${stop}` : blocker ?? stop,
		reviews: owner ? reviews(run).map(reviewStatus) : [],
		nodes: nodes.map(n => ({
			grain: n.grain.id, directory: n.grain.directory, task: n.grain.task, requires: liveNeeds(n), evaluator: n.grain.check,
			state: n.state, checked: checked(n) ? n.candidate : undefined,
			...(actor === n.worker ? { token: n.token } : {}),
			...(owner || actor === n.worker ? { review: n.review, worker: n.worker, repairs: n.repairs, inputs: n.inputs,
				generation: n.generation, receipt: n.check && receipts.get(n.check), reason: n.reason } : {}),
		})),
		pending: pending.map(e => ({ id: e.id, issuer: e.issuer, kind: e.kind, state: e.state,
			...(e.grain ? { grain: e.grain } : {}),
			...(e.tool === "bash" && e.runnerStarted && !e.receipt && awaitingReply(e) && !e.permissionHold ? { awaitingEvaluator: true } : {}),
			reason: e.permissionHold ?? e.error })),
		prepared: pending.filter(e => e.issuer === actor && e.state === "ordinary" && !e.permissionHold && canDispatch(run, e)).map(e => ({ tool: e.tool, arguments: e.args })),
	};
}

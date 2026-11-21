import { canFollow } from "./graph.mjs";
import { goalReceipt, missingObservation } from "./goal.mjs";
import { awaitingReply, current, expired } from "./native.mjs";
import { checked, liveNeeds } from "./plan.mjs";
import { fail } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @param {Run} run @param {Map<string,import("./model.js").Receipt|undefined>} receipts */
function ownerStatus(run, receipts) {
	const last = run.products.at(-1);
	const reports = new Map(run.reviews.filter(r => r.observation).map(r => [r.squad, r]));
	return {
		proposedLimit: run.capacity?.offer?.to, discoveryError: run.discoveryError,
		qualified: (run.goal ? run.accepted : last?.commit) ?? null, target: last?.target, outputs: last?.outputs ?? {},
		...(run.goal ? { checkpoint: last?.commit ?? null, goal: { commit: run.goal.commit, evaluator: run.policy.goalCheck, receipt: goalReceipt(run) } } : {}),
		questions: [...reports.values()].flatMap(r => r.observation?.outcome === "needs-decision"
			? [{ squad: r.squad, base: r.base, question: r.observation.reason, evidence: r.observation.evidence }] : []),
		products: run.products.map(p => ({ ...p, receipt: receipts.get(p.check) })),
		candidate: run.join && { ...run.join, receipt: receipts.get(run.join.check) },
	};
}

/** @param {Run} run @param {string} actor */
export function status(run, actor) {
	const owner = run.owner === actor;
	const reviews = run.reviews.filter(r => owner || r.worker === actor);
	const nodes = Object.values(run.nodes).filter(n => n.state !== "idle" && (owner || reviews.length || n.worker === actor));
	if (!owner && !nodes.length && !reviews.length && !run.effects.some(e => e.nativeId === actor))
		fail("foreign_run", "No bound assignment in this run");

	const pending = run.effects.filter(e => (owner || e.issuer === actor) && e.state !== "done" && (awaitingReply(e) || current(run, e)));
	const receipts = new Map(run.effects.filter(e => e.receipt).map(e => [e.id, e.receipt]));
	const missing = missingObservation(run);
	return {
		run: run.id, active: run.active, direction: run.policy.direction, contract: { commit: run.policy.base, path: run.policy.source },
		limit: run.capacity?.limit ?? null, deadline: run.policy.deadline, expired: expired(run),
		...(owner ? ownerStatus(run, receipts) : {}),
		blocker: run.pauseReason ?? run.blocker ?? run.conflict ?? run.goal?.stall ?? (missing ? `Goal check at ${missing.commit} awaits external evidence (exit 2): ${missing.output.trim() || "no diagnostic"}. Pause and explicitly resume after supplying it.` : undefined),
		reviews: reviews.map(r => {
			const { token, ...report } = r;
			return { ...report, ...(actor === r.worker ? { token, ...(canFollow(run, r) ? { nextToken: r.id } : {}) } : {}) };
		}),
		nodes: nodes.map(n => ({
			grain: n.grain.id, directory: n.grain.directory, task: n.grain.task, requires: liveNeeds(n), evaluator: n.grain.check,
			state: n.state, checked: checked(n) ? n.candidate : undefined,
			...(actor === n.worker ? { token: n.token } : {}),
			...(owner || actor === n.worker ? { review: n.review, worker: n.worker, repairs: n.repairs, inputs: n.inputs,
				generation: n.generation, receipt: n.check && receipts.get(n.check), reason: n.reason } : {}),
		})),
		pending: pending.map(e => ({ id: e.id, issuer: e.issuer, kind: e.kind, state: e.state, reason: e.permissionHold ?? e.error })),
		prepared: run.active ? pending.filter(e => e.issuer === actor && e.state === "ordinary" && !e.permissionHold).map(e => ({ tool: e.tool, arguments: e.args })) : [],
	};
}

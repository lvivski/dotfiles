import { randomUUID } from "node:crypto";
import { qualifiedProduct } from "./evidence.mjs";
import { actionable, checked, displacedInputs, owns } from "./plan.mjs";
import { digest } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @param {Run} run */
export const reviews = run => run.effects.filter(e => e.kind === "scout");
/** @param {Review} r */
export const reading = r => r.state === "ready" || r.state === "issued" || r.state === "uncertain";

/** A review *is* its workflow reservation. A received report may still await admission on resume.
 * @param {Run} run @param {string} issuer @param {string} squad @param {string} base @param {string} version @param {Review["wake"]} [wake] */
export function reserveReview(run, issuer, squad, base, version, wake) {
	run.effects.push({ id: randomUUID(), issuer, squad, base, version, ...(wake ? { wake } : {}), kind: "scout", tool: "workflow", args: {}, state: "ready" });
}

/** @param {Run} run @param {Review} r */
export const wakeSource = (run, r) => r.wake && reviews(run).find(p => p.id === r.wake?.review && p.squad === r.squad && p.base === r.base);

/** @param {Run} run @param {Review} r @param {import("./model.js").Squad} squad */
export const canInvestigate = (run, r, squad) => "areas" in squad && !!squad.researchAgent && !reviews(run).some(e =>
	e.squad === r.squad && e.base === r.base && e.version === r.version && e.wake?.key === "research");

/** Reconstruct the diagnostic for already-recorded "unknown output" failures only
 * when the rejected plan actually displaces that checked input.
 * @param {Run} run @param {Review} review */
export function correction(run, review) {
	if (review.state !== "blocked" || review.observation?.outcome !== "regenerate") return;
	const conflict = displacedInputs(run.nodes, review.observation.grains);
	if (conflict && (review.error === conflict.reason || conflict.lost.some(id => review.error === `Unknown required output: ${id}`)))
		return conflict.reason;
}

/** Prefer an attributed gap until that charter runs out of work. Under a cap, rotate
 * the others by last review so successive checkpoints don't starve them.
 * @param {Run} run @param {Review[]} history @param {import("./model.js").Receipt|undefined} gap */
export function discoverySquads(run, history, gap) {
	const squads = run.policy.squads, focus = gap?.squad && squads.find(s => s.id === gap.squad);
	if (focus && !run.blocker) {
		const report = history.findLast(r => r.squad === focus.id && r.base === gap.commit);
		if (!report || reading(report) || Object.values(run.nodes).some(n => n.review === report.id && (n.state === "published" || actionable(run, n))))
			return [focus];
	}
	if (!gap || run.policy.workers === undefined) return squads;
	const last = new Map(history.map((r, i) => [r.squad, i]));
	return squads.toSorted((a, b) => (last.get(a.id) ?? -1) - (last.get(b.id) ?? -1));
}

/** Only an available charter needs its Git version observed.
 * @param {Run} run @param {Review[]} history @param {string} squad */
export function availableHistory(run, history, squad) {
	const past = history.filter(r => r.squad === squad), last = past.at(-1);
	if (!last || !reading(last) || run.goal && last.base !== run.goal.commit) return past;
}

/** An unchanged revision needs a concrete new input, consumed once per charter.
 * @param {Run} run @param {Review[]} past Available history of this charter only. @param {string} base @param {string} version */
export function nextReview(run, past, base, version) {
	const last = past.at(-1);
	const seen = run.goal ? past.some(r => r.version === version) : last?.version === version;
	const obs = last?.state === "observed" && last.base === base ? last.observation : undefined;
	let key;
	if (last?.base === base && correction(run, last)) key = "displaced-input";
	if (obs?.outcome === "needs-decision" && last?.decision?.status === "answered") key = last.id;
	if (obs?.outcome === "needs-evidence") key = "focused-evidence";
	if (obs?.outcome === "needs-research") key = "research";
	if (obs?.outcome === "researched") key = "research-result";
	if (obs?.outcome === "waiting") {
		const producer = run.policy.squads.find(s => s.id === obs.waitFor);
		if (producer && "areas" in producer) {
			const outputs = Object.values(run.nodes).filter(n => owns(producer, n.grain.directory) && checked(n));
			if (outputs.some(n => n.candidate !== last?.packet?.outputs[n.grain.id]))
				key = digest([producer.id, Object.fromEntries(outputs.map(n => [n.grain.id, n.candidate]))]);
		}
	}
	if (key && last && !past.some(r => r.base === base && r.version === version && r.wake?.key === key))
		return { wake: { review: last.id, key } };
	if (!seen) return {};
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
		workflowId: r.workflowId, observation: r.observation, wake: r.wake, reason: r.state === "blocked" ? r.error : undefined, decision: r.decision };
}

/** Only the latest review can ask for input; historical questions remain in the reviews list.
 * @param {Run} run */
export function questions(run) {
	if (run.goal && qualifiedProduct(run)) return [];
	const latest = new Map(reviews(run).map(r => [r.squad, r]));
	return [...latest.values()].filter(r => r.state === "observed" && r.observation?.outcome === "needs-decision" && (r.observation.ownerInput || r.decision) &&
		(!run.goal || run.goal.commit === r.base && (!run.products.length || run.products.at(-1)?.commit === r.base)));
}

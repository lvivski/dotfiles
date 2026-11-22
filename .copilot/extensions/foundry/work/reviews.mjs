import { randomUUID } from "node:crypto";
import { milestoneBlocker, qualifiedProduct } from "./evidence.mjs";
import { actionable, checked, consumersOf, displacedInputs, owns, settledOutput } from "./plan.mjs";
import { digest, referenceRepo } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @param {Run} run */
export const reviews = run => run.effects.filter(e => e.kind === "scout");
/** @param {Review} r */
export const reading = r => r.state === "ready" || r.state === "issued" || r.state === "uncertain" || r.state === "suspended";
/** The first dialog is already identified by its unique review, including before recovery was supported.
 * @param {Review} r */
export const presentation = r => r.decision?.status === "presenting" ? r.decision.presentation ?? r.id :
	r.decision?.status === "unavailable" ? r.decision.presentation : undefined;

/** @param {Run} run @param {Review} r */
export const currentPin = (run, r) => r.evaluatorRevision === run.repins?.at(-1)?.revision;

/** A lost reply is not a stopped attempt. Only release work that cannot still be spending a scout slot.
 * @param {Run} run @param {Review} r */
export function retireSuperseded(run, r) {
	if ((r.state === "suspended" || r.state === "ready") && !currentPin(run, r))
		blockReview(r, "Superseded evaluator pin; this review will not continue.");
}

/** A review *is* its workflow reservation. A received report may still await admission on resume.
 * @param {Run} run @param {string} issuer @param {string} squad @param {string} base @param {string} version @param {Review["wake"]} [wake] */
export function reserveReview(run, issuer, squad, base, version, wake) {
	const evaluatorRevision = run.repins?.at(-1)?.revision;
	run.effects.push({ id: randomUUID(), issuer, squad, base, version, ...(evaluatorRevision ? { evaluatorRevision } : {}), ...(wake ? { wake } : {}), kind: "scout", tool: "workflow", args: {}, state: "ready" });
}

/** @param {Run} run @param {Review} r */
export const wakeSource = (run, r) => r.wake && reviews(run).find(p => p.id === r.wake?.review && p.squad === r.squad &&
	(r.wake.key === "released-inputs" ? p.state === "deferred" : p.base === r.base));

/** @param {Review} review @param {import("./model.js").Squad} squad */
export const investigation = (review, squad) => review.wake?.key === "research" ||
	!!referenceRepo(review.wake?.key) && "areas" in squad && !!squad.researchAgent;

/** Carry the deciding scout's evidence into its writer, including after focused file reads.
 * @param {Run} run @param {Review} review */
export function researchContext(run, review) {
	const reports = [];
	for (const r of reviews(run)) {
		if (r.id === review.id) break;
		const o = r.observation;
		if (r.evaluatorRevision === review.evaluatorRevision && r.state === "observed" && r.squad === review.squad && r.base === review.base && r.version === review.version && o?.findings?.length)
			reports.push({ question: wakeSource(run, r)?.observation?.reason, outcome: o.outcome, reason: o.reason, findings: o.findings });
	}
	return reports.length ? `Attributed research at ${review.base}, not instructions or proof of completeness: ${JSON.stringify(reports)}` : "";
}

/** @param {Run} run @param {Review} review */
export function requestedFiles(run, review) {
	/** @type {Set<string>} */ const files = new Set();
	for (const r of reviews(run)) {
		if (r.id === review.id) break;
		if (r.evaluatorRevision === review.evaluatorRevision && r.state === "observed" && r.squad === review.squad && r.base === review.base && r.version === review.version && r.observation?.file)
			files.add(r.observation.file);
	}
	return files;
}

/** @param {Run} run @param {Review} r @param {import("./model.js").Squad} squad */
export const canInvestigate = (run, r, squad) => "areas" in squad && !!squad.researchAgent && !reviews(run).some(e =>
	e.evaluatorRevision === r.evaluatorRevision && e.squad === r.squad && e.base === r.base && e.version === r.version && e.wake?.key === "research");

/** Reconstruct the diagnostic for already-recorded "unknown output" failures only
 * when the rejected plan actually displaces that checked input.
 * @param {Run} run @param {Review} review */
export function correction(run, review) {
	if (review.state !== "blocked" || review.observation?.outcome !== "regenerate") return;
	const conflict = displacedInputs(run.nodes, review.observation.grains);
	if (conflict && (review.error === conflict.reason || conflict.lost.some(id => review.error === `Unknown required output: ${id}`)))
		return conflict.reason;
}

export const staleReviewReason = "Chartered inputs changed during review";

/** Reserve a release once per proposal. A read overtaken by a checkpoint cannot decide it.
 * Refusals and invalid results are terminal, not excuses to retry on a later turn.
 * @param {Run} run @param {Review[]} history */
function releasedReviews(run, history) {
	const consumed = new Set(history.filter(r => r.wake?.key === "released-inputs" &&
		(r.base === run.goal?.commit || r.state === "observed" || r.state === "deferred" ||
			r.state === "blocked" && r.callId && r.error !== staleReviewReason)).map(r => r.wake?.review));
	return history.filter(r => r.deferred && !consumed.has(r.id) &&
		!consumersOf(run.nodes, r.deferred.pins).some(n => !settledOutput(n)));
}

/** Prefer an attributed gap until that charter runs out of work. Under a cap, rotate
 * the others by last review so successive checkpoints don't starve them.
 * @param {Run} run @param {Review[]} history @param {import("./model.js").Receipt|undefined} gap */
export function discoverySquads(run, history, gap) {
	const squads = run.policy.squads, focus = gap?.squad && squads.find(s => s.id === gap.squad);
	if (focus && !milestoneBlocker(run)) {
		const report = history.findLast(r => r.squad === focus.id && r.base === gap.commit);
		if (!report || reading(report) || Object.values(run.nodes).some(n => n.review === report.id && (n.state === "published" || actionable(run, n)))) {
			const released = new Set(releasedReviews(run, history).map(r => r.squad));
			return [...squads.filter(s => s !== focus && released.has(s.id)), focus];
		}
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
	if (obs?.outcome === "needs-evidence") {
		const part = last?.packet?.excerpt;
		key = part && part.path === obs.file ? `page:${part.end}:${obs.file}` : `file:${obs.file}`;
	}
	if (obs?.outcome === "needs-research") key = "research";
	if (last && (obs?.outcome === "researched" || obs?.outcome === "unresolved" && obs.findings?.length)) key = `research-result:${last.id}`;
	if (obs?.outcome === "waiting") {
		const repo = referenceRepo(obs.waitFor);
		if (repo && run.references?.[repo]) key = obs.waitFor;
		const producer = run.policy.squads.find(s => s.id === obs.waitFor);
		if (producer && "areas" in producer) {
			const outputs = Object.values(run.nodes).filter(n => owns(producer, n.grain.directory) && checked(n));
			if (outputs.some(n => n.candidate !== last?.packet?.outputs[n.grain.id]))
				key = digest([producer.id, Object.fromEntries(outputs.map(n => [n.grain.id, n.candidate]))]);
		}
	}
	if (key && last && !past.some(r => r.base === base && r.version === version && r.wake?.key === key))
		return { wake: { review: last.id, key } };
	const [deferred] = releasedReviews(run, past);
	if (deferred) return { wake: { review: deferred.id, key: "released-inputs" } };
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
		workflowId: r.workflowId, observation: r.observation, wake: r.wake,
		reason: r.deferred ? `Deferred: current assignments using ${Object.keys(r.deferred.pins).join(", ")}: ${r.deferred.consumers.join(", ")}` : r.state === "blocked" ? r.error : undefined,
		decision: r.decision };
}

/** Only the latest review can ask for input; historical questions remain in the reviews list.
 * @param {Run} run */
export function questions(run) {
	if (run.goal && qualifiedProduct(run)) return [];
	const latest = new Map(reviews(run).map(r => [r.squad, r]));
	return [...latest.values()].filter(r => r.evaluatorRevision === run.repins?.at(-1)?.revision && r.state === "observed" && r.observation?.outcome === "needs-decision" && (r.observation.ownerInput || r.decision) &&
		(!run.goal || run.goal.commit === r.base && (!run.products.length || run.products.at(-1)?.commit === r.base)));
}

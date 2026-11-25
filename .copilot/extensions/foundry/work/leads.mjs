import { answeredRoutes } from "./blockers.mjs";
import { checkpointReceipt, checkReceipt, currentEvaluation, goalReceipt, leadGoal, productReceiptAt, sameEvaluation } from "./evidence.mjs";
import { indexBudgetError } from "./pages.mjs";
import { owns } from "./plan.mjs";
import { outside } from "./product.mjs";
import { comparison, reading } from "./reviews.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @typedef {import("./model.js").Product} Product */

/** Only a contiguous stretch of missing observations can carry a prior failure forward.
 * Another verdict, an unverified check, or an unrelated target ends the search.
 * @param {Run} run @param {string} goal @param {Product} product */
function previousFailure(run, goal, product) {
	const at = run.effects.findIndex(e => e.id === goal);
	for (let i = at - 1; i >= 0; i--) {
		const e = run.effects[i];
		if (e.kind !== "goal") continue;
		const r = checkReceipt(e);
		if (!r || e.productEvaluatorRevision !== run.effects[at].productEvaluatorRevision || e.check !== run.policy.goalCheck || r.commit !== product.target &&
			!run.products.some(p => p.commit === r.commit && p.target === product.target)) break;
		if (r.exit === 2) continue;
		if (r.exit === 1 && (r.output.trim() || r.squad || r.blockers?.length || run.attributions?.some(a => a.receipt === e.id))) return e;
		break;
	}
}

/** @param {Run} run @param {import("./model.js").Receipt} receipt @param {string} id */
function routing(run, receipt, id) {
	const dirs = [...receipt.blockers ?? [], ...run.attributions?.filter(a => a.receipt === id) ?? []]
		.flatMap(s => "blocked" in s ? [s.directory] : []);
	return { directed: !!receipt.squad || dirs.length > 0, owners: new Set(run.policy.squads.filter(s =>
		s.id === receipt.squad || "areas" in s && dirs.some(d => owns(s, d))).map(s => s.id)) };
}

/** An older question justifies a new inspection, not a write. A packet refusal is not a no-gap verdict.
 * @param {Run} run @param {Review|undefined} r @param {import("./model.js").Area} squad @param {string} target */
function openQuestion(run, r, squad, target) {
	return r && r.squad === squad.id && (r.base === target || run.products.some(p => p.commit === r.base && p.target === target)) &&
		(r.state === "blocked" && !r.observation && r.error === indexBudgetError || r.state === "observed" &&
		r.observation?.outcome === "unresolved" && r.observation.evidence.some(file => owns(squad, file)));
}

/** @param {Run} run @param {import("./model.js").DiscoveryLead} lead @param {Review} review @param {import("./model.js").Area} squad */
export function validLead(run, lead, review, squad) {
	const p = run.products.find(p => p.check === lead.checkpoint && p.commit === review.base);
	const goal = leadGoal(lead);
	if (!goal) return false;
	const at = run.effects.findIndex(e => e.id === goal), e = run.effects[at], end = run.effects.indexOf(review);
	if (!p || at < 0 || at >= end || run.effects.slice(at + 1, end).some(e => e.kind === "goal") ||
		run.effects.findIndex(e => e.id === p.check) >= at || e.kind !== "goal" || e.check !== run.policy.goalCheck ||
		e.commit !== p.commit || !sameEvaluation(e,review) || (lead.pending ? !e.callId : checkReceipt(e)?.exit !== 2) ||
		!productReceiptAt(run, p.check, p.commit,review.productEvaluatorRevision)) return false;
	const old = previousFailure(run, goal, p), r = checkReceipt(old);
	if (!r || old?.id !== lead.receipt) return false;
	const route = routing(run, r, old.id);
	if (lead.priorReview) {
		const source = run.effects.slice(0, end).find(e => e.id === lead.priorReview);
		if (source?.kind !== "scout" || source.productEvaluatorRevision !== review.productEvaluatorRevision || !openQuestion(run, source, squad, p.target)) return false;
	} else if (route.directed && !route.owners.has(squad.id) || lead.pending && !route.directed) return false;
	const parent = review.retryOf ?? review.wake?.review;
	if (!parent) return true;
	const origin = run.effects.slice(at + 1, end).find(e => e.id === parent);
	return origin?.kind === "scout" && origin.squad === review.squad && origin.lead?.receipt === lead.receipt &&
		origin.lead.checkpoint === lead.checkpoint && origin.lead.missing === lead.missing &&
		origin.lead.pending === lead.pending && origin.lead.priorReview === lead.priorReview;
}

/** With an unchanged target, only joined directories can change between checkpoints.
 * An old pin without a provable directory is unknown, not unchanged.
 * @param {Run} run @param {Product} product @param {Review} review @param {import("./model.js").Area} squad */
function unchangedScope(run, product, review, squad) {
	const prior = run.products.find(p => p.check === review.lead?.checkpoint);
	if (!prior || prior.target !== product.target) return false;
	const paths = [...squad.areas, ...squad.boundary, ...review.observation?.evidence ?? []];
	const needs = review.observation?.grains.flatMap(g => typeof g === "string" ? [] : g.needs) ?? [];
	return [...new Set([...Object.keys(prior.outputs), ...Object.keys(product.outputs)])].every(id => {
		if (prior.outputs[id] === product.outputs[id]) return true;
		const node = run.nodes[id];
		return !prior.outputs[id] && node?.candidate === product.outputs[id] && !!node &&
			!needs.includes(id) && outside(node.grain.directory,paths);
	});
}

/** Leads invite a fresh inspection, never a reenactment of an old verdict. When the
 * evaluator supplies no routing metadata, the committed area charters partition the survey.
 * @param {Run} run @param {Review[]} history */
export function discoverLeads(run, history) {
	const at = run.goal, p = run.products.at(-1);
	if (!at || !p || p.commit !== at.commit || p.target !== at.target || run.join || run.conflict || run.blocker ||
		run.scheduling?.checkpointReviews === false || !checkpointReceipt(run, p.check, p.commit)) return;
	const e = run.effects.find(e => e.id === at.check);
	const pending = e?.kind === "goal" && e.state === "issued" && !!e.callId && !e.receipt && !e.permissionHold && currentEvaluation(run,e);
	if (!pending && goalReceipt(run)?.exit !== 2) return;
	const old = previousFailure(run, at.check, p), r = checkReceipt(old);
	if (!old || !r) return;
	const { directed, owners } = routing(run, r, old.id);
	if (pending && !directed) return;
	const answered = answeredRoutes(run, old.id).squads;
	/** @type {Map<string,import("./model.js").DiscoveryLead>} */
	const leads = new Map();
	for (const s of run.policy.squads) {
		if (!("areas" in s)) continue;
		const past = history.filter(h => h.squad === s.id && h.productEvaluatorRevision === e?.productEvaluatorRevision), latest = past.at(-1);
		const independent = directed && (!owners.has(s.id) || answered.has(s.id));
		if (answered.has(s.id) && latest?.lead?.receipt === old.id && !latest.lead.priorReview) continue;
		if (independent && !openQuestion(run, latest, s, p.target)) continue;
		if (latest?.base === p.commit && currentEvaluation(run,latest) &&
			(reading(latest) || latest.state === "reported" || latest.state === "deferred" ||
			latest.observation?.outcome === "needs-decision" && latest.decision?.status !== "answered")) continue;
		const last = past.findLast(h => h.lead?.receipt === old.id && currentEvaluation(run,h));
		if (last && (leadGoal(last.lead) === at.check || last.state === "observed" &&
			(last.observation?.outcome === "no-gap" || last.observation?.outcome === "regenerate") && unchangedScope(run, p, last, s))) continue;
		// A complete survey of the actual failed observation on these same bytes already disposed of this lead.
		if (past.some(h => h.base === p.commit && h.evaluatorRevision === old.evaluatorRevision && !h.lead &&
			h.state === "observed" && h.observation?.outcome === "no-gap" && h.packet?.sources?.includes(`receipt:${old.id}`) && !comparison(run, h))) continue;
		leads.set(s.id, { receipt: old.id, checkpoint: p.check, ...(pending ? { pending: at.check } : { missing: at.check }),
			...(independent && latest ? { priorReview: latest.id } : {}) });
	}
	return { leads, owners:new Set([...owners].filter(id => !answered.has(id))) };
}

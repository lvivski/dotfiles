import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { owns } from "./plan.mjs";
import { signal } from "./signals.mjs";
import { digest, fail, fields, name, record, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */

/** @param {Run} run @param {string} directory */
const charter = (run, directory) => run.policy.squads.find(s => "areas" in s ? owns(s, directory) :
	s.grains.some(id => run.nodes[id]?.grain.directory === directory))?.id;

/** @param {Run} run @param {string} actor @param {Record<string,unknown>} a */
export function attribute(run, actor, a) {
	if (actor !== run.owner) fail("foreign_run", "Only the owner can attribute historical evidence");
	const receipt = name(a.receipt, "goal receipt"), excerpt = text(a.excerpt, "verbatim excerpt");
	const s = signal({ id: a.id, directory: a.directory, blocked: a.blocked });
	const r = goalReceipt(run);
	if (!("blocked" in s) || !run.goal || run.goal.check !== receipt || r?.exit !== 1 || !r.output.includes(excerpt) || !charter(run, s.directory))
		fail("invalid_receipt", "Need the current unmet goal, a verbatim diagnostic and one chartered directory");
	const value = { receipt, excerpt, ...s }, old = run.attributions?.find(b => b.receipt === receipt && b.id === s.id);
	if (old && digest(old) === digest(value)) return false;
	if (old || r.blockers?.some(b => b.id === s.id)) fail("conflicting_attribution", "This step already has an attribution on that receipt");
	(run.attributions ??= []).push(value);
	delete run.goal.stall;
	return true;
}

/** @param {Run} run @param {string} receipt */
function failures(run, receipt) {
	const e = run.effects.find(e => e.kind === "goal" && e.id === receipt), r = checkReceipt(e);
	if (!e || r?.exit !== 1) return [];
	const rows = [...r.blockers ?? [], ...run.attributions?.filter(v => v.receipt === receipt) ?? []];
	return rows.flatMap(s => "blocked" in s ? [{ id: s.id, directory: s.directory, blocked: s.blocked, affected: s.blocked + 1,
		receipt, commit: r.commit, squad: charter(run, s.directory), detail: digest([receipt, s.id, s.directory, s.blocked]),
		excerpt: "excerpt" in s ? s.excerpt : undefined }] : []);
}

/** @param {Run} run */
export const currentFailures = run => run.goal && goalReceipt(run)?.exit === 1 ? failures(run, run.goal.check) : [];
/** @typedef {ReturnType<typeof failures>[number]} Gap */
/** @param {Gap} g @param {Review} r */
export const delivered = (g, r) => r.squad === g.squad && r.base === g.commit && r.packet?.sources?.includes(`detail:${g.detail}`);

/** A later decoder must be able to prove the original scope even after another goal was issued.
 * @param {Run} run @param {Review} r @param {import("./model.js").Observation|undefined} o */
export function repairDirectory(run, r, o) {
	const proposed = o?.grains[0];
	if (o?.outcome !== "regenerate" || o.grains.length !== 1 || typeof proposed !== "object" || !o.addresses?.length) return;
	const idx = run.effects.indexOf(r);
	const checked = run.effects.slice(0, idx).findLast(e => e.kind === "goal" && e.commit === r.base && e.evaluatorRevision === r.evaluatorRevision);
	if (checked && failures(run, checked.id).some(g => g.directory === proposed.directory && delivered(g, r) &&
		o.addresses?.some(a => !a.worker && a.id === g.id && a.grain === proposed.id))) return proposed.directory;
}

/** @param {unknown} value @returns {NonNullable<import("./model.js").Observation["addresses"]>} */
export function addresses(value) {
	if (!Array.isArray(value) || !value.length) fail("invalid_blocker", "Expected explicit blocker-to-grain links");
	const links = value.map(item => {
		const a = record(item); fields(a, ["id", "grain", "worker"]);
		return { id: name(a.id, "blocker"), grain: name(a.grain, "repair grain"), ...(a.worker === undefined ? {} : { worker: text(a.worker, "bound writer") }) };
	});
	if (new Set(links.map(l => l.id)).size !== links.length) fail("invalid_blocker", "Only one owner per blocker");
	return links;
}

/** @param {Run} run @param {Review} review @param {import("./model.js").Observation} observation @param {Run["nodes"]} planned */
export function checkLinks(run, review, observation, planned) {
	if (!observation.addresses) return;
	const gaps = currentFailures(run);
	for (const link of observation.addresses) {
		const g = gaps.find(g => g.id === link.id && delivered(g, review)), n = planned[link.grain];
		const fresh = !link.worker && observation.outcome === "regenerate" && observation.grains.some(x => (typeof x === "string" ? x : x.id) === link.grain);
		const bound = !!link.worker && n === run.nodes[link.grain] && n?.worker === link.worker && ["writing", "checking"].includes(n.state);
		if (!g || g.directory !== n?.grain.directory || !(fresh || bound))
			fail("invalid_blocker", "Link only delivered current blockers to their proposed repair or an explicitly bound writer in that directory");
	}
}

/** @param {Run["nodes"]} nodes @param {Gap} g @param {Review[]} reviews @param {number} remaining */
function ownership(nodes, g, reviews, remaining) {
	const seen = reviews.filter(r => delivered(g, r)), last = seen.at(-1);
	for (const r of seen.toReversed()) {
		const link = r.state === "observed" && r.observation?.addresses?.find(a => a.id === g.id);
		const n = link && nodes[link.grain];
		if (link && n && n.grain.directory === g.directory && (link.worker ? n.worker === link.worker : n.review === r.id) &&
			n.state !== "blocked" && n.state !== "idle" && n.state !== "repeated") {
			return { state: n.state === "waiting" || n.state === "writing" && !n.worker ? "reserved" :
				n.state === "writing" || n.state === "checking" ? "assigned" : "awaiting-verification", grain: link.grain, worker: n.worker, review: r.id };
		}
	}
	const reviewing = reviews.findLast(r => r.squad === g.squad && r.base === g.commit);
	const reading = reviewing && ["ready", "issued", "uncertain", "reported", "suspended", "deferred"].includes(reviewing.state);
	return { state: reading ? "in-review" : last || !g.squad || reviewing || !remaining ? "unowned" : "awaiting-review",
		review: last?.id ?? reviewing?.id, grain: undefined, worker: undefined };
}

/** @param {Run} run @param {number} remaining */
export function unownedBlockers(run, remaining) {
	const gaps = currentFailures(run);
	if (!gaps.length) return [];
	const history = run.effects.filter(e => e.kind === "scout").filter(r => r.evaluatorRevision === run.repins?.at(-1)?.revision);
	return gaps.map(g => ({ ...g, ...ownership(run.nodes, g, history, remaining) })).filter(g => g.state === "unowned");
}

/** One ledger projection: neither a writer nor a later omitted step is evidence of a fix.
 * @param {Run} run @param {number} remaining */
export function sharedBlockers(run, remaining) {
	const pin = run.repins?.at(-1)?.revision;
	/** @type {Map<string,Gap & {verifiedAt?:string, verifiedReceipt?:string}>} */ const latest = new Map();
	const reviews = run.effects.filter(e => e.kind === "scout").filter(r => r.evaluatorRevision === pin);
	for (const e of run.effects) {
		if (e.kind !== "goal" || e.check !== run.policy.goalCheck || e.evaluatorRevision !== pin) continue;
		const r = checkReceipt(e);
		if (!r || r.exit !== 0 && r.exit !== 1) continue;
		if (r.blockers?.some(s => "blocked" in s) || run.attributions?.some(s => s.receipt === e.id))
			for (const g of failures(run, e.id)) latest.set(JSON.stringify([g.id,g.directory]), g);
		for (const s of r.blockers ?? []) {
			const g = latest.get(JSON.stringify([s.id,s.directory]));
			if (g && "passed" in s) { g.verifiedAt = r.commit; g.verifiedReceipt = e.id; }
		}
	}
	return [...latest.values()].map(g => {
		const claim = ownership(run.nodes, g, reviews, remaining);
		return { ...g, ...claim, state: g.verifiedAt ? "verified" : run.goal?.check !== g.receipt ? "awaiting-verification" : claim.state };
	}).sort((a,b) => b.blocked - a.blocked);
}

import { randomUUID } from "node:crypto";
import { answeredLead, currentFailures, delivered, repairDirectory } from "./blockers.mjs";
import { workerLimit } from "./policy.mjs";
import { comparisonGoal, currentEvaluation, leadGoal, milestoneBlocker, productPin, qualifiedProduct, repairDetail, sameEvaluation } from "./evidence.mjs";
import { attachedNotes, noteId } from "./notes.mjs";
import { actionable, checked, consumersOf, displacedInputs, owns, settledOutput, stoppedHandoff } from "./plan.mjs";
import { comparisonScope, digest, fail, referenceRepo } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Review} Review */
/** @param {Run} run */
export const reviews = run => run.effects.filter(e => e.kind === "scout");
export const staleReaderMessage = "The installed Foundry reader changed. Reload Foundry in this session, then check the original assignment's status. Do not restart the run.";
/** Only the bound workflow's terminal envelope, not a scout's report or an unconfirmed exception.
 * Keep the original receipt recognizable on installations that already recorded it.
 * @param {Review} r */
export const readerInterrupted = r => r.state === "blocked" && !!r.workflowId && !!r.callId && !r.observation && !r.packet &&
	!r.retryOf && r.error === `Discovery error: Request workflow.execute failed with message: ${staleReaderMessage}`;
/** A retry has its own workflow and packet, but its routing evidence belongs to the original.
 * @param {Run} run @param {Review} review */
function evidenceOrigin(run, review) {
	if (!review.retryOf) return review;
	const original = run.effects.find(e => e.id === review.retryOf);
	if (original?.kind !== "scout" || original.retryOf || run.effects.indexOf(original) >= run.effects.indexOf(review))
		fail("corrupt_run", "Missing original scout review");
	return original;
}
/** @param {Review} r */
export const reading = r => r.state === "ready" || r.state === "issued" || r.state === "uncertain" || r.state === "suspended";
/** The first dialog is already identified by its unique review, including before recovery was supported.
 * @param {Review} r */
export const presentation = r => r.decision?.status === "presenting" ? r.decision.presentation ?? r.id :
	r.decision?.status === "unavailable" ? r.decision.presentation : undefined;

/** @param {Run} run @param {Review} r */
export const currentPin = (run, r) => currentEvaluation(run,r);

/** A lost reply is not a stopped attempt. Only release work that cannot still be spending a scout slot.
 * @param {Run} run @param {Review} r */
export function retireSuperseded(run, r) {
	if ((r.state === "suspended" || r.state === "ready") && !currentPin(run, r))
		blockReview(r, "Superseded evaluator pin; this review will not continue.");
}

/** A review *is* its workflow reservation. A received report may still await admission on resume.
 * @param {Run} run @param {string} issuer @param {string} squad @param {string} base @param {string} version @param {Review["wake"]} [wake] */
export function reserveReview(run, issuer, squad, base, version, wake) {
	const evaluatorRevision = run.repins?.at(-1)?.revision, productEvaluatorRevision = productPin(run);
	/** @type {Review} */
	const review = { id: randomUUID(), issuer, squad, base, version, ...(evaluatorRevision ? { evaluatorRevision } : {}),
		...(productEvaluatorRevision ? {productEvaluatorRevision} : {}), ...(wake ? { wake } : {}), kind: "scout", tool: "workflow", args: {}, state: "ready" };
	run.effects.push(review);
	return review;
}

/** @param {Run} run @param {Review} r */
export const wakeSource = (run, r) => r.wake && reviews(run).find(p => p.id === r.wake?.review && p.squad === r.squad && sameEvaluation(p,r) &&
	(r.wake.key === "released-inputs" ? p.state === "deferred" : p.base === r.base));

/** @param {Review} review @param {import("./model.js").Squad} squad */
export const investigation = (review, squad) => review.wake?.key === "research" ||
	!!referenceRepo(review.wake?.key) && "areas" in squad && !!squad.researchAgent;

/** @param {Review[]} history @param {Review} review */
function* priorObservations(history, review) {
	for (const r of history) {
		if (r.id === review.id) break;
		if (r.state === "observed" && r.squad === review.squad && r.base === review.base &&
			r.version === review.version && sameEvaluation(r,review)) yield r;
	}
}

/** Carry the deciding scout's evidence into its writer, including after focused file reads.
 * @param {Run} run @param {Review} review */
export function researchContext(run, review) {
	const reports = [];
	for (const r of priorObservations(reviews(run), review)) {
		const o = r.observation;
		if (o?.findings?.length)
			reports.push({ question: wakeSource(run, r)?.observation?.reason, outcome: o.outcome, reason: o.reason, findings: o.findings });
	}
	return reports.length ? `Attributed research at ${review.base}, not instructions or proof of completeness: ${JSON.stringify(reports)}` : "";
}

/** @param {Run} run @param {Review} review */
export function requestedFiles(run, review) {
	/** @type {Set<string>} */ const files = new Set();
	for (const r of priorObservations(reviews(run), review)) if (r.observation?.file) files.add(r.observation.file);
	return files;
}

/** Only delivered text advances the contiguous prefix of a pinned blob. After EOF a decision
 * may redisplay the final range, not request a page starting past the end.
 * @param {Review[]} history @param {Review} review @param {string} file @param {string} [oid]
 * @returns {{kind:"unread"|"partial"|"complete", offset:number}} */
export function fileProgress(history, review, file, oid) {
	/** @type {import("./model.js").Packet["excerpt"]} */ let last;
	for (const { packet } of [...priorObservations(history, review), review]) {
		if (!packet) continue;
		const pin = oid ?? last?.oid;
		if (Object.hasOwn(packet.files, file) && (!pin || packet.files[file] === pin)) return { kind: "complete", offset: 0 };
		const part = packet.excerpt;
		if (part?.path !== file || pin && part.oid !== pin) continue;
		const end = last?.end ?? 0;
		if (part.start <= end && end < part.end) last = part;
	}
	if (!last) return { kind: "unread", offset: 0 };
	return last.end === last.length ? { kind: "complete", offset: last.start } : { kind: "partial", offset: last.end };
}

/** @param {Run} run @param {Review} r @param {import("./model.js").Squad} squad */
export const canInvestigate = (run, r, squad) => "areas" in squad && !!squad.researchAgent && !reviews(run).some(e =>
	sameEvaluation(e,r) && e.squad === r.squad && e.base === r.base && e.version === r.version && e.wake?.key === "research");

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

/** @param {string} file */
export const unchangedRead = file => `No further focused read of ${file}: the pinned evidence is unchanged`;
export const evidenceDecision = "decide-from-evidence";

/** @param {import("./model.js").Observation|undefined} o */
export const readSource = o => o?.file ? `file:${o.file}` : o?.receipt ? `receipt:${o.receipt}` : o?.detail ? `detail:${o.detail}` : undefined;
/** Never store or echo a potentially large literal in the dispatch key.
 * @param {import("./model.js").Observation} o */
export const readKey = o => `read:${digest([readSource(o), o.match ?? null, o.offset ?? 0])}`;

/** Resume an implicit receipt/detail read at the first unseen unit, even after another source.
 * Explicit offsets and literal searches retain their own no-progress guards.
 * @param {Review[]} history @param {Review} review @param {import("./model.js").Observation} o */
export function contextProgress(history, review, o) {
	const source = readSource(o);
	if (!source || o.file || o.match || o.offset !== undefined) return;
	let end = 0, last = 0, length = 0;
	const pages = [...priorObservations(history, review), review].flatMap(r => {
		const p = r.packet?.read;
		return p?.source === source && !p.miss ? [p] : [];
	}).sort((a,b) => a.start - b.start);
	for (const p of pages) if (p.start <= end && end < p.end) { last = p.start; end = p.end; length = p.length; }
	if (end) return end === length ? {kind:"complete", offset:last} : {kind:"partial", offset:end};
}

/** Notes travel only along their own same-input evidence request chain, not to a later
 * checkpoint, another squad or an investigation. Never look up an arbitrary receipt by ID.
 * @param {Run} run @param {Review} review */
export function scopedNotes(run, review) {
	/** @param {Review} r */
	const inputs = r => {
		r = evidenceOrigin(run, r);
		const i = r.iteration;
		const lead = r.lead, source = lead?.priorReview && run.effects.find(e => e.id === lead.priorReview);
		const question = source && source.kind === "scout"
			? `Review ${source.id} left this charter open: ${source.observation?.reason ?? source.error}. The other charter's blocker is not evidence against this area. Investigate your charter's open question and cite delivered files in its own area for any repair.`
			: "Investigate the earlier failure against this charter's current files; do not assume it persists.";
		return [...attachedNotes(r), ...(lead ? [{receipt:lead.receipt, question:`Automatic follow-up on checkpoint ${lead.checkpoint}. Goal ${leadGoal(lead)} ${lead.pending ? "was pending when this investigation started" : "lacks release evidence"}. ${question} Propose disjoint repairs supported by this product with already checked inputs, or report that none are supported. Do not repeat release verification.`}] : []),
			...(i?.historical ? [{ receipt:i.historical.receipt, question:`Compare the earlier observation of ${i.historical.step} with the current incomplete receipt. Do not propose a repair unless the delivered product evidence supports it and the newer observations do not contradict it.` }] : []),
			...(i && !i.basis ? [{ receipt: i.receipt,
			question: `Owner comparison for ${i.directory}, offered blob ${i.blob}: ${i.question}. Consider an in-scope implementation, not another audit of the same evidence.` }] : [])];
	};
	const notes = new Map(inputs(review).map(n => [noteId(n), n]));
	let child = review;
	for (let i = run.effects.indexOf(review) - 1; i >= 0 && child.wake; i--) {
		const r = run.effects[i];
		if (r.id !== child.wake.review) continue;
		if (r.kind !== "scout" || r.squad !== review.squad || r.base !== review.base || r.version !== review.version ||
			!sameEvaluation(r,review) || r.observation?.outcome !== "needs-evidence" ||
			!(r.state === "observed" || r.state === "blocked" && child.wake.key === evidenceDecision)) break;
		for (const n of inputs(r)) notes.set(noteId(n), n);
		child = r;
	}
	return notes;
}

/** Evidence pages continue the same comparison, but an ordinary later review does not.
 * @param {Run} run @param {Review|undefined} review */
function comparisonReview(run, review) {
	let r = review && evidenceOrigin(run, review);
	while (r && !r.iteration && r.wake) {
		const prev = wakeSource(run, r);
		if (!prev || prev.observation?.outcome !== "needs-evidence" || prev.base !== r.base ||
			prev.version !== r.version || !sameEvaluation(prev,r) || run.effects.indexOf(prev) >= run.effects.indexOf(r)) return;
		r = evidenceOrigin(run, prev);
	}
	return r?.iteration ? r : undefined;
}

/** @param {Run} run @param {Review|undefined} review */
export const comparison = (run, review) => comparisonReview(run, review)?.iteration;

/** Only immutable review evidence determines same-checkpoint handoff scope.
 * @param {Run} run @param {Review} review @param {import("./model.js").Observation} report */
export function successorDirectory(run, review, report) {
	const iteration = comparison(run, review);
	if (review.retryOf) return iteration && comparisonScope(iteration);
	if (!iteration && report.replace?.length === 1) {
		const id = report.replace[0], n = review.predecessor ?? run.nodes[id], detail = n && repairDetail(n);
		if (detail && n.grain.id === id && review.packet?.sources?.includes(`detail:${detail}`)) return n.grain.directory;
	}
	return iteration ? comparisonScope(iteration) : repairDirectory(run, review, report);
}

/** @param {Run} run @param {Review} r @param {import("./model.js").Observation} report */
export const reviewHandoff = (run, r, report) => stoppedHandoff(run, r, report, successorDirectory(run, r, report));

/** @param {Review[]} history @param {Review} review @param {import("./model.js").Observation} o */
export function canContinueRead(history, review, o) {
	const source = readSource(o), offset = o.offset;
	if (offset === undefined || offset === 0) return true;
	for (const r of [...priorObservations(history, review), review]) {
		const read = r.packet?.read;
		if (read?.source === source && read && !read.miss && offset < read.length &&
			(offset === read.end || o.match && read.hit !== undefined && offset === read.hit + 1)) return true;
	}
	return false;
}

/** Another spelling of a query is not progress if it yields neither new text nor a later hit.
 * @param {Review[]} history @param {Review} review */
export function exhaustedRead(history, review) {
	const read = review.packet?.read;
	if (!read || read.miss) return !!read;
	if (!review.wake) return false; // An approved opening excerpt is not a repeated scout request.
	let end = read.start, furthestHit = -1;
	const earlier = [...priorObservations(history, review)].flatMap(r => r.packet?.read?.source === read.source ? [r.packet.read] : []);
	for (const p of earlier.sort((a, b) => a.start - b.start)) {
		if (read.hit !== undefined && read.hit === p.hit) return true;
		if (p.start <= end) end = Math.max(end, p.end);
		furthestHit = Math.max(furthestHit, p.hit ?? -1);
	}
	return end >= read.end && (read.hit === undefined || read.hit <= furthestHit);
}

/** @param {Review[]} past @param {Review} last */
export function rejectedRead(past, last) {
	const o = last.observation;
	if (last.state !== "blocked" || o?.outcome !== "needs-evidence") return;
	if (o.file && last.error === unchangedRead(o.file)) return fileProgress(past, last, o.file);
	const source = readSource(o);
	if (source && last.packet?.sources?.includes(source) && last.error === "Repeated read of unchanged pinned evidence")
		return contextProgress(past, last, o);
}

/** Reserve a release once per proposal. A read overtaken by a checkpoint cannot decide it.
 * Refusals and invalid results are terminal, not excuses to retry on a later turn.
 * @param {Run} run @param {Review[]} history */
export function releasedReviews(run, history) {
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
	const failures = currentFailures(run);
	if (!failures.length && focus && !milestoneBlocker(run)) {
		const report = history.findLast(r => r.squad === focus.id && r.base === gap.commit);
		if (!report || reading(report) || Object.values(run.nodes).some(n => n.review === report.id && (n.state === "published" || actionable(run, n)))) {
			const released = new Set(releasedReviews(run, history).map(r => r.squad));
			return [...squads.filter(s => s !== focus && released.has(s.id)), focus];
		}
	}
	const last = new Map(gap && workerLimit(run) !== undefined ? history.map((r, i) => [r.squad, i]) : []);
	/** @type {Map<string,number>} */ const impact = new Map();
	for (const g of failures) if (g.squad && !history.some(r => delivered(g, r)))
		impact.set(g.squad, Math.max(g.blocked, impact.get(g.squad) ?? 0));
	return squads.toSorted((a, b) => (impact.get(b.id) ?? 0) - (impact.get(a.id) ?? 0) ||
		(last.get(a.id) ?? -1) - (last.get(b.id) ?? -1));
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
	if (last?.base === base && last.version === version && rejectedRead(past, last)?.kind === "complete") key = evidenceDecision;
	if (obs?.outcome === "needs-decision" && last?.decision?.status === "answered") key = last.id;
	if (last && obs?.outcome === "needs-evidence" && last.version === version) {
		if (obs.match || obs.offset !== undefined || !obs.file) key = readKey({...obs, offset:obs.offset ?? contextProgress(past, last, obs)?.offset});
		else {
			const progress = fileProgress(past, last, obs.file);
			key = progress.kind === "partial" ? `page:${progress.offset}:${obs.file}` : `file:${obs.file}`;
		}
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
	if (seen && last?.state === "observed" && last.base === base && !last.iteration &&
		(obs?.outcome === "no-gap" || obs?.outcome === "unresolved" || obs?.outcome === "regenerate")) {
		const gaps = currentFailures(run).filter(g => g.squad === last.squad && !past.some(r => delivered(g, r)));
		const key = gaps.length && `blockers:${digest(gaps.map(g => g.detail))}`;
		if (key && !past.some(r => r.base === base && r.wake?.key === key)) return { wake: { review: last.id, key } };
	}
	if (!seen && !(last?.predecessor && last.base === base && Object.values(run.nodes).some(n =>
		n.review === last.id && (actionable(run, n) || n.state === "published")))) return {};
}

/** Only continue the work admitted on this checkpoint, not an unrelated deferred review.
 * @param {Run} run @param {Review[]} past @param {string} base @param {string} version */
export function checkpointWake(run, past, base, version) {
	const r = past.at(-1), at = run.goal, checkpoint = run.products.at(-1)?.check;
	if (!r || !at || r.base !== base || !checkpoint || answeredLead(run,r)) return;
	const lead = r.lead, i = comparison(run, r), missing = comparisonGoal(i);
	if (lead ? leadGoal(lead) !== at.check || lead.checkpoint !== checkpoint :
		r.state !== "observed" || r.observation?.outcome !== "needs-evidence" || !i?.basis || i.receipt !== checkpoint ||
		missing && missing !== at.check) return;
	const wake = nextReview(run, past, base, version)?.wake;
	if (wake?.review === r.id) return { wake, lead };
}

/** @param {Review} r @param {string} reason */
export function blockReview(r, reason) {
	r.state = "blocked";
	r.error = reason;
	delete r.permissionHold;
}

/** @param {Run} run @param {Review} r */
export function reviewStatus(run, r) {
	const origin = comparisonReview(run, r);
	const approved = origin?.iteration?.source?.commit, checkpoint = run.products.at(-1)?.commit;
	const superseded = r.state === "blocked" && r.error === staleReviewReason && approved && checkpoint &&
		checkpoint === run.goal?.commit && approved !== checkpoint;
	const hold = r.state === "blocked" && r.error === "Writable directories must be disjoint" && r.observation ?
		reviewHandoff(run, r, r.observation)?.hold : undefined;
	return { id: r.id, squad: r.squad, state: reading(r) ? "reading" : r.state, base: r.base, version: r.version,
		...(r.productEvaluatorRevision ? {productEvaluatorRevision:r.productEvaluatorRevision} : {}),
		workflowId: r.workflowId, observation: r.observation, wake: r.wake, ...(r.lead ? {lead:r.lead} : {}), ...(r.retryOf ? { retryOf: r.retryOf } : {}),
		...(origin ? { iteration: origin.iteration, ...(origin !== r ? { iterationFrom: origin.id } : {}) } : {}),
		...(r.correction ? { correction: r.correction } : {}),
		...(r.note ? { note: r.note } : {}),
		...(r.otherNotes ? { otherNotes: r.otherNotes } : {}),
		...(hold ? { handoffHold: hold } : {}),
		...(r.predecessor ? { predecessor: { grain: r.predecessor.grain.id, worker: r.predecessor.worker, base: r.predecessor.base, ...(r.predecessor.preview ? { preview: r.predecessor.preview } : {}),
			check: r.predecessor.check, ...(r.predecessor.candidate ? { candidate:r.predecessor.candidate } : {}), reason: r.predecessor.reason } } : {}),
		reason: r.deferred ? `Deferred: current assignments using ${Object.keys(r.deferred.pins).join(", ")}: ${r.deferred.consumers.join(", ")}` :
			superseded ? `Source comparison approval covers ${approved}, not the current checked product ${checkpoint}. Even if the cited files are unchanged, this report cannot staff a writer there.` :
			r.state === "blocked" ? r.error : undefined,
		decision: r.decision };
}

/** Only the latest review can ask for input; historical questions remain in the reviews list.
 * @param {Run} run */
export function questions(run) {
	if (run.goal && qualifiedProduct(run)) return [];
	const latest = new Map(reviews(run).map(r => [r.squad, r]));
	return [...latest.values()].filter(r => currentEvaluation(run,r) && r.state === "observed" && r.observation?.outcome === "needs-decision" && (r.observation.ownerInput || r.decision) &&
		(!run.goal || run.goal.commit === r.base && (!run.products.length || run.products.at(-1)?.commit === r.base)));
}

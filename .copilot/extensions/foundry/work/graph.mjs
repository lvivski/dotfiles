import { randomUUID } from "node:crypto";
import { assign, componentOutcome } from "./assignment.mjs";
import { transition } from "./machine.mjs";
import { executor } from "./adapter.mjs";
import { scheduling } from "./scheduling.mjs";
import { journal, producersDeclared, survey } from "./dispatch.mjs";
import { decide } from "./dialog.mjs";
import { isUtf8 } from "node:buffer";
import { admissionPolicy } from "./admission.mjs";
import { activeDelivery } from "./batch.mjs";
import { advanceDelivery } from "./delivery.mjs";
import { notifyWriters, takeArtifactBrief } from "./artifacts.mjs";
import { addresses, answeredLead, checkLinks, unownedBlockers } from "./blockers.mjs";
import { validOutcome } from "./contract.mjs";
import { evidenceDecision, exhaustedRead, readSource, readWake, rejectedRead, validateRead } from "./cursor.mjs";
import { checkReceipt, comparisonGoal, comparisonVerdict, currentEvaluation, exhaustedCandidate, goalReceipt, leadGoal, milestoneBlocker, omittedStep, productPin } from "./evidence.mjs";
import { checkpointCurrent, continuingRepair, pendingGoal, retainedRepair } from "./facts.mjs";
import { decisionOf, release } from "./engine.mjs";
import { discoverLeads } from "./leads.mjs";
import { applyGoal, assess, checkpointSurvey, movingSurvey, observeTarget, qualify, rejectRepeat, stall, timelyChecks } from "./goal.mjs";
import { availableReservations, remainingAssignments } from "./capacity.mjs";
import { admitted, expired, reserveNotice, reserveProduct, reserveWorker } from "./native.mjs";
import { awaitingReply } from "./reservation.mjs";
import { workerLimit } from "./policy.mjs";
import { finishWriters } from "./pool.mjs";
import { partitionConflict } from "./partition.mjs";
import { settleProduction } from "./production.mjs";
import { remedyWriter } from "./remedy.mjs";
import { validIsolation } from "./isolation.mjs";
import { deliveredFile, rejectedSource, unseenText, validMatch } from "./pages.mjs";
import { actionable, consumersOf, dependencies, liveNeeds, owns, productOutputs, proposal, queuedWriters, requireNewWork, revise, settledOutput, stalePins, superseded, supersededAttempt, unstartedWriter, validateNodes, waiting, writerInputs } from "./plan.mjs";
import { changedFiles, checkDirectory, combine, commitAt, committedFile, describeInventory, inventory, outside, regularFiles, rejoin, retain, treeOf, verifyContracts, verifyDirectoryPin, versionOf, withoutGrain } from "./product.mjs";
import { referenceCheckout } from "./research.mjs";
import { renew, renewalBasis } from "./renewal.mjs";
import { ownershipMode, preflightTransfer, protectsGrant, touchesCut } from "./transfer.mjs";
import { disjointSuccessor, heldRepair, matchesSuccessor, preflightSuccessor, successorReads } from "./successor.mjs";
import { atCheckpoint, availableHistory, blockReview, canInvestigate, checkpointScope, checkpointWake, comparison, discoverySquads, inputArrivals, nextReview, readerInterrupted, reading, requestedFiles, researchContext, reserveReview, reviewHandoff, reviews, scopedNotes, staleReviewReason, wakeSource } from "./reviews.mjs";
import { FoundryError, comparisonScope, contains, covers, digest, fail, fields, integer, members, mixed, name, names, ownership, record, referenceRepo, relative, sameScope, scopeLabel, text, waitTarget, roots as scopePaths } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Policy} Policy */
/** Consumers record transitive inputs, so one pass retires every assignment built on this version.
 * @param {Run} run @param {string} id @param {string|undefined} version */
function invalidateConsumers(run, id, version) {
	if (!version) return;
	const children=consumersOf(run.nodes,{[id]:version});
	const ids=new Set(children.map(c=>c.grain.id));
	if (Object.values(run.nodes).some(n=>protectsGrant(n,ids)))
		fail("ownership_transition","Cannot invalidate an approved ownership pair via its former inputs");
	for (const child of children)
		run.nodes[child.grain.id] = waiting(child.grain, child.review, child.repairs);
}

/** @param {Run} run @param {string[]} roots @param {string} [review] */
function request(run, roots, review) {
	const fresh = new Set([...dependencies(run.nodes, roots)].filter(id => run.nodes[id].state === "idle" || settledOutput(run.nodes[id]) && roots.includes(id)));
	for (const id of superseded(run.nodes, fresh)) {
		const n = run.nodes[id];
		run.nodes[id] = fresh.has(id) ? waiting(n.grain, review) : waiting(n.grain, n.review, n.repairs);
		if (!run.join) delete run.blocker;
	}
}

/** @param {string} cwd @param {Policy} policy @param {string} owner @param {import("./model.js").Grain[]} grains @returns {Run} */
export function newRun(cwd, policy, owner, grains) {
	/** @type {Run} */
	const run = { id: policy.id, owner, policy, active: true, activatedAt: Date.now(), effects: [], nodes: {}, products: [] };
	for (const g of grains) run.nodes[g.id] = { grain: g, repairs: 0, state: "idle" };
	if (policy.goalCheck) {
		const target = commitAt(cwd, policy.target);
		assess(cwd, run, owner, target, target);
	} else if (policy.seed)
		request(run, policy.seed);
	return run;
}

/** @param {string} cwd @param {Run} run @param {Node} n @param {string} commit */
function changedExclusion(cwd,run,n,commit) {
	const input=n.excluded;
	if (!input) return false;
	if ("path" in input) return changedFiles(cwd,input.revision,commit,[input.path]).length > 0;
	const checkpoint=run.products.at(-1);
	return checkpoint?.commit === commit && checkpoint.outputs[input.grain] !== input.revision && (!!checkpoint.outputs[input.grain] || commit !== n.base);
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Squad} squad @param {string} commit */
function reviewVersion(cwd, run, squad, commit) {
	if (run.goal) {
		if (!("areas" in squad)) return commit;
		const stopped = Object.values(run.nodes).filter(n => owns(squad, n.grain.directory) && (n.state === "repeated" || n.state === "blocked") &&
			(!n.excluded || changedExclusion(cwd,run,n,commit)));
		// Reproducing the combined failing tree is new evidence even for a charter that previously found no gap.
		return digest([commit, run.goal.tried ?? [], stopped.map(n => {
			const retired = supersededAttempt(run, n);
			return [n.grain.id, n.state, n.reason ?? n.candidate, ...(retired ? [retired] : [])];
		})]);
	}
	if (!("grains" in squad)) fail("invalid_goal", "Area charters need an assessed revision");
	const ids = dependencies(run.nodes, squad.grains);
	return versionOf(cwd, commit, [squad.charter, ...[...ids].flatMap(id => scopePaths(run.nodes[id].grain.directory))]);
}

/** @param {import("./model.js").Squad} squad @param {unknown} raw @returns {import("./model.js").Observation} */
export function parseObservation(squad, raw, classifyPrior=false) {
	const input = record(raw);
	fields(input, ["outcome", "reason", "evidence", "grains", "replace", "waitFor", "file", "receipt", "detail", "match", "offset", "ownerInput", "addresses"]);
	if (!Array.isArray(input.grains)) fail("invalid_field", "Expected a list of grains");
	const grains = input.grains.map(v => "areas" in squad && typeof v !== "string" ? proposal(v) : name(v, "grain"));
	if (classifyPrior && grains.some(g=>typeof g!=="string" && !g.prior))
		fail("missing_input","Classify each proposed writer's prior-directory prerequisite before staffing");
	names(grains.map(g => typeof g === "string" ? g : g.id), "grain");
	const outcome = input.outcome;
	if (outcome === "researched" || outcome === "needs-research" && !("areas" in squad && squad.researchAgent))
		fail("invalid_research", "Only an opted-in charter can request an investigation; only its researcher may answer");
	if (!validOutcome(outcome, grains.length))
		fail("invalid_outcome", "Expected regenerate with owned grains, or a non-writing outcome with an empty list");
	const ownerInput = input.ownerInput;
	if (ownerInput !== undefined && (outcome !== "needs-decision" || ownerInput !== "product-choice" && ownerInput !== "external-action"))
		fail("invalid_outcome", "Only a decision requiring a product choice or external action may ask the owner");
	if (outcome === "waiting" ? !("areas" in squad) || input.waitFor === undefined : input.waitFor !== undefined)
		fail("invalid_outcome", "Only a waiting area charter names a producer in waitFor");
	if ([input.file, input.receipt, input.detail].filter(v => v !== undefined).length !== Number(outcome === "needs-evidence") ||
		input.offset !== undefined && outcome !== "needs-evidence") fail("invalid_outcome", "Only needs-evidence selects exactly one file, receipt or detail");
	const match = input.match;
	if (match !== undefined && (outcome !== "needs-evidence" || !validMatch(match)))
		fail("invalid_outcome", "Use match only with needs-evidence: one nonempty Unicode literal");
	const replace = names(input.replace === undefined ? [] : input.replace, "pending grain");
	if (replace.length && (outcome !== "regenerate" || !("areas" in squad))) fail("invalid_outcome", "Only area regeneration can split pending work");
	if (!Array.isArray(input.evidence) || !input.evidence.length)
		fail("no_evidence", "Identify committed evidence for the observation");
	const evidence = input.evidence.map(relative);
	return { outcome, ...(ownerInput ? { ownerInput } : {}), reason: text(input.reason, "observation"), evidence, grains, ...(replace.length ? { replace } : {}),
		...(input.addresses === undefined ? {} : { addresses: addresses(input.addresses) }),
		...(outcome === "waiting" ? { waitFor: waitTarget(input.waitFor) } : {}),
		...(outcome === "needs-evidence" ? { ...(input.file !== undefined ? { file: relative(input.file) } :
			input.receipt !== undefined ? { receipt: name(input.receipt, "receipt") } : { detail: name(input.detail, "detail") }),
			...(input.offset !== undefined ? { offset: integer(input.offset, 0, "UTF-16 offset") } : {}), ...(match ? { match } : {}) } : {}) };
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} review
 * @param {string} [exactTarget] For a clarification, require the exact reviewed product at this target tip, not just equivalent charter inputs. */
export function currentReview(cwd, run, review, exactTarget) {
	const squad = run.policy.squads.find(s => s.id === review.squad);
	if (!squad || reviews(run).findLast(r => r.squad === squad.id)?.id !== review.id) return false;
	const live = exactTarget ?? commitAt(cwd, run.policy.target);
	const target = !exactTarget && checkpointSurvey(run,review) ? movingSurvey(cwd,run,live)?.target ?? live : live;
	if (run.goal) {
		if (!currentEvaluation(run,review) || run.goal.commit !== review.base || run.goal.target !== target) return false;
		if (review.lead) return leadGoal(review.lead) === run.goal.check && checkpointCurrent(run, review.lead.checkpoint, target) &&
			(review.lead.pending ? pendingGoal(run) || [0, 1, 2].includes(goalReceipt(run)?.exit ?? -1) : goalReceipt(run)?.exit === 2);
		const i = comparison(run, review);
		const missing = comparisonGoal(i);
		if (i && missing) return missing === run.goal.check && checkpointCurrent(run, i.receipt, target) && comparisonVerdict(goalReceipt(run)?.exit,i.successor);
		if (i?.basis) return checkpointCurrent(run, i.receipt, target) && (pendingGoal(run) || [0, 1, 2].some(exit => exit === goalReceipt(run)?.exit));
		return (!i || i.receipt === run.goal.check) && goalReceipt(run)?.exit === 1;
	}
	const base = productBase(cwd, run, target);
	return base === review.base || !exactTarget && reviewVersion(cwd, run, squad, base) === review.version;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} r @param {string} [target] */
export function sameReviewInputs(cwd, run, r, target = commitAt(cwd, run.policy.target)) {
	const squad = run.policy.squads.find(s => s.id === r.squad);
	verifyContracts(cwd, run.policy, target);
	if (r.retrySource && !sourceRecoveryOpen(run, comparison(run,r))) return false;
	const prior = r.retryOf ? run.effects.find(e => e.id === r.retryOf) : r;
	if (prior?.kind === "scout" && readerInterrupted(prior)) {
		const i = comparison(run, r);
		if (goalReceipt(run)?.exit === 0 || answeredLead(run, r) ||
			(r.lead || i?.basis) && run.scheduling?.checkpointReviews === false ||
			i && reservedDirectory(run, comparisonScope(i), !!i.source,i.successor?.from)) return false;
	}
	return !!squad && !run.blocker && !run.conflict && !run.join && currentReview(cwd, run, r, target) &&
		(!run.goal || !run.products.length || run.products.at(-1)?.commit === r.base) && reviewVersion(cwd, run, squad, r.base) === r.version;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string} id */
export function retryableReview(cwd, run, actor, id) {
	if (actor !== run.owner) fail("foreign_run", "Only the original run owner may request a fresh review");
	admitted(run);
	const history = reviews(run), r = history.find(r => r.id === id);
	if (!r || r.state !== "blocked" || !r.workflowId || !r.callId || r.retryOf)
		fail("not_recoverable", "Expected an original blocked review");
	let sourceBlob;
	if (r.observation) {
		const i = r.iteration, file = i?.source?.file;
		sourceBlob = file && regularFiles(cwd, r.base, [file])[0].oid;
		if (!sourceBlob || !rejectedSource(r, sourceBlob))
			fail("not_recoverable", "The reported review was not rejected for omission of its approved source");
		if (!sourceRecoveryOpen(run, i)) fail("dispatch_held", "Checkpoint reviews are disabled or the comparison directory is reserved");
	}
	if (!sameReviewInputs(cwd, run, r))
		fail("superseded", "No longer the current charter, evaluator and product revision");
	reviewSlot(run, actor, r.squad);
	return { prior:r, sourceBlob };
}

/** @param {Run} run @param {import("./model.js").Review["iteration"]} i */
const sourceRecoveryOpen = (run, i) => !!i && run.scheduling?.checkpointReviews !== false &&
	!reservedDirectory(run, comparisonScope(i), true,i.successor?.from);

/** @param {Run} run @param {import("./model.js").Scope} directory @param {boolean} source @param {string} [except] */
const reservedDirectory = (run, directory, source, except) => Object.values(run.nodes).find(n =>
	n.grain.id!==except && (source ? !settledOutput(n) : ["waiting", "writing", "checking", "published"].includes(n.state)) && !outside(n.grain.directory,scopePaths(directory)));

/** @param {Run} run @param {string} actor @param {string} squad */
function reviewSlot(run, actor, squad) {
	const history = reviews(run);
	if (history.some(x => reading(x) && x.squad === squad) || run.effects.some(e => e.issuer === actor && e.permissionHold))
		fail("dispatch_held", "Charter still running or owner dispatch held");
	if (!availableReservations(run))
		fail("limit", "No authorized assignment or worker slot for a new review");
}

/** A superseded refusal is a reason for a new comparison, never a verdict on a later product.
 * @param {string} cwd @param {Run} run @param {string} directory @param {string} blob @param {string} target */
function comparableOverlap(cwd, run, directory, blob, target) {
	const last = run.products.at(-1);
	if (!last || !checkpointCurrent(run,last.check,target)) return;
	const r = reviews(run).findLast(r => r.base !== last.commit && currentEvaluation(run,r) &&
		comparison(run,r)?.directory === directory);
	const i = comparison(run,r), report = r?.observation;
	if (!r || !i?.basis || i.blob !== blob || !r.workflowId || r.state !== "blocked" || r.error !== "Writable directories must be disjoint" || !report ||
		!run.products.some(p => p.commit === r.base && p.check === i.receipt && p.target === target)) return;
	const old = reviewHandoff(run,r,report)?.predecessor, [g] = report.grains;
	if (!old || !exhaustedCandidate(run,old) || typeof g !== "object") return;
	const pins = writerInputs(run.nodes,waiting({...old.grain,needs:g.needs}));
	if (!pins || Object.entries(pins).some(([id,pin]) => last.outputs[id] !== pin || r.packet?.outputs[id] !== pin) ||
		changedFiles(cwd,r.base,last.commit,[directory,...report.evidence,...Object.keys(pins).flatMap(id => scopePaths(run.nodes[id].grain.directory))]).length) return;
	return last.check;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {Pick<NonNullable<import("./model.js").Review["iteration"]>,"directory"|"files"|"receipt"|"blob"|"question"|"transfer"|"successor">} input
 * @param {import("./model.js").HistoricalStep} [prior] @param {import("./model.js").ProductCitation} [source] */
export function reserveIteration(cwd, run, actor, input, prior, source) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner can route a comparison");
	admitted(run);
	const partition=partitionConflict(run);
	if (partition && !(source && !input.transfer && disjointSuccessor(run,input.successor,comparisonScope(input),[source.file])))
		fail("ownership_transition",partition);
	if (partition && run.effects.some(e=>e.permissionHold)) fail("dispatch_held","Resolve outstanding permission holds before opening a disjoint comparison");
	const { directory, receipt, blob } = input, at = run.goal, gap = goalReceipt(run);
	const target = commitAt(cwd, run.policy.target), historical = prior && { ...prior, missing: receipt };
	const checkpoint = historical || source ? run.products.at(-1)?.check : pendingGoal(run) && checkpointCurrent(run, receipt, target) ? receipt :
		gap?.exit === 2 && at?.check === receipt ? comparableOverlap(cwd,run,directory,blob,target) : undefined;
	if (source && (historical || !at || at.check !== receipt || !comparisonVerdict(gap?.exit,input.successor) || at.commit !== source.commit || !checkpoint || !checkpointCurrent(run,checkpoint,target)))
		fail("invalid_receipt",`Need a new comparison on the exact current checked product and target, with its settled ${input.successor?"exit-1 or exit-2":"exit-2"} goal receipt; do not combine with historical evidence.`);
	if (historical && (!at || at.check !== receipt || !checkpoint || !checkpointCurrent(run, checkpoint, target) ||
		!omittedStep(run, historical, at.commit, run.repins?.at(-1)?.revision, productPin(run))))
		fail("invalid_receipt", "Need the current exit-2 receipt and the immediately preceding exit-1 observation on this checked product. Its stable step identifier must appear in the earlier output and not in the current output.");
	if (!at || !checkpoint && (at.check !== receipt || gap?.exit !== 1 || gap.commit !== at.commit) || at.target !== target ||
		run.join || run.blocker || run.conflict || run.products.length && run.products.at(-1)?.commit !== at.commit)
		fail("stale_assignment", "Use the current unmet goal receipt, or the latest passing checkpoint check ID while its goal is pending on the unchanged target");
	if (!run.artifacts?.some(a => a.blob === blob && a.to.some(dir => contains(dir, directory))))
		fail("foreign_artifact", "Comparison version was not offered to this directory");
	const squad = run.policy.squads.find(s => "areas" in s && owns(s, directory));
	if (!squad || !("areas" in squad)) fail("charter_scope", "Need a production directory owned by an area charter");
	const scope = comparisonScope(input);
	if (input.transfer && (!mixed(scope) || !source)) fail("ownership_transition","A transfer requires a source-backed mixed grant");
	if (input.successor && (input.transfer || !source || !covers(scope,source.file) || !outside(scope,run.policy.files)))
		fail("invalid_successor","A successor needs current source within the narrow grant; do not combine with a transfer or conserved paths");
	if (input.files) {
		if (!source || ownershipMode(run)==="directories")
			fail("unsupported_ownership","Exact-file grants require an opted-in product checker and a source-backed comparison");
		if (!owns(squad,scope) || !outside(scope,run.policy.files)) fail("charter_scope","Integration files must belong to the same charter and cannot touch conserved files");
		regularFiles(cwd,at.commit,input.files);
	}
	if (source) {
		if (!owns(squad,source.file))
			fail("charter_scope","Cite a production source file in the selected charter's writable areas");
		const bytes = committedFile(cwd,source.commit,source.file);
		if (bytes.includes(0) || !isUtf8(bytes) || !bytes.toString("utf8").includes(source.excerpt))
			fail("invalid_source","Cite a verbatim excerpt from a regular UTF-8 file on this checked product");
	}
	const existing = reviews(run).find(r => r.base === at.commit && currentEvaluation(run,r) &&
		r.iteration?.blob === blob && r.iteration.directory === directory && (!source || r.iteration.source?.goal === receipt))?.iteration;
	if (existing) {
		if (source && (source.file !== existing.source?.file || source.excerpt !== existing.source.excerpt || input.question !== existing.question ||
			digest(input.transfer ?? null)!==digest(existing.transfer ?? null) || digest(input.successor ?? null)!==digest(existing.successor ?? null) || !sameScope(scope,comparisonScope(existing))))
			fail("conflicting_comparison","This offered version already has a source comparison for this directory and goal; inspect the existing review.");
		return;
	}
	if (checkpoint && !historical && run.scheduling?.checkpointReviews === false)
		fail("dispatch_held", "New checkpoint comparisons are disabled by the current scheduling policy");
	if (input.successor) {
		preflightSuccessor(run,input.successor,scope,squad.id);
		checkDirectory(cwd,at.commit,directory);
		if (remainingAssignments(run)<2) fail("limit","Need budget for both a fresh review and a narrow successor");
	}
	const live = reservedDirectory(run, scope, !!source,input.successor?.from);
	if (live) fail("dispatch_held", `${scopeLabel(live.grain.directory)} is reserved by the existing assignment ${live.grain.id} (${live.state}). ` +
		`This comparison was not queued. Use the existing writer only for its assigned task and pinned inputs. ` +
		`Distinct work must wait for the directory to be released; request a fresh review on the then-current checked product.`);
	if (input.files) {
		if (input.transfer && mixed(scope)) {
			preflightTransfer(run,input.transfer,scope);
			checkDirectory(cwd,at.commit,scope.primary);
			if (changedFiles(cwd,input.transfer.candidate,at.commit,scopePaths(scope)).length)
				fail("stale_assignment","The paths to transfer no longer match the named parent version");
		}
		const conflict=Object.values(run.nodes).find(n=>n.grain.id!==(input.transfer?.from ?? input.successor?.from) && !sameScope(scope,n.grain.directory) && !outside(n.grain.directory,scopePaths(scope)));
		if (conflict) fail("ownership_transition",`The requested grant overlaps ${conflict.grain.id} (${scopeLabel(conflict.grain.directory)}). ` +
			"An exact-file comparison cannot split a retained owner's scope. Choose disjoint paths or review a separate ownership transition; no scout was started.");
	}
	const previous = reviews(run).findLast(r => r.squad === squad.id && r.base === at.commit && currentEvaluation(run,r));
	if (previous && (previous.state === "reported" || previous.state === "deferred" || previous.state === "observed" &&
		previous.observation?.outcome === "needs-decision" && previous.decision?.status !== "answered"))
		fail("dispatch_held", "The charter has an unapplied report, deferred proposal or pending decision; do not displace it.");
	reviewSlot(run, actor, squad.id);
	verifyContracts(cwd, run.policy, at.target);
	const review = reserveReview(run, actor, squad.id, at.commit, reviewVersion(cwd, run, squad, at.commit));
	review.iteration = checkpoint ? { ...input, receipt: checkpoint, basis: "checkpoint", ...(historical ? { historical } : {}), ...(source ? {source:{...source,goal:receipt}} : {}) } : input;
	delete at.stall;
	return review;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} review @param {import("./model.js").Observation} observation */
export function observe(cwd, run, review, observation) {
	admitted(run);
	const squad = run.policy.squads.find(s => s.id === review.squad) ?? fail("invalid_charter", "Missing charter");
	// An unspecialized question (including a report from an older workflow) is not an operator decision.
	const deciding = review.wake?.key === evidenceDecision || exhaustedRead(reviews(run), review);
	if (deciding && (observation.outcome === "needs-evidence" || observation.outcome === "needs-research"))
		fail("unresolved_evidence", "The decision follow-up must decide from delivered evidence or report unresolved");
	if (!observation.findings && (observation.outcome === "unresolved" || observation.outcome === "needs-decision" && !observation.ownerInput))
		observation = { ...observation, outcome: !deciding && canInvestigate(run, review, squad) ? "needs-research" : "unresolved" };
	const { outcome, grains, evidence } = observation, ids = grains.map(g => typeof g === "string" ? g : g.id);
	const i = comparison(run, review);
	const partition=outcome==="regenerate" && partitionConflict(run);
	if (partition && !(i?.source && i.successor && disjointSuccessor(run,i.successor,comparisonScope(i),successorReads(run,observation))))
		fail("ownership_transition",partition);
	if (outcome === "needs-research" && !canInvestigate(run, review, squad))
		fail("unresolved_research", "Investigation already requested on this revision; identify the remaining blocker");
	// A sibling can finish while this scout reads. On the same assessed commit, revalidate the
	// proposal against the live graph; never let an older charter review edit a newer plan.
	const renewal=review.renewal?.state==="approved" && renewalBasis(cwd,run,review,commitAt(cwd,run.policy.target));
	if (!(renewal && !renewal.reason && review.renewal?.checkpoint===renewal.checkpoint && review.renewal.goal===renewal.goal) && !currentReview(cwd, run, review)) {
		fail("stale_assignment", staleReviewReason);
	}
	if (outcome !== "no-gap" && answeredLead(run, review, grains.flatMap(g => typeof g === "string" ? [] : scopePaths(g.directory))))
		fail("superseded", "A newer goal receipt observed this historical lead's step passing; no further work from this lead");
	const replaceable = new Set(), withdrawals = [];
	for (const id of observation.replace ?? []) {
		const n = run.nodes[id];
		const launch = n && unstartedWriter(run,n);
		if (launch && !ids.includes(id)) {
			replaceable.add(id);
			withdrawals.push(launch);
			continue;
		}
		if (n?.excluded) {
			const [next] = grains;
			if (run.effects.some(e => e.grain === id && (e.permissionHold || awaitingReply(e) || e.state === "ordinary")) ||
				n.candidate && consumersOf(run.nodes,{[id]:n.candidate}).some(other => !settledOutput(other)))
				fail("frozen_assignment", `${id} still has an outstanding call or a live consumer of its checked version`);
			if (grains.length !== 1 || observation.replace?.length !== 1 || !next || typeof next === "string" || !sameScope(next.directory,n.grain.directory) ||
				next.check !== n.grain.check || run.nodes[next.id] || run.effects.some(e => e.grain === next.id) ||
				!changedExclusion(cwd,run,n,review.base))
				fail("stale_assignment", `A fresh task for ${id} needs a reviewed change to its excluded input: ${n.reason}`);
			replaceable.add(id);
			continue;
		}
		if (!n || !supersededAttempt(run, n)) continue;
		if (!remainingAssignments(run))
			fail("limit", "No assignment remains for a fresh writer on current inputs");
		const next = grains.find(g => typeof g !== "string" && sameScope(g.directory,n.grain.directory));
		if (grains.length !== 1 || observation.replace?.length !== 1 || !next || typeof next === "string" ||
			next.check !== n.grain.check || run.nodes[next.id] || run.effects.some(e => e.grain === next.id) ||
			!next.needs.length || run.join || run.blocker || run.conflict || reviewVersion(cwd, run, squad, review.base) !== review.version)
			fail("stale_assignment", `Replace only ${id} in a fresh review, with a new ID, the same directory and check, and current checked inputs`);
		const inputs = writerInputs(run.nodes, waiting({ ...n.grain, needs: next.needs }));
		if (!inputs || !Object.entries(inputs).every(([dep, pin]) => run.nodes[dep].state === "qualified" && review.packet?.outputs[dep] === pin) ||
			!Object.entries(inputs).some(([dep, pin]) => n.inputs?.[dep] !== pin) ||
			Object.entries(n.inputs ?? {}).some(([dep, pin]) => run.nodes[dep]?.candidate === pin && inputs[dep] !== pin))
			fail("stale_assignment", `Replacement of ${id} must name newly checked inputs and retain the writer's still-current pins`);
		replaceable.add(id);
	}
	if (grains.some(g => {
		const scope=typeof g==="string" ? run.nodes[g]?.grain.directory : g.directory;
		return scope && mixed(scope) && (!i?.source || !sameScope(scope,comparisonScope(i)));
	}))
		fail("charter_scope","A mixed write grant must match the exact primary directory and integration files approved for this comparison");
	const handoff = "areas" in squad ? reviewHandoff(run, review, observation) : undefined;
	const stopped = handoff?.predecessor;
	if (handoff?.hold && observation.replace?.some(id => run.nodes[id]?.stop?.kind === "writer-cannot-repair"))
		fail("frozen_assignment", "Writable directories must be disjoint"); // Preserve the report for guarded readmission; status explains the hold.
	if (stopped) {
		if (!sameReviewInputs(cwd, run, review) || !remainingAssignments(run))
			fail("stale_assignment", "No current reviewed assignment is available for this directory");
		replaceable.add(stopped.grain.id);
	}
	let original=run.nodes;
	if (i?.successor && outcome==="regenerate") {
		const s=i.successor, scope=comparisonScope(i);
		preflightSuccessor(run,s,scope,review.squad);
		if (!remainingAssignments(run)) fail("limit","No authorized assignment remains for a narrow successor");
		if (!matchesSuccessor(run,s,observation,scope))
			fail("invalid_successor","Propose only the named successor with the approved scope and original component evaluator, from this product without replacing or consuming the stopped assignment");
		original={...run.nodes,[s.from]:{...run.nodes[s.from],successor:{to:s.to,review:review.id,directory:scope}}};
	}
	if (i?.transfer && outcome==="regenerate") {
		const t=i.transfer, scope=comparisonScope(i), [g]=grains;
		if (!remainingAssignments(run)) fail("limit","No authorized assignment remains for the receiving writer; ownership was not transferred");
		if (!mixed(scope) || ids.length!==1 || ids[0]!==t.to || typeof g!=="object" || !sameScope(scope,g.directory) ||
			observation.replace?.length || [...dependencies(run.nodes,g.needs)].includes(t.from))
			fail("ownership_transition","Only the named receiving output may take the approved grant; it cannot consume the old whole package");
		preflightTransfer(run,t,scope);
		const donor=run.nodes[t.from];
		original={...run.nodes,[t.from]:{...donor,retained:[...donor.retained ?? [],{...scope,to:t.to,review:review.id}]}};
	}
	const revision = "areas" in squad && outcome === "regenerate"
		? revise(original, squad, stopped ? { ...observation, replace: [stopped.grain.id] } : observation, review.id, replaceable) : undefined;
	const planned = revision?.nodes ?? run.nodes;
	if (revision && !revision.deferred) for (const id of revision.direct) {
		const n = run.nodes[id];
		if (n.state!=="repeated" || grains.some(g=>typeof g==="string" ? g===id : sameScope(g.directory,n.grain.directory))) continue;
		const checkpoint=run.products.at(-1);
		if (!checkpoint || !n.candidate || changedFiles(cwd,n.candidate,checkpoint.commit,scopePaths(n.grain.directory)).length)
			fail("frozen_assignment", `Cannot repartition ${n.grain.id}: its repeated output has not passed a product checkpoint`);
	}
	checkLinks(run, review, observation, planned);
	if (review.lead && revision) {
		if (review.lead.priorReview && !evidence.some(file => "areas" in squad && owns(squad, file)))
			fail("no_evidence", "An independent checkpoint proposal must cite delivered evidence in its own product area");
		if (revision.deferred || Object.values(run.nodes).some(n => planned[n.grain.id] !== n && !settledOutput(n)))
			fail("frozen_assignment", "Historical discovery cannot displace a reserved or failed assignment");
		for (const id of ids) {
			const n = planned[id];
			if (n.grain.revision && n.grain.revision !== review.base) fail("stale_assignment", "Use the current checked product for historical discovery");
			checkpointInputs(run, review, n, writerInputs(planned, n));
		}
	}
	if (i && revision) {
		const n = planned[ids[0]];
		if (i.source && (!evidence.includes(i.source.file) || Object.values(original).some(old => planned[old.grain.id] !== old && !settledOutput(old))))
			fail("unsupported_comparison","A new source comparison must cite the delivered product file and cannot displace an existing assignment");
		const scope=comparisonScope(i);
		if (ids.length !== 1 || !sameScope(n.grain.directory,scope) || observation.replace?.some(id => !sameScope(run.nodes[id]?.grain.directory,scope)) ||
			Object.values(original).some(old => planned[old.grain.id] !== old && !sameScope(old.grain.directory,scope)))
			fail("charter_scope", `This comparison is for one independent directory: ${i.directory}`);
		if (i.basis) {
			if (revision.deferred || n.grain.revision && n.grain.revision !== review.base)
				fail("stale_assignment", "Comparison is not independent of other work or requests a different baseline");
			checkpointInputs(run, review, n, writerInputs(planned, n));
		}
	}
	if (revision) for (const g of grains) if (typeof g !== "string" && g.revision)
		for (const dir of scopePaths(g.directory)) verifyDirectoryPin(cwd, g.revision, dir);
	if (run.goal?.tried && planned !== run.nodes) for (const id of ids)
		requireNewWork(run, planned[id].grain, review.base, writerInputs(planned, planned[id]));
	if ("grains" in squad && ids.some(id => !squad.grains.includes(id))) fail("charter_scope", "This observation includes another squad's grain");
	const roots = "areas" in squad ? Object.keys(planned).filter(id => owns(squad, planned[id].grain.directory)) : squad.grains;
	const inputs = [...dependencies(planned, roots)].map(id => planned[id].grain);
	const focused = requestedFiles(run, review);
	for (const file of observation.file ? [...evidence, observation.file] : evidence) {
		if (file !== squad.charter && file !== run.policy.source && file !== run.policy.goalCheck &&
			!(run.policy.sharedBrief && (file === observation.file || focused.has(file))) &&
			!("areas" in squad && (owns(squad, file) || [run.policy.productCheck, ...squad.boundary, ...squad.checks].includes(file))) &&
			!inputs.some(g => covers(g.directory, file) || [g.specification, ...g.boundary, g.check].includes(file)))
			fail("charter_scope", `Evidence is outside this charter: ${file}`);
	}

	const packet = review.packet ?? fail("missing_packet", "Missing journaled scout packet");
	for (const e of regularFiles(cwd, review.base, evidence))
		if (!deliveredFile(packet,e.name,e.oid)) fail("unseen_evidence",unseenText(e.name,e.oid));
	for (const g of grains) {
		const prior=typeof g==="string" ? planned[g]?.grain.prior : g.prior;
		if (!prior || prior==="independent") continue;
		if (prior==="unavailable") fail("missing_input","Required prior directory read is not authorized; report the missing prerequisite instead of staffing a writer");
		const spec=squad.charter, excerpt=packet.excerpt, bytes=committedFile(cwd,review.base,spec), content=bytes.toString("utf8");
		const delivered=Object.hasOwn(packet.files,spec) ? content : excerpt?.path===spec ? content.slice(excerpt.start,excerpt.end) : "";
		if (!evidence.includes(spec) || !isUtf8(bytes) || !delivered.includes(prior.clause))
			fail("missing_input","Required prior directory read lacks its verbatim clause in the delivered owning charter");
		const output=typeof g==="string" ? planned[g].grain : g;
		for (const dir of ownership(output.directory).directories) verifyDirectoryPin(cwd,output.revision ?? review.base,dir);
	}
	if (outcome === "no-gap" && packet.partial) fail("partial_coverage", "Cannot conclude no-gap from a partial packet");
	if (outcome === "needs-evidence") {
		const source = readSource(observation), history = reviews(run);
		if (!observation.file && (!source || !packet.sources?.includes(source) || observation.receipt && !(
			observation.receipt === run.goal?.check && goalReceipt(run)?.commit === review.base ||
			[...scopedNotes(run, review).values()].some(n => n.receipt === observation.receipt))))
			fail("charter_scope", "Requested source is outside this charter packet");
		const file = observation.file;
		validateRead(history, review, observation, !!file && focused.has(file), file ? regularFiles(cwd, review.base, [file])[0].oid : undefined);
	}
	if (observation.waitFor && !referenceRepo(observation.waitFor) && (observation.waitFor === squad.id || !run.policy.squads.some(s => s.id === observation.waitFor)))
		fail("charter_scope", "Wait for a different declared producer charter");
	if (observation.references?.length) {
		const pins = { ...run.references };
		for (const { repo, revision } of observation.references) {
			if (pins[repo] && pins[repo] !== revision) fail("frozen_reference", `${repo} is already frozen for this run at ${pins[repo]}; rejected ${revision}`);
			if (!pins[repo] && referenceCheckout(cwd, { repo, revision })) pins[repo] = revision;
		}
		if (Object.keys(pins).length) run.references = pins;
	}
	if (revision?.deferred) {
		survey(review,{type:"defer",observation,deferred:revision.deferred});
		return;
	}
	survey(review,{type:"admit",observation});
	if (outcome === "needs-decision" && wakeSource(run, review)?.decision?.status === "answered")
		decide(review,{ status: "unavailable", reason: "The clarification did not resolve this charter. A change to the committed contract needs a newly authorized brief." });
	if (outcome === "regenerate") {
		if ("areas" in squad) {
			for (const id of ids) {
				const pin = planned[id].grain.revision;
				if (pin) retain(cwd, pin);
			}
			run.nodes = planned;
			for (const launch of withdrawals) journal(launch,"withdraw");
			if (stopped) {
				review.predecessor = stopped;
				delete review.error;
			}
			if (run.goal) delete run.goal.stall;
		} else request(run, ids, review.id);
	}
}

/** @param {Run} run @param {import("./model.js").Review} review @param {Node} n @param {Node["inputs"]} pins @param {string} [base] */
function checkpointInputs(run, review, n, pins, base = review.renewal?.state==="approved" ?
	run.products.find(p=>p.check===review.renewal?.checkpoint)?.commit : review.base) {
	const last = run.products.at(-1);
	if (!last || last.commit !== base || !pins || Object.entries(pins).some(([id, pin]) =>
		last.outputs[id] !== pin || run.nodes[id]?.state !== "qualified" || review.packet?.outputs[id] !== pin))
		fail("stale_assignment", `The required inputs for ${n.grain.directory} must already be checked in the reviewed checkpoint`);
}

/** @param {Run["join"]} join @param {string} target @param {Record<string,string>|undefined} outputs */
function sameProduct(join, target, outputs) {
	return join?.target === target && !!outputs && digest(join.outputs) === digest(outputs);
}

/** An outstanding native check still needs its original join in order to claim its receipt.
 * @param {Run} run */
function outstandingProduct(run) {
	const check = run.join && run.effects.find(e => e.id === run.join?.check);
	return check && (awaitingReply(check) || check.permissionHold || check.state === "ordinary");
}

/** Connect the assignment's declared invalidation effect to this work graph.
 * @param {Run} run @param {string} id @param {string} reason @param {{passed:boolean,incomplete:boolean,unfunded:boolean}} [component] */
function applyOutcome(run, id, reason,component) {
	componentOutcome(run,id,reason,component,invalidateConsumers);
}

/** @param {import("./model.js").Receipt} receipt @param {string|undefined} grain @param {number} remaining */
function productFailure(receipt, grain, remaining) {
	if (receipt.exit === 0) return;
	if (receipt.exit === null) return `Evaluation did not complete: ${receipt.output}`;
	const reason = receipt.output || "Evaluator failed";
	if (!grain) return `Product check failed without identifying a repairable output: ${reason}`;
	if (remaining === 0) return `No assignment remains to repair ${grain}: ${reason}`;
}

/** Apply only runner-owned receipts for the current attempt. No native calls here.
 * @param {string} cwd @param {Run} run @param {string} actor @param {number} remaining @param {string} target */
function settleChecks(cwd, run, actor, remaining, target) {
	const checks = new Map(run.effects.filter(e => e.tool === "bash").map(e => [e.id, e]));
	for (const id of Object.keys(run.nodes)) {
		const n = run.nodes[id]; // Repair can invalidate a later consumer in this same pass.
		if (n.state !== "checking" || !n.check) continue;
		const c=checks.get(n.check);
		if (c?.kind==="component" && c.remedy) {
			const job=remedyWriter(run,c);
			if (job) settleProduction(cwd,run,job,c);
			continue;
		}
		const receipt = checkReceipt(checks.get(n.check));
		if (!receipt) continue;
		const incomplete=receipt.exit===null && receipt.failure!=="changed-export";
		applyOutcome(run,id,incomplete ? receipt.output : receipt.output || "Evaluator failed",{passed:receipt.exit===0,incomplete,unfunded:remaining===0});
	}
	const partition=partitionConflict(run,run.join?.outputs,target);
	if (partition) return;
	const join = run.join, check = join && checks.get(join.check);
	if (!join || !check) return;
	const receipt = checkReceipt(check);
	const upgrade = run.productRepins?.at(-1);
	if (upgrade?.recheck === join.check) {
		const prior = run.products.at(-1);
		if (!receipt || check.error || run.blocker || join.target !== target || prior?.check !== upgrade.checkpoint ||
			(upgrade.targetFrom ? target!==upgrade.revision : join.commit !== prior.commit || !sameProduct(prior,target,join.outputs))) return;
		verifyContracts(cwd,run.policy,target);
		if (receipt.exit !== 0) { check.error = `Product evaluator recheck did not pass: ${receipt.output || receipt.exit}`; return; }
		run.products.push(join);
		if (upgrade.targetFrom) for (const id of Object.keys(join.outputs)) {
			assign(run.nodes[id],"integrate");
			delete run.nodes[id].restoration;
		}
		delete run.join;
		return;
	}
	const blamed = receipt?.repair && Object.hasOwn(join.outputs, receipt.repair) ? receipt.repair : undefined;
	const failure = receipt && productFailure(receipt, blamed, remaining);
	// Older snapshots kept this exact check's diagnostic on the run. A goal
	// launcher/refusal can have the same diagnostic and must keep its own hold.
	if (run.blocker && run.blocker !== (run.goal && checks.get(run.goal.check)?.error) &&
		run.blocker === (milestoneBlocker(run) ?? failure)) {
		check.error = run.blocker;
		delete run.blocker;
	}
	if (!receipt || check.error || run.blocker) return;
	if (!sameProduct(join, target, productOutputs(run, target, remaining))) return;
	if (excludeIncompatible(cwd,run,join.outputs,productBase(cwd,run,target),join.commit)) {
		delete run.join; // Preserve this receipt on its original effect, never apply it to the surviving outputs.
		return;
	}
	if (receipt.exit === 0) {
		if (!run.goal) qualify(run, actor, join,target);
		delete run.join;
		run.products.push(join);
		for (const id of Object.keys(join.outputs)) {
			assign(run.nodes[id],"integrate");
			delete run.nodes[id].restoration;
		}
	} else if (failure) check.error = failure;
	else if (blamed) {
		const n=run.nodes[blamed];
		if (n.retained && n.candidate && consumersOf(run.nodes,{[blamed]:n.candidate}).some(c=>!settledOutput(c))) {
			check.error=`Cannot reopen retained parent ${blamed} while an active consumer is pinned to its version`;
			return;
		}
		applyOutcome(run, blamed, receipt.output || "Evaluator failed");
		delete run.join;
	}
}

/** @param {string} cwd @param {Run} run @param {string} target */
export function productBase(cwd, run, target) {
	verifyContracts(cwd, run.policy, target);
	const last = run.products.at(-1);
	if (target !== run.policy.base && target !== last?.target) retain(cwd, target);
	if (!last)
		return target;
	if (last.target === target)
		return last.commit;
	return rejoin(cwd, last, target);
}

/** @param {Run} run @param {Record<string,string>} outputs */
export function changes(run, outputs) {
	return Object.entries(outputs).filter(([id]) => run.nodes[id].state !== "qualified").flatMap(([id, to]) =>
		scopePaths(run.nodes[id].grain.directory).map(directory => ({ directory, exact:ownership(run.nodes[id].grain.directory).files.includes(directory), retained:run.nodes[id].retained, from: run.nodes[id].replaces ?? text(run.nodes[id].base, "producer base"), to })));
}

class InputMismatch extends FoundryError {
	/** @param {string} message @param {NonNullable<Node["excluded"]>} input */
	constructor(message, input) {
		super("stale_assignment", `${message}: ${"path" in input ? `${input.revision}:${input.path}` : `${input.grain}@${input.revision}`}`);
		this.input = input;
	}
}

/** @param {Run} run @param {Node} n @param {import("./model.js").Review|undefined} review */
function citedFiles(run, n, review) {
	return review && run.policy.sharedBrief ? [...requestedFiles(run, review)].filter(file =>
		!covers(n.grain.directory, file) && review.observation?.evidence.includes(file)) : [];
}

/** Older writers were explicitly given every requested, cited external path, even one
 * inside a prerequisite. Don't retroactively rewrite their kickoff after a reload.
 * @param {string} cwd @param {Run} run @param {Node} n @param {string} commit @param {string[]} [supporting] */
function verifyEvidence(cwd, run, n, commit, supporting = n.supporting) {
	const r = reviews(run).find(r => r.id === n.review);
	if (!r || r.base === commit) return;
	const frozen = [r.correction?.file, comparison(run,r)?.source?.file].filter(
		/** @returns {file is string} */ file => !!file && !covers(n.grain.directory,file));
	const files = [...new Set([...frozen, ...(supporting ?? citedFiles(run,n,r))])];
	if (!files.length) return;
	const [file] = changedFiles(cwd, r.base, commit, files);
	if (file) throw new InputMismatch(frozen.includes(file) ? `The frozen evidence for ${n.grain.id} changed before integration` :
		"A supporting file in the writer's brief changed since this assignment", {revision:r.base,path:file});
}

/** A stopped writer may have missed a replacement prerequisite or a newer checkpoint.
 * @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base */
export function verifyRepairInputs(cwd, run, n, required, base) {
	if (!n.inputs || digest(required) !== digest(n.inputs))
		fail("stale_assignment", "The writer's pinned prerequisites are no longer current");
	const original = text(n.base, "writer base"), directory = n.grain.directory;
	if (changedFiles(cwd, n.replaces ?? original, base, scopePaths(directory)).some(p=>!touchesCut(n.retained ?? [],p)))
		fail("stale_assignment", `The reviewed directory ${directory} changed since this assignment`);
	for (const [id, pin] of Object.entries(required)) {
		const dirs = scopePaths(run.nodes[id].grain.directory);
		if (changedFiles(cwd, original, base, dirs).length && changedFiles(cwd, pin, base, dirs).length)
			fail("stale_assignment", `The reviewed input ${dirs.join(", ")} changed since this assignment`);
	}
	verifyEvidence(cwd, run, n, base);
}

/** Check admissions, not enduring product invariants. Verify the actual assembled tree,
 * not a producer's generation or the base underneath a sibling replacement.
 * @param {string} cwd @param {Run} run @param {Record<string,string>} outputs @param {string} base @param {string} commit */
function* incompatibleInputs(cwd, run, outputs, base, commit) {
	const last = run.products.at(-1);
	for (const id of Object.keys(outputs)) {
		const n = run.nodes[id];
		if (n.state === "qualified" || n.state === "repeated" && last?.outputs[id] === outputs[id]) continue;
		try {
			if (run.goal && n.base !== base && changedFiles(cwd,n.replaces ?? text(n.base,"producer base"),base,scopePaths(n.grain.directory)).some(p=>!touchesCut(n.retained ?? [],p)))
				fail("tree_conflict", `The reviewed directory ${n.grain.directory} changed since this assignment`);
			for (const [dep,pin] of Object.entries(n.inputs ?? {})) {
				if (outputs[dep] !== pin)
					throw new InputMismatch(`A checked input of ${id} is no longer included`,{revision:pin,grain:dep});
				const dirs = scopePaths(run.nodes[dep].grain.directory);
				const [changed] = changedFiles(cwd,pin,commit,dirs);
				if (changed) throw new InputMismatch(`A checked input of ${id} changed before integration`,{revision:pin,path:changed});
			}
			verifyEvidence(cwd,run,n,commit);
		} catch (error) {
			if (!(error instanceof InputMismatch)) throw error;
			yield {n,error};
		}
	}
}

/** @param {string} cwd @param {Run} run @param {Record<string,string>} outputs @param {string} base @param {string} commit */
export function verifyJoinedInputs(cwd,run,outputs,base,commit) {
	for (const {error} of incompatibleInputs(cwd,run,outputs,base,commit)) throw error;
}

/** @param {string} cwd @param {Run} run @param {Record<string,string>} outputs @param {string} base @param {string} commit */
function excludeIncompatible(cwd,run,outputs,base,commit) {
	const conflicts = [...incompatibleInputs(cwd,run,outputs,base,commit)];
	for (const {n,error} of conflicts) {
		assign(n,{type:"stop",reason:error.message});
		n.excluded = error.input;
	}
	return !!conflicts.length;
}

/** Reader 8 did not persist the source of an incomplete check's diagnostic. Never
 * promote that receipt; only the bound writer may spend a repair on a different tree.
 * Called on a private snapshot, discarded in full if admission fails.
 * @param {string} cwd @param {Run} run @param {Node} n @param {string} actor @param {string} token @param {string} target */
export function reserveChangedRepair(cwd, run, n, actor, token, target) {
	if (run.blocker || run.conflict || run.join || run.effects.some(e => e.issuer === actor && e.permissionHold))
		fail("dispatch_held", "Resolve the run, product check or issuer hold before submitting changed work");
	if (run.goal && (goalReceipt(run)?.exit !== 1 || run.goal.target !== target || (run.products.at(-1)?.commit ?? target) !== run.goal.commit))
		fail("stale_assignment", "Need a current unmet goal on this target and checkpoint");
	if (n.repairs >= run.policy.repairs || !availableReservations(run))
		fail("limit", "No authorized repair, assignment or worker slot remains");
	const base = productBase(cwd, run, target);
	const stale = stalePins(run, n);
	if (stale.length) fail("stale_assignment", `Pinned prerequisites no longer current: ${stale.map(([id, pin]) => `${id}@${pin}`).join(", ")}`);
	applyOutcome(run, n.grain.id, "Writer submitted changed work after an incomplete evaluation");
	validateNodes(run.nodes);
	const required = writerInputs(run.nodes, n) ?? fail("stale_assignment", "The writer's prerequisites are not ready");
	verifyRepairInputs(cwd, run, n, required, base);
	reserveWriter(cwd, run, n, required, base, actor, token);
	if (run.goal) delete run.goal.stall;
}

/** @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base @param {string} actor @param {string} [submitToken] @param {import("./model.js").Inventory} [baseline] @param {import("./model.js").CandidateReuse} [reuse] */
export function reserveWriter(cwd, run, n, required, base, actor, submitToken, baseline, reuse) {
	const g = n.grain, token = randomUUID();
	const inline = n.worker === actor && submitToken !== undefined && n.token === submitToken;
	if (n.worker) {
		const previous = run.effects.find(e => e.id === n.check);
		if (previous?.receipt?.failure === "changed-export") {
			if (run.goal && run.goal.target !== commitAt(cwd, run.policy.target))
				fail("stale_assignment", "The assessed target changed since the component check");
			verifyRepairInputs(cwd, run, n, required, base);
		}
		if (inline) {
			if (previous?.kind !== "component" || !checkReceipt(previous) || previous.inlineRepair)
				fail("invalid_repair", "An inline repair requires its own checked submission");
			previous.inlineRepair = token;
		}
		n.repairs++;
		delete n.candidate;
		delete n.stop;
		assign(n,"staff");
		n.token = token;
		if (!inline) reserveNotice(run, actor, token, "repair", baseline
			? `Read your foundry_status for ${run.id} before acting. For this attempt only, the operator approved read-only consultation of ${describeInventory(baseline)} to preserve your inventory. No other prior paths, revisions or permissions change. Join helpers and submit the complete assigned output normally.`
			: `Read foundry_status({run:"${run.id}"}). Repair the checked failure in ${scopeLabel(g.directory)} if this token is still writable. ${n.retained ? `Exclude all transferred paths: ${JSON.stringify(n.retained)}.` : "Keep the original scope;"} join any helpers before submitting.`, n, baseline);
		return;
	}
	const review = reviews(run).find(r => r.id === n.review);
	const iteration=comparison(run,review), narrow=iteration?.successor;
	if (narrow && review) {
		if (!currentReview(cwd,run,review) || review.base!==base || narrow.to!==g.id)
			fail("stale_assignment","The approved checkpoint or goal for the stopped assignment changed before staffing");
		preflightSuccessor(run,narrow,g.directory,review.squad,review.id);
		checkpointInputs(run,review,n,required);
	}
	const predecessor = review?.predecessor?.stop?.kind === "writer-cannot-repair" ? review.predecessor : undefined;
	if (predecessor && review && (review.base !== base || run.goal?.target !== commitAt(cwd,run.policy.target) ||
		!currentEvaluation(run,review) || Object.entries(required).some(([id, pin]) =>
			run.nodes[id]?.state !== "qualified" || review.packet?.outputs[id] !== pin)))
		fail("stale_assignment", "The product, evaluator or reviewed inputs changed before the stopped repair's successor could start");
	requireNewWork(run, g, base, required); // A pending prerequisite may have resolved since admission.
	const {directories:dirs,files}=ownership(g.directory), label = dirs.map(d=>`${d}/`).join(", ");
	if (files.length) {
		regularFiles(cwd,base,files);
		if (!review || changedFiles(cwd,review.base,base,files).length) fail("stale_assignment","The approved exact file changed before staffing");
	}
	const source = inventory(cwd, g.revision ?? base, g.directory);
	if (g.revision && (!source || members(source).length !== dirs.length)) fail("invalid_baseline", `Missing prior directory at ${g.revision}: ${label}`);
	if (g.prior && g.prior!=="independent" && (g.prior==="unavailable" || !review || !source || members(source).length!==dirs.length ||
		changedFiles(cwd,review.base,base,[g.specification,...(!g.revision ? dirs : [])]).length))
		fail("missing_input","Required prior directory or its charter changed before staffing");
	const deps = changes(run, required);
	if (reuse) for (const directory of scopePaths(g.directory)) deps.push({directory,exact:files.includes(directory),retained:n.retained, from:base, to:text(reuse.predecessor.candidate,"retained candidate")});
	const assembled = deps.length ? combine(cwd,base,deps) : base;
	for (const [id,pin] of Object.entries(required)) {
		const donor=run.nodes[id];
		if (donor.retained && changedFiles(cwd,pin,assembled,scopePaths(donor.grain.directory)).length)
			throw new InputMismatch("The requested whole-package pin no longer describes this assembled input",{grain:id,revision:pin});
	}
	const supporting = citedFiles(run,n,review).filter(file => !Object.keys(required).some(id => covers(run.nodes[id].grain.directory,file)));
	verifyEvidence(cwd,run,n,assembled,supporting);
	n.generation = reuse ? assembled : withoutGrain(cwd, assembled, narrow || n.restoration ? undefined : g.directory);
	if (review && run.policy.sharedBrief) n.supporting = supporting;
	if (source) {
		retain(cwd, g.revision ?? base);
		n.priorSource = source;
	}
	n.inputs = required;
	n.base = base;
	n.token = token;
	assign(n,"staff");
	const brief = [run.policy.direction, review?.observation?.reason,
		review && researchContext(run, review),
		...("task" in g ? [`Assigned behavior: ${g.task}`, `Component check: ${g.check}`] : []),
		predecessor && `Previous task ${predecessor.grain.id} stopped after inconclusive check ${predecessor.check}: ${predecessor.stop?.detail}. This is historical context, not permission to repeat that observation or read its candidate. Perform only the distinct reviewed work; report a missing prerequisite if it is not possible.`,
		narrow && `Narrow successor to ${narrow.from}, stopped component ${narrow.check}. Start from this checked product already in your checkout. Do not consult or import the prior candidate, preview or worktree.`,
		n.restoration && `Ownership restoration only: inspect the current ${label} in this checkout; submit it unchanged for its own fresh check. No other files or historical candidates are granted. If the scope cannot be attested, report the blocker.`,
		`Generate the complete ${label} ${dirs.length===1?"directory":"directories as one output"}; omitted files are deleted.`,
		files.length && `Also edit only these existing regular integration files in your frozen checkout: ${JSON.stringify(files)}. Preserve their paths. No parent or sibling is granted.`,
		"Keep the host-assigned Git branch. Neither you nor your helpers may rename it with rename_branch or Git commands. For a readable title, use rename_session instead.",
		`Read ${g.specification} and ${g.boundary.join(", ")} at this base. Required outputs: ${JSON.stringify(required)}.`,
		...supporting.map(file => `Read-only supporting file: ${review?.base}:${file}`),
		takeArtifactBrief(run, n),
		"For midpoint feedback, join helpers and use foundry_preview with this token. Compare the affected behavior on that draft; do not submit just to obtain a preview.",
		...(run.goal ? [`Reviewed input revision: ${base}`] : []),
		reuse ? `Your worktree already contains the complete ${label} from failed candidate ${reuse.predecessor.candidate}, check ${reuse.predecessor.check}. Preserve that work; use the selected reference ${reuse.blob} to correct the failure within the original contract. Submit a changed output for one fresh component check; do not replay the old attempt.`
			: narrow || n.restoration ? undefined : g.prior==="independent" ? "The proposal requires no prior implementation and grants no prior read." :
			source ? `Read prior implementation only if ${g.specification} explicitly permits it at this version, and only regular files from ${describeInventory(source)}. The source is not a read grant.`+
			(typeof g.prior==="object" ? ` The scout cited this clause; verify its scope in the original charter before any read: ${JSON.stringify(g.prior.clause)}` : "")
			: `No prior directory at ${base}:${label}; start empty. Do not search history for another version.`,
		"Split independent work across native in-session `task` agents in parallel. Give each a disjoint set of files under your directory or a read-only question, the permitted inputs and the same constraints; ask for results, not further delegation. Keep shared files for yourself. Work solo for small or indivisible changes, or if helpers are unavailable.",
		"Keep the token and all Foundry calls to yourself. Do not start desktop sessions, change the contract or evaluators, switch base, commit or land. Join the helpers and integrate their results before you submit. For a repair, reuse finished work; parallelize only the remaining independent pieces.",
		`From this worktree call foundry_submit({run:"${run.id}",token:"${token}"}).`].filter(Boolean).join("\n");
	const launch = reserveWorker(run, actor, token, n.generation, brief, g.agent, g.id, reuse);
	if (reuse) n.reuse = launch;
}

/** Only the latest report can be reconsidered, and only for a rejection whose cause we can
 * disprove at the original pins. Admit its recorded observation, never replay the workflow.
 * @param {string} cwd @param {Run} run @param {import("./model.js").Review[]} history
 * @param {import("./model.js").Review} r @param {import("./model.js").Observation} observation */
function readmitReport(cwd, run, history, r, observation) {
	const goal = run.goal;
	if (!goal || r.base !== goal.commit || !currentEvaluation(run,r) || !r.workflowId || !r.callId) return;
	const released = r.error === "Writable directories must be disjoint" && reviewHandoff(run, r, observation)?.predecessor;
	const progress = rejectedRead(history, r), unfinished = progress?.kind === "partial";
	const retiredConsumer = observation.outcome === "regenerate" && Object.values(run.nodes).some(n =>
		n.state === "repeated" && r.error === `Cannot repartition ${n.grain.id}: its repeated output has not passed a product checkpoint` &&
		!observation.replace?.includes(n.grain.id) && observation.grains.every(g => typeof g === "string" ?
			g !== n.grain.id : g.id !== n.grain.id && outside(n.grain.directory,scopePaths(g.directory))));
	if (progress?.kind === "complete" && goal.stall &&
		readWake(history, r, r.base, r.version)?.key === evidenceDecision &&
		sameReviewInputs(cwd, run, r)) delete goal.stall;
	const frozen=r.error===staleReviewReason && checkpointSurvey(run,r) && movingSurvey(cwd,run,commitAt(cwd,run.policy.target));
	if (frozen) {
		if (!currentReview(cwd,run,r,frozen.target) || run.effects.some(e=>e.permissionHold)) return;
		observe(cwd,run,r,observation); delete r.error; return;
	}
	if (!released && !unfinished && !retiredConsumer) return;
	if (retiredConsumer && !r.lead && !comparison(run,r)) {
		// An independent repeated output changes the charter's scheduling version,
		// not the frozen source. Revalidate the original proposal against the live graph.
		if (run.blocker || run.conflict || run.join || run.effects.some(e=>e.permissionHold) ||
			(run.products.at(-1)?.commit ?? goal.commit)!==r.base || !currentReview(cwd,run,r)) return;
		verifyContracts(cwd,run.policy,goal.target);
	} else if (!sameReviewInputs(cwd, run, r)) return;
	observe(cwd, run, r, observation);
	if (unfinished || retiredConsumer) {
		delete r.error;
		delete goal.stall;
	}
}

/** Select from ledger evidence only. Read fresh pins after each preceding reservation.
 * @param {Run} run @param {Node} node @param {import("./model.js").Review|undefined} review @param {boolean} scoped */
function writerCandidate(run, node, review, scoped) {
	if (node.worker && Object.values(run.nodes).some(other => other !== node && (other.worker === node.worker ||
		other.workspace && run.effects.some(e => e.id === other.workspace && (e.args.session_id === node.worker ||
			e.tool === "session.send" && e.issuer === node.worker))) && ["checking","writing"].includes(other.state))) return;
	const required = writerInputs(run.nodes, node);
	if (!required) return;
	if (retainedRepair(run,node)) return {required,retained:true};
	const scope = checkpointScope(run, review), checkpoint = scope?.check, missing = scope?.goal;
	if (continuingRepair(run, node, review, checkpoint)) {
		if (run.join || run.effects.some(e => e.permissionHold && (e.grain === node.grain.id || e.issuer === node.worker))) return;
		return { required, checkpoint: run.products.at(-1)?.check, continuation: true };
	}
	if (scoped && (!checkpoint || !currentEvaluation(run,review) || missing && missing !== run.goal?.check)) return;
	return { required, checkpoint, missing };
}

/** @param {Run} run @param {string} target */
function isolationEvidence(run,target) {
	const s=run.independent, join=run.join, e=s && run.effects.find(e=>e.id===s.product);
	if (!s || !join || !validIsolation(run) || target!==s.target || run.blocker || run.conflict ||
		run.effects.some(e=>e.permissionHold) || e?.kind!=="product" || e.error) return;
	const receipt=checkReceipt(e);
	if (receipt) return {s,join,e,receipt};
}

/** @typedef {import("./model.js").Review} Review */
/** @typedef {import("./model.js").Receipt} Receipt */
/** @typedef {{from:string,edge:import("./machine.mjs").Edge}} PlanningStep */
/** @typedef {{retryGoal?:boolean,submitToken?:string,target?:string,renew?:boolean,trace?:PlanningStep[]}} PlanningOptions */
/** @typedef {{cwd:string,run:Run,actor:string,owner:boolean,discover:boolean,options:PlanningOptions,target?:string,base?:string,
 * isolated?:ReturnType<typeof isolationEvidence>,history:Review[],latest?:Map<string,Review>,remaining:number,reserved:number,limit:number,
 * admission:import("./admission.mjs").Admission,workTarget?:string,nodes:Node[],stoppedWaiting:boolean,gap?:Receipt,
 * outputs?:Record<string,string>,assembly?:{commit:string,attribution?:string},excluded?:boolean,unchanged?:boolean,repeated?:Receipt,diagnostic?:string,
 * squads:import("./model.js").Squad[]}} Plan */

/** @template T @param {T|undefined} value @param {string} input */
function needed(value,input) {
	if (value===undefined) throw Error(`Missing scheduling input: ${input}`);
	return value;
}
/** @param {Plan} p */
const tip=p=>needed(p.target,"observed target");
/** @param {Plan} p */
const startingPoint=p=>p.base??=productBase(p.cwd,p.run,tip(p));

/** Guards are observations of the current draft. Do not speculatively read Git or assess a receipt.
 * @param {Plan} p */
function planningFacts(p) {
	const {run,owner,actor}=p;
	return {
		owner,elapsed:expired(run),
		get active(){return run.active;},get timely(){return timelyChecks(run);},
		get participant(){return owner || run.effects.some(e=>e.nativeId===actor);},
		get targetKnown(){return p.target!==undefined;},get delivery(){return !!activeDelivery(run);},
		get independent(){return !!run.independent;},get hasJoin(){return !!run.join;},
		get isolatedReceipt(){return !!p.isolated;},get isolatedPass(){return p.isolated?.receipt.exit===0;},
		get sameGoalTarget(){return run.goal?.target===p.target;},get liveWriter(){return Object.values(run.nodes).some(n=>n.state==="checking" || n.state==="writing");},
		get currentInputs(){return !!p.latest && run.goal?.target===p.target && !run.effects.some(e=>e.permissionHold);},
		get admitted(){return p.admission!=="closed";},
		get writerSlot(){return p.limit>0 && admissionPolicy(p.admission).writers!=="none" && p.nodes.some(n=>n.state==="waiting");},
		get outputs(){return !!p.outputs;},get sameJoin(){return sameProduct(run.join,tip(p),p.outputs);},
		get outstandingProduct(){return !!outstandingProduct(run);},get excluded(){return !!p.excluded;},get hasGoal(){return !!run.goal;},
		get noNewProduct(){return !!(p.unchanged || p.repeated);},
		get recheckStopped(){
			const work=admissionPolicy(p.admission);
			return p.stoppedWaiting && p.gap?.exit===0 && !run.join && !p.outputs && work.discover && !work.scoped;
		},
		get mayDiscover(){return admissionPolicy(p.admission).discover;},get budget(){return p.reserved!==p.remaining;},
		get surveyDue(){return run.goal ? admissionPolicy(p.admission).scoped || p.gap?.exit===1 && run.goal.target===p.target && !(p.outputs && run.join && !milestoneBlocker(run))
			: !run.policy.seed && (p.discover || workerLimit(run)!==undefined);},
		get unmet(){return p.gap?.exit===1;},get pendingWork(){return !!(run.blocker || run.join) || p.nodes.some(n=>actionable(run,n));},
		get surveysFinished(){
			const finished=new Map(reviews(run).filter(r=>currentEvaluation(run,r)).map(r=>[r.squad,r.base===p.gap?.commit && !reading(r)]));
			return p.squads.every(s=>finished.get(s.id));
		},
	};
}

/** @param {Plan} p */
function settleReports({cwd,run,actor,owner,history,latest}) {
	for (const r of history) if (r.observation) {
		try {
			if (r.state !== "reported") {
				if (r.state === "blocked" && latest?.get(r.squad) === r) readmitReport(cwd, run, history, r, r.observation);
				continue;
			}
			observe(cwd, run, r, r.observation);
			if (!owner && r.observation.outcome === "needs-decision")
				reserveNotice(run, actor, r.id, "decision", `Foundry ${run.id} has a charter question for its owner at ${r.base}. This notice grants no authority.`);
		}
		catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			blockReview(r, error.message);
		}
	}
}

/** @param {Plan} p */
function admitArrivals(p) {
	const {cwd,run}=p, target=tip(p);
	for (const r of inputArrivals(run,needed(p.latest,"owner reports").values())) {
		const report=r.observation;
		if (!report) continue;
		try {
			producersDeclared(r,sameReviewInputs(cwd,run,r,target),()=>{
				observe(cwd,run,r,report);
				delete r.error;
			});
		} catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			blockReview(r,error.message);
		}
	}
}

/** @param {Plan} p */
function retryReaders(p) {
	const {cwd,run,actor,owner,history}=p;
	for (const r of history) {
		if (!readerInterrupted(r) || (!owner && r.issuer !== actor) ||
			history.findLast(h => h.squad === r.squad) !== r || history.some(h => h.squad === r.squad && reading(h)) ||
			run.effects.some(e => e.permissionHold && (e.issuer === actor || e.issuer === r.issuer)) ||
			!availableReservations(run, p.remaining) || !sameReviewInputs(cwd, run, r, tip(p))) continue;
		const fresh = reserveReview(run, actor, r.squad, r.base, r.version, r.wake);
		fresh.retryOf = r.id;
		if (r.lead) fresh.lead = r.lead;
		history.push(fresh);
		if (run.goal) delete run.goal.stall;
		p.remaining--;
	}
}

/** @param {Plan} p */
function assessRelease(p) {
	const {cwd,run,actor}=p;
	const decision=run.goal ? applyGoal(cwd,run,actor,()=>tip(p),p.options.retryGoal===true)
		: decisionOf(transition(release,{value:"absent",context:null},{type:"assess"},{},true));
	p.admission=decision.admission;
	p.workTarget="workTarget" in decision && typeof decision.workTarget==="string" ? decision.workTarget : undefined;
	if (run.active && run.goal?.target===tip(p) && !run.conflict) {
		for (const g of unownedBlockers(run,p.remaining)) if (!run.effects.some(e=>e.kind==="escalation" && e.token===g.detail)) {
			reserveNotice(run, actor, g.detail, "escalation", `Foundry ${run.id}: ${g.id} at ${g.directory}: one failed step, ${g.blocked} journeys blocked (${g.affected} affected), no repair owner. Inspect receipt ${g.receipt} and ${g.review ? `review ${g.review}` : "charter ownership"}. This notice grants no authority.`);
		}
	}
}

/** @param {Plan} p */
function prepareAdmission(p) {
	const {cwd,run}=p, reviewed=run.products.at(-1) ?? run.goal;
	if (reviewed && !p.workTarget && !run.policy.seed && reviewed.target!==tip(p)) {
		const edits = changedFiles(cwd, reviewed.commit, startingPoint(p));
		const stale = Object.values(run.nodes).filter(n => settledOutput(n) && !outside(n.grain.directory, edits));
		if (stale.length) {
			const ids = superseded(run.nodes, stale.map(n => n.grain.id));
			if (Object.values(run.nodes).some(n=>protectsGrant(n,ids)))
				fail("tree_conflict","Target changed a transferred ownership group; cannot retire its grants on a moved target");
			if (Object.values(run.nodes).some(n => !ids.has(n.grain.id) && n.state !== "idle" && liveNeeds(n).some(id => ids.has(id))))
				fail("tree_conflict", "A target edit changed a required checkpoint output");
			for (const id of ids) {
				const { grain } = run.nodes[id];
				if (grain.task) delete run.nodes[id];
				else run.nodes[id] = { grain, state: "idle", repairs: 0 };
			}
		}
	}
	p.nodes=Object.values(run.nodes);
	p.limit=availableReservations(run,p.remaining);
}

/** @param {Plan} p */
function allocateWriters(p) {
	const {cwd,run,actor,history,nodes,limit,workTarget}=p, work=admissionPolicy(p.admission);
	for (const n of nodes) {
		if (p.reserved >= limit) break;
		if (n.state !== "waiting") continue;
		const held = work.writers==="repair" && heldRepair(run,n);
		if (work.writers==="repair" && !held) continue;
		const r = n.review ? history.find(r => r.id === n.review) : undefined;
		if (workTarget && !checkpointSurvey(run,r)) continue;
		if (!n.worker && r && answeredLead(run,r,scopePaths(n.grain.directory))) {
			assign(n,{type:"stop",reason:"A newer goal receipt observed this historical lead's step passing before staffing"});
			p.stoppedWaiting = true;
			continue;
		}
		const candidate = writerCandidate(run, n, r, work.scoped || held==="successor");
		if (!candidate) continue;
		const { required, checkpoint, missing, continuation } = candidate;
		try {
			if (candidate.retained || held && n.worker) verifyRepairInputs(cwd,run,n,required,startingPoint(p));
			if (checkpoint && r) {
				if (missing && missing !== run.goal?.check || !checkpointCurrent(run, checkpoint, workTarget ?? tip(p)))
					fail("stale_assignment", "The reviewed checkpoint, goal observation or target changed before staffing");
				if (continuation) verifyRepairInputs(cwd, run, n, required, startingPoint(p));
				checkpointInputs(run, r, n, required, continuation ? startingPoint(p) : undefined);
			}
			reserveWriter(cwd, run, n, required, run.goal?.commit ?? startingPoint(p), actor, p.options.submitToken);
			p.reserved++;
		} catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			assign(n,{type:"stop",reason:error.message});
			p.stoppedWaiting = true;
			if (error instanceof InputMismatch) n.excluded = error.input;
		}
	}
}

/** @param {Plan} p */
function joinInputs(p) {
	return admissionPolicy(p.admission).join!=="none" && (p.run.join || !p.run.blocker)
		? productOutputs(p.run,tip(p),p.remaining-p.reserved) : undefined;
}

/** @param {Plan} p */
function assembleOutputs(p) {
	const {cwd,run}=p, outputs=needed(p.outputs,"join outputs"), last=run.products.at(-1);
	const restored=last ? Object.keys(outputs).filter(id=>run.nodes[id].restoration?.checkpoint===last.check && !last.outputs[id]) : [];
	const attribution=restored.length ? digest(restored.sort().map(id=>[id,run.nodes[id].check,run.nodes[id].restoration])) : undefined;
	const commit=combine(cwd,startingPoint(p),changes(run,outputs),tip(p),attribution);
	p.assembly={commit,attribution};
	p.excluded=excludeIncompatible(cwd,run,outputs,startingPoint(p),commit);
}

/** @param {Plan} p */
function compareAssembly(p) {
	const {cwd,run}=p, {commit,attribution}=needed(p.assembly,"verified assembly");
	delete run.join;
	delete run.blocker;
	const at=run.goal;
	if (at && run.effects.find(e=>e.id===at.check)?.state==="retired" && treeOf(cwd,commit)===treeOf(cwd,at.commit))
		fail("no_progress", "The retained outputs reproduce the retired goal tree; no check was issued");
	p.unchanged=!attribution && admissionPolicy(p.admission).join==="changed" && !!at && treeOf(cwd,commit)===treeOf(cwd,at.commit);
	if (p.unchanged) {
		for (const n of p.nodes) if (n.state==="published") {
			assign(n,{type:"repeat",reason:"Checked output leaves the assessed product unchanged; the missing observation was not retried."});
		}
	} else if (!attribution) p.repeated=rejectRepeat(cwd,run,tip(p),commit,needed(p.outputs,"join outputs"));
}

/** @param {Plan} p */
function reserveSurveys(p) {
	const {cwd,run,actor,history,workTarget,remaining,limit}=p, work=admissionPolicy(p.admission);
	const applicable = history.filter(r => currentEvaluation(run,r));
	const leads = work.scoped ? discoverLeads(run, history) : undefined;
	const order = discoverySquads(run, applicable, p.gap);
	p.squads = leads?.owners.size ? order.toSorted((a, b) => Number(leads.owners.has(b.id)) - Number(leads.owners.has(a.id))) : order;
	const protectQueue=!work.scoped || !workTarget && pendingGoal(run);
	const scoutLimit=Number.isFinite(remaining) && protectQueue ? Math.min(limit,remaining-queuedWriters(run.nodes)) : limit;
	delete run.discoveryError;
	for (const squad of p.squads) {
		if (p.reserved >= scoutLimit) break;
		const past = availableHistory(run, applicable, squad.id);
		if (!past) continue;
		const prior = past.at(-1);
		if (workTarget && !checkpointSurvey(run,prior)) continue;
		const lead = leads?.leads.get(squad.id);
		const initial = lead ? { lead, wake: undefined } : undefined;
		if (work.scoped && !initial && !atCheckpoint(run, checkpointScope(run,prior))) continue;
		let commit;
		try { commit = run.goal?.commit ?? startingPoint(p); }
		catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			run.discoveryError = error.message;
			break;
		}
		const version = reviewVersion(cwd, run, squad, commit);
		/** @type {{ wake?:import("./model.js").Review["wake"]; lead?:import("./model.js").DiscoveryLead }|undefined} */
		const next = work.scoped ? checkpointWake(run, past, commit, version) ?? initial : nextReview(run, past, commit, version);
		if (!next) continue;
		const fresh = reserveReview(run, actor, squad.id, commit, version, next.wake);
		if (next.lead) fresh.lead = next.lead;
		p.reserved++;
	}
}

/** Preserve the original conflict boundary: earlier reservations and diagnostics on this
 * draft remain eligible for the caller's CAS. Unexpected errors still discard the plan.
 * @param {(p:Plan)=>void} effect */
const fallible=effect=>(/** @type {Plan} */ p)=>{
	try {effect(p);} catch (error) {
		if (!(error instanceof FoundryError)) throw error;
		p.diagnostic=error.message;
		return /** @type {const} */ ("conflict");
	}
};

/** @typedef {Extract<(typeof scheduling.states)[keyof typeof scheduling.states][number],{action:string}>["action"]} PlanningAction */
/** @type {Record<PlanningAction,(p:Plan)=>void|"conflict">} */
const planningActions={
	"record-conflict"(p){p.run.conflict=needed(p.diagnostic,"planning diagnostic");},
	"observe-target"(p){p.target=observeTarget(()=>p.options.target ?? commitAt(p.cwd,p.run.policy.target)).target;},
	"advance-delivery"(p){advanceDelivery(p.cwd,p.run,needed(activeDelivery(p.run),"approved delivery"),tip(p));},
	"read-isolation"(p){p.isolated=isolationEvidence(p.run,tip(p));},
	"reject-isolation"(p){
		const {e,receipt}=needed(p.isolated,"isolated receipt");
		e.error=`Independent product check did not pass: ${receipt.output || receipt.exit}`;
	},
	"accept-isolation"(p){
		const {cwd,run,actor}=p,{s,join,e}=needed(p.isolated,"isolated receipt");
		verifyContracts(cwd,run.policy,tip(p));
		run.products.push(join);delete run.join;
		for (const {grain} of s.selected) assign(run.nodes[grain],"integrate");
		assess(cwd,run,actor,tip(p),join.commit);
		const assessment=run.effects.at(-1);
		if (assessment?.kind!=="goal") throw Error("Independent assessment reservation is missing");
		assessment.isolation=e.isolation;s.assessment=assessment.id;
	},
	"settle-timely"(p){
		const {cwd,run,actor}=p;
		verifyContracts(cwd,run.policy,tip(p));
		if (run.join) settleChecks(cwd,run,actor,remainingAssignments(run),tip(p));
		applyGoal(cwd,run,actor,()=>tip(p),false);
	},
	"reconcile-writers"(p){
		const {run,actor}=p;
		finishWriters(run);notifyWriters(run,actor);
		delete run.conflict; // Recompute from the current target and live pins, not a refusal.
		p.history=reviews(run);
		if (p.owner && run.goal) p.latest=new Map(p.history.map(r=>[r.squad,r]));
	},
	"settle-reports":settleReports,"admit-arrivals":admitArrivals,
	"renew-reports"(p){for (const r of p.history) renew(p.cwd,p.run,r,tip(p),p.options.renew===true,report=>observe(p.cwd,p.run,r,report));},
	"settle-checks":fallible(p=>{p.remaining=remainingAssignments(p.run);settleChecks(p.cwd,p.run,p.actor,p.remaining,tip(p));}),
	"retry-readers":fallible(retryReaders),"assess-release":fallible(assessRelease),"prepare-admission":fallible(prepareAdmission),
	"allocate-writers":allocateWriters,"collect-outputs"(p){p.gap=goalReceipt(p.run);p.outputs=joinInputs(p);},
	"assemble-outputs":fallible(assembleOutputs),"compare-assembly":fallible(compareAssembly),
	"settle-survivors":fallible(p=>{
		const {cwd,run,actor}=p,remaining=p.remaining-p.reserved,target=tip(p);
		if (sameProduct(run.join,target,productOutputs(run,target,remaining))) settleChecks(cwd,run,actor,remaining,target);
		else if (!milestoneBlocker(run)) delete run.join;
	}),
	"reassess-survivors":fallible(p=>{p.admission=applyGoal(p.cwd,p.run,p.actor,()=>tip(p),false).admission;}),
	"refresh-outputs":fallible(p=>{p.outputs=joinInputs(p);}),
	"reserve-product":fallible(p=>{reserveProduct(p.run,p.actor,p.cwd,tip(p),needed(p.assembly,"verified assembly").commit,needed(p.outputs,"join outputs"));}),
	"reassess-stopped"(p){applyGoal(p.cwd,p.run,p.actor,()=>tip(p),false);},
	"reserve-surveys":reserveSurveys,
	"record-stall"(p){
		stall(p.run,p.repeated || p.nodes.some(n=>n.state==="repeated") ? "The proposed outputs reproduce a tree already checked against the goal."
			: "No actionable grain remains on this revision.",p.repeated ?? needed(p.gap,"unmet goal"));
	},
};
const executePlanning=executor(scheduling,planningActions);

/** Plan on a private snapshot outside the SQLite write lock. Only the caller may commit it.
 * @param {string} cwd @param {Run} run @param {string} actor @param {boolean} discover @param {PlanningOptions} [options] */
export function advance(cwd,run,actor,discover,options={}) {
	/** @type {Plan} */ const p={cwd,run,actor,owner:actor===run.owner,discover,options,history:[],remaining:0,reserved:0,limit:0,
		admission:"closed",nodes:[],stoppedWaiting:false,squads:[]};
	const facts=planningFacts(p);
	let snapshot={value:scheduling.initial,context:null}, type="plan";
	while (snapshot.value!=="done") {
		const result=transition(scheduling,snapshot,{type},facts,true);
		if (result.edge) options.trace?.push({from:snapshot.value,edge:result.edge});
		snapshot=result.snapshot;
		const [signal]=executePlanning(result,p);
		type=signal ?? "plan";
	}
}

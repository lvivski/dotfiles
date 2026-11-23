import { randomUUID } from "node:crypto";
import { notifyWriters, takeArtifactBrief } from "./artifacts.mjs";
import { validOutcome } from "./contract.mjs";
import { checkReceipt, goalReceipt, milestoneBlocker } from "./evidence.mjs";
import { checkpointCurrent, pendingGoal } from "./facts.mjs";
import { applyGoal, assess, qualify, rejectRepeat, stall } from "./goal.mjs";
import { availableReservations, remainingAssignments } from "./capacity.mjs";
import { admitted, expired, reserveNotice, reserveProduct, reserveWorker } from "./native.mjs";
import { workerLimit } from "./policy.mjs";
import { validMatch } from "./pages.mjs";
import { actionable, consumersOf, dependencies, liveNeeds, owns, productOutputs, proposal, requireNewWork, revise, settledOutput, stalePins, stoppedPredecessor, superseded, supersededAttempt, validateNodes, waiting, writerInputs } from "./plan.mjs";
import { changedFiles, combine, commitAt, directoryBaseline, outside, regularFiles, rejoin, retain, verifyContracts, verifyDirectoryPin, versionOf, withoutGrain } from "./product.mjs";
import { referenceCheckout } from "./research.mjs";
import { availableHistory, blockReview, canContinueRead, canInvestigate, comparison, discoverySquads, evidenceDecision, exhaustedRead, fileProgress, nextReview, readKey, readSource, reading, rejectedRead, requestedFiles, researchContext, reserveReview, reviews, scopedNotes, staleReviewReason, unchangedRead, wakeSource } from "./reviews.mjs";
import { FoundryError, contains, digest, fail, fields, integer, name, names, record, referenceRepo, relative, text, waitTarget } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Policy} Policy */
/** Consumers record transitive inputs, so one pass retires every assignment built on this version.
 * @param {Run} run @param {string} id @param {string|undefined} version */
function invalidateConsumers(run, id, version) {
	if (!version) return;
	for (const child of consumersOf(run.nodes, { [id]: version }))
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

/** @param {string} cwd @param {Run} run @param {import("./model.js").Squad} squad @param {string} commit */
function reviewVersion(cwd, run, squad, commit) {
	if (run.goal) {
		if (!("areas" in squad)) return commit;
		const stopped = Object.values(run.nodes).filter(n => owns(squad, n.grain.directory) && (n.state === "repeated" || n.state === "blocked"));
		// Reproducing the combined failing tree is new evidence even for a charter that previously found no gap.
		return digest([commit, run.goal.tried ?? [], stopped.map(n => {
			const retired = supersededAttempt(run, n);
			return [n.grain.id, n.state, n.reason ?? n.candidate, ...(retired ? [retired] : [])];
		})]);
	}
	if (!("grains" in squad)) fail("invalid_goal", "Area charters need an assessed revision");
	const ids = dependencies(run.nodes, squad.grains);
	return versionOf(cwd, commit, [squad.charter, ...[...ids].map(id => run.nodes[id].grain.directory)]);
}

/** @param {import("./model.js").Squad} squad @param {unknown} raw @returns {import("./model.js").Observation} */
export function parseObservation(squad, raw) {
	const input = record(raw);
	fields(input, ["outcome", "reason", "evidence", "grains", "replace", "waitFor", "file", "receipt", "detail", "match", "offset", "ownerInput"]);
	if (!Array.isArray(input.grains)) fail("invalid_field", "Expected a list of grains");
	const grains = input.grains.map(v => "areas" in squad && typeof v !== "string" ? proposal(v) : name(v, "grain"));
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
	const target = exactTarget ?? commitAt(cwd, run.policy.target);
	if (run.goal) {
		if (review.evaluatorRevision !== run.repins?.at(-1)?.revision || run.goal.commit !== review.base || run.goal.target !== target) return false;
		const i = comparison(run, review);
		if (i?.basis) return checkpointCurrent(run, i.receipt, target) && (pendingGoal(run) || [0, 1].some(exit => exit === goalReceipt(run)?.exit));
		return goalReceipt(run)?.exit === 1;
	}
	const base = productBase(cwd, run, target);
	return base === review.base || !exactTarget && reviewVersion(cwd, run, squad, base) === review.version;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} r @param {string} [target] */
export function sameReviewInputs(cwd, run, r, target = commitAt(cwd, run.policy.target)) {
	const squad = run.policy.squads.find(s => s.id === r.squad);
	verifyContracts(cwd, run.policy, target);
	return !!squad && !run.blocker && !run.conflict && !run.join && currentReview(cwd, run, r, target) &&
		(!run.goal || !run.products.length || run.products.at(-1)?.commit === r.base) && reviewVersion(cwd, run, squad, r.base) === r.version;
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {string} id */
export function retryableReview(cwd, run, actor, id) {
	if (actor !== run.owner) fail("foreign_run", "Only the original run owner may request a fresh review");
	admitted(run);
	const history = reviews(run), r = history.find(r => r.id === id);
	if (!r || r.state !== "blocked" || r.observation || !r.workflowId || !r.callId || r.retryOf)
		fail("not_recoverable", "Expected an original blocked no-report review");
	if (!sameReviewInputs(cwd, run, r))
		fail("superseded", "No longer the current charter, evaluator and product revision");
	reviewSlot(run, actor, r.squad);
	return r;
}

/** @param {Run} run @param {string} actor @param {string} squad */
function reviewSlot(run, actor, squad) {
	const history = reviews(run);
	if (history.some(x => reading(x) && x.squad === squad) || run.effects.some(e => e.issuer === actor && e.permissionHold))
		fail("dispatch_held", "Charter still running or owner dispatch held");
	if (!availableReservations(run))
		fail("limit", "No authorized assignment or worker slot for a new review");
}

/** @param {string} cwd @param {Run} run @param {string} actor @param {NonNullable<import("./model.js").Review["iteration"]>} input */
export function reserveIteration(cwd, run, actor, input) {
	if (actor !== run.owner) fail("foreign_run", "Only the run owner can route a comparison");
	admitted(run);
	const { directory, receipt, blob } = input, at = run.goal, gap = goalReceipt(run);
	const target = commitAt(cwd, run.policy.target), checkpoint = pendingGoal(run) && checkpointCurrent(run, receipt, target);
	if (!at || !checkpoint && (at.check !== receipt || gap?.exit !== 1 || gap.commit !== at.commit) || at.target !== target ||
		run.join || run.blocker || run.conflict || run.products.length && run.products.at(-1)?.commit !== at.commit)
		fail("stale_assignment", "Use the current unmet goal receipt, or the latest passing checkpoint check ID while its goal is pending on the unchanged target");
	if (!run.artifacts?.some(a => a.blob === blob && a.to.some(dir => contains(dir, directory))))
		fail("foreign_artifact", "Comparison version was not offered to this directory");
	const squad = run.policy.squads.find(s => "areas" in s && owns(s, directory));
	if (!squad) fail("charter_scope", "Need a production directory owned by an area charter");
	if (reviews(run).some(r => r.base === at.commit && r.evaluatorRevision === run.repins?.at(-1)?.revision &&
		r.iteration?.blob === blob && r.iteration.directory === directory)) return;
	if (checkpoint && run.scheduling?.checkpointReviews === false)
		fail("dispatch_held", "New in-flight checkpoint reviews are disabled by the current scheduling policy");
	const live = Object.values(run.nodes).find(n => ["waiting", "writing", "checking", "published"].includes(n.state) &&
		(contains(n.grain.directory, directory) || contains(directory, n.grain.directory)));
	if (live) fail("dispatch_held", `Use the existing assignment ${live.grain.id} (${live.state}); do not duplicate its work.`);
	const previous = reviews(run).findLast(r => r.squad === squad.id && r.base === at.commit && r.evaluatorRevision === run.repins?.at(-1)?.revision);
	if (previous && (previous.state === "reported" || previous.state === "deferred" || previous.state === "observed" &&
		previous.observation?.outcome === "needs-decision" && previous.decision?.status !== "answered"))
		fail("dispatch_held", "The charter has an unapplied report, deferred proposal or pending decision; do not displace it.");
	reviewSlot(run, actor, squad.id);
	verifyContracts(cwd, run.policy, at.target);
	const review = reserveReview(run, actor, squad.id, at.commit, reviewVersion(cwd, run, squad, at.commit));
	review.iteration = checkpoint ? { ...input, basis: "checkpoint" } : input;
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
	if (outcome === "needs-research" && !canInvestigate(run, review, squad))
		fail("unresolved_research", "Investigation already requested on this revision; identify the remaining blocker");
	// A sibling can finish while this scout reads. On the same assessed commit, revalidate the
	// proposal against the live graph; never let an older charter review edit a newer plan.
	if (!currentReview(cwd, run, review)) {
		fail("stale_assignment", staleReviewReason);
	}
	const replaceable = new Set();
	for (const id of observation.replace ?? []) {
		const n = run.nodes[id];
		if (!n || !supersededAttempt(run, n)) continue;
		if (!remainingAssignments(run))
			fail("limit", "No assignment remains for a fresh writer on current inputs");
		const next = grains.find(g => typeof g !== "string" && g.directory === n.grain.directory);
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
	const stopped = "areas" in squad && stoppedPredecessor(run, review, observation);
	if (stopped) {
		if (!sameReviewInputs(cwd, run, review) || !remainingAssignments(run))
			fail("stale_assignment", "No current reviewed assignment is available for this directory");
		replaceable.add(stopped.grain.id);
	}
	const revision = "areas" in squad && outcome === "regenerate"
		? revise(run.nodes, squad, stopped ? { ...observation, replace: [stopped.grain.id] } : observation, review.id, replaceable) : undefined;
	const planned = revision?.nodes ?? run.nodes;
	const i = comparison(run, review);
	if (i && revision) {
		const n = planned[ids[0]];
		if (ids.length !== 1 || n.grain.directory !== i.directory || observation.replace?.some(id => run.nodes[id]?.grain.directory !== i.directory) ||
			Object.values(run.nodes).some(old => planned[old.grain.id] !== old && old.grain.directory !== i.directory))
			fail("charter_scope", `This comparison is for one independent directory: ${i.directory}`);
		if (i.basis) {
			if (revision.deferred || n.grain.revision && n.grain.revision !== review.base)
				fail("stale_assignment", "Comparison is not independent of other work or requests a different baseline");
			checkpointInputs(run, review, n, writerInputs(planned, n));
		}
	}
	if (revision) for (const g of grains) if (typeof g !== "string" && g.revision)
		verifyDirectoryPin(cwd, g.revision, g.directory);
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
			!inputs.some(g => contains(g.directory, file) || [g.specification, ...g.boundary, g.check].includes(file)))
			fail("charter_scope", `Evidence is outside this charter: ${file}`);
	}

	const packet = review.packet ?? fail("missing_packet", "Missing journaled scout packet");
	const part = packet.excerpt;
	for (const e of regularFiles(cwd, review.base, evidence))
		if (!(Object.hasOwn(packet.files, e.name) && packet.files[e.name] === e.oid) && !(part?.path === e.name && part.oid === e.oid))
			fail("unseen_evidence", `Text of ${e.name} at ${e.oid} was not delivered in this packet`);
	if (outcome === "no-gap" && packet.partial) fail("partial_coverage", "Cannot conclude no-gap from a partial packet");
	if (outcome === "needs-evidence") {
		const source = readSource(observation), history = reviews(run);
		if (!observation.file && (!source || !packet.sources?.includes(source) || observation.receipt && !(
			observation.receipt === run.goal?.check && goalReceipt(run)?.commit === review.base ||
			[...scopedNotes(run, review).values()].some(n => n.receipt === observation.receipt))))
			fail("charter_scope", "Requested source is outside this charter packet");
		if (!canContinueRead(history, review, observation))
			fail("unresolved_evidence", "No advancing cursor from the selected source");
		if (history.some(r => r.squad === review.squad && r.base === review.base && r.version === review.version &&
			r.evaluatorRevision === review.evaluatorRevision && r.wake?.key === readKey(observation)))
			fail("unresolved_evidence", "Repeated read of unchanged pinned evidence");
	}
	if (observation.file) {
		const file = observation.file, [entry] = regularFiles(cwd, review.base, [file]);
		const progress = fileProgress(reviews(run), review, file, entry.oid);
		if (Object.hasOwn(packet.files, file) || !observation.match && observation.offset === undefined && focused.has(file) && progress.kind !== "partial")
			fail("unresolved_evidence", unchangedRead(file));
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
	review.observation = observation;
	if (revision?.deferred) {
		review.state = "deferred";
		review.deferred = revision.deferred;
		return;
	}
	review.state = "observed";
	if (outcome === "needs-decision" && wakeSource(run, review)?.decision?.status === "answered")
		review.decision = { status: "unavailable", reason: "The clarification did not resolve this charter. A change to the committed contract needs a newly authorized brief." };
	if (outcome === "regenerate") {
		if ("areas" in squad) {
			for (const id of ids) {
				const pin = planned[id].grain.revision;
				if (pin) retain(cwd, pin);
			}
			run.nodes = planned;
			if (stopped) {
				review.predecessor = stopped;
				delete review.error;
			}
			if (run.goal) delete run.goal.stall;
		} else request(run, ids, review.id);
	}
}

/** @param {Run} run @param {import("./model.js").Review} review @param {Node} n @param {Node["inputs"]} pins */
function checkpointInputs(run, review, n, pins) {
	const last = run.products.at(-1);
	if (last?.commit !== review.base || !pins || Object.entries(pins).some(([id, pin]) =>
		last.outputs[id] !== pin || run.nodes[id]?.state !== "qualified" || review.packet?.outputs[id] !== pin))
		fail("stale_assignment", `The required inputs for ${n.grain.directory} must already be checked in the reviewed checkpoint`);
}

/** @param {Run["join"]} join @param {string} target @param {Record<string,string>|undefined} outputs */
function sameProduct(join, target, outputs) {
	return join?.target === target && !!outputs && digest(join.outputs) === digest(outputs);
}

/** @param {Run} run @param {string} id @param {string} reason */
function repair(run, id, reason) {
	const node = run.nodes[id];
	invalidateConsumers(run, id, node.candidate);
	if (node.repairs >= run.policy.repairs) {
		node.state = "blocked";
		node.reason = `${id}: repair limit exhausted: ${reason}`;
		return;
	}
	if (node.state === "qualified") node.replaces = node.candidate; // Repair this version without rebasing its writer.
	node.reason = reason;
	node.state = "waiting";
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
 * @param {string} cwd @param {Run} run @param {string} actor @param {number} remaining */
function settleChecks(cwd, run, actor, remaining) {
	const checks = new Map(run.effects.filter(e => e.tool === "bash").map(e => [e.id, e]));
	for (const id of Object.keys(run.nodes)) {
		const n = run.nodes[id]; // Repair can invalidate a later consumer in this same pass.
		if (n.state !== "checking" || !n.check) continue;
		const receipt = checkReceipt(checks.get(n.check));
		if (!receipt) continue;
		if (receipt.exit === 0) { n.state = "published"; delete n.reason; }
		else if (receipt.exit === null && receipt.failure !== "changed-export") { n.state = "blocked"; n.reason = `Evaluation did not complete: ${receipt.output}`; }
		else if (remaining === 0) { n.state = "blocked"; n.reason = `No assignment remains to repair ${id}: ${receipt.output || "Evaluator failed"}`; }
		else repair(run, n.grain.id, receipt.output || "Evaluator failed");
	}
	const join = run.join, check = join && checks.get(join.check);
	if (!join || !check) return;
	const receipt = checkReceipt(check);
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
	const target = commitAt(cwd, run.policy.target);
	if (!sameProduct(join, target, productOutputs(run, target, remaining))) return;
	if (receipt.exit === 0) {
		delete run.join;
		if (!run.goal) qualify(run, actor, join);
		run.products.push(join);
		for (const id of Object.keys(join.outputs)) run.nodes[id].state = "qualified";
	} else if (failure) check.error = failure;
	else if (blamed) {
		delete run.join;
		repair(run, blamed, receipt.output || "Evaluator failed");
	}
}

/** @param {string} cwd @param {Run} run @param {string} target */
function productBase(cwd, run, target) {
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
function changes(run, outputs) {
	return Object.entries(outputs).filter(([id]) => run.nodes[id].state !== "qualified").map(([id, to]) =>
		({ directory: run.nodes[id].grain.directory, from: run.nodes[id].replaces ?? text(run.nodes[id].base, "producer base"), to }));
}

/** A stopped writer may have missed a replacement prerequisite or a newer checkpoint.
 * @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base */
export function verifyRepairInputs(cwd, run, n, required, base) {
	if (!n.inputs || digest(required) !== digest(n.inputs))
		fail("stale_assignment", "The writer's pinned prerequisites are no longer current");
	const original = text(n.base, "writer base"), directory = n.grain.directory;
	if (changedFiles(cwd, n.replaces ?? original, base, [directory]).length)
		fail("stale_assignment", `The reviewed directory ${directory} changed since this assignment`);
	for (const [id, pin] of Object.entries(required)) {
		const dir = run.nodes[id].grain.directory;
		if (changedFiles(cwd, original, base, [dir]).length && changedFiles(cwd, pin, base, [dir]).length)
			fail("stale_assignment", `The reviewed input ${dir} changed since this assignment`);
	}
	const r = reviews(run).find(r => r.id === n.review);
	const supporting = r && run.policy.sharedBrief ? [...requestedFiles(run, r)].filter(file =>
		!contains(directory, file) && r.observation?.evidence.includes(file)) : [];
	if (supporting.length && changedFiles(cwd, original, base, supporting).length)
		fail("stale_assignment", "A supporting file in the writer's brief changed since this assignment");
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
	repair(run, n.grain.id, "Writer submitted changed work after an incomplete evaluation");
	validateNodes(run.nodes);
	const required = writerInputs(run.nodes, n) ?? fail("stale_assignment", "The writer's prerequisites are not ready");
	verifyRepairInputs(cwd, run, n, required, base);
	reserveWriter(cwd, run, n, required, base, actor, token);
	if (run.goal) delete run.goal.stall;
}

/** @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base @param {string} actor @param {string} [submitToken] @param {import("./model.js").Baseline} [baseline] */
export function reserveWriter(cwd, run, n, required, base, actor, submitToken, baseline) {
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
		n.state = "writing";
		n.token = token;
		if (!inline) reserveNotice(run, actor, token, "repair", baseline
			? `Read your foundry_status for ${run.id} before acting. For this attempt only, the operator approved read-only consultation of ${baseline.revision}:${baseline.directory}/ (tree ${baseline.tree}) to preserve your inventory. No other prior paths, revisions or permissions change. Join helpers and submit the complete assigned directory normally.`
			: `Read foundry_status({run:"${run.id}"}). Repair the checked failure in ${g.directory}/ if this token is still writable. Keep the original scope; join any helpers before submitting.`, n, baseline);
		return;
	}
	requireNewWork(run, g, base, required); // A pending prerequisite may have resolved since admission.
	const source = directoryBaseline(cwd, g.revision ?? base, g.directory);
	if (g.revision && !source) fail("invalid_baseline", `No prior directory at ${g.revision}:${g.directory}`);
	const deps = changes(run, required);
	n.generation = withoutGrain(cwd, deps.length ? combine(cwd, base, deps) : base, g.directory);
	if (source) {
		retain(cwd, source.revision);
		n.priorSource = source;
	}
	n.inputs = required;
	n.base = base;
	n.token = token;
	n.state = "writing";
	const review = reviews(run).find(r => r.id === n.review);
	const supporting = review && run.policy.sharedBrief ? [...requestedFiles(run, review)].filter(file =>
		!contains(g.directory, file) && review.observation?.evidence.includes(file)) : [];
	const brief = [run.policy.direction, review?.observation?.reason,
		review && researchContext(run, review),
		...("task" in g ? [`Assigned behavior: ${g.task}`, `Component check: ${g.check}`] : []),
		`Generate the complete ${g.directory}/ directory; omitted files are deleted.`,
		"Keep the host-assigned Git branch. Neither you nor your helpers may rename it with rename_branch or Git commands. For a readable title, use rename_session instead.",
		`Read ${g.specification} and ${g.boundary.join(", ")} at this base. Required outputs: ${JSON.stringify(required)}.`,
		...supporting.map(file => `Read-only supporting file: ${review?.base}:${file}`),
		takeArtifactBrief(run, n),
		"For midpoint feedback, join helpers and use foundry_preview with this token. Compare the affected behavior on that draft; do not submit just to obtain a preview.",
		...(run.goal ? [`Reviewed input revision: ${base}`] : []),
		source ? `Read prior implementation only if ${g.specification} explicitly permits it at this version, and only regular files from ${source.revision}:${g.directory}/ (tree ${source.tree}). The source is not a read grant.`
			: `No prior directory at ${base}:${g.directory}/; start empty. Do not search history for another version.`,
		"Split independent work across native in-session `task` agents in parallel. Give each a disjoint set of files under your directory or a read-only question, the permitted inputs and the same constraints; ask for results, not further delegation. Keep shared files for yourself. Work solo for small or indivisible changes, or if helpers are unavailable.",
		"Keep the token and all Foundry calls to yourself. Do not start desktop sessions, change the contract or evaluators, switch base, commit or land. Join the helpers and integrate their results before you submit. For a repair, reuse finished work; parallelize only the remaining independent pieces.",
		`From this worktree call foundry_submit({run:"${run.id}",token:"${token}"}).`].filter(Boolean).join("\n");
	reserveWorker(run, actor, token, n.generation, brief, g.agent, g.id);
}

/** Only the latest report can be reconsidered, and only for a rejection whose cause we can
 * disprove at the original pins. Admit its recorded observation, never replay the workflow.
 * @param {string} cwd @param {Run} run @param {import("./model.js").Review[]} history
 * @param {import("./model.js").Review} r @param {import("./model.js").Observation} observation */
function readmitReport(cwd, run, history, r, observation) {
	const goal = run.goal;
	if (!goal || r.base !== goal.commit || r.evaluatorRevision !== run.repins?.at(-1)?.revision || !r.workflowId || !r.callId) return;
	const released = r.error === "Writable directories must be disjoint" && stoppedPredecessor(run, r, observation);
	const unfinished = rejectedRead(history, r)?.kind === "partial";
	if ((!released && !unfinished) || !sameReviewInputs(cwd, run, r)) return;
	observe(cwd, run, r, observation);
	if (unfinished) {
		delete r.error;
		delete goal.stall;
	}
}

/** Select from ledger evidence only. Read fresh pins after each preceding reservation.
 * @param {Run} run @param {Node} node @param {import("./model.js").Review|undefined} review @param {boolean} scoped */
function writerCandidate(run, node, review, scoped) {
	const required = writerInputs(run.nodes, node);
	if (!required) return;
	const iteration = comparison(run, review);
	if (scoped && !iteration?.basis) return;
	return { required, checkpoint: iteration?.basis && iteration.receipt };
}

/** Plan on a snapshot outside the SQLite write lock; the caller compare-and-swaps the changes.
 * @param {string} cwd @param {Run} run @param {string} actor @param {boolean} discover @param {{retryGoal?:boolean,submitToken?:string}} [context] */
export function advance(cwd, run, actor, discover, context = {}) {
	if (!run.active || expired(run))
		return;
	const owner = actor === run.owner;
	if (!owner && !run.effects.some(e => e.nativeId === actor))
		return;
	notifyWriters(run, actor);
	delete run.conflict; // Recompute from the current target and live pins. Never clear a refusal to do this.
	const history = reviews(run);
	const latest = owner && run.goal ? new Map(history.map(r => [r.squad, r])) : undefined;
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
	const remaining = remainingAssignments(run);
	settleChecks(cwd, run, actor, remaining);
	let base, target;
	const tip = () => target ??= commitAt(cwd, run.policy.target);
	const startingPoint = () => base ??= productBase(cwd, run, tip());
	let scopedOnly = false;
	try {
		const admission = run.goal ? applyGoal(cwd, run, actor, tip, context.retryGoal === true) : "open";
		if (admission === "closed") return;
		scopedOnly = admission === "checkpoint";
		const reviewed = run.products.at(-1) ?? run.goal;
		if (reviewed && !run.policy.seed && reviewed.target !== tip()) {
			const edits = changedFiles(cwd, reviewed.commit, startingPoint());
			const stale = Object.values(run.nodes).filter(n => settledOutput(n) && !outside(n.grain.directory, edits));
			if (stale.length) {
				const ids = superseded(run.nodes, stale.map(n => n.grain.id));
				if (Object.values(run.nodes).some(n => !ids.has(n.grain.id) && n.state !== "idle" && liveNeeds(n).some(id => ids.has(id))))
					fail("tree_conflict", "A target edit changed a required checkpoint output");
				for (const id of ids) {
					const { grain } = run.nodes[id];
					if (grain.task) delete run.nodes[id];
					else run.nodes[id] = { grain, state: "idle", repairs: 0 };
				}
			}
		}
	} catch (error) {
		if (!(error instanceof FoundryError)) throw error;
		run.conflict = error.message;
		return;
	}
	const nodes = Object.values(run.nodes), limit = availableReservations(run, remaining);
	let reserved = 0;
	for (const n of nodes) {
		if (reserved >= limit) break;
		if (n.state !== "waiting") continue;
		const r = n.review ? history.find(r => r.id === n.review) : undefined;
		const candidate = writerCandidate(run, n, r, scopedOnly);
		if (!candidate) continue;
		const { required, checkpoint } = candidate;
		try {
			if (checkpoint && r) {
				if (!checkpointCurrent(run, checkpoint, tip())) fail("stale_assignment", "The reviewed checkpoint or target changed before staffing");
				checkpointInputs(run, r, n, required);
			}
			reserveWriter(cwd, run, n, required, run.goal?.commit ?? startingPoint(), actor, context.submitToken);
			reserved++;
		} catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			n.state = "blocked";
			n.reason = error.message;
		}
	}
	const gap = goalReceipt(run);
	const outputs = !scopedOnly && (run.join || !run.blocker) && productOutputs(run, target, remaining - reserved);
	let repeated;
	if (outputs && !sameProduct(run.join, tip(), outputs)) {
		delete run.join;
		delete run.blocker;
		try {
			for (const id of Object.keys(outputs)) {
				const n = run.nodes[id];
				if (n.state !== "published" || !comparison(run, history.find(r => r.id === n.review))?.basis) continue;
				if (stalePins(run, n).length || Object.entries(n.inputs ?? {}).some(([dep, pin]) => outputs[dep] !== pin))
					fail("stale_assignment", `A checked input of ${id} changed before integration`);
				verifyRepairInputs(cwd, run, n, n.inputs ?? {}, startingPoint());
			}
			const commit = combine(cwd, startingPoint(), changes(run, outputs), tip());
			repeated = rejectRepeat(cwd, run, tip(), commit, outputs);
			if (!repeated) reserveProduct(run, actor, cwd, tip(), commit, outputs);
		} catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			run.conflict = error.message;
			return;
		}
	}
	if (reserved === remaining) return; // Staffing stops, not receipt settlement or product/goal verification.
	const survey = run.goal ? scopedOnly || gap?.exit === 1 && run.goal.target === tip() && !(outputs && run.join && !milestoneBlocker(run))
		: !run.policy.seed && (discover || workerLimit(run) !== undefined);
	if (!survey) return;
	const applicable = history.filter(r => r.evaluatorRevision === run.repins?.at(-1)?.revision);
	const squads = discoverySquads(run, applicable, gap);
	delete run.discoveryError;
	for (const squad of squads) {
		if (reserved >= limit) break;
		const past = availableHistory(run, applicable, squad.id);
		if (!past) continue;
		const prior = past.at(-1);
		if (scopedOnly && !(prior?.state === "observed" && prior.base === run.goal?.commit &&
			prior.observation?.outcome === "needs-evidence" && comparison(run, prior)?.basis)) continue;
		let commit;
		try { commit = run.goal?.commit ?? startingPoint(); }
		catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			run.discoveryError = error.message;
			break;
		}
		const version = reviewVersion(cwd, run, squad, commit);
		const next = nextReview(run, past, commit, version);
		if (!next || scopedOnly && !next.wake) continue;
		reserveReview(run, actor, squad.id, commit, version, next.wake);
		reserved++;
	}
	// Wait for discovery only before declaring a stall, not before checking a ready product.
	if (gap?.exit !== 1 || run.blocker || run.join || nodes.some(n => actionable(run, n))) return;
	const finished = new Map(reviews(run).filter(r => r.evaluatorRevision === run.repins?.at(-1)?.revision).map(r => [r.squad, r.base === gap.commit && !reading(r)]));
	if (squads.some(s => !finished.get(s.id))) return;
	stall(run, repeated || nodes.some(n => n.state === "repeated")
		? "The proposed outputs reproduce a tree already checked against the goal." : "No actionable grain remains on this revision.", repeated || gap);
}

import { randomUUID } from "node:crypto";
import { notifyWriters, takeArtifactBrief } from "./artifacts.mjs";
import { validOutcome } from "./contract.mjs";
import { checkReceipt, goalReceipt, milestoneBlocker } from "./evidence.mjs";
import { assess, goalAllowsWork, qualify, rejectRepeat, stall } from "./goal.mjs";
import { admitted, assignmentCount, expired, reserveNotice, reserveProduct, reserveWorker } from "./native.mjs";
import { actionable, consumersOf, dependencies, liveNeeds, owns, productOutputs, proposal, requireNewWork, revise, settledOutput, stalePins, superseded, supersededAttempt, validateNodes, waiting, working, writerInputs } from "./plan.mjs";
import { changedFiles, combine, commitAt, outside, regularFiles, rejoin, retain, verifyContracts, versionOf, withoutGrain } from "./product.mjs";
import { referenceCheckout } from "./research.mjs";
import { availableHistory, blockReview, canInvestigate, discoverySquads, nextReview, reading, requestedFiles, researchContext, reserveReview, reviews, staleReviewReason, wakeSource } from "./reviews.mjs";
import { FoundryError, contains, digest, fail, fields, name, names, record, referenceRepo, relative, text, waitTarget } from "./values.mjs";

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
	fields(input, ["outcome", "reason", "evidence", "grains", "replace", "waitFor", "file", "ownerInput"]);
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
	if ((outcome === "needs-evidence") !== (input.file !== undefined)) fail("invalid_outcome", "Only needs-evidence names a file");
	const replace = names(input.replace === undefined ? [] : input.replace, "pending grain");
	if (replace.length && (outcome !== "regenerate" || !("areas" in squad))) fail("invalid_outcome", "Only area regeneration can split pending work");
	if (!Array.isArray(input.evidence) || !input.evidence.length)
		fail("no_evidence", "Identify committed evidence for the observation");
	const evidence = input.evidence.map(relative);
	return { outcome, ...(ownerInput ? { ownerInput } : {}), reason: text(input.reason, "observation"), evidence, grains, ...(replace.length ? { replace } : {}),
		...(outcome === "waiting" ? { waitFor: waitTarget(input.waitFor) } : {}),
		...(outcome === "needs-evidence" ? { file: relative(input.file) } : {}) };
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} review
 * @param {string} [exactTarget] For a clarification, require the exact reviewed product at this target tip, not just equivalent charter inputs. */
export function currentReview(cwd, run, review, exactTarget) {
	const squad = run.policy.squads.find(s => s.id === review.squad);
	if (!squad || reviews(run).findLast(r => r.squad === squad.id)?.id !== review.id) return false;
	const target = exactTarget ?? commitAt(cwd, run.policy.target);
	if (run.goal) return review.evaluatorRevision === run.repins?.at(-1)?.revision && run.goal.commit === review.base && run.goal.target === target && goalReceipt(run)?.exit === 1;
	const base = productBase(cwd, run, target);
	return base === review.base || !exactTarget && reviewVersion(cwd, run, squad, base) === review.version;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} r */
export function sameReviewInputs(cwd, run, r) {
	const squad = run.policy.squads.find(s => s.id === r.squad), target = commitAt(cwd, run.policy.target);
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
	if (history.some(x => reading(x) && x.squad === r.squad) || run.effects.some(e => e.issuer === actor && e.permissionHold))
		fail("dispatch_held", "Charter still running or owner dispatch held");
	if (run.policy.assignments !== undefined && assignmentCount(run) >= run.policy.assignments ||
		run.policy.workers !== undefined && history.filter(reading).length + Object.values(run.nodes).filter(working).length >= run.policy.workers)
		fail("limit", "No authorized assignment or worker slot for a new review");
	return r;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} review @param {import("./model.js").Observation} observation */
export function observe(cwd, run, review, observation) {
	admitted(run);
	const squad = run.policy.squads.find(s => s.id === review.squad) ?? fail("invalid_charter", "Missing charter");
	// An unspecialized question (including a report from an older workflow) is not an operator decision.
	if (!observation.findings && (observation.outcome === "unresolved" || observation.outcome === "needs-decision" && !observation.ownerInput))
		observation = { ...observation, outcome: canInvestigate(run, review, squad) ? "needs-research" : "unresolved" };
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
		if (run.policy.assignments !== undefined && assignmentCount(run) >= run.policy.assignments)
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
	const revision = "areas" in squad && outcome === "regenerate" ? revise(run.nodes, squad, observation, review.id, replaceable) : undefined;
	const planned = revision?.nodes ?? run.nodes;
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
	if (observation.file) {
		if (focused.has(observation.file) && !(part?.path === observation.file && part.end < part.length) || Object.hasOwn(packet.files, observation.file))
			fail("unresolved_evidence", `No further focused read of ${observation.file}: the pinned evidence is unchanged`);
		regularFiles(cwd, review.base, [observation.file]);
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
			run.nodes = planned;
			if (run.goal) delete run.goal.stall;
		} else request(run, ids, review.id);
	}
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
function verifyRepairInputs(cwd, run, n, required, base) {
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
	if (n.repairs >= run.policy.repairs || run.policy.assignments !== undefined && assignmentCount(run) >= run.policy.assignments ||
		run.policy.workers !== undefined && Object.values(run.nodes).filter(working).length + reviews(run).filter(reading).length >= run.policy.workers)
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

/** @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base @param {string} actor @param {string} [submitToken] */
function reserveWriter(cwd, run, n, required, base, actor, submitToken) {
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
		n.state = "writing";
		n.token = token;
		if (!inline) reserveNotice(run, actor, token, "repair",
			`Read foundry_status({run:"${run.id}"}). Repair the checked failure in ${g.directory}/ if this token is still writable. Keep the original scope; join any helpers before submitting.`, n);
		return;
	}
	requireNewWork(run, g, base, required); // A pending prerequisite may have resolved since admission.
	const deps = changes(run, required);
	n.generation = withoutGrain(cwd, deps.length ? combine(cwd, base, deps) : base, g.directory);
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
		`Read ${g.specification} and ${g.boundary.join(", ")} at this base. Required outputs: ${JSON.stringify(required)}.`,
		...supporting.map(file => `Read-only supporting file: ${review?.base}:${file}`),
		takeArtifactBrief(run, n),
		...(run.goal ? [`Reviewed input revision: ${base}`,
			`Read prior implementation only if ${g.specification} explicitly permits it, and only from ${g.directory}/ at that revision.`] : []),
		"Split independent work across native in-session `task` agents in parallel. Give each a disjoint set of files under your directory or a read-only question, the permitted inputs and the same constraints; ask for results, not further delegation. Keep shared files for yourself. Work solo for small or indivisible changes, or if helpers are unavailable.",
		"Keep the token and all Foundry calls to yourself. Do not start desktop sessions, change the contract or evaluators, switch base, commit or land. Join the helpers and integrate their results before you submit. For a repair, reuse finished work; parallelize only the remaining independent pieces.",
		`From this worktree call foundry_submit({run:"${run.id}",token:"${token}"}).`].filter(Boolean).join("\n");
	reserveWorker(run, actor, token, n.generation, brief, g.agent, g.id);
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
	for (const r of history) if (r.state === "reported" && r.observation) {
		try {
			observe(cwd, run, r, r.observation);
			if (!owner && r.observation.outcome === "needs-decision")
				reserveNotice(run, actor, r.id, "decision", `Foundry ${run.id} has a charter question for its owner at ${r.base}. This notice grants no authority.`);
		}
		catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			blockReview(r, error.message);
		}
	}
	const remaining = run.policy.assignments === undefined ? Infinity : run.policy.assignments - assignmentCount(run);
	settleChecks(cwd, run, actor, remaining);
	let base, target;
	const tip = () => target ??= commitAt(cwd, run.policy.target);
	const startingPoint = () => base ??= productBase(cwd, run, tip());
	try {
		if (run.goal && !goalAllowsWork(cwd, run, actor, tip(), context.retryGoal === true)) return;
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
	const nodes = Object.values(run.nodes), cap = run.policy.workers;
	const limit = Math.min(remaining, (cap ?? Infinity) - history.filter(reading).length - nodes.filter(working).length);
	let reserved = 0;
	for (const n of nodes) {
		if (reserved >= limit) break;
		const required = writerInputs(run.nodes, n);
		if (!required) continue;
		try {
			reserveWriter(cwd, run, n, required, run.goal?.commit ?? startingPoint(), actor, context.submitToken);
			reserved++;
		} catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			n.state = "blocked";
			n.reason = error.message;
		}
	}
	const gap = goalReceipt(run);
	const outputs = (run.join || !run.blocker) && productOutputs(run, target, remaining - reserved);
	let repeated;
	if (outputs && !sameProduct(run.join, tip(), outputs)) {
		delete run.join;
		delete run.blocker;
		try {
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
	const survey = run.goal ? gap?.exit === 1 && run.goal.target === tip() && !(outputs && run.join && !milestoneBlocker(run))
		: !run.policy.seed && (discover || cap !== undefined);
	if (!survey) return;
	const applicable = history.filter(r => r.evaluatorRevision === run.repins?.at(-1)?.revision);
	const squads = discoverySquads(run, applicable, gap);
	delete run.discoveryError;
	for (const squad of squads) {
		if (reserved >= limit) break;
		const past = availableHistory(run, applicable, squad.id);
		if (!past) continue;
		let commit;
		try { commit = run.goal?.commit ?? startingPoint(); }
		catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			run.discoveryError = error.message;
			break;
		}
		const version = reviewVersion(cwd, run, squad, commit);
		const next = nextReview(run, past, commit, version);
		if (!next) continue;
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

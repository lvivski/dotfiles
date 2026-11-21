import { randomUUID } from "node:crypto";
import { validOutcome } from "./contract.mjs";
import { checkReceipt, goalReceipt } from "./evidence.mjs";
import { assess, goalAllowsWork, qualify, rejectRepeat, stall } from "./goal.mjs";
import { admitted, expired, reserveNotice, reserveProduct, reserveWorker } from "./native.mjs";
import { checked, dependencies, liveNeeds, owns, proposal, requireNewWork, revise, settledOutput, superseded, waiting } from "./plan.mjs";
import { changedFiles, combine, commitAt, outside, regularFiles, rejoin, retain, verifyContracts, versionOf, withoutGrain } from "./product.mjs";
import { blockReview, reading, reserveReview, reviews } from "./reviews.mjs";
import { FoundryError, contains, digest, fail, fields, name, names, record, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Policy} Policy */
/** Consumers record transitive inputs, so one pass retires every assignment built on this version.
 * @param {Run} run @param {string} id @param {string|undefined} version */
function invalidateConsumers(run, id, version) {
	if (!version) return;
	for (const [key, child] of Object.entries(run.nodes))
		if (child.inputs?.[id] === version && child.state !== "blocked")
			run.nodes[key] = waiting(child.grain, child.review, child.repairs);
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
	if (policy.workers !== undefined) run.capacity = { limit: policy.workers, kept: false };
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
		return digest([commit, run.goal.tried ?? [], stopped.map(n => [n.grain.id, n.state, n.reason ?? n.candidate])]);
	}
	if (!("grains" in squad)) fail("invalid_goal", "Area charters need an assessed revision");
	const ids = dependencies(run.nodes, squad.grains);
	return versionOf(cwd, commit, [squad.charter, ...[...ids].map(id => run.nodes[id].grain.directory)]);
}

/** @param {import("./model.js").Squad} squad @param {unknown} raw @returns {import("./model.js").Observation} */
export function parseObservation(squad, raw) {
	const input = record(raw);
	fields(input, ["outcome", "reason", "evidence", "grains", "replace"]);
	if (!Array.isArray(input.grains)) fail("invalid_field", "Expected a list of grains");
	const grains = input.grains.map(v => "areas" in squad && typeof v !== "string" ? proposal(v) : name(v, "grain"));
	names(grains.map(g => typeof g === "string" ? g : g.id), "grain");
	const outcome = input.outcome;
	if (!validOutcome(outcome, grains.length))
		fail("invalid_outcome", "Expected outcome regenerate with owned grains, or no-gap/needs-decision with an empty list");
	const replace = names(input.replace === undefined ? [] : input.replace, "pending grain");
	if (replace.length && (outcome !== "regenerate" || !("areas" in squad))) fail("invalid_outcome", "Only area regeneration can split pending work");
	if (!Array.isArray(input.evidence) || !input.evidence.length)
		fail("no_evidence", "Identify committed evidence for the observation");
	const evidence = input.evidence.map(relative);
	return { outcome, reason: text(input.reason, "observation"), evidence, grains, ...(replace.length ? { replace } : {}) };
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} review */
export function currentReview(cwd, run, review) {
	const squad = run.policy.squads.find(s => s.id === review.squad);
	if (!squad || reviews(run).findLast(r => r.squad === squad.id)?.id !== review.id) return false;
	const target = commitAt(cwd, run.policy.target);
	if (run.goal) return run.goal.commit === review.base && run.goal.target === target && goalReceipt(run)?.exit === 1;
	const base = productBase(cwd, run, target);
	return base === review.base || reviewVersion(cwd, run, squad, base) === review.version;
}

/** @param {string} cwd @param {Run} run @param {import("./model.js").Review} review @param {import("./model.js").Observation} observation */
export function observe(cwd, run, review, observation) {
	admitted(run);
	const squad = run.policy.squads.find(s => s.id === review.squad) ?? fail("invalid_charter", "Missing charter");
	const { outcome, grains, evidence } = observation, ids = grains.map(g => typeof g === "string" ? g : g.id);
	// A sibling can finish while this scout reads. On the same assessed commit, revalidate the
	// proposal against the live graph; never let an older charter review edit a newer plan.
	if (!currentReview(cwd, run, review)) {
		fail("stale_assignment", "Chartered inputs changed during review");
	}
	const planned = "areas" in squad && outcome === "regenerate" ? revise(run.nodes, squad, observation, review.id) : run.nodes;
	if (run.goal?.tried && planned !== run.nodes) for (const id of ids) {
		const g = planned[id].grain;
		requireNewWork(run, g, review.base, versions(planned, dependencies(planned, g.needs)));
	}
	if ("grains" in squad && ids.some(id => !squad.grains.includes(id))) fail("charter_scope", "This observation includes another squad's grain");
	const roots = "areas" in squad ? Object.keys(planned).filter(id => owns(squad, planned[id].grain.directory)) : squad.grains;
	const inputs = [...dependencies(planned, roots)].map(id => planned[id].grain);
	for (const file of evidence) {
		if (file !== squad.charter && file !== run.policy.source && file !== run.policy.goalCheck &&
			!("areas" in squad && (owns(squad, file) || [run.policy.productCheck, ...squad.boundary, ...squad.checks].includes(file))) &&
			!inputs.some(g => contains(g.directory, file) || [g.specification, ...g.boundary, g.check].includes(file)))
			fail("charter_scope", `Evidence is outside this charter: ${file}`);
	}
	regularFiles(cwd, review.base, evidence);
	review.state = "observed";
	review.observation = observation;
	if (outcome === "regenerate") {
		if ("areas" in squad) {
			run.nodes = planned;
			if (run.goal) delete run.goal.stall;
		} else request(run, ids, review.id);
	}
}

/** @param {Run["nodes"]} nodes @param {Iterable<string>} ids */
function versions(nodes, ids) {
	/** @type {Record<string,string>} */ const result = {};
	for (const id of ids) {
		const n = nodes[id];
		if (!n?.candidate || !checked(n))
			return;
		result[id] = n.candidate;
	}
	return result;
}

/** @param {Run} run @param {string} id */
const blockedInput = (run, id) => [...dependencies(run.nodes, [id])].some(dep => run.nodes[dep]?.state === "blocked");

/** @param {Run} run @param {Node} n */
const actionable = (run, n) => n.state === "writing" || n.state === "checking" || n.state === "waiting" && !blockedInput(run, n.grain.id);

/** An evaluator can point to an existing charter, never grant new scope. If that
 * review produces no usable work, the other charters still get a turn.
 * @param {Run} run @param {import("./model.js").Receipt|undefined} gap */
function discoverySquads(run, gap) {
	const squads = run.policy.squads, focus = gap?.squad && squads.find(s => s.id === gap.squad);
	if (focus && !run.blocker) {
		const report = reviews(run).findLast(r => r.squad === focus.id && r.base === gap.commit);
		if (!report || reading(report) || Object.values(run.nodes).some(n => n.review === report.id && (n.state === "published" || actionable(run, n))))
			return [focus];
	}
	if (!gap || !run.capacity) return squads;
	// Successive early checkpoints must not always spend the first capped slot on the same squad.
	const last = new Map(reviews(run).map((r, i) => [r.squad, i]));
	return squads.toSorted((a, b) => (last.get(a.id) ?? -1) - (last.get(b.id) ?? -1));
}

/** A seed requires every requested output. In discovery, a refused grain and its
 * dependents cannot contribute a new version, but cannot veto an independent product either.
 * @param {Run} run @param {string} [target] */
function productOutputs(run, target) {
	/** @type {Record<string,string>} */ const outputs = {};
	let changed = false;
	for (const [id, n] of Object.entries(run.nodes)) {
		if (n.state === "idle") continue;
		if (checked(n)) {
			outputs[id] = text(n.candidate, "checked output");
			if (n.state === "published") changed = true;
		} else if (run.policy.seed || !blockedInput(run, id))
			return;
	}
	if (changed || run.goal && (run.goal.target !== target || !run.products.length && run.join?.commit === target)) return outputs;
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
	node.repairs++;
	node.reason = reason;
	delete node.candidate;
	node.state = "waiting";
}

/** Apply only runner-owned receipts for the current attempt. No native calls here.
 * @param {string} cwd @param {Run} run @param {string} actor */
function settleChecks(cwd, run, actor) {
	const checks = new Map(run.effects.filter(e => e.tool === "bash").map(e => [e.id, e]));
	for (const id of Object.keys(run.nodes)) {
		const n = run.nodes[id]; // Repair can invalidate a later consumer in this same pass.
		if (n.state !== "checking" || !n.check) continue;
		const receipt = checkReceipt(checks.get(n.check));
		if (!receipt) continue;
		if (receipt.exit === 0) { n.state = "published"; delete n.reason; }
		else if (receipt.exit === null) { n.state = "blocked"; n.reason = `Evaluation did not complete: ${receipt.output}`; }
		else repair(run, n.grain.id, receipt.output || "Evaluator failed");
	}
	const join = run.join, receipt = join && checkReceipt(checks.get(join.check));
	if (!join || !receipt || run.blocker) return;
	const target = commitAt(cwd, run.policy.target);
	if (!sameProduct(join, target, productOutputs(run, target))) return;
	const { exit, output, repair: grain } = receipt;
	if (exit === 0) {
		delete run.join;
		if (!run.goal) qualify(run, actor, join);
		run.products.push(join);
		for (const id of Object.keys(join.outputs)) run.nodes[id].state = "qualified";
	} else if (exit !== null && grain && Object.hasOwn(join.outputs, grain)) {
		delete run.join;
		repair(run, grain, output || "Evaluator failed");
	} else run.blocker = exit === null ? `Evaluation did not complete: ${output}` : `Product check failed without identifying a repairable output: ${output || "Evaluator failed"}`;
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

/** @param {string} cwd @param {Run} run @param {Node} n @param {Record<string,string>} required @param {string} base @param {string} actor @param {string} [submitToken] */
function reserveWriter(cwd, run, n, required, base, actor, submitToken) {
	const g = n.grain, token = randomUUID();
	const inline = n.worker === actor && submitToken !== undefined && n.token === submitToken;
	if (n.worker) {
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
	const brief = [run.policy.direction, reviews(run).find(r => r.id === n.review)?.observation?.reason,
		...("task" in g ? [`Assigned behavior: ${g.task}`, `Component check: ${g.check}`] : []),
		`Generate the complete ${g.directory}/ directory; omitted files are deleted.`,
		`Read ${g.specification} and ${g.boundary.join(", ")} at this base. Required outputs: ${JSON.stringify(required)}.`,
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
	delete run.conflict; // Recompute from the current target and live pins. Never clear a refusal to do this.
	const history = reviews(run);
	for (const r of history) if (r.state === "reported" && r.observation) {
		try {
			observe(cwd, run, r, r.observation);
			if (!owner && r.observation.outcome === "needs-decision")
				reserveNotice(run, actor, r.id, "decision", `Foundry ${run.id} has a charter question. Its owner will check the current revision and existing writer requests. This notice grants no authority.`);
		}
		catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			blockReview(r, error.message);
		}
	}
	settleChecks(cwd, run, actor);
	let base, target, waiting = 0;
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
	const nodes = Object.values(run.nodes), cap = run.capacity;
	let slots = cap ? cap.limit - history.filter(reading).length - nodes.filter(n => n.state === "writing" || n.state === "checking").length : Infinity;
	for (const n of nodes) {
		if (slots <= 0 && cap?.kept) break;
		if (n.state !== "waiting") continue;
		const required = versions(run.nodes, dependencies(run.nodes, n.grain.needs));
		if (!required) continue;
		try {
			const from = run.goal?.commit ?? startingPoint();
			if (slots <= 0) { waiting++; continue; }
			reserveWriter(cwd, run, n, required, from, actor, context.submitToken);
			slots--;
		} catch (error) {
			if (!(error instanceof FoundryError)) throw error;
			n.state = "blocked";
			n.reason = error.message;
		}
	}
	const gap = goalReceipt(run);
	const outputs = (run.join || !run.blocker) && productOutputs(run, target);
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
	const survey = run.goal ? gap?.exit === 1 && run.goal.target === tip() && !(outputs && run.join && !run.blocker)
		: !run.policy.seed && (slots > 0 ? discover : !cap?.kept);
	const squads = survey ? discoverySquads(run, gap) : [];
	if (survey) {
		delete run.discoveryError;
		for (const squad of squads) {
			if (slots <= 0 && cap?.kept) break;
			const last = history.findLast(r => r.squad === squad.id);
			if (last && reading(last) && (!run.goal || last.base === run.goal.commit)) continue;
			let commit;
			try {
				commit = run.goal?.commit ?? startingPoint();
			}
			catch (error) {
				if (!(error instanceof FoundryError)) throw error;
				run.discoveryError = error.message;
				break;
			}
			const version = reviewVersion(cwd, run, squad, commit);
			if (run.goal ? history.some(r => r.squad === squad.id && r.version === version) : last?.version === version)
				continue;
			if (slots <= 0) { waiting++; continue; }
			reserveReview(run, actor, squad.id, commit, version);
			slots--;
		}
	}
	if (cap) {
		if (!waiting) delete cap.offer;
		else if (cap.offer) cap.offer.to = cap.limit + waiting;
		else if (!cap.kept) {
			const id = randomUUID();
			cap.offer = { id, to: cap.limit + waiting };
			if (!owner) reserveNotice(run, actor, id, "capacity", "Ready work is waiting at the worker cap. The owner session will present the choice if it is still needed. This notice does not authorize an increase.");
		}
	}
	// Wait for discovery only before declaring a stall, not before checking a ready product.
	if (!survey || gap?.exit !== 1 || run.blocker || run.join ||
		squads.some(s => {
			const last = reviews(run).findLast(r => r.squad === s.id);
			return last?.base !== gap.commit || reading(last);
		}) ||
		nodes.some(n => actionable(run, n))) return;
	stall(run, repeated || nodes.some(n => n.state === "repeated")
		? "The proposed outputs reproduce a tree already checked against the goal." : "No actionable grain remains on this revision.", repeated || gap);
}

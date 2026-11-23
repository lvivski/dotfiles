import { validateGraph } from "./contract.mjs";
import { blockedComponent, checkReceipt, missingInput } from "./evidence.mjs";
import { outside } from "./product.mjs";
import { assignmentDirectory, contains, digest, fail, fields, name, names, record, relative, text } from "./values.mjs";

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Proposal} Proposal */
/** @typedef {import("./model.js").Area} Area */
/** @param {Area} squad @param {string} directory */
export const owns = (squad, directory) => squad.areas.some(root => contains(root, directory));

/** @param {import("./model.js").Grain} grain @param {string} [review] @param {number} [repairs] @returns {Node} */
export const waiting = (grain, review, repairs = 0) => ({ grain, state: "waiting", repairs, ...(review ? { review } : {}) });

/** A published output still owns its directory until the combined tree is assessed.
 * @param {Node} n */
export const settledOutput = n => n.state === "qualified" || n.state === "repeated";
/** @param {Node} n */
export const checked = n => settledOutput(n) || n.state === "published";

/** @param {Run} run @param {Node} n */
export const stalePins = (run, n) => Object.entries(n.inputs ?? {}).filter(([id, pin]) =>
	run.nodes[id]?.candidate !== pin || !checked(run.nodes[id]));

/** A current terminal check is history, not authority to replay it. A changed
 * prerequisite can instead justify a newly reviewed assignment.
 * @param {Run} run @param {Node} n */
export function supersededAttempt(run, n) {
	if (n.state !== "blocked" || !n.worker || !n.generation || !n.check || n.repairs >= run.policy.repairs) return;
	const stale = stalePins(run, n);
	if (stale.length && !run.effects.some(e => e.grain === n.grain.id && ["component", "writer", "repair"].includes(e.kind) &&
		e.state !== "done" && e.state !== "refused") && blockedComponent(n, run.effects.find(e => e.id === n.check)))
		return { check: n.check, staleInputs: Object.fromEntries(stale) };
}

/** A terminal assignment keeps its original brief and pins as history, not prerequisites.
 * @param {Node} n */
export const liveNeeds = n => n.state === "blocked" ? [] : n.grain.needs;

/** @param {Node|undefined} n @param {import("./model.js").Effect} e */
export function targetsWriter(n, e) {
	return n?.state === "writing" && n.token === e.token && (e.tool !== "session.send" || e.issuer === n.worker);
}

/** A reference offer that never reached a native call cannot keep its former writer's directory.
 * Keep the reservation in the journal; a held, prepared, issued or uncertain call is not obsolete.
 * @param {Node} n @param {import("./model.js").Effect} e */
function obsoleteOffer(n, e) {
	if (e.kind !== "artifact" || e.state !== "ready" || targetsWriter(n, e)) return false;
	return e.callId === undefined && e.permissionHold === undefined && e.error === undefined;
}

/** @param {Run} run @param {Node} n */
export const assignmentCalls = (run, n) => run.effects.filter(e => e.grain === n.grain.id && !obsoleteOffer(n, e));

/** A writer's own missing-input stop releases no files. Only a different job at a later
 * checkpoint may take exactly this directory; unresolved native calls still own it.
 * @param {Run} run @param {import("./model.js").Review} review @param {import("./model.js").Observation} report */
export function stoppedPredecessor(run, review, report) {
	const [g] = report.grains;
	if (report.outcome !== "regenerate" || report.grains.length !== 1 || typeof g !== "object" || run.nodes[g.id] ||
		run.effects.some(e => e.grain === g.id) || !review.packet || review.retryOf) return;
	const n = Object.values(run.nodes).find(n => n.grain.directory === g.directory);
	if (!n || missingInput(n) === undefined || n.candidate ||
		!n.worker || !n.base || !n.token || !n.generation || n.base === review.base || n.grain.check !== g.check ||
		g.task === n.grain.task || report.replace?.some(id => id !== n.grain.id) ||
		Object.values(run.nodes).some(other => liveNeeds(other).includes(n.grain.id) || other.state !== "blocked" && Object.hasOwn(other.inputs ?? {}, n.grain.id))) return;
	const calls = assignmentCalls(run, n), launches = calls.filter(e => e.kind === "writer");
	if (launches.length !== 1 || !launches[0].callId || launches[0].nativeId !== n.worker || launches[0].args.base_branch !== n.generation ||
		calls.some(e => e.state !== "done" || e.permissionHold || e.error)) return;
	const repaired = calls.some(e => e.kind === "component" && e.id === n.check && e.issuer === n.worker && checkReceipt(e) && e.inlineRepair === n.token ||
		e.kind === "repair" && e.token === n.token && (e.args.session_id === n.worker || e.tool === "session.send" && e.issuer === n.worker));
	if (launches[0].token !== n.token && !repaired || g.needs.some(id => !run.nodes[id])) return;
	const deps = writerInputs(run.nodes, waiting({ ...n.grain, needs: g.needs }));
	if (deps && Object.entries(deps).every(([id, pin]) => run.nodes[id].state === "qualified" && review.packet?.outputs[id] === pin))
		return n;
}
/** @param {Run["nodes"]} nodes @param {Iterable<string>} roots */
export function dependencies(nodes, roots) {
	const ids = new Set(roots);
	for (const id of ids) {
		const n = nodes[id] ?? fail("unknown_grain", `Missing required output: ${id}`);
		for (const dep of liveNeeds(n)) ids.add(dep);
	}
	return ids;
}

/** Undefined means not ready; an empty map is a ready writer with no prerequisites.
 * @param {Run["nodes"]} nodes @param {Node} n */
export function writerInputs(nodes, n) {
	if (n.state !== "waiting") return;
	/** @type {Record<string,string>} */ const pins = {};
	for (const id of dependencies(nodes, n.grain.needs)) {
		const input = nodes[id];
		if (!input.candidate || !checked(input)) return;
		pins[id] = input.candidate;
	}
	return pins;
}

/** @param {Node} n */
export const working = n => n.state === "writing" || n.state === "checking";
/** @param {Run} run @param {Node} n */
const blockedInput = (run, n) => [...dependencies(run.nodes, [n.grain.id])].some(id => run.nodes[id].state === "blocked");
/** @param {Run} run @param {Node} n */
export const actionable = (run, n) => working(n) || n.state === "waiting" && !blockedInput(run, n);

/** A seed needs every requested output. In discovery, blocked or unfunded work
 * cannot veto verification of an independent checked output.
 * @param {Run} run @param {string|undefined} target @param {number} remaining */
export function productOutputs(run, target, remaining) {
	/** @type {Record<string,string>} */ const outputs = {};
	let changed = false;
	for (const n of Object.values(run.nodes)) {
		if (n.state === "idle") continue;
		if (!run.policy.seed && remaining === 0 && n.state === "waiting") continue;
		if (checked(n)) {
			outputs[n.grain.id] = text(n.candidate, "checked output");
			if (n.state === "published") changed = true;
		} else if (run.policy.seed || !blockedInput(run, n)) return;
	}
	if (changed || run.goal && (run.goal.target !== target || !run.products.length && run.join?.commit === target)) return outputs;
}

/** @param {Run["nodes"]} nodes */
export const validateNodes = nodes => validateGraph(Object.values(nodes).map(n => ({ ...n.grain, needs: liveNeeds(n) })));

/** A new token, report, or label does not change the job. The charter pins the spec and interface for this directory.
 * @param {Node["grain"]} g @param {string} base @param {Node["inputs"]} inputs */
export const workKey = (g, base, inputs) => digest([base, g.directory, g.task, g.check, [...g.needs].sort(), inputs, ...(g.revision && g.revision !== base ? [g.revision] : [])]);

/** @param {Run} run @param {Node["grain"]} g @param {string} base @param {Node["inputs"]} inputs */
export function requireNewWork(run, g, base, inputs) {
	if (inputs && run.goal?.tried?.includes(workKey(g, base, inputs)))
		fail("no_progress", `${g.directory}: this assignment with these inputs already reproduced a failing tree. Reuse its checked output or propose different work.`);
}

/** Inputs include transitive versions. Blocked assignments keep their pins only as history.
 * @param {Run["nodes"]} current @param {Record<string,string>} pins */
export function consumersOf(current, pins) {
	const versions = Object.entries(pins);
	return Object.values(current).filter(n => n.state !== "blocked" && versions.some(([id, version]) => n.inputs?.[id] === version));
}

/** Project retirement for validation only; a live consumer vetoes applying the entire change.
 * @param {Run["nodes"]} current @param {Iterable<string>} ids */
function retirement(current, ids) {
	const remove = new Set(ids), pins = Object.fromEntries([...remove].filter(id => settledOutput(current[id]))
		.map(id => [id, text(current[id].candidate, "checked output")]));
	const consumers = [];
	for (const n of consumersOf(current, pins)) {
		if (!settledOutput(n)) consumers.push(n.grain.id);
		remove.add(n.grain.id);
	}
	return { remove, deferred: consumers.length ? { pins, consumers } : undefined };
}

/** @param {Run["nodes"]} current @param {Iterable<string>} ids */
export function superseded(current, ids) {
	const { remove, deferred } = retirement(current, ids);
	if (deferred) fail("frozen_assignment", `A current assignment still consumes a superseded output: ${deferred.consumers.join(", ")}`);
	return remove;
}

/** @param {unknown} value @returns {Proposal} */
export function proposal(value) {
	const g = record(value);
	fields(g, ["id", "task", "directory", "check", "needs"]);
	return { id: name(g.id, "grain"), task: text(g.task, "missing behavior"), ...assignmentDirectory(g.directory),
		check: relative(g.check), needs: names(g.needs === undefined ? [] : g.needs, "required output") };
}

/** @param {Run["nodes"]} current @param {(string|import("./model.js").Output)[]} grains */
export function displacedInputs(current, grains) {
	const added = new Set(grains.map(g => typeof g === "string" ? g : g.id));
	for (const g of grains) if (typeof g !== "string") {
		const lost = g.needs.filter(id => !added.has(id) && current[id] && settledOutput(current[id]) && !outside(g.directory, [current[id].grain.directory]));
		if (lost.length) return { lost, reason: `${g.id} would own ${g.directory} and retire its required checked output(s): ${lost.map(id => `${id} (${current[id].grain.directory})`).join(", ")}. Use a disjoint directory to consume these outputs, or propose a complete replacement that does not require them.` };
	}
}

/** Check the entire replacement before changing any node, including consumers in other charters.
 * @param {Run["nodes"]} current @param {Area} squad @param {import("./model.js").Observation} report @param {string} review @param {Set<string>} [replaceable] */
export function revise(current, squad, report, review, replaceable = new Set()) {
	const remove = new Set(report.replace);
	for (const id of remove) {
		const n = current[id] ?? fail("unknown_grain", `No such assignment: ${id}`);
		if (!owns(squad, n.grain.directory)) fail("charter_scope", `Not your grain: ${id}`);
		if (!replaceable.has(id) && !settledOutput(n) && (n.generation || n.state !== "waiting" && n.state !== "blocked"))
			fail("frozen_assignment", `Only settled outputs or never reserved work can be split: ${id}`);
	}
	const added = report.grains.map(g => {
		const id = typeof g === "string" ? g : g.id;
		const old = current[id];
		if (old && !owns(squad, old.grain.directory)) fail("charter_scope", `Not your grain: ${id}`);
		if (old && !settledOutput(old) && !remove.has(id)) fail("frozen_assignment", `Cannot redefine an assigned grain: ${id}`);
		if (typeof g === "string") return old?.grain ?? fail("unknown_grain", `No checkpoint output named ${id}`);
		if (!owns(squad, g.directory) || !squad.checks.includes(g.check))
			fail("charter_scope", `Directory or component check is outside ${squad.id}'s charter: ${g.directory}, ${g.check}`);
		return { ...g, specification: squad.charter, boundary: squad.boundary, ...(squad.agent ? { agent: squad.agent } : {}) };
	});
	const dirs = added.map(g => g.directory);
	for (const n of Object.values(current))
		if (settledOutput(n) && (added.some(g => g.id === n.grain.id) || !outside(n.grain.directory, dirs))) remove.add(n.grain.id);
	const nodes = { ...current };
	const retired = retirement(current, remove);
	// If issued, downstream waiters will inherit the vetoing consumer's pins too.
	// Project their retirement for validation only; the live graph stays intact.
	if (retired.deferred) {
		const consumers = new Set(retired.deferred.consumers);
		for (const n of Object.values(current))
			if (n.state === "waiting" && !n.generation && [...dependencies(current, n.grain.needs)].some(id => consumers.has(id)))
				retired.remove.add(n.grain.id);
	}
	for (const id of retired.remove) delete nodes[id];
	for (const g of added) nodes[g.id] = waiting(g, review);
	const conflict = displacedInputs(current, added);
	if (conflict) fail("displaced_input", conflict.reason);
	validateNodes(nodes);
	return { nodes, deferred: retired.deferred };
}

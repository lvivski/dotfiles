import { validateGraph } from "./contract.mjs";
import { outside } from "./product.mjs";
import { contains, digest, fail, fields, name, names, record, relative, text } from "./values.mjs";

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

/** A terminal assignment keeps its original brief and pins as history, not prerequisites.
 * @param {Node} n */
export const liveNeeds = n => n.state === "blocked" ? [] : n.grain.needs;
/** @param {Run["nodes"]} nodes @param {Iterable<string>} roots */
export function dependencies(nodes, roots) {
	const ids = new Set(roots);
	for (const id of ids) {
		const n = nodes[id] ?? fail("unknown_grain", `Missing required output: ${id}`);
		for (const dep of liveNeeds(n)) ids.add(dep);
	}
	return ids;
}

/** @param {Run["nodes"]} nodes */
export const validateNodes = nodes => validateGraph(Object.values(nodes).map(n => ({ ...n.grain, needs: liveNeeds(n) })));

/** A new token, report, or label does not change the job. The charter pins the spec and interface for this directory.
 * @param {Node["grain"]} g @param {string} base @param {Node["inputs"]} inputs */
export const workKey = (g, base, inputs) => digest([base, g.directory, g.task, g.check, [...g.needs].sort(), inputs]);

/** @param {Run} run @param {Node["grain"]} g @param {string} base @param {Node["inputs"]} inputs */
export function requireNewWork(run, g, base, inputs) {
	if (inputs && run.goal?.tried?.includes(workKey(g, base, inputs)))
		fail("no_progress", `${g.directory}: this assignment with these inputs already reproduced a failing tree. Reuse its checked output or propose different work.`);
}

/** An assignment's inputs already include transitive versions. Never discard an issued consumer.
 * @param {Run["nodes"]} current @param {Iterable<string>} ids */
export function superseded(current, ids) {
	const remove = new Set(ids), retired = [...remove].filter(id => settledOutput(current[id]));
	for (const n of Object.values(current)) {
		if (n.state === "blocked" || !retired.some(id => n.inputs?.[id] === current[id].candidate)) continue;
		if (!settledOutput(n)) fail("frozen_assignment", `A current assignment still consumes a superseded output: ${n.grain.id}`);
		remove.add(n.grain.id);
	}
	return remove;
}

/** @param {unknown} value @returns {Proposal} */
export function proposal(value) {
	const g = record(value);
	fields(g, ["id", "task", "directory", "check", "needs"]);
	return { id: name(g.id, "grain"), task: text(g.task, "missing behavior"), directory: relative(g.directory),
		check: relative(g.check), needs: names(g.needs === undefined ? [] : g.needs, "required output") };
}

/** Check the entire replacement before changing any node, including consumers in other charters.
 * @param {Run["nodes"]} current @param {Area} squad @param {import("./model.js").Observation} report @param {string} review */
export function revise(current, squad, report, review) {
	const remove = new Set(report.replace);
	for (const id of remove) {
		const n = current[id] ?? fail("unknown_grain", `No such assignment: ${id}`);
		if (!owns(squad, n.grain.directory)) fail("charter_scope", `Not your grain: ${id}`);
		if (!settledOutput(n) && (n.generation || n.state !== "waiting" && n.state !== "blocked"))
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
	for (const id of superseded(current, remove)) delete nodes[id];
	for (const g of added) nodes[g.id] = waiting(g, review);
	validateNodes(nodes);
	return nodes;
}

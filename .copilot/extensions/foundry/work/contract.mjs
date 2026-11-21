import { commitAt, committedFile, outside, regularFiles } from "./product.mjs";
import { fail, fields, integer, name, names, record, relative, text } from "./values.mjs";

/** @param {unknown} outcome @param {number} grains @returns {outcome is import("./model.js").Observation["outcome"]} */
export const validOutcome = (outcome, grains) => grains > 0 ? outcome === "regenerate" :
	outcome === "no-gap" || outcome === "needs-decision" || outcome === "waiting" || outcome === "needs-evidence";

/** @param {unknown} value @param {string} label */
function list(value, label) {
	if (!Array.isArray(value) || !value.length)
		fail("incomplete_contract", `Expected nonempty ${label}`);
	return value;
}

/** @param {string[]} directories */
function disjoint(directories) {
	const roots = directories.map(dir => `${dir.normalize("NFC").toLowerCase()}/`).sort();
	for (const [i, dir] of roots.entries()) {
		if (dir.startsWith(".foundry/")) fail("contract_scope", "Implementation cannot own .foundry");
		if (i && dir.startsWith(roots[i - 1])) fail("overlapping_ownership", "Writable directories must be disjoint");
	}
}

/** @param {import("./model.js").Output[]} grains */
export function validateGraph(grains) {
	const ids = names(grains.map(g => g.id), "grain");
	disjoint(grains.map(g => g.directory));
	const byId = new Map(grains.map(g => [g.id, g]));
	const complete = new Set(), pending = new Set();
	/** @param {string} id */
	function visit(id) {
		if (complete.has(id))
			return;
		if (pending.has(id))
			fail("dependency_cycle", `Output cycle at ${id}`);
		const g = byId.get(id);
		if (!g)
			fail("unknown_grain", `Unknown required output: ${id}`);
		pending.add(id);
		g.needs.forEach(visit);
		pending.delete(id);
		complete.add(id);
	}
	ids.forEach(visit);
}

/** @param {Record<string,unknown>} row */
function fixed(row) {
	const grains = list(row.grains, "grains").map(v => {
		const g = record(v);
		fields(g, ["id", "directory", "specification", "boundary", "check", "needs"]);
		return { id: name(g.id, "grain"), directory: relative(g.directory), specification: relative(g.specification),
			boundary: list(g.boundary, "boundary files").map(relative), check: relative(g.check), needs: names(g.needs ?? [], "required output") };
	});
	validateGraph(grains);
	const known = new Set(grains.map(g => g.id));
	if (!Array.isArray(row.squads ?? [])) fail("invalid_charter", "Expected flat squads");
	const squads = (Array.isArray(row.squads) ? row.squads : []).map(v => {
		const s = record(v);
		fields(s, ["id", "charter", "grains", "agent"]);
		const allowed = names(s.grains, "chartered grain");
		if (!allowed.length || allowed.some(id => !known.has(id)))
			fail("invalid_charter", "Each squad needs actual grain outputs");
		return { id: name(s.id, "squad"), charter: relative(s.charter), grains: allowed, ...(s.agent === undefined ? {} : { agent: text(s.agent, "native agent") }) };
	});
	names(squads.flatMap(s => s.grains), "chartered producer");
	const seed = row.seed === undefined ? undefined : names(row.seed, "seed grain");
	if (seed && (!seed.length || seed.some(id => !known.has(id))) || !seed && !squads.length)
		fail("invalid_seed", "Supply a nonempty seed or discovery squad");
	if (!seed && grains.some(g => !squads.some(s => s.grains.includes(g.id))))
		fail("invalid_charter", "Every output needs a chartered producer");
	return { squads, grains, ...(seed ? { seed } : {}) };
}

/** @param {Record<string,unknown>} row */
function chartered(row) {
	if (!row.goalCheck) fail("invalid_goal", "Area charters require a final goal check");
	const squads = list(row.squads, "area charters").map(v => {
		const s = record(v);
		fields(s, ["id", "charter", "agent", "areas", "boundary", "checks"]);
		return { id: name(s.id, "squad"), charter: relative(s.charter), areas: list(s.areas, "writable areas").map(relative),
			boundary: list(s.boundary, "boundary files").map(relative), checks: list(s.checks, "component checks").map(relative),
			...(s.agent === undefined ? {} : { agent: text(s.agent, "native agent") }) };
	});
	disjoint(squads.flatMap(s => s.areas));
	return { squads, grains: [], seed: undefined };
}

/** @param {string} cwd @param {unknown} source @returns {{policy:import("./model.js").Policy, grains:import("./model.js").Grain[]}} */
export function readPolicy(cwd, source) {
	const filename = relative(source);
	if (!filename.startsWith(".foundry/"))
		fail("contract_scope", "Start from a committed .foundry policy");
	const base = commitAt(cwd, "HEAD"), row = record(JSON.parse(committedFile(cwd, base, filename).toString()));
	if (row.version !== 1 && row.version !== 2)
		fail("unsupported_contract", "Expected Foundry contract version 1 or 2");
	fields(row, ["version", "id", "direction", "target", "productCheck", "goalCheck", "squads", "limits", ...(row.version === 1 ? ["grains", "seed"] : [])]);
	const target = text(row.target, "full local target ref");
	if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target) || target.includes("..") || target.endsWith(".lock"))
		fail("invalid_target", "Expected a literal local branch");
	commitAt(cwd, target);
	const productCheck = relative(row.productCheck);
	const goalCheck = row.goalCheck === undefined ? undefined : relative(row.goalCheck);
	if (goalCheck && !outside(goalCheck, [productCheck]))
		fail("invalid_goal", "Use distinct checks for a milestone and the final goal");
	if (goalCheck && row.seed !== undefined)
		fail("invalid_goal", "seed selects a one-off; omit seed and use squads for a final goal");
	const limits = row.limits === undefined ? {} : record(row.limits);
	fields(limits, ["workers", "assignments", "repairs", "deadline"]);
	const { workers, assignments, repairs = 1 } = limits;
	const deadline = limits.deadline === undefined ? undefined : text(limits.deadline, "ISO deadline");
	if (deadline && !Number.isFinite(Date.parse(deadline)))
		fail("invalid_limit", "Invalid deadline");
	const { squads, grains, seed } = row.version === 1 ? fixed(row) : chartered(row);
	names(squads.map(s => s.id), "squad");
	const files = [...new Set([filename, productCheck, ...(goalCheck ? [goalCheck] : []), ...grains.flatMap(g => [g.specification, ...g.boundary, g.check]),
		...squads.flatMap(s => "areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter])])];
	const writable = [...grains.map(g => g.directory), ...squads.flatMap(s => "areas" in s ? s.areas : [])];
	for (const file of files)
		if (!outside(file, writable)) fail("contract_scope", `Conserved file overlaps a writable directory: ${file}`);
	regularFiles(cwd, base, files);
	const policy = {
		id: name(row.id, "policy ID"), direction: text(row.direction, "engineering direction"), source: filename, target, base, productCheck,
		files, squads, ...(seed ? { seed } : {}),
		...(goalCheck ? { goalCheck } : {}),
		...(workers === undefined ? {} : { workers: integer(workers, 1, "worker limit") }),
		...(assignments === undefined ? {} : { assignments: integer(assignments, 0, "total assignment limit") }),
		repairs: integer(repairs, 0, "repair limit"), ...(deadline ? { deadline } : {})
	};
	return { policy, grains: grains.map(g => {
		const agent = squads.find(s => "grains" in s && s.grains.includes(g.id))?.agent;
		return agent ? { ...g, agent } : g;
	}) };
}

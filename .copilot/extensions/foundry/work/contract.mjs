import { commitAt, committedFile, outside, regularFiles } from "./product.mjs";
import { fail, fields, integer, name, names, record, relative, text } from "./values.mjs";

/** @param {unknown} outcome @param {number} grains @returns {outcome is import("./model.js").Observation["outcome"]} */
export const validOutcome = (outcome, grains) => grains > 0 ? outcome === "regenerate" : outcome === "no-gap" || outcome === "needs-decision";

/** @param {unknown} value @param {string} label */
function list(value, label) {
	if (!Array.isArray(value) || !value.length)
		fail("incomplete_contract", `Expected nonempty ${label}`);
	return value;
}

/** @param {string} cwd @param {unknown} source @returns {import("./model.js").Policy} */
export function readPolicy(cwd, source) {
	const filename = relative(source);
	if (!filename.startsWith(".foundry/"))
		fail("contract_scope", "Start from a committed .foundry policy");
	const base = commitAt(cwd, "HEAD"), row = record(JSON.parse(committedFile(cwd, base, filename).toString()));
	fields(row, ["version", "id", "direction", "target", "productCheck", "grains", "squads", "limits", "seed"]);
	if (row.version !== 1)
		fail("unsupported_contract", "Expected a Foundry graph version 1");
	const target = text(row.target, "full local target ref");
	if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(target) || target.includes("..") || target.endsWith(".lock"))
		fail("invalid_target", "Expected a literal local branch");
	commitAt(cwd, target);
	const grains = list(row.grains, "grains").map(v => {
		const g = record(v);
		fields(g, ["id", "directory", "specification", "boundary", "check", "needs"]);
		const directory = relative(g.directory);
		if (directory.toLowerCase().split("/")[0] === ".foundry")
			fail("contract_scope", "Implementation cannot own .foundry");
		return {
			id: name(g.id, "grain"), directory, specification: relative(g.specification),
			boundary: list(g.boundary, "boundary files").map(relative), check: relative(g.check), needs: names(g.needs ?? [], "required output")
		};
	});
	const ids = grains.map(g => g.id);
	names(ids, "grain");
	for (const g of grains)
		if (!outside(g.directory, grains.filter(o => o !== g).map(o => o.directory)))
			fail("overlapping_ownership", "Grain directories must be disjoint");
	const complete = new Set(), pending = new Set();
	/** @param {string} id */
	function visit(id) {
		if (complete.has(id))
			return;
		if (pending.has(id))
			fail("dependency_cycle", `Output cycle at ${id}`);
		const g = grains.find(g => g.id === id);
		if (!g)
			fail("unknown_grain", `Unknown required output: ${id}`);
		pending.add(id);
		g.needs.forEach(visit);
		pending.delete(id);
		complete.add(id);
	}
	ids.forEach(visit);
	if (!Array.isArray(row.squads ?? []))
		fail("invalid_charter", "Expected flat squads");
	const squads = (Array.isArray(row.squads) ? row.squads : []).map(v => {
		const s = record(v);
		fields(s, ["id", "charter", "grains", "agent"]);
		const allowed = names(s.grains, "chartered grain");
		if (!allowed.length || allowed.some(id => !complete.has(id)))
			fail("invalid_charter", "Each squad needs actual grain outputs");
		return { id: name(s.id, "squad"), charter: relative(s.charter), grains: allowed, ...(s.agent === undefined ? {} : { agent: text(s.agent, "native agent") }) };
	});
	names(squads.map(s => s.id), "squad");
	names(squads.flatMap(s => s.grains), "chartered producer");
	const seed = row.seed === undefined ? undefined : names(row.seed, "seed grain");
	if (seed && (!seed.length || seed.some(id => !complete.has(id))) || !seed && !squads.length)
		fail("invalid_seed", "Supply a nonempty seed or discovery squad");
	if (!seed && grains.some(g => !squads.some(s => s.grains.includes(g.id))))
		fail("invalid_charter", "Every output needs a chartered producer");
	const limits = record(row.limits);
	fields(limits, ["workers", "repairs", "deadline"]);
	const deadline = limits.deadline === undefined ? undefined : text(limits.deadline, "ISO deadline");
	if (deadline && !Number.isFinite(Date.parse(deadline)))
		fail("invalid_limit", "Invalid deadline");
	const productCheck = relative(row.productCheck);
	const files = [...new Set([filename, productCheck, ...grains.flatMap(g => [g.specification, ...g.boundary, g.check]), ...squads.map(s => s.charter)])];
	for (const file of files) {
		if (grains.some(g => !outside(g.directory, [file])))
			fail("contract_scope", `Conserved file overlaps a writable grain: ${file}`);
	}
	regularFiles(cwd, base, files);
	return {
		id: name(row.id, "policy ID"), direction: text(row.direction, "engineering direction"), source: filename, target, base, productCheck, grains, squads,
		workers: integer(limits.workers, 1, "worker limit"), repairs: integer(limits.repairs, 0, "repair limit"), ...(deadline ? { deadline } : {}), ...(seed ? { seed } : {})
	};
}

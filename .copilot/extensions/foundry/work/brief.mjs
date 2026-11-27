import { planDirectory } from "./contract.mjs";
import { fixed, list } from "./fixed.mjs";
export { validateGraph, verifyFixedGrant } from "./fixed.mjs";
import { blobText, commitAt, committedFile, git, outside, regularFiles, verifyDirectoryPin } from "./product.mjs";
import { deadlineAt, disjoint, fail, fields, integer, roots, name, names, record, relative, text } from "./values.mjs";

/** @param {string} cwd @param {{name:string,oid:string}} entry */
export function journeyText(cwd, entry) {
	const bytes = git(cwd, ["cat-file", "blob", entry.oid]);
	const content=blobText(bytes);
	if (!content?.trim()) fail("invalid_brief", `${entry.name} must be nonempty UTF-8 text`);
	return content;
}

/** @param {Record<string,unknown>} row @param {string} filename */
function chartered(row, filename) {
	if (!row.goalCheck) fail("invalid_goal", "Area charters require a final goal check");
	const charters = list(row.squads, "area charters").map(record);
	const sharedBrief = charters.every(s => s.boundary === undefined) ? `${planDirectory(filename)}/journey.md` : undefined;
	const squads = charters.map(s => {
		fields(s, ["id", "charter", "agent", "areas", "boundary", "checks", "researchAgent"]);
		return { id: name(s.id, "squad"), charter: relative(s.charter), areas: list(s.areas, "writable areas").map(relative),
			boundary: sharedBrief ? [sharedBrief] : list(s.boundary, "boundary files").map(relative), checks: list(s.checks, "component checks").map(relative),
			...(s.researchAgent === undefined ? {} : { researchAgent: name(s.researchAgent, "research agent profile") }),
			...(s.agent === undefined ? {} : { agent: text(s.agent, "native agent") }) };
	});
	disjoint(squads.flatMap(s => s.areas));
	return { squads, grains: [], seed: undefined, sharedBrief };
}

/** @param {string} cwd @param {unknown} source @returns {{policy:import("./model.js").Policy, grains:import("./model.js").Grain[]}} */
export function readPolicy(cwd, source) {
	const filename = relative(source);
	if (!filename.startsWith(".foundry/"))
		fail("contract_scope", "Start from a committed .foundry policy");
	const base = commitAt(cwd, "HEAD"), row = record(JSON.parse(committedFile(cwd, base, filename).toString()));
	if (row.version !== 1 && row.version !== 2)
		fail("unsupported_contract", "Expected Foundry contract version 1 or 2");
	fields(row, ["version", "id", "direction", "target", "productCheck", "goalCheck", "squads", "limits", ...(row.version === 1 ? ["grains", "seed"] : ["ownership"])]);
	if (row.ownership !== undefined && row.ownership !== "exact-files" && row.ownership !== "retain-except-transferred") fail("invalid_charter","Unknown product ownership interface");
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
	if (deadline && deadlineAt(deadline) === undefined)
		fail("invalid_limit", "Deadline must be an ISO timestamp with an explicit Z or numeric UTC offset");
	const contract = row.version === 1 ? fixed(row) : chartered(row, filename);
	const { squads, grains, seed } = contract;
	const sharedBrief = "sharedBrief" in contract ? contract.sharedBrief : undefined;
	names(squads.map(s => s.id), "squad");
	const files = [...new Set([filename, productCheck, ...(goalCheck ? [goalCheck] : []), ...grains.flatMap(g => [g.specification, ...g.boundary, g.check]),
		...squads.flatMap(s => "areas" in s ? [s.charter, ...s.boundary, ...s.checks] : [s.charter])])];
	const writable = [...grains.flatMap(g => roots(g.directory)), ...squads.flatMap(s => "areas" in s ? s.areas : [])];
	for (const g of grains) if (g.revision) for (const dir of roots(g.directory)) verifyDirectoryPin(cwd, g.revision, dir);
	for (const file of files)
		if (!outside(file, writable)) fail("contract_scope", `Conserved file overlaps a writable directory: ${file}`);
	const pinned = regularFiles(cwd, base, files);
	if (sharedBrief) journeyText(cwd, pinned[files.indexOf(sharedBrief)]);
	/** @type {import("./model.js").Policy} */
	const policy = {
		id: name(row.id, "policy ID"), direction: text(row.direction, "engineering direction"), source: filename, target, base, productCheck,
		files, squads, ...(row.ownership ? {ownership: row.ownership} : {}), ...(sharedBrief ? { sharedBrief } : {}), ...(seed ? { seed } : {}),
		...(goalCheck ? { goalCheck } : {}),
		...(workers === undefined ? {} : { workers: integer(workers, 1, "worker limit") }),
		...(assignments === undefined ? {} : { assignments: integer(assignments, 0, "total assignment limit") }),
		repairs: integer(repairs, 0, "repair limit"), ...(deadline ? { deadline } : {})
	};
	return { policy, grains };
}

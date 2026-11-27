import { isUtf8 } from "node:buffer";
import { topology } from "./topology.mjs";
import { commitAt, committedFile, git, outside, regularFiles, verifyDirectoryPin } from "./product.mjs";
import { assignmentDirectory, deadlineAt, digest, disjoint, fail, fields, integer, roots, name, names, record, relative, text } from "./values.mjs";

/** @param {unknown} outcome @param {number} grains @returns {outcome is import("./model.js").Observation["outcome"]} */
export const validOutcome = (outcome, grains) => grains > 0 ? outcome === "regenerate" :
	outcome === "no-gap" || outcome === "needs-decision" || outcome === "waiting" || outcome === "needs-evidence" ||
	outcome === "needs-research" || outcome === "researched" || outcome === "unresolved";

/** @param {unknown} value @param {string} label */
function list(value, label) {
	if (!Array.isArray(value) || !value.length)
		fail("incomplete_contract", `Expected nonempty ${label}`);
	return value;
}

/** @param {import("./model.js").Output[]} grains @param {boolean} [checkScope] */
export function validateGraph(grains, checkScope = true) {
	const ids = names(grains.map(g => g.id), "grain");
	if (checkScope) disjoint(grains.flatMap(g => roots(g.directory)));
	const byId = new Map(grains.map(g => [g.id, g]));
	topology(id=>byId.get(id)?.needs).validate(ids);
}

/** @param {Record<string,unknown>} row */
function fixed(row) {
	const grains = list(row.grains, "grains").map(v => {
		const g = record(v);
		fields(g, ["id", "directory", "specification", "boundary", "check", "needs"]);
		if (typeof g.directory !== "string") fail("invalid_charter", "A directory set requires one area's charter in a version 2 plan");
		return { id: name(g.id, "grain"), ...assignmentDirectory(g.directory), specification: relative(g.specification),
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
	return { squads, grains:grains.map(g=>{
		const agent=squads.find(s=>s.grains.includes(g.id))?.agent;
		return agent ? {...g,agent} : g;
	}), ...(seed ? { seed } : {}) };
}

/** @param {string} filename */
export const planDirectory = filename => filename.replace(/\.json$/, "");

/** A fixed scout selected an ID, not a duplicate copy of the writable grant.
 * Resolve that ID in the immutable activation brief when it matters for a new permission.
 * @param {string} cwd @param {import("./model.js").Run} run @param {import("./model.js").Node} n */
export function verifyFixedGrant(cwd,run,n){
	if(n.grain.task!==undefined)return;
	const row=record(JSON.parse(committedFile(cwd,run.policy.base,run.policy.source).toString()));
	const g=row.version===1 && fixed(row).grains.find(g=>g.id===n.grain.id);
	if(!g || row.direction!==run.policy.direction || digest(g)!==digest(n.grain))
		fail("stale_assignment","The fixed grant no longer matches its original activation brief");
}

/** @param {import("./model.js").Run} run @param {{file:string}[]} files */
export function changesFixedContract(run,files){
	const paths=Object.values(run.nodes).flatMap(({grain:g})=>g.task===undefined?[g.specification,...g.boundary]:[]);
	return paths.length>0 && files.some(f=>!outside(f.file,paths));
}
/** An old approval is still inspectable evidence, not authority to change this contract.
 * @param {import("./model.js").Run} run */
export function contractHold(run){
	const unsafe=run.adoptions?.find(a=>a.rollout && a.decision?.status==="answered" &&
		(changesFixedContract(run,a.rollout.files) || a.rollout.followup && changesFixedContract(run,a.rollout.followup.files)));
	if(unsafe)return `Approved rollout ${unsafe.id} changes a conserved fixed specification or boundary. This run is read-only; its historical receipts are not a handoff.`;
}

/** A reverted or deleted input still belongs to this evaluator's approved overlay,
 * even when it no longer differs from the target. Do not overlay the other evaluator's repins.
 * @param {import("./model.js").Run} run @param {"goal"|"product"} kind @param {string} revision */
export function evaluatorOverlay(run,kind,revision){
	const base=run.policy.contractTarget??run.policy.base, goals=run.repins??[], products=run.productRepins??[];
	const harnesses=new Set(products.flatMap(p=>p.amendments?.flatMap(s=>s.harness?[s.harness]:[])??[]));
	const chain=new Map((kind==="goal"?goals:[...products,...goals.filter(p=>harnesses.has(p.revision))]).map(p=>[p.revision,p]));
	/** @type {Set<string>} */ const paths=new Set();
	for(let at=revision;at!==base;){
		const pin=chain.get(at)??fail("stale_pin","Evaluator history does not reach the selected contract");
		for(const file of pin.files)paths.add(file);
		chain.delete(at);at=pin.from;
	}
	const exact=run.policy.goalCheck;
	return {revision,paths:[...paths],...(kind==="goal" && exact && !exact.startsWith(".foundry/") && paths.has(exact) &&
		run.testRepairs?.some(j=>j.state==="applied" && j.rule.check===exact && !j.grain) && {exact})};
}

/** Product overlays must stay inside the evaluator's private namespace and outside all other grants.
 * @param {import("./model.js").Run} run @param {string[]} files */
export function productOverlayPaths(run,files) {
	const p = run.policy, check = p.productCheck;
	const protectedFiles = [p.source, ...p.files.filter(f=>f!==check), ...p.squads.flatMap(s=>"areas" in s ? [s.charter,...s.areas,...s.boundary,...s.checks] : [s.charter]),
		...Object.values(run.nodes).flatMap(n=>[n.grain.check,n.grain.specification,...n.grain.boundary,...roots(n.grain.directory)])];
	return check.startsWith(".foundry/") && files.length > 0 && files.every(f=>(f===check || f.startsWith(`${check}.d/`)) && !/^\.foundry\/[^/]+\.json$/i.test(f) && outside(f,protectedFiles));
}

/** @param {string} cwd @param {{name:string,oid:string}} entry */
export function journeyText(cwd, entry) {
	const bytes = git(cwd, ["cat-file", "blob", entry.oid]);
	const content = bytes.toString("utf8");
	if (bytes.includes(0) || !isUtf8(bytes) || !content.trim()) fail("invalid_brief", `${entry.name} must be nonempty UTF-8 text`);
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

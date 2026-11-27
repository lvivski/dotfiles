import { git, regularFiles } from "../../../skills/foundry/scripts/git-files.mjs";
import { topology } from "./topology.mjs";
import { assignmentDirectory, digest, disjoint, fail, fields, name, names, record, relative, roots, text } from "./values.mjs";

/** @param {unknown} value @param {string} label */
export function list(value,label){
	if(!Array.isArray(value) || !value.length)fail("incomplete_contract",`Expected nonempty ${label}`);
	return value;
}

/** @param {import("./model.js").Output[]} grains @param {boolean} [checkScope] */
export function validateGraph(grains,checkScope=true){
	const ids=names(grains.map(g=>g.id),"grain"),byId=new Map(grains.map(g=>[g.id,g]));
	if(checkScope)disjoint(grains.flatMap(g=>roots(g.directory)));
	topology(id=>byId.get(id)?.needs).validate(ids);
}

/** @param {Record<string,unknown>} row */
export function fixed(row){
	const grains=list(row.grains,"grains").map(v=>{
		const g=record(v);
		fields(g,["id","directory","specification","boundary","check","needs"]);
		if(typeof g.directory!=="string")fail("invalid_charter","A directory set requires one area's charter in a version 2 plan");
		return {id:name(g.id,"grain"),...assignmentDirectory(g.directory),specification:relative(g.specification),
			boundary:list(g.boundary,"boundary files").map(relative),check:relative(g.check),needs:names(g.needs??[],"required output")};
	});
	validateGraph(grains);
	const known=new Set(grains.map(g=>g.id));
	if(!Array.isArray(row.squads??[]))fail("invalid_charter","Expected flat squads");
	const squads=(Array.isArray(row.squads)?row.squads:[]).map(v=>{
		const s=record(v);fields(s,["id","charter","grains","agent"]);
		const allowed=names(s.grains,"chartered grain");
		if(!allowed.length || allowed.some(id=>!known.has(id)))fail("invalid_charter","Each squad needs actual grain outputs");
		return {id:name(s.id,"squad"),charter:relative(s.charter),grains:allowed,...(s.agent===undefined?{}:{agent:text(s.agent,"native agent")})};
	});
	names(squads.flatMap(s=>s.grains),"chartered producer");
	const seed=row.seed===undefined?undefined:names(row.seed,"seed grain");
	if(seed && (!seed.length || seed.some(id=>!known.has(id))) || !seed && !squads.length)
		fail("invalid_seed","Supply a nonempty seed or discovery squad");
	if(!seed && grains.some(g=>!squads.some(s=>s.grains.includes(g.id))))fail("invalid_charter","Every output needs a chartered producer");
	return {squads,grains:grains.map(g=>{
		const agent=squads.find(s=>s.grains.includes(g.id))?.agent;return agent?{...g,agent}:g;
	}),...(seed?{seed}:{})};
}

/** A fixed assignment selects an ID, not a second editable scope. Verify at its
 * original activation, never at the current branch tip.
 * @param {string} cwd @param {import("./model.js").Run} run @param {{grain:import("./model.js").Grain}} n
 * @param {import("./model.js").Review} [review] */
export function verifyFixedGrant(cwd,run,n,review){
	if(n.grain.task!==undefined)return;
	const p=run.policy,[file]=regularFiles(cwd,p.base,[p.source]);
	const row=record(JSON.parse(git(cwd,["cat-file","blob",file.oid]).toString()));
	const defs=row.version===1 && fixed(row),g=defs && defs.grains.find(g=>g.id===n.grain.id);
	if(!g || !defs || row.id!==run.id || row.direction!==p.direction || digest(g)!==digest(n.grain) ||
		digest(defs.seed??null)!==digest(p.seed??null))fail("stale_assignment","The fixed grant no longer matches its original activation brief");
	if(p.seed || review){
		const graph=new Map(defs.grains.map(g=>[g.id,g.needs]));
		const roots=review?.observation?.grains.filter(g=>typeof g==="string")??p.seed??[];
		const squad=review && defs.squads.find(s=>s.id===review.squad);
		if(review && (!squad || roots.some(id=>!squad.grains.includes(id))) || !topology(id=>graph.get(id)).upstream(roots).has(g.id))
			fail("stale_assignment","The activation and original request do not grant this output");
	}
}

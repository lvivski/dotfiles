import { isUtf8 } from "node:buffer";
import { posix } from "node:path";
import { changedFiles, committedFile, entries, outside, regularFiles } from "./product.mjs";
import { covers, fail, fields, name, record, relative, text } from "./values.mjs";

export const stages=/** @type {const} */ (["component","generated","package","runtime"]);
/** @param {unknown} value @param {string} label */
export function nonempty(value,label) {
	if (!Array.isArray(value) || !value.length) fail("incomplete_evidence",`Missing ${label}`);
	return /** @type {unknown[]} */ (value);
}

/** Only a final filename wildcard has unambiguous cross-platform semantics.
 * Expand against both trees so added and removed matches cannot escape the proof.
 * @param {string} cwd @param {string} pin @param {string} base @param {string} assembly @param {string[]} selectors */
function concrete(cwd,pin,base,assembly,selectors) {
	const roots=new Set();
	const literals=selectors.filter(p=>!p.includes("*"));
	if (literals.length) {
		const files=entries(cwd,pin,false,literals);
		for (const p of literals) {
			if (!files.some(e=>e.name===p && ["100644","100755","040000"].includes(e.mode))) fail("incomplete_evidence",`Missing concrete input ${pin}:${p}; use its enclosing directory for optional reads`);
			roots.add(p);
		}
	}
	for (const p of selectors.filter(p=>p.includes("*"))) {
		const m=/^([^*?[\]{}]+)\/\*([.][a-zA-Z0-9_-]+)$/.exec(p);
		if (!m) fail("incomplete_evidence",`Unsupported input selector ${p}; use its enclosing directory`);
		const files=[...new Set([pin,base,assembly])].flatMap(tree=>entries(cwd,tree,true,[m[1]]))
			.filter(e=>e.name.slice(0,e.name.lastIndexOf("/"))===m[1] && e.name.endsWith(m[2]));
		if (!files.length || files.some(e=>!["100644","100755"].includes(e.mode))) fail("incomplete_evidence",`Unknown input set ${p}`);
		for (const e of files) roots.add(e.name);
	}
	return [...roots];
}

/** The operator reviews completeness of the source proof, not a free-form
 * declaration of independence. Git verifies all cited bytes and concrete roots.
 * A directory is a conservative recursive input; a missing or dynamic root is
 * not guessed. Bounded filename globs expand on the observed and proposed trees.
 * @param {string} cwd @param {unknown} input @param {Map<string,{commit:string,check:string,selected:boolean,scope:import("./model.js").Scope}>} roles
 * @param {string} base @param {string} assembly @param {string[]} held @param {string[]} delta */
export function footprints(cwd,input,roles,base,assembly,held,delta) {
	const seen=new Set();
	const result=nonempty(input,"component evidence").map(value=>{
		const r=record(value); fields(r,["component","stages"]);
		const component=name(r.component,"component check"), role=roles.get(component);
		if (!role || seen.has(component)) fail("incomplete_evidence","Need one evidence record for each distinct selected and held check");
		seen.add(component);
		const parts=record(r.stages);fields(parts,[...stages]);
		/** @type {import("./model.js").Footprint["stages"]} */
		const proof={component:[],generated:[],package:[],runtime:[]};
		const roots=new Set(), sources=new Set(), inventoryInputs=new Set();
		/** @type {Map<string,string[]>} */ const edges=new Map();
		for (const stage of stages) for (const raw of nonempty(parts[stage],`${component} ${stage} build evidence`)) {
			const n=record(raw);fields(n,["file","excerpt","inventory","reason"]);
			const file=relative(n.file), excerpt=text(n.excerpt,"verbatim build or consumption evidence"), reason=text(n.reason,"explanation of this complete stage");
			const [source]=regularFiles(cwd,role.commit,[file]), bytes=committedFile(cwd,role.commit,file);
			if (!isUtf8(bytes) || !bytes.toString().includes(excerpt)) fail("incomplete_evidence",`Missing exact source at ${role.commit}:${file}`);
			const i=record(n.inventory);fields(i,["file","keys"]);
			const manifest=relative(i.file);
			if (!Array.isArray(i.keys) || !i.keys.every(k=>typeof k==="string" && k.length && !Object.hasOwn(Object.prototype,k)))
				fail("incomplete_evidence","Name the exact key path to a finite build input list");
			const keys=/** @type {string[]} */ (i.keys);
			const local=posix.relative(posix.dirname(file),manifest);
			if (file!==manifest && ![manifest,local,`./${local}`].some(p=>excerpt.includes(p)))
				fail("incomplete_evidence",`Cite the rule that consumes ${manifest}, not a disconnected manifest`);
			const [entry]=regularFiles(cwd,role.commit,[manifest]), contents=committedFile(cwd,role.commit,manifest);
			if (changedFiles(cwd,base,role.commit,[manifest]).length || changedFiles(cwd,base,assembly,[manifest]).length)
				fail("incomplete_evidence",`A proposed or held change cannot supply its own build inventory: ${manifest}`);
			/** @type {unknown} */ let list;
			try { list=isUtf8(contents) && JSON.parse(contents.toString()); }
			catch (e) { if (!(e instanceof SyntaxError)) throw e;fail("incomplete_evidence",`Invalid JSON in ${manifest}`); }
			for (const key of keys) {
				if (!list || typeof list!=="object" || !Object.hasOwn(list,key)) fail("incomplete_evidence",`Missing build inventory ${manifest}:${keys.join("/")}`);
				list=Reflect.get(list,key);
			}
			if (!Array.isArray(list)) fail("incomplete_evidence",`No finite input list at ${manifest}:${keys.join("/")}`);
			const inputs=list.map(relative);
			if (new Set(inputs).size!==inputs.length || inputs.some(p=>/[?[\]{}]/.test(p))) fail("incomplete_evidence","Need distinct concrete input selectors");
			const files=concrete(cwd,role.commit,base,assembly,inputs);
			for (const p of files) inventoryInputs.add(p);
			proof[stage].push({file,blob:source.oid,excerpt,reason,inventory:{file:manifest,keys,blob:entry.oid},inputs});
			edges.set(file,[...edges.get(file)??[],manifest,...files]);
			for (const p of [file,manifest,...files]) roots.add(p);
			sources.add(file);
		}
		const reachable=new Set([role.check]);
		for (const file of reachable) for (const source of sources) if (covers(edges.get(file)??[],source)) reachable.add(source);
		if (!proof.component.some(n=>n.file===role.check) || [...sources].some(s=>!reachable.has(s)))
			fail("incomplete_evidence",`Root the build proof in the signed evaluator ${role.check} and connect every cited source to its consumer`);
		const reads=[...roots];
		if (outside(role.scope,[...inventoryInputs])) fail("incomplete_evidence",`The inventories do not account for any input in ${component}'s grant`);
		if (role.selected ? !outside(held,reads) || changedFiles(cwd,role.commit,assembly,reads).length : !outside(reads,delta))
			fail("dependent_output",`The ${component} source/build/runtime footprint crosses the held work or changes on the proposed assembly`);
		return {component,commit:role.commit,stages:proof};
	});
	if (seen.size!==roles.size) fail("incomplete_evidence","Missing a selected or held component's build and runtime proof");
	return result;
}

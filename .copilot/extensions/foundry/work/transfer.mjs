import { contains, covers, fail, fields, name, ownership, record, roots, sameScope } from "./values.mjs";

/** @typedef {import("./model.js").Node} Node */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Scope} Scope */
export const retainedMode = "retain-except-transferred";
/** Target adoption changes the contract bytes, never the ownership interface.
 * @param {Run} run */
export function ownershipMode(run) {
	const upgrade=run.productRepins?.findLast(p=>!p.targetFrom);
	return upgrade ? upgrade.ownership ?? "exact-files" : run.policy.ownership ?? "directories";
}
/** @param {Run} run @param {string|undefined} pin */
export const understandsTransfers = (run,pin) => (pin ? run.productRepins?.find(p=>p.revision===pin)?.ownership : run.policy.ownership) === retainedMode;
/** @param {unknown} input */
export function transferRequest(input) {
	const a=record(input); fields(a,["from","candidate","to"]);
	const candidate=name(a.candidate,"parent candidate");
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(candidate)) fail("invalid_pin","Name the full included parent candidate");
	return {from:name(a.from,"parent output"),candidate,to:name(a.to,"receiving output")};
}
/** @param {Node} n */
export function grant(n) {
	const base=ownership(n.grain.directory);
	return n.retained ? {...base,exclude:{directories:n.retained.map(r=>r.primary),files:n.retained.flatMap(r=>r.files)}} : base;
}

/** Freeze attribution independently of mutable writer state. A receiver that hasn't passed its component
 * is never an included output: its files remain reserved, not attributable to the donor.
 * @param {Run["nodes"]} nodes @param {Record<string,string>} outputs */
export function productOwnership(nodes,outputs) {
	if (Object.values(nodes).some(n=>n.retained) || Object.keys(outputs).some(id=>nodes[id]?.restoration))
		return Object.fromEntries(Object.keys(outputs).map(id=>[id,grant(nodes[id])]));
}
/** @param {string} path */
const key = path=>path.normalize("NFC").toLowerCase();
/** Reserved file ancestors and descendants must not change type, even through a case alias.
 * @param {import("./model.js").FileScope[]} cuts @param {string} path */
export const touchesCut = (cuts,path) => cuts.some(c=>roots(c).some(root=>contains(key(root),key(path)) || contains(key(path),key(root))));

/** @param {Run} run @param {import("./model.js").Transfer} t @param {import("./model.js").FileScope} scope */
export function preflightTransfer(run,t,scope) {
	if (!understandsTransfers(run,run.productRepins?.at(-1)?.revision))
		fail("unsupported_ownership","The selected product checker must explicitly support retain-except-transferred");
	const n=run.nodes[t.from], last=run.products.at(-1);
	if (!n || n.state!=="qualified" || n.candidate!==t.candidate || last?.outputs[t.from]!==t.candidate ||
		run.nodes[t.to] || run.effects.some(e=>e.grain===t.to) || run.join || !roots(scope).every(p=>
			ownership(n.grain.directory).directories.some(d=>p.startsWith(d+"/")) && !touchesCut(n.retained ?? [],p)))
		fail("ownership_transition","Need a fresh receiving ID and strict, unassigned descendants of the exact included parent output");
	if (run.effects.some(e=>e.grain===t.from && (e.permissionHold || !["done","refused","withdrawn","retired"].includes(e.state))))
		fail("dispatch_held","Resolve outstanding parent calls before transferring paths");
	const live=activeConsumer(run,t.from,scope);
	if (live) fail("frozen_assignment",`${live.grain.id} still consumes the parent output or transferred evidence`);
}

/** @param {Run} run @param {string} from @param {Scope} scope
 * @param {{except?:string,verifiedCitationsOf?:Node}} [options] */
export function activeConsumer(run,from,scope,options={}) {
	const dependents=new Set([from]);
	for (const id of dependents) for (const v of Object.values(run.nodes))
		if (v.state!=="blocked" && v.grain.needs.includes(id)) dependents.add(v.grain.id);
	return Object.values(run.nodes).find(v=>{
		if (v.grain.id===options.except || ["idle","blocked","repeated","qualified"].includes(v.state)) return false;
		const r=run.effects.find(e=>e.id===v.review);
		const cited=r?.kind==="scout" ? [...(v===options.verifiedCitationsOf ? [] : r.observation?.evidence ?? []),r.correction?.file,r.iteration?.source?.file] : [];
		return Object.hasOwn(v.inputs ?? {},from) || dependents.has(v.grain.id) ||
			[...v.supporting ?? [],...cited].some(p=>p && covers(scope,p));
	});
}
/** Disjoint except for the exact receiving owner recorded on its donor.
 * @param {Node} donor @param {string} id @param {Scope} scope */
export const transferredTo = (donor,id,scope) => donor.successor?.to===id && sameScope(donor.successor.directory,scope) ||
	donor.retained?.some(({to,primary,files})=>to===id && sameScope({primary,files},scope));

/** @param {Node} n @param {Set<string>} ids */
export const protectsGrant = (n,ids) => n.restoration && (ids.has(n.grain.id) || ids.has(n.restoration.retainer)) ||
	n.successor && (ids.has(n.grain.id) || ids.has(n.successor.to)) ||
	n.retained && (ids.has(n.grain.id) || n.retained.some(c=>ids.has(c.to)));

/** @typedef {import("./model.js").Run} Run */
/** @typedef {import("./model.js").Effect} Effect */
/** @typedef {import("./model.js").Product} Product */
/** @typedef {{effect:string,code:"inadmissible-outcome",reason:string}} IntegrityHold */
/** @type {WeakMap<Run,{effects:Map<string,Effect>,products:Map<string,Product>}>} */
const indexes=new WeakMap();
/** @type {WeakMap<Run,readonly IntegrityHold[]>} */ const holds=new WeakMap();
/** @type {WeakSet<Effect>} */ const withheld=new WeakSet();

/** Only the immutable snapshot may reuse its decoder's maps. Planner drafts can
 * add and replace entities during a single transaction.
 * @param {Run} run @param {Map<string,Effect>} effects @param {Map<string,Product>} products */
export function indexRevision(run,effects,products){indexes.set(run,{effects,products});}
/** Cache only data derived entirely from this validated revision. Do not cache
 * permissions, clock decisions, Git probes, or a mutable planner draft.
 * @template T @param {(run:Run)=>T} build */
export function revisionLookup(build){
	/** @type {WeakMap<Run,T>} */const memo=new WeakMap();
	return (/** @type {Run} */ run)=>{
		if(!Object.isFrozen(run) || !indexes.has(run))return build(run);
		if(!memo.has(run))memo.set(run,build(run));return /** @type {T} */ (memo.get(run));
	};
}
/** @param {Run} run @param {string|undefined} id */
export const effectAt=(run,id)=>id===undefined?undefined:Object.isFrozen(run) && indexes.has(run)?
	indexes.get(run)?.effects.get(id):run.effects.find(e=>e.id===id);
/** @param {Run} run @param {string} id */
export const productAt=(run,id)=>Object.isFrozen(run) && indexes.has(run)?indexes.get(run)?.products.get(id):run.products.find(p=>p.check===id);
/** @param {Run} run */
export const integrityHolds=run=>holds.get(run)??[];
/** @param {Effect} e */
export const heldOutcome=e=>withheld.has(e);
/** @param {Run} run @param {readonly IntegrityHold[]} list */
export function withhold(run,list){
	if(!list.length)return;
	holds.set(run,list);
	for(const {effect} of list){const e=effectAt(run,effect);if(e)withheld.add(e);}
}
/** @template T @param {T} value @returns {T} */
export function immutable(value){
	if(value && typeof value==="object" && !Object.isFrozen(value)){
		for(const child of Object.values(value))immutable(child);
		Object.freeze(value);
	}
	return value;
}

/** Only parsed JSON enters the revision store. Give each planner private containers while sharing
 * immutable strings, rather than serializing every settled diagnostic into another V8 buffer.
 * @template T @param {T} value @returns {T} */
export function privateCopy(value){
	if(Array.isArray(value))return /** @type {T} */(value.map(privateCopy));
	if(value && typeof value==="object"){
		const out={...value};
		for(const key in out)if(Object.hasOwn(out,key))out[key]=privateCopy(out[key]);
		return out;
	}
	return value;
}

/** Compare wire data without creating two full-history strings. Like JSON, omit undefined
 * object fields; preserve property order because joined members are visited in the recorded order.
 * @param {unknown} a @param {unknown} b @returns {boolean} */
export function sameDocument(a,b){
	if(a===b)return true;
	if(!a || !b || typeof a!=="object" || typeof b!=="object")return false;
	if(Array.isArray(a) || Array.isArray(b)){
		if(!Array.isArray(a) || !Array.isArray(b) || a.length!==b.length)return false;
		for(let i=0;i<a.length;i++)if(!sameDocument(a[i]??null,b[i]??null))return false;
		return true;
	}
	const left=Object.keys(a).filter(k=>Reflect.get(a,k)!==undefined),right=Object.keys(b).filter(k=>Reflect.get(b,k)!==undefined);
	return left.length===right.length && left.every((k,i)=>k===right[i] && sameDocument(Reflect.get(a,k),Reflect.get(b,k)));
}

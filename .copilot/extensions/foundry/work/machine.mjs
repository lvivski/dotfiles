/** @typedef {{on:string,target?:string,action?:string,update?:string,guard?:string,when?:readonly string[],fork?:readonly string[],description?:string}} Edge */
/** @typedef {Record<string,readonly Edge[]>} States */
/** @typedef {{readonly description:string,readonly states:Readonly<Record<string,string>>}} Info */
/** @template {States} [T=States] @typedef {{readonly id:string,readonly initial:string,readonly states:T,readonly info?:Info}} Machine */
/** @typedef {Readonly<Record<string,unknown>>} Facts */
/** @param {string} s */
const opposite=s=>s.startsWith("!") ? s.slice(1) : `!${s}`;
const validated=new WeakSet();
const recipe=Symbol("Foundry context update");
const predicate=Symbol("Foundry event guard");
/** @type {WeakMap<readonly Edge[],Map<string,Map<string,unknown>>>} */ const guardBindings=new WeakMap();
/** @type {WeakMap<object,Machine>} */ const resolved=new WeakMap();
/** @typedef {{readonly type:string}} Effect */
/** @template {States} T @template C @typedef {{readonly region:string,readonly snapshot:{readonly value:keyof T & string,readonly context:C},
 * readonly edge:T[keyof T & string][number]|undefined,readonly effects:readonly Effect[],readonly fork:readonly string[]}} Resolution */
/** @type {readonly Effect[]} */ const none=Object.freeze([]);
/** @type {readonly string[]} */ const noSignals=Object.freeze([]);
/** @template {States} T @param {Machine<T>} m */
function sealed(m) {validated.add(m);return Object.freeze(m);}

/** Is every assignment satisfying these guards already taken by an earlier edge?
 * Split only on facts that could still distinguish an overlapping rule.
 * @param {readonly (readonly string[])[]} rules @param {Set<string>} guards @returns {boolean} */
function covered(rules,guards) {
	const overlap=rules.filter(r=>!r.some(g=>guards.has(opposite(g))));
	if (!overlap.length) return false;
	if (overlap.some(r=>r.every(g=>guards.has(g)))) return true;
	const literal=overlap[0].find(g=>!guards.has(g));
	return literal!==undefined && covered(overlap,new Set([...guards,literal])) && covered(overlap,new Set([...guards,opposite(literal)]));
}

/** @param {States} states @param {string} state */
function validate(states,state) {
	const edges=states[state], previous=new Map();
	/** @type {Map<string,Map<string,unknown>>} */ const bindings=new Map();
	if (!Array.isArray(edges)) throw Error(`Expected transitions for ${state}`);
	for (const e of edges) {
		if (typeof e.on!=="string" || !e.on || !e.target && !e.action && !e.update && !e.fork ||
			e.action!==undefined && (typeof e.action!=="string" || !e.action.trim()) ||
			e.update!==undefined && (typeof e.update!=="string" || !e.update.trim())) throw Error(`Missing signal or destination/action: ${state}`);
		if (e.target!==undefined && (typeof e.target!=="string" || !Object.hasOwn(states,e.target))) throw Error(`Unknown destination: ${state} → ${e.target}`);
		const guards=e.when===undefined ? [] : e.when, rules=previous.get(e.on) ?? [];
		if (!Array.isArray(guards) || guards.some(g=>typeof g!=="string" || !/^!?[^!\s]+$/.test(g))) throw Error(`Invalid guard: ${state}.${e.on}`);
		if(e.guard!==undefined){
			if(!guards.includes(e.guard) && !guards.includes(`!${e.guard}`))throw Error(`Unreferenced event guard: ${state}.${e.on}`);
			const table=bindings.get(e.on)??new Map(), fn=Object.getOwnPropertyDescriptor(e,predicate)?.value;
			if(table.has(e.guard) && table.get(e.guard)!==fn)throw Error(`Conflicting event guard: ${state}.${e.on}.${e.guard}`);
			table.set(e.guard,fn);bindings.set(e.on,table);
		}
		if(e.fork!==undefined){
			const dest=states[e.target??state];
			if(!Array.isArray(e.fork)||!e.fork.length||new Set(e.fork).size!==e.fork.length ||
				e.fork.some((/** @type {unknown} */ s)=>typeof s!=="string" || !Array.isArray(dest) || !dest.some(r=>r.on===s)))
				throw Error(`Invalid fork from ${state}.${e.on} to ${e.target??state}`);
			Object.freeze(e.fork);
		}
		if (guards.some(g=>guards.includes(opposite(g))) || covered(rules,new Set(guards))) throw Error(`Unreachable transition: ${state}.${e.on}`);
		rules.push(guards);previous.set(e.on,rules);
		Object.freeze(guards);Object.freeze(e);
	}
	if(bindings.size)guardBindings.set(edges,bindings);
	Object.freeze(edges);
}

/** Only immediate, automatic fan-out must form a DAG. An ordinary event or host reply
 * can revisit the same state; a cascade with no outside event must settle unconditionally.
 * @param {States} states */
function validateForks(states){
	/** @type {Map<string,Set<string>>} */ const links=new Map();
	for(const [state,edges] of Object.entries(states))for(const e of edges)if(e.fork){
		const key=JSON.stringify([state,e.on]),to=links.get(key)??new Set();
		for(const signal of e.fork)to.add(JSON.stringify([e.target??state,signal]));
		links.set(key,to);
	}
	const incoming=new Map([...links.keys()].map(k=>[k,0]));
	for(const destinations of links.values())for(const k of destinations)if(incoming.has(k))incoming.set(k,(incoming.get(k)??0)+1);
	const ready=[...incoming.keys()].filter(k=>!incoming.get(k));
	for(const k of ready)for(const d of links.get(k)??[]){
		const n=incoming.get(d);if(n===undefined)continue;
		incoming.set(d,n-1);if(n===1)ready.push(d);
	}
	if(ready.length!==links.size)throw Error(`Automatic fork cycle: ${[...incoming.keys()].find(k=>incoming.get(k))}`);
}

/** Define the executable rules for one entity. Reading the definition does not run it.
 * @template {States} T @param {string} id @param {keyof T & string} initial @param {T} states
 * @param {{description:string,states:Record<keyof NoInfer<T> & string,string>}} [info] @returns {Machine<T>} */
export function machine(id,initial,states,info) {
	if (typeof id!=="string" || !id.trim() || typeof initial!=="string" || !Object.hasOwn(states,initial)) throw Error(`Missing machine ID or initial state: ${id}.${initial}`);
	for (const state of Object.keys(states)) validate(states,state);
	validateForks(states);
	return sealed({id,initial,states:Object.freeze(states),...(info && {info:Object.freeze({...info,states:Object.freeze({...info.states})})})});
}

/** New events/states compose independently. A new guarded alternative precedes only its event's fallback.
 * Unchanged tables retain identity; there is no global compile, replay or change to an actor's current state.
 * @param {Machine} base @param {States} additions @param {Record<string,string>} [descriptions] @returns {Machine} */
export function extend(base,additions,descriptions) {
	if (!validated.has(base)) base=machine(base.id,base.initial,base.states,base.info);
	const states={...base.states};
	for (const [key,edges] of Object.entries(additions)) {
		const next=[...(Object.hasOwn(states,key) ? states[key] : [])];
		for (const e of edges) {
			const fallback=next.findIndex(old=>old.on===e.on && !old.when?.length);
			next.splice(fallback<0 ? next.length : fallback,0,e);
		}
		Object.defineProperty(states,key,{value:next,enumerable:true,configurable:true});
	}
	for (const key of Object.keys(additions)) validate(states,key);
	if(Object.values(additions).some(es=>es.some(e=>e.fork)))validateForks(states);
	return sealed({...base,states:Object.freeze(states),...(base.info && descriptions && {
		info:Object.freeze({...base.info,states:Object.freeze({...base.info.states,...descriptions})})
	})});
}

/** @template {States} T @template {string} S @param {Machine<T>} model @param {S} state @param {string} signal @param {Facts} facts
 * @param {{context:unknown,event:{type:string}}} [input]
 * @returns {T[S][number]|undefined} */
function pick(model,state,signal,facts,input) {
	if (!Object.hasOwn(model.states,state)) throw Error(`Unhandled state: ${model.id}.${state}`);
	const rows=model.states[state], bound=input && guardBindings.get(rows)?.get(signal), observed=new Map();
	return rows.find(e=>e.on===signal && (e.when ?? []).every(g=>{
		const negated=g.startsWith("!"), key=negated ? g.slice(1) : g;
		let value;
		if(observed.has(key))value=observed.get(key);
		else if(input && bound?.has(key)){
			const read=bound.get(key);
			if(typeof read!=="function")throw Error(`Unbound event guard: ${model.id}.${key}`);
			value=read(input.context,input.event);
		}else if(Object.hasOwn(facts,key))value=facts[key];
		if(typeof value!=="boolean")throw Error(`Missing boolean guard: ${model.id}.${state}.${key}`);
		observed.set(key,value);
		return value!==negated;
	}));
}

/** Inspect one rule from explicitly sampled facts; never run code owned by the entity.
 * @template {States} T @template {string} S @param {Machine<T>} model @param {S} state @param {string} signal @param {Facts} [facts] */
export function step(model,state,signal,facts={}) {return pick(model,state,signal,facts);}

/** A caller issuing a required command must not silently drop an unsupported transition.
 * @template {States} T @template {string} S @param {Machine<T>} model @param {S} state @param {string} signal @param {Facts} [facts] */
export function select(model,state,signal,facts={}) {
	const edge=step(model,state,signal,facts);
	if (!edge) throw Error(`Unhandled transition: ${model.id}.${state} on ${signal}`);
	return edge;
}

/** @template {string} E @template {string} S @param {E} on @param {S} target @param {string} [description] */
export const to=(on,target,description)=>({on,target,...(description && {description})});

/** Attach the implementation to the edge itself. JSON retains its display name, not executable code.
 * The callback returns the complete next slice; it cannot select a destination or issue an effect.
 * @template {string} N @template C @template E @param {N} name @param {(context:C,event:E)=>C} reduce */
export function update(name,reduce) {
	if(typeof name!=="string" || !name.trim() || typeof reduce!=="function")throw Error("A context update needs a name and a reducer");
	return Object.freeze({update:name,[recipe]:reduce});
}

/** A guard determined by the entity's own state/event belongs on the rule, not in the caller.
 * In the structural simulator its name is a hypothetical input; execution uses only the predicate.
 * @template {string} N @template C,E @param {N} name @param {(context:C,event:E)=>boolean} test */
export function guard(name,test){
	if(typeof name!=="string" || !/^[^!\s]+$/.test(name) || typeof test!=="function")throw Error("An event guard needs a name and a predicate");
	return Object.freeze({guard:name,when:Object.freeze([name]),[predicate]:test});
}

/** @template {States} T @param {Machine<T>} model @param {string} from @param {string} signal @param {Facts} facts @param {boolean} required
 * @param {{context:unknown,event:{type:string}}} [input] */
function resolve(model,from,signal,facts,required,input){
	const edge=pick(model,from,signal,facts,input);
	if(!edge && required)throw Error(`Unhandled transition: ${model.id}.${from} on ${signal}`);
	if(!edge)return;
	const effects=edge.action ? Object.freeze([Object.freeze({type:edge.action})]) : none;
	return {region:model.id,from,to:edge.target??from,edge,effects,fork:edge.fork??noSignals};
}

/** Pure microstep. The structural part is also used by the inspector. A wire projection
 * can explain a reducer but cannot execute one whose implementation is missing.
 * @template {States} T @template C @template {{type:string}} E
 * @param {Machine<T>} model @param {{value:string,context:C}} before @param {E} event @param {Facts} [facts] @param {boolean} [required]
 * @returns {Resolution<T,C>} */
export function transition(model,before,event,facts={},required=false){
	if(!validated.has(model))throw Error(`Not an executable machine: ${model.id}`);
	if(!event || typeof event.type!=="string" || !event.type)throw Error(`Missing event type: ${model.id}`);
	const change=resolve(model,before.value,event.type,facts,required,{context:before.context,event});
	let context=before.context;
	if(change?.edge.update){
		const reduce=Object.getOwnPropertyDescriptor(change.edge,recipe)?.value;
		if(typeof reduce!=="function")throw Error(`Unbound context update: ${model.id}.${change.edge.update}`);
		context=reduce(context,event);
		if(context && typeof context==="object" && "then" in context)throw Error(`Asynchronous context update: ${model.id}.${change.edge.update}`);
	}
	// resolve() verifies the input state, and machine() validates every literal target.
	const snapshot=change ? Object.freeze({value:change.to,context}) : before;
	const result=Object.freeze({region:model.id,snapshot,edge:change?.edge,effects:change?.effects??none,fork:change?.fork??noSignals});
	resolved.set(result,model);
	return result;
}

/** Effects cannot be fabricated from a diagram, dispatched for another machine, or run
 * twice from one resolution. The durable ledger still owns cross-process idempotence.
 * @param {Machine} model @param {{effects:readonly Effect[]}} result */
export function takeEffects(model,result){
	if(resolved.get(result)!==model)throw Error(`Invalid or consumed transition: ${model.id}`);
	resolved.delete(result);
	return result.effects;
}

/** Orthogonal regions observe one signal against the same pre-event snapshot. Return a sparse plan;
 * callers own persistence, effect ordering and authority. Installing a definition issues no events.
 * @param {...Machine} models */
export function compose(...models) {
	/** @type {Map<string,Machine>} */ const registry=new Map();
	/** @param {Machine} model */
	function install(model) {
		const old=registry.get(model.id);
		if (old && Object.keys(old.states).some(s=>!Object.hasOwn(model.states,s))) throw Error(`Cannot remove a live state from ${model.id} without migration`);
		registry.set(model.id,validated.has(model) ? model : machine(model.id,model.initial,model.states,model.info));
	}
	for (const m of models) {
		if (registry.has(m.id)) throw Error(`Duplicate region: ${m.id}`);
		install(m);
	}
	/** @param {Readonly<Record<string,string>>} snapshot @param {string} signal @param {Readonly<Record<string,Facts>>} [inputs] */
	function plan(snapshot,signal,inputs={}) {
		return Object.entries(snapshot).flatMap(([region,from])=>{
			const m=registry.get(region);
			if (!m) throw Error(`Unknown region: ${region}`);
			const change=resolve(m,from,signal,inputs[region]??{},false);
			return change ? [change] : [];
		});
	}
	return {install,describe:()=>Object.fromEntries(registry),plan,
		/** An optional in-memory interpreter for ephemeral actors and simulations. Durable entities
		 * use plan/step on the authoritative ledger instead of keeping a shadow actor alive.
		 * @param {Readonly<Record<string,string>>} [saved] */
		actor(saved=Object.fromEntries([...registry].map(([key,m])=>[key,m.initial]))) {
			const values=new Map(Object.entries(saved));
			for (const [key,state] of values) if (!Object.hasOwn(registry.get(key)?.states ?? {},state)) throw Error(`Unknown actor state: ${key}.${state}`);
			return {snapshot:()=>Object.fromEntries(values),
				/** @param {string} signal @param {Readonly<Record<string,Facts>>} [inputs] */
				send(signal,inputs={}) {
					const steps=plan(Object.fromEntries(values),signal,inputs);
					for (const s of steps) values.set(s.region,s.to);
					return steps;
				}};
		}};
}

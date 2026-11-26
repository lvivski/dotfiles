/** @typedef {{on:string,target?:string,action?:string,when?:readonly string[],description?:string}} Edge */
/** @typedef {Record<string,readonly Edge[]>} States */
/** @typedef {{readonly description:string,readonly states:Readonly<Record<string,string>>}} Info */
/** @template {States} [T=States] @typedef {{readonly id:string,readonly initial:string,readonly states:T,readonly info?:Info}} Machine */
/** @typedef {Readonly<Record<string,unknown>>} Facts */
/** @param {string} s */
const opposite=s=>s.startsWith("!") ? s.slice(1) : `!${s}`;
const validated=new WeakSet();
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
	if (!Array.isArray(edges)) throw Error(`Expected transitions for ${state}`);
	for (const e of edges) {
		if (typeof e.on!=="string" || !e.on || !e.target && !e.action || e.action!==undefined && typeof e.action!=="string") throw Error(`Missing signal or destination/action: ${state}`);
		if (e.target!==undefined && (typeof e.target!=="string" || !Object.hasOwn(states,e.target))) throw Error(`Unknown destination: ${state} → ${e.target}`);
		const guards=e.when===undefined ? [] : e.when, rules=previous.get(e.on) ?? [];
		if (!Array.isArray(guards) || guards.some(g=>typeof g!=="string" || !/^!?[^!\s]+$/.test(g))) throw Error(`Invalid guard: ${state}.${e.on}`);
		if (guards.some(g=>guards.includes(opposite(g))) || covered(rules,new Set(guards))) throw Error(`Unreachable transition: ${state}.${e.on}`);
		rules.push(guards);previous.set(e.on,rules);
		Object.freeze(guards);Object.freeze(e);
	}
	Object.freeze(edges);
}

/** Immutable, serializable definition. A terminal state has no outgoing edges. No entry effects on hydration.
 * @template {States} T @param {string} id @param {keyof T & string} initial @param {T} states
 * @param {{description:string,states:Record<keyof NoInfer<T> & string,string>}} [info] @returns {Machine<T>} */
export function chart(id,initial,states,info) {
	if (typeof id!=="string" || !id.trim() || typeof initial!=="string" || !Object.hasOwn(states,initial)) throw Error(`Missing machine ID or initial state: ${id}.${initial}`);
	for (const state of Object.keys(states)) validate(states,state);
	return sealed({id,initial,states:Object.freeze(states),...(info && {info:Object.freeze({...info,states:Object.freeze({...info.states})})})});
}

/** New events/states compose independently. A new guarded alternative precedes only its event's fallback.
 * Unchanged tables retain identity; there is no global compile, replay or change to an actor's current state.
 * @param {Machine} base @param {States} additions @param {Record<string,string>} [descriptions] @returns {Machine} */
export function extend(base,additions,descriptions) {
	if (!validated.has(base)) base=chart(base.id,base.initial,base.states,base.info);
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
	return sealed({...base,states:Object.freeze(states),...(base.info && descriptions && {
		info:Object.freeze({...base.info,states:Object.freeze({...base.info.states,...descriptions})})
	})});
}

/** Choose one transition, never execute it. An unrelated signal (or unmatched guard) is ignored.
 * @template {States} T @template {string} S @param {Machine<T>} model @param {S} state @param {string} signal @param {Facts} [facts]
 * @returns {T[S][number]|undefined} */
export function step(model,state,signal,facts={}) {
	if (!Object.hasOwn(model.states,state)) throw Error(`Unhandled state: ${model.id}.${state}`);
	return model.states[state].find(e=>e.on===signal && (e.when ?? []).every(g=>{
		const negated=g.startsWith("!"), key=negated ? g.slice(1) : g;
		if (!Object.hasOwn(facts,key) || typeof facts[key]!=="boolean") throw Error(`Missing boolean guard: ${model.id}.${state}.${key}`);
		return facts[key]!==negated;
	}));
}

/** A caller issuing a required command must not silently drop an unsupported transition.
 * @template {States} T @template {string} S @param {Machine<T>} model @param {S} state @param {string} signal @param {Facts} [facts] */
export function select(model,state,signal,facts={}) {
	const edge=step(model,state,signal,facts);
	if (!edge) throw Error(`Unhandled transition: ${model.id}.${state} on ${signal}`);
	return edge;
}

/** @template {string} E @template {string} S @param {E} on @param {S} target @param {string} [description] */
export const to=(on,target,description)=>({on,target,...(description && {description})});

/** Orthogonal regions observe one signal against the same pre-event snapshot. Return a sparse plan;
 * callers own persistence, effect ordering and authority. Installing a definition issues no events.
 * @param {...Machine} models */
export function compose(...models) {
	/** @type {Map<string,Machine>} */ const registry=new Map();
	/** @param {Machine} model */
	function install(model) {
		const old=registry.get(model.id);
		if (old && Object.keys(old.states).some(s=>!Object.hasOwn(model.states,s))) throw Error(`Cannot remove a live state from ${model.id} without migration`);
		registry.set(model.id,validated.has(model) ? model : chart(model.id,model.initial,model.states,model.info));
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
			const edge=step(m,from,signal,inputs[region]);
			return edge ? [{region,from,to:edge.target ?? from,edge}] : [];
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

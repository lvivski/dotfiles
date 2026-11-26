import {catalog} from "../work/catalog.mjs";
import {step} from "../work/chart.mjs";
import {entryWitnesses} from "./entries.mjs";

/** @typedef {import("../work/chart.mjs").Machine} Machine */
/** @typedef {Record<string,boolean>} Facts */
/** @typedef {{from:string,to:string,rule:number,edge:import("../work/chart.mjs").Edge,facts:Facts}} Hop */
/** @param {string[]} keys @param {number} [i] @param {Facts} [row] @returns {Generator<Facts>} */
function* valuations(keys,i=0,row={}){
	if(i===keys.length){yield {...row};return;}
	for(const value of [false,true]){row[keys[i]]=value;yield* valuations(keys,i+1,row);}
}

/** Breadth-first over winning rules, not drawn arrows. Facts may vary by event
 * unless a specific observation is supplied. No action or fact producer runs.
 * @param {Machine} m @param {string[]} [seeds] @param {{signal:string,facts:Facts}} [observation] */
export function walk(m,seeds=[m.initial],observation){
	/** @type {Map<string,Hop[]>} */ const paths=new Map();
	/** @type {Map<string,Hop[]>} */ const edges=new Map();
	for(const s of seeds){
		if(!Object.hasOwn(m.states,s))throw Error(`Unknown seed: ${m.id}.${s}`);
		paths.set(s,[]);
	}
	let cases=0,ignored=0;
	for(const [from,path] of paths){
		const rules=m.states[from],signals=observation?[observation.signal]:new Set(rules.map(e=>e.on));
		/** @type {Hop[]} */ const exits=[];
		edges.set(from,exits);
		for(const signal of signals){
			const keys=[...new Set(rules.filter(e=>e.on===signal).flatMap(e=>(e.when??[]).map(g=>g.replace(/^!/,""))))];
			const seen=new Set();
			for(const facts of observation?[observation.facts]:valuations(keys)){
				cases++;
				const edge=step(m,from,signal,facts);
				if(!edge){ignored++;continue;}
				if(seen.has(edge))continue;
				seen.add(edge);
				const to=edge.target??from,hop={from,to,rule:rules.indexOf(edge),edge,facts};
				exits.push(hop);
				if(!paths.has(to))paths.set(to,[...path,hop]);
			}
		}
	}
	// At catalog scale the reachable sets also give the closed strongly
	// connected components: no member can reach a state that cannot return.
	const reach=new Map([...paths.keys()].map(s=>{
		const set=new Set([s]);for(const n of set)for(const edge of edges.get(n)??[])set.add(edge.to);
		return [s,set];
	}));
	const remaining=new Set(paths.keys()),closed=[];
	for(const s of remaining){
		const reachable=reach.get(s);if(!reachable)throw Error(`Missing reachable set: ${s}`);
		const group=[...reachable].filter(n=>reach.get(n)?.has(s));
		for(const n of group)remaining.delete(n);
		if(group.length===reachable.size)closed.push(group);
	}
	return {paths,edges,cases,ignored,closed};
}

/** Reachability is existential. Only witnessed projections and specified historical entries
 * augment the initial state; an arbitrary saved-state seed is not reachability evidence.
 * @param {Record<string,Machine>} machines */
export function inventory(machines){
	const {projected,restored}=entryWitnesses(walk(machines.assignment).paths.keys());
	return Object.values(machines).map(m=>{
		const ids=Object.keys(m.states),initial=walk(m),p=projected[m.id]??new Map(),r=restored[m.id]??new Map();
		const live=walk(m,[m.initial,...p.keys()]),all=walk(m,[m.initial,...p.keys(),...r.keys()]);
		return {region:m.id,states:ids.length,rules:Object.values(m.states).flat().length,
			winningRules:[...all.edges.values()].flat().length,guardCases:all.cases,
			outsideInitial:ids.filter(s=>!initial.paths.has(s)),projected:Object.fromEntries([...p].filter(([s])=>!initial.paths.has(s))),
			restoredOnly:Object.fromEntries([...r].filter(([s])=>!live.paths.has(s))),unreachable:ids.filter(s=>!all.paths.has(s)),closed:all.closed};
	});
}

/** For a finite environment, every possible path must hit the requested outcome. A reachable
 * dead end or ANY reachable cycle avoiding it is a counterexample, even if it has an exit.
 * @template {string|number} T @param {T} start @param {(state:T)=>T[]} next @param {(state:T)=>boolean} done */
export function obstruction(start,next,done){
	/** @type {Set<T>} */ const proved=new Set();
	/** @type {Map<T,number>} */ const active=new Map();
	/** @type {T[]} */ const path=[];
	/** @param {T} state @returns {{prefix:T[],cycle?:T[]}|undefined} */
	function visit(state){
		if(done(state)||proved.has(state))return;
		const at=active.get(state);
		if(at!==undefined)return {prefix:path.slice(0,at),cycle:[...path.slice(at),state]};
		active.set(state,path.length);path.push(state);
		const successors=next(state);
		if(!successors.length)return {prefix:[...path]};
		for(const to of successors){const failed=visit(to);if(failed)return failed;}
		path.pop();active.delete(state);proved.add(state);
	}
	return visit(start);
}

/** @param {string[]} args */
function report(args){
	const {machines}=catalog();
	if(!args.length){
		const rows=inventory(machines);
		if(rows.some(r=>r.unreachable.length || r.winningRules!==r.rules))process.exitCode=1;
		return rows;
	}
	const [region,seed,signal,raw]=args;
	if(args.length>4 || !seed || !Object.hasOwn(machines,region))throw Error("Expected: [region state [signal [boolean-facts-json]]]");
	const facts=raw===undefined?{}:JSON.parse(raw);
	if(!facts||typeof facts!=="object"||Array.isArray(facts)||Object.values(facts).some(v=>typeof v!=="boolean"))
		throw Error("Expected an object of boolean facts");
	const {paths,edges,cases,ignored,closed}=walk(machines[region],[seed],signal?{signal,facts}:undefined);
	return {region,seed,cases,ignored,paths:Object.fromEntries(paths),edges:Object.fromEntries(edges),closed};
}

if(import.meta.main)process.stdout.write(JSON.stringify(report(process.argv.slice(2)),null,2)+"\n");

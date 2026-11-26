import assert from "node:assert/strict";
import test from "node:test";
import { catalog, definitions } from "../work/catalog.mjs";
import { compose, transition } from "../work/machine.mjs";
import { valuations } from "../test/walk.mjs";
import { statechart } from "./statechart.mjs";
import { simulate } from "./simulation.mjs";

test("event history restores the configuration and guard inputs; branching discards only the abandoned future",()=>{
	const sim=simulate([catalog().machines.activity]);
	sim.send("policy-hold");const held=sim.current();assert.deepEqual(held.states,{activity:"held"});
	assert.deepEqual(sim.preview("policy-ready"),[]);assert.equal(sim.history.length,2);
	sim.setFact("activity","sameHold",true);sim.send("policy-ready");assert.equal(sim.current().states.activity,"active");
	sim.seek(1);assert.equal(sim.current(),held);assert.equal(sim.inputs().activity.sameHold,false);
	sim.send("pause");assert.equal(sim.current().states.activity,"paused");assert.equal(sim.history.length,3);
	sim.send("policy-ready");assert.deepEqual(sim.current().changes,[]);assert.deepEqual(sim.current().states,{activity:"paused"});
	sim.reset();assert.equal(sim.history.length,1);assert.equal(sim.current().states.activity,"active");
});

test("a single graph event fans out across the real parallel regions without executing either action",()=>{
	const {machines}=catalog(),sim=simulate([machines.supervision,machines.history]);
	sim.seed("supervision","managed-policy");sim.seed("history","pending");
	sim.setFact("supervision","permitted",true);sim.send("sample");
	assert.deepEqual(sim.current().states,{supervision:"dispatch",history:"pending"});
	assert.deepEqual(sim.current().changes.map(c=>c.edge.action),["reactivate","lookup"]);
	sim.seek(2);assert.deepEqual(sim.current().states,{supervision:"managed-policy",history:"pending"});
});

/** Concrete entity data for pure production microsteps; the browser instead supplies
 * hypothetical observations. These are never signed receipts or native capabilities.
 * @param {string} id @param {string} from @param {string} type @param {Record<string,boolean>} facts */
function example(id,from,type,facts){
	const hold={issuer:"issuer",token:"original",effect:"call"};
	switch(id){
	case "activity":return {context:{policyHold:hold},event:{type,hold,reason:"permission",issuer:"issuer",token:facts.sameHold?"original":"other"}};
	case "dialog":{
		const expected=facts.unpresented ? undefined : facts.samePresentation ? "presentation" : "obsolete";
		return {context:{question:"question",presentation:"presentation"},event:{type,expected,answer:"answer",reason:"offline"}};
	}
	case "assignment":return {context:{replaces:"previous"},event:{type,id:"grain",reason:"original outcome",candidate:"candidate"}};
	case "review":case "call":return {context:{},event:{type,callId:"call",workflowId:"workflow",error:"reason",nativeId:"worker",boundAt:1}};
	case "quiescence":return {context:{held:[],retained:[]},event:{type,label:`sample (${from})`,check:{id:"observation"}}};
	case "release":case "release-preflight":return {context:null,event:{type,target:"target",workTarget:"checkpoint"}};
	case "renewal":return {context:undefined,event:{type,checkpoint:"product",goal:"goal",reason:"input changed"}};
	default:return {context:null,event:{type}};
	}
}

test("every drawable rule, guard valuation, ignored event and effect agrees with the installed machines",()=>{
	const {machines}=catalog(), live=definitions();
	for(const [id,m] of Object.entries(live)){
		const wire=machines[id], drawing=statechart(wire,false);
		const visible=[...drawing.nodes.flatMap(n=>n.internal),...drawing.wires];
		const projected=visible.flatMap(w=>w.rules.map(i=>`${w.source}:${i}:${w.signal}:${w.target??""}`)).sort();
		const authored=Object.entries(m.states).flatMap(([s,rules])=>rules.map((r,i)=>`${s}:${i}:${r.on}:${r.target??""}`)).sort();
		assert.deepEqual(projected,authored,id);
		const real=compose(m), sim=simulate([structuredClone(wire)]), signals=new Set(["!unhandled",...Object.values(m.states).flat().map(r=>r.on)]);
		for(const [from,rows] of Object.entries(m.states)){
			sim.seed(id,from);
			for(const type of signals){
				const choices=rows.filter(r=>r.on===type);
				const keys=[...new Set(choices.flatMap(r=>(r.when??[]).map(g=>g.replace(/^!/,""))))];
				for(const facts of valuations(keys)){
					const expected=choices.find(r=>(r.when??[]).every(k=>k[0]==="!"?!facts[k.slice(1)]:facts[k]));
					const [actual]=real.plan({[id]:from},type,{[id]:facts});
					for(const [key,value] of Object.entries(facts))sim.setFact(id,key,value);
					const [shown]=sim.preview(type);
					assert.equal(actual?.edge,expected,`${id}.${from} on ${type}`);
					assert.deepEqual(shown,actual && structuredClone(actual));
					const effects=expected?.action?[{type:expected.action}]:[];
					assert.deepEqual(shown?.effects??[],effects);
					const {context,event}=example(id,from,type,facts),snapshot=Object.freeze({value:from,context}), before=structuredClone(snapshot);
					const result=transition(m,snapshot,event,facts);
					assert.equal(result.edge,expected);assert.deepEqual(result.effects,effects);
					assert.deepEqual(result.fork,shown?.fork??[]);
					assert.equal(result.snapshot.value,shown?.to??from);
					assert.deepEqual(snapshot,before,`${id}.${from} must not mutate its input snapshot`);
					if(!shown)assert.equal(result.snapshot,snapshot);
				}
			}
		}
	}
});

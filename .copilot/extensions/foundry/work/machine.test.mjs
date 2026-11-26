import assert from "node:assert/strict";
import test from "node:test";
import { machine, compose, extend, guard, step, transition, update } from "./machine.mjs";
import { executor } from "./adapter.mjs";

const reader=()=>machine("reader","idle",{
	idle:[{on:"open",target:"reading",action:"load"}],
	reading:[{on:"response",when:["ok"],target:"done"},{on:"response",target:"waiting",action:"observe"}],
	waiting:[{on:"connected",target:"reading",action:"load"}],
	done:[],
});

test("inspecting a machine or its serialized definition selects a rule without executing an effect",()=>{
	const model=reader(), wire=JSON.parse(JSON.stringify(model));
	for(const m of [model,wire]){
		let state=m.initial;
		assert.equal(step(m,state,"response",{ok:true}),undefined);
		for(const [signal,ok,next] of [["open",false,"reading"],["response",false,"waiting"],["connected",true,"reading"],["response",true,"done"]]){
			const edge=step(m,state,String(signal),{ok}); assert.ok(edge);
			state=edge.target;assert.equal(state,next);
		}
		assert.equal(step(m,state,"open"),undefined);
		assert.throws(()=>step(m,"lost","open"),/unknown|unhandled/i);
		assert.throws(()=>step(m,"reading","response",{ok:1}),/boolean/);
	}
});

test("construction rejects malformed and shadowed transitions without conflating different signals",()=>{
	assert.throws(()=>Reflect.apply(machine,null,["x","absent",{s:[]}]),/initial/);
	assert.throws(()=>machine("x","s",{s:[{on:"go",target:"missing"}]}),/destination/);
	assert.throws(()=>machine("x","s",{s:[{on:"go",when:["a","!a"],target:"s"}]}),/unreachable/i);
	assert.throws(()=>machine("x","s",{s:[{on:"go",target:"s"},{on:"go",when:["a"],target:"s"}]}),/unreachable/i);
	assert.throws(()=>machine("x","s",{s:[{on:"go",when:["a"],target:"s"},{on:"go",when:["!a"],target:"s"},{on:"go",target:"s"}]}),/unreachable/i);
	const m=machine("x","s",{s:[{on:"no",when:["!seen"],action:"look"},{on:"yes",action:"stay"}]});
	assert.equal(step(m,"s","no",{seen:true}),undefined);
	assert.equal(step(m,"s","no",{seen:false})?.action,"look");
	assert.equal(step(m,"s","yes")?.action,"stay");
});

test("an extension adds a guarded lane to an active instance without replay or rebuilding the other regions",()=>{
	const original=reader(), notice=machine("notice","quiet",{quiet:[{on:"connected",target:"shown",action:"notify"}],shown:[]});
	const system=compose(original,notice);
	const snapshot={reader:"waiting",notice:"quiet"};
	const actor=system.actor(snapshot);
	const revised=extend(original,{waiting:[{on:"connected",when:["cached"],target:"done",action:"restore"}]});
	assert.equal(revised.states.idle,original.states.idle);
	system.install(revised);
	assert.deepEqual(snapshot,{reader:"waiting",notice:"quiet"});
	const changes=actor.send("connected",{reader:{cached:true}});
	assert.deepEqual(changes.map(s=>[s.region,s.from,s.to,s.edge.action]),[["reader","waiting","done","restore"],["notice","quiet","shown","notify"]]);
	assert.equal(step(original,"waiting","connected")?.action,"load");
	const recovered=Object.fromEntries(changes.map(s=>[s.region,s.to]));
	assert.deepEqual(actor.snapshot(),recovered);
	assert.deepEqual(system.plan(recovered,"connected"),[]);
	assert.throws(()=>system.install(machine("reader","idle",{idle:[]})),/remove|missing/i);
	assert.throws(()=>compose(original,original),/duplicate/i);
	assert.equal(system.describe().reader,revised);
	assert.deepEqual(system.plan({reader:"waiting"},"connected",{reader:{cached:false}}).map(s=>s.edge.action),["load"]);
});

test("a signal is atomic across parallel regions, including a late guard failure",()=>{
	const a=machine("a","pending",{pending:[toNext("wake")],next:[]});
	const b=machine("b","pending",{pending:[{...toNext("wake"),when:["verified"]}],next:[]});
	function toNext(/** @type {string} */ on) {return {on,target:"next",action:"notify"};}
	const sys=compose(a,b), actor=sys.actor();
	assert.throws(()=>actor.send("wake"),/boolean guard/);
	assert.deepEqual(actor.snapshot(),{a:"pending",b:"pending"});
	assert.deepEqual(actor.send("wake",{b:{verified:false}}).map(t=>t.region),["a"]);
	const hydrated=sys.actor(JSON.parse(JSON.stringify(actor.snapshot())));
	assert.deepEqual(hydrated.send("wake",{b:{verified:true}}).map(t=>t.region),["b"]);
	assert.deepEqual(hydrated.send("wake"),[]);
	assert.throws(()=>sys.actor({a:"obsolete"}),/actor state/);
});

test("priority and reachability agree with an independent truth table",()=>{
	const names=["a","b","c"];
	const masks=Array.from({length:8},(_,bits)=>Object.fromEntries(names.map((key,i)=>[key,Boolean(bits & 1<<i)])));
	const clauses=Array.from({length:27},(_,i)=>names.flatMap((name,k)=>{
		const v=Math.floor(i/3**k)%3;return v ? [v===1?name:`!${name}`] : [];
	}));
	for(const first of clauses) for(const second of clauses) {
		const rows=[first,second].map((when,i)=>({on:"sample",when,action:String(i)}));
		const expected=masks.map(f=>rows.findIndex(({when})=>when.every(l=>l[0]==="!" ? !f[l.slice(1)] : f[l])));
		if (!expected.includes(1)) {assert.throws(()=>machine("truth","s",{s:rows}),/unreachable/i);continue;}
		const m=machine("truth","s",{s:rows});
		assert.deepEqual(masks.map(f=>Number(step(m,"s","sample",f)?.action ?? -1)),expected);
	}
});

test("adding states validates destinations atomically and keeps legacy snapshots usable",()=>{
	const m=reader(), system=compose(m);
	assert.throws(()=>system.install(extend(m,{waiting:[{on:"inspect",target:"lost"}]})),/destination/);
	const invalid=JSON.parse(JSON.stringify(m));invalid.states.idle[0].target="lost";
	assert.throws(()=>system.install(invalid),/destination/);
	assert.throws(()=>extend(invalid,{}),/destination/);
	assert.equal(system.describe().reader,m);
	const next=extend(m,{waiting:[{on:"inspect",target:"inspection"}],inspection:[{on:"confirmed",target:"done",action:"retain"}]});
	system.install(next);
	assert.deepEqual(system.plan({reader:"waiting"},"inspect").map(s=>s.to),["inspection"]);
	assert.equal(step(next,"inspection","confirmed")?.action,"retain");
	assert.equal(step(m,"waiting","inspect"),undefined);
	assert.throws(()=>system.plan({unregistered:"idle"},"inspect"),/region/);
	assert.equal(Reflect.set(next.states,"other",[]),false);
});

test("pluggable action adapters are explicit capabilities, not part of selection or hydration",()=>{
	const m=reader(), next=extend(m,{waiting:[{on:"cached",target:"done",action:"restore"}]});
	/** @type {string[]} */ const calls=[];
	const base={load:()=>calls.push("load"),observe:()=>calls.push("observe")};
	assert.throws(()=>executor(next,base),/Unbound action: reader.restore/);
	const perform=executor(next,{...base,restore:()=>calls.push("restore")});
	const result=transition(next,{value:"waiting",context:null},{type:"cached"});
	assert.deepEqual(calls,[]);perform(result,undefined);assert.deepEqual(calls,["restore"]);
	assert.throws(()=>perform({effects:[{type:"constructor"}]},undefined),/Invalid or consumed/);
});

test("a described extension preserves existing purposes and actor state after serialization",()=>{
	const plain=machine("job","new",{new:[{on:"begin",target:"open",description:"Start this job."}],open:[]},
		{description:"Track one job.",states:{new:"The job is queued.",open:"The job is underway."}});
	const installed=compose(JSON.parse(JSON.stringify(plain))),actor=installed.actor();
	actor.send("begin");
	const revised=extend(installed.describe().job,{open:[{on:"finish",target:"done",description:"Accept the result."}],done:[]},{done:"The result was accepted."});
	installed.install(revised);
	assert.deepEqual(revised.info,{description:"Track one job.",states:{new:"The job is queued.",open:"The job is underway.",done:"The result was accepted."}});
	assert.deepEqual(actor.snapshot(),{job:"open"});
	assert.equal(actor.send("finish")[0].edge.description,"Accept the result.");
	assert.deepEqual(actor.snapshot(),{job:"done"});
});

test("the selected transition computes context once and queues, but does not execute, its effect",()=>{
	/** @type {string[]} */ const log=[];
	const add=update("account",(/** @type {{total:number}} */ c,/** @type {{type:string,amount:number}} */ ev)=>{
		log.push("reduced");return {total:c.total+ev.amount};
	});
	const model=machine("reservation","open",{open:[
		{on:"accept",when:["eligible"],target:"closed",...add,action:"notify"},
		{on:"accept",...update("retain",(/** @type {{total:number}} */ c)=>c)},
	],closed:[]});
	const initial=Object.freeze({value:"open",context:Object.freeze({total:1})});
	const event=Object.freeze({type:"accept",amount:2});
	const execute=executor(model,{notify:(/** @type {{total:number}} */ context)=>log.push(`admitted ${context.total}`)});
	assert.throws(()=>executor(model,{}),/Unbound action/);
	const ignored=transition(model,initial,{type:"other"});
	assert.equal(ignored.snapshot,initial);assert.equal(ignored.edge,undefined);
	assert.throws(()=>transition(model,initial,{type:"other"},{},true),/Unhandled transition/);
	const kept=transition(model,initial,event,{eligible:false});
	assert.notEqual(kept.snapshot,initial,"an update-only event is handled even without a new value or effects");
	assert.equal(kept.snapshot.context,initial.context);assert.deepEqual(kept.effects,[]);assert.deepEqual(log,[]);
	const accepted=transition(model,initial,event,{eligible:true});
	assert.deepEqual(accepted.snapshot,{value:"closed",context:{total:3}});assert.deepEqual(initial.context,{total:1});
	assert.deepEqual(accepted.effects,[{type:"notify"}]);assert.deepEqual(log,["reduced"]);
	const wire=JSON.parse(JSON.stringify(model));
	assert.equal(wire.states.open[0].update,"account");
	const [preview]=compose(wire).plan({reservation:"open"},event.type,{reservation:{eligible:true}});
	assert.equal(preview.to,accepted.snapshot.value);assert.deepEqual(preview.effects,accepted.effects);
	assert.throws(()=>execute(preview,initial.context),/Invalid or consumed/);
	assert.throws(()=>transition(wire,initial,event,{eligible:true}),/Not an executable machine/);
	assert.throws(()=>transition(machine(wire.id,wire.initial,wire.states),initial,event,{eligible:true}),/Unbound context update/);
	const other=executor(extend(model,{}),{notify:()=>assert.fail()});
	assert.throws(()=>other(accepted,null),/Invalid or consumed/);
	execute(accepted,accepted.snapshot.context);
	assert.throws(()=>execute(accepted,accepted.snapshot.context),/consumed/);
	assert.deepEqual(log,["reduced","admitted 3"]);
});

test("inspection, restoration and a losing branch do not execute or queue their reducers' effects",()=>{
	let calls=0;
	const model=machine("job","saved",{saved:[
		{on:"tick",when:["ready"],target:"done",...update("resolve",()=>{calls++;throw Error("unavailable input");}),action:"start"},
		{on:"tick",action:"observe"}],done:[]});
	const wire=structuredClone(model),sys=compose(wire);
	const actor=sys.actor({job:"saved"});
	assert.deepEqual(sys.plan(actor.snapshot(),"tick",{job:{ready:true}})[0].effects,[{type:"start"}]);
	const before={value:"saved",context:{}},run=executor(model,{observe:()=>{},start:()=>assert.fail("no accepted transition")});
	const chosen=transition(model,before,{type:"tick"},{ready:false});
	assert.deepEqual(chosen.effects,[{type:"observe"}]);run(chosen,undefined);
	assert.equal(calls,0);assert.throws(()=>transition(model,before,{type:"tick"},{ready:true}),/unavailable input/);
	assert.equal(calls,1);assert.deepEqual(before,{value:"saved",context:{}});
});

test("event-owned guards cannot be overridden by a sampled boolean or executed by the inspector",()=>{
	let reads=0;
	const matching=guard("matches",(/** @type {{pin:string}} */ c,/** @type {{type:string,pin:string}} */ e)=>{reads++;return c.pin===e.pin;});
	const m=machine("grant","held",{held:[{on:"ready",...matching,target:"open",action:"release"}],open:[]});
	const wire=structuredClone(m),sample={value:"held",context:{pin:"bound"}};
	assert.equal(step(wire,"held","ready",{matches:true})?.target,"open");assert.equal(reads,0);
	assert.equal(transition(m,sample,{type:"ready",pin:"other"},{matches:true}).snapshot,sample);
	assert.equal(transition(m,sample,{type:"ready",pin:"bound"},{matches:false}).snapshot.value,"open");
	assert.throws(()=>transition(machine(wire.id,"held",wire.states),sample,{type:"ready",pin:"bound"},{matches:true}),/Unbound event guard/);
	assert.equal(reads,2);
});

test("all alternatives for an event use the same sampled fact and context predicate",()=>{
	let observations=0,reads=0;
	const own=guard("owned",()=>{reads++;return true;});
	const m=machine("sample","a",{a:[{on:"sample",...own,when:["owned","changed","urgent"],action:"now"},
		{on:"sample",when:["owned","changed"],action:"later"}]});
	const facts={owned:false,get changed(){return ++observations===1;},urgent:false};
	assert.deepEqual(transition(m,{value:"a",context:null},{type:"sample"},facts).effects,[{type:"later"}]);
	assert.equal(reads,1);assert.equal(observations,1);
	assert.throws(()=>machine("bad","a",{a:[{on:"go",...own,when:["owned","changed"],action:"now"},
		{on:"go",...guard("owned",()=>false),action:"later"}]}),/Conflicting event guard/);
});

test("automatic forks are inspectable, complete, and cannot spin without a new external event",()=>{
	const m=machine("dispatch","idle",{idle:[{on:"wake",target:"batch",fork:["history","work"]}],
		batch:[{on:"history",action:"lookup"},{on:"work",target:"idle",action:"start"}]});
	const result=transition(m,{value:"idle",context:null},{type:"wake"});
	assert.deepEqual(result.fork,["history","work"]);assert.deepEqual(result.effects,[]);
	const [wire]=compose(structuredClone(m)).plan({dispatch:"idle"},"wake");
	assert.deepEqual(wire.fork,result.fork);
	assert.throws(()=>machine("bad","a",{a:[{on:"wake",fork:["absent"]}]}),/Invalid fork/);
	assert.throws(()=>machine("bad","a",{a:[{on:"wake",fork:["wake","wake"]}]}),/Invalid fork/);
	assert.throws(()=>extend(m,{batch:[{on:"work",target:"idle",when:["stale"],fork:["wake"]}]}),/Automatic fork cycle/);
});

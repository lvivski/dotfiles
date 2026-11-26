import assert from "node:assert/strict";
import test from "node:test";
import { chart, compose, extend, step } from "./chart.mjs";
import { implement } from "./adapter.mjs";

const reader=()=>chart("reader","idle",{
	idle:[{on:"open",target:"reading",action:"load"}],
	reading:[{on:"response",when:["ok"],target:"done"},{on:"response",target:"waiting",action:"observe"}],
	waiting:[{on:"connected",target:"reading",action:"load"}],
	done:[],
});

test("a machine is data: a signal selects a single edge, never executes an action",()=>{
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
	assert.throws(()=>Reflect.apply(chart,null,["x","absent",{s:[]}]),/initial/);
	assert.throws(()=>chart("x","s",{s:[{on:"go",target:"missing"}]}),/destination/);
	assert.throws(()=>chart("x","s",{s:[{on:"go",when:["a","!a"],target:"s"}]}),/unreachable/i);
	assert.throws(()=>chart("x","s",{s:[{on:"go",target:"s"},{on:"go",when:["a"],target:"s"}]}),/unreachable/i);
	assert.throws(()=>chart("x","s",{s:[{on:"go",when:["a"],target:"s"},{on:"go",when:["!a"],target:"s"},{on:"go",target:"s"}]}),/unreachable/i);
	const m=chart("x","s",{s:[{on:"no",when:["!seen"],action:"look"},{on:"yes",action:"stay"}]});
	assert.equal(step(m,"s","no",{seen:true}),undefined);
	assert.equal(step(m,"s","no",{seen:false})?.action,"look");
	assert.equal(step(m,"s","yes")?.action,"stay");
});

test("an extension adds a guarded lane to an active instance without replay or rebuilding the other regions",()=>{
	const original=reader(), notice=chart("notice","quiet",{quiet:[{on:"connected",target:"shown",action:"notify"}],shown:[]});
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
	assert.throws(()=>system.install(chart("reader","idle",{idle:[]})),/remove|missing/i);
	assert.throws(()=>compose(original,original),/duplicate/i);
	assert.equal(system.describe().reader,revised);
	assert.deepEqual(system.plan({reader:"waiting"},"connected",{reader:{cached:false}}).map(s=>s.edge.action),["load"]);
});

test("a signal is atomic across parallel regions, including a late guard failure",()=>{
	const a=chart("a","pending",{pending:[toNext("wake")],next:[]});
	const b=chart("b","pending",{pending:[{...toNext("wake"),when:["verified"]}],next:[]});
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
		if (!expected.includes(1)) {assert.throws(()=>chart("truth","s",{s:rows}),/unreachable/i);continue;}
		const m=chart("truth","s",{s:rows});
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
	assert.throws(()=>implement(next,base),/Unbound action: reader.restore/);
	const perform=implement(next,{...base,restore:()=>calls.push("restore")});
	const actor=compose(next).actor({reader:"waiting"}), [effect]=actor.send("cached");
	assert.deepEqual(calls,[]);assert.ok(effect.edge.action);perform(effect.edge.action,undefined);
	assert.deepEqual(calls,["restore"]);assert.throws(()=>perform("constructor",undefined),/Unknown action/);
});

test("a described extension preserves existing purposes and actor state after serialization",()=>{
	const plain=chart("job","new",{new:[{on:"begin",target:"open",description:"Start this job."}],open:[]},
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

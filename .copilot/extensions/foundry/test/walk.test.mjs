import assert from "node:assert/strict";
import test from "node:test";
import {machine,extend,step} from "../work/machine.mjs";
import {catalog} from "../work/catalog.mjs";
import { monitors } from "../work/rules/supervision.mjs";
import {inventory,obstruction,walk} from "./walk.mjs";

/** @type {import("../work/machine.mjs").Machine} */
const m=machine("ticket","new",{
	new:[{on:"queue",target:"waiting"},{on:"accept",when:["signed"],target:"done"},{on:"accept",action:"observe"}],
	waiting:[{on:"receipt",target:"done"}],done:[{on:"read",action:"show"}],
	restored:[{on:"retry",target:"waiting"}],
});
test("shortest witnesses replay on the real selector; an internal action is not an ignored signal",()=>{
	const g=walk(m);
	assert.deepEqual([...g.paths.keys()],["new","waiting","done"]);assert.deepEqual(g.closed,[["done"]]);
	const path=g.paths.get("done");assert.ok(path);assert.equal(path.length,1);
	for(const {from,edge,facts,rule} of path)assert.equal(step(m,from,edge.on,facts),m.states[from][rule]);
	assert.equal(path[0].to,"done");assert.deepEqual(path[0].facts,{signed:true});
	const held=walk(m,["new"],{signal:"accept",facts:{signed:false}});
	assert.equal(held.ignored,0);assert.deepEqual(held.edges.get("new")?.map(e=>[e.edge.action,e.to]),[["observe","new"]]);
	const restored=walk(m,["restored"]);
	assert.deepEqual(restored.paths.get("done")?.map(e=>e.edge.on),["retry","receipt"]);
	const absent=walk(m,["restored"],{signal:"accept",facts:{signed:true}});
	assert.equal(absent.ignored,1);assert.deepEqual(absent.edges.get("restored"),[]);
});

test("a cycle is closed only under the supplied evidence; an unknown guard is not false",()=>{
	const cycle=machine("sample","a",{a:[{on:"wake",target:"b"}],
		b:[{on:"wake",when:["ready"],target:"end"},{on:"wake",target:"a"}],end:[]});
	assert.deepEqual(walk(cycle).closed,[["end"]]);
	assert.deepEqual(walk(cycle,["a"],{signal:"wake",facts:{ready:false}}).closed,[["a","b"]]);
	assert.throws(()=>walk(cycle,["a"],{signal:"wake",facts:{}}),/Missing boolean guard/);
});

test("every registered state has an entry witness; a new orphan cannot pass as a projection",()=>{
	const {machines}=catalog();
	for(const row of inventory(machines)){
		assert.deepEqual(row.unreachable,[],row.region);
		assert.equal(row.winningRules,row.rules,row.region);
	}
	const changed={...machines,release:extend(machines.release,{orphan:[{on:"assess",action:"wait"}]})};
	assert.deepEqual(inventory(changed).find(r=>r.region==="release")?.unreachable,["orphan"]);
	assert.deepEqual(Object.keys(inventory(machines).find(r=>r.region==="renewal")?.restoredOnly??{}),["presenting"]);
});

test("universal progress finds an escapable livelock and distinguishes a dead end",()=>{
	/** @param {string} s */
	const next=s=>s==="start"?["end","a"]:s==="a"?["end","b"]:["a"];
	assert.deepEqual(obstruction("start",next,s=>s==="end"),{prefix:["start"],cycle:["a","b","a"]});
	const untilHeld=(/** @type {string} */ s)=>s==="start"?["end","held"]:[];
	assert.deepEqual(obstruction("start",untilHeld,s=>s==="end"),{prefix:["start","held"]});
});

test("stable evidence and fair samples route each owed wake; a history lookup cannot discharge a dispatch obligation",()=>{
	for(const [flag,gate,action] of [
		["managed","managed-policy","reactivate"],["local","issuer-permission","reconcile"],["missing","missing-target","reconcile"],
		["retryRead","workflow-status","reconcile"],["formDue","approval-delivery","reconcile"],["participant","ledger","reconcile"],
	])for(const evidence of [true,false])for(const pending of [true,false]){
		const facts={expired:false,managed:false,local:false,missing:false,retryRead:false,participant:false,formDue:false,
			[flag]:true,permitted:evidence,presentable:evidence,available:evidence,changed:flag!=="formDue" && evidence};
		/** @param {string} state */
		const next=state=>{
			const rows=monitors.plan({supervision:state,history:pending?"pending":"idle"},"sample",{supervision:facts});
			assert.equal(rows.find(r=>r.region==="history")?.edge.action,pending?"lookup":undefined);
			const row=rows.find(r=>r.region==="supervision");assert.ok(row);
			if(state==="dispatch")assert.equal(row.to,gate);
			return [row.edge.action===action?"owed wake":row.to];
		};
		const problem=obstruction("dispatch",next,s=>s==="owed wake");
		if(evidence||flag==="retryRead")assert.equal(problem,undefined,flag);
		else assert.deepEqual(problem,{prefix:["dispatch"],cycle:[gate,gate]},flag);
	}
});

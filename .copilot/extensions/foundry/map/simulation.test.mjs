import assert from "node:assert/strict";
import test from "node:test";
import { catalog } from "../work/catalog.mjs";
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

import assert from "node:assert/strict";
import test from "node:test";
import { mixedGrant, submittedGrant } from "../test/ownership.mjs";
import { git } from "../test/fixture.mjs";

test("a broader review cannot displace a checked mixed grant",async t=>{
	const {issued,f}=await mixedGrant(t,"prevent");
	assert.ok(issued.nodes.some(n=>n.grain==="picker" && n.state==="qualified"),"the checked primary lost its owner");
	assert.ok(!issued.nodes.some(n=>n.grain==="controls"));assert.equal(f.workers.size,2);
	assert.match(issued.reviews.at(-1)?.reason??"",/mixed grant|exact.file/);
});

test("a previously joined product retains its historical broad owner",async t=>{
	const {proof,f,primary,file}=await submittedGrant(t,"legacy join");
	assert.ok(proof.qualified && !proof.outputs?.picker && proof.outputs?.controls);
	assert.equal(git(f.root,"show",`${proof.qualified}:${primary}/result`),"keep");
	assert.equal(git(f.root,"show",`${proof.qualified}:${file}`),"new control");
	assert.doesNotMatch(proof.products?.at(-1)?.receipt?.output??"",/"picker":/);
});

test("an issued writer may publish without integrating through a displaced grant",async t=>{
	const {proof,before,f}=await submittedGrant(t,"issued writer");
	assert.equal(proof.qualified,null);assert.deepEqual(proof.products,before.products);assert.deepEqual(proof.goalChecks,before.goalChecks);
	assert.equal(proof.nodes.find(n=>n.grain==="controls")?.state,"published");
	assert.match(proof.blocker??"",/picker.*controls|controls.*picker/);assert.equal(f.workers.size,3);
});

import assert from "node:assert/strict";
import test from "node:test";
import { git, put } from "../test/fixture.mjs";
import { displacedGrant, publishedRetainer, submittedGrant } from "../test/ownership.mjs";
import { historicalRuntime } from "../test/legacy-readers.mjs";
import { openDatabase } from "./database.mjs";
import { prepareRestoration } from "./restoration.mjs";
import { createRuntime } from "./runtime.mjs";

test("restore the orphan without displacing an issued repair",async t=>{
	const {f,run,worker,file,before,parent,primary}=await displacedGrant(t,"restore issued");
	const read=f.runtime(f.root,{confirm:async()=>true},createRuntime), broad=f.runtime(worker.cwd,{},createRuntime);
	put(worker.cwd,file,"new control");
	const submitted=await broad.operation("submit",{run,token:worker.token},worker.id);
	const repair=submitted.nodes.find(n=>n.grain==="controls");assert.ok(repair?.state==="writing" && repair.token!==worker.token && repair.receipt && repair.receipt.exit===1,"retain the original writer's bounded repair while integration is held");
	const checkpoint=before.products?.at(-1)?.check, goal=before.goalChecks?.at(-1)?.id;
	await read.operation("restore",{run,from:"picker",historical:checkpoint,retainer:"controls",to:"selector",checkpoint,goal},"owner");
	const attester=[...f.workers.values()].at(-1);assert.ok(attester && attester.id!==worker.id);
	await f.runtime(attester.cwd,{},createRuntime).operation("submit",{run,token:attester.token},attester.id);
	assert.deepEqual(read.inspect({run,detail:"proof"},"owner").products,before.products);
	put(worker.cwd,`${parent}/fixed`,"available");
	await broad.operation("submit",{run,token:repair.token},worker.id);
	const end=read.inspect({run,detail:"proof"},"owner");assert.ok(end.qualified && end.outputs?.selector && end.outputs.controls && !end.outputs.picker);
	assert.equal(git(f.root,"show",`${end.qualified}:${file}`),"new control");
	assert.deepEqual(end.products?.slice(0,-1),before.products);
});

test("restore ownership on the original joined product",async t=>{
	const {f,run,worker,file,before,primary,proof,proposal}=await submittedGrant(t,"restore joined");
	assert.ok(proof.outputs?.controls && !proof.outputs.picker && proof.checkpoint && !proof.qualified);
	const read=f.runtime(f.root,{confirm:async()=>true},createRuntime);
	const receipt=proof.goalChecks?.at(-1)?.id, historical=before.products?.at(-1)?.check;
	assert.ok(receipt && historical && proof.goal?.receipt?.exit===2);
	const request={run,from:"picker",historical,retainer:"controls",to:"selector",checkpoint:proof.products?.at(-1)?.check,goal:receipt};
	assert.equal(read.inspect({run,detail:"proof"},"owner").release?.reason,"ownership-conflict");
	await assert.rejects(read.operation("restore",{...request,retainer:"core"},"owner"),{code:"invalid_restoration"});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("restore",request,"owner"),{code:"approval_declined"});
	await read.operation("restore",request,"owner");await f.settle();
	const writer=[...f.workers.values()].at(-1);assert.ok(writer && writer.id!==worker.id);
	assert.equal(git(writer.cwd,"show",`HEAD:${primary}/result`),"keep");
	put(writer.cwd,`${primary}/result`,"different");
	const fresh=f.runtime(writer.cwd,{},createRuntime);
	await assert.rejects(fresh.operation("submit",{run,token:writer.token},writer.id),{code:"changed_restoration"});
	put(writer.cwd,`${primary}/result`,"keep");put(writer.cwd,file,"not granted");
	await fresh.operation("submit",{run,token:writer.token},writer.id);
	const after=read.inspect({run,detail:"proof"},"owner");assert.ok(after.outputs?.selector && !after.outputs.picker);
	assert.equal(after.outputs.controls,proof.outputs.controls);assert.notEqual(after.checkpoint,proof.checkpoint);
	assert.equal(git(f.root,"rev-parse",`${after.checkpoint}^{tree}`),git(f.root,"rev-parse",`${proof.checkpoint}^{tree}`));
	assert.deepEqual(after.products?.slice(0,-1),proof.products);assert.deepEqual(after.goalChecks?.slice(0,-1),proof.goalChecks);
	assert.match(after.products?.at(-1)?.receipt?.output??"",/"selector":\{"directories":\["unit\/picker"\],"files":\[\]\}/);
	assert.equal(after.goal?.receipt?.exit,2);assert.equal(after.goal?.receipt?.commit,after.checkpoint);assert.equal(after.qualified,null);
	assert.ok(after.checkpoint && after.goalChecks?.at(-1)?.id);put(f.root,"next","Complete the independent behavior.");
	const ref=(await read.operation("publish",{run,file:"next",to:["unit/done"]},"owner")).artifacts.at(-1);assert.ok(ref);
	await read.operation("iterate",{run,receipt:after.goalChecks.at(-1)?.id,blob:ref.blob,question:"Complete the independent behavior.",directory:"unit/done",source:{commit:after.checkpoint,file,excerpt:"new control"}},"owner");await f.settle();
	await f.scouts.at(-1)?.report(proposal("finish","unit/done",file));
	const end=[...f.workers.values()].at(-1);assert.ok(end && end.id!==writer.id);put(end.cwd,"unit/done/result","ok");
	await f.runtime(end.cwd,{},createRuntime).operation("submit",{run,token:end.token},end.id);
	const final=read.inspect({run,detail:"proof"},"owner");assert.ok(final.qualified && final.outputs?.selector===after.outputs.selector);
});

for (const mode of ["restore pending","restore cited"]) test(`partial repartition of a checked mixed grant / ${mode}`,async t=>{
	const {f,run,owner,file,primary,review,citation,proof,before,cited,rail,a,b,current,priorChecks,request,first}=await publishedRetainer(t,mode);
	if (cited) {
		const old=await historicalRuntime(t,54);
		const blocked=f.runtime(f.root,{confirm:async()=>assert.fail("unexpected approval")},old);
		await assert.rejects(blocked.operation("restore",request,"owner"),{code:"dispatch_held"});
		assert.deepEqual(blocked.inspect({run,detail:"proof"},"owner").products,current.products);blocked.close();
	}
	if (cited) {
		const db=openDatabase(f.root);t.after(()=>db.close());
		const snapshot=db.read(run);assert.ok(snapshot);
		const oldPin=before.outputs?.picker;assert.ok(oldPin);
		/** @param {(r:import("./model.js").Run)=>void} change @param {RegExp} reason */
		function refused(change,reason) {
			assert.ok(snapshot);
			const r=structuredClone(snapshot);change(r);
			assert.throws(()=>prepareRestoration(f.root,r,"owner",request,e=>db.verifySigned(run,e)),{code:"dispatch_held",message:reason});
		}
		refused(r=>{r.nodes.buttons.state="writing";},/buttons \(writing\)/);
		refused(r=>{r.nodes.buttons.inputs={picker:oldPin};},/buttons \(published\)/);
		refused(r=>{r.nodes.buttons.grain.needs=["core"];r.nodes.core.grain.needs=["picker"];},/buttons \(published\)/);
		refused(r=>{r.nodes.buttons.supporting=[citation];},/buttons \(published\)/);
		refused(r=>{
			const scout=r.effects.find(e=>e.id===r.nodes.rail.review);assert.ok(scout?.kind==="scout" && scout.observation);
			scout.observation.evidence.push(citation);
		},/rail \(published\)/);
		refused(r=>{
			const scout=r.effects.find(e=>e.id===review.id);assert.ok(scout?.kind==="scout" && scout.packet);
			delete scout.packet.files[citation];
		},/buttons \(published\)/);
		refused(r=>{
			const scout=r.effects.find(e=>e.id===review.id);assert.ok(scout?.kind==="scout" && scout.packet);
			scout.base=scout.packet.base=f.tip;
		},/buttons \(published\)/);
		refused(r=>{const call=r.effects.find(e=>e.grain==="buttons" && e.kind==="writer");assert.ok(call);call.state="uncertain";},/writer .*uncertain/);
	}
	await owner.operation("restore",request,"owner");
	const attester=[...f.workers.values()].at(-1);assert.ok(attester && attester.id!==rail.id);
	const fresh=f.runtime(attester.cwd,{},first);
	if (cited) {
		put(attester.cwd,citation,"changed");
		await assert.rejects(fresh.operation("submit",{run,token:attester.token},attester.id),{code:"changed_restoration"});
		put(attester.cwd,citation,"keep");
	}
	await fresh.operation("submit",{run,token:attester.token},attester.id);
	const end=owner.inspect({run,detail:"proof"},"owner");assert.ok(end.qualified && end.outputs?.selector);
	assert.equal(end.outputs.buttons,a.checked);assert.equal(end.outputs.rail,b.checked);assert.equal(end.outputs.controls,undefined);
	assert.equal(git(f.root,"show",`${end.qualified}:${file}`),"current button");assert.equal(git(f.root,"show",`${end.qualified}:unit/rail/change`),"reordered");
	assert.equal(git(f.root,"show",`${end.qualified}:${citation}`),"keep");
	assert.deepEqual(end.reviews.find(r=>r.id===review.id),current.reviews.find(r=>r.id===review.id));
	assert.deepEqual(end.goalChecks?.slice(0,-1),current.goalChecks);assert.deepEqual(end.products?.slice(0,-1),current.products);
	assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check joined product","Check final goal"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { firstObserver, observerInputs, failedFinalDiagnostic } from "../test/ownership.mjs";
import { createRuntime } from "./runtime.mjs";

test("the stopped attester prepares the exact observer grant without writing or asking the owner to identify blobs",async t=>{
	const {f,run,db,attester,paired,author}=await observerInputs(t,"observer pass"), owner=f.runtime(f.root,{confirm:async()=>true},createRuntime),
		writer=f.runtime(attester.cwd,{},createRuntime);
	const before=db.read(run),count=f.workers.size;assert.ok(before);
	await writer.operation("propose",{run,token:attester.token,check:paired.id,observer:{file:author.file}},attester.id);
	const offer=owner.inspect({run},"owner").recovery.find(a=>a.kind==="proposal");assert.ok(offer);
	const {run:_,...observer}=author;assert.deepEqual(offer.arguments,{run,observer});
	assert.deepEqual(db.read(run)?.nodes,before.nodes);assert.deepEqual(db.read(run)?.effects,before.effects);
	await owner.operation("diagnose",author,"owner");assert.equal(f.workers.size,count+1);
	assert.ok([...f.workers.values()].at(-1)?.prompt.includes(author.file));
});

test("a retaining writer authors the diagnostic scope for production, not the owner",async t=>{
	const {f,db,run,component,producer,implementation,regression}=await failedFinalDiagnostic(t,"production pass");
	const before=db.read(run),n=before?.nodes[producer],w=n && f.workers.get(n.worker??"");assert.ok(before && n?.token && w && component.commit);
	const r=f.runtime(w.cwd,{},createRuntime),owner=f.runtime(f.root,{confirm:async()=>true},createRuntime);
	const input={run,token:n.token,check:component.id,production:{files:[implementation,regression],task:"Reproduce the failure and repair only the responsible production path."}};
	await r.operation("propose",input,w.id);
	const proposal=owner.inspect({run},"owner").recovery.find(x=>x.kind==="proposal");assert.ok(proposal?.arguments);
	const body=proposal.arguments.production;assert.ok(body && typeof body==="object" && !Array.isArray(body));assert.equal(body.producer,producer);
	assert.deepEqual(body.files,input.production.files);assert.equal(body.diagnostic,component.id);
	assert.deepEqual(db.read(run)?.nodes,before.nodes);
	const count=f.workers.size;await owner.operation("remediate",{run,...body},"owner");assert.equal(f.workers.size,count+1);
	const repair=[...f.workers.values()].at(-1);assert.ok(repair && repair.id!==w.id && repair.prompt.includes(regression));
});

test("component writers supply all their own checkpoint footprints; missing proofs cannot start a check",async t=>{
	const {f,db,run,settled,result,args,original,paired,stages,loadInputs}=await firstObserver(t,"independent pass");
	const alpha=settled.nodes.alpha;assert.ok(alpha.check && alpha.candidate && result.check && args.component);
	const selected=[{grain:"alpha",candidate:alpha.candidate,component:alpha.check}];
	const batch={run,observer:result.check,checkpoint:args.checkpoint,goal:args.goal,target:f.tip,selected};
	const owner=f.runtime(f.root,{confirm:async()=>true},createRuntime);
	await assert.rejects(owner.operation("checkpoint",batch,"owner"),/footprint/);
	await owner.operation("checkpoint",{...batch,requestEvidence:true},"owner");
	const requests=db.read(run)?.instructions?.filter(e=>e.instruction?.kind==="footprint")??[];
	assert.equal(requests.length,5);assert.ok(requests.every(e=>e.state==="done" && e.args.session_id!=="owner"));
	assert.equal(db.read(run)?.independent,undefined);
	for(const check of [original.id,paired.id,result.check,args.component,alpha.check]){
		const e=settled.effects.find(e=>e.id===check);assert.ok(e?.kind==="component" && e.grain);
		const n=settled.nodes[e.grain],w=f.workers.get(n.worker??"");assert.ok(w && n.token);
		const evidence=Object.fromEntries(stages.map(stage=>[stage,[{file:"unit.mjs",excerpt:loadInputs,inventory:{file:"build.json",keys:[e.grain,stage]},reason:"The evaluator reads from the declared inventory."}]]));
		await f.runtime(w.cwd,{},createRuntime).operation("propose",{run,token:n.token,check,footprint:{stages:evidence}},w.id);
	}
	assert.equal(db.read(run)?.independent,undefined);
	const offer=owner.inspect({run},"owner").recovery.find(a=>a.kind==="subset");assert.ok(offer?.arguments);
	assert.deepEqual(offer.arguments,batch);
	await owner.operation("checkpoint",offer.arguments,"owner");
	assert.ok(db.read(run)?.independent);assert.equal(owner.inspect({run},"owner").qualified,null);
});

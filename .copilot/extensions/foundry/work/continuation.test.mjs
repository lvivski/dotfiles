import assert from "node:assert/strict";
import test from "node:test";
import { git, put, scriptedInspections, settleSubmitted } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { prepareBaselines } from "./baseline.mjs";
import { openDatabase } from "./database.mjs";
import { prepareInput } from "./resupply.mjs";
import { createRuntime } from "./runtime.mjs";

const run="archive",source=".foundry/archive.json",charter=".foundry/scope.md",boundary=".foundry/shared.md",unit="unit.mjs";
for(const change of ["charter","boundary","checker","moved before prepared delivery"])test(`reader-94 frozen writers after prospective charter adoption / ${change}`,async t=>{
	const incompatible=change==="boundary" || change==="checker",move=change==="moved before prepared delivery";
	const build=await historicalFactory(t,94),f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Preserve the inventory and read a reference.",
		productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"outputs",charter,boundary:[boundary],areas:["parts"],checks:[unit]}]}),
		[charter]:"Produce only the specified outputs.",[boundary]:"Only the named directories.",[unit]:"","product.mjs":"",
		"goal.mjs":`import {existsSync as has,readFileSync as read} from "node:fs";process.exit(!has("parts/start/proof")?1:has("parts/read/value") && ["one","two","three"].every(id=>read("parts/"+id+"/old","utf8")===id+" verified")?0:2);`,
		"parts/one/old":"one","parts/two/old":"two","parts/three/old":"three"});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const grains=[["start","parts/start"],["read","parts/read"],["keep",["parts/one","parts/two"]],["tail","parts/three"],["index","parts/index"]].map(([id,directory])=>
		({id,directory,task:`Produce ${id}.`,check:unit,needs:id==="index"?["start"]:[]}));
	await f.scouts[0].report({outcome:"regenerate",reason:"The remaining evidence is missing.",evidence:[charter],grains});
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail("missing run");
	const worker=(/** @type {string} */ id)=>f.workers.get(read().nodes[id].worker??"")??assert.fail();
	const file="reference.txt";put(f.root,file,"one row");const blob=git(f.root,"hash-object",file);
	const first=worker("start");put(first.cwd,"parts/start/proof","first");await f.runtime(first.cwd).operation("submit",{run,token:first.token},first.id);
	for(const id of ["read","keep","tail"]){const w=worker(id);await f.runtime(w.cwd).operation("submit",{run,token:w.token,missingInput:id==="read"?"Need the reference.":"Need my prior inventory.",...(id==="read" && {inputBlob:blob})},w.id);}
	const dep=worker("index");await f.runtime(dep.cwd).operation("submit",{run,token:dep.token,missingInput:"Need the reference.",inputBlob:blob},dep.id);
	const before=read(),last=before.products.at(-1);assert.ok(last&&before.goal);
	assert.ok(!before.nodes.read.check&&!before.nodes.read.preview&&!before.nodes.read.priorSource);
	assert.ok(Array.isArray(before.nodes.keep.priorSource));assert.ok(before.nodes.index.inputs?.start);
	const files=[charter];put(f.root,charter,"Use the revised specification for subsequent work.");
	if(incompatible){files.push(change==="boundary"?boundary:unit);put(f.root,files[1],change==="boundary"?"New boundary.":"// Changed checker\n");}
	git(f.root,"add",...files);git(f.root,"commit","-qm","Adopt prospective contract");
	const revision=git(f.root,"rev-parse","HEAD");
	const priorOwner=f.runtime(f.root,{confirm:async()=>true});
	await priorOwner.operation("repin",{run,kind:"target",from:f.tip,revision,files,checkpoint:last.check,goal:before.goal.check,acceptance:"Apply the new contract prospectively."},"owner");
	await priorOwner.operation("publish",{run,file,to:["parts/read","parts/index"]},"owner");
	const input={run,grain:"read",blob},baseline={run,grains:["keep","tail"]};
	await assert.rejects(priorOwner.operation("input",input,"owner"),/specification, boundary or component check changed/);
	await assert.rejects(priorOwner.operation("repairBaseline",baseline,"owner"),/original charter, boundary or component check changed/);
	const original=read(),checkpoint=original.products.at(-1);assert.ok(checkpoint && original.goal);
	priorOwner.close();f.owner.close();const inspect=scriptedInspections(f.root);
	const oldBlob=git(f.root,"rev-parse",`${f.tip}:${charter}`),newBlob=git(f.root,"rev-parse",`${revision}:${charter}`);
	/** @type {string[]} */ const prompts=[];let approve=false;
	const owner=f.runtime(f.root,{...inspect,autoConfirm:async()=>true,confirm:async msg=>{prompts.push(msg);return approve;},
		execute:async(tool,args,key)=>move && tool==="send_session_message" ? {resultType:"failure",error:"This session management tool is disabled"} : f.execute(tool,args,key)},createRuntime);
	owner.turn("owner");await owner.flush();
	for(const id of ["read","keep","tail","index"])assert.equal(read().nodes[id].state,"blocked","an exact artifact does not approve a different charter");
	if(incompatible){
		await assert.rejects(owner.operation("input",input,"owner"),{code:"stale_assignment"});
		await assert.rejects(owner.operation("repairBaseline",baseline,"owner"),{code:"stale_assignment"});
		assert.equal(prompts.length,0);assert.equal(read().effects.filter(e=>e.kind==="repair").length,0);return;
	}
	const decision=owner.inspect({run},"owner").recovery.find(a=>a.kind==="input" && a.grain==="read");
	assert.equal(decision?.disposition,"decision","do not tell the writer to wait for bytes that are already present");
	assert.deepEqual(decision?.arguments,{run,input:{grain:"read",blob}});
	if(move){
		approve=true;
		await owner.operation("repairBaseline",{run,grains:["keep"]},"owner");
		const e=read().effects.find(e=>e.kind==="repair" && e.continuation);assert.ok(e?.kind==="repair" && e.state==="ordinary" && e.callId);
		const w=worker("keep"),thread=f.runtime(w.cwd,inspect,createRuntime);
		await assert.rejects(thread.operation("submit",{run,token:e.token},w.id),{code:"dispatch_held"});
		put(f.root,charter,"Yet another prospective charter.");git(f.root,"commit","-qam","Change after approval");
		await assert.rejects(owner.pre(e.tool,e.args,"owner","obsolete-baseline"),{code:"unreserved_call"});
		owner.turn("owner");await owner.flush();
		assert.equal(read().effects.find(job=>job.id===e.id)?.state,"withdrawn");assert.deepEqual(read().nodes.keep,original.nodes.keep);
		await assert.rejects(thread.operation("submit",{run,token:e.token},w.id),{code:"stale_assignment"});assert.equal(prompts.length,1);return;
	}
	const verify=(/** @type {import("./model.js").NativeCall} */ e)=>db.verifySigned(run,e);
	assert.equal(prepareInput(f.root,original,"owner",{run,grain:"index",blob},verify).consent,"native","the exact dependency ID and pin are eligible");
	// Retaining the same Git objects under a different output ID is not preserving a prerequisite.
	for(const variant of ["removed","new output","new directory","different version","missing from checkpoint"]){
		const r=structuredClone(original),s=r.nodes.start,p=r.products.at(-1);assert.ok(p&&s.candidate);
		if(variant==="removed")delete r.nodes.start;
		if(variant==="new output" || variant==="new directory"){
			delete r.nodes.start;delete p.outputs.start;r.nodes.replacement={...s,grain:{...s.grain,id:"replacement",
				directory:variant==="new directory"?"parts/other":s.grain.directory}};p.outputs.replacement=s.candidate;
		}
		if(variant==="different version")s.candidate=checkpoint.commit;
		if(variant==="missing from checkpoint")delete p.outputs.start;
		assert.throws(()=>prepareInput(f.root,r,"owner",{run,grain:"index",blob},verify),`reject ${variant}`);
	}
	// Selection is not authority: an otherwise changed writer grant does not reach the dialog.
	const forged=structuredClone(original);forged.nodes.keep.grain.task="A different job.";
	assert.throws(()=>prepareBaselines(f.root,forged,"owner",["keep"],false,verify),{code:"stale_assignment"});
	for(const [op,args] of /** @type {const} */([["input",input],["repairBaseline",baseline]])){
		await assert.rejects(owner.operation(op,args,"owner"),{code:"approval_declined"});
	}
	assert.equal(prompts.length,2);assert.equal(read().effects.filter(e=>e.kind==="repair").length,0);
	approve=true;
	for(const [op,args,ids] of /** @type {const} */([["input",input,["read"]],["repairBaseline",baseline,baseline.grains]])){
		await owner.operation(op,args,"owner");
		for(const id of ids){
			const p=prompts.at(-1),old=original.nodes[id],now=read().nodes[id];assert.ok(p&&old.worker&&old.grain.task);
			const inventory=Array.isArray(old.priorSource)?old.priorSource:old.priorSource?[old.priorSource]:[];
			for(const x of [charter,oldBlob,newBlob,old.worker,old.grain.task,unit,boundary,...(id==="read"?[blob]:inventory.map(b=>b.tree))])
				assert.ok(p.includes(x),`native form omitted ${x}`);
			assert.equal(now.state,"writing");assert.equal(now.worker,old.worker);assert.notEqual(now.token,old.token);assert.deepEqual(now.grain,old.grain);
			assert.equal(now.generation,old.generation);assert.deepEqual(now.inputs,old.inputs);
			const w=worker(id),writer=settleSubmitted(f.runtime(w.cwd,inspect,createRuntime));
			assert.deepEqual(writer.inspect({run},w.id).nodes.find(n=>n.grain===id)?.frozenCharter,{file:charter,from:oldBlob,to:newBlob,target:revision,productEvaluator:revision,goalEvaluator:revision});
			if(id==="read")put(w.cwd,"parts/read/value",git(w.cwd,"cat-file","blob",blob));
			else for(const b of inventory)put(w.cwd,b.directory+"/old",git(w.cwd,"show",`${b.revision}:${b.directory}/old`)+" verified");
			await writer.operation("submit",{run,token:now.token},w.id);assert.ok(read().inspections?.some(i=>i.component===read().nodes[id].check&&i.state==="approved"));
		}
	}
	owner.turn("owner");await owner.flush();const after=read(),qualified=owner.inspect({run},"owner").qualified;assert.ok(qualified);
	assert.equal(after.nodes.index.state,"blocked");assert.equal(after.effects.filter(e=>e.kind==="writer").length,5);
	assert.equal(git(f.root,"show",`${qualified}:parts/read/value`),"one row");assert.equal(git(f.root,"show",`${qualified}:${charter}`),git(f.root,"show",`${revision}:${charter}`));
	assert.deepEqual(after.effects.find(e=>e.id===checkpoint.check),original.effects.find(e=>e.id===checkpoint.check));assert.equal(prompts.length,4);
});

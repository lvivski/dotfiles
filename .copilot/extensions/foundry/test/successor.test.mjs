import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { observe, parseObservation, reserveIteration } from "../work/graph.mjs";
import { assignmentCount } from "../work/capacity.mjs";
import { decode } from "../work/snapshot.mjs";
import { factory, git, put } from "./fixture.mjs";

const cases=[
	{stop:"cannotRepair",mixed:true,exit:2},
	{stop:"relinquish",mixed:true,exit:2},
	{stop:"delivered repair",mixed:false,exit:1},
	{stop:"relinquish",mixed:true,exit:1,label:"unmet goal after secondary exit 251"},
	{stop:"delivered repair",mixed:true,exit:1,label:"unmet goal after secondary exit 2"}
];
for (const {stop,mixed,exit,label=stop} of cases) test(`fresh narrow successor on the same stopped checkpoint / ${label}`, async t=>{
	const previous=process.env.FOUNDRY_SUCCESSOR_BEFORE;
	/** @type {typeof factory} */
	const build=previous?(await import(pathToFileURL(path.resolve(previous,"test/fixture.mjs")).href)).factory:factory;
	const run="display", brief=".foundry/display.json", check="component.mjs", directory="unit/picker";
	const file=mixed?"unit/entry":`${directory}/entry`, files=mixed?[file]:undefined;
	const scope=files?{primary:directory,files}:directory;
	const f=build(t,run,brief,{
		[brief]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Render the selected item.",ownership:"exact-files",
			productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"view",areas:["unit","core"],charter:"brief",checks:[check]}]}),
		".foundry/display/journey.md":"Select the item.","brief":"Display the selection.",[file]:"disconnected","unit/sibling":"keep",[`${directory}/existing`]:"current",
		[check]:`import {readFileSync as read} from "node:fs";if(process.env.FOUNDRY_GRAIN==="sample"){${mixed && exit===1?`if(read("${file}","utf8")!=="wired")process.exit(1);console.log("Primary selection connected.");`:""}console.log("Secondary observation unavailable.");process.exit(${stop==="relinquish"?251:2});}
if(process.env.FOUNDRY_GRAIN==="picker"&&read("${file}","utf8")!=="wired")process.exit(1);`,
		"product.mjs":`import assert from "node:assert/strict";const m=JSON.parse(process.env.FOUNDRY_OWNERSHIP);assert.ok(!m.sample);if(m.picker)assert.deepEqual(m.picker,{directories:["${directory}"],files:${JSON.stringify(files??[])}});`,
		"goal.mjs":`import {existsSync as has,readFileSync as read} from "node:fs";process.exit(!has("core/out")?1:read("${file}","utf8")==="wired"?0:${exit});`
	});
	await f.start();
	await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"Implement and observe the selection.",evidence:["brief"],grains:[
		{id:"sample",task:"Connect and observe the selection.",directory:"unit",check,needs:[]},{id:"core",task:"Provide the core.",directory:"core",check,needs:[]}]});
	const w=f.workers.get((await f.status()).nodes.find(n=>n.grain==="sample")?.worker ?? "");assert.ok(w);
	put(w.cwd,file,mixed && exit===1?"wired":"failed draft");put(w.cwd,`${directory}/draft`,"not an input");
	const writer=f.runtime(w.cwd,{execute:async(...a)=>{
		const result=await f.execute(...a);
		if(stop==="delivered repair"&&a[0]==="bash"){f.owner.turn("owner");await f.owner.flush();}
		return result;
	}});
	await writer.operation("submit",{run,token:w.token},w.id);
	const bound=writer.inspect({run},w.id).nodes.find(n=>n.grain==="sample"), failed=(await f.status()).nodes.find(n=>n.grain==="sample")?.check;
	assert.ok(failed && bound?.token);
	if (mixed && exit===1) {
		assert.ok(bound.receipt);
		assert.equal(bound.receipt.exit,stop==="relinquish"?251:2);
		assert.match(bound.receipt.output,/Primary selection connected\.\s+Secondary observation unavailable\./);
	}
	await writer.operation("submit",{run,token:bound.token,[stop==="cannotRepair"?stop:"relinquish"]:{check:failed,reason:"Secondary observation unavailable."}},w.id);
	const c=f.workers.get((await f.status()).nodes.find(n=>n.grain==="core")?.worker ?? "");assert.ok(c);
	put(c.cwd,"core/out","checked");await f.runtime(c.cwd).operation("submit",{run,token:c.token},c.id);
	for (const scout of f.scouts.slice(1)) await scout.report({outcome:"unresolved",reason:"No independent observation available.",evidence:["brief"],grains:[]});
	await f.owner.operation("configure",{run,revision:1,checkpointReviews:true},"owner");
	put(f.root,"reference","Connect the current view.");
	const [offer]=(await f.owner.operation("publish",{run,file:"reference",to:[directory]},"owner")).artifacts;
	const old=f.runtime(f.root,{confirm:async()=>true});
	const proof=old.inspect({run,detail:"proof"},"owner"), receipt=proof.goalChecks?.at(-1)?.id;assert.equal(proof.goal?.receipt?.exit,exit);assert.ok(receipt && proof.checkpoint);
	const args={run,receipt,blob:offer.blob,question:"Connect the current entry.",directory,...(files&&{files}),
		source:{commit:proof.checkpoint,file,excerpt:"disconnected"}}, successor={from:"sample",check:failed,to:"picker"};
	await assert.rejects(old.operation("iterate",args,"owner"),{code:exit===2?"dispatch_held":"invalid_receipt"});
	if(previous)await assert.rejects(old.operation("iterate",{...args,successor},"owner"),{code:"unsupported_field"});
	old.close();f.owner.close();
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	const before=read();let consent=true;
	const owner=f.runtime(f.root,{confirm:async msg=>{assert.ok(msg.includes(failed)&&msg.includes("picker"));return consent;}},createRuntime);
	if(stop==="cannotRepair"){
		await assert.rejects(owner.operation("iterate",{...args,successor:{...successor,check:receipt}},"owner"),{code:"invalid_successor"});
		await assert.rejects(owner.operation("iterate",{...args,successor,directory:"unit",files:undefined},"owner"));
		for (const guard of ["budget","consumer","uncertain"]) {
			const r=structuredClone(before);
			if (guard==="budget") r.policy.assignments=assignmentCount(r)+1;
			if (guard==="consumer") r.nodes.core={...r.nodes.core,state:"writing",supporting:[file]};
			if (guard==="uncertain") {const e=r.effects.find(e=>e.grain==="sample"&&e.kind==="writer");assert.ok(e);e.state="uncertain";}
			assert.throws(()=>reserveIteration(f.root,r,"owner",{...args,successor},undefined,args.source),
				{code:guard==="budget"?"limit":guard==="consumer"?"frozen_assignment":"dispatch_held"});
		}
	}
	consent=false;await assert.rejects(owner.operation("iterate",{...args,successor},"owner"),{code:"approval_declined"});assert.deepEqual(read(),before);
	consent=true;await owner.operation("iterate",{...args,successor},"owner");await f.settle();
	const scout=f.scouts.at(-1);assert.ok(scout && scout.prompt.includes("picker"));
	const grain={id:"picker",directory:scope,task:"Connect the selection.",check,needs:["core"]};
	const report={outcome:"regenerate",reason:"The current entry is disconnected.",evidence:[file],grains:[grain]};
	if(stop==="cannotRepair")for (const wrong of [{id:"other"},{check:"other.mjs"},{needs:["sample"]},{directory:"unit"}]){
		const r=read();
		/** @type {import("../work/model.js").Effect|undefined} */ const rev=r.effects.find(e=>e.id===scout.id);assert.ok(rev?.kind==="scout");
		assert.throws(()=>observe(f.root,r,rev,parseObservation(r.policy.squads[0],{...report,grains:[{...grain,...wrong}]})),{code:"invalid_successor"});
		assert.deepEqual(r.nodes,before.nodes);
	}
	await scout.report(report);
	const assigned=read(), worker=f.workers.get(assigned.nodes.picker?.worker??"");assert.ok(worker,JSON.stringify(assigned.effects.at(-1)));
	assert.notEqual(worker.id,w.id);assert.equal(readFileSync(path.join(worker.cwd,file),"utf8"),"disconnected");
	assert.equal(readFileSync(path.join(worker.cwd,directory,"existing"),"utf8"),"current");assert.ok(!existsSync(path.join(worker.cwd,directory,"draft")));
	const next=f.runtime(worker.cwd,{},createRuntime);
	await assert.rejects(next.operation("submit",{run,token:worker.token},worker.id),{code:"unchanged_candidate"});
	put(worker.cwd,file,"wired");put(worker.cwd,"unit/sibling","out of scope");
	await next.operation("submit",{run,token:worker.token},worker.id);
	const end=read(), last=end.products.at(-1);assert.ok(last?.qualifiedAt);
	assert.equal(git(f.root,"show",`${last.commit}:${file}`),"wired");assert.equal(git(f.root,"show",`${last.commit}:unit/sibling`),"keep");
	assert.deepEqual(end.effects.slice(0,before.effects.length),before.effects);assert.deepEqual(end.products.slice(0,before.products.length),before.products);
	assert.deepEqual(end.nodes.sample.stop,before.nodes.sample.stop);assert.equal(end.nodes.sample.check,failed);
	assert.deepEqual({...end.nodes.sample,successor:undefined},{...before.nodes.sample,successor:undefined});
	const forged=structuredClone(end);delete forged.nodes.sample.successor;assert.throws(()=>decode(forged),{code:"corrupt_run"});
	assert.deepEqual(end.effects.slice(before.effects.length).filter(e=>e.tool==="bash").map(e=>[e.kind,e.receipt?.exit]),[["component",0],["product",0],["goal",0]]);
});

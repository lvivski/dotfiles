import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { capture, combine } from "../work/product.mjs";
import { observe, parseObservation } from "../work/graph.mjs";
import { spawnSync } from "node:child_process";
import { factory, git, put } from "./fixture.mjs";

for (const scenario of ["existing run","active consumer","parent repair"]) test(`transfer two paths without retiring the original package or consumers / ${scenario}`, async t=>{
	const upgrade=scenario==="existing run", parentRepair=scenario==="parent repair";
	const prior=upgrade && process.env.FOUNDRY_TRANSFER_BEFORE;
	/** @type {typeof factory} */
	const build=prior?(await import(pathToFileURL(path.resolve(prior,"test/fixture.mjs")).href)).factory:factory;
	const run="display", source=".foundry/display.json", check=".foundry/product.mjs", directory="pkg/picker", file="pkg/views/index";
	const checker=`import assert from "node:assert/strict";import {readFileSync as read} from "node:fs";
const map=JSON.parse(process.env.FOUNDRY_OWNERSHIP), matches=(s,p)=>s.files.includes(p)||s.directories.some(d=>p===d||p.startsWith(d+"/"));
if(map.picker){const ids=p=>Object.keys(map).filter(id=>matches(map[id],p)&&!(map[id].exclude&&matches(map[id].exclude,p)));
for(const p of ["pkg/picker","pkg/picker/result","pkg/views/index"])assert.deepEqual(ids(p),["picker"]);
for(const p of ["pkg/core","pkg/views/menu","pkg/views/future","pkg/picker-new"])assert.deepEqual(ids(p),["package"]);
assert.equal(read("pkg/core","utf8"),"keep");assert.equal(read("pkg/views/menu","utf8"),"keep menu");
if(read("pkg/views/index","utf8")!=="chosen"){console.log("FOUNDRY_REPAIR=picker");process.exit(1);}
if(${parentRepair}&&!((await import("node:fs")).existsSync("pkg/views/future"))){console.log("FOUNDRY_REPAIR=package");process.exit(1);}}`;
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Render the selected item.",
		ownership:upgrade?"exact-files":"retain-except-transferred",productCheck:check,goalCheck:"goal.mjs",squads:[{id:"view",areas:["pkg","consumer"],charter:"brief",checks:["unit.mjs"]}]}),
		".foundry/display/journey.md":"Render the selection.","brief":"Render the selection.",[check]:upgrade?"":checker,"unit.mjs":"",
		"goal.mjs":`import {existsSync as has} from "node:fs";process.exit(!has("pkg/core")?1:has("pkg/picker/result")?0:2);`});
	await f.start(); await f.scouts[0].report({outcome:"regenerate",reason:"Package and consume the data.",evidence:["brief"],
		grains:[{id:"package",directory:"pkg",needs:[],task:"Provide the package.",check:"unit.mjs"},
			...(parentRepair?[]:[{id:"consumer",directory:"consumer",needs:["package"],task:"Consume the checked package.",check:"unit.mjs"}])]});
	const [p]=f.workers.values();
	put(p.cwd,"pkg/core","keep");put(p.cwd,file,"default");put(p.cwd,"pkg/views/menu","keep menu");
	await f.runtime(p.cwd).operation("submit",{run,token:p.token},p.id);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const read=()=>db.read(run) ?? assert.fail();
	const candidate=read().nodes.package.candidate;assert.ok(candidate);
	put(f.root,"reference","Select the requested item.");
	const [offer]=(await f.owner.operation("publish",{run,file:"reference",to:[directory]},"owner")).artifacts;
	const args=()=>{const r=read();assert.ok(r.goal);return {run,receipt:r.goal.check,directory,files:[file],blob:offer.blob,question:"Render the selected item.",
		source:{commit:r.goal.commit,file,excerpt:"default"}};};
	const transfer={from:"package",candidate,to:"picker"};
	const old=f.runtime(f.root,{confirm:async()=>true});
	await assert.rejects(old.operation("iterate",args(),"owner"),{code:"ownership_transition"});
	if (!upgrade && !parentRepair) {
		const active=read();assert.equal(active.nodes.consumer.inputs?.package,candidate);
		await assert.rejects(old.operation("iterate",{...args(),transfer},"owner"),{code:"frozen_assignment"});
		assert.deepEqual(read(),active);
	}
	if (!parentRepair) {
		const [,c]=f.workers.values();assert.ok(c);
		put(c.cwd,"consumer/value","consumes the original package");await f.runtime(c.cwd).operation("submit",{run,token:c.token},c.id);
	}
	const original=read(), oldChecks=original.effects.filter(e=>e.tool==="bash");old.close();f.owner.close();
	/** @type {string[]} */ const prompts=[];let consent=true;
	const owner=f.runtime(f.root,{confirm:async message=>{prompts.push(message);return consent;}},createRuntime);
	if (upgrade) {
		await assert.rejects(owner.operation("iterate",{...args(),transfer},"owner"),{code:"unsupported_ownership"});
		const side=path.join(path.dirname(f.root),"checker");git(f.root,"worktree","add","-q","--detach",side,f.tip);
		put(side,check,checker);git(side,"commit","-qam","Use exclusion-aware product attribution");
		await owner.operation("repin",{run,kind:"product",from:f.tip,revision:git(side,"rev-parse","HEAD"),files:[check],ownership:"retain-except-transferred"},"owner");
	}
	const ready=read(), input={...args(),transfer};
	const stale=f.runtime(f.root,{confirm:async()=>{put(f.root,"external","moved");git(f.root,"add","external");git(f.root,"commit","-qm","Move target");return true;}},createRuntime);
	await assert.rejects(stale.operation("iterate",input,"owner"),{code:"invalid_receipt"});
	assert.deepEqual(read(),ready);git(f.root,"update-ref","refs/heads/main",f.tip,git(f.root,"rev-parse","HEAD"));
	consent=false; await assert.rejects(owner.operation("iterate",input,"owner"),{code:"approval_declined"});assert.deepEqual(read(),ready);
	consent=true;await owner.operation("iterate",input,"owner");await f.settle();
	const review=f.scouts.at(-1);assert.ok(review && review.prompt.includes("picker"));
	const proposal={id:"picker",directory:{primary:directory,files:[file]},task:"Render the picker.",check:"unit.mjs",needs:[]};
	const report={outcome:"regenerate",reason:"Render the selected item.",evidence:[file],grains:[proposal]};
	for (const invalid of [{...proposal,id:"other"},{...proposal,needs:["package"]},{...proposal,directory:{primary:directory,files:[file,"pkg/views/menu"]}}]) {
		const copy=read();
		/** @type {import("../work/model.js").Effect|undefined} */ const r=copy.effects.find(e=>e.id===review.id);assert.ok(r?.kind==="scout");
		assert.throws(()=>observe(f.root,copy,r,parseObservation(copy.policy.squads[0],{...report,grains:[invalid]})),/approved|named receiving/);
		assert.equal(copy.nodes.package.retained,undefined);
	}
	await review.report(report);
	const assigned=read(), w=f.workers.get(assigned.nodes.picker?.worker ?? "");assert.ok(w);
	const writer=f.runtime(w.cwd,{},createRuntime);
	put(w.cwd,"pkg/picker/result","available");put(w.cwd,file,"wrong");put(w.cwd,"pkg/views/menu","must not publish");
	await writer.operation("submit",{run,token:w.token},w.id);
	const repair=read().nodes.picker;assert.equal(repair.state,"writing");assert.ok(repair.token && repair.token!==w.token);
	put(w.cwd,file,"chosen");await writer.operation("submit",{run,token:repair.token},w.id);
	if (parentRepair) {
		const waiting=read(), n=waiting.nodes.package;
		assert.ok(n.state==="writing" && n.token,`${n.state}: ${n.reason}; ${waiting.conflict}`);
		const runtime=f.runtime(p.cwd,{},createRuntime);
		put(p.cwd,file,"stale original writer");put(p.cwd,"pkg/picker/result","overwrite");put(p.cwd,"pkg/views/future","new sibling");
		await assert.rejects(runtime.operation("publish",{run,token:n.token,file,to:[directory]},p.id),{code:"charter_scope"});
		await runtime.operation("submit",{run,token:n.token},p.id);
	}
	const end=read(), last=end.products.at(-1);assert.ok(last?.qualifiedAt);
	if (parentRepair) {
		assert.notEqual(last.outputs.package,candidate);
		assert.equal(git(f.root,"show",`${last.commit}:pkg/views/future`),"new sibling");
		assert.equal(git(f.root,"show",`${last.commit}:pkg/picker/result`),"available");
	} else {
		assert.equal(last.outputs.package,candidate);assert.equal(last.outputs.consumer,ready.nodes.consumer.candidate);
		assert.deepEqual(end.nodes.consumer.inputs,{package:candidate});
	}
	assert.deepEqual(end.products.slice(0,ready.products.length),ready.products);
	assert.deepEqual(end.effects.slice(0,original.effects.length).filter(e=>e.tool==="bash"),oldChecks);
	assert.equal(git(f.root,"show",`${last.commit}:${file}`),"chosen");
	assert.equal(git(f.root,"show",`${last.commit}:pkg/views/menu`),"keep menu");
	assert.equal(end.effects.find(e=>e.id===end.goal?.check)?.receipt?.exit,0);
	assert.ok(prompts.some(s=>s.includes(candidate)&&s.includes(file)&&s.includes("future")));
	const proof=owner.inspect({run,detail:"proof"},"owner").qualification;assert.equal(proof?.format,"foundry-qualification/v4");
	assert.deepEqual(proof?.ownership?.package,{directories:["pkg"],files:[],exclude:{directories:[directory],files:[file]}});
	assert.deepEqual(proof?.ownership?.picker,{directories:[directory],files:[file]});
	if (upgrade) {
		const script=fileURLToPath(new URL("../../../skills/foundry/scripts/qualification.mjs",import.meta.url)), bundle=path.join(path.dirname(f.root),"display.bundle");
		const pack=spawnSync(process.execPath,[script,"pack",bundle],{cwd:f.root,input:JSON.stringify(proof),encoding:"utf8"});
		assert.equal(pack.status,0,pack.stderr);assert.ok(git(f.root,"bundle","list-heads",bundle).includes(last.commit));
	}
	assert.deepEqual(end.effects.slice(ready.effects.length).filter(e=>e.kind==="writer").map(e=>e.grain),["picker"]);
	const donor=end.nodes.package;assert.ok(donor.generation && donor.retained);
	put(p.cwd,file,"stale original writer");put(p.cwd,"pkg/picker/result","overwrite");put(p.cwd,"pkg/views/future","new sibling");
	const repaired=capture(p.cwd,donor.generation,donor.grain.directory,donor.retained,last.commit);
	const update={from:candidate,to:repaired,directory:"pkg",retained:donor.retained};
	const merged=combine(f.root,last.commit,[update]);
	for(const commit of [repaired,merged]) {
		assert.equal(git(f.root,"show",`${commit}:${file}`),"chosen");
		assert.equal(git(f.root,"show",`${commit}:pkg/picker/result`),"available");
		assert.equal(git(f.root,"show",`${commit}:pkg/views/future`),"new sibling");
	}
});

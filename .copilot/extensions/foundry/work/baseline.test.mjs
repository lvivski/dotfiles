import assert from "node:assert/strict";
import { once, EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { existsSync,writeFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { git, put, scriptedInspections, settleSubmitted } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";

for(const phase of ["join","goal","checkpoint advances in form","unissued goal in form","foreign permission hold","decline","unissued group member","changed supporting input","capacity"])test(`grant the original baseline group without racing settlement / ${phase}`,async t=>{
	const build=await historicalFactory(t,91),run="catalog",source=".foundry/catalog.json",ids=["first","next","one","two"],stopped=ids.slice(2);
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Preserve and verify both indexes.",
		goalCheck:"goal.mjs",productCheck:"product.mjs",squads:[{id:"catalog",areas:["units/first","units/one","units/two"],charter:"brief",checks:["unit.mjs"]},
			{id:"indexer",areas:["units/next"],charter:"indexer.md",checks:["unit.mjs"]}]}),
		".foundry/catalog/journey.md":"Preserve and verify both indexes.",brief:"Preserve all original entries.","indexer.md":"Build the index.","product.mjs":"",
		"unit.mjs":`import {readFileSync as read} from "node:fs";const id=process.env.FOUNDRY_GRAIN;if(["one","two"].includes(id)&&read("units/"+id+"/index","utf8")!==id+" verified")process.exit(1);`,
		"goal.mjs":`import {readFileSync as read,existsSync as has} from "node:fs";process.exit(["one","two"].every(id=>read("units/"+id+"/index","utf8")===id+" verified") && has("units/next/value")?0:1);`,
		"units/one/index":"one","units/two/index":"two","units/next/fixture":"original supporting input"});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	let review=f.scouts.find(s=>s.squad==="catalog")??assert.fail();const evidence=["brief"];
	if(phase==="changed supporting input"){
		await review.report({outcome:"needs-evidence",reason:"Check the test fixture used by both inventories.",file:"units/next/fixture",evidence,grains:[]});
		review=f.scouts.findLast(s=>s.squad==="catalog")??assert.fail();evidence.push("units/next/fixture");
	}
	const task=(/** @type {string} */ id)=>({id,directory:`units/${id}`,task:`Maintain ${id}.`,check:"unit.mjs",needs:[]});
	await review.report({outcome:"regenerate",reason:"Need index changes.",evidence,
		grains:ids.filter(id=>id!=="next").map(task)});
	await f.scouts.find(s=>s.squad==="indexer")?.report({outcome:"regenerate",reason:"Need the next index.",evidence:["indexer.md"],grains:[task("next")]});
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	const writer=(/** @type {string} */ id)=>f.workers.get(read().nodes[id].worker??"")??assert.fail();
	for(const id of stopped){const w=writer(id);await f.runtime(w.cwd).operation("submit",{run,token:w.token,missingInput:"Need the original inventory."},w.id);}
	const first=writer("first"),next=writer("next");
	put(first.cwd,"units/first/value","first");await f.runtime(first.cwd).operation("submit",{run,token:first.token},first.id);
	const original=read();assert.ok(original.products.at(-1));assert.ok(stopped.every(id=>original.nodes[id].state==="blocked"));
	const selection={run,grains:stopped};
	if(phase==="foreign permission hold"){
		put(next.cwd,"units/next/value","next");await f.runtime(next.cwd,{permissionBlocker:async()=>({scope:"session",message:"Unrelated issuer only"})}).operation("submit",{run,token:next.token},next.id);
		const held=read().effects.find(e=>e.kind==="component" && e.grain==="next" && e.permissionHold);assert.ok(held);
		await assert.rejects(f.runtime(f.root,{confirm:async()=>false}).operation("repairBaseline",selection,"owner"),{code:"approval_declined"});
		f.owner.close();let forms=0;const owner=f.runtime(f.root,{confirm:async()=>{forms++;return true;}},createRuntime);
		await owner.operation("repairBaseline",selection,"owner");const after=read();
		assert.equal(forms,1);assert.deepEqual(after.effects.find(e=>e.id===held.id),held);
		assert.ok(stopped.every(id=>after.nodes[id].state==="writing" && after.effects.some(e=>e.kind==="repair" && e.grain===id && e.state==="done")));return;
	}
	/** @type {(()=>Promise<unknown>)|undefined} */ let finish;
	const sibling=f.runtime(next.cwd,{execute:async(tool,args,key)=>{
		if(tool==="bash" && String(args.description).includes(phase==="goal"?"final goal":"joined product")){
			assert.equal(finish,undefined);
			if(phase==="goal" || phase==="join"){
				const gate=join(dirname(f.root),"original-claim");
				const pending=promisify(execFile)("/bin/sh",["-c",String(args.command)],{cwd:f.root,timeout:60_000,
					env:{...process.env,FOUNDRY_TEST_CLAIM_GATE:gate,FOUNDRY_TEST_AFTER_CLAIM:"1",NODE_OPTIONS:`--import=${new URL("../test/runner-claim-gate.mjs",import.meta.url).href}`}});
				let released=false;
				const release=async()=>{if(!released){writeFileSync(gate+".continue","");released=true;}await pending;};
				t.after(async()=>{if(!released && existsSync(dirname(gate)))await release();});
				const end=Date.now()+20_000;while(!existsSync(gate+".loaded")){assert.ok(Date.now()<end,"original runner must claim");await sleep(10);}
				finish=release;
			}else finish=()=>f.execute(tool,args,key);
			return {resultType:"unconfirmed"};
		}
		return f.execute(tool,args,key);
	}});
	put(next.cwd,"units/next/value","next");if(phase==="changed supporting input")put(next.cwd,"units/next/fixture","incompatible");
	await sibling.operation("submit",{run,token:next.token},next.id);
	const saved=read(),call=saved.effects.find(e=>e.id===(phase==="goal"?saved.goal?.check:saved.join?.check));
	assert.ok(finish && call?.tool==="bash" && call.callId && call.state==="uncertain" && !call.receipt);
	if(phase==="changed supporting input"){
		assert.ok(saved.nodes.one.supporting?.includes("units/next/fixture"),"test requires an outside-squad supporting file in the original writer brief");
		assert.equal(git(f.root,"show",`${saved.join?.commit}:units/next/fixture`),"incompatible");
	}
	await assert.rejects(f.owner.operation("repairBaseline",selection,"owner"),/settled, current unmet goal/);
	assert.deepEqual(read().nodes.one,saved.nodes.one);sibling.close();f.owner.close();
	const events=new EventEmitter(),ready=once(events,"ready"),release=once(events,"release"),inspect=scriptedInspections(f.root);
	let intercepted=false;
	const settler=f.runtime(f.root,{...inspect,permissionBlocker:async()=>{
		if(phase==="unissued goal in form" && !intercepted && read().effects.some(e=>e.kind==="goal" && e.id!==saved.goal?.check && e.state==="ready")){
			intercepted=true;events.emit("ready");await release;
		}return null;
	}},createRuntime);
	let forms=0;
	const owner=f.runtime(f.root,{...inspect,autoConfirm:async()=>true,confirm:async msg=>{
		forms++;for(const id of stopped)for(const v of [writer(id).id,"units/"+id,f.tip])assert.ok(msg.includes(v));
		if(phase==="checkpoint advances in form" || phase==="unissued goal in form"){
			assert.ok(finish);await finish();finish=undefined;settler.turn("owner");
			if(phase==="unissued goal in form")await Promise.race([ready,settler.flush().then(()=>assert.fail("New goal was never held at its unissued reservation"))]);
			else await settler.flush();
		}
		return phase!=="decline";
	}},createRuntime);
	if(phase==="unissued group member"){
		await assert.rejects(owner.operation("repairBaseline",{run,grains:["one","next"]},"owner"),/original bound missing-input/);
		assert.equal(forms,0);assert.deepEqual(read().nodes.one,saved.nodes.one);return;
	}
	if(phase==="capacity" || phase==="changed supporting input"){
		if(phase==="capacity")await owner.operation("configure",{run,revision:1,workers:1},"owner");
		const prior=read();await assert.rejects(owner.operation("repairBaseline",selection,"owner"),phase==="capacity"?{code:"limit"}:/supporting file/);
		assert.deepEqual(read(),prior);assert.equal(forms,0);return;
	}
	if(phase==="decline"){
		await assert.rejects(owner.operation("repairBaseline",selection,"owner"),{code:"approval_declined"});
		assert.equal(forms,1);assert.deepEqual(read(),saved);return;
	}
	try{await owner.operation("repairBaseline",selection,"owner");}finally{events.emit("release");}
	assert.equal(forms,1);await settler.flush();
	const granted=read();assert.equal(granted.effects.filter(e=>e.kind==="repair" && e.baseline && e.state==="done").length,2);
	for(const id of stopped){
		const repair=granted.effects.find(e=>e.kind==="repair" && e.grain===id);assert.ok(repair?.kind==="repair");
		assert.deepEqual(repair.baselineStop,saved.nodes[id]);
	}
	assert.equal(granted.effects.filter(e=>e.kind==="writer").length,4);
	if(phase==="checkpoint advances in form" || phase==="unissued goal in form")assert.notEqual(granted.products.at(-1)?.check,saved.products.at(-1)?.check);
	else assert.deepEqual(granted.effects.find(e=>e.id===call.id),call);
	if(finish){await finish();settler.turn("owner");await settler.flush();}
	for(const id of stopped){
		const node=read().nodes[id],w=writer(id),r=settleSubmitted(f.runtime(w.cwd,inspect,createRuntime));
		assert.equal(node.worker,saved.nodes[id].worker);assert.equal(node.generation,saved.nodes[id].generation);assert.equal(node.state,"writing");assert.notEqual(node.token,w.token);
		const approved=r.inspect({run},w.id).nodes.find(n=>n.grain===id)?.baseline;
		assert.ok(approved && !Array.isArray(approved));assert.deepEqual(approved,saved.nodes[id].priorSource);
		put(w.cwd,approved.directory+"/index",git(w.cwd,"show",`${approved.revision}:${approved.directory}/index`)+" verified");
		await r.operation("submit",{run,token:node.token},w.id);
	}
	owner.turn("owner");await owner.flush();const end=read(),qualified=owner.inspect({run},"owner").qualified;assert.ok(qualified);
	assert.ok(end.effects.find(e=>e.id===call.id)?.receipt);assert.equal(end.effects.filter(e=>e.kind===call.kind && e.commit===call.commit).length,1);
	for(const id of stopped)assert.equal(git(f.root,"show",`${qualified}:units/${id}/index`),id+" verified");
	assert.equal(git(f.root,"show",`${qualified}:units/next/value`),"next");
});

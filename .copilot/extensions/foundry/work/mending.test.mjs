import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRuntime } from "./runtime.mjs";
import { openDatabase } from "./database.mjs";
import { factory, git, put, recoveryClock } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { observed, recipient } from "../test/portable.mjs";
import { replacementBlob } from "./inputs.mjs";
import { resumeMechanic, settleMechanic } from "./mechanic.mjs";
import { git as gitBytes, stageTest } from "./product.mjs";

const id="catalog",source=".foundry/catalog.json",goal=".foundry/goal.mjs",product=".foundry/product.mjs";
const probe=goal+".control",spec="requirements.md",invariant="report-count";
const script=(/** @type {string} */ result)=>`import {readFileSync} from "node:fs";const row=JSON.parse(readFileSync("lib/report.json"));process.exit(${result}?0:1);`;
const old=script("row.previous===3"),fixed=script("row.count===3");
const plan={version:2,id,target:"refs/heads/main",direction:"Report the measured count.",productCheck:product,goalCheck:goal,
	squads:[{id:"reports",charter:spec,areas:["lib"],checks:["check.mjs"]}]};
const standin=`#!/usr/bin/env node
const fs=require("node:fs"),cp=require("node:child_process"),subject=process.argv[3],file=require("node:path").join(subject,"lib/report.json");
if(subject===process.cwd())throw Error("Control inputs must come from a separate activation export");
const original=fs.readFileSync(file);
try {fs.writeFileSync(file,JSON.stringify({count:process.argv[2]==="good"?3:4}));
const r=cp.spawnSync(process.execPath,[".foundry/goal.mjs"],{cwd:subject});if(![0,1].includes(r.status))process.exitCode=2;
else {console.log(JSON.stringify({assertion:"report-count",matched:r.status===0}));process.exitCode=r.status;}}
finally{fs.writeFileSync(file,original);}`;

for(const scenario of ["recover","saved run","saved unobserved","external unavailable","unavailable observation and control","outside .foundry","bad test change","wrong assertion","review rejects","product failure","unavailable control","permission revoked","owner paused","owner reviewed supersession"])test(`automatic test repair / ${scenario}`,async t=>{
	const archive=process.env.FOUNDRY_MENDING_FIXTURE;
	const missing=["saved unobserved","external unavailable","unavailable observation and control"].includes(scenario);
	/** @type {typeof factory} */ const build=archive?(await import(join(archive,"test/fixture.mjs"))).factory:missing?await historicalFactory(t,90):scenario==="saved run"?await historicalFactory(t,89):factory;
	const host=async(/** @type {import("./mending.mjs").Phase} */ phase,/** @type {import("./mending.mjs").Packet} */ packet)=>{
		calls.push(phase);assert.ok(packet.message.includes(invariant) && packet.message.includes("row.previous"));
		if(phase==="author"){
			assert.ok(!packet.message.includes("spawnSync"),"do not show the author the holdout");
			return {id:"author-fixture",subject:packet.subject,change:scenario==="bad test change"?"process.exit(0);\n":fixed+"\n",reason:"Read the measured field."};
		}
		assert.ok(packet.message.includes("row.count") && packet.message.includes("newBad"));
		return {id:"duck-fixture",subject:packet.subject,approved:!["review rejects","owner reviewed supersession"].includes(scenario),reason:"Read the unchanged count requirement and the negative control."};
	};
	const calls=/** @type {string[]} */ ([]);
	const check=scenario==="outside .foundry"?"quality/observe.mjs":goal,driver=check+".control";
	const f=build(t,id,source,{[source]:JSON.stringify({...plan,goalCheck:check}),[spec]:"A valid report measures three entries.","check.mjs":"",
		".foundry/catalog/journey.md":"Measure the real count, not the fixture's previous field.",
		[driver]:["unavailable control","unavailable observation and control"].includes(scenario)?"#!/bin/sh\nexit 2\n":scenario==="wrong assertion"?standin.replace(`assertion:"report-count"`,`assertion:process.argv[2]==="bad"?"other":"report-count"`):standin.replace(goal,check),
		[product]:"",[check]:(missing?(scenario==="saved unobserved"?old.replace("process.exit(","if(row.live && row.previous===undefined)process.exit(2);process.exit("):
			fixed.replace("process.exit(","if(row.live)process.exit(2);process.exit(")):scenario==="product failure"?fixed:old)+"\n",
		"lib/report.json":JSON.stringify({count:scenario==="product failure"?4:3,...(missing && {live:true})})});
	chmodSync(join(f.root,driver),0o755);git(f.root,"commit","-qam","Freeze project-owned independent controls");
	const target=git(f.root,"rev-parse","HEAD");
	// The old owner really ran the failing check. No new plan, pin, artifact or manual diagnosis is supplied on attachment.
	const clock=recoveryClock();let oldProductWrites=0,permitted=true;
	/** @type {ReturnType<typeof createRuntime>} */ const owner=f.runtime(f.root,{watchRecovery:clock.watch,confirm:async()=>scenario==="owner reviewed supersession" || assert.fail("no per-repair approval or repin"),
		permissionBlocker:async()=>permitted?null:{scope:"session",message:"Permission revoked"},
		repairAgent:async(phase,p,ticket)=>{
			const w=phase==="author"?"author-fixture":"duck-fixture";
			assert.deepEqual(await owner.mechanicPacket(ticket,"owner",w),p);
			await assert.rejects(owner.mechanicPacket(ticket,"owner","duplicate"),{code:"wrong_workflow"});
				if(scenario==="permission revoked" && phase==="review")permitted=false;
				if(scenario==="owner paused" && phase==="author")await owner.operation("pause",{run:id},"owner");
			return host(phase,p);
			},repairState:async(w,ticket)=>({id:w,subject:ticket.subject,...(ticket.phase==="author"?{change:fixed}:{approved:true}),reason:"Original bound answer."}),
			execute:(tool,args,key)=>{if(tool==="create_session")oldProductWrites++;return f.execute(tool,args,key);}
	},createRuntime);
	const historical=archive || missing || scenario==="saved run";
	await f.start(historical?f.owner:owner);
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(id)??assert.fail();
	const original=read().effects.find(c=>c.kind==="goal");assert.ok(original?.kind==="goal" && original.receipt?.exit===(missing?2:1));const stop=original.id;db.verifySigned(id,original);
	if(historical)assert.ok(!read().testRepairs);f.owner.close();
	owner.sessionStart("owner",f.root);owner.turn("owner");await owner.flush();await clock.pulse(owner,3);
	const end=read(),job=end.testRepairs?.find(r=>r.stop===stop);
	assert.ok(job,"the original signed failure must reach test diagnosis on a normal owner wake");
	assert.deepEqual(end.effects.find(c=>c.id===stop),original);assert.equal(git(f.root,"rev-parse","HEAD"),target);
	assert.equal(readFileSync(join(f.root,"lib/report.json"),"utf8"),JSON.stringify({count:scenario==="product failure"?4:3,...(missing && {live:true})}));
	assert.equal(oldProductWrites,0);
	if(["recover","saved run","saved unobserved","outside .foundry"].includes(scenario)){
		assert.deepEqual(calls,["author","review"],job.reason??job.state);assert.equal(job.state,"applied",job.reason??"expected adoption");
		assert.equal(owner.inspect({run:id},"owner").qualified,target);
		assert.notEqual(end.goal?.check,stop);assert.equal(end.repins?.length,1);
		assert.equal(git(f.root,"show",`${end.repins?.at(-1)?.revision}:${check}`),fixed);
		for(const c of end.effects)if(c.tool==="bash")db.verifySigned(id,c);
	}else{
		assert.equal(job.state,scenario==="product failure"?"product":missing?"unobserved":scenario==="permission revoked"?"reviewing":scenario==="owner paused"?"authoring":"held");
		assert.deepEqual(calls,["review rejects","permission revoked","owner reviewed supersession"].includes(scenario)?["author","review"]:["bad test change","wrong assertion","owner paused"].includes(scenario)?["author"]:[]);
		assert.equal(end.repins?.length??0,0);assert.equal(owner.inspect({run:id},"owner").qualified,null);
	}
	const checkpoints=end.effects.map(c=>c.id);owner.turn("owner");await owner.flush();assert.deepEqual(read().effects.map(c=>c.id),checkpoints);
	if(scenario==="permission revoked"){
		permitted=true;owner.turn("owner");await owner.flush();assert.equal(owner.inspect({run:id},"owner").qualified,target);
		assert.deepEqual(calls,["author","review"],"restored permission observes the original result without another review");
	}
	if(scenario==="owner paused"){
		assert.equal(end.active,false);await owner.operation("resume",{run:id,source},"owner");await owner.flush();
		assert.equal(owner.inspect({run:id},"owner").qualified,target);assert.deepEqual(calls,["author","review"]);
	}
	if(scenario==="owner reviewed supersession"){
		const blob=gitBytes(f.root,["hash-object","-w","--stdin"],fixed+"\n").toString().trim(),revision=stageTest(f.root,target,check,blob);
		await owner.operation("repin",{run:id,from:target,revision,files:[check]},"owner");owner.turn("owner");await owner.flush();
		assert.equal(owner.inspect({run:id},"owner").qualified,target,"a legitimate new evaluator must supersede the held old goal");
		assert.deepEqual(read().effects.find(e=>e.id===stop),original);
	}
});

test("an unissued writer repair after exit 2 uses independent test controls before touching its product",async t=>{
	const build=await historicalFactory(t,90),unit="checks/report.mjs",file="lib/item/value.json";
	const oldTest=`import {readFileSync as read} from "node:fs";const row=JSON.parse(read("${file}"));if(row.live && row.previous===undefined)process.exit(2);process.exit(row.previous===3?0:1);`;
	const repaired=oldTest.replaceAll("row.previous","row.count");
	const f=build(t,id,source,{[source]:JSON.stringify({...plan,squads:[{id:"reports",charter:spec,areas:["lib"],checks:["base.mjs",unit]}]}),
		".foundry/catalog/journey.md":"Produce both measured values.",[spec]:"Report a count of three.","base.mjs":"",[product]:"",
		[goal]:`import {existsSync as has} from "node:fs";process.exit(has("${file}")?0:has("lib/base/value")?2:1);`,[unit]:oldTest,
		[unit+".control"]:standin.replaceAll("lib/report.json",file).replaceAll(goal,unit)});
	chmodSync(join(f.root,unit+".control"),0o755);git(f.root,"commit","-qam","Freeze the project cases");await f.start();
	await f.scouts[0].report({outcome:"regenerate",reason:"Two independent outputs are missing.",evidence:[spec],grains:["base","item"].map(g=>({id:g,directory:"lib/"+g,task:"Measure "+g,needs:[],check:g==="base"?"base.mjs":unit}))});
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(id)??assert.fail();
	for(const g of ["base","item"]){const w=f.workers.get(read().nodes[g].worker??"");assert.ok(w);put(w.cwd,g==="base"?"lib/base/value":file,g==="base"?"base":'{"count":3,"live":true}');
		await f.runtime(w.cwd).operation("submit",{run:id,token:w.token},w.id);}
	const before=read(),old=before.effects.find(e=>e.id===before.nodes.item.check);assert.ok(old?.receipt?.exit===2 && before.nodes.item.state==="waiting");
	f.owner.close();
	/** @type {ReturnType<typeof createRuntime>} */ const owner=f.runtime(f.root,{repairAgent:async(phase,packet,ticket)=>{
		await owner.mechanicPacket(ticket,"owner",phase);return {id:phase,subject:packet.subject,reason:"Read the measured field.",...(phase==="author"?{change:repaired}:{approved:true})};
	}},createRuntime);
	owner.sessionStart("owner",f.root);owner.turn("owner");await owner.flush();const after=read(),job=after.testRepairs?.find(j=>j.stop===old.id);
	assert.equal(job?.state,"applied");assert.equal(after.nodes.item.candidate,before.nodes.item.candidate);assert.equal(after.nodes.item.repairs,0);
	assert.deepEqual(after.effects.find(e=>e.id===old.id),old);assert.ok(after.effects.find(e=>e.id===job.recheck)?.receipt?.exit===0);
});

for(const status of ["completed","halted","paused","unconfirmed","capacity","resume capacity","second halt","invalid attempt"])test(`reattach to an interrupted ${status} test author without duplicating an admitted call`,{timeout:30000},async t=>{
	const bound=status!=="unconfirmed" && status!=="capacity";
	const build=await historicalFactory(t,89);
	const f=build(t,id,source,{[source]:JSON.stringify(plan),[spec]:"The measured count is three.","check.mjs":"",
		".foundry/catalog/journey.md":"Observe count.",[product]:"",[goal]:old,[probe]:standin,"lib/report.json":'{"count":3}'});
	chmodSync(join(f.root,probe),0o755);git(f.root,"commit","-qam","Freeze independent cases");await f.start();f.owner.close();
	let entered=()=>{},finish=()=>{};const start=new Promise(resolve=>{entered=()=>resolve(undefined);}),release=new Promise(resolve=>{finish=()=>resolve(undefined);});
	/** @type {ReturnType<typeof createRuntime>} */ const first=f.runtime(f.root,{repairAgent:async(phase,p,ticket)=>{
		assert.equal(phase,"author");
		if(status==="paused"){
			await first.operation("pause",{run:id},"owner");await assert.rejects(first.mechanicPacket(ticket,"owner","original-author"),{code:"repair_wait"});
		}else if(bound)await first.mechanicPacket(ticket,"owner","original-author");
		if(status==="second halt")await first.mechanicPacket(ticket,"owner","original-author","halt",1);
		if(status==="capacity"){entered();throw Error("This session already has 2 active workflow runs, which is the concurrent limit.");}
		entered();await release;return {id:"original-author",subject:p.subject,change:fixed,reason:"Use count."};
	}},createRuntime);
	first.turn("owner");await start;if(status==="capacity")await first.flush();first.close();finish();await first.flush();
	if(status==="resume capacity"){
		/** @type {ReturnType<typeof createRuntime>} */ const crowded=f.runtime(f.root,{repairState:async(w,ticket)=>{
			await crowded.mechanicPacket(ticket,"owner",w,"halt",1);
			return settleMechanic({runId:w,status:"halted",attempt:1},ticket,w,id=>resumeMechanic(id,async()=>{
				throw Error("This session already has 2 active workflow runs, which is the concurrent limit.");
			},async()=>assert.fail("a rejected continuation was not active")));
		}},createRuntime);
		crowded.turn("owner");await crowded.flush();
		const waiting=crowded.inspect({run:id},"owner").testRepairs?.[0];assert.equal(waiting?.state,"authoring","a rejected resume must not lose the original author");
		assert.match(waiting.reason??"",/capacity/);crowded.close();
	}
	let starts=0,reads=0,resumes=0;
	/** @type {ReturnType<typeof createRuntime>} */ const next=f.runtime(f.root,{repairState:async(w,ticket)=>{
		assert.equal(w,"original-author");assert.equal(ticket.phase,"author");reads++;
		const result={id:w,subject:ticket.subject,change:fixed,reason:"Use count."};
		return settleMechanic({runId:w,status:["second halt","resume capacity","invalid attempt"].includes(status)?"halted":status,attempt:status==="second halt"?2:status==="invalid attempt"?0:1,result},ticket,w,async(workflow,paused,attempt)=>{
			assert.equal(workflow,w);const why=paused?"permission":"halt";await next.mechanicPacket(ticket,"owner",w,why,attempt);resumes++;
			await assert.rejects(next.mechanicPacket(ticket,"owner",w,why,attempt),/no second resume/i);await next.mechanicPacket(ticket,"owner",w);
			return {runId:w,status:"completed",result};
		});
	},repairAgent:async(phase,p,ticket)=>{
		starts++;if(status==="capacity" && phase==="author"){
			await next.mechanicPacket(ticket,"owner","admitted");return {id:"admitted",subject:p.subject,change:fixed,reason:"Use count."};
		}
		assert.equal(phase,"review","never restart an admitted or uncertain author");
		await next.mechanicPacket(ticket,"owner","original-review");return {id:"original-review",subject:p.subject,approved:true,reason:"Both controls preserve count."};
	}},createRuntime);
	if(status==="paused")await next.operation("resume",{run:id,source},"owner");
	next.turn("owner");await next.flush();next.turn("owner");await next.flush();
	const s=next.inspect({run:id,detail:"proof"},"owner");
	if(status==="second halt"){
		assert.equal(s.testRepairs?.[0].state,"held");assert.match(s.testRepairs[0].reason??"",/interrupted again/);assert.equal(reads,1);assert.equal(starts+resumes,0);return;
	}
	assert.equal(reads,bound?1:0);assert.equal(starts,bound?1:status==="capacity"?2:0);assert.equal(resumes,["halted","paused","resume capacity","invalid attempt"].includes(status)?1:0);
	if(bound || status==="capacity")assert.equal(s.qualified,git(f.root,"rev-parse","HEAD"));
	else {assert.equal(s.qualified,null);assert.match(s.testRepairs?.[0].reason??"",/unconfirmed call cannot be replayed/);}
});

for(const kind of ["component","product","component after target moved","component while authoring","component before dispatch","component after dispatch","component before stricter adoption","component with a changed contract"])test(`repair a ${kind} test without regenerating its submitted implementation`,async t=>{
	const unit="checks/unit.mjs",evaluator=kind==="product"?product:unit,driver=evaluator+".control",file="lib/entry/value.json",adopting=kind.endsWith("adoption");
	const body=(/** @type {string} */ field)=>`import {readFileSync} from "node:fs";const row=JSON.parse(readFileSync("${file}"));process.exit(row.${field}===3?0:1);`;
	const seeded=!["component","product","component before stricter adoption"].includes(kind);
	const policy=seeded?{version:1,id,target:plan.target,direction:plan.direction,productCheck:product,seed:["item"],
		grains:[{id:"item",directory:"lib/entry",specification:spec,boundary:["api"],check:unit,needs:[]}]}:{...plan,squads:[{id:"reports",charter:spec,areas:["lib"],checks:[unit]}]};
	const previous=(kind==="component" || kind==="product") && process.env.FOUNDRY_VERIFICATION_BEFORE;
	/** @type {typeof factory} */ const build=previous?(await import(join(previous,"test/fixture.mjs"))).factory:factory;
	const f=build(t,id,source,{[source]:JSON.stringify(policy),api:"Count is a number.",
		[spec]:"Produce one record with a count of three.",".foundry/catalog/journey.md":"Measure three.",[product]:"",[unit]:"",
		[goal]:`import {existsSync} from "node:fs";process.exit(existsSync("${file}")?${adopting?2:0}:1);`,[evaluator]:body("previous"),
		[driver]:standin.replaceAll("lib/report.json",file).replaceAll(goal,evaluator)});
	chmodSync(join(f.root,driver),0o755);if(kind==="component")chmodSync(join(f.root,evaluator),0o755);
	git(f.root,"commit","-qam","Freeze the independent check");
	let moved=false,watch=false;
	function move(){if(!moved){const p=kind.endsWith("changed contract")?spec:"operator";put(f.root,p,p===spec?"Require a new unit.":"Unrelated target edit.");git(f.root,"add",p);git(f.root,"commit","-qm","Independent target work");moved=true;}}
	function recheckReady(/** @type {string} */ state){if(!watch || moved)return false;const db=openDatabase(f.root);
		try{return db.read(id)?.effects.some(e=>e.tool==="bash" && !!e.testPin && e.state===state);}finally{db.close();}}
	const agent=async(/** @type {import("./mending.mjs").Phase} */ phase,/** @type {import("./mending.mjs").Packet} */ p)=>
		phase==="author"?{id:"author",subject:p.subject,reason:"Read count.",change:body("count")}:{id:"reviewer",subject:p.subject,approved:true,reason:"Independent count controls matched."};
	/** @type {ReturnType<typeof createRuntime>} */ const owner=f.runtime(f.root,{confirm:async()=>true,repairAgent:async(phase,p,ticket)=>{
		const w=phase==="author"?"author":"reviewer";await owner.mechanicPacket(ticket,"owner",w);
		if(kind.endsWith("while authoring") && phase==="author")move();
		if(p.message.includes("Use the new required field."))return {id:w,subject:p.subject,reason:"The good example no longer establishes the adopted requirement."};
		return agent(phase,p);
	},permissionBlocker:async()=>{if((kind.endsWith("before dispatch") || kind.endsWith("changed contract")) && recheckReady("ready"))move();return null;},
	execute:(tool,args,key)=>{if(kind.endsWith("after dispatch") && tool==="bash" && recheckReady("issued"))move();return f.execute(tool,args,key);}
	});const s=await f.start(owner);assert.ok(!s.qualified);watch=true;
	if(!seeded)await f.scouts[0].report({outcome:"regenerate",reason:"Missing report.",evidence:[spec],grains:[{id:"item",directory:"lib/entry",task:"Provide the count.",needs:[],check:unit}]});
	const w=[...f.workers.values()][0];assert.ok(w);put(w.cwd,file,'{"count":3}');
	if(kind.endsWith("target moved"))move();
	await f.runtime(w.cwd).operation("submit",{run:id,token:w.token},w.id);await f.settle();
	owner.turn("owner");await owner.flush();
	const db=openDatabase(f.root);t.after(()=>db.close());const r=db.read(id)??assert.fail();
	const j=r.testRepairs?.find(j=>j.rule.check===evaluator);assert.ok(j,r.blocker??JSON.stringify(r.effects.map(e=>[e.kind,e.receipt?.exit])));
	assert.equal(j.state,"applied",j.reason??j.state);const old=r.effects.find(e=>e.id===j.stop),fresh=r.effects.find(e=>e.id===j.recheck);
	if(kind.endsWith("changed contract")){
		owner.turn("owner");await owner.flush();const s=owner.inspect({run:id},"owner");
		assert.equal(moved,true);assert.equal(fresh?.callId,undefined);assert.equal(s.qualified,null);assert.match(s.blocker??"",/contract changed|contract or adopted target changed/i);return;
	}
	assert.ok(old?.tool==="bash" && fresh?.tool==="bash" && old.receipt?.exit===1 && fresh.receipt?.exit===0 && old.commit===fresh.commit);
	db.verifySigned(id,old);db.verifySigned(id,fresh);
	assert.equal(replacementBlob(fresh.receipt),j.blob);assert.equal(git(f.root,"show",`${fresh.commit}:${evaluator}`),body("previous"));
	assert.equal(r.nodes.item.repairs,0);assert.equal(f.workers.size,1);
	if(kind==="component" || kind==="product"){
		const old=owner.inspect({run:id,detail:"proof"},"owner").qualification;assert.ok(old);
		const calls=f.checks.slice(),effects=structuredClone(r.effects);
		if(previous){
			assert.notEqual(old.format,"foundry-qualification/v5");owner.close();
			const dest=recipient(f.root,old,"old-object-transfer");
			await assert.rejects(observed(dest,kind==="component"?"component:item":"product"),/Historical object transfer only/);
		}
		const current=previous?f.runtime(f.root,{execute:async()=>assert.fail("Reading original proof must never dispatch")},createRuntime):owner;
		const {qualification:proof,qualificationUnavailable}=current.inspect({run:id,detail:"proof"},"owner");assert.ok(proof,qualificationUnavailable??"Missing portable proof");
		const observation=kind==="component"?proof.outputs[0].receipt:proof.receipts.product;
		assert.equal(observation.inputEvidence,previous?"reconstructed":"signed");
		assert.equal(observation.inputs.checker.mode,kind==="component"?"100755":"100644");
		const dest=recipient(f.root,proof,"recipient",kind==="component"?"component:item":"product");assert.equal(git(dest,"cat-file","blob",observation.inputs.checker.blob),body("count"));
		const result=await observed(dest,kind==="component"?"component:item":"product");
		assert.equal(result.status,fresh.receipt.exit,`The imported ${kind} must run the exact repaired evaluator`);
		assert.deepEqual(db.read(id)?.effects,effects);assert.deepEqual(f.checks,calls);
	}
	if(adopting){
		const checkpoint=r.products.at(-1),prior=r.goal;assert.ok(checkpoint && prior);
		const stricter=body("newContract");put(f.root,unit,stricter);git(f.root,"commit","-qam","Require the new field");
		const target=git(f.root,"rev-parse","HEAD");
		await owner.operation("repin",{run:id,kind:"target",from:checkpoint.target,revision:target,checkpoint:checkpoint.check,goal:prior.check,files:[unit],acceptance:"Use the new required field."},"owner");await owner.flush();
		const after=db.read(id)??assert.fail(),joined=after.effects.find(e=>e.kind==="product" && e.evaluatorRevision===target);
		assert.equal(joined?.receipt?.components?.item.exit,1,"the newly adopted assertion must run, not the older passing repair");
		assert.equal(replacementBlob(joined?.receipt?.components?.item),undefined);
		assert.equal(owner.inspect({run:id},"owner").qualified,null);
	}else if(!previous)assert.ok(owner.inspect({run:id},"owner").qualified);
	assert.equal(moved,seeded);
});

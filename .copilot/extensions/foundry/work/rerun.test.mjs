import assert from "node:assert/strict";
import test from "node:test";
import { git, put } from "../test/fixture.mjs";
import { pairedWork } from "../test/install.mjs";
import { directory,historicalFactory } from "../test/legacy-readers.mjs";
import { cpSync,existsSync,writeFileSync } from "node:fs";
import { execFile,spawnSync } from "node:child_process";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { createRuntime } from "./runtime.mjs";
import { openDatabase } from "./database.mjs";
import { boardFacts } from "./visibility.mjs";
import {buildTools} from "./tools.mjs";

const run="sample", source=".foundry/sample.json";
test("a stopped component can be observed on its frozen checkpoint after a mixed target merge",async t=>{
	const factory=await historicalFactory(t,61);
	const f=factory(t,run,source,{
		[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Check the accepted row.",limits:{repairs:0},goalCheck:"goal.mjs",productCheck:"product.mjs",
			squads:[{id:"team",charter:"spec",grains:["probe","input"]}],grains:["probe","input"].map(id=>({id,directory:id,specification:"spec",boundary:["api"],check:`${id}.mjs`}))}),
		spec:"Check the row.",api:"row", "goal.mjs":"process.exit(1)", "product.mjs":"", "input.mjs":"",
		"probe.mjs":`await import("./probe/observe.mjs");`
	});
	await f.start(); await f.scouts[0].report({outcome:"regenerate",reason:"Need both outputs.",evidence:["spec"],grains:["probe","input"]});
	const nodes=(await f.status()).nodes, writer=(/** @type {string} */ id)=>f.workers.get(nodes.find(n=>n.grain===id)?.worker ?? "");
	const w=writer("probe"), i=writer("input"); assert.ok(w && i);
	put(w.cwd,"probe/observe.mjs",`import {readFileSync,existsSync} from "node:fs"; process.exit(existsSync("input/row") && readFileSync("spec","utf8")==="Check the row."?0:7)`);
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	put(i.cwd,"input/row","row"); await f.runtime(i.cwd).operation("submit",{run,token:i.token},i.id);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run), p=original?.products.at(-1), n=original?.nodes.probe; assert.ok(p && n?.check);
	put(f.root,"spec","New charter");git(f.root,"commit","-qam","Change the target contract"); const tip=git(f.root,"rev-parse","HEAD");
	const owner=f.runtime(f.root,{confirm:async()=>true},createRuntime);
	const tool=buildTools(owner,()=>"owner",assert.fail).find(t=>t.name==="foundry_check");assert.ok(tool?.handler);
	const args={run,observe:{check:n.check,product:p.commit,harness:["probe/observe.mjs"],current:["input"]}};
	const writerRuntime=f.runtime(w.cwd,{},createRuntime);
	const suggestion={run,token:w.token,check:n.check,observe:{harness:["probe/observe.mjs"],current:["input"]}};
	await assert.rejects(f.runtime(i.cwd,{},createRuntime).operation("propose",suggestion,i.id),{code:"stale_assignment"});
	const count=f.checks.length;await writerRuntime.operation("propose",suggestion,w.id);await writerRuntime.operation("propose",suggestion,w.id);
	assert.equal(f.checks.length,count,"reporting diagnostic evidence is not authorization for a check");
	const next=owner.inspect({run},"owner").recovery.find(a=>a.kind==="proposal");
	assert.ok(next?.disposition==="decision");assert.equal(next.tool,"foundry_check");assert.deepEqual(next.arguments,args);
	assert.ok(!JSON.stringify(next).includes(w.token));
	const result=await tool.handler(next.arguments,{sessionId:"owner",toolName:tool.name,toolCallId:"observe",arguments:next.arguments});
	assert.equal(typeof result,"string",JSON.stringify(result));
	const after=db.read(run), e=after?.effects.at(-1); assert.ok(e?.kind==="rerun");db.verifySigned(run,e);
	assert.equal(e.receipt?.exit,0);assert.equal(e.commit,p.commit);assert.deepEqual(after?.nodes.probe,n);
	assert.deepEqual(after?.goal,original?.goal);assert.deepEqual(after?.products,original?.products);assert.equal(git(f.root,"rev-parse","HEAD"),tip);
});
for (const [reader,exit] of [[61,0],[61,1],[61,2],[22,2],[95,0]]) test(reader===95?"a loaded reader-95 historical observer signs its own interruption on a same-path cutover":reader===22
	? "pre-journal exit 1 followed by missingInput has no signing key even with a signed current product"
	: `recheck the original stopped assignment on the checked product: exit ${exit}`,async t=>{
	const factory=await historicalFactory(t,reader);
	const missingInput=exit===2 ? "The next occurrence is absent from the checked calendar." : undefined;
	const originalExit=missingInput ? 1 : 7;
	const f=factory(t,run,source,{
		[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Deliver the current data.",limits:{repairs:missingInput ? 1 : 0},
			goalCheck:"goal.mjs",productCheck:"product.mjs",squads:[{id:"team",charter:"spec",grains:["probe","input"]}],
			grains:["probe","input"].map(id=>({id,directory:id,specification:"spec",boundary:["api"],check:id==="probe"?"component.mjs":"input.mjs"}))}),
		spec:"Check both rows.",api:"Data format.", "goal.mjs":"process.exit(1)", "product.mjs":"", "input.mjs":"",
		"component.mjs":`${reader===95?'if(process.env.LAUNCH_LOG)(await import("node:fs")).appendFileSync(process.env.LAUNCH_LOG,"launched\\n");':""}
			if(process.env.FOUNDRY_GRAIN!=="probe" || process.env.FOUNDRY_DIRECTORY!=="probe" ||
			process.env.FOUNDRY_DIRECTORIES!==${reader===22 ? 'undefined' : `'["probe"]'`}) throw Error("wrong binding");
			await import("./"+process.env.FOUNDRY_DIRECTORY+"/main.mjs");`,
	});
	await f.start();
	await f.scouts[0].report({outcome:"regenerate",reason:"Publish data and check it.",evidence:["spec"],grains:["probe","input"]});
	const state=await f.status();
	const worker=(/** @type {string} */ id)=>{const w=f.workers.get(state.nodes.find(n=>n.grain===id)?.worker ?? "");assert.ok(w);return w;};
	const probe=worker("probe"), input=worker("input");
	put(probe.cwd,"probe/main.mjs",`import {readFileSync,existsSync} from "node:fs"; import {row} from "./second.mjs";
		console.log("both rows",row); process.exit(existsSync("input/value")?Number(readFileSync("input/value","utf8")):${originalExit});`);
	put(probe.cwd,"probe/second.mjs",'export const row="original second assertion";');
	await f.runtime(probe.cwd).operation("submit",{run,token:probe.token},probe.id);
	if (missingInput) {
		const repair=(await f.status(probe.id)).nodes.find(n=>n.grain==="probe"); assert.ok(repair?.state==="writing" && repair.token);
		await f.runtime(probe.cwd).operation("submit",{run,token:repair.token,missingInput},probe.id);
	}
	put(input.cwd,"input/value",String(exit));
	const inputRuntime=reader===22 ? f.runtime(input.cwd,{},createRuntime) : f.runtime(input.cwd);
	await inputRuntime.operation("submit",{run,token:input.token},input.id);
	const db=openDatabase(f.root); t.after(()=>db.close());
	const before=db.read(run), p=before?.products.at(-1), n=before?.nodes.probe;
	assert.ok(before && p && n?.check && n.state==="blocked");
	const original=before.effects.find(e=>e.id===n.check); assert.ok(original?.kind==="component" && original.receipt?.exit===originalExit);
	assert.match(original.receipt.output,/both rows original second assertion/);
	if (missingInput) { assert.ok(n.reason?.includes(missingInput)); assert.equal(n.candidate,undefined); }
	const args={run,check:n.check,product:p.commit,harness:["probe/main.mjs","probe/second.mjs"],current:["input"]};
	if (reader!==22) await assert.rejects(f.owner.operation("recheck",{run,check:n.check},"owner"),{code:"not_recoverable"});
	f.owner.close();
	if(reader===95){
		const install=directory(t,95),gate=join(dirname(f.root),"claimed"),log=gate+".evaluator";
		/** @type {Promise<unknown>|undefined} */ let child;
		const owner=f.runtime(f.root,{confirm:async()=>true,execute:async(tool,args,callId)=>{
			assert.equal(tool,"bash");await owner.pre(tool,args,"owner",callId);
			child=promisify(execFile)("/bin/sh",["-c",String(args.command)],{cwd:f.root,timeout:60_000,env:{...process.env,
				FOUNDRY_TEST_CLAIM_GATE:gate,FOUNDRY_TEST_AFTER_CLAIM:"1",LAUNCH_LOG:log,NODE_OPTIONS:`--import=${new URL("../test/runner-claim-gate.mjs",import.meta.url).href}`}});
			const end=Date.now()+20_000;
			while(!existsSync(gate+".loaded")){assert.ok(Date.now()<end,"old runner did not claim");await sleep(10);}
			return {resultType:"unconfirmed"};
		}});
		try{
			await owner.operation("recheck",args,"owner");owner.close();
			const pending=db.read(run)?.effects.at(-1);assert.ok(pending?.kind==="rerun" && pending.runnerClaim && !pending.receipt);
			cpSync(new URL("./",import.meta.url),pairedWork(join(install,"../..")),{recursive:true});
			const now=spawnSync(process.execPath,[fileURLToPath(new URL("../test/installed-reader.mjs",import.meta.url)),install,f.root],
				{encoding:"utf8",input:JSON.stringify({action:"configure",params:{run,revision:0,checkpointReviews:false}})});
			assert.equal(now.status,0,now.stderr);assert.equal(JSON.parse(now.stdout).ok,true,now.stdout);
			writeFileSync(gate+".continue","");assert.ok(child);await child;
			const after=db.read(run),result=after?.effects.find(e=>e.id===pending.id);
			assert.ok(result?.kind==="rerun" && result.receipt);assert.equal(result.runnerClaim,pending.runnerClaim);db.verifySigned(run,result);
			assert.equal(result.receipt.exit,null);assert.match(result.receipt.output,/Invalid Foundry execution snapshot/);
			assert.equal(existsSync(log),false);assert.deepEqual(after?.goal,before.goal);assert.deepEqual(after?.products,before.products);
		}finally{writeFileSync(gate+".continue","");await child;}
		return;
	}
	if (reader===22) {
		assert.equal(original.runnerStarted,true); assert.equal(original.runnerClaim,undefined);
		const product=before.effects.find(e=>e.id===p.check); assert.ok(product?.kind==="product"); db.verifySigned(run,product);
		const owner=f.runtime(f.root,{confirm:async()=>assert.fail("unsigned original must not prompt"),execute:async()=>assert.fail("must not launch")},createRuntime);
		await assert.rejects(owner.operation("recheck",args,"owner"),
			{code:"missing_receipt",message:new RegExp(`${args.check}.*exit 1.*${original.commit}.*no runner signing key`)});
		assert.deepEqual(db.read(run),before);
		return;
	}
	db.verifySigned(run,original);
	put(probe.cwd,"probe/second.mjs",'throw Error("unsubmitted working tree edit")');
	const owner=f.runtime(f.root,{confirm:async()=>true},createRuntime);
	if (exit===0) {
		await assert.rejects(owner.operation("recheck",args,probe.id),{code:"foreign_run"});
		await assert.rejects(owner.operation("recheck",{...args,product:original.commit},"owner"),{code:"stale_assignment"});
		await assert.rejects(owner.operation("recheck",{...args,harness:["probe/main.mjs"]},"owner"),/classify changed inputs.*probe\/second\.mjs/);
		await assert.rejects(owner.operation("recheck",{...args,harness:[],current:["input","probe"]},"owner"),/directory probe is absent/);
		await assert.rejects(owner.operation("recheck",{...args,harness:["probe/main.mjs"],current:["input","probe/second.mjs"]},"owner"),/directory probe is absent.*probe\/second\.mjs/);
		const declined=f.runtime(f.root,{confirm:async()=>false},createRuntime);
		await assert.rejects(declined.operation("recheck",args,"owner"),{code:"approval_declined"});
		assert.deepEqual(db.read(run),before);
	}
	await owner.operation("recheck",args,"owner");
	await owner.operation("recheck",args,"owner");
	const after=db.read(run); assert.ok(after);
	assert.deepEqual(after.effects.find(e=>e.id===n.check),original);
	assert.deepEqual(after.nodes,before.nodes); assert.deepEqual(after.products,before.products); assert.deepEqual(after.goal,before.goal);
	const added=after.effects.slice(before.effects.length); assert.equal(added.length,1);
	const [fresh]=added; assert.ok(fresh.tool==="bash" && fresh.kind==="rerun");
	assert.equal(fresh.rerun?.of,n.check); assert.equal(fresh.commit,p.commit);
	db.verifySigned(run,fresh);
	const pin=fresh.rerun; assert.ok(pin);
	assert.throws(()=>db.verifySigned(run,{...fresh,rerun:{...pin,harness:[]}}),{code:"wrong_outcome"});
	assert.equal(fresh.receipt?.exit,exit); assert.match(fresh.receipt.output,/both rows original second assertion/);
	const displayed=owner.readBoard(run,"owner").nodes.find(n=>n.id==="probe");
	const latest=displayed?.attempts?.at(-1);
	assert.equal(latest?.status,["passed","failed","unavailable"][exit]);
	assert.equal(latest?.check,fresh.id); assert.equal(latest?.commit,p.commit);
	assert.equal(displayed?.passedOnBuild,exit===0 ? fresh.id : undefined);
	assert.equal(displayed?.state,"blocked"); assert.equal(displayed.checked,null);
	assert.equal(displayed?.result?.exit,originalExit); assert.equal(owner.inspect({run},"owner").qualified,null);
	if (exit===0) {
		const label=(/** @type {import("./model.js").Run} */ r)=>boardFacts(r,"owner").nodes.find(n=>n.id==="probe")?.passedOnBuild;
		const otherProduct=structuredClone(after);otherProduct.products[otherProduct.products.length-1].commit=original.receipt.commit;
		assert.equal(label(otherProduct),undefined,"a pass on another build is history only");
		const otherOriginal=structuredClone(after);otherOriginal.nodes.probe.check=original.id+"-other";
		assert.equal(label(otherOriginal),undefined,"the rerun must belong to this stopped attempt");
		const superseded=structuredClone(after);
		superseded.effects.push({...fresh,id:fresh.id+"-later",state:"issued",runnerStarted:undefined,runnerClaim:undefined,receipt:undefined,
			rerun:{...pin,after:fresh.id}});
		assert.equal(label(superseded),undefined,"a still-pending newer observation is not a current pass");
		assert.equal(boardFacts(after,probe.id).nodes[0].passedOnBuild,undefined);
		const moved=f.runtime(f.root,{permissionBlocker:async()=>{
			git(f.root,"commit","--allow-empty","-qm","Target moves during preflight"); return null;
		}},createRuntime);
		await assert.rejects(moved.operation("recheck",{run,check:n.check,product:p.commit,after:fresh.id},"owner"),{code:"stale_assignment"});
		assert.deepEqual(db.read(run),after);
	}
	if (exit===1) {
		const moved=f.runtime(f.root,{confirm:async()=>true,execute:async(tool,args,id)=>{
			git(f.root,"commit","--allow-empty","-qm","Target moves before the runner claims");
			return f.execute(tool,args,id);
		}},createRuntime);
		await moved.operation("recheck",{run,check:n.check,product:p.commit,after:fresh.id},"owner");
		const last=db.read(run)?.effects.at(-1); assert.ok(last?.kind==="rerun");
		db.verifySigned(run,last);
		assert.equal(last.receipt?.exit,null); assert.match(last.receipt.output,/no evaluator was run/);
	}
	if (exit===2) {
		const repeat={run,check:n.check,product:p.commit,after:fresh.id};
		const repeatOwner=f.runtime(f.root,{confirm:async()=>assert.fail("the signed harness and product have not changed")},createRuntime);
		await Promise.all([repeatOwner.operation("recheck",repeat,"owner"),repeatOwner.operation("recheck",repeat,"owner")]);
		await assert.rejects(owner.operation("recheck",{...repeat,harness:[]},"owner"),/identical approved check/);
		const reopened=f.runtime(f.root,{},createRuntime);
		const history=reopened.readBoard(run,"owner").nodes.find(n=>n.id==="probe")?.attempts;
		assert.deepEqual(history?.map(a=>[a.exit,a.after]),[[originalExit,undefined],[2,n.check],[2,fresh.id]]);
		const end=db.read(run); assert.ok(end); assert.deepEqual(end.goal,before.goal);
		for (const e of end.effects.filter(e=>e.kind==="rerun")) {assert.ok(e.kind==="rerun");db.verifySigned(run,e);}
	}
	assert.equal(git(f.root,"ls-tree",p.commit,"--","probe"),"","historical tests were not integrated");
});

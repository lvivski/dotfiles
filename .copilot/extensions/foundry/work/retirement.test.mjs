import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { git, loadEntry, put } from "../test/fixture.mjs";
import { directory,historicalFactory } from "../test/legacy-readers.mjs";
import { createRuntime } from "./runtime.mjs";
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { git as bytes, stageTest } from "./product.mjs";

const run = "catalog", source = ".foundry/catalog.json", ids = ["names", "prices", "stock", "labels"];
/** @param {string} type @param {object} data */
const event = (type, data) => ({ id: crypto.randomUUID(), type, data });

test("a superseded claimed goal cannot strand a different reviewed product or borrow its later verdict", {timeout:90000},async t=>{
	const build=await historicalFactory(t,90),goal=".foundry/goal.mjs";
	const body='import {existsSync as has,writeFileSync} from "node:fs";import {setTimeout as sleep} from "node:timers/promises";'+
		'if(process.env.PROBE){writeFileSync(process.env.PROBE+".started","");while(!has(process.env.PROBE+".finish"))await sleep(30);}\nprocess.exit(has("extra/value")?0:1);\n';
	const f=build(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Provide both values.",goalCheck:goal,productCheck:"product.mjs",
		squads:[{id:"items",charter:"spec",grains:["base","extra"]}],grains:["base","extra"].map(id=>({id,directory:id,specification:"spec",boundary:["api"],check:"component.mjs",needs:[]}))}),
		spec:"Provide both values.",api:"Stable interface.","component.mjs":"","product.mjs":"",[goal]:body});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");await f.scouts[0].report({outcome:"regenerate",reason:"Missing values.",evidence:["spec"],grains:["base","extra"]});
	const db=openDatabase(f.root);t.after(()=>db.close());
	const worker=(/** @type {string} */ id)=>f.workers.get(db.read(run)?.nodes[id].worker??"")??assert.fail();
	const w=worker("base"),other=worker("extra"),probe=join(dirname(f.root),"native-probe");
	/** @type {Promise<unknown>|undefined} */ let executing;
	const past=f.runtime(w.cwd,{execute:async(tool,a,id)=>{
		if(tool!=="bash" || !String(a.description).startsWith("Check final goal"))return f.execute(tool,a,id);
		executing=promisify(execFile)("/bin/sh",["-c",String(a.command)],{cwd:f.root,env:{...process.env,PROBE:probe},timeout:65000});
		for(let i=0;i<300 && !existsSync(probe+".started");i++)await sleep(25);
		assert.ok(existsSync(probe+".started"));return {resultType:"unconfirmed"};
	}});
	let oldId="";
	try{
		put(w.cwd,"base/value","base");await past.operation("submit",{run,token:w.token},w.id);await past.flush();
		const r=db.read(run)??assert.fail(),old=r.effects.find(c=>c.id===r.goal?.check);
		assert.ok(old?.kind==="goal" && old.state==="uncertain" && old.runnerClaim && !old.receipt);oldId=old.id;
		put(other.cwd,"extra/value","extra");await f.runtime(other.cwd).operation("submit",{run,token:other.token},other.id);
		const blob=bytes(f.root,["hash-object","-w","--stdin"],'import {existsSync} from "node:fs";process.exit(existsSync("base/value") && existsSync("extra/value")?0:1);').toString().trim();
		const first=stageTest(f.root,f.tip,goal,bytes(f.root,["hash-object","-w","--stdin"],"process.exit(2);").toString().trim());
		const pin=stageTest(f.root,first,goal,blob),oldOwner=f.runtime(f.root,{confirm:async()=>true});
		await oldOwner.operation("repin",{run,from:f.tip,revision:first,files:[goal]},"owner");
		await oldOwner.operation("repin",{run,from:first,revision:pin,files:[goal]},"owner");await oldOwner.flush();oldOwner.close();past.close();f.owner.close();
		const stopped=db.read(run)??assert.fail();assert.equal(stopped.goal?.check,oldId);assert.equal(stopped.nodes.extra.state,"published");
		const now=f.runtime(f.root,{confirm:async()=>assert.fail("the new evaluator is already approved")},createRuntime);
		now.sessionStart("owner",f.root);now.turn("owner");await now.flush();
		const end=db.read(run)??assert.fail(),p=end.products.at(-1),g=end.effects.find(c=>c.id===end.goal?.check);
		assert.ok(p && p.commit!==old.commit && p.outputs.extra===stopped.nodes.extra.candidate,"normal wake must integrate the genuinely changed published output");
		assert.ok(g?.kind==="goal" && g.commit===p.commit && g.evaluatorRevision===pin && g.receipt?.exit===0);db.verifySigned(run,g);
		assert.equal(now.inspect({run},"owner").qualified,p.commit);assert.deepEqual(end.effects.find(c=>c.id===oldId),old);
		const calls=end.effects.length;writeFileSync(probe+".finish","");await executing;
		now.turn("owner");await now.flush();const late=db.read(run)??assert.fail();
		const original=late.effects.find(c=>c.id===oldId);assert.ok(original?.kind==="goal" && original.receipt?.exit===1);db.verifySigned(run,original);
		assert.equal(late.effects.length,calls);assert.equal(now.inspect({run},"owner").qualified,p.commit);
	}finally{writeFileSync(probe+".finish","");await executing;}
});

for (const race of ["none", "receipt", "target"]) test(`owner retirement preserves four published outputs without replay; approval race: ${race}`, async t => {
	const factory=await historicalFactory(t,95),past=directory(t,95);
	/** @type {{issue:typeof import("./native.mjs").issue,reserveCheck:(r:import("./model.js").Run,issuer:string,cwd:string,commit:string,check:string)=>string}} */
	const {issue,reserveCheck}=await import(join(past,"work/native.mjs"));
	/** @type {typeof import("./database.mjs")} */ const previous=await import(join(past,"work/database.mjs"));
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main", direction: "Publish a complete catalog.",
		productCheck: "product.mjs", goalCheck: "goal.mjs", grains: ["base", ...ids].map(id => ({ id, directory:id, specification:"spec", boundary:["api"], check:"unit.mjs" })),
		squads:[{id:"catalog", charter:"spec", grains:["base", ...ids]}] }), spec:"Build the catalog.", api:"Contract.", "unit.mjs":"", "product.mjs":"",
		"goal.mjs":`import {existsSync} from "node:fs"; process.exit(${JSON.stringify(ids)}.every(id=>existsSync(id+"/value")) ? 0 : 1);` });
	const store = openDatabase(f.root, undefined, true); t.after(() => store.close());
	await f.start();
	/** @param {string[]} grains */
	const propose = async grains => { const job = f.scouts.at(-1); assert.ok(job); await job.report({outcome:"regenerate",reason:"Produce the catalog.",evidence:["spec"],grains}); };
	/** @param {string} id */
	async function publish(id) {
		const n = (await f.status()).nodes.find(n => n.grain === id), w = f.workers.get(n?.worker ?? ""); assert.ok(w);
		put(w.cwd, `${id}/value`, id); await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	await propose(["base"]); await publish("base"); await propose(ids);
	// Historical checkpoint: the exclusive pre-journal runner claimed this attempt but never wrote a result.
	const callId = crypto.randomUUID();
	const originalStore=previous.openDatabase(f.root);t.after(()=>originalStore.close());
	const old = originalStore.mutateLocked(run, r => {
		const at = r.goal; assert.ok(at && r.products.at(-1)?.commit === at.commit);
		at.check = reserveCheck(r,"owner",f.root,at.commit,"goal.mjs");
		const e = r.effects.at(-1); assert.ok(e && issue(r,e,callId)); e.runnerStarted = true; e.state = "uncertain";
		return e;
	});
	for (const id of ids) await publish(id);
	const before = await f.status(); assert.deepEqual(before.nodes.filter(n => n.state === "published").map(n => n.grain),ids);
	const shellId = old.args.shellId, description = old.args.description, readId = crypto.randomUUID();
	const notification = event("system.notification", {kind:{ type:"shell_completed",shellId,description,exitCode:1 }});
	const read = event("tool.execution_start", {toolName:"read_bash",toolCallId:readId,arguments:{shellId,delay:0}});
	const terminal = event("tool.execution_complete", {toolCallId:readId,success:true,
		result:{content:`FoundryError: Invalid Foundry dispatch\n    at fail (file:///fixture/values.mjs:8:45)\n    at decode (file:///fixture/snapshot.mjs:214:3)\n    at snapshot (file:///fixture/database.mjs:83:18)\n<shellId: ${shellId} completed with exit code 1>`},
		toolTelemetry:{properties:{shell_error_category:"command_nonzero_exit"},metrics:{exit_code:1}}});
	const history = [notification,read,terminal];
	let consent = true, prompts = 0;
	const conf = await loadEntry({sessionId:"owner",on(){},ui:{elicitation:async() => {
		prompts++;
		if (consent && race === "receipt") originalStore.mutateLocked(run, r => {
			const pending = r.effects.find(e => e.id === old.id); assert.ok(pending && pending.kind === "goal" && pending.commit && pending.check);
			pending.receipt = {commit:pending.commit,check:pending.check,exit:1,output:"Late real runner result"}; pending.state = "done";
		});
		if (consent && race === "target") { put(f.root,"other","moved");git(f.root,"add","other");git(f.root,"commit","-qm","move target"); }
		return {action:consent?"accept":"cancel"};}},rpc:{
		mode:{get:async()=>"interactive"}, managedSettings:{get:async()=>({failClosed:false})},permissions:{getMode:async()=>({mode:"assisted"})},
		eventLog:{read:async(/** @type {{cursor?:string,types:string[]}} */ page)=>{const rows=history.filter(e=>page.types.includes(e.type)),at=Number(page.cursor??0);
			return {cursorStatus:"ok",cursor:String(at+1),events:rows.slice(at,at+1),hasMore:at+1<rows.length};}},
		tools:{execute:(/** @type {{name:string,arguments:typeof old.args,toolCallId:string}} */ a)=>f.execute(a.name,a.arguments,a.toolCallId)}
	},send:async()=>"notice"});
	const ctx = {sessionId:"owner"}, hook = {...ctx, timestamp:new Date(), workingDirectory:f.root};
	await conf.hooks?.onSessionStart?.({...hook,source:"resume"},ctx);
	t.after(()=>conf.hooks?.onSessionEnd?.({...hook,reason:"complete"},ctx));
	const tool = conf.tools?.find(t=>t.name==="foundry_retire"); assert.ok(tool?.handler,"missing foundry_retire");
	const args = {run,check:old.id}, invoke = () => tool.handler?.(args,{...ctx,arguments:args,toolName:tool.name,toolCallId:"retire"});
	const beforeChecks = f.checks.length;
	history.shift(); assert.match(JSON.stringify(await invoke()),/terminal|notification/i); history.unshift(notification);
	history.push(event("system.notification",{kind:{type:"shell_completed",shellId,description,exitCode:0}}));
	assert.match(JSON.stringify(await invoke()), /conflicting terminal/i); history.pop();
	assert.match(JSON.stringify(await tool.handler(args,{...ctx,agentId:"helper",arguments:args,toolName:tool.name,toolCallId:"helper"})),/not its subagents/);
	await assert.rejects(f.owner.operation("retire",args,"stranger"), /owner/i);
	consent=false; assert.match(JSON.stringify(await invoke()),/not approved/i);
	assert.equal(store.read(run)?.goal?.check,old.id); assert.equal(f.checks.length,beforeChecks);
	consent=true;
	const result = await invoke();
	if (race === "target") {
		assert.match(JSON.stringify(result),/original checked product|changed during approval/);
		assert.equal(f.checks.length,beforeChecks); assert.equal(store.read(run)?.effects.find(e=>e.id===old.id)?.state,"uncertain");
		return;
	}
	assert.equal(typeof result,"string");
	const done = f.runtime(f.root,{},createRuntime).inspect({run,detail:"proof"},"owner"), former=done.goalChecks?.find(e=>e.id===old.id);
	if (race === "receipt") { assert.equal(former?.state,"done"); assert.equal(former?.receipt?.output,"Late real runner result"); }
	else {
		assert.equal(former?.state,"retired"); assert.equal(former?.receipt,undefined);
		assert.equal(former.infrastructureFailure?.notification,notification.id); assert.equal(former.infrastructureFailure?.completion,terminal.id);
	}
	assert.ok(done.qualified && done.qualified !== old.commit); assert.equal(done.goal?.receipt?.commit,done.qualified);
	assert.equal(done.products?.at(-1)?.receipt?.commit,done.qualified);
	for(const id of ids) assert.equal(git(f.root,"show",`${done.qualified}:${id}/value`),id);
	assert.deepEqual(f.checks.slice(beforeChecks),[`Check joined product at ${done.qualified.slice(0,12)}`,`Check final goal at ${done.qualified.slice(0,12)}`]);
	assert.notEqual(done.goalChecks?.at(-1)?.id,old.id); assert.equal(f.workers.size,5);
	assert.equal(typeof await invoke(),"string"); assert.equal(prompts,2); assert.equal(f.checks.length,beforeChecks+2);
});

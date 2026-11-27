import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { factory } from "../test/fixture.mjs";
import { directory } from "../test/legacy-readers.mjs";
import { installTools } from "../test/install.mjs";
import { ledgerPath,openDatabase } from "./database.mjs";

const run="cutover",source=".foundry/cutover.json",here=fileURLToPath(new URL("./",import.meta.url));
/** @typedef {import("./model.js").NativeCall} Check */
/** @param {Check["args"]} args @param {string} root @param {NodeJS.ProcessEnv} [env] */
const shell=(args,root,env={})=>spawnSync("/bin/sh",["-c",String(args.command)],{cwd:root,env:{...process.env,...env},encoding:"utf8"});
/** @param {Check["args"]} args @param {string} root @param {NodeJS.ProcessEnv} env */
const running=(args,root,env)=>promisify(execFile)("/bin/sh",["-c",String(args.command)],{cwd:root,env:{...process.env,...env},timeout:40_000})
	.then(value=>({status:0,...value}),error=>({status:error.code,stderr:String(error.stderr)}));
/** @param {string} file */
async function reached(file){const end=Date.now()+15_000;while(!existsSync(file)){assert.ok(Date.now()<end,`never reached ${file}`);await sleep(10);}}
const settled={resultType:"success",toolTelemetry:{properties:{executionMode:"sync",shell_error_category:"command_nonzero_exit"},metrics:{exit_code:78}}};
/** @param {import("node:test").TestContext} t @param {boolean} [ready] @param {string} [deadline] */
async function setup(t,ready=false,deadline){
	const f=factory(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Measure the output.",
		productCheck:"product.mjs",goalCheck:"goal.mjs",...(deadline&&{limits:{deadline}}),squads:[{id:"counts",areas:["entries"],charter:"spec",boundary:["api"],checks:["product.mjs"]}]}),
		"spec":"Count entries.","api":"Stable.","product.mjs":"",
		"goal.mjs":`import {appendFileSync,existsSync} from "node:fs";import {setTimeout as sleep} from "node:timers/promises";
			appendFileSync(process.env.LAUNCH_LOG,"goal\\n");if(process.env.WAIT_FOR)while(!existsSync(process.env.WAIT_FOR))await sleep(10);`});
	const base=path.dirname(f.root),p=path.join(base,"installation's home",".copilot","extensions","foundry"),log=path.join(base,"invocations");
	const deploy=(/** @type {number|undefined} */ version=undefined)=>{
		mkdirSync(p,{recursive:true});rmSync(path.join(p,"work"),{recursive:true,force:true});
		if(!version)installTools(path.join(p,"../../skills/foundry/scripts"));
		cpSync(version?path.join(directory(t,version),"work"):here,path.join(p,"work"),{recursive:true});
	};
	deploy(95);
	const module=(/** @type {string} */ name)=>import(pathToFileURL(path.join(p,`work/${name}.mjs`)).href);
	const old=(await module("runtime")).createRuntime;
	if(ready){
		const root=(await module("product")).rootAt(f.root); // The original runtime reserves from its canonical Git root.
		const policy=(await module("contract")).readPolicy(root,source),r=(await module("graph")).newRun(root,policy.policy,"owner",policy.grains);
		const db=(await module("database")).openDatabase(f.root,ledgerPath(f.root),true);try{db.insert(r);}finally{db.close();}
	}else{
		let admitted=false;
		const issuer=f.runtime(f.root,{execute:async(tool,args,callId)=>{
			assert.equal(tool,"bash");
			/** @type {ReturnType<typeof openDatabase>} */ const db=(await module("database")).openDatabase(f.root);
			try{const e=db.read(run)?.effects.find(e=>e.args.shellId===args.shellId);assert.ok(e?.callId);assert.equal(e.callId,callId);
				await issuer.pre(tool,args,e.issuer,callId);admitted=true;}
			finally{db.close();}
			return {resultType:"unconfirmed"};
		}},old);
		await f.start(issuer);assert.equal(admitted,true,"original edition must actually admit the original command before cutover");issuer.close();
	}
	const raw=new DatabaseSync(ledgerPath(f.root)),db=openDatabase(f.root);t.after(()=>{db.close();raw.close();});
	const document=()=>JSON.parse(String(raw.prepare("SELECT document FROM runs WHERE id=?").get(run)?.document));
	const read=()=>db.read(run)??assert.fail("missing run");
	const checks=()=>read().effects.filter(/** @returns {e is Check} */ e=>e.tool==="bash");
	const e=checks().find(e=>e.kind==="goal")??assert.fail();
	const original=()=>checks().find(x=>x.id===e.id)??assert.fail();
	const linked=()=>checks().filter(x=>x.attempt?.version===2 && x.attempt.previous===e.id);
	const host=(/** @type {string} */ action,props={})=>{
		const proc=spawnSync(process.execPath,[fileURLToPath(new URL("../test/installed-reader.mjs",import.meta.url)),p,f.root],
			{input:JSON.stringify({action,id:e.id,...props}),encoding:"utf8",cwd:f.root,env:{...process.env,LAUNCH_LOG:log}});
		assert.equal(proc.status,0,proc.stderr);return JSON.parse(proc.stdout.trim().split("\n").at(-1)??assert.fail());
	};
	const launches=()=>existsSync(log)?readFileSync(log,"utf8").trim().split("\n").length:0;
	return {f,base,db,raw,e,log,deploy,host,launches,document,read,original,linked,old};
}

test("one loaded 95 runner loses the actual same-path preclaim race; only positive original settlement links one consented check",async t=>{
	const {f,base,db,e,log,deploy,host,launches,document,original,linked,read}=await setup(t),gate=path.join(base,"claim");
	const before=running(e.args,f.root,{LAUNCH_LOG:log,FOUNDRY_TEST_CLAIM_GATE:gate,
		NODE_OPTIONS:`--import=${new URL("../test/runner-claim-gate.mjs",import.meta.url).href}`});
	let old;
	try{
		await reached(gate+".loaded");deploy();
		assert.equal(host("pre",{args:e.args,callId:e.callId}).ok,true);
		for(const props of [{actor:"stranger"},{callId:"wrong"},{args:{...e.args,initial_wait:3}},{args:{...e.args,shellId:"not-foundry"}}])
			assert.equal(host("pre",{args:e.args,callId:e.callId,...props}).ok,false,"recognizable unmatched calls are denied");
		const closed=shell(e.args,f.root,{LAUNCH_LOG:log});
		assert.equal(closed.status,78,closed.stderr);assert.match(closed.stderr,/closed-before-runner-claim/);
	}finally{writeFileSync(gate+".continue","");old=await before;}
	assert.notEqual(old.status,0);assert.match(old.stderr,/Invalid Foundry execution snapshot/);
	const prior=original();assert.ok(prior.attempt?.version===1);
	assert.equal(prior.attempt.closure,"closed-before-runner-claim");assert.equal(prior.runnerClaim,undefined);assert.equal(prior.receipt,undefined);
	assert.equal(launches(),0);assert.equal(document().format,"foundry-run/2");
	for(const v of [95,80]){
		deploy(v);for(const action of ["resume","start","status"]){
			const result=host(action,{params:action==="status"?{run}:{source}});assert.equal(result.ok,false);assert.equal(result.code,"corrupt_run");assert.deepEqual(result.calls,[]);
		}
		assert.notEqual(shell(e.args,f.root,{LAUNCH_LOG:log}).status,0);
		assert.equal(launches(),0);
	}
	deploy();assert.deepEqual(host("turn").calls,[]);
	assert.deepEqual(host("turn",{reply:settled,nativeArgs:{...e.args,initial_wait:3}}).calls,[]);
	assert.equal(original().state,"uncertain");assert.equal(read().effects.length,1);
	const now=host("turn",{reply:settled});assert.equal(now.ok,true,now.message);
	const fresh=linked();
	assert.equal(fresh.length,1);assert.notEqual(fresh[0].callId,e.callId);assert.equal(fresh[0].issuer,e.issuer);
	assert.equal(fresh[0].attempt?.version,2);assert.equal(fresh[0].receipt?.exit,0);db.verifySigned(run,fresh[0]);
	assert.ok(now.permissions.some((/** @type {{id:string}} */ p)=>p.id===fresh[0].args.shellId));assert.equal(host("status",{params:{run}}).value.qualified,f.tip);
	assert.deepEqual(host("turn",{reply:settled}).calls,[]);assert.equal(launches(),1);
});

test("a pre-cutover exclusive signer finishes its actual goal through conversion and downgrade; no surrogate gets its key",async t=>{
	const {f,base,db,e,log,deploy,host,launches,original:readOriginal}=await setup(t),finish=path.join(base,"finish");
	const runner=running(e.args,f.root,{LAUNCH_LOG:log,WAIT_FOR:finish});
	let original;
	try{
		await reached(log);original=readOriginal();
		assert.ok(original.runnerClaim);deploy();assert.equal(host("configure",{params:{run,revision:0,checkpointReviews:false}}).ok,true);
		assert.notEqual(shell(e.args,f.root,{LAUNCH_LOG:log}).status,0);deploy(95);
		assert.equal(host("resume",{params:{source}}).code,"corrupt_run");
	}finally{writeFileSync(finish,"");assert.equal((await runner).status,0);}
	deploy();const now=host("turn");assert.equal(now.ok,true,now.message);
	const originalResult=readOriginal();
	assert.equal(originalResult.runnerClaim,original.runnerClaim);db.verifySigned(run,originalResult);
	assert.equal(originalResult.receipt?.exit,0);assert.equal(originalResult.attempt?.version,1);
	assert.equal(host("status",{params:{run}}).value.qualified,f.tip);assert.equal(launches(),1);
});

test("a genuinely unissued legacy reservation closes once and completes the same initial obligation",async t=>{
	const {f,e,deploy,host,launches,original,linked}=await setup(t,true);assert.equal(e.state,"ready");deploy();
	const next=host("turn");assert.equal(next.ok,true,next.message);
	const prior=original(),fresh=linked();assert.ok(prior.attempt?.version===1);
	assert.equal(prior.attempt.closure,"never-issued",JSON.stringify(next));assert.equal(prior.callId,undefined);assert.equal(prior.runnerClaim,undefined);
	assert.equal(fresh.length,1);assert.equal(fresh[0].receipt?.exit,0);assert.equal(launches(),1);
	assert.equal(host("status",{params:{run}}).value.qualified,f.tip);
});

test("closure is not transferable native permission; declining the fresh linked call does not run the evaluator",async t=>{
	const {f,e,deploy,host,linked,launches}=await setup(t);deploy();assert.equal(shell(e.args,f.root).status,78);
	const delivered=host("turn",{reply:settled,denyFresh:true});assert.equal(delivered.ok,true,delivered.message);
	const [fresh]=linked();assert.ok(fresh?.callId && fresh.callId!==e.callId);
	assert.equal(fresh.state,"refused");assert.equal(fresh.runnerClaim,undefined);assert.equal(fresh.receipt,undefined);
	assert.deepEqual(host("turn",{reply:settled}).calls,[]);assert.equal(launches(),0);
});

test("an actual old local permission hold stays attached until that issuer can authorize a fresh native call",async t=>{
	const {f,old,deploy,host,original,linked,launches}=await setup(t,true);
	const past=f.runtime(f.root,{permissionBlocker:async()=>({scope:"session",message:"Waiting for issuer"}),execute:async()=>assert.fail("held")},old);
	past.turn("owner");await past.flush();past.close();assert.ok(original().permissionHold);deploy();
	assert.deepEqual(host("turn",{blocked:true}).calls,[]);assert.equal(linked().length,0);assert.equal(launches(),0);
	const released=host("turn");assert.equal(released.ok,true,released.message);
	assert.equal(linked()[0]?.receipt?.exit,0,JSON.stringify(released));assert.equal(launches(),1);
});

for(const reason of ["unknown","declined","expired","paused"])test(`the original ${reason} call cannot authorize a fresh attempt`,async t=>{
	const deadline=new Date(Date.now()+3_600_000).toISOString();
	const {f,e,deploy,host,original,linked,launches}=await setup(t,false,deadline);deploy();
	if(reason==="unknown"){
		// A terminal-looking reply without a runner closure is not proof.
		assert.deepEqual(host("turn",{reply:settled}).calls,[]);
		assert.equal(original().state,"uncertain");
	}else{
		if(reason==="paused")assert.equal(host("pause",{params:{run}}).ok,true);
		assert.equal(shell(e.args,f.root).status,78);
		const result=host("turn",{reply:reason==="declined"?{resultType:"denied"}:settled,
			...(reason==="expired"&&{now:Date.parse(deadline)+1})});
		assert.equal(result.ok,true,result.message);assert.deepEqual(result.calls,[]);
		if(reason==="declined")assert.equal(original().state,"refused");
	}
	assert.equal(original().runnerClaim,undefined);assert.equal(original().receipt,undefined);
	assert.equal(linked().length,0);assert.equal(launches(),0);
});

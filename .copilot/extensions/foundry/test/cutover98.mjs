import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ledgerPath, openDatabase } from "../work/database.mjs";
import { verifyPreparation } from "../work/outcomes.mjs";
import { digest } from "../work/values.mjs";
import { factory, git, put } from "./fixture.mjs";
import { directory } from "./legacy-readers.mjs";

const current=resolve(import.meta.dirname,"../../.."),commit="49cfe616868c23ee8c35b6bc31ed9162587c814f";
export const run="tally",source=".foundry/tally.json";
/** @typedef {import("node:test").TestContext} Context */
/** @typedef {import("../work/model.js").NativeCall} Check */
/** @typedef {import("../work/model.js").Run} Run */
/** @param {string} name @param {string} log */
const program=(name,log)=>`import {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(log)},${JSON.stringify(name+"\n")});`;

/** Both contenders load from the original absolute path. Neither ledger pathname nor argv changes.
 * @param {Context} t @param {number} [version] */
export function editions(t,version=98){
	const dir=join(tmpdir(),`foundry-98-${randomUUID()}`),home=join(dir,"original issuer's home"),extension=join(home,"extensions/foundry");
	mkdirSync(home,{recursive:true});t.after(()=>rmSync(dir,{recursive:true,force:true}));
	let old=process.env.FOUNDRY_READER98;
	if(!old){
		old=join(dir,"archive/.copilot");mkdirSync(dirname(old),{recursive:true});
		const tar=execFileSync("git",["-C",current,"archive",commit,".copilot/extensions/foundry",".copilot/skills/foundry"],{maxBuffer:16*1024*1024});
		execFileSync("tar",["-xf","-","-C",dirname(old)],{input:tar});
	}
	const replace=(/** @type {string} */ from)=>{
		for(const p of ["extensions/foundry","skills/foundry"]){
			const dest=join(home,p);rmSync(dest,{recursive:true,force:true});mkdirSync(dirname(dest),{recursive:true});
			cpSync(join(from,p),dest,{recursive:true});
		}
	};
	const past=()=>{
		if(version===98)replace(old);
		else{
			mkdirSync(extension,{recursive:true});const work=join(extension,"work");rmSync(work,{recursive:true,force:true});
			cpSync(join(directory(t,version),"work"),work,{recursive:true});
		}
		assert.equal(readFileSync(join(extension,"work/reader.version"),"utf8").trim(),String(version));
	};
	past();return {dir,extension,upgrade:()=>replace(current),past,load:(/** @type {string} */ name)=>import(pathToFileURL(join(extension,`work/${name}.mjs`)).href)};
}
/** @param {string} file */
export const contents=file=>existsSync(file)?readFileSync(file,"utf8"):"";
/** @param {string} file */
export async function reached(file){
	const until=Date.now()+20000;
	while(!existsSync(file)){assert.ok(Date.now()<until,`never reached ${file}`);await sleep(10);}
}
/** @param {Context} t @param {string} root @param {ReturnType<typeof editions>} ed */
export function observations(t,root,ed){
	const raw=new DatabaseSync(ledgerPath(root)),db=openDatabase(root);
	t.after(()=>{db.close();raw.close();});
	const findRow=(/** @type {string} */ id)=>raw.prepare("SELECT id,owner,document,checksum FROM runs WHERE id=?").get(id);
	const row=(id=run)=>{
		const r=findRow(id);assert.ok(r && typeof r.document==="string");return {...r,document:r.document};
	};
	const schema=()=>({protocol:raw.prepare("PRAGMA user_version").get()?.user_version,
		objects:raw.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY name").all()});
	const spool=(/** @type {string} */ id)=>{
		if(!existsSync(db.file+".outcomes"))return;
		const journal=new DatabaseSync(db.file+".outcomes",{readOnly:true});
		try{return journal.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(run,id);}finally{journal.close();}
	};
	const keyLog=join(ed.dir,"keys"),preload=pathToFileURL(join(import.meta.dirname,"key-trace.mjs")).href;
	const env=(/** @type {NodeJS.ProcessEnv} */ more={})=>({...process.env,TMPDIR:ed.dir,NODE_OPTIONS:`--import=${preload}`,...more,FOUNDRY_TEST_KEYS:keyLog});
	const shell=(/** @type {Check} */ e)=>spawnSync("/bin/sh",["-c",String(e.args.command)],{cwd:root,encoding:"utf8",env:env()});
	const racing=(/** @type {Check} */ e,/** @type {NodeJS.ProcessEnv} */ more)=>promisify(execFile)("/bin/sh",["-c",String(e.args.command)],{cwd:root,timeout:45000,env:env({
		...more,NODE_OPTIONS:`--import=${preload} --import=${pathToFileURL(join(import.meta.dirname,"runner-claim-gate.mjs")).href}`})})
		.then(value=>({status:0,...value}),error=>({status:error.code,stderr:String(error.stderr)}));
	const host=(/** @type {string} */ action,props={})=>{
		const p=spawnSync(process.execPath,[join(import.meta.dirname,"installed-reader.mjs"),ed.extension,root],{
			cwd:root,input:JSON.stringify({action,...props}),env:env(),encoding:"utf8"});
		assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout.trim().split("\n").at(-1)??assert.fail());
	};
	return {...ed,db,row,findRow,schema,spool,shell,racing,host,read:()=>db.read(run)??assert.fail(),keys:()=>contents(keyLog).trim().split("\n").filter(Boolean)};
}
/** @param {Check} e @param {number} exit */
export function terminal(e,exit){
	return [{type:"tool.execution_start",id:"start",data:{toolName:"bash",arguments:e.args,toolCallId:e.callId,turnId:"original"}},
		{type:"tool.execution_complete",id:"end",data:{toolCallId:e.callId,turnId:"original",success:true,
			toolTelemetry:{properties:{executionMode:"sync",shell_error_category:"command_nonzero_exit"},metrics:{exit_code:exit}}}}];
}
/** @param {Context} t @param {number} [version] */
export async function goal(t,version=98){
	const ed=editions(t,version),old=(await ed.load("runtime")).createRuntime,log=join(ed.dir,"evaluators");
	const files={[source]:JSON.stringify({version:2,id:run,direction:"Check the count.",target:"refs/heads/main",productCheck:"product.mjs",goalCheck:"goal.mjs",
		squads:[{id:"counts",areas:["entries"],charter:"charter",boundary:["api"],checks:["product.mjs"]}]}),
		charter:"Report a count.",api:"One total.", "product.mjs":program("product",log),"goal.mjs":program("goal",log)};
	const f=factory(t,run,source,files,old),issuer=f.runtime(f.root,{execute:async(tool,args,id)=>{
		assert.equal(tool,"bash");await issuer.pre(tool,args,"owner",id);return {resultType:"unconfirmed"};
	}},old);
	await f.start(issuer);issuer.close();f.owner.close();
	const o=observations(t,f.root,ed),state=o.read(),e=state.effects.find(e=>e.id===state.goal?.check);
	assert.ok(e?.tool==="bash" && e.callId && !e.runnerStarted && !e.receipt && e.attempt?.version===(version===98?2:1));
	return {...o,f,e,log};
}

/** @param {Context} t */
export async function writers(t){
	const ed=editions(t),old=(await ed.load("runtime")).createRuntime,ids=["one","two"];
	const brief={version:1,id:run,direction:"Write two counts.",target:"refs/heads/main",productCheck:"product.mjs",goalCheck:"goal.mjs",
		squads:[{id:"counts",charter:"charter",grains:ids}],grains:ids.map(id=>({id,directory:id,specification:"spec",boundary:["api"],check:"product.mjs",needs:[]}))};
	const f=factory(t,run,source,{[source]:JSON.stringify(brief),charter:"Counts.",spec:"Two counts.",api:"Totals.","product.mjs":"","goal.mjs":"process.exit(1);"},old);
	const issuer=f.runtime(f.root,{execute:async(tool,args,callId)=>{
		if(tool!=="create_session")return f.execute(tool,args,callId);
		return String(args.name).startsWith("one ")?{resultType:"success",structuredContent:{project_session_id:"first-writer"}}:{resultType:"unconfirmed"};
	}},old);
	await f.start(issuer);await f.scouts[0].report({outcome:"regenerate",reason:"Counts missing.",evidence:["charter"],grains:ids});
	issuer.close();f.owner.close();
	const o=observations(t,f.root,ed),e=o.read().effects.find(e=>e.kind==="writer" && e.grain==="two");
	/** @type {ReturnType<typeof openDatabase>} */ const sql=(await ed.load("database")).openDatabase(f.root);
	t.after(()=>sql.close());assert.ok(e?.kind==="writer" && e.callId && !e.nativeId);
	return {...o,f,e,sql,brief};
}

/** Seed captured Git bytes without creating writer worktrees. The original reader owns admission,
 * writer bindings, reservations, execution, signatures, adoption and serial issue. No receipt is seeded.
 * @param {Context} t @param {boolean} [parallelClaims] */
export async function rollout(t,parallelClaims=false){
	const ed=editions(t),{createRuntime:old}=await ed.load("runtime"),{stagePatch,rootAt}=await ed.load("product");
	const {reserveCheck,boundWriter}=await ed.load("native"),{assign}=await ed.load("assignment"),{describeNewChecks}=await ed.load("description");
	const open=(await ed.load("database")).openDatabase,log=join(ed.dir,"evaluators"),stop=join(ed.dir,"hold-middle");
	const ids=["alpha","bravo","charlie"],check=(/** @type {string} */ id)=>`.foundry/${id}.mjs`,file=(/** @type {string} */ id)=>`entries/${id}/n`,rule=".foundry/rule";
	const script=(/** @type {string} */ id)=>`import {readFileSync,appendFileSync,existsSync} from "node:fs";import {setTimeout as wait} from "node:timers/promises";
const n=readFileSync(${JSON.stringify(file(id))},"utf8").trim();if(n==="fixed"){appendFileSync(${JSON.stringify(log)},${JSON.stringify(id+"\n")});
if(${JSON.stringify(id)}==="bravo" && existsSync(${JSON.stringify(stop)}))while(existsSync(${JSON.stringify(stop)}))await wait(10);
if(${JSON.stringify(id)}==="bravo" && existsSync(${JSON.stringify(stop+".nonpassing")}))process.exit(1);}
if(n==="draft")process.exit(${id==="alpha"?1:0});`;
	/** @type {Record<string,string>} */ const files={[source]:JSON.stringify({version:1,id:run,direction:"Publish three counts.",target:"refs/heads/main",
		productCheck:".foundry/product.mjs",goalCheck:".foundry/goal.mjs",limits:{workers:4},
		squads:[{id:"counts",charter:".foundry/charter",grains:ids}],grains:ids.map(id=>({id,directory:`entries/${id}`,
			specification:`.foundry/${id}.md`,boundary:[".foundry/api"],check:check(id),needs:[]}))}),
		".foundry/charter":"Count the three entries.",".foundry/api":"One total per line.",[rule]:"old\n",".foundry/product.mjs":"",
		".foundry/goal.mjs":`import {existsSync,readFileSync} from "node:fs";const f=${JSON.stringify(ids.map(file))};
process.exit(!f.some(n=>existsSync(n))?1:f.every(n=>existsSync(n)&&readFileSync(n,"utf8").trim()==="fixed")?0:2);`};
	for(const id of ids){files[check(id)]="";files[`.foundry/${id}.md`]=`Count ${id}.`;}
	const f=factory(t,run,source,files,old),actors=new Map(),root=rootAt(f.root);
	let mode="baseline";
	/** @type {Check|undefined} */ let issued;
	const r=f.runtime(root,{confirm:async()=>true,confirmProposal:async()=>true,formIdle:async()=>false,execute:async(tool,args,id)=>{
		if(tool==="create_session"){
			assert.ok(args.kickoff && typeof args.kickoff==="object" && "prompt" in args.kickoff);
			const {assignment}=await ed.load("native"),a=assignment(args.kickoff.prompt),worker="writer-"+String(args.name).split(" ")[0];
			actors.set(worker,a.token);return {resultType:"success",structuredContent:{project_session_id:worker}};
		}
		if(tool==="bash" && mode==="parallel"){
			const c=o.read().effects.find(e=>e.args.shellId===args.shellId);
			assert.ok(c?.kind==="component");await r.pre(tool,args,c.issuer,id);return {resultType:"unconfirmed"};
		}
		if(tool==="bash" && mode==="rollout"){
			const c=o.read().effects.find(e=>e.args.shellId===args.shellId);
			assert.ok(c?.tool==="bash");
			if(c.rollout && c.grain==="alpha"){
				await r.pre(tool,args,"owner",id);
				const real=o.shell(c);assert.equal(real.status,0,real.stderr);return {resultType:"success",textResultForLlm:real.stdout};
			}
			if(c.rollout){
				assert.equal(c.grain,"bravo","serial issue must withhold the third original member");
				assert.ok(!issued);issued=c;await r.pre(tool,args,"owner",id);return {resultType:"unconfirmed"};
			}
		}
		return f.execute(tool,args,id);
	}},old);
	await f.start(r);
	const o=observations(t,root,ed);
	await r.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"Three counts are missing.",evidence:[".foundry/charter"],grains:ids});
	assert.equal(actors.size,3);
	/** @type {ReturnType<typeof openDatabase>} */ const db=open(root,ledgerPath(root),false,undefined,describeNewChecks);
	try{
		for(const id of ids){
			const actor="writer-"+id,token=actors.get(actor);
			db.planAndSwap(run,s=>{
				const n=boundWriter(s,actor,token);assert.equal(n.state,"writing");
				const diff=`diff --git a/${file(id)} b/${file(id)}\nnew file mode 100644\n--- /dev/null\n+++ b/${file(id)}\n@@ -0,0 +1 @@\n+draft\n`;
				n.candidate=stagePatch(root,n.generation,n.generation,diff);assign(n,"submit");
				n.check=reserveCheck(s,actor,root,n.candidate,n.grain.check,id);
			});
		}
		if(parallelClaims)mode="parallel";
		for(const actor of actors.keys())r.turn(actor);
		await r.flush();r.turn("owner");await r.flush();
	}finally{db.close();}
	if(parallelClaims){
		const calls=o.read().effects.filter(/** @returns {e is Check} */ e=>e.kind==="component");
		assert.equal(calls.length,3);assert.ok(calls.every(e=>e.callId && !e.runnerStarted && e.state==="uncertain"));
		r.close();f.owner.close();return {...o,f,members:calls};
	}
	const initial=o.read(),checkpoint=initial.products.at(-1);assert.ok(checkpoint && initial.goal);
	assert.ok(checkpoint.commit===initial.goal.commit && !initial.join && !initial.blocker &&
		!initial.effects.some(e=>["issued","uncertain"].includes(e.state)),
		JSON.stringify({join:initial.join,block:initial.blocker,goal:initial.goal,calls:initial.effects.map(e=>[e.kind,e.grain,e.state,e.receipt?.exit])}));
	const owners=Object.fromEntries(ids.map(id=>{
		const n=initial.nodes[id],e=initial.effects.find(e=>e.id===n.check);assert.ok(e?.kind==="component");o.db.verifySigned(run,e);return [id,[n.worker,n.generation,n.token,e.id]];
	}));
	for(const id of ids)put(root,check(id),script(id));
	git(root,"add",".foundry");git(root,"commit","-qm","Check all counts on the adopted target");const target=git(root,"rev-parse","HEAD");
	await r.operation("repin",{run,kind:"target",from:f.tip,revision:target,checkpoint:checkpoint.check,goal:initial.goal.check,
		files:ids.map(check),acceptance:"Observe the three counts together."},"owner");await r.flush();
	const joined=o.read().join;assert.ok(joined);const failed=o.read().effects.find(e=>e.id===joined.check);
	assert.ok(failed?.kind==="product");assert.equal(failed.receipt?.components?.alpha.exit,1);o.db.verifySigned(run,failed);
	const edit=(/** @type {string} */ p,/** @type {string} */ a,/** @type {string} */ b)=>`--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-${a}\n+${b}\n`;
	const buildLog=join(ed.dir,"preparations"),hook=".foundry/prepare-components";
	const build=`diff --git a/${hook} b/${hook}\nnew file mode 100755\n--- /dev/null\n+++ b/${hook}\n@@ -0,0 +1,2 @@\n+#!/usr/bin/env node\n`+
		`+const fs=require("node:fs");fs.appendFileSync(${JSON.stringify(buildLog)},"build\\n");fs.writeFileSync(process.argv[2]+"/proof","prepared");\n`;
	const assembly=stagePatch(root,joined.commit,target,ids.map(id=>edit(file(id),"draft","fixed")).join("")+edit(rule,"old","new")+build);
	put(root,"correction.diff",git(root,"diff","--full-index",joined.commit,assembly)+"\n");
	const offer=await r.operation("publish",{run,file:"correction.diff",to:ids.map(id=>`entries/${id}`)},"owner");
	mode="rollout";await r.operation("rollout",{run,assembly:joined.commit,check:joined.check,blob:offer.artifacts.at(-1)?.blob},"owner");
	await r.flush();r.close();f.owner.close();
	assert.ok(issued);const state=o.read(),batch=state.effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && e.rollout===issued?.rollout);
	assert.deepEqual(batch.map(e=>e.grain),ids);const [prefix,middle,tail]=batch;
	assert.equal(prefix.receipt?.exit,0);o.db.verifySigned(run,prefix);
	assert.deepEqual(o.keys(),[prefix.id]);assert.deepEqual(state.effects.filter(e=>e.tool==="bash" && e.state==="ready").map(e=>e.id),[tail.id]);
	assert.equal(middle.id,issued.id);assert.ok(middle.callId && !middle.runnerStarted && !middle.receipt);
	assert.equal(tail.state,"ready");assert.ok(!tail.callId);assert.equal(contents(log),"alpha\n");
	const inputs=/\(inputs ([0-9a-f]{64})\)/.exec(prefix.receipt?.output??"")?.[1];
	assert.ok(inputs && prefix.runnerClaim && prefix.receipt?.inputs?.prepared);
	const cache=join(ed.dir,"foundry-build-"+digest([prefix.id,inputs])),claim=prefix.runnerClaim,tree=prefix.receipt.inputs.prepared;
	const prefixSeal=()=>{
		const [name]=readdirSync(cache);const [actual,signature]=name.split(".");
		assert.equal(actual,tree);assert.ok(verifyPreparation(claim,inputs,actual,signature));
		return [name,readFileSync(join(cache,name,"proof"),"utf8")];
	};
	assert.equal(contents(buildLog),"build\n");
	return {...o,f,owners,prefix,middle,tail,assembly,log,stop,buildLog,prefixSeal};
}

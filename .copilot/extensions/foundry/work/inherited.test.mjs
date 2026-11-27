import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { factory, git, loadEntry, put, recoveryClock } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { verdicts } from "../test/portable.mjs";

const run="sample", source=".foundry/sample.json", charter=".foundry/charter.md", component=".foundry/component.mjs";
const product=".foundry/product.mjs", goal=".foundry/goal.mjs", old=".foundry/old.txt", next=".foundry/new.txt";
const ids=["first","middle","last"], dirs=["package/inputs","package/other"];
const files=dirs.map(d=>`${d}/caller.mjs`), patch="suggested.diff";
const guide="package/guide.txt", baseGuide="Header\nOriginal rule.\nFooter\n", retainedGuide=baseGuide+"Checkpoint note.\n";
const lines=['import {readFileSync} from "node:fs";',`const input="${old}";`,'if(readFileSync(input,"utf8")!=="entry")process.exit(1);'];
const before=lines.join("\n")+"\n", after=before.replace(old,next);
const diff=(/** @type {string[]} */ paths)=>paths.map(p=>`diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,3 +1,3 @@\n ${lines[0]}\n-${lines[1]}\n+${lines[1].replace(old,next)}\n ${lines[2]}\n`).join("");
/** @param {import("node:test").TestContext} t @param {typeof factory} build @param {number|null} [exit] @param {boolean} [conflict] */
async function setup(t,build,exit=1,conflict=false){
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Produce a complete catalog.",
		productCheck:product,goalCheck:goal,limits:{repairs:1},squads:[{id:"catalog",areas:["package"],charter,checks:[component]}]}),
		".foundry/sample/journey.md":"Read the complete catalog.",[charter]:"Produce the catalog.",[old]:"entry",[guide]:baseGuide,
		[files[0]]:before,[files[1]]:before,[component]:`import {readFileSync,writeFileSync} from "node:fs";import {spawnSync} from "node:child_process";
			const id=process.env.FOUNDRY_GRAIN, dir=process.env.FOUNDRY_DIRECTORY;
			if(readFileSync(dir+"/value","utf8")!==id)process.exit(1);
			const caller=id==="middle"?${JSON.stringify(files[0])}:id==="last"?${JSON.stringify(files[1])}:undefined;
			if(caller && spawnSync(process.execPath,[caller],{stdio:"inherit"}).status!==0){
				${exit===null?'writeFileSync("unexpected","changed export");':""}process.exit(${exit??1});}`,
		[product]:`import {readFileSync} from "node:fs"; for(const [id,dir] of Object.entries(JSON.parse(process.env.FOUNDRY_OUTPUTS)))
			if(readFileSync(dir+"/value","utf8")!==id)process.exit(1);`,
		[goal]:`import {existsSync} from "node:fs"; const ready=${JSON.stringify(ids)}.filter(id=>existsSync("package/"+id+"/value"));
			if(!ready.length)process.exit(1);if(ready.length!==3 || !existsSync("operator"))process.exit(2);`});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const db=openDatabase(f.root);t.after(()=>db.close());
	const read=()=>db.read(run)??assert.fail("missing original run");
	if(conflict){
		await f.scouts[0].report({outcome:"regenerate",reason:"Preserve the guide and callers in the package.",evidence:[charter],
			grains:[{id:"broad",directory:"package",task:"Produce the initial catalog.",check:component,needs:[]}]});
		const w=f.workers.get(read().nodes.broad.worker??"");assert.ok(w);
		put(w.cwd,"package/value","broad");put(w.cwd,guide,retainedGuide);for(const file of files)put(w.cwd,file,before);
		await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);await f.settle();
	}
	const scout=f.scouts.at(-1);assert.ok(scout);
	await scout.report({outcome:"regenerate",reason:"The three catalog entries are missing.",evidence:[charter],
		grains:ids.map(id=>({id,directory:`package/${id}`,task:`Produce ${id}.`,check:component,needs:[]}))});
	for(const id of ids){
		const w=f.workers.get(read().nodes[id].worker??"");assert.ok(w);
		put(w.cwd,`package/${id}/value`,id);await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	const prior=read(), checkpoint=prior.products.at(-1), assessed=prior.goal;assert.ok(checkpoint && assessed);
	assert.deepEqual(checkpoint.outputs,Object.fromEntries(ids.map(id=>[id,prior.nodes[id].candidate])));
	git(f.root,"rm","-q",old);put(f.root,next,"entry");put(f.root,"operator","preserve");
	if(conflict)put(f.root,guide,baseGuide.replace("Original","New"));
	put(f.root,charter,"Maintain the complete catalog with the new input.");
	git(f.root,"add",".");git(f.root,"commit","-qm","Adopt the new input without changing the catalog entries");
	const revision=git(f.root,"rev-parse","HEAD");
	const blob=(/** @type {string} */ commit)=>git(f.root,"rev-parse",`${commit}:${guide}`);
	const resolutions=conflict?[{file:guide,mode:"100644",base:blob(f.tip),checkpoint:blob(checkpoint.commit),target:blob(revision),
		result:execFileSync("git",["-C",f.root,"hash-object","--stdin"],{input:retainedGuide.replace("Original","New"),encoding:"utf8"}).trim()}]:undefined;
	const args={run,kind:"target",from:f.tip,revision,checkpoint:checkpoint.check,goal:assessed.check,
		files:[old,next,charter],acceptance:"Maintain all three catalog entries with the new input.",...(resolutions && {resolutions})};
	const publish=async(/** @type {string} */ bytes,recipient=dirs)=>{
		put(f.root,patch,bytes);await f.owner.operation("publish",{run,file:patch,to:recipient},"owner");
		return read().artifacts?.at(-1)?.blob??assert.fail("missing reference");
	};
	return {...f,db,read,args,prior,revision,publish};
}

const preparationCases={none:null,"failed hook":/compiler unavailable/,"empty output":/no regular files/,
	"invalid artifact":/Linked or special file/,"changed artifact":/does not match the original build/};

test("writer-drafted inherited correction qualifies the unchanged reader-94 ledger",async t=>{
	const f=await setup(t,await historicalFactory(t,94));
	const old=f.runtime(f.root,{confirm:async()=>true});await old.operation("repin",f.args,"owner");await old.flush();
	const stopped=f.read(),j=stopped.join;assert.ok(j);old.close();f.owner.close();let forms=0,authors=0;
	/** @type {ReturnType<typeof createRuntime>} */ const owner=f.runtime(f.root,{formIdle:async()=>true,confirmProposal:async()=>{forms++;return true;},
		draftAgent:async ticket=>{
			authors++;const id="inherited-author",p=await owner.draftPacket(ticket,"owner",id);
			assert.deepEqual(p.files.map(f=>f.file).sort(),files.toSorted());
			assert.equal(p.source.kind,"inherited");assert.equal(p.assembly,j.commit);
			return {runId:id,status:"completed",workflowName:"foundry-draft",result:{subject:ticket.subject,reason:"Keep callers on the new input.",
				edits:p.files.map(f=>({file:f.file,before:f.before,text:after}))}};
		}},process.env.FOUNDRY_DRAFT_RED?undefined:createRuntime);
	await owner.operation("draft",{run,check:j.check,files},"owner");await owner.flush();
	const final=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(final);
	assert.equal(authors,1);assert.equal(forms,2);assert.equal(f.read().artifacts?.length??0,0);
	assert.deepEqual(f.read().nodes,stopped.nodes);assert.deepEqual(f.read().products.at(-1)?.outputs,j.outputs);
	assert.deepEqual(git(f.root,"diff","--name-only",j.commit,final.commit).split("\n").sort(),files.toSorted());
	assert.deepEqual(verdicts(final.receipts.product.components),Object.fromEntries(ids.map(id=>[id,{check:component,exit:0}])));
});

for (const [fault,error] of Object.entries(preparationCases)) test(`prepared components on the exact joined and amended exports / ${fault}`,async t=>{
	const inherited=process.env.FOUNDRY_PREPARED_DIR;
	process.env.FOUNDRY_PREPARED_DIR="inherited-path-must-not-be-used";
	t.after(()=>{if(inherited===undefined)delete process.env.FOUNDRY_PREPARED_DIR;else process.env.FOUNDRY_PREPARED_DIR=inherited;});
	const absent=`if(process.env.FOUNDRY_PREPARED_DIR!==undefined)throw Error("unexpected prepared directory");\n`;
	const previous=!error && process.env.FOUNDRY_VERIFICATION_BEFORE;
	/** @type {typeof factory} */ const build=previous?(await import(path.join(previous,"test/fixture.mjs"))).factory:factory;
	const f=await setup(t,(ctx,id,source,inputs)=>build(ctx,id,source,{...inputs,
		[component]:absent+inputs[component],[product]:absent+inputs[product],[goal]:absent+inputs[goal]}));
	const hook=".foundry/prepare-components", log=path.join(path.dirname(f.root),"observations");
	const trace=`const trace=(...row)=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(row)+"\\n");`;
	put(f.root,hook,`#!/usr/bin/env node
		const fs=require("node:fs"), out=process.argv[2];${trace}
		${absent}
		if(process.argv.length!==3 || !require("node:path").isAbsolute(out) || fs.readdirSync(out).length)throw Error("bad output directory");
		trace("prepare",process.cwd(),out);
		if(${JSON.stringify(fault)}==="failed hook"){console.error("compiler unavailable");process.exit(2);}
		if(${JSON.stringify(fault)}==="empty output")process.exit(0);
		if(${JSON.stringify(fault)}==="invalid artifact"){fs.symlinkSync(process.execPath,out+"/external");process.exit(0);}
		fs.mkdirSync(out+"/app/empty",{recursive:true});
		fs.writeFileSync(out+"/app/binary",fs.readFileSync("${files[0]}"),{mode:0o755});
		fs.writeFileSync(out+"/provenance",fs.readFileSync("package/first/value"));`);
	chmodSync(path.join(f.root,hook),0o755);
	put(f.root,component,`import * as fs from "node:fs";import assert from "node:assert/strict";${trace}
		const {FOUNDRY_PREPARED_DIR:dir,FOUNDRY_GRAIN:id,FOUNDRY_DIRECTORIES:roots}=process.env;
		trace(id,process.cwd(),dir);
		assert.deepEqual(JSON.parse(roots),["package/"+id]);assert.equal(process.env.FOUNDRY_OUTPUTS,undefined);
		assert.equal(fs.readFileSync(dir+"/provenance","utf8"),"first");
		assert.equal(fs.readFileSync(dir+"/app/binary","utf8"),fs.readFileSync("${files[0]}","utf8"));
		assert.ok(fs.statSync(dir+"/app/binary").mode & 0o100);assert.ok(fs.statSync(dir+"/app/empty").isDirectory());
		fs.writeFileSync(dir+"/app/binary","changed private build");
		if(${JSON.stringify(fault)}==="changed artifact" && id==="first"){
			const [,,original]=JSON.parse(fs.readFileSync(${JSON.stringify(log)},"utf8").split("\\n")[0]);
			fs.writeFileSync(original+"/app/binary","corrupted after preparation");
		}
		if(id==="middle" && fs.readFileSync("${files[0]}","utf8")!==${JSON.stringify(after)})process.exit(1);`);
	git(f.root,"add",hook,component);git(f.root,"commit","-qm","Opt adopted components into a prepared build");
	const revision=git(f.root,"rev-parse","HEAD");
	put(f.root,hook,"#!/bin/sh\nexit 91\n");put(f.root,"package/first/value","dirty working copy");
	const owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("repin",{...f.args,revision,files:[...f.args.files,hook,component]},"owner");
	const saved=f.read(), failed=saved.effects.find(e=>e.id===saved.join?.check);
	assert.ok(failed?.receipt && failed.receipt.exit===null);
	if(!error){
		assert.deepEqual(verdicts(failed.receipt.components),{first:{check:component,exit:0},middle:{check:component,exit:1}});
		const blob=await f.publish(diff(files));
		await owner.operation("inherit",{run,check:failed.id,blob},"owner");
		const proof=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);
		assert.deepEqual(verdicts(proof.receipts.product.components),Object.fromEntries(ids.map(id=>[id,{check:component,exit:0}])));
		assert.notEqual(proof.commit,failed.receipt.commit);
		if(previous){
			const end=f.read();owner.close();
			const current=f.runtime(f.root,{execute:async()=>assert.fail("Never replay an old prepared check")},createRuntime);
			const r=current.inspect({run,detail:"proof"},"owner");assert.equal(r.qualified,proof.commit);assert.equal(r.qualification,null);
			assert.match(r.qualificationUnavailable??"",/prepared bytes/);assert.deepEqual(f.read().effects,end.effects);
		}
	}else{
		assert.deepEqual(verdicts(failed.receipt.components),fault==="changed artifact"?{first:{check:component,exit:0},middle:{check:component,exit:null}}:{});
		assert.match(failed.receipt.output,error);
		assert.equal(saved.products.at(-1)?.check,f.args.checkpoint);assert.equal(saved.goal?.check,f.args.goal);
	}
	/** @type {string[][]} */
	const rows=readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line));
	assert.deepEqual(rows.map(([id])=>id),fault==="none"?["prepare","first","middle","prepare",...ids]:fault==="changed artifact"?["prepare","first"]:["prepare"]);
	const paths=rows.flatMap(([,root,artifact])=>[root,artifact]);
	assert.equal(new Set(paths).size,paths.length,"each invocation gets independent directories");
	assert.ok(paths.every(p=>!existsSync(p)),"remove all exports and prepared directories on success or failure");
});

for(const reload of [false,true])test(`an inherited caller correction continues an approved target without readopting it / ${reload?"recorded failure":"fresh failure"}`,async t=>{
	const historical=reload && process.env.FOUNDRY_AMEND_FIXTURE;
	/** @type {typeof factory} */ const build=historical?(await import(historical)).factory:reload?await historicalFactory(t,79):factory;
	const f=await setup(t,build,1,reload), attempts=[...f.checks];
	/** @type {string[]} */ const forms=[];
	/** @type {import("./model.js").Run|undefined} */ let stopped;
	const clock=recoveryClock(), host={watchRecovery:clock.watch,autoConfirm:async()=>true,
		confirm:async(/** @type {string} */ msg)=>{
			if(msg.includes("adopt this release change"))return true;
			stopped=f.read();forms.push(msg);return true;
		}};
	const adopter=f.runtime(f.root,reload?{confirm:async()=>true}:host);
	put(f.root,"private-index","staged");git(f.root,"add","private-index");put(f.root,"private-index","unstaged");
	const index=git(f.root,"write-tree");
	const early=reload?undefined:await f.publish(diff(files));
	await adopter.operation("repin",f.args,"owner");await adopter.flush();
	const saved=stopped??f.read(), joined=saved.join;assert.ok(joined);
	const failed=saved.effects.find(e=>e.id===joined.check);assert.ok(failed?.kind==="product" && failed.receipt && failed.error);
	assert.equal(failed.receipt.exit,null);assert.deepEqual(verdicts(failed.receipt.components),{first:{check:component,exit:0},middle:{check:component,exit:1}});
	assert.equal(saved.goal?.check,f.args.goal);assert.equal(saved.products.at(-1)?.check,f.args.checkpoint);
	const blob=early??await f.publish(diff(files));
	const issuer=reload?f.runtime(f.root,host,createRuntime):adopter;
	if(reload){
		adopter.close();f.owner.close();
		issuer.sessionStart("owner",f.root);await clock.pulse(issuer,4);
	}
	await issuer.flush();
	assert.equal(forms.length,1,"the owner must be shown the exact inherited-byte decision without another command");
	for(const item of [failed.id,joined.commit,f.revision,blob,...files,old,next])assert.ok(forms[0].includes(item),`missing from correction: ${item}`);
	const end=f.read(), final=issuer.inspect({run,detail:"proof"},"owner").qualification;assert.ok(final);
	assert.notEqual(final.commit,joined.commit);
	assert.deepEqual(end.effects.find(e=>e.id===failed.id),failed);
	f.db.verifySigned(run,failed);
	assert.deepEqual(end.products.slice(0,-1),f.prior.products);
	assert.deepEqual(end.products.at(-1)?.outputs,joined.outputs);assert.deepEqual(end.nodes,saved.nodes);
	assert.deepEqual(end.inspections,saved.inspections);
	assert.deepEqual(git(f.root,"diff","--name-only",joined.commit,final.commit).split("\n").sort(),[...files].sort());
	for(const p of files){assert.equal(git(f.root,"show",`${final.commit}:${p}`),after.trim());assert.equal(git(f.root,"show",`main:${p}`),before.trim());}
	assert.equal(git(f.root,"rev-parse","main"),f.revision);
	assert.equal(git(f.root,"show",`${final.commit}:operator`),"preserve");
	assert.equal(git(f.root,"write-tree"),index);assert.equal(git(f.root,"diff","--name-only"),"private-index");
	assert.equal(git(f.root,"ls-tree",final.commit,"private-index"),"");
	assert.equal(end.productRepins?.length,1);assert.equal(end.productRepins[0].recheck,failed.id);
	if(reload){
		assert.ok(failed.receipt.resolutionDigest);
		assert.equal(end.effects.find(e=>e.id===end.products.at(-1)?.check)?.receipt?.resolutionDigest,failed.receipt.resolutionDigest);
		assert.equal(git(f.root,"show",`${final.commit}:${guide}`),retainedGuide.replace("Original","New").trim());
	}
	assert.deepEqual(verdicts(final.receipts.product.components),Object.fromEntries(ids.map(id=>[id,{check:component,exit:0}])));
	assert.equal(final.receipts.goal.commit,final.commit);assert.equal(final.receipts.goal.evaluatorRevision,f.revision);
	assert.deepEqual(f.checks.slice(attempts.length).map(s=>s.split(" at ")[0]),["Check joined product","Check joined product","Check final goal"]);
	const forged=structuredClone(end), bad=forged.effects.find(e=>e.id===failed.id)?.receipt;assert.ok(bad?.components);
	bad.components.middle.exit=2;assert.throws(()=>decode(forged),{code:"corrupt_run"});
	await clock.pulse(issuer,2);assert.equal(forms.length,1);assert.deepEqual(f.read(),end);
});

for(const hold of ["out of grant","protected","unavailable","changed export","declined","moved","permission","paused"])test(`inherited correction never spends an invalid or unconfirmed grant / ${hold}`,async t=>{
	const f=await setup(t,factory,hold==="unavailable"?2:hold==="changed export"?null:1);
	const a=f.runtime(f.root,{confirm:async()=>true});await a.operation("repin",f.args,"owner");a.close();
	const failed=f.read(), count=f.checks.length;
	const paths=hold==="out of grant"?[...files,"package/middle/value"]:hold==="protected"?[...files,charter]:files;
	const bytes=diff(files)+(paths.length>files.length?`diff --git a/${paths[2]} b/${paths[2]}\n--- a/${paths[2]}\n+++ b/${paths[2]}\n@@ -1 +1 @@\n-${hold==="protected"?"Maintain the complete catalog with the new input.":"middle"}\n\\ No newline at end of file\n+different\n`:``);
	await f.publish(bytes,hold==="protected"?[...dirs,"package"]:["package"]);
	let forms=0,permitted=true;
	const owner=f.runtime(f.root,{autoConfirm:async()=>true,permissionBlocker:async()=>permitted?null:{scope:"session",message:"Permissions held"},confirm:async()=>{
		forms++;
		if(hold==="moved"){put(f.root,"later","keep");git(f.root,"add","later");git(f.root,"commit","-qm","Move target during approval");return true;}
		if(hold==="permission"){permitted=false;return true;}
		if(hold==="paused"){await f.owner.operation("pause",{run},"owner");return true;}
		return false;
	}});
	owner.turn("owner");await owner.flush();await tick();owner.turn("owner");await owner.flush();
	assert.equal(forms,["declined","moved","permission","paused"].includes(hold)?1:0);
	assert.deepEqual(f.read().products,failed.products);assert.deepEqual(f.read().join,failed.join);assert.deepEqual(f.checks.length,count);
	assert.deepEqual(f.read().effects,failed.effects);
	if(hold==="changed export" || hold==="unavailable")
		assert.equal(failed.effects.find(e=>e.id===failed.join?.check)?.receipt?.components?.middle.exit,hold==="unavailable"?2:null);
	if(hold==="out of grant" || hold==="protected")assert.match(owner.inspect({run},"owner").blocker??"",/Not an offered, unowned file/);
	if(hold==="declined"){
		owner.close();const reloaded=f.runtime(f.root,{confirm:async()=>{forms++;return true;}});
		reloaded.turn("owner");await reloaded.flush();assert.equal(forms,1);
		assert.ok(failed.join);
		const status=await reloaded.operation("inherit",{run,check:failed.join.check,blob:f.read().artifacts?.at(-1)?.blob},"owner");
		assert.ok(status.qualified);assert.equal(forms,2);assert.equal(f.read().adoptions?.at(-1)?.previous?.[0].status,"dismissed");
	}
});

test("competing references need a selection; the next failed caller needs its own observation and changed bytes",async t=>{
	const f=await setup(t,factory),a=f.runtime(f.root,{confirm:async()=>true});
	await a.operation("repin",f.args,"owner");a.close();
	const initial=f.read().join;assert.ok(initial);
	const first=await f.publish(diff([files[0]]));await f.publish(diff(files));
	const forms=[];/** @type {ReturnType<typeof createRuntime>} */ const owner=f.runtime(f.root,{confirm:async prompt=>{
		forms.push(prompt);if(forms.length===1){put(f.root,"note.txt","Independent reading.");await owner.operation("publish",{run,file:"note.txt",to:dirs},"owner");}return true;
	}});
	owner.turn("owner");await owner.flush();
	assert.match(owner.inspect({run},"owner").blocker??"",/Multiple owner patches/);assert.equal(forms.length,0);
	await assert.rejects(owner.operation("draft",{run,check:initial.check},"owner"),{code:"dispatch_held"},"a third author cannot stand in for a choice between two verified corrections");
	assert.equal(f.read().correctionDrafts?.length??0,0);
	await assert.rejects(owner.operation("inherit",{run,check:initial.check,blob:first},"worker-1"),/owner/);
	await owner.operation("inherit",{run,check:initial.check,blob:first},"owner");await owner.flush();
	const intermediate=f.read(),second=intermediate.productRepins?.at(-1)?.amendments?.[0];assert.ok(second && intermediate.join);
	const middle=intermediate.effects.find(c=>c.id===second.recheck);
	assert.deepEqual(verdicts(middle?.receipt?.components),{first:{check:component,exit:0},middle:{check:component,exit:0},last:{check:component,exit:1}});
	assert.equal(intermediate.goal?.check,f.args.goal);assert.equal(forms.length,1);
	await assert.rejects(owner.operation("inherit",{run,check:initial.check,blob:first},"owner"),/current adopted target/);
	await f.publish(diff([files[1]]));owner.turn("owner");await owner.flush();
	const result=owner.inspect({run,detail:"proof"},"owner");
	assert.ok(result.qualified);assert.equal(forms.length,2);
	assert.deepEqual(result.productEvaluatorChanges?.at(-1)?.amendments?.map(s=>s.prior.check),[initial.check,middle?.id]);
	assert.equal(f.read().effects.find(c=>c.id===second.recheck)?.receipt?.exit,null);
	assert.equal(git(f.root,"rev-parse","HEAD"),f.revision);
});

test("a target move between consent and dispatch holds the original reserved check until its pin returns",async t=>{
	const f=await setup(t,factory),a=f.runtime(f.root,{confirm:async()=>true});
	await a.operation("repin",f.args,"owner");a.close();
	const saved=f.read();await f.publish(diff(files));
	let moved="",forms=0;
	const owner=f.runtime(f.root,{confirm:async()=>{forms++;return true;},permissionBlocker:async()=>{
		if(!moved && f.read().productRepins?.at(-1)?.amendments?.length){
			put(f.root,"later","keep");git(f.root,"add","later");git(f.root,"commit","-qm","Move before dispatch");
			moved=git(f.root,"rev-parse","main");
		}
		return null;
	}});
	owner.turn("owner");await owner.flush();
	const held=f.read(),call=held.effects.find(e=>e.id===held.join?.check);assert.ok(moved && call?.kind==="product");
	assert.equal(call.state,"ready");assert.equal(call.callId,undefined);assert.deepEqual(held.products,saved.products);assert.equal(forms,1);
	assert.equal(owner.inspect({run},"owner").release?.reason,"product-repin-target-changed");
	owner.turn("owner");await owner.flush();assert.deepEqual(f.read().effects,held.effects);
	git(f.root,"update-ref","refs/heads/main",f.revision,moved);
	owner.turn("owner");await owner.flush();
	const end=f.read();assert.equal(end.products.at(-1)?.check,call.id);assert.ok(owner.inspect({run},"owner").qualified);assert.equal(forms,1);
});

test("the exact patch uses the native form buttons alone, even under Approve All",async t=>{
	const f=await setup(t,factory),a=f.runtime(f.root,{confirm:async()=>true});
	await a.operation("repin",f.args,"owner");a.close();
	const blob=await f.publish(diff(files)),before=f.read();assert.ok(before.join);
	const args={run,inherited:{check:before.join.check,blob}},ctx={sessionId:"owner"},hook={...ctx,timestamp:new Date(),workingDirectory:f.root};
	/** @type {import("@github/copilot-sdk").ElicitationParams[]} */ const forms=[];
	/** @type {{action?:string,content?:Record<string,string>}} */ let reply;
	const entry=await loadEntry({sessionId:"owner",on(){},log(){},send:async()=>"notice",
		ui:{elicitation:async(/** @type {import("@github/copilot-sdk").ElicitationParams} */ form)=>{
			forms.push(form);return reply;
		}},rpc:{mode:{get:async()=>"autopilot"},managedSettings:{get:async()=>({failClosed:false,bypassPermissionsDisabled:false})},
			permissions:{getMode:async()=>({mode:"allow-all"})},tools:{execute:(/** @type {{name:string,arguments:import("./model.js").Effect["args"],toolCallId:string}} */ c)=>f.execute(c.name,c.arguments,c.toolCallId)}}});
	await entry.hooks.onSessionStart?.({...hook,source:"resume"},ctx);t.after(()=>entry.hooks.onSessionEnd?.({...hook,reason:"complete"},ctx));
	const name="foundry_grant",call=entry.tools.find(t=>t.name===name)?.handler;assert.ok(call);
	for(reply of [{},{action:"accept",content:{approval:"Leave unchanged"}},{action:"decline"},{action:"cancel"},{action:"accept"}]){
		const result=await call(args,{...ctx,toolName:name,toolCallId:`requested-inherited-${reply.action}-${!!reply.content}`,arguments:args});
		assert.equal(forms.length,1);const form=forms.pop();assert.ok(form);
		assert.deepEqual(form.requestedSchema,{type:"object",properties:{}},"a yes/no approval must not render a selector or checkbox");
		assert.ok(form.message.includes(blob) && files.every(p=>form.message.includes(p)));
		if(reply.action==="accept" && !reply.content){
			assert.equal(typeof result,"string");assert.ok(f.owner.inspect({run},"owner").qualified);
		}else{
			assert.notEqual(typeof result,"string");assert.deepEqual(f.read().effects,before.effects);
			assert.equal(f.read().adoptions?.at(-1)?.decision?.status,["decline","cancel"].includes(reply.action??"")?"dismissed":"unavailable");
		}
	}
});

test("an automatic approval arrives after turn-end cleanup without another owner turn",async t=>{
	const f=await setup(t,factory),a=f.runtime(f.root,{confirm:async()=>true});
	await a.operation("repin",f.args,"owner");a.close();
	const blob=await f.publish(diff(files)),before=f.read(),clock=recoveryClock();
	let active=true,visible=false;
	/** @type {string[]} */ const requests=[];
	const signals=new EventEmitter(),opened=once(signals,"open"),reply=once(signals,"reply");
	const owner=f.runtime(f.root,{watchRecovery:clock.watch,formIdle:async()=>!active,
		confirm:async message=>{requests.push(message);visible=true;signals.emit("open");await reply;return false;}});
	owner.sessionStart("owner",f.root);owner.turn("owner");
	try{
		await Promise.race([opened,owner.flush()]);
		// The desktop clears its composer items at the end of the turn, not the native callbacks.
		visible=false;active=false;
		assert.equal(requests.length,0,"a background approval issued inside the turn would already be invisible");
		await Promise.race([opened,clock.pulse(owner,8).then(()=>assert.fail("no post-turn approval"))]);
		assert.ok(visible && requests[0].includes(blob));assert.deepEqual(f.read().effects,before.effects);
	}finally{signals.emit("reply");await owner.flush();}
	await clock.pulse(owner,8);assert.equal(requests.length,1);assert.equal(f.read().adoptions?.at(-1)?.decision?.status,"dismissed");
});

for(const outcome of ["approve","decline","superseded"])test(`reloaded owner automatically recovers an orphaned form without duplicating a native request / ${outcome}`,async t=>{
	const historical=process.env.FOUNDRY_FORM_FIXTURE;
	/** @type {typeof factory} */ const build=historical?(await import(historical)).factory:outcome==="approve"?await historicalFactory(t,80):factory;
	const f=await setup(t,build),adopter=f.runtime(f.root,{confirm:async()=>true});
	await adopter.operation("repin",f.args,"owner");adopter.close();
	const blob=await f.publish(diff(files)),before=f.read(),clock=recoveryClock();
	const signals=new EventEmitter(),opened=once(signals,"open"),oldReply=once(signals,"reply");
	const old=f.runtime(f.root,{confirm:async()=>{signals.emit("open");await oldReply;return true;}});
	old.turn("owner");await Promise.race([opened,old.flush().then(()=>assert.fail("no original approval"))]);
	const original=f.read().adoptions?.at(-1);assert.ok(original?.decision?.status==="presenting");
	let native="pending",forms=0,probes=0;
	const restored=f.runtime(f.root,{watchRecovery:clock.watch,autoConfirm:async()=>true,
		formVacant:async()=>{probes++;if(native==="unknown")throw Error("Pending UI cannot be read");return native==="empty";},
		confirm:async message=>{
			forms++;assert.ok(message.includes(blob) && message.includes(original.assembly??assert.fail()));
			const now=f.read();assert.deepEqual(now.effects,before.effects);assert.deepEqual(now.products,before.products);
			const d=now.adoptions?.at(-1)?.decision;assert.ok(d?.status==="presenting");assert.notEqual(d.presentation,original.decision?.status==="presenting" && original.decision.presentation);
			return outcome==="approve";
		}},createRuntime);
	if(!historical && outcome==="decline"){
		// Native queues can still be empty between the durable claim and SDK delivery.
		native="empty";restored.sessionStart("owner",f.root);await clock.pulse(restored,4);
		assert.equal(probes,0);assert.equal(forms,0);
		await assert.rejects(restored.operation("inherit",{run,check:before.join?.check,blob},"owner"),{code:"approval_pending"});
	}
	old.close();native="pending";
	restored.sessionStart("owner",f.root);await clock.pulse(restored,4);
	native="unknown";await clock.pulse(restored,8);
	assert.deepEqual(f.read().adoptions?.at(-1)?.decision,original.decision);assert.equal(forms,0);
	if(outcome==="superseded"){put(f.root,"operator","later revision");git(f.root,"commit","-qam","Supersede the target");}
	native="empty";await clock.pulse(restored,12);
	signals.emit("reply");await old.flush();
	assert.ok(probes>0,"restored presentations must observe the host even when the ledger has not changed");
	assert.equal(forms,outcome==="superseded"?0:1,"no new operator command or duplicate presentation");
	await clock.pulse(restored,8);const end=f.read();
	if(outcome==="approve"){
		assert.ok(restored.inspect({run},"owner").qualified);assert.equal(end.productRepins?.at(-1)?.amendments?.length,1);
		assert.equal(end.productRepins?.at(-1)?.recheck,before.join?.check);
	}else assert.deepEqual(end.effects,before.effects);
	if(outcome!=="superseded"){
		const offer=end.adoptions?.at(-1);assert.equal(offer?.id,original.id);
		assert.partialDeepStrictEqual(offer?.previous?.at(-1),{status:"unavailable",presentation:original.decision.presentation});
		assert.equal(offer?.decision?.status,outcome==="approve"?"answered":"dismissed");assert.equal(forms,1);
	}
});

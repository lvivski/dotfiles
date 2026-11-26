import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { factory, git, put, recoveryClock } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";

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
	assert.equal(failed.receipt.exit,null);assert.deepEqual(failed.receipt.components,{first:{check:component,exit:0},middle:{check:component,exit:1}});
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
	assert.deepEqual(final.receipts.product.components,Object.fromEntries(ids.map(id=>[id,{check:component,exit:0}])));
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
	const forms=[],owner=f.runtime(f.root,{confirm:async prompt=>{forms.push(prompt);return true;}});
	owner.turn("owner");await owner.flush();
	assert.match(owner.inspect({run},"owner").blocker??"",/Multiple owner patches/);assert.equal(forms.length,0);
	await assert.rejects(owner.operation("inherit",{run,check:initial.check,blob:first},"worker-1"),/owner/);
	await owner.operation("inherit",{run,check:initial.check,blob:first},"owner");await owner.flush();
	const intermediate=f.read(),second=intermediate.productRepins?.at(-1)?.amendments?.[0];assert.ok(second && intermediate.join);
	const middle=intermediate.effects.find(c=>c.id===second.recheck);
	assert.deepEqual(middle?.receipt?.components,{first:{check:component,exit:0},middle:{check:component,exit:0},last:{check:component,exit:1}});
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

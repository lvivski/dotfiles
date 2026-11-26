import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openDatabase } from "./database.mjs";
import { checkpointReceipt } from "./evidence.mjs";
import { currentReview } from "./graph.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { factory, git, put } from "../test/fixture.mjs";

const run = "sample", source = ".foundry/sample.json", product = ".foundry/product.mjs", goal = ".foundry/goal.mjs";
const primary = "view/main", exact = "view/connection", component = ".foundry/component.mjs";
function latch() {
	let resolve=()=>{};
	const promise=new Promise(done=>{resolve=()=>done(undefined);});
	return {resolve,promise};
}
/** @param {import("node:test").TestContext} t @param {boolean} [stopped] @param {typeof factory} [build] */
async function checkpoint(t,stopped=false,build=factory) {
	const f = build(t, run, source, {
		[source]: JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Produce a checked file.",productCheck:product,goalCheck:goal,
			limits:{repairs:1},squads:(stopped?["unit","choice"]:["unit"]).map(id=>({id,areas:id==="unit"?["unit","view","stopped","incomplete"]:["choices"],charter:".foundry/spec.md",boundary:[".foundry/interface.md"],checks:[component]}))}),
		".foundry/spec.md":"Produce a checked file.", ".foundry/interface.md":"The file contains ok.", [component]:'if(process.env.FOUNDRY_GRAIN==="stopped")process.exit(1); if(process.env.FOUNDRY_GRAIN==="incomplete")process.exit(2)', [exact]:"disconnected",
		[product]:'console.log("legacy checker")', [goal]:`import {existsSync,readFileSync} from "node:fs"; process.exit(!existsSync("unit/result") ? 1 :
			existsSync("${primary}/result") && readFileSync("${exact}","utf8")==="connected" ? 0 : 2);`,
	});
	const opened=latch(), dismiss=latch(), original=f.runtime(f.root,{ask:async()=>{opened.resolve(); await dismiss.promise; return null;}});
	await f.start(original);
	await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	if (stopped) {
		await f.scouts.find(s=>s.squad==="choice")?.report({outcome:"needs-decision",ownerInput:"product-choice",reason:"Which label?",evidence:[".foundry/spec.md"],grains:[]});
		await opened.promise;
	}
	await f.scouts.find(s=>s.squad==="unit")?.report({outcome:"regenerate",reason:"File needed",evidence:[".foundry/spec.md"],
		grains:(stopped?["unit","stopped","incomplete"]:["unit"]).map(id=>({id,directory:id,task:`Write ${id}.`,check:component,needs:[]}))});
	if (stopped) for (const id of ["stopped","incomplete"]) {
		const w=f.workers.get((await f.status()).nodes.find(n=>n.grain===id)?.worker ?? ""); assert.ok(w);
		put(w.cwd,`${id}/result`,"initial candidate");
		await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	const w=f.workers.get((await f.status()).nodes.find(n=>n.grain==="unit")?.worker ?? ""); assert.ok(w);
	put(w.cwd,"unit/result","ok");
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	const before = f.owner.inspect({run,detail:"proof"},"owner"), prior = before.products?.at(-1);
	assert.ok(prior); assert.equal(before.goal?.receipt?.exit,2);
	const side = path.join(path.dirname(f.root),"overlay");
	git(f.root,"worktree","add","-q","--detach",side,f.tip);
	put(side,product,`import {readFileSync} from "node:fs"; if(readFileSync("unit/result","utf8")!=="ok")process.exit(1);
		const map=JSON.parse(process.env.FOUNDRY_OWNERSHIP); if(map.connection &&
			(JSON.stringify(map.connection.directories)!=='["${primary}"]' || JSON.stringify(map.connection.files)!=='["${exact}"]')) process.exit(1);
		console.log("new checker",process.env.FOUNDRY_OUTPUTS);`);
	git(side,"commit","-qam","Review product checker");
	const revision = git(side,"rev-parse","HEAD"), args = {run,kind:"product",from:f.tip,revision,files:[product]};
	if (stopped) {
		const db=openDatabase(f.root); t.after(()=>db.close());
		const before=db.read(run);
		await assert.rejects(f.owner.operation("repin",args,"owner"),/stopped \(writing\)/);
		assert.deepEqual(db.read(run),before);
		for (const id of ["stopped","incomplete"]) {
			const n=before?.nodes[id], w=f.workers.get(n?.worker ?? ""); assert.ok(w);
			const writer=f.runtime(w.cwd), node=writer.inspect({run},w.id).nodes.find(n=>n.grain===id); assert.ok(node?.token);
			assert.ok(node.receipt); assert.equal(node.receipt.exit,id==="stopped"?1:2);
			if (id==="incomplete") {
				assert.ok(node.cannotRepair);
				await writer.operation("submit",{run,token:node.token,cannotRepair:{check:node.cannotRepair.check,reason:"No permitted repair remains."}},w.id);
			} else {
				put(w.cwd,"stopped/result","corrected candidate"); await writer.operation("submit",{run,token:node.token},w.id);
			}
		}
		assert.equal(f.owner.inspect({run},"owner").questions?.length,0);
	}
	original.close(); dismiss.resolve();
	return { ...f, before, prior, side, revision, args };
}

for (const outcome of ["pass","component fails","goal fails"]) test(`mixed target repin on the original run / ${outcome}`,async t=>{
	const f=await checkpoint(t), owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("repin",f.args,"owner"); // A previously approved product checker is in the incoming merge.
	const db=openDatabase(f.root); t.after(()=>db.close());
	const read=()=>db.read(run) ?? assert.fail(), old=read(), prior=old.products.at(-1); assert.ok(prior && old.goal);
	const charter=".foundry/spec.md", changed=[charter,component,product,goal];
	put(f.root,"operator","keep"); put(f.root,charter,"Maintain the existing output; preserve the inventory.");
	put(f.root,product,git(f.side,"show",`HEAD:${product}`));
	put(f.root,component,`import {readFileSync} from "node:fs"; if(readFileSync("unit/result","utf8")!=="ok" ||
		readFileSync("operator","utf8")!=="keep" || process.env.FOUNDRY_GRAIN!=="unit") process.exit(1);
		process.exit(${outcome==="component fails"?1:0})`);
	const release=`import {readFileSync} from "node:fs"; if(readFileSync("unit/result","utf8")!=="ok" || readFileSync("operator","utf8")!=="keep")process.exit(1);`;
	put(f.root,goal,release+(outcome==="goal fails" ? 'if(process.argv[2]!=="--complete")process.exit(2);' : ""));
	git(f.root,"add",".");git(f.root,"commit","-qm","Operator changes acceptance and product together");
	const revision=git(f.root,"rev-parse","main"), args={run,kind:"target",revision,from:f.tip,files:changed,checkpoint:prior.check,goal:old.goal.check,acceptance:"Check the maintained output with the new component and final goal."};
	owner.turn("owner"); await owner.flush();
	assert.equal(owner.inspect({run},"owner").release?.reason,"contract-changed");
	const held=read(), attempts=[...f.checks];
	await assert.rejects(owner.operation("repin",{...args,files:[goal]},"owner"),/complete.*diff/i);
	await assert.rejects(owner.operation("repin",args,"worker-1"),/owner/i);
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false}).operation("repin",args,"owner"),/not approved/i);
	assert.deepEqual(read(),held); assert.deepEqual(f.checks,attempts);
	const migrated=f.runtime(f.root,{confirm:async prompt=>{
		for (const item of [f.revision,prior.check,old.goal?.check,revision,...changed]) assert.ok(item && prompt.includes(item));
		return true;
	}});
	await migrated.operation("repin",args,"owner");
	const after=read(), fresh=after.effects.slice(held.effects.length), p=fresh.find(e=>e.kind==="product");
	assert.deepEqual(after.effects.slice(0,held.effects.length),held.effects);
	assert.equal(git(f.root,"rev-parse","main"),revision); assert.deepEqual(after.nodes.unit,held.nodes.unit);
	assert.ok(p?.commit && p.receipt); assert.equal(p.evaluatorRevision,revision);
	assert.equal(git(f.root,"show",`${p.commit}:operator`),"keep"); assert.equal(git(f.root,"show",`${p.commit}:unit/result`),"ok");
	assert.equal(git(f.root,"rev-parse",`${p.commit}^`),revision);
	const final=migrated.inspect({run,detail:"proof"},"owner");
	if (outcome==="component fails") {
		assert.notEqual(p.receipt.exit,0); assert.match(p.receipt.output,/unit/); assert.ok(!fresh.some(e=>e.kind==="goal"));
		assert.deepEqual(p.receipt.components,{unit:{check:component,exit:1}});
	} else {
		assert.equal(p.receipt.exit,0); assert.equal(after.goal?.commit,p.commit);
		assert.equal(final.goal?.receipt?.exit,outcome==="pass"?0:2); assert.equal(final.goal?.pin,revision);
	}
	if (outcome==="pass") {
		assert.equal(final.qualified,p.commit); assert.equal(final.qualification?.contract.commit,revision);
		assert.equal(final.qualification?.receipts.product.evaluatorRevision,revision);
		assert.deepEqual(final.qualification?.receipts.product.components,{unit:{check:component,exit:0}});
		assert.equal(final.qualification?.contract.activation,f.tip);
		const corrupt=structuredClone(after), bad=corrupt.effects.find(e=>e.id===p.id)?.receipt?.components;
		assert.ok(bad); bad.unit.check=goal; assert.throws(()=>decode(corrupt),/lineage|dispatch/);
	} else assert.equal(final.qualification,null);
	if (outcome==="goal fails") {
		// Correct the default entrypoint off-target, retaining every full-release assertion.
		const side=path.join(path.dirname(f.root),"full-goal");
		git(f.root,"worktree","add","-q","--detach",side,revision);
		put(side,goal,release);git(side,"commit","-qam","Run the full goal by default");
		const pin=git(side,"rev-parse","HEAD"), checks=[...f.checks];
		await owner.operation("repin",{run,from:revision,revision:pin,files:[goal]},"owner");
		const proof=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);
		assert.equal(proof.commit,p.commit);assert.equal(proof.receipts.goal.evaluatorRevision,pin);
		assert.deepEqual(proof.receipts.product.components,p.receipt.components);
		assert.deepEqual(f.checks.slice(checks.length).map(c=>c.split(" at ")[0]),["Check final goal"]);
		const bundle=path.join(path.dirname(f.root),"adopted.bundle");
		execFileSync(process.execPath,[fileURLToPath(new URL("../../../skills/foundry/scripts/qualification.mjs",import.meta.url)),"pack",bundle],
			{cwd:f.root,input:JSON.stringify(proof)});
		const heads=git(f.root,"bundle","list-heads",bundle);
		for (const id of [f.tip,revision,pin,p.commit]) assert.ok(heads.includes(`refs/foundry/objects/${id}`));
		assert.equal(git(f.root,"rev-parse","main"),revision);
	}
});

for (const exit of [2,1]) test(`target adoption retains an unissued original repair without replay / signed exit ${exit}`,async t=>{
	const charter=".foundry/spec.md", ids=["core","extra","sample"];
	/** @type {typeof factory} */
	const build=process.env.FOUNDRY_PRIOR_FIXTURE ? (await import(process.env.FOUNDRY_PRIOR_FIXTURE)).factory : factory;
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Produce both catalog files.",
		productCheck:product,goalCheck:goal,limits:{repairs:1},squads:[{id:"catalog",areas:ids,charter,checks:[component]}]}),
		".foundry/sample/journey.md":"Open the complete catalog.",[charter]:"Produce the catalog files.","sample/existing":"original tree",
		[component]:`if (process.env.FOUNDRY_GRAIN==="sample") {console.log("Observation did not complete");process.exit(${exit});}`,
		[product]:"",[goal]:`import {existsSync} from "node:fs"; if(!existsSync("core/value"))process.exit(1);if(!existsSync("extra/value"))process.exit(2);`});
	await f.start(); await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"Produce both files and observe the sample.",evidence:[charter],
		grains:ids.map(id=>({id,directory:id,task:`Produce ${id}.`,check:component,needs:[]}))});
	const db=openDatabase(f.root);t.after(()=>db.close());
	const read=()=>db.read(run) ?? assert.fail("missing run");
	async function submit(/** @type {string} */ id) {
		const w=f.workers.get(read().nodes[id].worker ?? ""); assert.ok(w);
		put(w.cwd,`${id}/value`,id);
		const issuer=f.runtime(w.cwd);
		if(id==="sample") await issuer.operation("preview",{run,token:w.token},w.id);
		await issuer.operation("submit",{run,token:w.token},w.id);
	}
	await submit("core");
	const checkpoint=read().products.at(-1), assessed=read().goal?.check; assert.ok(checkpoint && assessed);
	put(f.root,"operator","keep");put(f.root,charter,"Maintain both files and report unavailable observations.");
	git(f.root,"add",".");git(f.root,"commit","-qm","Mixed operator target");
	await submit("extra"); await submit("sample");
	const before=read(), node=before.nodes.sample, original=before.effects.find(e=>e.id===node.check);
	assert.ok(original?.kind==="component" && original.receipt?.exit===exit && node.candidate===original.commit);
	assert.deepEqual([before.nodes.extra.state,node.state,node.repairs],["published","waiting",0]);
	const args={run,kind:"target",from:f.tip,revision:git(f.root,"rev-parse","main"),files:[charter],checkpoint:checkpoint.check,goal:assessed,acceptance:"Maintain the catalog. Keep the original release check."};
	const checks=[...f.checks], messages=[...f.inbox], oldReceipt=original.receipt;
	const migrated=f.runtime(f.root,{confirm:async()=>false},createRuntime);
	if(exit!==2) {
		await assert.rejects(migrated.operation("repin",args,"owner"),/current assignments/);
		assert.deepEqual(read(),before);return;
	}
	if (process.env.FOUNDRY_PRIOR_FIXTURE) await assert.rejects(f.owner.operation("repin",args,"owner"),/current assignments/);
	await assert.rejects(migrated.operation("repin",args,"owner"),/not approved/i);
	assert.deepEqual(read(),before);
	const owner=f.runtime(f.root,{confirm:async prompt=>{
		assert.ok(prompt.includes(original.id) && original.commit && prompt.includes(original.commit));
		return true;
	}},createRuntime);
	await owner.operation("repin",args,"owner");
	const after=read(), final=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(final);
	for (const e of before.effects) {
		const kept=after.effects.find(x=>x.id===e.id);
		if (e.kind==="writer" && e.grain==="extra") assert.partialDeepStrictEqual(kept,e); // Fresh integration finishes this writer.
		else assert.deepEqual(kept,e);
	}
	assert.deepEqual(after.nodes.sample,{...node,state:"blocked",reason:after.nodes.sample.reason});
	assert.match(after.nodes.sample.reason ?? "",/unavailable/i);
	assert.deepEqual(after.effects.find(e=>e.id===original.id)?.receipt,oldReceipt);
	assert.deepEqual(f.inbox,messages);
	assert.deepEqual(f.checks.slice(checks.length).map(s=>s.split(" at ")[0]),["Check joined product","Check final goal"]);
	assert.deepEqual(Object.keys(final.receipts.product.components ?? {}).sort(),["core","extra"]);
	assert.equal(git(f.root,"show",`${node.candidate}:sample/value`),"sample");
	assert.equal(git(f.root,"ls-tree",final.commit,"sample"),git(f.root,"ls-tree",checkpoint.commit,"sample"));
	assert.equal(git(f.root,"show",`${final.commit}:sample/existing`),"original tree");
	assert.equal(git(f.root,"show",`${final.commit}:extra/value`),"extra");
	assert.equal(git(f.root,"show",`${final.commit}:operator`),"keep");
});

test("target approval binds the live tip and cannot upgrade a directories-only checker",async t=>{
	const f=await checkpoint(t);
	const charter=".foundry/spec.md";put(f.root,charter,"Maintain the original output.");git(f.root,"commit","-qam","Prospective charter");
	const args={run,kind:"target",from:f.tip,revision:git(f.root,"rev-parse","main"),files:[charter],checkpoint:f.prior.check,
		goal:f.before.goalChecks?.at(-1)?.id,acceptance:"Retain the release criteria and adopt the new maintenance charter."};
	const attempts=[...f.checks], auto=f.runtime(f.root,{autoConfirm:async()=>true,confirm:undefined});
	await assert.rejects(auto.operation("repin",args,"owner"),/approval form is unavailable/i);
	const race=f.runtime(f.root,{confirm:async()=>{put(f.root,"operator","unrelated");git(f.root,"add","operator");git(f.root,"commit","-qm","Moved again");return true;}});
	await assert.rejects(race.operation("repin",args,"owner"),/changed during approval/i);
	assert.deepEqual(f.checks,attempts);
	const owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("repin",{...args,revision:git(f.root,"rev-parse","main")},"owner");
	const after=owner.inspect({run,detail:"proof"},"owner");
	assert.equal(after.productOwnership,"directories");
});

test("the target manifest cannot silently drop a previously approved checker or overwrite a published directory",async t=>{
	const f=await checkpoint(t), owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("repin",f.args,"owner");
	const prior=owner.inspect({run,detail:"proof"},"owner");
	const charter=".foundry/spec.md";put(f.root,charter,"Prospective charter.");git(f.root,"commit","-qam","Amend charter only");
	const args={run,kind:"target",from:f.tip,revision:git(f.root,"rev-parse","main"),checkpoint:prior.products?.at(-1)?.check,goal:prior.goalChecks?.at(-1)?.id,
		acceptance:"Keep the new charter and restore the legacy product checker.",files:[charter]};
	const checks=[...f.checks];
	await assert.rejects(owner.operation("repin",args,"owner"),/complete.*diff/i);
	put(f.root,"unit/extra","operator-owned");git(f.root,"add","unit");git(f.root,"commit","-qm","Edit inside included directory");
	await assert.rejects(owner.operation("repin",{...args,revision:git(f.root,"rev-parse","main"),files:[charter,product]},"owner"),/owned output|Concurrent modification/);
	assert.deepEqual(f.checks,checks);assert.equal(owner.inspect({run},"owner").productPin,f.revision);
});

test("mixed target reconciles only listed unowned file conflicts on the original checked run",async t=>{
	const charter=".foundry/spec.md", file="package/guide.txt", owned="package/core/value", flag="new-target";
	const base="Header\n\nObserve the original item.\n\nFooter\n", checkpoint=base+"Checkpoint notes.\n";
	const target=base.replace("original","selected"), merged=checkpoint.replace("original","selected");
	const ready=base+"Ready\n";
	const check=`import {existsSync,readFileSync} from "node:fs"; if(existsSync("${flag}") &&
		(readFileSync("${file}","utf8")!==${JSON.stringify(merged)} || readFileSync("${owned}","utf8")!==${JSON.stringify(ready)})) process.exit(1);`;
	/** @type {typeof factory} */
	const build=process.env.FOUNDRY_PRIOR_FIXTURE ? (await import(process.env.FOUNDRY_PRIOR_FIXTURE)).factory : factory;
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Publish a checked package.",
		productCheck:product,goalCheck:goal,squads:[{id:"package",areas:["package"],charter,checks:[component]}]}),
		".foundry/sample/journey.md":"Read the completed package.",[charter]:"Produce the package.",[file]:base,[owned]:base,
		[component]:check,[product]:check,[goal]:check+`if(!existsSync("${flag}"))process.exit(readFileSync("${owned}","utf8")===${JSON.stringify(ready)}?2:1);`});
	await f.start(); await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	for(const [id,directory] of [["broad","package"],["narrow","package/core"]]) {
		const scout=f.scouts.at(-1);assert.ok(scout);
		await scout.report({outcome:"regenerate",reason:"Complete the package.",evidence:[charter],grains:[{id,directory,task:`Produce ${id}.`,check:component,needs:[]}]});
		const w=f.workers.get((await f.status()).nodes.find(n=>n.grain===id)?.worker ?? "");assert.ok(w);
		if(id==="broad") put(w.cwd,file,checkpoint);
		put(w.cwd,owned,id==="broad"?"interim":ready);
		await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);await f.settle();
	}
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run) ?? assert.fail();
	const before=read(), last=before.products.at(-1);assert.ok(last && before.goal);
	assert.deepEqual(Object.keys(last.outputs),["narrow"]);assert.equal(before.effects.find(e=>e.id===before.goal?.check)?.receipt?.exit,2);
	put(f.root,file,target);put(f.root,flag,"present");put(f.root,charter,"Preserve both contributions.");
	git(f.root,"add",".");git(f.root,"commit","-qm","Change target paragraph and charter");
	const revision=git(f.root,"rev-parse","HEAD"), args={run,kind:"target",from:f.tip,revision,files:[charter],checkpoint:last.check,goal:before.goal.check,acceptance:"Keep the checked package and adopt the target paragraph."};
	const blob=(/** @type {string} */ ref,/** @type {string} */ p)=>git(f.root,"rev-parse",`${ref}:${p}`);
	const hash=(/** @type {string} */ bytes)=>execFileSync("git",["-C",f.root,"hash-object","--stdin"],{input:bytes,encoding:"utf8"}).trim();
	const row={file,mode:"100644",base:blob(f.tip,file),checkpoint:blob(last.commit,file),target:blob(revision,file),result:hash(merged)};
	const attempts=[...f.checks];
	await assert.rejects(f.owner.operation("repin",args,"owner"),/Concurrent modification since checkpoint/);
	if(process.env.FOUNDRY_PRIOR_FIXTURE) await assert.rejects(f.owner.operation("repin",{...args,resolutions:[row]},"owner"),/Unsupported field: resolutions/);
	let prompts=0;
	const owner=f.runtime(f.root,{confirm:async prompt=>{
		prompts++; for(const field of Object.values(row)) assert.ok(prompt.includes(field),field);
		assert.ok(prompt.includes("Observe the original item.") && prompt.includes("Observe the selected item."));
		return prompts>1;
	}},createRuntime);
	for(const bad of [{...row,checkpoint:row.target},{...row,result:hash("invented bytes")},{...row,mode:"100755"}])
		await assert.rejects(owner.operation("repin",{...args,resolutions:[bad]},"owner"),/resolution/i);
	assert.equal(prompts,0);
	// A second conflicting path needs its own proof, and approval cannot waive an included grant.
	put(f.root,owned,target);git(f.root,"commit","-qam","Competing edit to a current output");
	const changed=git(f.root,"rev-parse","HEAD");
	await assert.rejects(owner.operation("repin",{...args,revision:changed,resolutions:[row]},"owner"),/package\/core\/value/);
	const covered={...row,file:owned,checkpoint:hash(ready),result:hash(target+"Ready\n")};
	await assert.rejects(owner.operation("repin",{...args,revision:changed,resolutions:[row,covered]},"owner"),/owned output narrow/);
	put(f.root,owned,base);git(f.root,"commit","-qam","Withdraw only the competing fixture edit");
	const current=git(f.root,"rev-parse","HEAD"), request={...args,revision:current,resolutions:[row]};
	await assert.rejects(owner.operation("repin",request,"owner"),/not approved/i);
	assert.deepEqual(read(),before);assert.deepEqual(f.checks,attempts);
	await owner.operation("repin",request,"owner");
	const after=read(), proof=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);
	assert.deepEqual(after.effects.slice(0,before.effects.length),before.effects);
	assert.equal(git(f.root,"rev-parse","main"),current);assert.equal(blob(proof.commit,file),row.result);
	assert.equal(git(f.root,"rev-parse",`${proof.commit}^`),current);assert.deepEqual(proof.outputs.map(o=>o.id),["narrow"]);
	assert.deepEqual(proof.receipts.product.components,{narrow:{check:component,exit:0}});
	assert.equal(proof.receipts.goal.commit,proof.commit);assert.deepEqual(f.checks.slice(attempts.length).map(c=>c.split(" at ")[0]),["Check joined product","Check final goal"]);
	assert.deepEqual(after.productRepins?.at(-1)?.resolutions,[row]);
	const observed=after.effects.find(e=>e.id===after.productRepins?.at(-1)?.recheck);assert.ok(observed?.kind==="product" && observed.receipt?.resolutionDigest);
	db.verifySigned(run,observed);
	const forged=structuredClone(after), list=forged.productRepins?.at(-1)?.resolutions;assert.ok(list);
	list[0].result=hash("different");assert.throws(()=>decode(forged),{code:"corrupt_run"});
});

test("a bound writer can correct its frozen task, publish, and join the reviewed mixed target",async t=>{
	const f=await checkpoint(t), owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("repin",f.args,"owner");
	await owner.operation("configure",{run,revision:1,checkpointReviews:true},"owner");
	const previous=owner.inspect({run,detail:"proof"},"owner"), checked=previous.products?.at(-1), receipt=previous.goalChecks?.at(-1)?.id;
	assert.ok(receipt && checked);
	put(f.root,"offer","Connect the view");const [offer]=(await owner.operation("publish",{run,file:"offer",to:[primary]},"owner")).artifacts;
	await owner.operation("iterate",{run,directory:primary,files:[exact],receipt,source:{commit:checked.commit,file:exact,excerpt:"disconnected"},blob:offer.blob,question:"Connect the view."},"owner");
	await f.settle(); const review=f.scouts.at(-1); assert.ok(review);
	const clause=" Leave the flag disconnected.";
	await review.report({outcome:"regenerate",reason:"Wire the view.",evidence:[exact],grains:[{id:"connection",task:"Connect the view."+clause,directory:{primary,files:[exact]},check:component,needs:[]}]});
	const n=owner.inspect({run},"owner").nodes.find(n=>n.grain==="connection"), w=f.workers.get(n?.worker ?? "");assert.ok(w);
	put(w.cwd,`${primary}/result`,"existing draft");
	const charter=".foundry/spec.md"; put(f.root,charter,"Check both outputs.");put(f.root,product,git(f.side,"show",`HEAD:${product}`));
	git(f.root,"commit","-qam","Keep operator contract");const revision=git(f.root,"rev-parse","HEAD");
	const args={run,kind:"target",from:f.tip,revision,files:[charter,product],goal:receipt,checkpoint:checked.check,acceptance:"Use the target charter for new work; keep the full goal."};
	await assert.rejects(owner.operation("repin",args,"owner"),/current assignments/);
	await owner.operation("correct",{run,grain:"connection",worker:w.id,review:review.id,clause,file:exact,excerpt:"disconnected"},"owner");
	const writer=f.runtime(w.cwd);assert.equal(writer.inspect({run},w.id).nodes[0].task,"Connect the view.");
	put(w.cwd,exact,"connected");await writer.operation("submit",{run,token:w.token},w.id);
	assert.equal(owner.inspect({run},"owner").nodes.find(n=>n.grain==="connection")?.state,"published");
	await owner.operation("repin",args,"owner");
	const proof=owner.inspect({run,detail:"proof"},"owner").qualification; assert.ok(proof);
	assert.equal(git(f.root,"show",`${proof.commit}:${primary}/result`),"existing draft");
	assert.deepEqual(proof.outputs.map(o=>o.id).sort(),["connection","unit"]);assert.equal(git(f.root,"rev-parse","main"),revision);
});

test("a settled legacy checkpoint recovers on the same bytes only after a new product and goal receipt",async t=>{
	const f = await checkpoint(t,true);
	const db = openDatabase(f.root); t.after(()=>db.close());
	const read = () => db.read(run) ?? assert.fail("missing run");
	const old = read(), oldGoal = old.goal?.check, oldReviews = old.effects.filter(e=>e.kind==="scout");
	const stopped=old.nodes.stopped; assert.equal(stopped.state,"blocked"); assert.ok(stopped.candidate);
	assert.equal(old.effects.find(e=>e.id===stopped.check)?.receipt?.exit,1);
	assert.equal(old.nodes.incomplete.stop?.kind,"writer-cannot-repair");
	assert.ok(oldReviews.some(r=>r.decision?.status==="presenting" && r.base!==old.goal?.commit));
	const held = latch(), finish = latch();
	const owner = f.runtime(f.root,{confirm:async prompt=>{
		assert.match(prompt,/product evaluator only/i); assert.match(prompt,/exact-file/i); assert.match(prompt,new RegExp(f.prior.check));
		return true;
	},execute:async(tool,args,call)=>{
		if (tool==="bash" && String(args.description).startsWith("Check joined product")) { held.resolve(); await finish.promise; }
		return f.execute(tool,args,call);
	}});
	const operation = owner.operation("repin",f.args,"owner");
	try {
		await Promise.race([held.promise,operation.then(()=>assert.fail("no product recheck"))]);
		const current = read(); assert.equal(current.goal?.check,oldGoal);
		assert.equal(current.join?.commit,f.prior.commit); assert.deepEqual(current.join?.outputs,f.prior.outputs);
		assert.equal(checkpointReceipt(current,f.prior.check,f.prior.commit),false);
		assert.equal(owner.inspect({run},"owner").release?.admission,"closed");
		assert.equal(owner.inspect({run,detail:"proof"},"owner").qualification,null);
		assert.ok(oldReviews.every(r=>!currentReview(f.root,current,r)));
	} finally { finish.resolve(); await operation; }
	const end = read(), current = end.products.at(-1); assert.ok(current);
	assert.equal(current.commit,f.prior.commit); assert.notEqual(current.check,f.prior.check);
	assert.deepEqual(end.effects.slice(0,old.effects.length),old.effects);
	assert.deepEqual(end.products.slice(0,-1),old.products); assert.deepEqual(end.nodes,old.nodes);
	const fresh = end.effects.slice(old.effects.length);
	assert.deepEqual(fresh.map(e=>e.kind),["product","goal"]);
	assert.equal(fresh[0].receipt?.evaluatorRevision,f.revision); assert.match(fresh[0].receipt?.output ?? "",/new checker.*"unit":"unit"/);
	assert.equal(fresh[1].receipt?.evaluatorRevision,undefined); assert.equal(fresh[1].receipt?.exit,2);
	assert.deepEqual(end.repins,undefined); assert.ok(checkpointReceipt(end,current.check,current.commit));
	assert.equal(git(f.root,"rev-parse","refs/heads/main"),f.tip);

	const inspect = f.runtime(f.root,{confirm:async()=>true});
	put(f.root,"reference","Connect the view."); const [offer] = (await inspect.operation("publish",{run,file:"reference",to:[primary]},"owner")).artifacts;
	await inspect.operation("configure",{run,revision:1,checkpointReviews:true},"owner");
	const args = {run,directory:primary,files:[exact],source:{commit:current.commit,file:exact,excerpt:"disconnected"},blob:offer.blob,question:"Connect the view."};
	await assert.rejects(inspect.operation("iterate",{...args,receipt:oldGoal},"owner"),/settled exit-2/);
	await inspect.operation("iterate",{...args,receipt:end.goal?.check},"owner"); await f.settle();
	const comparison = f.scouts.at(-1); assert.ok(comparison?.packet.files[exact]);
	await comparison.report({outcome:"regenerate",reason:"Wire the view.",evidence:[exact],grains:[{
		id:"connection",task:"Wire the view.",check:component,directory:{primary,files:[exact]},needs:[]}]});
	const w=f.workers.get(read().nodes.connection?.worker ?? ""); assert.ok(w);
	put(w.cwd,`${primary}/result`,"ok"); put(w.cwd,exact,"connected");
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	const proof=inspect.inspect({run,detail:"proof"},"owner").qualification; assert.ok(proof);
	assert.equal(proof.format,"foundry-qualification/v3"); assert.notEqual(proof.commit,current.commit);
	assert.equal(proof.receipts.product.evaluatorRevision,f.revision); assert.equal(proof.receipts.goal.productEvaluatorRevision,f.revision);
	assert.equal(proof.receipts.goal.evaluatorRevision,undefined);
	assert.equal(git(f.root,"show",`${proof.commit}:${exact}`),"connected");
	assert.deepEqual(read().nodes.stopped,stopped); assert.ok(!proof.outputs.some(o=>o.id==="stopped"));
	assert.equal(git(f.root,"show",`${proof.commit}:${product}`),git(f.root,"show",`${f.tip}:${product}`));
	const bundle=path.join(path.dirname(f.root),"qualified.bundle");
	execFileSync(process.execPath,[fileURLToPath(new URL("../../../skills/foundry/scripts/qualification.mjs",import.meta.url)),"pack",bundle],
		{cwd:f.root,input:JSON.stringify(proof)});
	assert.match(git(f.root,"bundle","list-heads",bundle),new RegExp(`^${f.revision} refs/foundry/objects/${f.revision}$`,"m"));
	const final=read();
	for (const mutate of [
		/** @param {typeof final} r */ r=>{r.goal = old.goal;},
		/** @param {typeof final} r */ r=>{if (r.productRepins) r.productRepins[0].recheck=f.prior.check;},
		/** @param {typeof final} r */ r=>{const e=r.effects.find(e=>e.id===comparison.id); if(e) delete e.productEvaluatorRevision;},
		/** @param {typeof final} r */ r=>{const e=r.effects.find(e=>e.id===r.products.at(-1)?.check); if(e?.receipt) { delete e.evaluatorRevision; delete e.receipt.evaluatorRevision; }},
	]) { const forged=structuredClone(final); mutate(forged); assert.throws(()=>decode(forged),{code:"corrupt_run"}); }
});

test("product upgrade refuses missing consent, out-of-scope diffs, and an approval that outlives its checkpoint", async t=>{
	const f=await checkpoint(t), db=openDatabase(f.root); t.after(()=>db.close());
	const original=db.read(run); let prompts=0;
	const owner=f.runtime(f.root,{confirm:async()=>{prompts++; return false;}});
	await assert.rejects(owner.operation("repin",f.args,"worker-1"),{code:"foreign_run"});
	await assert.rejects(owner.operation("repin",{...f.args,files:[]},"owner"),{code:"invalid_pin"});
	await assert.rejects(owner.operation("repin",{...f.args,from:f.revision},"owner"),{code:"stale_pin"});
	for(const file of [source,goal,component,".foundry/interface.md","unit/result",".foundry/other.mjs"]) {
		git(f.side,"reset","--hard",f.revision);
		put(f.side,file,"unrelated edit"); git(f.side,"add",file); git(f.side,"commit","-qm","Unrelated change");
		await assert.rejects(owner.operation("repin",{...f.args,revision:git(f.side,"rev-parse","HEAD"),files:[product,file]},"owner"),{code:"contract_scope"});
	}
	assert.equal(prompts,0);
	await assert.rejects(owner.operation("repin",f.args,"owner"),{code:"approval_declined"});
	await assert.rejects(f.owner.operation("repin",f.args,"owner"),{code:"approval_required"});
	assert.equal(prompts,1); assert.deepEqual(db.read(run),original);
	let revoked=false;
	const permissions=f.runtime(f.root,{permissionBlocker:async()=>revoked?{scope:"session",message:"Manual approvals."}:null,
		confirm:async()=>{revoked=true;return true;}});
	await assert.rejects(permissions.operation("repin",f.args,"owner"),{code:"permissions_unready"});
	assert.deepEqual(db.read(run),original);
	const changed=f.runtime(f.root,{confirm:async()=>{
		put(f.root,"notice","new reviewed choice"); await f.owner.operation("publish",{run,file:"notice",to:[primary]},"owner"); return true;
	}});
	await assert.rejects(changed.operation("repin",f.args,"owner"),{code:"stale_pin"});
	const end=db.read(run); assert.ok(end); assert.equal(end.productRepins,undefined);
	assert.deepEqual(end.effects,original?.effects); assert.deepEqual(end.products,original?.products);
	const moved=f.runtime(f.root,{confirm:async()=>{
		put(f.root,"ordinary-file","unrelated target work"); git(f.root,"add","ordinary-file"); git(f.root,"commit","-qm","Moved target"); return true;
	}});
	await assert.rejects(moved.operation("repin",f.args,"owner"),{code:"stale_pin"});
	assert.deepEqual(db.read(run),end);
});

const before=process.env.FOUNDRY_RELEASE_BEFORE;
test("original writers can relinquish two signed numeric repairs without changing the checkpoint or its receipts", async t => {
	const previous = process.env.FOUNDRY_PREVIOUS_WORK;
	/** @type {typeof factory} */
	const build = previous ? (await import(pathToFileURL(path.resolve(previous,"../test/fixture.mjs")).href)).factory : factory;
	const f = build(t, run, source, {
		[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Deliver the core.",productCheck:product,goalCheck:goal,
			squads:[{id:"team",charter:"brief.md",boundary:["brief.md"],areas:["core","meter","lamp"],checks:[component]}]}),
		"brief.md":"Implement and observe.", [product]:"", [goal]:`import {existsSync} from "node:fs";process.exit(existsSync("core/output") ? 2 : 1);`,
		[component]:`if(process.env.FOUNDRY_GRAIN!=="core"){console.log("secondary observation unavailable");process.exit(process.env.FOUNDRY_GRAIN==="meter"?2:251);}`,
	});
	await f.start(); await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"Feature observations",evidence:["brief.md"],
		grains:["meter","lamp","core"].map(id=>({id,task:`Produce ${id}.`,directory:id,check:component,needs:[]}))});
	for (const id of ["meter","lamp","core"]) {
		const w=f.workers.get((await f.status()).nodes.find(n=>n.grain===id)?.worker ?? ""); assert.ok(w);
		put(w.cwd,`${id}/output`,id);
		await f.runtime(w.cwd,{execute:async (...args)=>{
			const result=await f.execute(...args);
			if (id==="meter" && args[0]==="bash") { f.owner.turn("owner"); await f.owner.flush(); }
			return result;
		}}).operation("submit",{run,token:w.token},w.id);
	}
	if (previous) for (const grain of ["meter","lamp"]) {
		const old=(await f.status()).nodes.find(n=>n.grain===grain);
		const w=f.workers.get(old?.worker ?? ""); assert.ok(w && old?.check);
		const writer=f.runtime(w.cwd), bound=writer.inspect({run},w.id).nodes.find(n=>n.grain===grain);
		assert.ok(bound?.token && !bound.cannotRepair && !bound.relinquish);
		await assert.rejects(writer.operation("submit",{run,token:bound.token,relinquish:{check:old.check,reason:"No scoped fix."}},w.id),
			{code:"unsupported_field"});
	}
	f.owner.close();
	const db=openDatabase(f.root); t.after(()=>db.close());
	const read=()=>db.read(run) ?? assert.fail(), old=read(), checkpoint=old.products.at(-1); assert.ok(checkpoint);
	const host={mode:async()=>"interactive",permissionBlocker:async()=>null,execute:f.execute,confirm:async()=>true,notify:async()=>"notice"};
	const owner=createRuntime(f.root,host); t.after(()=>owner.close());
	const side=path.join(path.dirname(f.root),"checker");
	git(f.root,"worktree","add","-q","--detach",side,f.tip); put(side,product,"// same product contract\n");
	git(side,"commit","-qam","Update product checker"); const pin={run,kind:"product",from:f.tip,revision:git(side,"rev-parse","HEAD"),files:[product]};
	for (const id of ["meter","lamp"]) {
		await assert.rejects(owner.operation("repin",pin,"owner"),{code:"unsettled_checkpoint"});
		const n=read().nodes[id], w=f.workers.get(n.worker ?? ""); assert.ok(w && n.check && n.token);
		const writer=createRuntime(w.cwd,host); t.after(()=>writer.close());
		const node=writer.inspect({run},w.id).nodes.find(x=>x.grain===id); assert.ok(node?.receipt && !node.cannotRepair);
		assert.equal(node.receipt.exit,id==="meter"?2:251);
		const stop={run,token:n.token,relinquish:{check:n.check,reason:"No scoped change can supply the auxiliary observation."}};
		const snapshot=read();
		assert.equal(owner.inspect({run},"owner").nodes.find(x=>x.grain===id)?.relinquish,undefined);
		await assert.rejects(owner.operation("submit",stop,"owner"));
		await assert.rejects(writer.operation("submit",{...stop,token:w.token},w.id));
		await assert.rejects(writer.operation("submit",{...stop,relinquish:{...stop.relinquish,check:old.goal?.check}},w.id));
		await assert.rejects(writer.operation("submit",{...stop,missingInput:"not an input"},w.id));
		const busy=createRuntime(w.cwd,{...host,runningHelpers:async()=>["helper"]}); t.after(()=>busy.close());
		await assert.rejects(busy.operation("submit",stop,w.id),{code:"helpers_running"});
		await assert.rejects(owner.operation("submit",stop,w.id),/worktree|generation/i);
		assert.deepEqual(read(),snapshot);
		assert.equal(node.relinquish?.check,n.check);
		put(w.cwd,`${id}/output`,"unsubmitted changes");
		await writer.operation("submit",stop,w.id);
		const end=read();
		assert.deepEqual(end.effects,old.effects); assert.deepEqual(end.products,old.products); assert.deepEqual(end.goal,old.goal);
		assert.equal(end.nodes[id].state,"blocked"); assert.equal(end.nodes[id].stop?.kind,"writer-relinquished");
		assert.equal(end.nodes[id].check,n.check); assert.equal(end.nodes[id].repairs,n.repairs);
		assert.equal(git(f.root,"show",`${node.receipt.commit}:${id}/output`),id);
		assert.equal(owner.inspect({run},"owner").qualified,null);
		await assert.rejects(writer.operation("submit",stop,w.id));
		const forged=structuredClone(end), effect=forged.effects.find(e=>e.kind==="component" && e.id===n.check);
		assert.ok(effect?.kind==="component");
		if (id==="lamp") delete effect.inlineRepair;
		else {
			const sent=forged.effects.find(e=>e.kind==="repair" && e.token===n.token); assert.ok(sent);
			sent.state="uncertain";
		}
		assert.throws(()=>decode(forged),{code:"corrupt_run"});
	}
	await owner.operation("repin",pin,"owner");
	const end=read(), fresh=end.products.at(-1);
	assert.equal(fresh?.commit,checkpoint.commit); assert.deepEqual(fresh?.outputs,checkpoint.outputs);
	assert.deepEqual(end.effects.slice(0,old.effects.length),old.effects);
	assert.deepEqual(end.effects.slice(old.effects.length).map(e=>[e.kind,e.receipt?.exit]),[["product",0],["goal",2]]);
	assert.equal(owner.inspect({run},"owner").qualified,null);
});
test("the original ledger accepts independent goal and successive product checker fixes",async t=>{
	const build=before ? (await import(pathToFileURL(path.resolve(before,"test/fixture.mjs")).href)).factory : factory;
	const f=await checkpoint(t,false,build); f.owner.close();
	const owner=createRuntime(f.root,{mode:async()=>"interactive",permissionBlocker:async()=>null,confirm:async()=>true,
		execute:f.execute,notify:async()=>"notice"}); t.after(()=>owner.close());
	const db=openDatabase(f.root); t.after(()=>db.close());
	const read=()=>db.read(run) ?? assert.fail("missing original run");
	const history=read(), goalSide=path.join(path.dirname(f.root),"goal");
	git(f.root,"worktree","add","-q","--detach",goalSide,f.tip);
	const originalGoal=git(goalSide,"show",`HEAD:${goal}`);
	put(goalSide,goal,`console.log("reviewed goal");\n${originalGoal}`); git(goalSide,"commit","-qam","Review goal evaluator");
	const goalPin=git(goalSide,"rev-parse","HEAD");
	const goalArgs={run,from:f.tip,revision:goalPin,files:[goal]};
	let revoked=false;
	const autopilot=createRuntime(f.root,{mode:async()=>"autopilot",autoConfirm:async()=>{revoked=true;return true;},
		permissionBlocker:async()=>revoked?{scope:"session",message:"Manual approvals."}:null,execute:f.execute,notify:async()=>"notice"});
	t.after(()=>autopilot.close());
	await assert.rejects(autopilot.operation("repin",goalArgs,"owner"),{code:"permissions_unready"});
	assert.deepEqual(read(),history);
	await owner.operation("repin",goalArgs,"owner");
	const afterGoal=read(); assert.equal(afterGoal.productRepins,undefined);
	assert.deepEqual(afterGoal.effects.slice(0,history.effects.length).map(e=>[e.id,e.receipt]),history.effects.map(e=>[e.id,e.receipt]));
	await owner.operation("repin",f.args,"owner");
	const helper=`${product}.d/check.mjs`;
	put(f.side,helper,'export default "second checker"');
	put(f.side,product,`import label from "./product.mjs.d/check.mjs"; console.log(label);\n${git(f.side,"show",`HEAD:${product}`)}`);
	git(f.side,"add",product,helper); git(f.side,"commit","-qm","Review second product evaluator");
	const second=git(f.side,"rev-parse","HEAD");
	await assert.rejects(owner.operation("repin",{...f.args,revision:second,files:[product,helper]},"owner"),{code:"stale_pin"});
	await owner.operation("repin",{...f.args,from:f.revision,revision:second,files:[product,helper]},"owner");
	const end=read(), effects=end.effects.slice(afterGoal.effects.length);
	assert.deepEqual(end.effects.slice(0,afterGoal.effects.length),afterGoal.effects);
	assert.deepEqual(end.products.slice(0,history.products.length),history.products);
	assert.deepEqual(end.productRepins?.map(p=>[p.from,p.revision]),[[f.tip,f.revision],[f.revision,second]]);
	assert.deepEqual(effects.map(e=>[e.kind,e.receipt?.evaluatorRevision,e.receipt?.productEvaluatorRevision]),
		[["product",f.revision,undefined],["goal",goalPin,f.revision],["product",second,undefined],["goal",goalPin,second]]);
	assert.ok(effects.every(e=>e.commit===f.prior.commit));
	assert.match(effects[2].receipt?.output ?? "",/second checker/); assert.match(effects[3].receipt?.output ?? "",/reviewed goal/);
	assert.equal(owner.inspect({run,detail:"proof"},"owner").qualification,null);
});

test("failed product recheck holds the original checkpoint; neither its repair hint nor resume can spend the old goal", async t=>{
	const f=await checkpoint(t); put(f.side,product,'console.log("FOUNDRY_REPAIR=unit");process.exit(1)');
	git(f.side,"commit","-qam","Nonpassing checker");
	const owner=f.runtime(f.root,{confirm:async()=>true});
	const held=await owner.operation("repin",{...f.args,revision:git(f.side,"rev-parse","HEAD")},"owner");
	assert.equal(held.candidate?.receipt?.exit,1); assert.match(held.blocker ?? "",/recheck did not pass/);
	const count=f.checks.length;
	await owner.operation("resume",{source},"owner");
	const end=owner.inspect({run,detail:"proof"},"owner");
	assert.equal(end.release?.admission,"closed"); assert.equal(end.qualification,null);
	assert.equal(end.goal?.receipt,undefined); assert.deepEqual(end.products,f.before.products);
	assert.equal(f.checks.length,count); assert.equal(f.workers.size,1);
});

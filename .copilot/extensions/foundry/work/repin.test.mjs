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
	await owner.operation("repin",{run,from:f.tip,revision:goalPin,files:[goal]},"owner");
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

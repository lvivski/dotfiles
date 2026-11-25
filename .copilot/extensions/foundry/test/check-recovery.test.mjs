import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { factory, git, put } from "./fixture.mjs";
import { openDatabase } from "../work/database.mjs";
import { createRuntime } from "../work/runtime.mjs";

const run = "sample", source = ".foundry/sample.json";
/** A previous release's fixture can produce the failures. Open its original Git checkout,
 * ledger and signed outcome journal with this release; never rewrite their snapshots.
 * @type {typeof factory} */
const priorFactory = process.env.FOUNDRY_PRIOR_FIXTURE ? (await import(process.env.FOUNDRY_PRIOR_FIXTURE)).factory : factory;
/** @param {string} goal */
const files = goal => ({
	[source]: JSON.stringify({ version:1,id:run,target:"refs/heads/target",direction:"Deliver a working item.",
		goalCheck:".foundry/goal.mjs",productCheck:"product.mjs",grains:[{id:"item",directory:"item",specification:"spec",boundary:["api"],check:"unit.mjs"}],
		squads:[{id:"items",charter:"spec",grains:["item"]}] }),
	spec:"Publish the item.", api:"Deliver a value.", "unit.mjs":"", "product.mjs":"", ".foundry/goal.mjs":goal,
});
const itemGoal = 'import {existsSync} from "node:fs";process.exit(existsSync("item/value")?0:1);';
/** @param {unknown} description */
const kind = description => String(description).startsWith("Check final goal") ? "goal" : String(description).startsWith("Check joined product") ? "product" : "component";
/** @param {{turn:(actor:string)=>void,flush:()=>Promise<void>}} r @param {string} actor */
async function turn(r,actor) { r.turn(actor); await r.flush(); }
/** @param {import("node:test").TestContext} t @param {ReturnType<typeof factory>} f @param {string} cwd @param {Partial<Parameters<typeof createRuntime>[1]>} [overrides] */
function upgrade(t,f,cwd,overrides) {
	const r = createRuntime(cwd,{mode:async()=>"interactive",permissionBlocker:async()=>null,execute:f.execute,notify:async()=>"handoff",
		watchReceipts:()=>()=>{}, ...overrides});
	t.after(()=>r.close());
	return r;
}

for (const fault of ["component","product","goal","signed-null","moved-goal"]) test(`fresh, approved observation of the frozen ${fault} check`, async t => {
	// The evaluator's external observation can change, not its immutable script.
	const data = files(fault === "signed-null"
		? 'import {existsSync} from "node:fs"; if (!existsSync(process.env.TMPDIR+"/observed")) process.kill(process.pid,"SIGKILL");'
		: itemGoal);
	data[source] = JSON.stringify({...JSON.parse(data[source]),limits:{workers:1,assignments:2}});
	const f = priorFactory(t,run,source,data);
	git(f.root,"branch","target",f.tip);
	const dir = path.dirname(f.root), gate = path.join(dir,"gate");
	mkdirSync(gate);
	let armed = fault === "signed-null", failed = "";
	/** @type {Parameters<typeof createRuntime>[1]["execute"]} */
	const execute = async (tool,args,id) => {
		if (tool !== "bash" || !armed || failed || (fault === "signed-null" || fault === "moved-goal" ? "goal" : fault) !== kind(args.description)) return f.execute(tool,args,id);
		failed = String(args.shellId).slice("foundry-".length);
		const interrupted = fault === "signed-null";
		const result = spawnSync("/bin/sh",["-c",String(args.command)],{cwd:f.root,encoding:"utf8",
			env:{...process.env,...(interrupted ? {TMPDIR:gate} : {PATH:gate})}});
		assert.equal(result.status,interrupted ? 0 : 127,result.stderr);
		return interrupted ? {resultType:"success",textResultForLlm:result.stdout} :
			{resultType:"success",toolTelemetry:{properties:{executionMode:"sync",shell_error_category:"command_nonzero_exit"},metrics:{exit_code:result.status}}};
	};
	const old = f.runtime(f.root,{execute,watchReceipts:()=>()=>{}});
	await f.start(old);
	let writer;
	if (fault !== "signed-null") {
		await f.scouts[0].report({outcome:"regenerate",reason:"Deliver item",evidence:["spec"],grains:["item"]});
		[writer] = f.workers.values(); assert.ok(writer);
		armed = true;
		put(writer.cwd,"item/value","frozen");
		const w = f.runtime(writer.cwd,{execute,watchReceipts:()=>()=>{}});
		await w.operation("submit",{run,token:writer.token},writer.id); await w.flush(); w.close();
		// A fresh component observation must never recapture the working tree.
		put(writer.cwd,"item/value","later edit");
	}
	await old.flush(); old.close();
	const db = openDatabase(f.root); t.after(()=>db.close());
	const original = db.read(run)?.effects.find(e=>e.id===failed);
	assert.ok(original && original.callId && original.state === "done");
	if (fault === "signed-null") { assert.ok(original.runnerClaim); assert.equal(original.receipt?.exit,null); }
	else { assert.ok(!original.runnerStarted && !original.runnerClaim && !original.receipt); assert.match(String(original.error),/launcher exited 127/); }
	const count = () => db.read(run)?.effects.filter(e=>e.tool==="bash").length;
	const before = count();
	put(gate,"observed","yes");
	const owner = upgrade(t,f,f.root,{confirm:async () => true,execute:async(tool,a,id)=>{
		if (fault!=="signed-null" || tool!=="bash") return f.execute(tool,a,id);
		const result = spawnSync("/bin/sh",["-c",String(a.command)],{cwd:f.root,encoding:"utf8",env:{...process.env,TMPDIR:gate}});
		assert.equal(result.status,0,result.stderr);
		return {resultType:"success",textResultForLlm:result.stdout};
	}});
	await turn(owner,"owner");
	await owner.operation("resume",{source},"owner");
	assert.equal(count(),before,"no automatic or ordinary resume retry");
	if (fault === "moved-goal") {
		put(f.root,"neighbor","new target"); git(f.root,"add","neighbor"); git(f.root,"commit","-qm","move target");
		git(f.root,"branch","-f","target","HEAD");
		const side=path.join(dir,"pin"); git(f.root,"worktree","add","-q","--detach",side,f.tip);
		put(side,".foundry/goal.mjs",`console.log("observing item");\n${itemGoal}`);
		git(side,"commit","-qam","Revise evaluator diagnostic");
		await owner.operation("repin",{run,from:f.tip,revision:git(side,"rev-parse","HEAD"),files:[".foundry/goal.mjs"]},"owner");
	}
	const args = {run,check:failed};
	await assert.rejects(upgrade(t,f,f.root,{confirm:async()=>false}).operation("recheck",args,"owner"),{code:"approval_declined"});
	assert.equal(count(),before);
	await owner.operation("recheck",args,"owner");
	if (fault==="component" && writer) {
		const selected=db.read(run)?.nodes.item.check;
		git(f.root,"branch","-d","target");
		await turn(upgrade(t,f,writer.cwd),writer.id);
		assert.equal(db.read(run)?.effects.find(e=>e.id===selected)?.callId,undefined,"a worker must not issue the named observation with its target absent");
		git(f.root,"branch","target",f.tip);
	}
	if (writer) await turn(upgrade(t,f,writer.cwd),writer.id);
	await turn(owner,"owner");
	const state = db.read(run); assert.ok(state);
	const product = state.products.at(-1);
	assert.ok(product?.qualifiedAt,JSON.stringify(owner.inspect({run},"owner"))); assert.equal(product.target,git(f.root,"rev-parse","target"));
	if (writer) assert.equal(git(f.root,"show",`${product.commit}:item/value`),"frozen");
	if (fault === "moved-goal") {
		assert.equal(git(f.root,"show",`${product.commit}:neighbor`),"new target");
		assert.match(state.effects.find(e=>e.id===state.goal?.check)?.receipt?.output ?? "",/observing item/);
	}
	assert.deepEqual(state.effects.find(e=>e.id===failed),original);
	const replacement = state.effects.filter(e=>e.tool==="bash" && e.recheck?.of===failed);
	assert.equal(replacement.length,1); assert.notEqual(replacement[0].callId,original.callId);
	assert.equal(replacement[0].receipt?.exit,0);
	if (fault !== "moved-goal") assert.equal(replacement[0].commit,original.commit);
	assert.equal(state.effects.filter(e=>e.kind==="scout" || e.kind==="writer" || e.kind==="repair").length,writer ? 2 : 0);
	const after = count();
	await owner.operation("recheck",args,"owner");
	assert.equal(count(),after);
});

for (const fault of ["unknown","claimed","numeric"]) test(`no fresh observation for ${fault}; preserve the original result`,async t=>{
	const goal = fault==="numeric" ? 'console.log("SIGKILL"); process.exit(137)' : fault==="claimed" ?
		'import {existsSync,writeFileSync} from "node:fs";import {setTimeout as sleep} from "node:timers/promises";'+
		'const gate=process.env.TMPDIR;writeFileSync(gate+"/claimed",""); for(let i=0;!existsSync(gate+"/finish")&&i<2000;i++)await sleep(10);' : "";
	const f=priorFactory(t,run,source,files(goal)), gate=path.dirname(f.root);
	git(f.root,"branch","target",f.tip);
	/** @type {Promise<number|null>|undefined} */ let completion;
	/** @type {(()=>Promise<unknown>)|undefined} */ let original;
	const old=f.runtime(f.root,{watchReceipts:()=>()=>{},execute:async(tool,args,id)=>{
		if (fault==="numeric" || tool!=="bash") return f.execute(tool,args,id);
		if (fault==="unknown") { original=()=>f.execute(tool,args,id); return {resultType:"unconfirmed"}; }
		const runner=spawn("/bin/sh",["-c",String(args.command)],{cwd:f.root,env:{...process.env,TMPDIR:gate},stdio:"ignore"});
		completion=new Promise((resolve,reject)=>{runner.once("error",reject);runner.once("exit",resolve);});
		const until=Date.now()+12000;
		while (!existsSync(path.join(gate,"claimed"))) { assert.ok(Date.now()<until); await delay(10); }
		// Even a definitive native command exit isn't evidence against a claimed runner.
		return {resultType:"success",toolTelemetry:{properties:{executionMode:"sync",shell_error_category:"command_nonzero_exit"},metrics:{exit_code:137}}};
	}});
	try {
		await f.start(old); old.close();
		const db=openDatabase(f.root); t.after(()=>db.close());
		const before=db.read(run), check=before?.goal?.check; assert.ok(check);
		const first=before.effects.find(e=>e.id===check); assert.ok(first);
		assert.equal(!!first.runnerClaim,fault!=="unknown");
		assert.equal(first.receipt?.exit,fault==="numeric" ? 137 : undefined);
		const owner=upgrade(t,f,f.root,{confirm:async()=>assert.fail("unexpected approval")});
		await assert.rejects(owner.operation("recheck",{run,check},"owner"),{code:"not_recoverable"});
		assert.deepEqual(db.read(run)?.effects,before.effects);
		if (fault!=="numeric") {
			if (completion) { put(gate,"finish",""); assert.equal(await completion,0); }
			else { assert.ok(original); await original(); }
			await turn(owner,"owner");
			const end=db.read(run); assert.ok(end?.products.at(-1)?.qualifiedAt);
			assert.deepEqual(end.effects.filter(e=>e.kind==="goal").map(e=>e.id),[check]);
		}
	} finally { if (completion) { put(gate,"finish",""); await completion; } }
});

for (const race of ["target","pause","deadline","permission"]) test(`a ${race} change during approval does not spend a fresh check`,async t=>{
	const deadline=Date.now()+60_000, data=files(""); data[source]=JSON.stringify({...JSON.parse(data[source]),limits:{deadline:new Date(deadline).toISOString()}});
	const f=priorFactory(t,run,source,data); git(f.root,"branch","target",f.tip);
	const old=f.runtime(f.root,{execute:async()=>({resultType:"success",toolTelemetry:{properties:{executionMode:"sync",shell_error_category:"command_nonzero_exit"},metrics:{exit_code:1}}})});
	await f.start(old); old.close();
	const db=openDatabase(f.root); t.after(()=>db.close()); const before=db.read(run); assert.ok(before?.goal);
	let held=false;
	const owner=upgrade(t,f,f.root,{permissionBlocker:async()=>held ? {scope:"run",message:"held"} : null,confirm:async()=>{
		if (race==="target") {put(f.root,"moved","yes");git(f.root,"add","moved");git(f.root,"commit","-qm","move");git(f.root,"branch","-f","target","HEAD");}
		if (race==="pause") await f.owner.operation("pause",{run},"owner");
		if (race==="deadline") t.mock.method(Date,"now",()=>deadline+1);
		held=race==="permission"; return true;
	}});
	await assert.rejects(owner.operation("recheck",{run,check:before.goal.check},"owner"),{
		code:race==="target" ? "stale_assignment" : race==="pause" ? "paused" : race==="deadline" ? "deadline" : "permissions_unready"});
	assert.deepEqual(db.read(run)?.effects,before.effects);
});

test("a copied null receipt with its original signature missing grants no observation",async t=>{
	const f=priorFactory(t,run,source,files('process.kill(process.pid,"SIGKILL")'));
	git(f.root,"branch","target",f.tip); await f.start();
	const db=openDatabase(f.root); t.after(()=>db.close());
	const check=db.read(run)?.goal?.check; assert.ok(check);
	const journal=new DatabaseSync(`${db.file}.outcomes`);
	try { assert.equal(journal.prepare("DELETE FROM outcomes WHERE run=? AND effect=?").run(run,check).changes,1); }
	finally { journal.close(); }
	const before=db.read(run);
	assert.equal(before?.effects.find(e=>e.id===check)?.receipt?.exit,null);
	const owner=upgrade(t,f,f.root,{confirm:async()=>assert.fail("missing signature must not open approval")});
	await assert.rejects(owner.operation("recheck",{run,check},"owner"),{code:"missing_receipt"});
	assert.deepEqual(db.read(run),before);
});

for (const phase of ["component","product","goal"]) test(`a missing target after ${phase} returns a wait and does not discard its receipt`, async t => {
	const f = factory(t,run,source,files(itemGoal));
	git(f.root,"branch","target",f.tip);
	await f.start(); await f.scouts[0].report({outcome:"regenerate",reason:"Deliver item",evidence:["spec"],grains:["item"]});
	const [w] = f.workers.values();
	let hidden = false;
	const issuer = f.runtime(w.cwd,{execute:async(tool,args,id)=>{
		const result = await f.execute(tool,args,id);
		if (!hidden && tool==="bash" && kind(args.description)===phase) {git(f.root,"branch","-d","target"); hidden=true;}
		return result;
	}});
	put(w.cwd,"item/value","frozen");
	const submitted=await issuer.operation("submit",{run,token:w.token},w.id);
	assert.match(String("blocker" in submitted && submitted.blocker),/Target unavailable/);
	assert.ok(hidden);
	const db=openDatabase(f.root); t.after(()=>db.close());
	assert.equal(db.read(run)?.conflict,undefined,"a missing ref is a live wait, not a persisted refusal");
	const proof = () => f.owner.inspect({run,detail:"proof"},"owner");
	assert.equal(proof().release?.reason,"target-unavailable"); assert.equal(proof().qualified,null);
	const absent=proof();
	const receipt=phase==="component" ? absent.nodes[0].receipt : phase==="product" ? absent.candidate?.receipt : absent.goal?.receipt;
	assert.equal(receipt && receipt.exit,0);
	const before = f.checks.length; await turn(f.owner,"owner"); assert.equal(f.checks.length,before);
	git(f.root,"branch","target",f.tip); await turn(f.owner,"owner");
	assert.ok(proof().qualified);
	assert.deepEqual(f.checks.map(kind),["goal","component","product","goal"]);
});

test("a frozen goal pass over an absent target cannot qualify its restored, moved ref",async t=>{
	const f=priorFactory(t,run,source,files(itemGoal));
	git(f.root,"branch","target",f.tip); await f.start();
	await f.scouts[0].report({outcome:"regenerate",reason:"Deliver item",evidence:["spec"],grains:["item"]});
	const [w]=f.workers.values();
	const old=f.runtime(w.cwd,{execute:async(tool,args,id)=>{
		const result=await f.execute(tool,args,id);
		if (tool==="bash" && kind(args.description)==="goal") git(f.root,"branch","-d","target");
		return result;
	}});
	put(w.cwd,"item/value","frozen");
	try { await old.operation("submit",{run,token:w.token},w.id); }
	catch (error) { assert.ok(process.env.FOUNDRY_PRIOR_FIXTURE && error instanceof Error && "status" in error && error.status===128); }
	old.close();
	const db=openDatabase(f.root); t.after(()=>db.close());
	const before=db.read(run), oldGoal=before?.effects.find(e=>e.id===before.goal?.check);
	assert.ok(oldGoal?.runnerClaim && oldGoal.receipt?.exit===0);
	put(f.root,"neighbor","new"); git(f.root,"add","neighbor"); git(f.root,"commit","-qm","different target"); git(f.root,"branch","target","HEAD");
	const owner=upgrade(t,f,f.root); await turn(owner,"owner");
	const final=db.read(run), product=final?.products.at(-1);
	assert.ok(final && product?.qualifiedAt);
	assert.equal(product.target,git(f.root,"rev-parse","target")); assert.notEqual(product.commit,oldGoal.commit);
	assert.deepEqual(final.effects.find(e=>e.id===oldGoal.id),oldGoal);
	assert.equal(git(f.root,"show",`${product.commit}:neighbor`),"new"); assert.equal(git(f.root,"show",`${product.commit}:item/value`),"frozen");
	assert.equal(final.effects.filter(e=>e.kind==="component").length,1);
	assert.equal(final.effects.find(e=>e.id===final.goal?.check)?.receipt?.commit,product.commit);
});

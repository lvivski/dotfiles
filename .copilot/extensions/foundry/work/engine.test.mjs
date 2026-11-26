import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { decisionOf, releasePreflight, transition } from "./engine.mjs";
import { select, step, transition as next } from "./machine.mjs";
import { catalog } from "./catalog.mjs";
import { applyGoal, qualify, releaseAssessment } from "./goal.mjs";
import { receiptWakes } from "./wakes.mjs";
import { factory, git, put } from "../test/fixture.mjs";

test("every registered transition can win; unknown states, guards and unreachable rules fail closed",()=>{
	const {machines}=catalog();
	for (const model of Object.values(machines)) for (const [state,all] of Object.entries(model.states)) for (const signal of new Set(all.map(e=>e.on))) {
		const edges=all.filter(e=>e.on===signal), flags=[...new Set(edges.flatMap(e=>(e.when ?? []).map(g=>g.replace(/^!/,""))))], reached=new Set();
		for (let mask=0;mask<2**flags.length;mask++) {
			const facts=Object.fromEntries(flags.map((g,i)=>[g,!!(mask & (1<<i))]));
			const edge=step(model,state,signal,facts);if(edge) reached.add(edge);
			if (model.id==="release" && signal==="assess" || model.id==="release-preflight") assert.ok(edge,"A release assessment must not drop an observation");
		}
		assert.equal(reached.size,edges.length,`Dead transition in ${state}`);
	}
	assert.throws(()=>select(machines.supervision,"managed-policy","sample",{}),/missing boolean/i);
});

test("a changed contract cannot promote a frozen checkpoint, and a published repair only rejoins when its admission permits it",()=>{
	const flags=[false,true];
	for (const contractChanged of flags) for (const checkpointWriters of flags) for (const changedJoin of flags) for (const published of flags) {
		const observed={type:"inspect",target:"live",workTarget:"signed",...(contractChanged && {error:"contract changed"})};
		const res=next(releasePreflight,{value:"frozen",context:/** @type {import("./engine.mjs").Decision|null} */ (null)},observed,
			{contractChanged,checkpointWriters,changedJoin,published},true);
		const rejoin=!contractChanged && changedJoin && published;
		assert.deepEqual(decisionOf(res),{action:rejoin?"rejoin":"wait",admission:rejoin?"join-only":checkpointWriters?"checkpoint":"closed",
			reason:contractChanged?"contract-changed":rejoin?"target-changed":"checkpoint-work",target:"live",
			...(!rejoin && {workTarget:"signed"}),...(contractChanged && {error:"contract changed"})});
		assert.deepEqual(res.effects.map(e=>e.type),rejoin?["rejoin"]:[]);
	}
});

test("ownership repair admission is the intersection of ordinary writer permission, current pins and a designated repair",()=>{
	const inputs=["sameTarget","joining","blocked","recordedConflict","permissionHold","eligibleWriters","scoped","designatedRepair"];
	for (let mask=0;mask<2**inputs.length;mask++) {
		const f=Object.fromEntries(inputs.map((key,i)=>[key,!!(mask & 1<<i)])), event={type:"inspect",target:"pin",error:"held ownership"};
		let plan=next(releasePreflight,{value:"repair-admission",context:/** @type {import("./engine.mjs").Decision|null} */ (null)},event,f,true);
		if (plan.snapshot.value==="repairs") plan=next(releasePreflight,plan.snapshot,event,f,true);
		const permitted=f.sameTarget && !f.joining && !f.blocked && !f.recordedConflict && !f.permissionHold && f.eligibleWriters && f.designatedRepair;
		assert.deepEqual(decisionOf(plan),{action:"wait",reason:"ownership-conflict",target:"pin",error:"held ownership",
			admission:permitted ? f.scoped ? "ownership-checkpoint-repairs" : "ownership-repairs" : "closed"});
		assert.deepEqual(plan.effects,[]);
	}
});

/** @returns {import("./model.js").Run} */
function checkedRun() {
	const commit="pin", product={target:commit,commit,check:"p",outputs:{}}, goal={target:commit,commit,check:"g"};
	/** @param {"product"|"goal"} kind @param {string} id @returns {import("./model.js").NativeCall} */
	const signed=(kind,id)=>({id,kind,issuer:"owner",tool:"bash",args:{},callId:id,state:"done",runnerStarted:true,check:kind,commit,
		receipt:{check:kind,commit,exit:0,output:"passed",completedAt:1}});
	return {id:"release",active:true,activatedAt:1,owner:"owner",nodes:{},goal,products:[product],effects:[signed("goal","g"),signed("product","p")],
		policy:{id:"release",source:"plan",direction:"Verify the output.",target:"main",base:commit,files:[],squads:[],repairs:0,goalCheck:"goal",productCheck:"product"}};
}

test("an expired assessment reads the target only for two timely passes, and hands off only the exact settled product",()=>{
	for (const variant of ["late product","unsigned goal","wrong evaluator","missing target","work still owed","exact"]) {
		const run=checkedRun(), before=run.effects.slice(), product=run.products[0];
		run.policy.deadline=new Date(5000).toISOString();
		const [goal,joined]=run.effects;
		if(variant==="late product") {assert.ok(joined.receipt);joined.receipt.completedAt=5000;}
		if(variant==="unsigned goal") delete goal.runnerStarted;
		if(variant==="wrong evaluator") run.policy.productCheck="different-check";
		if(variant==="work still owed") run.nodes.part={grain:{id:"part",specification:"spec",directory:"part",boundary:[],needs:[],check:"unit"},state:"published",repairs:0};
		const hidden=variant==="missing target", exact=variant==="exact", early=["late product","unsigned goal","wrong evaluator"].includes(variant);
		let reads=0;
		const tip=()=>{reads++;assert.ok(!early,"Do not look up a target after the early deadline gate");
			if(hidden)throw Object.assign(Error("absent ref"),{status:128});return "pin";};
		const assessment=releaseAssessment(".",run,tip);
		assert.equal(assessment.reason,exact?"exact-checks-passed":hidden?"target-unavailable":"deadline");
		assert.equal(assessment.action,exact?"qualify":"wait");
		assert.equal(reads,early?0:1);assert.equal(product.qualifiedAt,undefined);assert.deepEqual(run.effects,before);
		assert.deepEqual(applyGoal(".",run,"owner",tip,false),assessment);
		applyGoal(".",run,"owner",tip,false);
		assert.equal(run.effects.filter(e=>e.kind==="handoff").length,Number(exact));
		assert.equal(!!product.qualifiedAt,exact);assert.deepEqual(run.effects.slice(0,2),before);
	}
});

test("a component-only handoff cannot use a past join, a goal run's milestone or an unsigned product",()=>{
	for(const variant of ["not current join","target moved","goal requires assessment","native success only","already qualified","exact"]) {
		const run=checkedRun(), [product]=run.products.splice(0);delete run.goal;delete run.policy.goalCheck;
		run.join=variant==="not current join"?{...product}:product;
		if(variant==="goal requires assessment") run.policy.goalCheck="goal";
		if(variant==="native success only") delete run.effects[1].runnerStarted;
		if(variant==="already qualified") product.qualifiedAt=1;
		const before=structuredClone(run), handoff=()=>qualify(run,"owner",product,variant==="target moved"?"new":"pin");
		if(variant!=="exact") {assert.throws(handoff,/unhandled transition/i);assert.deepEqual(run,before);continue;}
		handoff();assert.ok(product.qualifiedAt);assert.equal(run.active,true);
		assert.equal(run.effects.filter(e=>e.kind==="handoff").length,1);assert.throws(handoff,/unhandled transition/i);
	}
});

test("release inspection and execution agree on a changed contract and recover when restored", async t => {
	const run = "guard", source = ".foundry/guard.json";
	const f = factory(t, run, source, { [source]: JSON.stringify({version:2, id:run, target:"refs/heads/main",
		direction:"Build a catalog.", goalCheck:"goal.mjs", productCheck:"product.mjs",
		squads:[{id:"catalog",areas:["app"],charter:"spec",boundary:["api"],checks:["unit.mjs"]}]}),
		api:"Original", spec:"Own the catalog.", "goal.mjs":"process.exit(1)", "product.mjs":"", "unit.mjs":"" });
	/** @type {(()=>void)|undefined} */ let tick;
	const owner=f.runtime(f.root,{watchRecovery:fn=>{tick=fn;return ()=>{tick=undefined;};}});
	await f.start(owner);
	const ledger = openDatabase(f.root); t.after(() => ledger.close());
	const stamp = ledger.stamp(run);
	put(f.root, "api", "Changed"); git(f.root, "commit", "-qam", "Change conserved contract");
	assert.equal(f.owner.inspect({run}, "owner").release?.admission, "closed");
	assert.equal(ledger.stamp(run), stamp, "status must not journal a newly observed conflict");
	owner.turn("owner"); await owner.flush();
	const blocked = f.owner.inspect({run}, "owner");
	assert.match(blocked.blocker ?? "", /conserved contract changed: api/i);
	assert.partialDeepStrictEqual(blocked.release, { action:"wait", admission:"closed", reason:"contract-changed" });
	assert.deepEqual(await f.status(), blocked);
	assert.equal(f.checks.length, 1);
	assert.ok(tick);
	for (let i=0;i<8;i++) {tick(); await owner.flush();}
	put(f.root, "api", "Original"); git(f.root, "commit", "-qam", "Restore contract");
	const held = ledger.stamp(run);
	assert.equal(f.owner.inspect({run}, "owner").release?.admission, "open", "assessment uses the restored tip before reconciliation");
	assert.equal(ledger.stamp(run), held);
	for (let i=0;i<8;i++) {tick(); await owner.flush();}
	assert.notEqual(ledger.stamp(run),held,"the target repair must wake dispatch, not just change the read-only assessment");
	const restored = f.owner.inspect({run}, "owner");
	assert.doesNotMatch(restored.blocker ?? "", /conserved contract changed/);
	assert.notEqual(restored.release?.reason, "contract-changed");
});

test("a locked ledger does not lose an issued receipt watch; permanent errors retire it", () => {
	/** @type {import("./model.js").NativeCall} */
	const check = {id:"c",issuer:"owner",kind:"goal",tool:"bash",state:"issued",args:{},callId:"native",commit:"pin",check:"goal"};
	/** @type {import("./model.js").Run} */
	const run = {id:"watch",owner:"owner",active:true,activatedAt:1,nodes:{},products:[],effects:[check],
		policy:{id:"watch",direction:"test",target:"main",source:"p",base:"pin",productCheck:"check",files:[],squads:[],repairs:0}};
	/** @type {(()=>void)|undefined} */ let tick;
	let wakes = 0, logs = 0;
	/** @type {Error|null} */ let failure = Object.assign(Error("locked"), { code:"ERR_SQLITE_ERROR", errcode:5 });
	const observer = receiptWakes({read:() => run, stamp:() => { if (failure) throw failure; return "new"; },
		clock: fn => { tick = fn; return () => { tick = undefined; }; }, wake:() => { wakes++; }, log:() => { logs++; } });
	const currentTick = () => tick, poll = () => currentTick()?.();
	observer.observe(run, "owner"); poll();
	assert.ok(tick, "a transient contention error must retain the observation");
	failure = null;
	check.state = "done"; check.runnerStarted = true; check.receipt = {commit:"pin",check:"goal",exit:0,output:""};
	for (let i = 0; i < 10; i++) poll();
	assert.equal(wakes, 1); assert.equal(tick, undefined);
	check.state = "issued"; delete check.receipt;
	failure = Object.assign(Error("corrupt"), { code:"ERR_SQLITE_ERROR", errcode:11 });
	observer.observe(run, "owner"); poll();
	assert.equal(tick, undefined); assert.equal(wakes, 1); assert.ok(logs);
	failure = Object.assign(Error("try again"), {code:"EAGAIN"});
	observer.observe(run, "owner"); poll();
	const queued = currentTick(); assert.ok(queued);
	observer.close();
	failure = null;
	check.receipt = {commit:"pin",check:"goal",exit:0,output:""};
	queued();
	assert.equal(tick, undefined); assert.equal(wakes, 1);
});

test("an unrecognized goal state cannot inherit a passing checkpoint's release path", () => {
	/** @type {import("./engine.mjs").Facts} */
	const eligible = {active:true, qualified:false, goal:"met", blocked:false, scoped:false, stalled:false,
		moved:false, failedComponent:false, idle:true, product:true, exactProduct:true, join:false, held:false, review:false, work:false};
	assert.equal(transition(eligible).action, "qualify");
	const future = { ...eligible, goal: "needs-inspection" };
	// Model a newer producer at the JavaScript boundary, outside the compile-time state union.
	assert.throws(() => Reflect.apply(transition, undefined, [future]), /unhandled.*needs-inspection/i);
});

test("a pass qualifies exactly one settled product; reorderings cannot qualify pending work or trap an eligible comparison", () => {
	/** @type {import("./engine.mjs").GoalState[]} */
	const goals = ["pending", "superseded", "incomplete", "missing", "unmet", "met"];
	const flags = [false, true];
	for (const goal of goals) for (const active of flags) for (const exactProduct of flags) for (const moved of flags)
	for (const review of flags) for (const work of flags) for (const blocked of flags) for (const join of flags) {
		const scoped = exactProduct && !moved && !blocked && !join && (goal === "pending" || goal === "superseded" || review);
		const input = Object.freeze({active,goal,exactProduct,moved,review,work,blocked,join,scoped,product:true,stalled:false,held:false,idle:false,qualified:false,failedComponent:false});
		const {action, admission} = transition(input);
		assert.equal(action === "qualify", active && goal === "met" && exactProduct && !moved && !review && !work && !blocked && !join);
		if (goal === "pending" || goal === "superseded") {
			assert.equal(action,"wait");
			assert.equal(admission,active && scoped ? "checkpoint" : "closed");
		}
	}
});

test("a same-target join never turns a normal reconciliation into a retry of missing goal evidence", () => {
	/** @type {import("./engine.mjs").Facts} */
	const facts={active:true, qualified:false, goal:"missing", blocked:false, scoped:false, stalled:false,
		moved:false, failedComponent:false, idle:false, product:true, exactProduct:true, join:true, held:false, review:false, work:false};
	assert.deepEqual(transition(facts),{action:"wait",admission:"closed",reason:"missing-evidence"});
});

test("an owner changes staffing live without cancelling workers or exceeding the committed ceiling", async t => {
	const run = "capacity", source = ".foundry/capacity.json", ids = ["one","two","three","four"];
	const f = factory(t, run, source, { [source]: JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Publish four folders.",
		limits:{workers:2},productCheck:"check.mjs",seed:ids,
		grains:ids.map(id => ({id,directory:id,specification:"spec",boundary:["api"],check:"check.mjs"}))}), spec:"Build it.",api:"Use the contract.","check.mjs":"" });
	await f.start();
	const [a,b] = f.workers.values(); assert.equal(f.workers.size,2);
	await f.owner.operation("configure", {run, revision:0, workers:1}, "owner");
	await assert.rejects(f.owner.operation("configure", {run,revision:0,workers:2}, "owner"), /revision/i);
	await assert.rejects(f.owner.operation("configure", {run,revision:1,workers:3}, "owner"), /ceiling/i);
	await assert.rejects(f.owner.operation("configure", {run,revision:1,workers:2}, a.id), /owner/);
	put(a.cwd,"one/value","ok");
	await f.runtime(a.cwd).operation("submit", {run,token:a.token},a.id);
	assert.equal(f.workers.size,2);
	const fresh = f.runtime(f.root);
	const updated = await fresh.operation("configure", {run,revision:1,workers:null}, "owner");
	assert.equal(updated.limit,2); assert.equal(f.workers.size,3);
	assert.equal(updated.nodes.find(n=>n.worker===b.id)?.state,"writing");
	assert.deepEqual(f.checks.length,1);
});

test("a lost shell completion wakes the owner from a real receipt, never by reissuing the pending check", async t => {
	const run = "receipt", source = ".foundry/receipt.json";
	const f = factory(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Accept only the checked tree.",
		goalCheck:"goal.mjs",productCheck:"product.mjs",grains:[{id:"item",directory:"item",specification:"spec",boundary:["api"],check:"product.mjs"}],
		squads:[{id:"builders",charter:"spec",grains:["item"]}]}),"spec":"Build it.","api":"Contract.","goal.mjs":"","product.mjs":""});
	/** @type {(()=>void)|undefined} */ let tick;
	/** @type {(()=>Promise<unknown>)|undefined} */ let finish;
	let issues = 0;
	const owner = f.runtime(f.root, {watchReceipts: fn => {tick=fn; return () => {tick=undefined;};}, execute:async (tool,args,id) => {
		if (tool==="bash" && String(args.description).includes("final goal")) {
			issues++; finish=()=>f.execute(tool,args,id); return {resultType:"unconfirmed"};
		}
		return f.execute(tool,args,id);
	}});
	await f.start(owner);
	assert.ok(tick, "issued goal must have a receipt wake");
	assert.ok(finish); tick(); await owner.flush();
	assert.equal(issues,1); assert.equal((await f.status()).qualified,null);
	await finish(); // Runner commits the receipt, but the shell completion notification is lost.
	tick(); await owner.flush();
	assert.equal((await f.status()).qualified,f.tip);
	assert.equal(issues,1); assert.equal(f.checks.length,2);
});

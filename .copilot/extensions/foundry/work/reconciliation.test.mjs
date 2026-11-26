import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { factory, git, put } from "../test/fixture.mjs";
import { compose, transition } from "./machine.mjs";
import { openDatabase } from "./database.mjs";
import { reconciliation, reconcileWake } from "./reconciliation.mjs";
import { createRuntime } from "./runtime.mjs";

/** @param {string} value @param {string} type @param {Record<string,boolean>} [facts] */
const step=(value,type,facts)=>transition(reconciliation,{value,context:null},{type},facts,true);
/** @param {ReturnType<typeof step>} result */
const effects=result=>result.effects.map(e=>e.type);

test("only the unexpired recording issuer rechecks its hold; continuation needs active original work",()=>{
	assert.deepEqual(effects(step("idle","wake",{executable:false})),["retain-wake"]);
	for(const ownHold of [true,false]) for(const expired of [true,false]) for(const active of [true,false]) {
		const result=step("inspecting","inspected",{ownHold,expired,active,continuations:true});
		if(ownHold && !expired) assert.deepEqual(effects(result),["sample-policy"]);
		else if(active && !expired) assert.deepEqual(effects(result),["continue-workflows"]);
		else {assert.deepEqual(effects(result),[]);assert.deepEqual(result.fork,["history","dispatch"]);}
	}
	assert.deepEqual(effects(step("held","policy",{permitted:true})),["clear-hold"]);
	assert.deepEqual(effects(step("held","policy",{permitted:false})),[]);
});

test("a missing target, pause or deadline cannot staff work; only a final handoff survives inactivity",()=>{
	for(const active of [true,false]) for(const expired of [true,false]) for(const missingTarget of [true,false]) {
		const facts={active,expired,missingTarget,handoff:false,owner:true,question:true};
		const offered=effects(step("offering","work",facts));
		assert.deepEqual(offered,active && !expired && !missingTarget ? ["offer-question"] : []);
	}
	assert.deepEqual(effects(step("offering","work",{active:false,expired:true,missingTarget:false,handoff:true,owner:true,question:true})),["offer-batch"]);
	assert.deepEqual(effects(step("reservations","batch",{hasBatch:false})),[]);
	assert.deepEqual(effects(step("planning","planned",{closed:false,missingTarget:false,owner:true,active:true,expired:false,renewalDue:true})),["sample-policy"]);
	assert.deepEqual(effects(step("renewal","policy",{closed:false,permitted:false})),["watch-held-renewal"]);
	assert.deepEqual(effects(step("renewal","policy",{closed:false,permitted:true})),["renew"]);
	assert.deepEqual(effects(step("enabling","authorized",{checkOnly:false,pooled:false,ready:false})),["refill"]);
	assert.deepEqual(effects(step("recording","recorded",{permitted:false})),[]);
	assert.deepEqual(effects(step("enabling","authorized",{checkOnly:true})),[]);
	assert.deepEqual(effects(step("native","attempt",{claimed:false,pinnedCheck:true})),[]);
});

test("inspecting every fork reports its independent signals; restoring the target never replays them",()=>{
	const branches=[
		step("inspecting","inspected",{ownHold:false,active:false}),
		step("held","policy",{permitted:false}),
		step("recovering","recovered"),
		step("enabling","authorized",{checkOnly:false,pooled:false,ready:true}),
	];
	const model=compose(reconciliation);
	for(const accepted of branches){
		const target=accepted.snapshot.value;
		assert.deepEqual(accepted.fork,target==="lanes"?["history","dispatch"]:["scouts","writers","calls"]);
		const restored=model.actor({reconciliation:target});
		assert.deepEqual(restored.send("wake"),[],"hydration is not an issuer wake");
		assert.deepEqual(restored.snapshot(),{reconciliation:target});
		const ignored=transition(reconciliation,accepted.snapshot,{type:"restored"});
		assert.equal(ignored.snapshot,accepted.snapshot);assert.deepEqual(ignored.effects,[]);assert.deepEqual(ignored.fork,[]);
	}
});

test("each fork lane needs its own evidence; a permitted sibling cannot bypass a stop or capacity hold",()=>{
	for(const closed of [true,false]) for(const recoverCalls of [true,false]){
		assert.deepEqual(effects(step("lanes","history",{closed,recoverCalls})),!closed && recoverCalls ? ["read-originals"] : []);
		assert.deepEqual(effects(step("lanes","dispatch",{closed})),closed ? [] : ["plan"]);
	}
	for(const jobs of [true,false]) for(const capacityWait of [true,false]) for(const pool of [true,false]){
		assert.deepEqual(effects(step("dispatching","scouts",{jobs,capacityWait})),jobs && !capacityWait ? ["launch-scouts"] : []);
		assert.deepEqual(effects(step("dispatching","writers",{jobs,pool})),!jobs ? [] : pool ? ["match-writers"] : ["send-writers"]);
		assert.deepEqual(effects(step("dispatching","calls",{jobs})),jobs ? ["send-calls"] : []);
	}
	for(const executable of [true,false]) for(const scope of ["run","session","clear"]) for(const hadHolds of [true,false]){
		const result=step("permission","sampled",{executable,managed:scope==="run",blocked:scope!=="clear",hadHolds});
		assert.deepEqual(effects(result),[!executable ? "decline-mode" : scope==="run" ? "hold-run" :
			scope==="session" ? "hold-issuer" : hadHolds ? "release-batch" : "enable"]);
	}
});

function latch(){
	let open=()=>{};
	const wait=new Promise(resolve=>{open=()=>resolve(undefined);});
	return {wait,open};
}

test("declared lanes dispatch from one observation while native history and writer matching are both pending",async()=>{
	const history=latch(), matching=latch(), events=/** @type {string[]} */([]);
	/** @type {Parameters<typeof reconcileWake>[0]} */ const handlers={};
	for(const edges of Object.values(reconciliation.states)) for(const e of edges) if("action" in e)
		handlers[e.action]=()=>assert.fail(`Unexpected effect ${e.action}`);
	/** @type {Parameters<typeof reconcileWake>[0]} */
	const inspected={
		"inspect-issuer":next=>next("inspected",{ownHold:false,active:true,expired:false,continuations:false}),
		"read-originals":async next=>{events.push("history");await history.wait;await next("completion",{terminal:false});await next("drained");},
		plan:next=>next("planned",{closed:false,missingTarget:false,owner:false}),
		"watch-plan":next=>next("work",{missingTarget:false,active:true,expired:false,owner:false,question:false}),
		"offer-batch":next=>next("batch",{hasBatch:true}),
		"sample-batch":next=>next("sampled",{executable:true,managed:false,blocked:false,hadHolds:false}),
		enable:next=>next("authorized",{checkOnly:false,pooled:false,ready:true}),
		"group-batch":()=>{events.push("partition");},
		"launch-scouts":()=>{events.push("scouts");},
		"match-writers":async next=>{events.push("matching");await matching.wait;await next("matched",{closed:false});},
		"sample-writer-batch":next=>{events.push("recheck");return next("sampled",{executable:false});},
		"decline-mode":()=>{},
		"send-calls":next=>{events.push("direct");return next("attempt",{claimed:true});},
		refill:()=>{events.push("refill");},
	};
	/** @type {Parameters<typeof reconcileWake>[2]} */
	const inputs={history:()=>({closed:false,recoverCalls:true}),dispatch:()=>({closed:false}),
		scouts:()=>({jobs:true,capacityWait:false}),writers:()=>({jobs:true,pool:true}),calls:()=>({jobs:true})};
	const task=reconcileWake({...handlers,...inspected},{type:"wake",executable:true},inputs);
	try{
		await turn();
		assert.deepEqual(events,["history","partition","scouts","matching","direct","refill"]);
		matching.open();await turn();assert.equal(events.at(-1),"recheck");
	}finally{history.open();matching.open();await task;}
});

test("a synchronous failure in one fork lane does not abandon a sibling's later rejection",async()=>{
	const history=latch(), finished=latch(), planError=Error("plan failed"), seen=/** @type {string[]} */([]);
	/** @type {Parameters<typeof reconcileWake>[0]} */ const handlers={};
	for(const edges of Object.values(reconciliation.states))for(const e of edges)if("action" in e)
		handlers[e.action]=()=>assert.fail(`Unexpected effect ${e.action}`);
	handlers["inspect-issuer"]=next=>next("inspected",{ownHold:false,active:true,expired:false,continuations:false});
	handlers["read-originals"]=async()=>{seen.push("history");await history.wait;finished.open();throw Error("late history failure");};
	handlers.plan=()=>{seen.push("plan");throw planError;};
	const started=Promise.resolve().then(()=>reconcileWake(handlers,{type:"wake",executable:true},
		{history:()=>({closed:false,recoverCalls:true}),dispatch:()=>({closed:false})}));
	try{
		await assert.rejects(started,e=>e===planError);assert.deepEqual(seen,["history","plan"]);
	}finally{history.open();}
	await finished.wait;await turn(); // node:test fails the case if a sibling rejection escapes the fork.
});

const run="dispatch", source=".foundry/dispatch.json";
/** @type {typeof factory} */
const build=process.env.FOUNDRY_PRIOR_FIXTURE ? (await import(process.env.FOUNDRY_PRIOR_FIXTURE)).factory : factory;
/** @param {import("node:test").TestContext} t @param {string[]} seed */
function trial(t,seed) {
	const grains=seed.map(id=>({id,directory:id,check:`${id}.mjs`,specification:"spec",boundary:["api"]}));
	return build(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Publish the original values.",seed,grains,productCheck:"product.mjs"}),
		spec:"Produce the requested value.",api:"Keep the requested value.",
		...Object.fromEntries(seed.map(id=>[`${id}.mjs`,`import {readFileSync as read} from "node:fs";if(read("${id}/value","utf8")!=="${id}")process.exit(1);`])),
		"product.mjs":""});
}

test("a pause supersedes an in-flight managed-policy sample; explicit resume uses the original reservation",async t=>{
	const f=trial(t,["first"]), permit=latch();
	let probes=0,reads=0,creates=0;
	const prior=f.runtime(f.root,{permissionBlocker:async()=>probes++ ? {scope:"run",message:"Managed settings pending."} : null});
	await f.start(prior);prior.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run)?.effects.find(e=>e.kind==="writer");assert.ok(original && !original.callId);
	assert.equal(db.read(run)?.policyHold?.effect,original.id);
	const issuer=f.runtime(f.root,{permissionBlocker:async()=>{reads++;await permit.wait;return null;},
		execute:async(tool,...args)=>{if(tool==="create_session")creates++;return f.execute(tool,...args);}},createRuntime);
	issuer.turn("owner");
	try{
		await turn();assert.equal(reads,1);
		await issuer.operation("pause",{run},"owner");
		issuer.turn("owner");await turn();
	}finally{permit.open();await issuer.flush();}
	assert.equal(db.read(run)?.active,false);assert.equal(db.read(run)?.policyHold,undefined);
	assert.equal(creates,0);assert.deepEqual(db.read(run)?.effects.find(e=>e.id===original.id),original);
	await issuer.operation("resume",{source},"owner");
	const [w]=f.workers.values();assert.equal(db.read(run)?.effects.find(e=>e.id===original.id)?.nativeId,w.id);
	assert.equal(w.token,original.token);assert.equal(creates,1);
	put(w.cwd,"first/value","first");await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
	assert.ok(issuer.inspect({run},"owner").qualified);
});

test("reloaded issuer binds a lost reply once while an unissued sibling proceeds and keeps its signed receipt",async t=>{
	const f=trial(t,["first","second"]), history=latch();
	let creates=0,reads=0;
	/** @type {unknown} */ let response;
	const prior=f.runtime(f.root,{execute:async(tool,args,key)=>{
		assert.equal(tool,"create_session");creates++;
		// Pause after the first native session exists, before the next sibling can claim.
		const sent=f.execute(tool,args,key), paused=f.owner.operation("pause",{run},"owner");
		response=await sent;await paused;throw Error("Lost original creation response");
	}});
	await f.start(prior);prior.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const saved=db.read(run);assert.ok(saved);
	const [original,sibling]=saved.effects.filter(e=>e.kind==="writer");
	assert.ok(original.callId && original.state==="uncertain" && sibling.state==="ready" && !sibling.callId);
	const [first]=f.workers.values();put(first.cwd,"first/value","first");
	const issuer=f.runtime(f.root,{watchRecovery:()=>()=>{},recover:async e=>{
		reads++;assert.equal(e.issuer,"owner");assert.equal(e.id,original.id);assert.equal(e.callId,original.callId);
		assert.deepEqual(e.args,original.args);await history.wait;return response;
	},execute:async(tool,...args)=>{if(tool==="create_session")creates++;return f.execute(tool,...args);}},createRuntime);
	issuer.sessionStart("owner",f.root);
	// Trace the eligible dispatch on this restored fixture without authorizing the corresponding adapter.
	const inspected=step("enabling","authorized",{checkOnly:false,pooled:false,ready:true});
	assert.deepEqual(inspected.fork,["scouts","writers","calls"]);assert.deepEqual(db.read(run),saved);
	assert.equal(reads,0);assert.equal(creates,1);
	issuer.turn("owner");
	try{
		await turn();assert.equal(reads,1);assert.equal(creates,1,"original history is readable through a pause; new work is not");
		await issuer.operation("resume",{source},"owner");
		const second=f.workers.get("worker-2");assert.ok(second,"the pending original lookup must not block its ready sibling");
		assert.equal(db.read(run)?.effects.find(e=>e.id===sibling.id)?.nativeId,second.id);
		put(second.cwd,"second/value","second");await f.runtime(second.cwd,{},createRuntime).operation("submit",{run,token:second.token},second.id);
		const check=db.read(run)?.effects.find(e=>e.kind==="component" && e.issuer===second.id);
		assert.ok(check?.kind==="component" && check.receipt?.exit===0);
		issuer.turn("owner");issuer.turn("owner");issuer.post(original.callId,response,"another-issuer");await turn();
		assert.equal(db.read(run)?.nodes.first.worker,undefined);assert.equal(reads,1);assert.equal(creates,2);
		history.open();await issuer.flush();
		assert.equal(db.read(run)?.nodes.first.worker,first.id);assert.equal(db.read(run)?.effects.find(e=>e.id===original.id)?.callId,original.callId);
		await f.runtime(first.cwd,{},createRuntime).operation("submit",{run,token:first.token},first.id);
		const after=db.read(run), retained=after?.effects.find(e=>e.id===check.id);
		assert.ok(retained?.kind==="component");db.verifySigned(run,retained);assert.deepEqual(retained.receipt,check.receipt);
		const result=issuer.inspect({run},"owner");assert.ok(result.qualified);assert.equal(git(f.root,"show",`${result.qualified}:first/value`),"first");
		issuer.turn("owner");await issuer.flush();assert.equal(creates,2);assert.equal(reads,1);
	}finally{history.open();await issuer.flush();}
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { factory, git, put, recoveryClock, withLedgerLock } from "../test/fixture.mjs";
import { ledgerPath, openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { supervise } from "./supervision.mjs";
import { contention } from "./wakes.mjs";
import { setImmediate as turn } from "node:timers/promises";
import { EventEmitter, once } from "node:events";

/** @type {typeof factory} */
const build=process.env.FOUNDRY_PRIOR_FIXTURE ? (await import(process.env.FOUNDRY_PRIOR_FIXTURE)).factory : factory;

/** @param {import("node:test").TestContext} t @param {string} route @param {typeof factory} [make] */
async function lockedReply(t,route,make=factory){
	const run="admission", source=".foundry/admission.json", notice=route==="same-session notice";
	const f=make(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Deliver the item.",
		productCheck:"product.mjs",grains:[{id:"item",directory:"item",check:"unit.mjs",specification:"spec",boundary:["api"]}],
		...(notice?{goalCheck:"goal.mjs",squads:[{id:"items",charter:"spec",grains:["item"]}]}:{seed:["item"]})}),
		spec:"Produce the item.",api:"Keep the interface.","unit.mjs":"","product.mjs":"","goal.mjs":""});
	const host=new EventEmitter(), issued=once(host,"issued"), deliver=once(host,"deliver");
	/** @type {unknown} */ let response;
	let sends=0,call="";
	const owner=f.runtime(f.root,{execute:async(tool,args,key)=>{
		if(tool!=="create_session")return f.execute(tool,args,key);
		sends++;call=key;response=await f.execute(tool,args,key);
		if(route==="completion hook")return {resultType:"unconfirmed"};
		host.emit("issued");await deliver;return response;
	},notify:async()=>{if(notice){sends++;host.emit("issued");await deliver;}return "admitted";}});
	const starting=Promise.allSettled([f.start(owner)]);
	if(route==="completion hook")await starting;else await issued;
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run)?.effects.find(e=>e.kind===(notice?"handoff":"writer"));assert.ok(original?.callId);
	await withLedgerLock(f.root,async()=>{
		if(route==="completion hook")owner.post(call,response,"owner");
		else host.emit("deliver");
		await turn();
	});
	const [start]=await starting;await owner.flush();
	return {f,run,owner,original,db,notice,start,sends:()=>sends,response};
}

for(const route of ["automatic binding","completion hook","same-session notice"])test(`lock while recording original ${route} does not lose or reissue the effect`,async t=>{
	const {f,run,owner,original,db,notice,start,sends}=await lockedReply(t,route);
	if(start.status==="rejected")throw start.reason;
	const end=db.read(run)?.effects.find(e=>e.id===original.id);assert.equal(end?.state,"done");
	assert.equal(end.callId,original.callId);assert.equal(sends(),1);
	if(!notice){
		const [w]=f.workers.values();assert.equal(end.nativeId,w.id);
		put(w.cwd,"item/value","original");await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	assert.ok(owner.inspect({run},"owner").qualified);
});

for(const notice of [false,true])test(`upgrade after the old issuer lost a locked ${notice?"local notice":"writer reply"}`,
	{skip:!process.env.FOUNDRY_PRIOR_FIXTURE},async t=>{
	const {f,run,owner,db,sends,response,original}=await lockedReply(t,notice?"same-session notice":"automatic binding",build);
	owner.close();assert.equal(db.read(run)?.effects.find(e=>e.id===original.id)?.state,"issued");
	const clock=recoveryClock(), issuer=f.runtime(f.root,{watchRecovery:clock.watch,
		recover:async e=>{assert.equal(notice,false);assert.equal(e.callId,original.callId);return response;},
		notify:async()=>assert.fail("Do not resend the original notice"),execute:async(tool,...args)=>{
			assert.notEqual(tool,"create_session");return f.execute(tool,...args);}},createRuntime);
	issuer.sessionStart("owner",f.root);await clock.pulse(issuer,12);
	if(notice){
		assert.ok(issuer.inspect({run},"owner").qualified);
		assert.deepEqual(db.read(run)?.effects.find(e=>e.id===original.id),original,"no host history exists for session.send");
	}else{
		const [w]=f.workers.values();assert.equal(db.read(run)?.nodes.item.worker,w.id);
		put(w.cwd,"item/value","original");await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
		assert.ok(issuer.inspect({run},"owner").qualified);
	}
	assert.equal(sends(),1);
});

for (const route of ["clock","startup lock","completion signal","refusal","operator pause"]) test(`the reloaded issuer observes late native evidence without another turn or a duplicate writer / ${route}`,async t=>{
	const id="sample", source=".foundry/sample.json";
	const f=build(t,id,source,{[source]:JSON.stringify({version:1,id,target:"refs/heads/main",direction:"Complete the original item.",seed:["item"],
		productCheck:"product.mjs",grains:[{id:"item",directory:"item",check:"component.mjs",specification:"spec",boundary:["contract"]}]}),
		spec:"Produce the item.",contract:"Keep its value.", "component.mjs":"", "product.mjs":`import {readFileSync} from "node:fs";if(readFileSync("item/value","utf8")!=="original")process.exit(1);`});
	let creates=0, reads=0, visible=false;
	/** @type {unknown} */ let response;
	const first=f.runtime(f.root,{execute:async(tool,args,call)=>{
		if(tool!=="create_session") return f.execute(tool,args,call);
		creates++; response=route==="refusal" ? {resultType:"denied"} : await f.execute(tool,args,call);return {resultType:"unconfirmed"};
	}});
	await f.start(first);first.close();
	const held=(await f.status()).pending.find(e=>e.state==="uncertain");assert.ok(held);
	/** @type {Set<()=>void>} */ const ticks=new Set();
	let originalCall="";
	const next=f.runtime(f.root,{watchRecovery:f=>{ticks.add(f);return ()=>{ticks.delete(f);};},
		recover:async e=>{assert.equal(e.id,held.id);assert.ok(e.callId);originalCall=e.callId;reads++;if(!visible) throw Error("Completion not visible yet");return response;},
		execute:async(tool,...args)=>{if(tool==="create_session")creates++;return f.execute(tool,...args);}
	},createRuntime);
	if(route==="startup lock"){
		const lock=new DatabaseSync(ledgerPath(f.root));
		try{lock.exec("BEGIN IMMEDIATE");next.sessionStart("owner",f.root);}
		finally{lock.close();}
	}else next.sessionStart("owner",f.root);
	const tick=async()=>{for(const fire of [...ticks]) fire();await next.flush();};
	for(let i=0;i<12;i++)await tick();
	assert.ok(reads,"the issuer must find the original pending call after the ledger becomes readable");
	assert.equal((await f.status()).nodes[0].worker,undefined);
	if(route==="operator pause") await f.owner.operation("pause",{run:id},"owner");
	visible=true; // Only the host's original completion became readable; no turn, ledger write or new request.
	if(route==="completion signal") {
		const count=reads;
		next.completion(originalCall,"other-issuer");next.completion("unrelated","owner");await next.flush();assert.equal(reads,count);
		next.completion(originalCall,"owner");await next.flush();
	} else for(let i=0;i<12;i++)await tick();
	assert.equal(creates,1);
	if(route==="operator pause"){assert.equal(next.inspect({run:id},"owner").active,false);assert.deepEqual(f.checks,[]);return;}
	if(route==="refusal"){const s=next.inspect({run:id},"owner");assert.match(s.nodes[0].reason??"",/permission refused/i);assert.equal(f.workers.size,0);return;}
	const [w]=f.workers.values();assert.equal(next.inspect({run:id},"owner").nodes[0].worker,w.id);
	put(w.cwd,"item/value","original");await f.runtime(w.cwd,{},createRuntime).operation("submit",{run:id,token:w.token},w.id);
	const done=next.inspect({run:id},"owner");assert.ok(done.qualified);assert.equal(git(f.root,"show",`${done.qualified}:item/value`),"original");
	assert.equal(creates,1);
});

for(const outcome of ["disconnect","locked settlement","locked refusal","permanent error","operator pause"])test(`bound scout status observation after transient read failures / ${outcome}`,async t=>{
	const run="review",source=".foundry/review.json",flow="original-scout";
	const f=build(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Deliver the item.",
		grains:[{id:"item",directory:"item",specification:"spec",boundary:["contract"],check:"unit.mjs"}],
		squads:[{id:"items",charter:"spec",grains:["item"]}],productCheck:"product.mjs"}),
		spec:"Provide the requested item.",contract:"Keep the requested value.","unit.mjs":"",
		"product.mjs":`import {readFileSync} from "node:fs";if(readFileSync("item/value","utf8")!=="original")process.exit(1);`});
	let ticket="",starts=0,resumes=0,reads=0,available=false,refused=false;
	const first=f.runtime(f.root,{scout:async(id,key,actor)=>{
		starts++;ticket=key;await first.scoutBatch(id,key,actor,flow);throw Error("Lost terminal reply after binding");
	}});
	await f.start(first);await turn();await first.flush();first.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run)?.effects.find(e=>e.kind==="scout");
	assert.ok(original && original.state==="uncertain" && original.workflowId===flow && original.callId===ticket);
	/** @type {Set<()=>void>} */ const ticks=new Set();
	const disconnected={runId:flow,status:"halted",failure:{type:"workflow_provider_disconnected"}};
	let deliver=()=>{};const terminal=new Promise(resolve=>{deliver=()=>resolve(undefined);});
	const next=f.runtime(f.root,{watchRecovery:fn=>{ticks.add(fn);return ()=>{ticks.delete(fn);};},
		scout:async()=>{starts++;throw Error("Unexpected new scout");},
		scoutState:async id=>{
			assert.equal(id,flow);reads++;
			if(!available || outcome==="permanent error")
				throw Object.assign(Error("Cannot read workflow status"),{code:available?"EACCES":"ETIMEDOUT"});
			await terminal;return refused?{...disconnected,failure:{type:"workflow_resume_declined"}}:disconnected;
		},
		scoutSnapshot:async id=>{assert.equal(id,flow);return disconnected;},
		resumeScout:async id=>{
			assert.equal(id,flow);resumes++;
			const [job]=await next.scoutBatch(run,ticket,"owner",id);assert.equal(job.id,original.id);
			await next.scoutResult(run,ticket,"owner",id,job.id,{outcome:"regenerate",reason:"Implement the missing item.",evidence:["spec"],grains:["item"]},job.packet);
			return {runId:id,status:"completed"};
		}
	},createRuntime);
	async function sample(n=16){for(let i=0;i<n;i++){for(const tick of [...ticks])tick();await next.flush();await turn();await next.flush();}}
	next.sessionStart("owner",f.root);await sample();
	assert.ok(reads>0 && reads<16,"back off rather than reading on every tick");
	const afterOutage=db.read(run)?.effects.find(e=>e.id===original.id);
	assert.equal(resumes,0);assert.equal(f.workers.size,0);
	const before=reads;available=true;await sample();
	assert.equal(starts,1);assert.equal(db.read(run)?.effects.find(e=>e.id===original.id)?.callId,ticket);
	assert.ok(reads>before,"the issuer must reread the bound workflow without a turn or a changed ledger");
	assert.deepEqual(afterOutage,original,"a status timeout is not new evidence about the review");
	if(outcome==="permanent error"){
		const stopped=reads;await sample();assert.equal(reads,stopped);assert.equal(resumes,0);assert.equal(f.workers.size,0);return;
	}
	assert.equal(reads,before+1,"duplicate ticks must share an outstanding status read");
	assert.equal(resumes,0,"a reattached read is not a verified halt");
	if(outcome==="operator pause")await f.owner.operation("pause",{run},"owner");
	if(outcome==="locked settlement" || outcome==="locked refusal")await withLedgerLock(f.root,async()=>{deliver();await turn();refused=outcome==="locked refusal";});
	else {deliver();await turn();}
	await sample();
	if(outcome==="operator pause"){assert.equal(resumes,0);assert.equal(db.read(run)?.active,false);assert.equal(f.workers.size,0);return;}
	if(refused){
		const saved=db.read(run)?.effects.find(e=>e.id===original.id);assert.equal(saved?.state,"blocked");
		assert.match(saved?.error??"",/workflow_resume_declined/);assert.equal(resumes,0);assert.equal(f.workers.size,0);return;
	}
	assert.equal(resumes,1);assert.equal(f.workers.size,1);
	const [w]=f.workers.values();assert.equal(next.inspect({run},"owner").nodes[0].worker,w.id);
	put(w.cwd,"item/value","original");await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
	const done=next.inspect({run},"owner");assert.ok(done.qualified);assert.equal(git(f.root,"show",`${done.qualified}:item/value`),"original");
});

for(const fault of ["locked reconciliation","mode reset"])test(`an eligible reservation survives a ${fault} with no new turn`,async t=>{
	const run="wake",source=".foundry/wake.json",program=`import {readFileSync} from "node:fs";if(readFileSync("item/value","utf8")!=="original")process.exit(1);`;
	const f=build(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Deliver the item.",seed:["item"],
		productCheck:"product.mjs",grains:[{id:"item",directory:"item",check:"unit.mjs",specification:"spec",boundary:["contract"]}]}),
		spec:"Provide the item.",contract:"Keep the requested value.","unit.mjs":"","product.mjs":program});
	let mode="interactive",preflight=false;
	const first=f.runtime(f.root,{mode:async()=>mode,permissionBlocker:async()=>{
		if(!preflight){preflight=true;return null;}
		if(fault==="mode reset")return {scope:"session",message:"Manual approvals"};
		mode="plan";return null;
	}});
	await f.start(first);first.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run)?.effects.find(e=>e.kind==="writer");assert.ok(original?.state==="ready" && !original.callId);
	const clock=recoveryClock();let fail=true,starts=0;
	const next=f.runtime(f.root,{watchRecovery:clock.watch,mode:async()=>{
		if(fail && fault==="mode reset")throw Object.assign(Error("Mode connection reset"),{code:"ECONNRESET"});
		return "interactive";
	},execute:async(tool,args,key)=>{if(tool==="create_session")starts++;return f.execute(tool,args,key);}},createRuntime);
	next.sessionStart("owner",f.root);
	if(fault==="locked reconciliation")await withLedgerLock(f.root,()=>clock.pulse(next));
	else await clock.pulse(next,4);
	assert.equal(starts,0);fail=false;
	await clock.pulse(next,16);
	assert.equal(starts,1,"original ready writer must be claimed without another ledger change or turn");
	const [w]=f.workers.values();assert.equal(db.read(run)?.effects.find(e=>e.id===original.id)?.nativeId,w.id);
	put(w.cwd,"item/value","original");await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
	const done=next.inspect({run},"owner");assert.ok(done.qualified);assert.equal(git(f.root,"show",`${done.qualified}:item/value`),"original");
});

test("pending history is observed while a sibling permission sample is still outstanding",async()=>{
	let tick=()=>{},release=()=>{},reads=0,dispatch=0,permitted=0;
	const policy=new Promise(resolve=>{release=()=>resolve(undefined);});
	const watch=supervise({clock:cb=>{tick=cb;return ()=>{};},track:p=>{void p.catch(assert.fail);},stamp:()=>"same",tip:()=>"main",
		sample:()=>({state:"issuer-permission",ref:"main",pending:true}),permitted:async()=>{permitted++;await policy;return false;},
		lookup:async()=>{reads++;},wake:async()=>{dispatch++;return true;},retryRead:contention,log:e=>assert.fail(String(e))});
	try{
		watch.observe("run","owner",{state:"issuer-permission",ref:"main",pending:true},true);
		tick();await turn();assert.equal(permitted,1);assert.equal(reads,1);
		tick();await turn();assert.equal(permitted,1,"at most one permission sample");assert.equal(reads,2,"history must not share the policy wait");
	}finally{release();await turn();watch.close();}
	assert.equal(dispatch,0);
});

test("duplicate startup hooks share a backed-off scan; corruption and close end the retry",()=>{
	/** @type {Set<()=>void>} */ const clocks=new Set();
	/** @type {Error[]} */ const logged=[];
	const unexpected=()=>assert.fail("Registration must not dispatch or observe a run");
	const watch=supervise({clock:fn=>{clocks.add(fn);return ()=>{clocks.delete(fn);};},track:unexpected,sample:unexpected,stamp:unexpected,
		permitted:unexpected,tip:unexpected,wake:unexpected,lookup:unexpected,retryRead:contention,log:e=>{assert.ok(e instanceof Error);logged.push(e);}});
	const busy=Object.assign(Error("busy"),{code:"ERR_SQLITE_ERROR",errcode:5}),corrupt=Object.assign(Error("corrupt"),{code:"ERR_SQLITE_ERROR",errcode:11});
	let error=busy,reads=0;
	const scan=()=>{reads++;throw error;};
	watch.register("issuer",scan);watch.register("issuer",scan);
	assert.equal(reads,1);assert.equal(clocks.size,1);
	const [tick]=clocks;for(let i=0;i<8;i++)tick();
	assert.ok(reads>1 && reads<8);error=corrupt;
	for(let i=0;i<8;i++)tick();assert.equal(clocks.size,0);assert.deepEqual(logged,[busy,corrupt]);
	error=busy;watch.register("issuer",scan);const [queued]=clocks;watch.close();
	const before=reads;tick();queued();assert.equal(reads,before);assert.equal(clocks.size,0);
});

test("a slow original-call observation cannot mask another region's target or permission signal",async()=>{
	let tick=()=>{}, release=()=>{}, stamp="a", wakes=0, observing=false;
	const wait=new Promise(resolve=>{release=()=>resolve(undefined);});
	/** @type {Set<Promise<void>>} */ const pending=new Set();
	const watch=supervise({clock:fn=>{tick=fn;return ()=>{};},track:p=>{pending.add(p);p.finally(()=>pending.delete(p));},
		sample:()=>({state:"ledger",ref:"main",pending:true}),stamp:()=>stamp,tip:()=>stamp,permitted:async()=>true,
		lookup:async()=>{observing=true;await wait;},wake:async()=>{wakes++;return true;},retryRead:()=>false,log:e=>assert.fail(String(e))});
	try {
		watch.observe("job","issuer",{state:"ledger",ref:"main",pending:true},true);
		tick();await turn();assert.equal(observing,true);assert.equal(wakes,1);
		stamp="b";tick();await turn();assert.equal(wakes,2);
	} finally {release();await Promise.all(pending);watch.close();}
});

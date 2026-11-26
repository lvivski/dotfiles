import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { factory, git, put, recoveryClock, withLedgerLock } from "../test/fixture.mjs";
import { openDatabase } from "./database.mjs";

const run="inspected",source=".foundry/inspected.json";
/** @param {import("node:test").TestContext} t @param {string} [deadline] */
async function trial(t,deadline) {
	const f=factory(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Publish the approved value.",
		...(deadline && {limits:{deadline}}),seed:["item"],grains:[{id:"item",directory:"item",check:"unit.mjs",specification:"spec",boundary:["api"]}],productCheck:"product.mjs"}),
		spec:"Provide the value.",api:"Keep the requested value.","unit.mjs":"",
		"product.mjs":`import {readFileSync as read} from "node:fs";if(read("item/value","utf8")!=="review me")process.exit(1);`});
	await f.start();const [w]=f.workers.values();put(w.cwd,"item/value","review me");
	const db=openDatabase(f.root);t.after(()=>db.close());
	return {f,w,db};
}

test("a copied component pass cannot supply a review packet without the signed original",async t=>{
	const {f,w,db}=await trial(t),workflow="original-signed-review";
	let launches=0,finish=()=>{};
	const observed=new Promise(resolve=>{finish=()=>resolve(undefined);});
	const issuer=f.runtime(w.cwd,{startInspection:async()=>{launches++;return {runId:workflow,status:"running"};},
		inspectionState:async id=>{await observed;const [i]=db.read(run)?.inspections??[];assert.ok(i);
			return {runId:id,status:"completed",result:{inspection:i.id,component:i.component,candidate:i.candidate,outcome:"approved",summary:"Signed candidate reviewed."}};}});
	await issuer.operation("submit",{run,token:w.token},w.id);await turn();await issuer.flush();
	const [i]=db.read(run)?.inspections??[];assert.ok(i?.dispatch && i.workflow===workflow);
	const ticket=i.dispatch,packet=()=>issuer.inspectionPacket(run,i.id,ticket,w.id,workflow);
	const journal=new DatabaseSync(`${db.file}.outcomes`);t.after(()=>journal.close());
	const original=journal.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?").get(run,i.component);assert.ok(original);
	assert.equal(journal.prepare("DELETE FROM outcomes WHERE run=? AND effect=?").run(run,i.component).changes,1);
	assert.equal(db.read(run)?.effects.find(e=>e.id===i.component)?.receipt?.exit,0);
	await assert.rejects(packet(),{code:"missing_receipt"});
	assert.equal(db.read(run)?.nodes.item.state,"reviewing");
	journal.prepare("INSERT INTO outcomes(run,effect,signature,document) VALUES(?,?,?,?)").run(run,i.component,original.signature,original.document);
	assert.equal((await packet()).candidate,i.candidate);finish();await turn();await issuer.flush();
	assert.equal(db.read(run)?.products.length,1);assert.equal(db.read(run)?.inspections?.[0].dispatch,ticket);assert.equal(launches,1);
});

test("reload observes the admitted Rubber Duck even without a start reply; policy gates publication, not evidence",async t=>{
	const {f,w,db}=await trial(t), clock=recoveryClock(), workflow="original-duck";
	let launches=0,reads=0,mode="interactive",held=false,packetSeen=false,release=()=>{};
	const result=new Promise(resolve=>{release=()=>resolve(undefined);});
	const original=f.runtime(w.cwd,{startInspection:async(id,job,ticket,actor)=>{
		launches++;const packet=await original.inspectionPacket(id,job,ticket,actor,workflow);
		packetSeen=packet.inspection===job && packet.prompt.includes("item/value");
		return new Promise(()=>{}); // The admitted body bound before the SDK start reply was lost.
	},inspectionState:()=>new Promise(()=>{})});
	await original.operation("submit",{run,token:w.token},w.id);
	await turn();await original.flush();original.close();
	const saved=db.read(run), [review]=saved?.inspections ?? [];
	assert.ok(review?.dispatch && review.workflow===workflow && review.state==="issued");
	assert.equal(packetSeen,true);assert.equal(launches,1);assert.equal(saved?.nodes.item.state,"reviewing");assert.equal(saved.products.length,0);
	/** @type {string[]} */ const log=[];
	const issuer=f.runtime(w.cwd,{mode:async()=>mode,watchRecovery:clock.watch,log:message=>log.push(message),
		permissionBlocker:async()=>held ? {scope:"session",message:"Manual approvals."} : null,
		startInspection:async()=>assert.fail("Do not start a replacement inspection"),
		inspectionState:async id=>{assert.equal(id,workflow);reads++;await result;return {runId:id,status:"completed",result:{
			inspection:review.id,component:review.component,candidate:review.candidate,outcome:"approved",summary:"The scoped value is correct."}};}});
	issuer.sessionStart(w.id,w.cwd);await clock.pulse(issuer,8);
	assert.equal(reads,1);assert.deepEqual(db.read(run)?.inspections?.[0],review);
	mode="plan";
	await withLedgerLock(f.root,async()=>{release();await turn();});
	await turn();await issuer.flush();
	assert.equal(db.read(run)?.inspections?.[0].state,"approved");assert.equal(db.read(run)?.products.length,0);
	mode="interactive";held=true;
	await clock.pulse(issuer,12);
	assert.equal(db.read(run)?.nodes.item.state,"reviewing");assert.equal(db.read(run)?.products.length,0);
	held=false;await clock.pulse(issuer,12);
	const after=db.read(run), final=after?.products.at(-1);
	assert.ok(final,JSON.stringify({node:after?.nodes.item.state,review:after?.inspections?.[0],log}));assert.equal(git(f.root,"show",`${final.commit}:item/value`),"review me");
	assert.equal(after?.inspections?.[0].dispatch,review.dispatch);assert.equal(reads,1);assert.equal(launches,1);
});

test("start and foreign results are not verdicts; only a terminal original can be retried on owner resume",async t=>{
	const {f,w,db}=await trial(t), clock=recoveryClock(), workflow="duck-one";
	let launches=0,terminal=false;
	const writer=f.runtime(w.cwd,{watchRecovery:clock.watch,
		startInspection:async(id,job,ticket,actor)=>{
			launches++;const {prompt,...pins}=await writer.inspectionPacket(id,job,ticket,actor,workflow);
			assert.ok(prompt);return {runId:workflow,status:"completed",result:{...pins,outcome:"approved",summary:"Not a status receipt."}};
		},inspectionState:async id=>{
			const [i]=db.read(run)?.inspections??[];assert.ok(i);
			return {runId:terminal ? id : "other-workflow",status:"completed",result:{inspection:i.id,component:i.component,
				candidate:terminal ? "other-candidate" : i.candidate,outcome:"approved",summary:"Not the original reviewed subject."}};
		}});
	await writer.operation("submit",{run,token:w.token},w.id);await turn();await writer.flush();
	const [issued]=db.read(run)?.inspections??[];assert.ok(issued?.dispatch && issued.workflow===workflow && issued.state==="issued");
	assert.equal(db.read(run)?.nodes.item.state,"reviewing");
	for (const [ticket,actor,flow] of [[issued.dispatch,"other-issuer",workflow],["other-ticket",w.id,workflow],[issued.dispatch,w.id,"other-flow"]])
		await assert.rejects(writer.inspectionPacket(run,issued.id,ticket,actor,flow));
	await f.owner.operation("resume",{source},"owner");assert.equal(db.read(run)?.inspections?.[0].dispatch,issued.dispatch);
	terminal=true;await clock.pulse(writer,8);
	const unavailable=db.read(run)?.inspections?.[0];assert.equal(unavailable?.state,"unavailable");
	assert.match(unavailable.summary??"",/exact inspection/i);assert.equal(db.read(run)?.products.length,0);
	writer.turn(w.id);await writer.flush();assert.equal(launches,1);writer.close();
	/** @type {string[]} */ const log=[];
	const next=f.runtime(f.root,{log:message=>log.push(message),startInspection:async(id,job,ticket,actor)=>{
		launches++;assert.equal(actor,"owner");assert.equal(job,issued.id);assert.notEqual(ticket,issued.dispatch);
		await assert.rejects(next.inspectionPacket(id,job,ticket,actor,workflow),{code:"wrong_workflow"});
		await next.inspectionPacket(id,job,ticket,actor,"duck-two");return {runId:"duck-two",status:"running"};
	},inspectionState:async id=>({runId:id,status:"completed",result:{inspection:issued.id,component:issued.component,candidate:issued.candidate,
		outcome:"approved",summary:"The original value is preserved."}})});
	await next.operation("resume",{source},"owner");await turn();await next.flush();
	const end=db.read(run),review=end?.inspections?.[0];assert.equal(review?.workflow,"duck-two");assert.equal(review.state,"approved");
	assert.equal(review.previous?.[0].issuer,w.id);assert.equal(review.previous?.[0].workflow,workflow);assert.equal(review.previous?.[0].dispatch,issued.dispatch);
	assert.equal(review.previous?.[0].summary,unavailable.summary);assert.equal(end?.products.length,1,JSON.stringify({log,node:end?.nodes.item.state,join:end?.join}));assert.equal(launches,2);
	await next.operation("resume",{source},"owner");assert.equal(launches,2);
});

test("an ambiguous unbound start survives pause, resume, duplicate submission and reload without a second launch",async t=>{
	const {f,w,db}=await trial(t), clock=recoveryClock();let launches=0;
	const writer=f.runtime(w.cwd,{startInspection:async()=>{launches++;throw Error("Lost native admission response");},
		inspectionState:async()=>assert.fail("There is no bound native ID to read")});
	await writer.operation("submit",{run,token:w.token},w.id);await turn();await writer.flush();writer.close();
	const state=db.read(run),[original]=state?.inspections??[];assert.ok(original?.state==="issued" && original.dispatch && !original.workflow);
	const component=state?.effects.find(e=>e.id===original.component);assert.ok(component?.kind==="component");db.verifySigned(run,component);
	await f.owner.operation("pause",{run},"owner");
	const restored=f.runtime(w.cwd,{watchRecovery:clock.watch,startInspection:async()=>assert.fail("An uncertain dispatch cannot be reissued")});
	restored.sessionStart(w.id,w.cwd);await f.owner.operation("resume",{source},"owner");await clock.pulse(restored,10);
	await restored.operation("submit",{run,token:w.token},w.id);await f.owner.operation("resume",{source},"owner");
	const end=db.read(run);assert.deepEqual(end?.inspections,[original]);assert.equal(end?.nodes.item.state,"reviewing");
	assert.equal(end?.products.length,0);assert.deepEqual(end?.effects.find(e=>e.id===component.id),component);assert.equal(launches,1);
});

test("a reloaded inspection issuer waits for its managed hold; operator pause cannot be cleared by a policy wake",async t=>{
	const {f,w,db}=await trial(t), clock=recoveryClock();
	/** @type {import("./model.js").Inspection|undefined} */ let subject;
	let held=true,starts=0;
	const issuer=f.runtime(w.cwd,{watchRecovery:clock.watch,
		permissionBlocker:async()=>held && db.read(run)?.inspections?.some(i=>i.state==="ready") ? {scope:"run",message:"Managed controls unresolved."} : null,
		startInspection:async()=>assert.fail("The inspection is held")});
	await issuer.operation("submit",{run,token:w.token},w.id);issuer.close();
	const stopped=db.read(run),[original]=stopped?.inspections??[];
	assert.ok(original?.state==="ready" && !original.dispatch && original.permissionHold);assert.equal(stopped?.policyHold?.effect,original.id);
	const restored=f.runtime(w.cwd,{watchRecovery:clock.watch,permissionBlocker:async()=>held ? {scope:"run",message:"Managed controls unresolved."} : null,
		startInspection:async(id,job,ticket,actor)=>{starts++;subject=db.read(id)?.inspections?.find(i=>i.id===job);
			await restored.inspectionPacket(id,job,ticket,actor,"permitted-duck");return {runId:"permitted-duck",status:"running"};},
		inspectionState:async id=>({runId:id,status:"completed",result:{inspection:subject?.id,component:subject?.component,candidate:subject?.candidate,
			outcome:"approved",summary:"The value remains correct."}})});
	restored.sessionStart(w.id,w.cwd);await clock.pulse(restored,6);assert.equal(starts,0);
	await f.owner.operation("pause",{run},"owner");held=false;await clock.pulse(restored,10);
	assert.equal(db.read(run)?.active,false);assert.equal(starts,0);
	await f.owner.operation("resume",{source},"owner");await clock.pulse(restored,10);
	assert.equal(starts,1);assert.equal(db.read(run)?.inspections?.[0].state,"approved");assert.equal(db.read(run)?.products.length,1);
});

test("a paused or halted workflow keeps its ticket and exposes the original native recovery path",async t=>{
	const {f,w,db}=await trial(t), clock=recoveryClock(), workflow="duck-to-continue";
	let launches=0,reads=0,status="halted";
	const issuer=f.runtime(w.cwd,{watchRecovery:clock.watch,
		startInspection:async()=>{launches++;return {runId:workflow,status:"running"};},
		inspectionState:async id=>{
			reads++;const [i]=db.read(run)?.inspections??[];assert.ok(i);
			return {runId:id,status,...(status==="halted" && {failure:{type:"workflow_provider_disconnected"}}),
				...(status==="completed" && {result:{inspection:i.id,component:i.component,candidate:i.candidate,outcome:"approved",summary:"Value is intact."}})};
		}});
	await issuer.operation("submit",{run,token:w.token},w.id);await turn();await issuer.flush();
	const [halted]=db.read(run)?.inspections??[];assert.ok(halted?.dispatch && halted.state==="issued");
	assert.match(halted.summary??"",/workflow_provider_disconnected/);
	for(const detail of [workflow,w.id,"existing limits"])assert.ok(halted.summary?.includes(detail));
	await f.owner.operation("resume",{source},"owner");status="paused";await clock.pulse(issuer,12);
	const paused=db.read(run)?.inspections?.[0];assert.equal(paused?.dispatch,halted.dispatch);
	assert.match(paused?.summary??"",/paused/);assert.equal(db.read(run)?.products.length,0);
	const before=reads;await clock.pulse(issuer,16);assert.ok(reads-before<16,"unchanged status backs off");
	status="completed";await clock.pulse(issuer,12);
	assert.equal(launches,1);assert.equal(db.read(run)?.inspections?.[0].dispatch,halted.dispatch);assert.equal(db.read(run)?.products.length,1);
});

test("only an exact pre-admission capacity rejection rearms the same candidate after backoff",async t=>{
	const {f,w,db}=await trial(t);
	t.mock.timers.enable({apis:["setTimeout"]});
	/** @type {string[]} */ const tickets=[];
	const issuer=f.runtime(w.cwd,{startInspection:async(id,job,ticket,actor)=>{
		tickets.push(ticket);
		if (tickets.length===1) throw Error("This session already has 2 active workflow runs, which is the concurrent limit.");
		await issuer.inspectionPacket(id,job,ticket,actor,"admitted-duck");return {runId:"admitted-duck",status:"running"};
	},inspectionState:async id=>{
		const [i]=db.read(run)?.inspections??[];assert.ok(i);
		return {runId:id,status:"completed",result:{inspection:i.id,component:i.component,candidate:i.candidate,outcome:"approved",summary:"Value is intact."}};
	}});
	await issuer.operation("submit",{run,token:w.token},w.id);await turn();await issuer.flush();
	const [queued]=db.read(run)?.inspections??[];assert.ok(queued?.state==="ready" && !queued.dispatch && !queued.workflow);
	assert.match(queued.summary??"",/capacity/i);
	issuer.turn(w.id);await issuer.flush();assert.equal(tickets.length,1);
	t.mock.timers.tick(15_000);await turn();await issuer.flush();
	const [done]=db.read(run)?.inspections??[];assert.equal(done?.state,"approved");assert.equal(done.id,queued.id);
	assert.equal(tickets.length,2);assert.notEqual(tickets[0],tickets[1]);assert.equal(db.read(run)?.products.length,1);
});

for (const stop of ["deadline","close"]) test(`a ${stop} during the permission read prevents native inspection issuance`,async t=>{
	const now=Date.now();t.mock.timers.enable({apis:["Date"],now});
	const {f,w,db}=await trial(t,new Date(now+60_000).toISOString());
	let sampling=()=>{},release=()=>{},starts=0;
	const sampled=new Promise(resolve=>{sampling=()=>resolve(undefined);}), grant=new Promise(resolve=>{release=()=>resolve(undefined);});
	const issuer=f.runtime(w.cwd,{permissionBlocker:async()=>{
		if(db.read(run)?.inspections?.some(i=>i.state==="ready")){sampling();await grant;}
		return null;
	},startInspection:async()=>{starts++;throw Error("Must not issue");}});
	const submitted=issuer.operation("submit",{run,token:w.token},w.id).catch(error=>error);
	await sampled;
	if (stop==="deadline") t.mock.timers.setTime(now+60_001);else issuer.close();
	release();const result=await submitted;await issuer.flush();
	if(stop==="close") assert.equal(result.code,"runtime_closed");else assert.ok(!(result instanceof Error),String(result));
	assert.equal(starts,0);const state=db.read(run), [review]=state?.inspections??[];
	assert.ok(review && review.state==="ready" && !review.dispatch);assert.equal(state?.products.length,0);
});

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { factory,git,put } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { openDatabase } from "./database.mjs";
import { effectAt } from "./revision.mjs";
import { decode } from "./snapshot.mjs";
import { inspectionOutcome } from "./assignment.mjs";
import { metricsFacts } from "./metrics.mjs";
import { markInspection, publicationSample } from "./inspections.mjs";
import { createRuntime } from "./runtime.mjs";

const run="reviewed",source=".foundry/reviewed.json";
/** @param {import("node:test").TestContext} t @param {typeof factory} [build] */
async function trial(t,build=factory){
	const f=build(t,run,source,{[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Publish the checked result.",
		seed:["consumer"],productCheck:"product.mjs",grains:["producer","consumer"].map(id=>({id,directory:id,specification:"spec",boundary:["api"],
			check:"unit.mjs",needs:id==="consumer"?["producer"]:[]}))}),spec:"Provide a value and its use.",api:"Keep the public value.",
		"unit.mjs":"","product.mjs":`import {readFileSync as read} from "node:fs";if(read("consumer/value","utf8")!=="correct")process.exit(1);`});
	await f.start();const store=openDatabase(f.root);t.after(()=>store.close());
	return {f,store};
}

test("a passing component waits for review; the owner can take an unissued review after its writer closes",async t=>{
	const {f,store}=await trial(t),[p]=f.workers.values();
	put(p.cwd,"producer/value","not yet reviewed");
	const writer=f.runtime(p.cwd,{startInspection:undefined});
	await writer.operation("submit",{run,token:p.token},p.id);
	const state=store.read(run);assert.ok(state);
	const n=state.nodes.producer,e=state.effects.find(e=>e.id===n.check);
	assert.ok(e?.kind==="component" && e.receipt?.exit===0);
	store.verifySigned(run,e);
	assert.equal(n.state,"reviewing");
	assert.equal(state.nodes.consumer.worker,undefined);assert.equal(f.workers.size,1);
	assert.equal(state.products.length,0);assert.equal(writer.inspect({run},p.id).nodes[0].checked,undefined);
	assert.equal(git(f.root,"rev-parse","main"),f.tip);
	const [prior]=state.inspections??[];assert.ok(prior?.state==="ready" && prior.issuer===p.id && !prior.dispatch);
	writer.close();f.owner.turn("owner");await f.owner.flush();
	assert.deepEqual(store.read(run)?.inspections,[prior],"a routine wake cannot take another issuer's reservation");
	await f.owner.operation("resume",{source,run},"owner");await turn();await f.owner.flush();
	const recovered=store.read(run);assert.ok(recovered?.nodes.consumer.worker);
	const [review]=recovered.inspections??[];
	assert.deepEqual([review?.id,review?.issuer,review?.state,review?.component],[prior.id,"owner","approved",n.check]);
	assert.deepEqual(recovered.effects.filter(c=>c.kind==="component"),[e]);
});

test("a slow independent reviewer holds only its own output, not unrelated ready work",async t=>{
	const ids=["slow","fast","after"];
	const f=factory(t,run,source,{[source]:JSON.stringify({version:1,id:run,direction:"Ship three outputs.",target:"refs/heads/main",
		productCheck:"unit.mjs",seed:["slow","after"],limits:{workers:2},grains:ids.map(id=>({id,directory:id,check:"unit.mjs",specification:"brief",
			boundary:["api"],needs:id==="after"?["fast"]:[]}))}),brief:"Build each output.",api:"Keep the names.","unit.mjs":""});
	await f.start();const [slow,fast]=f.workers.values();
	put(slow.cwd,"slow/value","review not completed");
	await f.runtime(slow.cwd,{startInspection:async()=>({runId:"open",status:"running"}),inspectionState:()=>new Promise(()=>{})})
		.operation("submit",{run,token:slow.token},slow.id);
	put(fast.cwd,"fast/value","ready");await f.runtime(fast.cwd).operation("submit",{run,token:fast.token},fast.id);
	const status=await f.status(), nodes=new Map(status.nodes.map(n=>[n.grain,n]));
	assert.equal(nodes.get("slow")?.state,"reviewing");assert.equal(nodes.get("slow")?.checked,undefined);
	assert.equal(nodes.get("fast")?.state,"published");assert.equal(nodes.get("after")?.inputs?.fast,nodes.get("fast")?.checked);
	assert.equal(nodes.get("after")?.state,"writing");assert.equal(status.products?.length,0);
});

test("review findings survive reload, cannot be bypassed with the same bytes, and route one repair to the original writer",async t=>{
	const {f,store}=await trial(t),[p]=f.workers.values();
	const finding="producer/value:1: the exported value is incorrect.";
	let release=()=>{};const reviewing=new Promise(resolve=>{release=()=>resolve(undefined);});
	/** @type {Map<string,{inspection:string,component:string,candidate:string,outcome:string,summary:string}>} */ const results=new Map();
	const writer=f.runtime(p.cwd,{
		async startInspection(id,inspection,ticket,actor) {
			const i=store.read(id)?.inspections?.find(i=>i.id===inspection);
			assert.ok(i?.dispatch===ticket && i.issuer===actor);assert.equal(i.state,"issued");
			const value=git(f.root,"show",`${i.candidate}:producer/value`),runId=`duck-${results.size+1}`;
			results.set(runId,{inspection,component:i.component,candidate:i.candidate,...(value==="correct" ?
				{outcome:"approved",summary:"producer/value:1: exports the required value."}:{outcome:"changes",summary:finding})});
			return {runId,status:"running"};
		},
		async inspectionState(runId){if(runId==="duck-1")await reviewing;return {runId,status:"completed",result:results.get(runId)};},
	});
	put(p.cwd,"producer/value","incorrect");
	const waiting=await writer.operation("submit",{run,token:p.token},p.id);
	assert.equal(waiting.nodes[0].state,"reviewing");release();await turn();await writer.flush();
	const first=store.read(run),reject=first?.inspections?.[0];assert.ok(first && reject);
	assert.equal(reject.state,"changes");assert.equal(reject.summary,finding);
	assert.equal(first.nodes.consumer.worker,undefined);assert.equal(first.products.length,0);assert.equal(f.workers.size,1);
	const n=writer.inspect({run},p.id).nodes[0];
	assert.ok(n.state==="writing" && n.worker===p.id && n.token && n.token!==p.token);
	assert.equal(n.codeReview?.summary,finding);assert.ok(n.receipt && n.receipt.exit===0);
	const notice=first.effects.find(e=>e.kind==="repair" && e.token===n.token);
	assert.ok(notice && String(notice.args.message).includes(finding),"the late finding must reach the same writer in its repair notice");
	const check=first.effects.find(e=>e.id===reject.component);assert.ok(check?.kind==="component");store.verifySigned(run,check);
	const reloaded=f.runtime(p.cwd);
	await assert.rejects(reloaded.operation("submit",{run,token:n.token},p.id),/change the assigned output/);
	assert.equal(store.read(run)?.effects.filter(e=>e.kind==="component").length,1);
	const forgery=structuredClone(first);forgery.nodes.producer.state="published";forgery.nodes.producer.candidate=reject.candidate;
	assert.throws(()=>decode(forgery),/Invalid Foundry task graph/);
	put(p.cwd,"producer/value","correct");
	await writer.operation("submit",{run,token:n.token},p.id);await turn();await writer.flush();
	const second=store.read(run),[original,approved]=second?.inspections??[];assert.ok(second && original && approved);
	assert.deepEqual(original,reject);assert.equal(approved.state,"approved");assert.notEqual(approved.component,reject.component);
	assert.notEqual(approved.candidate,reject.candidate);assert.equal(results.size,2);
	assert.equal(second.nodes.producer.state,"published");assert.deepEqual(second.nodes.consumer.inputs,{producer:approved.candidate});
	const wrongScope=structuredClone(second), copy=wrongScope.inspections?.find(i=>i.id===approved.id);assert.ok(copy);
	copy.scope={directories:[],files:["producer/other"]};assert.throws(()=>decode(wrongScope),{code:"corrupt_run"});
	assert.equal(f.workers.size,2);const [,consumer]=f.workers.values();
	assert.equal(git(consumer.cwd,"show","HEAD:producer/value"),"correct");
	assert.ok(!f.runtime(consumer.cwd).inspect({run},consumer.id).nodes.some(n=>n.codeReview?.id===reject.id));
	put(consumer.cwd,"consumer/value","correct");
	const cw=f.runtime(consumer.cwd);await cw.operation("submit",{run,token:consumer.token},consumer.id);await turn();await cw.flush();
	const last=store.read(run);assert.ok(last?.products.at(-1)?.qualifiedAt);assert.equal(last.inspections?.length,3);
	assert.equal(results.size,2);assert.equal(git(f.root,"rev-parse","main"),f.tip);
	const {workflowIds}=metricsFacts(last).history;assert.ok(workflowIds.includes("duck-1") && workflowIds.includes("duck-2"));
});

test("a review cannot extend an attestation, a repair cap or the run's assignment budget",async t=>{
	const {f,store}=await trial(t),[p]=f.workers.values();
	put(p.cwd,"producer/value","needs repair");
	await f.runtime(p.cwd,{startInspection:undefined}).operation("submit",{run,token:p.token},p.id);
	const live=structuredClone(store.read(run)),i=live?.inspections?.[0];assert.ok(live && i);
	markInspection(i,"issue",{dispatch:"review-request"});
	assert.throws(()=>markInspection(i,"unavailable",{summary:"unknown start"}),/Unhandled transition/);
	markInspection(i,"bind",{workflow:"bound-review"});markInspection(i,"changes",{summary:"producer/value needs correction"});
	for(const condition of ["attestation","repairs","assignments","permitted"]){
		/** @type {import("./model.js").Run} */ const draft=structuredClone(live);
		const n=draft.nodes.producer;draft.policy.repairs=condition==="repairs" ? 0 : 1;
		if(condition==="attestation")n.restoration={from:"prior",retainer:"keeper",historical:"receipt",checkpoint:"checkpoint",goal:"goal",tree:i.candidate};
		inspectionOutcome(draft,n,i,condition==="assignments"?0:1);
		assert.equal(n.state,condition==="permitted"?"waiting":"blocked");
		assert.match(n.reason??"",/producer\/value needs correction/);assert.equal(n.token,p.token);
	}
});

test("resuming a pre-review ledger preserves the original writer's contract and does not invent a review",async t=>{
	const priorFixture=process.env.FOUNDRY_PRIOR_FIXTURE;
	/** @type {typeof factory} */ const build=priorFixture ? (await import(priorFixture)).factory : await historicalFactory(t,64);
	const {f,store}=await trial(t,build),[p]=f.workers.values();
	assert.equal(store.read(run)?.inspections,undefined);
	f.owner.close();
	const owner=f.runtime(f.root,{startInspection:async()=>assert.fail("no retrospective review")},createRuntime);
	await owner.operation("pause",{run},"owner");await owner.operation("resume",{source,run},"owner");
	put(p.cwd,"producer/value","correct");
	await f.runtime(p.cwd,{startInspection:undefined},createRuntime).operation("submit",{run,token:p.token},p.id);
	const prior=store.read(run);assert.ok(prior?.nodes.consumer.worker);assert.equal(prior.inspections,undefined);
	assert.equal(prior.nodes.producer.state,"published");assert.equal(prior.nodes.producer.token,p.token);
	const w=f.workers.get(prior.nodes.consumer.worker);assert.ok(w);
	put(w.cwd,"consumer/value",git(w.cwd,"show",`${prior.nodes.consumer.inputs?.producer}:producer/value`));
	await f.runtime(w.cwd,{startInspection:async()=>assert.fail("no invented reviewer")},createRuntime).operation("submit",{run,token:w.token},w.id);
	const end=store.read(run);assert.ok(end?.products.at(-1)?.qualifiedAt);
	assert.equal(end.inspections,undefined);assert.equal(end.nodes.producer.check,prior.nodes.producer.check);
	for(const id of [end.nodes.producer.check,end.nodes.consumer.check,end.products.at(-1)?.check]){
		const c=effectAt(end,id);assert.ok(c?.tool==="bash" && c.receipt?.exit===0);store.verifySigned(run,c);
	}
});

test("two owner resumes can recover the same unavailable candidate only once, without another writer or component",async t=>{
	const previous=process.env.FOUNDRY_INSPECTION_FIXTURE;
	/** @type {typeof factory} */ const build=previous ? (await import(previous)).factory : factory;
	const {f,store}=await trial(t,build),[writer]=f.workers.values();
	const original=f.runtime(writer.cwd,{startInspection:async()=>({runId:"original-duck",status:"running"}),
		inspectionState:async id=>({runId:id,status:"error",error:"Provider unavailable"})});
	put(writer.cwd,"producer/value","correct");
	await original.operation("submit",{run,token:writer.token},writer.id);await turn();await original.flush();original.close();
	const before=store.read(run), [first]=before?.inspections??[];assert.ok(first?.state==="unavailable" && before);
	const check=before.effects.find(e=>e.id===first.component);assert.ok(check?.kind==="component");store.verifySigned(run,check);

	const events=new EventEmitter(),waiting=once(events,"checking"),permission=once(events,"permitted"),finish=once(events,"reviewed");
	const lookup=async(/** @type {string} */ id)=>{assert.equal(id,"new-duck");await finish;return {runId:id,status:"completed",result:{
		inspection:first.id,component:first.component,candidate:first.candidate,outcome:"approved",summary:"producer/value:1 exports the required value."}};};
	let launches=0;
	const slow=f.runtime(f.root,{permissionBlocker:async()=>{events.emit("checking");await permission;return null;},
		startInspection:async()=>{launches++;throw Error("Stale resume started a duplicate review");},inspectionState:lookup},createRuntime);
	const fast=f.runtime(f.root,{startInspection:async(id,job,ticket,actor)=>{
		launches++;const packet=await fast.inspectionPacket(id,job,ticket,actor,"new-duck");
		assert.equal(packet.candidate,first.candidate);return {runId:"new-duck",status:"running"};
	},inspectionState:lookup},createRuntime);
	const racing=slow.operation("resume",{source,run},"owner");await waiting;
	try{await fast.operation("resume",{source,run},"owner");await turn();await fast.flush();}
	finally{events.emit("permitted");}
	await racing;
	const parked=store.read(run)?.inspections?.[0];assert.ok(parked?.state==="issued" && parked.workflow==="new-duck");
	assert.equal(parked.previous?.[0].workflow,first.workflow);assert.equal(parked.previous?.[0].issuer,writer.id);
	assert.equal(store.read(run)?.nodes.consumer.worker,undefined);
	events.emit("reviewed");await turn();await Promise.all([fast.flush(),slow.flush()]);
	const end=store.read(run);assert.ok(end?.nodes.consumer.worker);
	assert.equal(launches,1);assert.equal(end.nodes.producer.worker,writer.id);assert.equal(end.inspections?.[0].id,first.id);
	assert.deepEqual(end.effects.filter(e=>e.kind==="component"),[check]);
	assert.equal(end.nodes.consumer.inputs?.producer,first.candidate);
});

test("a permission sample cannot publish a replaced decision or lift another issuer's hold",async t=>{
	const {f,store}=await trial(t),[w]=f.workers.values();put(w.cwd,"producer/value","correct");
	await f.runtime(w.cwd,{startInspection:undefined}).operation("submit",{run,token:w.token},w.id);
	const r=structuredClone(store.read(run)),[i]=r?.inspections??[];assert.ok(r && i);
	markInspection(i,"issue",{dispatch:"issued"});markInspection(i,"bind",{workflow:"bound"});
	markInspection(i,"approved",{summary:"producer/value:1 supplies the expected result."});
	const sample=publicationSample(w.id);assert.equal(sample.check(r),false);sample.permit();
	const changed=structuredClone(r),[decision]=changed.inspections??[];assert.ok(decision);
	decision.summary="Different decision text at the same candidate.";assert.equal(sample.check(changed),false);sample.permit();
	const message=decision.permissionHold="Manual approval required.";
	assert.equal(sample.check(changed),false);assert.equal(decision.permissionHold,message);
	const peer=publicationSample(r.owner);assert.equal(peer.check(changed),true);assert.equal(peer.selected.length,0);
	assert.equal(decision.permissionHold,message);
	sample.permit();assert.equal(sample.check(changed),true);assert.equal(decision.permissionHold,undefined);
});

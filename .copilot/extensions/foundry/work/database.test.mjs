import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checksum, ledgerPath, openDatabase } from "./database.mjs";
import { historicalFactory,historicalRuntime } from "../test/legacy-readers.mjs";
import { factory,git,put } from "../test/fixture.mjs";
import { createRuntime } from "./runtime.mjs";
import { integrityHolds } from "./revision.mjs";
import { serialize } from "node:v8";
import { releaseFacts } from "./facts.mjs";

const run="fence", source=".foundry/fence.json";
const files={[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Measure.",
	productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"entries",areas:["entries"],charter:"spec",boundary:["api"],checks:["product.mjs"]}]}),
	"product.mjs":"","goal.mjs":"","api":"Stable.","spec":"Build entries."};
/** @param {import("node:test").TestContext} t */
async function setup(t,version=95){
	const make=await historicalFactory(t,version),f=make(t,run,source,files);
	const owner=f.runtime(f.root,{execute:async()=>({resultType:"unconfirmed"})});
	await f.start(owner);owner.close();f.owner.close();
	const raw=new DatabaseSync(ledgerPath(f.root)),db=openDatabase(f.root);
	t.after(()=>{db.close();raw.close();});
	const document=()=>String(raw.prepare("SELECT document FROM runs WHERE id=?").get(run)?.document);
	const save=(/** @type {unknown} */ v)=>{const s=JSON.stringify(v);raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(s,checksum(s),run);};
	return {f,db,raw,document,save};
}

test("only a committed logical edit crosses the wire barrier; mixed and unknown shapes cannot be claimed",async t=>{
	const {db,raw,document,save}=await setup(t),before=document(),old=JSON.parse(before);
	assert.ok(old.nodes && !old.graph && !old.format);
	assert.equal(db.forResume(source,"owner")?.id,run);db.planAndSwap(run,()=>{});db.mutateLocked(run,()=>{});
	assert.equal(document(),before);
	assert.throws(()=>db.mutateLocked(run,r=>{r.active=false;throw Error("before commit");}),/before commit/);
	assert.equal(document(),before);
	db.planAndSwap(run,r=>{r.scheduling={revision:1,checkpointReviews:false};});
	const converted=JSON.parse(document());
	assert.equal(converted.format,"foundry-run/2");assert.equal("nodes" in converted,false);
	assert.deepEqual(converted.graph.nodes,old.nodes);
	assert.deepEqual(converted.effects.map((/** @type {import("./model.js").NativeCall} */ {attempt,...e})=>e),old.effects);
	assert.equal(converted.effects.find((/** @type {import("./model.js").Effect} */ e)=>e.tool==="bash").attempt.version,1);
	assert.equal(db.forResume(source,"owner")?.id,run);assert.deepEqual(db.involving("owner"),[run]);
	for(const v of [{...converted,nodes:old.nodes},{...old,graph:converted.graph},{...converted,format:"foundry-run/3"},
		{...converted,effects:old.effects}]){
		save(v);assert.throws(()=>db.mutateLocked(run,()=>assert.fail("invalid document reached a writer")),{code:"corrupt_run"});
	}
	save(converted);db.read(run);
	raw.prepare("UPDATE runs SET document=document||' ' WHERE id=?").run(run);
	assert.throws(()=>db.read(run),{code:"corrupt_run"},"cache hits must not hide an external checksum mismatch");
});

test("a version-two reservation cannot masquerade as an unsigned pre-journal completion",async t=>{
	const f=factory(t,run,source,files),owner=f.runtime(f.root,{execute:async()=>({resultType:"unconfirmed"})});await f.start(owner);
	const db=openDatabase(f.root),raw=new DatabaseSync(db.file);t.after(()=>{raw.close();db.close();});
	const doc=JSON.parse(String(raw.prepare("SELECT document FROM runs WHERE id=?").get(run)?.document)),e=doc.effects[0];
	assert.equal(e.attempt.version,2);e.runnerStarted=true;e.state="done";e.receipt={commit:e.commit,check:e.check,exit:0,output:"not signed"};
	const forged=JSON.stringify(doc);raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(forged,checksum(forged),run);
	assert.throws(()=>db.read(run),{code:"corrupt_run"});assert.throws(()=>db.mutateLocked(run,()=>assert.fail("unsigned result reached planner")),{code:"corrupt_run"});
});

test("an unclaimed reservation cannot change its physical scope or turn a non-release purpose into a goal",async t=>{
	const f=factory(t,run,source,files),owner=f.runtime(f.root,{execute:async()=>({resultType:"unconfirmed"})});await f.start(owner);
	const db=openDatabase(f.root),raw=new DatabaseSync(db.file);t.after(()=>{raw.close();db.close();});
	const row=()=>raw.prepare("SELECT document,checksum FROM runs WHERE id=?").get(run)??assert.fail(),saved=row();
	const original=JSON.parse(String(saved.document));
	for(const part of ["scope","release","preparation","role","overlay"]){
		const doc=structuredClone(original),e=doc.effects.find((/** @type {import("./model.js").Effect} */ e)=>e.kind==="goal"),d=e.verification,s=d.steps.at(-1);
		if(part==="scope")s.inputs.scope={kind:"component",grain:"entries",directories:["entries"],files:[]};
		if(part==="release")d.use="subset";
		if(part==="preparation")s.build={commit:e.commit,hook:null};
		if(part==="role")d.evaluation={kind:"product",outputs:[]};
		if(part==="overlay")s.inputs.overlay={revision:e.commit,paths:[]};
		const bytes=JSON.stringify(doc);raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(bytes,checksum(bytes),run);
		assert.throws(()=>db.mutateLocked(run,()=>assert.fail("invalid obligation reached a claimant")),{code:"corrupt_run"},part);
	}
	raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(saved.document,saved.checksum,run);
	const restored=db.read(run)?.effects.find(e=>e.kind==="goal");assert.ok(restored?.kind==="goal" && !restored.runnerStarted && !restored.receipt);
	assert.equal(restored.id,original.goal.check);
});

test("reopening a workflow shared by different dispatches holds the original ledger without replay",async t=>{
	const build=await historicalFactory(t,95),policy=JSON.parse(files[source]);
	policy.squads.push({...policy.squads[0],id:"totals",areas:["totals"]});
	const f=build(t,run,source,{...files,[source]:JSON.stringify(policy),"goal.mjs":"process.exit(1)"});
	await f.start();f.owner.close();
	const raw=new DatabaseSync(ledgerPath(f.root));t.after(()=>raw.close());
	const row=()=>raw.prepare("SELECT document,checksum FROM runs WHERE id=?").get(run)??assert.fail();
	const original=row(),data=JSON.parse(String(original.document));
	const scouts=data.effects.filter((/** @type {import("./model.js").Effect} */ e)=>e.kind==="scout");
	assert.equal(scouts.length,2);assert.ok(scouts[0].workflowId && scouts[0].callId);
	assert.equal(scouts[0].workflowId,scouts[1].workflowId);assert.equal(scouts[0].callId,scouts[1].callId);
	const current=f.runtime(f.root,{scout:async()=>assert.fail("Do not start another scout")},createRuntime);
	assert.equal(current.inspect({run},"owner").reviews.length,2,"one original native batch legitimately serves both scouts");
	scouts[1].callId="another-dispatch";
	const document=JSON.stringify(data);raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(document,checksum(document),run);
	const held=row(),calls=[...f.checks];
	assert.throws(()=>current.inspect({run},"owner"),{code:"corrupt_run"});
	await assert.rejects(current.operation("resume",{run,source},"owner"),{code:"corrupt_run"});
	assert.deepEqual(row(),held);assert.deepEqual(f.checks,calls);
	current.close();
});

test("downgraded SQL discovery still binds the original writer and source; the current writer finishes its own draft",async t=>{
	const make=await historicalFactory(t,95),f=make(t,run,source,{...files,[source]:JSON.stringify({version:1,id:run,
		target:"refs/heads/main",direction:"Build the entry.",seed:["entry"],productCheck:"product.mjs",
		grains:[{id:"entry",directory:"entry",specification:"spec",boundary:["api"],check:"unit.mjs"}]}),"unit.mjs":""});
	await f.start();const [writer]=f.workers.values();put(writer.cwd,"entry/value","original draft");
	const db=openDatabase(f.root);t.after(()=>db.close());
	const old=db.read(run)?.nodes.entry;assert.equal(old?.worker,writer.id);
	db.mutateLocked(run,r=>{r.scheduling={revision:1,checkpointReviews:false};});
	for(const version of [95,80]){
		const before=f.runtime(writer.cwd,{},await historicalRuntime(t,version));
		await assert.rejects(before.operation("start",{source},writer.id),{code:version===95?"worker_cannot_start":"corrupt_run"});
		await assert.rejects(before.operation("submit",{run,token:writer.token},writer.id),{code:"corrupt_run"});
		before.close();
	}
	assert.equal(db.forResume(source,"owner")?.id,run);assert.deepEqual(db.involving(writer.id),[run]);
	assert.deepEqual(db.read(run)?.nodes.entry,old);
	const now=f.runtime(writer.cwd,{},createRuntime);await now.operation("submit",{run,token:writer.token},writer.id);await now.flush();
	assert.equal(db.read(run)?.nodes.entry.state,"qualified");assert.equal(f.workers.size,1);
});

for(const version of [80,95])test(`reader ${version} needs a separate explicit start for a new ID at the same filename`,async t=>{
	const build=await historicalFactory(t,version),f=build(t,run,source,{...files,"goal.mjs":"process.exit(2)"});
	await f.start();f.owner.close();
	const db=openDatabase(f.root),raw=new DatabaseSync(db.file,{readOnly:true});t.after(()=>{db.close();raw.close();});
	db.mutateLocked(run,r=>{r.scheduling={revision:1,checkpointReviews:false};});
	const row=()=>raw.prepare("SELECT document,checksum FROM runs WHERE id=?").get(run),before=row();
	const state=db.read(run),original=state?.effects.find(e=>e.id===state.goal?.check);
	assert.ok(original?.kind==="goal" && original.receipt?.exit===2);db.verifySigned(run,original);
	const other="different-brief",actor=version===95?"owner":"other-owner";
	put(f.root,source,JSON.stringify({...JSON.parse(files[source]),id:other}));git(f.root,"commit","-qam","Name a separate brief");
	let calls=0;const old=f.runtime(f.root,{execute:async()=>{calls++;return {resultType:"unconfirmed"};}});
	await assert.rejects(old.operation("resume",{source},"owner"),{code:"corrupt_run"});
	assert.equal(db.read(other),undefined);assert.equal(calls,0);
	await old.operation("start",{source},actor);await old.flush();old.close();
	const fresh=db.read(other);assert.ok(fresh?.goal);assert.equal(fresh.owner,actor);assert.equal(calls,1);
	assert.notEqual(fresh.goal.check,original.id);assert.deepEqual(fresh.products,[]);assert.deepEqual(fresh.nodes,{});
	assert.ok(fresh.effects.every(e=>!e.receipt && !e.runnerClaim && !e.token));
	if(actor==="owner")assert.throws(()=>db.forResume(source,actor),{code:"run_conflict"});
	assert.deepEqual(row(),before);db.verifySigned(run,original);
});

for(const [version,wanted] of /** @type {const} */ ([[95,"required"],[22,"legacy-no-review"]]))test(`preserve reader ${version}'s independent-review contract at conversion`,async t=>{
	const {db,document,save}=await setup(t,version);db.mutateLocked(run,r=>{r.scheduling={revision:1,checkpointReviews:false};});
	const wire=JSON.parse(document());assert.equal(wire.reviewContract,wanted);
	assert.throws(()=>db.planAndSwap(run,r=>{if(wanted==="required")delete r.inspections;else r.inspections=[];}),{code:"corrupt_run"});
	assert.deepEqual(JSON.parse(document()),wire);
	for(const v of [{...wire,reviewContract:undefined},{...wire,reviewContract:wanted==="required"?"legacy-no-review":"required"}]){
		save(v);assert.throws(()=>db.read(run),{code:"corrupt_run"});
	}
});

test("process loss on either side of the first wire commit and a stale competing edit preserve the same run",async t=>{
	const {f,db,document}=await setup(t),before=document(),args=[`--import=${new URL("../test/wire-crash.mjs",import.meta.url).href}`,
		fileURLToPath(new URL("../test/installed-reader.mjs",import.meta.url)),fileURLToPath(new URL("../",import.meta.url)),f.root];
	for(const side of ["before","after"]){
		const crash=spawnSync(process.execPath,args,{encoding:"utf8",input:JSON.stringify({action:"configure",params:{run,revision:0,checkpointReviews:false}}),
			env:{...process.env,CRASH_SIDE:side}});
		assert.equal(crash.status,side==="before"?86:87,crash.stderr || crash.stdout);
		if(side==="before")assert.equal(document(),before);
		else{assert.equal(JSON.parse(document()).format,"foundry-run/2");assert.equal(db.forResume(source,"owner")?.scheduling?.revision,1);}
	}
	const peer=openDatabase(f.root);t.after(()=>peer.close());let attempts=0;
	db.planAndSwap(run,r=>{
		if(++attempts===1)peer.mutateLocked(run,p=>{p.active=false;});
		assert.ok(r.scheduling);r.scheduling.revision++;
	});
	assert.equal(attempts,2);assert.equal(db.read(run)?.active,false);assert.equal(db.read(run)?.scheduling?.revision,2);
});

test("a valid runner that finishes between the document and spool reads never surfaces a false integrity hold",async t=>{
	const f=factory(t,run,source,files),owner=f.runtime(f.root,{execute:async()=>({resultType:"unconfirmed"})});await f.start(owner);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const saved=DatabaseSync.prototype.prepare;let ran=false;
	try{
		DatabaseSync.prototype.prepare=function(/** @type {string} */ sql){
			const s=saved.call(this,sql);
			if(sql.startsWith("SELECT document,checksum,owner FROM runs")){
				const get=s.get.bind(s);Object.defineProperty(s,"get",{value:(/** @type {import("node:sqlite").SQLInputValue[]} */ ...values)=>{
					const row=get(...values);
					if(!ran){
						ran=true;const e=JSON.parse(String(row?.document)).effects[0];
						const actual=spawnSync("/bin/sh",["-c",e.args.command],{cwd:f.root,encoding:"utf8"});
						assert.equal(actual.status,0,actual.stderr);
					}
					return row;
				}});
			}
			return s;
		};
		const snapshot=db.read(run);assert.ok(snapshot && ran);
		assert.deepEqual(integrityHolds(snapshot),[],"a signature valid for the concurrent claim is not a corrupt spool row");
		const e=snapshot.effects[0];assert.ok(e.kind==="goal" && e.receipt?.exit===0);db.verifySigned(run,e);
	}finally{DatabaseSync.prototype.prepare=saved;}
});

test("a stale read-only reservation cannot hand a native ticket to its caller",async t=>{
	const {db,f}=await setup(t),peer=openDatabase(f.root);t.after(()=>peer.close());
	const original=db.read(run)?.effects[0];assert.ok(original?.callId);
	let selections=0;
	const ticket=db.reserve(run,r=>{
		selections++;
		if(!r.active)return;
		peer.mutateLocked(run,other=>{other.active=false;});
		return {value:original.callId};
	});
	assert.equal(ticket,undefined,"the discarded private snapshot must not return its earlier ticket");
	assert.equal(selections,2);assert.deepEqual(db.read(run)?.effects[0],original);
});

test("the validated revision shares neither a mutable graph nor a planner draft and discovers an independently created spool",async t=>{
	const {db,f,document,save}=await setup(t);
	for(const size of [0,512]){
		const old=JSON.parse(document());
		old.effects=old.effects.filter((/** @type {import("./model.js").Effect} */ e)=>e.kind!=="handoff");
		for(let i=0;i<size;i++)old.effects.push({id:`settled-${i}`,issuer:"owner",kind:"handoff",tool:"session.send",state:"done",
			token:"prior",args:{message:"x".repeat(1024)}});
		save(old);
		const start=db.metrics(),time=performance.now(),first=db.read(run);
		assert.ok(first);const cold=db.metrics(),loaded=performance.now();
		for(let i=0;i<10;i++)assert.strictEqual(db.read(run),first);
		const warm=db.metrics();
		t.diagnostic(JSON.stringify({settled:size,coldBytes:cold.decodedBytes-start.decodedBytes,coldValidations:cold.validations-start.validations,
			warmBytes:warm.decodedBytes-cold.decodedBytes,warmValidations:warm.validations-cold.validations,coldMs:loaded-time,tenWarmMs:performance.now()-loaded}));
		assert.equal(cold.decodedBytes-start.decodedBytes,Buffer.byteLength(document()));assert.equal(cold.validations-start.validations,1);
		assert.deepEqual(warm,cold);assert.throws(()=>{first.effects.length=0;},TypeError);
		assert.throws(()=>db.planAndSwap(run,r=>{r.effects.length=0;throw Error("discard");}),/discard/);
		assert.strictEqual(db.read(run),first);
	}
	const before=db.stamp(run),other=new DatabaseSync(ledgerPath(f.root)+".outcomes");
	try{other.exec("CREATE TABLE outcomes(run TEXT NOT NULL,effect TEXT NOT NULL,signature TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(run,effect)) STRICT;PRAGMA user_version=1");
		other.prepare("INSERT INTO outcomes VALUES(?,?,?,?)").run(run,"orphan","invalid","{}");}
	finally{other.close();}
	assert.notEqual(db.stamp(run),before,"a spool created by a different process is discoverable without first reading a receipt");
});

test("an unchanged release decision does not serialize settled history into fresh private planner copies",async t=>{
	const {db,document,save}=await setup(t);
	const old=JSON.parse(document()),marker="synthetic settled notice ".repeat(2048);
	for(let i=0;i<20;i++)old.effects.push({id:`closed-${i}`,issuer:"owner",kind:"handoff",tool:"session.send",state:"done",
		token:"prior",args:{message:marker+i}});
	save(old);const first=db.read(run);assert.ok(first?.goal);
	const target=first.goal.target,expected=releaseFacts(first,target),before=db.metrics();
	const clone=globalThis.structuredClone,stringify=JSON.stringify;
	let bytes=0;
	const cloning=t.mock.method(globalThis,"structuredClone",(/** @type {unknown} */ v)=>{
		if(v && typeof v==="object" && "effects" in v)bytes+=serialize(v).length;
		return clone(v);
	});
	const encoding=t.mock.method(JSON,"stringify",(/** @type {unknown} */ v)=>{
		const s=stringify(v);
		if(typeof s==="string" && s.includes(marker))bytes+=Buffer.byteLength(s);
		return s;
	});
	try{
		for(let i=0;i<3;i++)db.planAndSwap(run,r=>{
			assert.deepEqual(releaseFacts(r,target),expected);return ()=>true;
		});
	}finally{cloning.mock.restore();encoding.mock.restore();}
	assert.equal(bytes,0,"an unchanged scheduler pass must not encode historical evidence as JSON or V8 clone payloads");
	assert.deepEqual(db.metrics(),before);assert.strictEqual(db.read(run),first);
});

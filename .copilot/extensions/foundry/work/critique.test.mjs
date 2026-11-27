import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { candidatePacket, critiqueDefinition, inspectionToolBlocked } from "./critique.mjs";
import { mechanicDefinition, repairResult } from "./mechanic.mjs";
import { fail } from "./values.mjs";
import { git, withoutGrain } from "./product.mjs";

/** @param {import("node:test").TestContext} t */
function fixture(t) {
	const root = mkdtempSync(path.join(tmpdir(),"foundry-critique-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	/** @param {string} p @param {string|Buffer} bytes */
	function put(p, bytes) { mkdirSync(path.dirname(path.join(root,p)), {recursive:true}); writeFileSync(path.join(root,p), bytes); }
	function commit() {
		git(root, ["add", "-A"]); git(root, ["commit", "--quiet", "-m", "fixture"]);
		return git(root, ["rev-parse", "HEAD"]).toString().trim();
	}
	git(root, ["init", "--quiet", "-b", "fixture"]);
	put("pkg/unit/deleted", "base-only deletion contents");
	put("pkg/unit/replaced", "base-only replacement contents");
	put("pkg/unit/transfer/earlier", "other owner's old bytes");
	put("pkg/unit/borrowed", "other owner's old exact file");
	put("pkg/unit-neighbor/private", "sibling contents");
	put("glue/entry", "old integration line\n");
	put("glue/entry-extra", "prefix collision contents");
	put("glue/old-name", "permitted rename contents\n");
	const base = commit(), generation = withoutGrain(root,base,"pkg/unit");
	git(root, ["checkout", "--quiet", "--detach", generation]);
	put("pkg/unit/replaced", "first generated line\nlast generated line\n");
	put("pkg/unit/empty", ""); put("pkg/unit/transferable", "owned despite the similar prefix");
	put("pkg/unit/transfer/new-owner", Buffer.from("other owner's binary\0"));
	symlinkSync("../../elsewhere", path.join(root,"pkg/unit/borrowed"));
	put("glue/entry", "new integration line\n"); chmodSync(path.join(root,"glue/entry"), 0o755);
	renameSync(path.join(root,"glue/old-name"), path.join(root,"glue/new-name"));
	const candidate = commit();
	/** @type {import("./model.js").Inspection} */
	const i = { id:"inspection", component:"component", grain:"unit", issuer:"private-issuer", state:"issued",
		task:"Check the generated result.", base,generation,candidate,
		scope:{directories:["pkg/unit"], files:["glue/entry","glue/old-name","glue/new-name"],
			exclude:{directories:["pkg/unit/transfer"],files:["pkg/unit/borrowed"]}} };
	return {root,put,commit,i};
}

test("review exactly the frozen owned changes, never the dirty index, base-only source or transferred paths", t => {
	const {root,put,i} = fixture(t);
	put("pkg/unit/replaced", "private staged bytes"); git(root, ["add","pkg/unit/replaced"]);
	put("pkg/unit/replaced", "private unstaged bytes"); put("pkg/unit/new-draft","private untracked bytes");
	const blob=git(root,["rev-parse",`${i.candidate}:pkg/unit/replaced`]).toString().trim();
	const substituted=git(root,["hash-object","-w","--stdin"],"private replacement object").toString().trim();
	git(root,["update-ref",`refs/replace/${blob}`,substituted]);
	const status = () => git(root,["status","--porcelain=v1"]).toString();
	const before = status();
	const input = {...i, token:"writer-capability", args:{password:"private-launch-arguments"}, summary:"Writer says approved."};
	const packet = candidatePacket(root,input);
	assert.deepEqual(Object.keys(packet).sort(), ["candidate","component","inspection","prompt"]);
	assert.deepEqual([packet.inspection,packet.component,packet.candidate], [i.id,i.component,i.candidate]);
	assert.equal(status(), before);
	for (const expected of [i.base,i.generation,i.candidate,i.task, "pkg/unit/replaced","pkg/unit/deleted","pkg/unit/empty",
		"first generated line","last generated line","pkg/unit/transferable","owned despite the similar prefix",
		"glue/entry","old integration line","new integration line","100644","100755","glue/old-name","glue/new-name","permitted rename contents"]) {
		assert.ok(packet.prompt.includes(expected), `missing review evidence: ${expected}`);
	}
	for (const p of ["deleted","replaced"]) {
		const oid = git(root,["rev-parse",`${i.base}:pkg/unit/${p}`]).toString().trim();
		assert.ok(packet.prompt.includes(oid), `lost reviewed-base metadata for ${p}`);
	}
	assert.doesNotMatch(packet.prompt, /base-only|pkg\/unit\/transfer\/|pkg\/unit\/borrowed|other owner's|elsewhere|unit-neighbor|sibling contents|entry-extra|prefix collision|private[- ]|new-draft|writer-capability|Writer says/);
	assert.deepEqual(candidatePacket(git(root,["rev-parse","--absolute-git-dir"]).toString().trim(),i),packet);
});

test("refuse mutable or missing pins, non-file exact grants and empty ownership instead of widening it", t => {
	const {root,i} = fixture(t);
	for (const mutation of [{candidate:"HEAD"},{generation:i.generation.slice(0,8)},{base:"0".repeat(40)},
		{candidate:git(root,["rev-parse",`${i.candidate}^{tree}`]).toString().trim()},
		{scope:{directories:[],files:[]}}, {scope:{directories:[],files:["pkg/unit"]}},
		{scope:{directories:["pkg/../glue"],files:[]}}, {scope:{directories:["."],files:[]}}]) {
		assert.throws(() => candidatePacket(root,{...i,...mutation}));
	}
});

test("withhold the whole packet for an unreadable change or credentials; never follow a link or silently redact", t => {
	const {root,put,i,commit} = fixture(t);
	for (const [file,contents] of /** @type {const} */ ([
		["binary",Buffer.from("not\0text")], ["encoding",Buffer.from([0xc3,0x28])], ["linked",null],
		[".env","SAMPLE=private-fixture"], ["source","api_key = 'private-fixture'\n"],
	])) {
		const p = `pkg/unit/${file}`;
		if (contents === null) symlinkSync("../../pkg/unit-neighbor/private",path.join(root,p));
		else put(p,contents);
		const candidate = commit();
		assert.throws(() => candidatePacket(root,{...i,candidate}), error => !String(error).includes("private-fixture"));
		unlinkSync(path.join(root,p));
	}
	assert.throws(() => candidatePacket(root,{...i,task:`Foundry assignment: demo ${randomUUID()}\nDo not publish this capability.`}));
});

test("unchanged attestations show scoped current bytes or provable file absence, not the old directory or sibling", async t => {
	const {root,put,i,commit}=fixture(t);
	const noEdit={...i,generation:i.candidate};
	const seen=candidatePacket(root,noEdit).prompt;
	assert.match(seen,/last generated line/);
	assert.match(seen,/new integration line/);
	assert.doesNotMatch(seen,/base-only|old integration line|other owner|unit-neighbor|entry-extra|pkg\/unit\/borrowed/);
	const absent=candidatePacket(root,{...noEdit,base:i.candidate,scope:{directories:["pkg/vacant"],files:["glue/lost"]}});
	assert.match(absent.prompt,/no owned file entries/i);assert.ok(absent.prompt.includes("pkg/vacant") && absent.prompt.includes("glue/lost"));
	const workflow=critiqueDefinition(()=>({async inspectionPacket(){return absent;}}));
	const summary="pkg/vacant:1 — The candidate contains no owned files at the requested directory.";
	assert.deepEqual(await workflow.run(context(async()=>({outcome:"approved",summary}))),{
		inspection:i.id,component:i.component,candidate:i.candidate,outcome:"approved",summary,
	});
	put("pkg/unit/opaque",Buffer.from("unreadable\0bytes"));const pin=commit();
	assert.throws(()=>candidatePacket(root,{...noEdit,base:pin,generation:pin,candidate:pin}),/binary|unrepresentable/i);
});

test("a fixed assignment gets just its exact conserved spec at the reviewed base, never a new review location", async t => {
	const {root,put,commit,i}=fixture(t), spec="contract/unit.md", frozen="Implement the exact line ending specified here.";
	git(root,["checkout","--quiet","--detach",i.base]);
	put(spec,frozen);put("contract/unit.md.other","sibling spec contents");
	put("contract/opaque",Buffer.from("spec\0bytes"));symlinkSync("unit.md.other",path.join(root,"contract/link"));
	const base=commit();put(spec,"staged spec draft");git(root,["add",spec]);put(spec,"spec edited after staging");
	const request={...i,base,specification:spec}, packet=candidatePacket(root,request);
	assert.ok(packet.prompt.includes(spec) && packet.prompt.includes(frozen) && packet.prompt.includes(git(root,["rev-parse",`${base}:${spec}`]).toString().trim()));
	assert.doesNotMatch(packet.prompt,/sibling spec|unit\.md\.other|staged spec|spec edited|base-only/);
	const ordinary=candidatePacket(root,{...i,base});
	assert.ok(!ordinary.prompt.includes(spec) && !ordinary.prompt.includes(frozen));
	assert.throws(()=>candidatePacket(root,request,Buffer.byteLength(ordinary.prompt)),/budget|context/i);
	for (const specification of ["contract","contract/missing","contract/opaque","contract/link","pkg/unit/deleted"])
		assert.throws(()=>candidatePacket(root,{...request,specification}));
	const definition=critiqueDefinition(()=>({async inspectionPacket(){return packet;}}));
	const answer=await definition.run(context(async()=>({outcome:"approved",summary:`${spec}:1 — The assignment text looks complete.`})));
	assert.equal(answer.outcome,"unavailable","task context is not evidence that the actual product was reviewed");
});

test("a measured context budget rejects oversized changes before reading their blob bodies; a sufficient budget includes every byte", t => {
	const {root,put,i,commit}=fixture(t);
	const source="begin\n"+"middle\n".repeat(75000)+"end\n";
	put("pkg/unit/big",source);const candidate=commit(), subject={...i,candidate};
	const oid=git(root,["rev-parse",`${candidate}:pkg/unit/big`]).toString().trim();
	const calls=t.mock.method(childProcess,"execFileSync");syncBuiltinESMExports();
	try {
		assert.throws(()=>candidatePacket(root,subject,16384),/budget|context/i);
		assert.ok(!calls.mock.calls.some(({arguments:args})=>Array.isArray(args[1]) && args[1].includes("cat-file") &&
			(args[1].includes("blob") && args[1].includes(oid) || args[1].includes("--batch"))),"never materialize an oversized body");
	} finally {calls.mock.restore();syncBuiltinESMExports();}
	const full=candidatePacket(root,subject), bytes=Buffer.byteLength(full.prompt);
	assert.ok(full.prompt.includes(JSON.stringify(source)));assert.deepEqual(candidatePacket(root,subject,bytes),full);
	assert.throws(()=>candidatePacket(root,subject,bytes-1),/budget|context/i);
});

/** @typedef {Parameters<ReturnType<typeof critiqueDefinition>["run"]>[0]} Context */
/** @param {Context["agent"]} agent @returns {Context} */
function context(agent) {
	return {args:{run:"run",inspection:"inspection",dispatch:"dispatch"}, session:/** @type {Context["session"]} */ ({sessionId:"issuer",
		rpc:{agent:{list:async()=>({agents:[{id:"rubber-duck",name:"rubber-duck",source:"builtin"}]})}}}),
		runId:"workflow-id", agent, signal:new AbortController().signal, agents:{}, phase(){}, log(){},
		step:async (_key, fn)=>fn(), pause:assert.fail, parallel:()=>assert.fail("Unexpected fork"),
		pipeline:()=>assert.fail("Unexpected pipeline"), workflow:assert.fail};
}

test("only the built-in Rubber Duck reviews the bound packet; SDK admission and writer-supplied pins are not verdicts", async t => {
	const {root,i} = fixture(t), packet = candidatePacket(root,i);
	let reads = 0, calls = 0;
	const definition = critiqueDefinition(() => ({async inspectionPacket(...args) {
		assert.deepEqual(args,["run","inspection","dispatch","issuer","workflow-id"]); reads++; return packet;
	}}));
	const summary = "pkg/unit/replaced:2 — The final generated line contradicts the assigned result.";
	/** @type {unknown} */ let answer;
	const ctx = context(async (prompt, options) => {
		calls++; assert.equal(options?.agent,"rubber-duck"); assert.equal(prompt,packet.prompt);
		assert.deepEqual(options?.schema?.required, ["outcome","summary"]); assert.equal(options?.schema?.additionalProperties,false);
		return answer;
	});
	assert.equal(definition.meta.name,"foundry-inspect");
	for (const outcome of ["approved","changes","unavailable"]) {
		answer = {outcome,summary};
		assert.deepEqual(await definition.run(ctx), {inspection:i.id,component:i.component,candidate:i.candidate,outcome,summary});
	}
	for (answer of [null, {}, "approved", {status:"completed"}, {outcome:"maybe",summary}, {outcome:"approved",summary:" "},
		{outcome:"approved",summary,candidate:"forged"}, {outcome:"approved",summary:"Looks good"},
		{outcome:"approved",summary:"pkg/unit/replaced:25 — There is no such line in the candidate."},
		{outcome:"approved",summary:"pkg/unit-neighbor/private:1 — This unrelated implementation works."}]) {
		const result = await definition.run(ctx); assert.equal(result.outcome,"unavailable");
		assert.deepEqual([result.inspection,result.component,result.candidate],[i.id,i.component,i.candidate]);
	}
	assert.equal(reads,calls); assert.ok(reads>3);
});

test("an absent, shadowed or unverified catalog agent never receives the product packet", async t => {
	const {root,i}=fixture(t), packet=candidatePacket(root,i);
	const definition=critiqueDefinition(()=>({async inspectionPacket(){return packet;}}));
	let calls=0;const ctx=context(async()=>{calls++;return {outcome:"approved",summary:"pkg/unit/replaced:1 — This is not the selected native reviewer."};});
	const agent={id:"rubber-duck",name:"rubber-duck",source:"builtin"};
	for (const agents of [[],[{...agent,source:"project"}],[agent,{...agent,id:"project-copy",source:"project"}],null]) {
		const session=/** @type {Context["session"]} */ ({sessionId:"issuer",rpc:{agent:{list:async()=>{
			if (!agents) throw Error("not available");return {agents};
		}}}});
		const result=await definition.run({...ctx,session});assert.equal(result.outcome,"unavailable");
	}
	assert.equal(calls,0);
});

test("the repair workflow delivers only its bound packet and guards both the test author and the independent reviewer",async()=>{
	const runtime={async mechanicPacket(/** @type {import("./mending.mjs").Ticket} */ ticket,/** @type {string} */ actor,/** @type {string} */ w){
		assert.equal(w,"workflow-id");assert.equal(actor,"issuer");return {subject:ticket.subject,message:"frozen evaluator bytes"};
	}},definition=mechanicDefinition(()=>runtime);
	for(const phase of /** @type {const} */ (["author","review"])){
		const args={run:"r",stop:"original",dispatch:"ticket",subject:"bound",phase};
		const ctx={...context(async(prompt,options)=>{
			assert.equal(options?.agent,phase==="author"?"foundry-test-author":"rubber-duck");assert.match(prompt,/frozen evaluator bytes/);
			const caller={sessionId:"child",agentId:"agent",toolName:"view",toolArgs:{},timestamp:new Date(),workingDirectory:"."};
			assert.ok(await inspectionToolBlocked(runtime,"issuer","child",caller,async()=>{throw Error("Unknown tool caller");}));
			return phase==="author"?{change:"fixed",reason:"Observed the field."}:{approved:true,reason:"The assertion is unchanged."};
		}),args};
		const result=await definition.run(ctx);assert.ok(result);
		const envelope={runId:"workflow-id",status:"completed",result};assert.deepEqual(repairResult(envelope,args),result);
		assert.throws(()=>repairResult(envelope,{...args,subject:"other"}));assert.throws(()=>repairResult(envelope,args,"another-workflow"));
		if(phase==="review"){
			ctx.session.rpc.agent.list=async()=>({agents:[]});
			await assert.rejects(definition.run(ctx),/Rubber Duck/);
		}
	}
});

test("the mechanic pauses before displaying any evidence and delivers once on the resumed attempt",async()=>{
	let permitted=false,pauses=0,agents=0;
	const runtime={async mechanicPacket(){if(!permitted)fail("repair_wait","No evidence while paused");return {subject:"bound",message:"frozen input"};}};
	const workflow=mechanicDefinition(()=>runtime),args=/** @type {const} */({run:"r",stop:"old",dispatch:"dispatch",phase:"author",subject:"bound"});
	const ctx={...context(async prompt=>{assert.match(prompt,/frozen input/);agents++;return {change:"test bytes",reason:"Field was missing."};}),args,
		async pause(/** @type {string} */ key){assert.equal(key,"permission:dispatch");pauses++;throw new DOMException("Workflow paused","AbortError");}};
	await assert.rejects(workflow.run(ctx),{name:"AbortError"});assert.equal(pauses,1);assert.equal(agents,0);
	permitted=true;const result=await workflow.run(ctx);assert.ok(result);assert.equal(result.subject,args.subject);assert.equal(agents,1);
});

test("a failed native review releases its tool guard without releasing another active inspection", async t => {
	const {root,i}=fixture(t), packet=candidatePacket(root,i);
	const runtime={async inspectionPacket(){return packet;}}, definition=critiqueDefinition(()=>runtime);
	const caller={sessionId:"child",agentId:"other",toolName:"view",toolArgs:{},timestamp:new Date(),workingDirectory:root};
	const pending=new Set(), entered=new Set();let waiting=()=>{};
	/** @param {string} id */
	const start=id=>definition.run({...context(async()=>{
		entered.add(id);if(entered.size===2) waiting();
		await new Promise(resolve=>pending.add({id,finish:()=>resolve(undefined)}));
		throw Error(`native failure ${id}`);
	}),runId:id});
	/** @type {Promise<void>} */ const both=new Promise(resolve=>{waiting=resolve;});
	const first=assert.rejects(start("first"),/native failure first/),second=assert.rejects(start("second"),/native failure second/);
	await both;
	/** @type {string[]} */ const seen=[];
	const blocked=()=>inspectionToolBlocked(runtime,"issuer","issuer",caller,async id=>{
		seen.push(id);throw Error("unattributable actor");
	});
	try {
		assert.ok(await blocked());
		[...pending].find(p=>p.id==="first").finish();await first;seen.length=0;
		assert.ok(await blocked());assert.deepEqual(seen,["second"]);
	} finally {for(const p of pending)p.finish();await Promise.all([first,second]);}
	seen.length=0;assert.equal(await blocked(),false);assert.deepEqual(seen,[]);
});

test("check the original authority every attempt, including a resume; no packet, no review", async t => {
	const {root,i} = fixture(t), packet = candidatePacket(root,i);
	let calls=0, reads=0, current=packet, allowed=true;
	const definition=critiqueDefinition(() => ({async inspectionPacket(run,inspection,dispatch,actor,workflow) {
		reads++;
		if (!allowed || [run,inspection,dispatch,actor,workflow].join()!=="run,inspection,dispatch,issuer,workflow-id")
			throw Error("not this bound review");
		return current;
	}}));
	const ctx=context(async()=>{calls++;return {outcome:"changes",summary:"pkg/unit/replaced:1 — This implementation ignores its input."};});
	for(const args of [{...ctx.args,token:"forged"},{...ctx.args,inspection:"../forged"},{run:"run",inspection:"inspection"}])
		await assert.rejects(definition.run({...ctx,args:/** @type {Context["args"]} */ (args)}));
	assert.equal(reads,0);
	for(const change of [{runId:"other"}, {args:{...ctx.args,dispatch:"other"}}, {session:/** @type {Context["session"]} */({sessionId:"other"})}])
		await assert.rejects(definition.run({...ctx,...change}),/not this bound review/);
	for(const change of [{inspection:"other"},{component:""},{component:"different-valid-component"},{candidate:"HEAD"},{candidate:i.base},{prompt:""}]) {
		current={...packet,...change};await assert.rejects(definition.run(ctx));
	}
	current=packet;
	const {prompt,...pins}=packet, unguarded=createHash("sha256").update(JSON.stringify(pins)).update("\0").update(prompt).digest("hex");
	await assert.rejects(definition.run({...ctx,step:async()=>unguarded}),/tool guard was not recorded/);
	assert.equal(calls,0);
	const journal=new Map();ctx.step=async(key,fn)=>{
		if (!journal.has(key)) journal.set(key,await fn());return journal.get(key);
	};
	current=packet;assert.equal((await definition.run(ctx)).outcome,"changes");
	current=candidatePacket(root,{...i,task:"Review a different assignment."});await assert.rejects(definition.run(ctx),/original review subject changed/);
	allowed=false;await assert.rejects(definition.run(ctx),/not this bound review/);
	assert.equal(calls,1);
});

test("a parked review receives its original complete packet; a new review receives the scoped assignment",async t=>{
	const {root,i}=fixture(t),assigned="Preserve the original line endings.",old=candidatePacket(root,i),current=candidatePacket(root,i,Infinity,assigned);
	const {prompt,...pins}=old;
	/** @param {string} bytes */
	const subject=bytes=>createHash("sha256").update("packet-only-v1\0").update(JSON.stringify(pins)).update("\0").update(bytes).digest("hex");
	let budget=Buffer.byteLength(prompt),canRead=true;
	const definition=critiqueDefinition(()=>({async inspectionPacket(_run,_job,_ticket,_actor,_workflow,original){
		if(!canRead)fail("inspection_held","Original issuer held");
		return candidatePacket(root,i,budget,assigned,original);
	}}));
	/** @type {string[]} */ const delivered=[];
	const ctx=context(async bytes=>{delivered.push(String(bytes));return {outcome:"approved",summary:"pkg/unit/replaced:1: the generated line retains the required ending."};});
	const parked={...ctx,step:async()=>subject(prompt)},enriched={...ctx,step:async()=>subject(current.prompt)};
	assert.equal((await definition.run(parked)).outcome,"approved");
	assert.deepEqual(delivered,[prompt],"use the journaled bytes, not a new task or partial evidence");
	await assert.rejects(definition.run(ctx),/budget/,"a fresh review may not drop the task to fit");
	await assert.rejects(definition.run(enriched),/budget/,"an already enriched packet may not be downgraded either");
	budget--;await assert.rejects(definition.run(parked),/budget/,"the historical packet still needs to fit today's budget");
	budget=Infinity;
	await assert.rejects(definition.run({...ctx,step:async()=>"0".repeat(64)}),/original review subject/);
	canRead=false;await assert.rejects(definition.run(parked),{code:"inspection_held"});
	canRead=true;assert.equal((await definition.run(enriched)).outcome,"approved");assert.equal((await definition.run(ctx)).outcome,"approved");
	assert.deepEqual(delivered,[prompt,current.prompt,current.prompt]);assert.ok(current.prompt.includes(assigned));
});

import assert from "node:assert/strict";
import test from "node:test";
import {factory,git,put} from "../test/fixture.mjs";
import {openDatabase} from "./database.mjs";
import {buildTools} from "./tools.mjs";

const run="catalog",source=".foundry/catalog.json";
/** @param {import("node:test").TestContext} t */
function trial(t){
	return factory(t,run,source,{[source]:JSON.stringify({version:1,id:run,direction:"Deliver the item.",target:"refs/heads/main",
		productCheck:"product.mjs",seed:["item"],grains:[{id:"item",directory:"item",specification:"spec",boundary:["api"],check:"unit.mjs"}]}),
		spec:"Provide the item.",api:"Keep the requested value.","unit.mjs":"","product.mjs":""});
}
/** @param {Parameters<typeof buildTools>[0]} runtime @param {string} [actor] */
function surface(runtime,actor="owner"){
	const tools=buildTools(runtime,()=>actor,async()=>assert.fail("Unexpected permission status read"));
	return {tools,call:async(/** @type {string} */ name,/** @type {object} */ args,/** @type {string|undefined} */ agentId=undefined)=>{
		const tool=tools.find(t=>t.name===`foundry_${name}`);assert.ok(tool?.handler,`Missing tool foundry_${name}`);
		return tool.handler(args,{sessionId:actor,toolName:tool.name,toolCallId:"probe",arguments:args,agentId});
	}};
}

test("the native catalog routes an explicit review, check or grant to exactly its original operation",async t=>{
	const f=trial(t);await f.start();
	/** @type {unknown[]} */ const calls=[];
	const {tools,call}=surface({...f.owner,operation:async(op,args,actor)=>{
		calls.push([op,args,actor]);return f.owner.inspect({run},actor);
	}});
	for(const retired of ["iterate","rereview","recheck","pair","reuse","restore","diagnose","remediate"])
		assert.ok(!tools.some(t=>t.name===`foundry_${retired}`),`${retired} is still a second public route`);
	const source={commit:"snapshot",file:"spec",excerpt:"item"},previous={check:"last",candidate:"candidate",phases:["before","after"]};
	const observer={grain:"item",pair:"pair",file:"observer",blob:"old",previous};
	for(const [tool,choice,args,op] of /** @type {const} */ ([
		["review","compare",{directory:"item",receipt:"goal",blob:"reference",question:"Missing item?",source},"iterate"],
		["review","retry",{review:"failed-review"},"rereview"],
		["check","recover",{check:"unstarted"},"recheck"],
		["check","observe",{check:"original",product:"product",harness:["tests"],current:["item"]},"recheck"],
		["check","repeat",{check:"original",product:"product",after:"latest"},"recheck"],
		["check","pair",{grain:"item",failed:"failed",checkpoint:"checkpoint",goal:"goal",retainer:"other",candidate:"candidate",component:"component"},"pair"],
		["grant","inspectBaseline",{grains:["item"]},"inspectBaseline"],
		["grant","input",{grain:"item",blob:"reference"},"input"],
		["grant","draft",{check:"signed-stop",files:["item/value"]},"draft"],
		["grant","repairBaseline",{grains:["item"]},"repairBaseline"],
		["grant","reuse",{grain:"item",check:"failed",candidate:"candidate",blob:"offered"},"reuse"],
		["grant","restore",{from:"old",historical:"then",retainer:"owner",to:"fresh",checkpoint:"now",goal:"goal"},"restore"],
		["grant","observer",observer,"diagnose"],
		["grant","approveObserver",{...observer,preview:"draft"},"diagnose"],
		["grant","production",{diagnostic:"check",candidate:"candidate",checkpoint:"checkpoint",goal:"goal",producer:"item",files:["one"],task:"Fix one file"},"remediate"],
		["grant","inherited",{check:"failed",blob:"reference"},"inherit"],
		["grant","owned",{check:"failed",blob:"reference"},"owned"],
		["grant","evaluator",{check:".foundry/goal.mjs",blob:"reference"},"evaluator"],
	])){
		assert.equal(typeof await call(tool,{run,[choice]:args}),"string");
		assert.deepEqual(calls.splice(0),[[op,{run,...args},"owner"]]);
	}
});

test("ambiguous, cross-mode and helper requests never reach a domain operation",async t=>{
	const f=trial(t);let calls=0;
	const {call}=surface({...f.owner,operation:async()=>{calls++;assert.fail("Unexpected domain operation");}});
	for(const [tool,args] of /** @type {const} */ ([
		["review",{run}],["review",{run,compare:{},retry:{review:"r"}}],["review",{run,retry:{run:"other",review:"r"}}],
		["review",{run,unknown:{review:"r"}}],["review",{run,constructor:{}}],
		["check",{run,repeat:{check:"c",product:"p"}}],["check",{run,recover:{check:"c",after:"x"}}],
		["check",{run,foreground:{assembly:"joined",check:"stopped",declarations:[{grain:"item",file:"item/check.sh",line:2}]}}],
		["grant",{run,inspectBaseline:{grains:["one"]},repairBaseline:{grains:["one"]}}],
		["grant",{run,input:{grain:"item",blob:"reference",worker:"replacement"}}],
		["grant",{run,draft:{check:"c",files:["item/value"],text:"owner-authored replacement"}}],
		["grant",{run,inherited:{check:"c",blob:"p"},owned:{check:"c",blob:"p"}}],
		["grant",{run,observer:{grain:"g",pair:"p",file:"f",blob:"b",preview:"not-an-approval"}}],
		["grant",{run,approveObserver:{grain:"g",pair:"p",file:"f",blob:"b"}}],
		["publish",{run,readBaselines:["g"]}],["publish",{run,file:"spec",to:["item"],baselines:["item"]}],
	])){
		assert.match(JSON.stringify(await call(tool,args)),/"resultType":"failure"/);assert.equal(calls,0);
	}
	assert.match(JSON.stringify(await call("check",{run,recover:{check:"c"}},"helper")),/subagents/i);assert.equal(calls,0);
});

test("a repeated start cannot lift an operator pause; only resume can continue the original writer",async t=>{
	const f=trial(t),{call}=surface(f.owner);
	assert.match(JSON.stringify(await call("resume",{source})),/No run to resume/i);
	assert.equal(typeof await call("start",{source}),"string");
	const [w]=f.workers.values();assert.ok(w);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const active=db.stamp(run);assert.equal(typeof await call("start",{source}),"string");assert.equal(db.stamp(run),active);
	assert.equal(typeof await call("pause",{run}),"string");
	const before=db.read(run),stamp=db.stamp(run);assert.equal(before?.active,false);
	assert.match(JSON.stringify(await call("start",{source})),/paused.*resume/i);
	assert.equal(db.stamp(run),stamp);assert.deepEqual(db.read(run),before);
	assert.equal(typeof await call("resume",{source,run}),"string");assert.equal(f.workers.size,1);
	put(w.cwd,"item/value","original");await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	const done=await f.status();assert.ok(done.qualified);assert.equal(git(f.root,"show",`${done.qualified}:item/value`),"original");
});

test("a repeated start cannot dispatch a ready reservation after a reload",async t=>{
	const f=trial(t);let mode="interactive",preflight=false;
	const first=f.runtime(f.root,{mode:async()=>mode,permissionBlocker:async()=>{
		if(preflight)mode="plan";preflight=true;return null;
	}});
	await f.start(first);first.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run)?.effects.find(e=>e.kind==="writer");assert.ok(original?.state==="ready" && !original.callId);
	const next=f.runtime(f.root),{call}=surface(next),stamp=db.stamp(run);
	assert.equal(typeof await call("start",{source}),"string");
	assert.equal(db.stamp(run),stamp);assert.equal(f.workers.size,0);
	next.turn("owner");await next.flush();
	const [w]=f.workers.values();assert.ok(w);assert.equal(db.read(run)?.effects.find(e=>e.id===original.id)?.nativeId,w.id);
});

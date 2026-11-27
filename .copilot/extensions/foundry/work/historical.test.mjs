import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { contents, goal, reached, rollout, run, source, terminal, writers } from "../test/cutover98.mjs";
import { git, put } from "../test/fixture.mjs";
import { canDispatch, issue } from "./native.mjs";
import { openClaims } from "./claims.mjs";
/** @typedef {import("./model.js").NativeCall} Check */
/** @typedef {import("./model.js").Run} Run */
/** @typedef {{check:string,reason:string,obligation?:{members:string[],position:number,predecessors:string[]}}} Projected */

test("an actual authorized 98 command closes at the same path; status and a second entry cannot execute it",async t=>{
	const o=await goal(t),{e}=o,before=o.row();o.upgrade();
	assert.equal(o.host("status",{params:{run}}).ok,true);assert.deepEqual(o.row(),before);
	const elsewhere=spawnSync(process.execPath,[fileURLToPath(new URL("./runner.mjs",import.meta.url)),o.f.root,run,e.id],{cwd:o.f.root,encoding:"utf8"});
	assert.equal(elsewhere.status,1);assert.deepEqual(o.row(),before);
	o.db.planAndSwap(run,()=>{});assert.deepEqual(o.row(),before);
	assert.throws(()=>o.db.mutateLocked(run,r=>{r.active=false;throw Error("abort");}),/abort/);assert.deepEqual(o.row(),before);
	const early=o.host("turn",{id:e.id,events:terminal(e,1)});assert.deepEqual(early.calls,[]);assert.deepEqual(o.row(),before);
	const pre=o.host("pre",{args:e.args,callId:e.callId});assert.deepEqual(o.row(),before);
	for(const bad of [{actor:"other"},{callId:"different"},{args:{...e.args,description:"Different arguments"}}])
		assert.equal(o.host("pre",{args:e.args,callId:e.callId,...bad}).ok,false);
	const res=o.shell(e);assert.equal(res.status,78,res.stderr);assert.equal(pre.ok,true,pre.message);assert.equal(contents(o.log),"");assert.deepEqual(o.keys(),[]);
	const after=o.row(),doc=JSON.parse(after.document),original=doc.effects.find((/** @type {Check} */ x)=>x.id===e.id);
	assert.deepEqual(original,JSON.parse(before.document).effects.find((/** @type {Check} */ x)=>x.id===e.id));
	assert.equal(doc.format,"foundry-run/3");assert.ok(!("nodes" in doc));assert.equal(doc.history[e.id].closure,"closed-before-runner-claim");
	assert.equal(o.shell(e).status,78);assert.deepEqual(o.row(),after);assert.equal(o.spool(e.id),undefined);
	/** @type {((r:Run)=>void)[]} */ const corrupt=[r=>{assert.ok(r.history);delete r.history[e.id];},
		r=>{assert.ok(r.history);r.history[e.id].settlement={kind:"terminal",request:r.history[e.id].request,turn:"invented",start:"a",end:"b",exit:1};},
		r=>{const c=r.effects.find(c=>c.id===e.id);assert.ok(c?.tool==="bash");c.attempt={version:1};},
		r=>{const c=r.effects.find(c=>c.id===e.id);assert.ok(c);c.args.command+=" ";}];
	for(const change of corrupt){
		assert.throws(()=>o.db.mutateLocked(run,change),{code:"corrupt_run"});assert.deepEqual(o.row(),after);
	}
	o.past();assert.equal(o.host("resume",{params:{source}}).code,"corrupt_run");assert.equal(o.host("start",{params:{source}}).code,"corrupt_run");
	assert.equal(o.shell(e).status,1);assert.deepEqual(o.row(),after);assert.deepEqual(o.keys(),[]);
});

test("a contradicted, unclaimed 98 slot is not closed, even by a proven sibling's first fence",async t=>{
	const o=await rollout(t,true);assert.ok("members" in o);const [known,unknown]=o.members;
	const s=o.read(),earned=s.effects.find(e=>e.kind==="goal" && e.receipt);assert.ok(earned?.kind==="goal");
	o.db.verifySigned(run,earned);
	const journal=new DatabaseSync(o.db.file+".outcomes");
	try{journal.prepare("INSERT INTO outcomes SELECT run,?,signature,document FROM outcomes WHERE run=? AND effect=?").run(unknown.id,run,earned.id);}
	finally{journal.close();}
	const contradiction=o.spool(unknown.id),prior=o.row();o.upgrade();
	const read=o.host("status",{params:{run}});assert.ok(read.ok,read.message);
	assert.ok(read.value.integrityHolds.some((/** @type {{effect:string}} */ h)=>h.effect===unknown.id));
	assert.equal(o.shell(unknown).status,1);assert.deepEqual(o.row(),prior);
	assert.equal(o.shell(known).status,78);assert.equal(o.read().history?.[known.id].closure,"closed-before-runner-claim");
	assert.equal(o.read().history?.[unknown.id],undefined);assert.equal(o.shell(unknown).status,1);
	assert.deepEqual(o.spool(unknown.id),contradiction);assert.deepEqual(o.keys(),[]);
});

test("no new or already issued check can dispatch or mint a key by presenting an undeclared version 3",async t=>{
	const o=await goal(t),raw=o.row();
	o.db.preview(run,r=>{
		const e=r.effects.find(e=>e.id===o.e.id);assert.ok(e?.tool==="bash" && e.callId);
		Object.assign(e,{attempt:{version:3}});delete e.verification;
		assert.equal(canDispatch(r,e),false,"a format number does not declare a grant");
		e.state="issued";assert.equal(issue(r,e,e.callId),false);
	});

	const claims=openClaims(o.f.root,run,o.e.id);
	try{assert.throws(()=>claims.claim(),{code:"unissued_check"});}finally{claims.close();}
	assert.deepEqual(o.row(),raw);assert.equal(o.spool(o.e.id),undefined);
});

test("verification never interprets an unknown attempt tag as the original v2 signature domain",async t=>{
	const o=await goal(t),{e}=o;const result=o.shell(e);assert.equal(result.status,0,result.stderr);
	const original=o.read().effects.find(c=>c.id===e.id);assert.ok(original?.tool==="bash" && original.receipt);o.db.verifySigned(run,original);
	const changed=structuredClone(original);Object.assign(changed,{attempt:{version:3}});
	assert.throws(()=>o.db.verifySigned(run,changed),{code:"wrong_outcome"});
});

test("conversion does not rewrite a 98 claim merely because its authenticated outcome arrived in the separate spool",async t=>{
	const o=await goal(t),{e}=o;assert.equal(o.shell(e).status,0);
	const effects=JSON.parse(o.row().document).effects;assert.ok(effects[0].runnerClaim && !effects[0].receipt);
	const signed=o.spool(e.id);assert.ok(signed);o.upgrade();assert.equal(o.host("pause",{params:{run}}).ok,true);
	assert.deepEqual(JSON.parse(o.row().document).effects,effects);assert.deepEqual(o.spool(e.id),signed);
	const late=o.read().effects.find(c=>c.id===e.id);assert.ok(late?.kind==="goal" && late.receipt?.exit===0);o.db.verifySigned(run,late);
});

test("a different issued writer's real same-path command fences a loaded 98 claimant in the same run",async t=>{
	const o=await rollout(t,true);assert.ok("members" in o);const [first,middle,last]=o.members,gate=join(o.dir,"parallel-claim");
	const old=o.racing(middle,{FOUNDRY_TEST_CLAIM_GATE:gate});let result;
	try{
		await reached(gate+".loaded");o.upgrade();assert.equal(o.shell(first).status,78);
		const h=o.read().history??assert.fail();
		for(const e of [first,middle,last])assert.equal(h[e.id].closure,"closed-before-runner-claim");
	}finally{writeFileSync(gate+".continue","");result=await old;}
	assert.equal(result.status,1);assert.match(result.stderr,/Invalid Foundry execution snapshot/);assert.deepEqual(o.keys(),[]);
	const [start,end]=terminal(middle,result.status);
	assert.deepEqual(o.host("turn",{actor:first.issuer,id:middle.id,events:[start,end]}).calls,[]);
	assert.equal(o.read().history?.[middle.id].settlement,undefined);
	const fresh=o.host("turn",{actor:middle.issuer,id:middle.id,holdFresh:true,events:[start,
		{...end,data:{...end.data,success:false,error:{code:"command_nonzero_exit"}}}]});
	const links=o.read().effects.filter(/** @returns {c is Check} */ c=>c.kind==="component" && c.attempt?.version===3 && c.attempt.previous===middle.id);
	assert.equal(links.length,1);assert.deepEqual(fresh.calls,[links[0].args]);assert.deepEqual(o.keys(),[]);
	const h=o.read().history??assert.fail(),p=h[middle.id].settlement;assert.ok(p?.kind==="terminal");assert.equal(p.exit,1);
	assert.equal(h[first.id].settlement,undefined);assert.equal(h[last.id].settlement,undefined);
	for(const e of [first,middle,last])assert.equal(o.spool(e.id),undefined);
});

test("a fenced ordinary 98 component waits for its own writer and finishes the same submitted bytes",async t=>{
	const o=await rollout(t,true);assert.ok("members" in o);const old=o.members[1],grain=old.grain??assert.fail();
	const prior=o.read(),n=prior.nodes[grain],launch=prior.effects.find(e=>e.kind==="writer" && e.nativeId===n.worker && e.grain===grain);assert.ok(launch);
	o.upgrade();const closed=o.shell(old);assert.equal(closed.status,78,closed.stderr);assert.deepEqual(o.keys(),[]);
	const events=terminal(old,78);
	assert.deepEqual(o.host("turn",{id:old.id,actor:"owner",events}).calls,[]);assert.equal(o.spool(old.id),undefined);
	const next=o.host("turn",{id:old.id,actor:old.issuer,events,review:"approved"});
	assert.ok(next.ok,next.message);assert.deepEqual(next.logs,[]);
	const s=o.read(),replacements=s.effects.filter(/** @returns {c is Check} */ c=>c.kind==="component" && c.attempt?.version===3 && c.attempt.previous===old.id);
	assert.equal(replacements.length,1,"the original writer's already-submitted component needs a verified successor, not a new writer");
	const [c]=replacements;assert.equal(c.commit,old.commit);assert.equal(c.issuer,old.issuer);assert.notEqual(c.callId,old.callId);assert.equal(c.receipt?.exit,0);
	assert.equal(s.nodes[grain].check,c.id);assert.equal(s.nodes[grain].worker,n.worker);assert.equal(s.nodes[grain].token,n.token);
	assert.equal(s.nodes[grain].candidate,n.candidate);
	const writer=s.effects.find(e=>e.id===launch.id);assert.ok(writer?.kind==="writer");
	const {finished,...unchanged}=writer;assert.deepEqual(unchanged,launch);assert.ok(finished && finished.component===c.id);
	const checked=s.products.find(p=>p.check===finished.product);assert.equal(checked?.outputs[grain],n.candidate);
	assert.deepEqual(s.effects.find(e=>e.id===old.id),old);assert.equal(o.spool(old.id),undefined);o.db.verifySigned(run,c);
	assert.ok(s.inspections?.some(i=>i.component===c.id && i.state==="approved" && i.workflow));
	assert.equal(next.permissions.filter((/** @type {{id:string}} */ p)=>p.id===c.args.shellId).length,1);
	assert.ok(o.members.filter(e=>e!==old).every(e=>!s.effects.some(c=>c.tool==="bash" && c.attempt?.version===3 && c.attempt.previous===e.id)));
	assert.deepEqual(o.host("turn",{id:old.id,actor:old.issuer,events,review:"approved"}).calls,[]);assert.ok(o.keys().includes(c.id));
});

test("98 SQL observes original and subsequently bound writers; a different explicit start is not a filename lock",async t=>{
	const o=await writers(t),{sql,e}=o,schema=o.schema();assert.equal(schema.protocol,13);
	const lookup=(/** @type {boolean} */ first,/** @type {boolean} */ second)=>{
		for(const [id,expected] of Object.entries({"first-writer":first,"second-writer":second,stranger:false})){
			assert.equal(sql.isWriter(id),expected);assert.deepEqual(sql.involving(id),expected?[run]:[]);
		}
	};
	lookup(true,false);assert.equal(sql.forResume(source,"owner")?.id,run);o.upgrade();
	const change=o.host("configure",{params:{run,revision:0,checkpointReviews:false}});
	assert.ok(change.ok,change.message);assert.throws(()=>sql.forResume(source,"owner"),{code:"corrupt_run"});lookup(true,false);
	const events=[{type:"tool.execution_start",id:"create",data:{toolName:e.tool,arguments:e.args,toolCallId:e.callId,turnId:"t"}},
		{type:"tool.execution_complete",id:"created",data:{toolCallId:e.callId,turnId:"t",success:true,result:{structuredContent:{project_session_id:"second-writer"}}}}];
	assert.deepEqual(o.host("turn",{id:e.id,events}).calls,[]);lookup(true,true);
	const prior=o.row(),historical=o.read();assert.ok(historical.nodes.two.worker==="second-writer");o.past();
	assert.throws(()=>sql.read(run),{code:"corrupt_run"});assert.throws(()=>sql.mutateLocked(run,()=>assert.fail("old write")),{code:"corrupt_run"});
	put(o.f.root,source,JSON.stringify({...o.brief,id:"separate"}));put(o.f.root,"goal.mjs","");
	git(o.f.root,"add",source,"goal.mjs");git(o.f.root,"commit","-qm","Activate a different brief ID at the same pathname");
	for(const actor of ["first-writer","second-writer"])
		assert.equal(o.host("start",{actor,params:{source}}).code,"worker_cannot_start");
	assert.equal(o.host("resume",{params:{source}}).code,"corrupt_run");assert.equal(o.findRow("separate"),undefined);
	const started=o.host("start",{params:{source}});assert.ok(started.ok,started.message);
	const fresh=sql.read("separate");assert.ok(fresh);assert.equal(fresh.policy.source,source);
	const oldIds=new Set(historical.effects.flatMap(e=>[e.id,e.callId,e.token].filter(Boolean)));
	assert.ok(fresh.effects.every(e=>!e.nativeId && ![e.id,e.callId,e.token].some(id=>oldIds.has(id))));
	assert.ok(Object.values(fresh.nodes).every(n=>n.state==="idle" && !n.worker && !n.token && !n.check));assert.equal(fresh.products.length,1);
	for(const check of fresh.effects)if(check.tool==="bash" && check.receipt)sql.verifySigned("separate",check);
	assert.deepEqual(sql.involving("owner"),["separate",run]);assert.throws(()=>sql.forResume(source,"owner"),{code:"run_conflict"});
	assert.equal(o.host("resume",{params:{source,run:"separate"}}).ok,true);
	assert.deepEqual(o.row(),prior);assert.deepEqual(o.schema(),schema);
});

test("late acknowledgements, incomplete history, a timeout and a refused shell never clear a closed original",async t=>{
	const o=await goal(t),{e}=o;o.upgrade();const closed=o.shell(e);assert.equal(closed.status,78);
	const [start,end]=terminal(e,closed.status),raw={resultType:"success",toolTelemetry:end.data.toolTelemetry};
	assert.deepEqual(o.host("post",{args:e.args,callId:e.callId,reply:raw}).calls,[]);
	for(const events of [[end],[start], [start,{...end,data:{...end.data,toolTelemetry:undefined}}],
		[start,{...end,data:{...end.data,turnId:"other"}}],[start,{...end,agentId:"nested"}],
		[{...start,data:{...start.data,toolName:"another-provider.bash"}},end],
		[start,{...start,data:{...start.data,arguments:{...e.args,shellId:"contradiction"}}},end],
		[start,{...end,data:{...end.data,toolTelemetry:{...raw.toolTelemetry,properties:{executionMode:"sync",shell_error_category:"timeout"}}}}],
		[start,{type:"permission.completed",id:"deny",data:{toolCallId:e.callId,result:{kind:"denied-by-rules"}}},end]]){
		assert.deepEqual(o.host("turn",{id:e.id,events}).calls,[]);assert.equal(o.read().history?.[e.id].settlement,undefined);
	}
	const denied={type:"permission.completed",id:"deny",data:{toolCallId:e.callId,result:{kind:"denied-by-rules"}}};
	assert.deepEqual(o.host("turn",{id:e.id,events:[start,denied]}).calls,[]);
	assert.deepEqual(o.read().history?.[e.id].settlement,{kind:"declined"});
	assert.deepEqual(o.host("turn",{id:e.id,events:[start,end]}).calls,[]);assert.deepEqual(o.read().history?.[e.id].settlement,{kind:"declined"});
	assert.equal(contents(o.log),"");assert.deepEqual(o.keys(),[]);assert.equal(o.spool(e.id),undefined);
});

test("an explicit refusal on the original native binding remains a negative decision after a late completion",async t=>{
	const o=await goal(t),{e}=o;o.upgrade();assert.equal(o.shell(e).status,78);
	assert.deepEqual(o.host("post",{args:e.args,callId:e.callId,reply:{resultType:"denied"}}).calls,[]);
	assert.deepEqual(o.read().history?.[e.id].settlement,{kind:"declined"});
	assert.deepEqual(o.host("turn",{id:e.id,events:terminal(e,78)}).calls,[]);
	assert.deepEqual(o.read().history?.[e.id].settlement,{kind:"declined"});assert.deepEqual(o.keys(),[]);
});

for(const claimed of [false,true])test(`archived untagged v1 at the actual path: ${claimed?"retain the original signature":"close without a key"}`,async t=>{
	const o=await goal(t,95),{e}=o;assert.equal(JSON.parse(o.row().document).format,undefined);
	if(claimed)assert.equal(o.shell(e).status,0);
	const row=o.row(),signed=o.spool(e.id);o.upgrade();assert.equal(o.host("status",{params:{run}}).ok,true);
	assert.deepEqual(o.row(),row);assert.deepEqual(o.spool(e.id),signed);
	if(claimed){
		assert.ok(o.host("pause",{params:{run}}).ok);const kept=o.read().effects.find(c=>c.id===e.id);
		assert.ok(kept?.tool==="bash" && kept.receipt);
		o.db.verifySigned(run,kept);assert.equal(kept.receipt.exit,0);assert.deepEqual(o.spool(e.id),signed);
		assert.equal(o.read().history?.[e.id],undefined);assert.deepEqual(o.keys(),[e.id]);
	}else{
		assert.equal(o.shell(e).status,78);assert.deepEqual(o.keys(),[]);assert.equal(contents(o.log),"");
		assert.equal(o.read().history?.[e.id].closure,"closed-before-runner-claim");assert.equal(o.spool(e.id),undefined);
	}
	assert.equal(JSON.parse(o.row().document).format,"foundry-run/3");o.past();assert.equal(o.host("resume",{params:{source}}).code,"corrupt_run");
});

for(const winner of ["entry","other-slot","original","original-interrupted"])test(`earned prefix and raced middle at the original 98 path: ${winner} wins`,async t=>{
	const o=await rollout(t);assert.ok("prefix" in o);const {prefix,middle,tail}=o,prior=o.row(),raw=JSON.parse(prior.document);
	const earned=o.spool(prefix.id),seal=o.prefixSeal(),gate=join(o.dir,"claim");
	if(winner==="original")writeFileSync(o.stop,"hold");
	const claimed=winner.startsWith("original");
	const before=o.racing(middle,winner==="original"?{}:{FOUNDRY_TEST_CLAIM_GATE:gate,...(claimed && {FOUNDRY_TEST_AFTER_CLAIM:"1"})});
	let result,deliveryExit;
	try{
		if(winner==="original"){
			const end=Date.now()+20000;
			while(!contents(o.log).includes("bravo")){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}
		}else await reached(gate+".loaded");
		o.upgrade();
		assert.equal(o.host("status",{params:{run}}).ok,true);
		if(winner==="entry"){
			deliveryExit=o.shell(middle).status;assert.equal(deliveryExit,78);
		}
		else{
			// The tail is the ONLY never-issued slot. Its normal issuer wake must
			// close the open middle too, before the already loaded 98 claimant resumes.
			const res=o.host("turn");assert.ok(res.ok,res.message);assert.deepEqual(res.calls,[]);
			assert.equal(JSON.parse(o.row().document).history?.[tail.id]?.closure,"never-issued");
			if(claimed)assert.notEqual(o.shell(middle).status,0);
		}
	}finally{writeFileSync(gate+".continue","");rmSync(o.stop,{force:true});result=await before;}
	const doc=JSON.parse(o.row().document);
	assert.equal(doc.format,"foundry-run/3");assert.equal(doc.history[tail.id].closure,"never-issued");
	assert.deepEqual(o.spool(prefix.id),earned);
	assert.deepEqual(o.read().effects.find(e=>e.id===prefix.id),prefix);
	assert.deepEqual(doc.effects.find((/** @type {Check} */ e)=>e.id===tail.id),raw.effects.find((/** @type {Check} */ e)=>e.id===tail.id));
	for(const [id,binding] of Object.entries(o.owners)){
		/** @type {Run["nodes"][string]} */ const n=o.read().nodes[id];assert.deepEqual([n.worker,n.generation,n.token,n.check],binding);
	}
	if(claimed){
		assert.equal(result.status,0,result.stderr);assert.equal(doc.history[middle.id],undefined);
		const signed=o.read().effects.find(e=>e.id===middle.id);assert.ok(signed?.tool==="bash" && signed.receipt);o.db.verifySigned(run,signed);
		const completed=winner==="original";assert.equal(signed.receipt.exit,completed?0:null);
		if(!completed)assert.match(signed.receipt.output,/Invalid Foundry execution snapshot/);
		assert.deepEqual(o.keys(),[prefix.id,middle.id]);assert.equal(contents(o.log),completed?"alpha\nbravo\n":"alpha\n");
		/** @type {Projected[]} */ const slots=o.host("status",{params:{run}}).value.historicalChecks;
		assert.deepEqual(slots.filter(s=>s.obligation).map(s=>s.check),completed?[tail.id]:[]);
	}else{
		assert.equal(result.status,1,result.stderr);assert.match(result.stderr,/Invalid Foundry execution snapshot/);
		assert.equal(doc.history[middle.id].closure,"closed-before-runner-claim");assert.ok(!doc.history[middle.id].settlement);
		assert.deepEqual(doc.effects.find((/** @type {Check} */ e)=>e.id===middle.id),raw.effects.find((/** @type {Check} */ e)=>e.id===middle.id));
		assert.deepEqual(o.keys(),[prefix.id]);assert.equal(contents(o.log),"alpha\n");assert.equal(o.spool(middle.id),undefined);
		assert.equal(contents(o.buildLog),"build\n","neither losing contender prepared the historical check");
		assert.equal(o.shell(middle).status,78,"a delayed entry recognizes the original fence");
		const observed=terminal(middle,deliveryExit??result.status);
		for(const events of [[],observed.slice(1),observed.slice(0,1),[{...observed[0],data:{...observed[0].data,arguments:{...middle.args,initial_wait:2}}},observed[1]]]){
			assert.deepEqual(o.host("turn",{id:middle.id,events}).calls,[]);assert.ok(!o.read().history?.[middle.id].settlement);
		}
		const done=o.host("turn",{id:middle.id,events:observed,holdFresh:true});assert.ok(done.ok,done.message);
		const p=o.read().history?.[middle.id].settlement;assert.ok(p?.kind==="terminal");assert.equal(p.exit,deliveryExit??result.status);
		const fresh=o.read().effects.filter(/** @returns {c is Check} */ c=>c.tool==="bash" && c.attempt?.version===3 && c.attempt.previous===middle.id);
		assert.equal(fresh.length,1);assert.deepEqual(done.calls,[fresh[0].args]);assert.equal(fresh[0].state,"uncertain");
		/** @type {Projected[]} */ const slots=o.host("status",{params:{run}}).value.historicalChecks;
		assert.deepEqual(slots.filter(s=>s.obligation),[]);assert.ok(!slots.some(s=>s.check===middle.id));
		assert.match(slots.find(s=>s.check===tail.id)?.reason??"",new RegExp(fresh[0].id));
		assert.deepEqual(o.host("turn",{id:middle.id,events:observed}).calls,[]);
		if(winner==="other-slot"){
			// The matched terminal envelope was from the losing, already-loaded 98 process (exit 1).
			// Deliver the one outstanding fresh shell, never a replacement for its uncertain call.
			assert.equal(o.shell(fresh[0]).status,0);assert.notEqual(o.shell(fresh[0]).status,0);
			const next=o.host("turn",{review:"approved"});assert.deepEqual(next.logs,[]);
			assert.equal(o.host("status",{params:{run}}).value.qualified,o.assembly);
			for(const c of o.read().effects)if(c.tool==="bash" && c.attempt?.version===3)o.db.verifySigned(run,c);
		}
	}
	const last=o.read().effects.find(e=>e.id===tail.id);assert.ok(last);assert.equal(last.callId,undefined);assert.equal(last.runnerClaim,undefined);
	assert.deepEqual(o.spool(prefix.id),earned);assert.deepEqual(o.prefixSeal(),seal);
});

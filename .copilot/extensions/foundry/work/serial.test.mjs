import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { contents, reached, rollout, run, terminal } from "../test/cutover98.mjs";
import { join } from "node:path";
import { git } from "../test/fixture.mjs";
import { checksum } from "./database.mjs";
import { digest } from "./values.mjs";
/** @typedef {import("./model.js").NativeCall} Check */
/** @param {import("node:test").TestContext} t */
async function batch(t){
	const o=await rollout(t);assert.ok("prefix" in o);
	const old=o.read(),earned=o.spool(o.prefix.id),seal=o.prefixSeal(),originals=[o.middle,o.tail];
	const command=o.middle.args,prior=Object.fromEntries(Object.entries(old.nodes).map(([id,n])=>[id,structuredClone(n)]));
	const current=()=>o.read().effects.filter(/** @returns {c is Check} */ c=>c.tool==="bash" && c.attempt?.version===3);
	const invariant=()=>{
		const state=o.read();
		for(const e of [o.prefix,...originals]){
			const c=state.effects.find(c=>c.id===e.id);assert.deepEqual(c,e);
			if(e!==o.prefix)assert.equal(o.spool(e.id),undefined);
		}
		for(const n of Object.values(prior)){
			const launch=old.effects.find(e=>e.kind==="writer" && e.nativeId===n.worker && e.token===n.token);assert.ok(launch);
			assert.deepEqual(state.effects.find(e=>e.id===launch.id),launch);
		}
		assert.deepEqual(o.spool(o.prefix.id),earned);assert.deepEqual(o.prefixSeal(),seal);assert.deepEqual(o.middle.args,command);
	};
	return {...o,old,prior,current,invariant,close(){
		o.upgrade();const shell=o.shell(o.middle);assert.equal(shell.status,78,shell.stderr);
		assert.deepEqual(o.keys(),[o.prefix.id]);assert.deepEqual(o.host("turn",{id:o.middle.id,events:[]}).calls,[]);
		return terminal(o.middle,shell.status);
	}};
}

for(const decision of ["approve","deny","nonpassing","changes"])test(`continue the original serial approval through ${decision}`,async t=>{
	const o=await batch(t),events=o.close();
	if(decision==="nonpassing")writeFileSync(o.stop+".nonpassing","signed check must fail");
	const trace=join(o.dir,"current-loads");
	const result=o.host("turn",{id:o.middle.id,events,review:decision==="changes"?"changes":"approved",denyFresh:decision==="deny",
		...(decision==="approve" && {traceNew:trace})});
	assert.ok(result.ok,result.message);assert.deepEqual(result.logs,[]);o.invariant();
	const state=o.read(),calls=o.current(),[middle,last,product,goal]=calls;
	assert.ok(middle?.attempt?.version===3);assert.equal(middle.attempt.previous,o.middle.id);
	assert.deepEqual(result.permissions.map((/** @type {{id:string}} */ p)=>p.id),calls.map(e=>e.args.shellId));
	const h=state.history??assert.fail();assert.equal(h[o.middle.id].settlement?.kind,"terminal");assert.equal(h[o.tail.id].closure,"never-issued");
	for(const e of calls){assert.equal(e.issuer,"owner");assert.ok(!("rollout" in e) && !("replacement" in e) && e.attempt?.version===3);
		if(e.receipt)o.db.verifySigned(run,e);}
	if(decision==="deny" || decision==="nonpassing"){
		assert.equal(calls.length,1);assert.deepEqual(state.nodes,o.prior);
		if(decision==="deny"){assert.equal(middle.state,"refused");assert.equal(middle.runnerClaim,undefined);assert.equal(middle.receipt,undefined);
			assert.equal(contents(o.log),"alpha\n");assert.deepEqual(o.keys(),[o.prefix.id]);}
		else {assert.equal(middle.receipt?.exit,1);assert.equal(contents(o.log),"alpha\nbravo\n");assert.deepEqual(o.keys(),[o.prefix.id,middle.id]);}
	}else{
		assert.equal(middle.receipt?.exit,0);assert.equal(last.receipt?.exit,0);assert.ok(last.attempt?.version===3 && last.attempt.previous===o.tail.id);
		const a=middle.attempt.facts.find(f=>f.kind==="build-group"),b=last.attempt.facts.find(f=>f.kind==="build-group");
		assert.deepEqual(a?.prior,[o.prefix.id]);assert.deepEqual(b?.prior,[o.prefix.id,middle.id]);
		assert.match(middle.receipt?.output??"",new RegExp(`reused .* from ${o.prefix.id}`));
		const ordered=[o.prefix,middle,last];
		if(decision==="changes"){assert.equal(calls.length,2);assert.deepEqual(state.nodes,o.prior);
			assert.ok(state.inspections?.some(i=>i.component===o.prefix.id && i.state==="changes"));
			assert.equal(contents(o.log),"alpha\nbravo\ncharlie\n");}
		else{
			assert.equal(calls.length,4);assert.equal(product.kind,"product");assert.equal(goal.kind,"goal");assert.equal(product.receipt?.exit,0);assert.equal(goal.receipt?.exit,0);
			assert.equal(product.commit,o.assembly);assert.equal(goal.commit,o.assembly);assert.ok(product.runnerClaim!==goal.runnerClaim);
			assert.deepEqual(Object.keys(product.receipt?.components??{}),ordered.map(e=>e.grain));
			assert.ok(Object.values(product.receipt?.components??{}).every(c=>c.exit===0 && c.inputs?.prepared));
			const checkpoint=state.products.at(-1);assert.equal(checkpoint?.check,product.id);assert.ok(checkpoint?.qualifiedAt);assert.equal(state.goal?.check,goal.id);
			for(const c of ordered){
				const id=c.grain??assert.fail(),n=state.nodes[id],i=state.inspections?.find(i=>i.component===c.id);
				assert.ok(i?.state==="approved" && i.dispatch && i.workflow && i.candidate===o.assembly && i.specification===o.prior[id].grain.specification);
				assert.equal(n.check,c.id);assert.equal(n.replaces,o.prior[id].candidate);assert.equal(n.candidate,o.assembly);assert.ok(!n.worker && !n.token);
				assert.equal(checkpoint?.outputs[id],o.assembly);assert.equal(git(o.f.root,"show",`${o.assembly}:entries/${id}/n`),"fixed");
			}
			assert.equal(contents(o.log),"alpha\nbravo\ncharlie\nalpha\nbravo\ncharlie\n");
			assert.equal(contents(o.buildLog),"build\nbuild\n");assert.deepEqual(o.keys(),[o.prefix.id,...calls.map(c=>c.id)]);
			const status=o.host("status",{params:{run}});assert.equal(status.value.qualified,o.assembly);
			for(const file of ["work/runner.mjs","work/historical.mjs","work/archive.mjs","work/seals.mjs"])
				assert.ok(contents(trace).includes(file),"must exercise actual mixed-source reader and current signer: "+file);
			const phases=new Set(contents(trace+".locks").trim().split("\n"));
			assert.deepEqual([...phases],["outside"],"do not traverse Git objects while the runner owns SQLite's exclusive claim transaction");
			t.diagnostic(JSON.stringify({run,approval:o.middle.rollout,assembly:o.assembly,target:checkpoint?.target,
				originals:[o.prefix.id,o.middle.id,o.tail.id],current:calls.map(c=>({id:c.id,kind:c.kind,grain:c.grain,exit:c.receipt?.exit})),
				prefixRowDigest:digest(o.spool(o.prefix.id)),prefixSealDigest:digest(o.prefixSeal()),settlement:h[o.middle.id].settlement}));
		}
	}
	const row=o.row();assert.deepEqual(o.host("turn",{id:o.middle.id,events,review:"approved"}).calls,[]);assert.deepEqual(o.row(),row);
});

test("a well-shaped but incomplete grant cannot spend a pending new attempt; the authentic same attempt continues",async t=>{
	const o=await batch(t),events=o.close();
	const held=o.host("turn",{id:o.middle.id,events,holdFresh:true});assert.equal(held.calls.length,1);
	const [e]=o.current();assert.ok(e?.attempt?.version===3 && e.callId && !e.runnerClaim);const sealed=o.row();
	const db=new DatabaseSync(o.db.file);t.after(()=>db.close());
	const write=(/** @type {string} */ doc)=>db.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc,checksum(doc),run);
	for(const kind of ["target","clear","build-group","signed","review","closed-slot","approved"]){
		const doc=JSON.parse(sealed.document),c=doc.effects.find((/** @type {Check} */ x)=>x.id===e.id),a=c.attempt;
		const i=a.facts.findIndex((/** @type {{kind:string}} */ f)=>f.kind===kind);assert.ok(i>=0);a.facts.splice(i,1);
		c.verification.grant=a.grant=digest(["foundry-power/v3",doc.id,doc.owner,doc.policy.source,c.check,a.source,a.use,a.facts]);
		try{write(JSON.stringify(doc));assert.notEqual(o.shell(e).status,0);assert.deepEqual(o.keys(),[o.prefix.id]);assert.equal(o.spool(e.id),undefined);}
		finally{write(sealed.document);}
	}
	for(const substitution of ["foreign approval","neighbor slot","different signed pass","wider scope","other hook","neighbor command","changed shell request"]){
		const doc=JSON.parse(sealed.document),c=doc.effects.find((/** @type {Check} */ x)=>x.id===e.id),a=c.attempt,d=c.verification;
		if(substitution==="foreign approval")a.source.id=doc.adoptions.find((/** @type {{id:string}} */ s)=>s.id!==a.source.id).id;
		if(substitution==="neighbor slot")a.previous=o.tail.id;
		if(substitution==="different signed pass"){
			const f=a.facts.find((/** @type {{kind:string,check?:string}} */ f)=>f.kind==="signed" && f.check===o.prefix.id);
			f.check=o.prior.alpha.check;f.commit=o.prior.alpha.candidate;
		}
		if(substitution==="wider scope")d.steps[0].inputs.scope.directories.push("entries/alpha");
		if(substitution==="other hook")d.steps[0].build.hook.blob=d.steps[0].inputs.checker.blob;
		if(substitution==="neighbor command")c.args={...o.tail.args};
		if(substitution==="changed shell request")c.args.initial_wait=5;
		d.grant=a.grant=digest(["foundry-power/v3",doc.id,doc.owner,doc.policy.source,c.check,a.source,a.use,a.facts]);
		try{write(JSON.stringify(doc));assert.notEqual(o.shell(e).status,0,substitution);assert.deepEqual(o.keys(),[o.prefix.id]);assert.equal(o.spool(e.id),undefined);}
		finally{write(sealed.document);}
	}
	assert.equal(o.shell(e).status,0);assert.notEqual(o.shell(e).status,0);
	const next=o.host("turn",{review:"approved"});assert.ok(next.ok,next.message);assert.deepEqual(next.logs,[]);
	assert.equal(o.host("status",{params:{run}}).value.qualified,o.assembly);assert.deepEqual(o.current().filter(c=>c.attempt?.version===3 && c.attempt.previous===o.middle.id).map(c=>c.id),[e.id]);
});

test("the already-claimed 98 middle finishes once and only its never-issued tail is replaced",async t=>{
	const o=await rollout(t);assert.ok("prefix" in o);const {middle,prefix,tail}=o,earned=o.spool(prefix.id);
	writeFileSync(o.stop,"wait");const underway=o.racing(middle,{});
	try{
		const end=Date.now()+20000;while(!contents(o.log).includes("bravo")){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10));}
		o.upgrade();assert.deepEqual(o.host("turn").calls,[]);assert.equal(o.read().history?.[middle.id],undefined);
	}finally{rmSync(o.stop,{force:true});assert.equal((await underway).status,0);}
	const original=o.read().effects.find(c=>c.id===middle.id);assert.ok(original?.kind==="component" && original.receipt?.exit===0);o.db.verifySigned(run,original);
	const prior=o.spool(middle.id),next=o.host("turn",{review:"approved"});assert.deepEqual(next.logs,[]);
	const s=o.read(),links=s.effects.filter(/** @returns {c is Check} */ c=>c.tool==="bash" && c.attempt?.version===3 && !!c.attempt.previous);
	assert.deepEqual(links.map(c=>c.attempt?.version===3 && c.attempt.previous),[tail.id]);
	assert.deepEqual(o.spool(middle.id),prior);assert.deepEqual(o.spool(prefix.id),earned);
	assert.equal(o.host("status",{params:{run}}).value.qualified,o.assembly);
});

test("an original serial decline cannot be replaced by a later terminal acknowledgement",async t=>{
	const o=await batch(t),events=o.close(),decline={type:"permission.completed",id:"decline",data:{toolCallId:o.middle.callId,result:{kind:"denied-by-rules"}}};
	assert.deepEqual(o.host("turn",{id:o.middle.id,events:[events[0],decline]}).calls,[]);
	assert.deepEqual(o.host("turn",{id:o.middle.id,events,review:"approved"}).calls,[]);
	assert.equal(o.read().history?.[o.middle.id].settlement?.kind,"declined");assert.deepEqual(o.current(),[]);assert.deepEqual(o.keys(),[o.prefix.id]);o.invariant();
});

for(const stage of ["issue","build"])test(`a moved target withholds the original continuation at ${stage}`,async t=>{
	const o=await batch(t),events=o.close(),target=git(o.f.root,"rev-parse","refs/heads/main");
	const response=o.host("turn",{id:o.middle.id,events,holdFresh:true,...(stage==="issue" && {moveBeforeIssue:run})});
	const [c]=o.current();assert.ok(c?.attempt?.version===3);const gate=join(o.dir,"before-build");
	if(stage==="issue"){
		assert.deepEqual(response.calls,[],"the stale native call must not be issued");assert.equal(c.callId,undefined);assert.equal(c.state,"ready");
		assert.notEqual(git(o.f.root,"rev-parse","refs/heads/main"),target);assert.deepEqual(o.keys(),[o.prefix.id]);
	}else{
		assert.equal(response.calls.length,1);
		const runner=o.racing(c,{FOUNDRY_TEST_CLAIM_GATE:gate,FOUNDRY_TEST_AFTER_CLAIM:"1"});
		try{await reached(gate+".loaded");git(o.f.root,"commit","--allow-empty","-qm","Synthetic target movement after key claim");}
		finally{writeFileSync(gate+".continue","");assert.equal((await runner).status,0);}
		const [original]=o.current();assert.equal(original.id,c.id);assert.equal(original.receipt?.exit,null);
		assert.match(original.receipt?.output??"",/target moved/);o.db.verifySigned(run,original);assert.deepEqual(o.keys(),[o.prefix.id,c.id]);
	}
	assert.equal(contents(o.buildLog),"build\n");assert.equal(contents(o.log),"alpha\n");o.invariant();
});

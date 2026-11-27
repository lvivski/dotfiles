import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { realpathSync } from "node:fs";
import test from "node:test";
import { factory, git, put, scriptedInspections, settleSubmitted } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { preparePublication } from "./artifacts.mjs";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { extend, machine } from "./machine.mjs";

for(const scenario of ["explicit","requested blob","rule extension","already offered","wrong recipient","decline","change during approval","revoked permission","denied delivery","uncertain delivery","two missing inputs","managed hold","moved before delivery","stale prepared delivery","exhausted"])test(`missing input reopens only the original writer / ${scenario}`,async t=>{
	const auto=["requested blob","rule extension","already offered","two missing inputs","managed hold"].includes(scenario),build=auto?factory:await historicalFactory(t,91);
	const run="catalog",source=".foundry/catalog.json",dir="checks/items",grain="verify-row",item=dir+"/proof",file="pinned rows.txt";
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Verify the requested row.",goalCheck:"goal.mjs",productCheck:"product.mjs",
		...(["two missing inputs","exhausted"].includes(scenario) && {limits:{repairs:scenario==="exhausted"?0:2}}),squads:[{id:"catalog",charter:"charter",areas:["checks"],checks:["unit.mjs"]}]}),
		".foundry/catalog/journey.md":"Look up the reference row.",charter:"Create only the assigned check.","product.mjs":"",
		"unit.mjs":`import {readFileSync} from "node:fs";if(readFileSync("${item}","utf8")!=="verified row")process.exit(1);`,
		"goal.mjs":`import {existsSync} from "node:fs";process.exit(existsSync("${item}")?0:1);`});
	await f.start();const review=f.scouts[0];
	await review.report({outcome:"regenerate",reason:"Missing check.",evidence:["charter"],grains:[{id:grain,task:"Verify the row in the supplied inventory.",directory:dir,check:"unit.mjs",needs:[]}]});
	const [w]=f.workers.values(),first=f.runtime(w.cwd),reason="The required row is not in my frozen packet.";
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	put(f.root,file,"verified row");const blob=git(f.root,"hash-object",file),claim={run,grain,blob};
	if(scenario==="already offered")await f.owner.operation("publish",{run,file,to:[dir]},"owner");
	await first.operation("submit",{run,token:w.token,missingInput:reason,...(auto && {inputBlob:blob})},w.id);
	const prior=read().nodes[grain];assert.equal(prior.state,"blocked");assert.ok(!prior.priorSource && !prior.preview && !prior.check && !prior.candidate);
	const p=f.root;
	if(auto && scenario!=="already offered")db.mutateLocked(run,preparePublication(realpathSync(p),read(),"owner",{file,to:[dir]})); // Crash after capture, before the owner's wake.
	else if(scenario!=="already offered")await f.owner.operation("publish",{run,file,to:[scenario==="wrong recipient"?"checks/other":dir]},"owner");
	if(!auto){
		f.owner.turn("owner");await f.owner.flush();assert.deepEqual(read().nodes[grain],prior);
		await assert.rejects(f.owner.operation("input",claim,"owner"),{code:"unknown_operation"});
	}
	f.owner.close();first.close();
	const inspections=scriptedInspections(p),writer=settleSubmitted(f.runtime(w.cwd,inspections,createRuntime));let forms=0,receipts=0;
	const empty=machine("recovery","select",{select:[]});
	if(scenario==="rule extension"){
		const unselected=f.runtime(p,{},(dir,host)=>createRuntime(dir,host,empty));
		unselected.turn("owner");await unselected.flush();unselected.close();
		assert.deepEqual(read().nodes[grain],prior,"no rule selected an operation on this edition");
		const before=read(),wrong=extend(empty,{select:[{on:"reference",action:"draft"}]});
		assert.throws(()=>f.runtime(p,{},(dir,host)=>createRuntime(dir,host,wrong)),/draft.*reference|reference.*draft/,
			"the edition has no author subject for a reference event");
		assert.deepEqual(read(),before,"an incompatible edition cannot spend an input stop asking an unrelated operator question");
	}
	const rule=scenario==="rule extension" ? extend(empty,{select:[{on:"reference",when:["targeted","!approved"],action:"input"}]}) :
		scenario==="already offered" ? extend(empty,{select:[{on:"reference",action:"input"}]}) : undefined;
	let allowed=scenario!=="managed hold",moved=false,routeCalls=0;
	const owner=f.runtime(p,{...inspections,permissionBlocker:async()=>{
		if(scenario==="moved before delivery" && !moved && read().effects.some(e=>e.kind==="repair" && e.input)){
			moved=true;put(p,"charter","Changed scope");git(p,"commit","-qam","Move after approval");
		}
		return allowed?null:{scope:"session",message:"Await permission"};
	},
		autoConfirm:async()=>true,confirm:async msg=>{
		forms++;assert.ok([w.id,grain,blob,dir,"unit.mjs",reason].every(v=>msg.includes(v)));assert.ok(!msg.includes(w.token));
		if(scenario==="change during approval"){put(f.root,"charter","New requirement.");git(f.root,"commit","-qam","Change contract");}
		if(scenario==="revoked permission")allowed=false;
		return scenario!=="decline";
	},execute:async(tool,args,key)=>{
		if(tool==="send_session_message" && String(args.message).includes(blob)){
			routeCalls++;
			if(scenario==="stale prepared delivery" && routeCalls===1)return {resultType:"failure",error:"This session management tool is disabled"};
			receipts++;assert.equal(args.session_id,w.id);const n=writer.inspect({run},w.id).nodes.find(n=>n.grain===grain);assert.ok(n?.token);
			await assert.rejects(writer.operation("submit",{run,token:n.token,usedArtifacts:[blob]},w.id),{code:"dispatch_held"});
			if(scenario==="denied delivery")return {resultType:"denied"};
			if(scenario==="uncertain delivery")return {resultType:"unknown"};
		}
		return f.execute(tool,args,key);
	}},(dir,host)=>createRuntime(dir,host,rule));
	if(scenario==="already offered"){
		owner.turn("owner");await owner.flush();assert.equal(read().nodes[grain].state,"blocked");assert.equal(receipts,0);assert.equal(forms,0);return;
	}
	if(!auto){
		await assert.rejects(owner.operation("input",claim,w.id),{code:"foreign_run"});
		await assert.rejects(owner.operation("input",{...claim,blob:f.tip},"owner"),{code:"missing_artifact"});
		if(scenario==="wrong recipient"){await assert.rejects(owner.operation("input",claim,"owner"),{code:"missing_artifact"});assert.equal(forms,0);return;}
		if(scenario==="exhausted"){await assert.rejects(owner.operation("input",claim,"owner"),{code:"limit"});assert.equal(forms,0);return;}
		if(["decline","change during approval","revoked permission"].includes(scenario)){
			await assert.rejects(owner.operation("input",claim,"owner"));assert.equal(forms,1);assert.deepEqual(read().nodes[grain],prior);assert.equal(receipts,0);return;
		}
		await owner.operation("input",claim,"owner");
	}
	if(scenario==="managed hold"){
		owner.turn("owner");await owner.flush();assert.equal(read().nodes[grain].state,"blocked");assert.equal(receipts,0);allowed=true;
	}
	owner.turn("owner");await owner.flush();const after=read(),notice=after.effects.find(e=>e.kind==="repair" && e.input);
	assert.ok(notice?.kind==="repair" && notice.input,"same writer did not receive a new scoped grant");
	assert.deepEqual(notice.input.prior,prior);assert.equal(notice.input.blob,blob);assert.equal(notice.input.review,review.id);
	if(scenario==="moved before delivery" || scenario==="stale prepared delivery"){
		if(scenario==="stale prepared delivery"){
			assert.equal(notice.state,"ordinary");put(p,"charter","Changed scope");git(p,"commit","-qam","Move after native refusal");
			await assert.rejects(owner.pre(notice.tool,notice.args,"owner","stale-prepared"),{code:"unreserved_call"});
			owner.turn("owner");await owner.flush();
		} else assert.ok(moved);
		assert.equal(receipts,0);let state=read(),held=state.effects.find(e=>e.id===notice.id);
		assert.equal(held?.state,"withdrawn");assert.deepEqual(state.nodes[grain],prior);assert.equal(forms,1);
		if(scenario==="stale prepared delivery")assert.ok(held?.callId);else assert.equal(held?.callId,undefined);
		await assert.rejects(writer.operation("submit",{run,token:notice.token},w.id),{code:"stale_assignment"});
		git(p,"update-ref","refs/heads/main",f.tip,git(p,"rev-parse","HEAD")); // Restore exactly the approved pins in this disposable repo.
		owner.turn("owner");await owner.flush();state=read();const next=state.nodes[grain];assert.equal(next.state,"writing");
		assert.equal(next.worker,w.id);assert.equal(forms,1);assert.equal(receipts,1);assert.notEqual(next.token,notice.token);
		put(w.cwd,item,git(w.cwd,"cat-file","blob",blob));await writer.operation("submit",{run,token:next.token},w.id);owner.turn("owner");await owner.flush();
		assert.ok(owner.inspect({run},"owner").qualified);return;
	}
	if(scenario==="denied delivery"){assert.deepEqual(after.nodes[grain],prior);assert.equal(notice.state,"refused");owner.turn("owner");await owner.flush();assert.equal(receipts,1);return;}
	const n=after.nodes[grain];assert.equal(n.worker,w.id);assert.equal(n.generation,prior.generation);assert.deepEqual(n.grain,prior.grain);assert.deepEqual(n.inputs,prior.inputs);
	if(scenario==="uncertain delivery"){
		assert.equal(notice.state,"uncertain");await assert.rejects(writer.operation("preview",{run,token:n.token},w.id),{code:"dispatch_held"});
		owner.turn("owner");await owner.flush();assert.equal(receipts,1);assert.equal(read().nodes[grain].check,undefined);return;
	}
	assert.equal(n.state,"writing");assert.notEqual(n.token,w.token);assert.ok(!n.preview && !n.candidate && !n.check && !n.priorSource);
	assert.equal(forms,auto?0:1);assert.equal(f.workers.size,1);assert.ok(!after.effects.some(e=>e.kind==="component"));
	await assert.rejects(writer.operation("submit",{run,token:w.token},w.id),{code:"stale_assignment"});
	let token=n.token;
	if(scenario==="two missing inputs"){
		put(p,file,"second row");const other=git(p,"hash-object",file);
		await writer.operation("submit",{run,token,missingInput:"Need the next row.",inputBlob:other},w.id);
		await owner.operation("publish",{run,file,to:[dir]},"owner");
		const fresh=read().nodes[grain];assert.equal(fresh.state,"writing");assert.notEqual(fresh.token,token);assert.equal(fresh.worker,w.id);
		token=fresh.token;
	}
	await assert.rejects(owner.operation("input",claim,"owner"),{code:"stale_assignment"});assert.equal(forms,auto?0:1);
	for(const edit of [/** @param {import("./model.js").Node} v */ v=>{v.worker="other-writer";},
		/** @param {import("./model.js").Node} v */ v=>{v.grain.task="A different task";}]){
		const altered=structuredClone(after);edit(altered.nodes[grain]);assert.throws(()=>decode(altered),{code:"corrupt_run"});
	}
	put(p,file,"different working-copy bytes");put(w.cwd,item,git(w.cwd,"cat-file","blob",blob));
	await writer.operation("submit",{run,token,...(!auto && {usedArtifacts:[blob]})},w.id);owner.turn("owner");await owner.flush();
	const end=read(),qualified=owner.inspect({run},"owner").qualified;assert.ok(qualified);
	assert.equal(git(p,"show",`${qualified}:${item}`),"verified row");
	assert.ok(end.inspections?.some(i=>i.component===end.nodes[grain].check && i.state==="approved"));
	assert.equal(end.products.at(-1)?.commit,qualified);assert.equal(end.goal?.commit,qualified);
	const component=end.effects.find(e=>e.id===end.nodes[grain].check);assert.ok(component?.kind==="component");
	assert.deepEqual(component.usedArtifacts,auto?undefined:[blob]);
	assert.deepEqual(end.effects.find(e=>e.id===notice.id),notice);
	const forged=structuredClone(end),e=forged.effects.find(e=>e.id===notice.id);assert.ok(e?.kind==="repair" && e.input);e.input.blob=f.tip;
	assert.throws(()=>decode(forged),{code:"corrupt_run"});
});

for(const phase of ["outstanding goal","in-flight join","failed join"])test(`a missing reference reaches the original writer across a sibling's ${phase}`,async t=>{
	const prepared=phase!=="outstanding goal";
	const build=await historicalFactory(t,91),run="catalog",source=".foundry/catalog.json",dir="output/lookup",other="output/index",file="rows.txt";
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Index and look up a row.",
		productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"outputs",areas:["output"],charter:"brief",checks:["unit.mjs"]}]}),
		".foundry/catalog/journey.md":"Use the index and the row.",brief:"Generate the two independent outputs.","unit.mjs":"",
		"product.mjs":phase==="failed join"?`import {existsSync} from "node:fs";if(existsSync("${other}/value")){console.error("Unattributed product failure");process.exit(1);}`:"",
		"goal.mjs":`import {existsSync as has} from "node:fs";process.exit(!has("${other}/value")?1:has("${dir}/value")?0:2);`});
	await f.start();
	await f.scouts[0].report({outcome:"regenerate",reason:"Both outputs are absent.",evidence:["brief"],
		grains:[["lookup",dir],["index",other]].map(([id,directory])=>({id,directory,task:`Build ${id}.`,check:"unit.mjs",needs:[]}))});
	const original=await f.status(),at=(/** @type {string} */ id)=>f.workers.get(original.nodes.find(n=>n.grain===id)?.worker??"")??assert.fail();
	const w=at("lookup"),s=at("index"),old=f.runtime(w.cwd);
	await old.operation("submit",{run,token:w.token,missingInput:"The row is absent from the supplied inputs."},w.id);
	put(f.root,file,"requested bytes");await f.owner.operation("publish",{run,file,to:[dir]},"owner");
	await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	old.close();f.owner.close();
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	const before=read().nodes.lookup,inspect=scriptedInspections(f.root),signal=new EventEmitter(),issued=once(signal,"issued"),release=once(signal,"release");
	let forms=0;
	const owner=f.runtime(f.root,{...inspect,confirm:async()=>{forms++;return true;},execute:async(tool,args,key)=>
		prepared && tool==="send_session_message" ? {resultType:"failure",error:"This session management tool is disabled"} : f.execute(tool,args,key)},createRuntime);
	const writer=settleSubmitted(f.runtime(w.cwd,inspect,createRuntime)),blob=git(f.root,"hash-object",file),claim={run,grain:"lookup",blob};
	if(prepared)await owner.operation("input",claim,"owner");
	const notice=read().effects.find(e=>e.kind==="repair" && e.input);
	const sibling=settleSubmitted(f.runtime(s.cwd,{...inspect,execute:async(tool,args,key)=>{
		if(tool==="bash" && String(args.description).includes(prepared?"joined product":"final goal")){signal.emit("issued");await release;}
		return f.execute(tool,args,key);
	}},createRuntime));
	put(s.cwd,other+"/value","index");
	const work=sibling.operation("submit",{run,token:s.token},s.id);
	try{
		await Promise.race([issued,work.then(()=>assert.fail("Sibling did not reach the expected check"))]);
		if(prepared){
			assert.equal(notice?.state,"ordinary");assert.ok(read().join);
			owner.turn("owner");await owner.flush();
			assert.deepEqual(read().effects.find(e=>e.id===notice?.id),notice,"a pending join must not spend or withdraw this reservation");
			if(phase==="in-flight join" && notice?.kind==="repair")
				await assert.rejects(owner.pre(notice.tool,notice.args,"owner","early-prepared"),{code:"dispatch_held"});
			signal.emit("release");await work;
		}
		if(phase==="failed join"){
			owner.turn("owner");await owner.flush();const state=read(),e=state.effects.find(e=>e.id===notice?.id);
			assert.equal(state.effects.find(e=>e.id===state.join?.check)?.receipt?.exit,1);
			assert.equal(e?.state,"withdrawn","a terminal failed join cannot monopolize the undelivered writer's slot");
			assert.deepEqual(state.nodes.lookup,before);assert.equal(forms,1);return;
		}
		const checkpoint=read().products.at(-1),goal=read().goal?.check;assert.ok(checkpoint && goal);assert.notEqual(checkpoint.commit,before.base);
		if(prepared){
			assert.ok(notice?.kind==="repair");
			await owner.pre(notice.tool,notice.args,"owner","prepared-delivery");
			owner.post("prepared-delivery",await f.execute(notice.tool,notice.args,"prepared-delivery"),"owner");await owner.flush();
		}else await owner.operation("input",claim,"owner");
		const body=read().nodes.lookup;assert.ok(body.token && body.token!==w.token);assert.equal(body.worker,w.id);assert.equal(body.generation,before.generation);
		if(!prepared)assert.equal(read().effects.find(e=>e.id===goal)?.receipt,undefined);
		put(w.cwd,dir+"/value",git(w.cwd,"cat-file","blob",blob));await writer.operation("submit",{run,token:body.token},w.id);
		if(!prepared)assert.equal(owner.inspect({run},"owner").qualified,null);
		signal.emit("release");await work;owner.turn("owner");await owner.flush();
		const end=read(),qualified=owner.inspect({run},"owner").qualified;assert.ok(qualified);
		assert.equal(git(f.root,"show",`${qualified}:${dir}/value`),"requested bytes");
		assert.equal(git(f.root,"show",`${qualified}:${other}/value`),"index");
		assert.equal(end.effects.find(e=>e.id===goal)?.receipt?.exit,2);
		assert.equal(end.effects.filter(e=>e.kind==="goal" && e.commit===checkpoint.commit).length,1);assert.equal(f.workers.size,2);
		assert.equal(forms,1);assert.equal(end.effects.filter(e=>e.kind==="repair").length,1);
	} finally {signal.emit("release");await work;}
});

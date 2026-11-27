import assert from "node:assert/strict";
import test from "node:test";
import { factory, git, put, scriptedInspections, settleSubmitted } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { offered, preparePublication } from "./artifacts.mjs";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { rootAt } from "./product.mjs";
import { decode } from "./snapshot.mjs";
import { requestedSource, sourceBinding, supplierRequests } from "./supplier.mjs";
import { prepareInput } from "./resupply.mjs";
import path from "node:path";

const run="catalog",source=".foundry/catalog.json",file="parts/source/row",target="parts/lookup";
/** @param {import("node:test").TestContext} t @param {typeof factory} build @param {boolean} dependent @param {boolean} [fixed] */
async function setup(t,build,dependent,fixed=false){
	const ids=["source","lookup"],grains=ids.map(id=>({id,directory:"parts/"+id,check:"unit.mjs",needs:dependent&&id==="lookup"?["source"]:[]}));
	const f=build(t,run,source,{[source]:JSON.stringify({id:run,direction:"Read the requested row.",target:"refs/heads/main",goalCheck:"goal.mjs",productCheck:"product.mjs",
		...(fixed ? {version:1,grains:grains.map(g=>({...g,specification:"brief",boundary:["contract"]})),squads:[{id:"entries",charter:"brief",grains:ids,agent:"assigned-writer"}]} :
			{version:2,squads:[{id:"entries",areas:["parts"],charter:"brief",checks:["unit.mjs"]}]})}),
		".foundry/catalog/journey.md":"Look up a row.",brief:"Create the assigned output.",contract:"Preserve the row.","product.mjs":"",
		"unit.mjs":`import {readFileSync as read} from "node:fs";if(process.env.FOUNDRY_GRAIN==="lookup" && read("${target}/value","utf8")!=="the row")process.exit(1);`,
		"goal.mjs":`import {existsSync as has} from "node:fs";process.exit(has("${target}/value")&&has("${file}")?0:1);`});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"The catalog is missing.",evidence:["brief"],grains:fixed?ids:grains.map(g=>({...g,task:`Create ${g.id}.`}))});
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	const worker=(/** @type {string} */ id)=>f.workers.get(read().nodes[id].worker??"")??assert.fail();
	const supplier=worker("source");
	put(supplier.cwd,file,"the row");const blob=git(supplier.cwd,"hash-object",file);
	if(dependent)await f.runtime(supplier.cwd).operation("submit",{run,token:supplier.token},supplier.id);
	return {f,db,read,supplier,blob,consumer:worker("lookup")};
}

for(const published of [false,true])test(`a producer reference needs its own assigning review, not an earlier mention / ${published?"checked":"draft"}`,async t=>{
	const {read,db}=await setup(t,factory,published),r=structuredClone(read());
	const n=r.nodes.source,consumer=r.nodes.lookup,at={grain:"source",file},s=requestedSource(r,consumer,at);
	const review=r.effects.find(e=>e.id===s.review),writer=r.effects.find(e=>e.id===s.assignment);
	assert.ok(review?.kind==="scout" && review.observation && writer?.kind==="writer");
	if(published){const c=r.effects.find(e=>e.id===s.component);assert.ok(c?.kind==="component");db.verifySigned(run,c);}
	assert.ok(sourceBinding(r,s));
	writer.permissionHold="later native permission";
	assert.throws(()=>requestedSource(r,consumer,at),{code:"stale_assignment"});
	assert.ok(sourceBinding(r,s),"a later hold did not undo the original assignment");
	delete writer.permissionHold;
	const mention={...review,id:review.id+"-mention",squad:"unrelated"};
	r.effects.splice(r.effects.indexOf(review),0,mention);
	assert.equal(requestedSource(r,consumer,at).review,review.id);
	assert.ok(!sourceBinding(r,{...s,review:mention.id}),"mentioning the output did not grant it");
	n.review=mention.id;
	assert.throws(()=>requestedSource(r,consumer,at),{code:"stale_assignment"});
	assert.ok(sourceBinding(r,s),"the changed live pointer did not rewrite the issuing review");
});

for(const typed of [true,false])test(`a reader-94 stopped consumer can accept its original producer's fresh reference, without an owner copy / ${typed?"exact request":"explicit native match"}`,async t=>{
	const {f,read,supplier,blob,consumer}=await setup(t,await historicalFactory(t,94),false);
	const original=f.runtime(consumer.cwd),sourceThread=f.runtime(supplier.cwd),args={run,file,to:[target],token:supplier.token};
	await original.operation("submit",{run,token:consumer.token,missingInput:"Need the row.",...(typed && {inputBlob:blob})},consumer.id);
	await sourceThread.operation("publish",args,supplier.id);
	await assert.rejects(f.owner.operation("input",{run,grain:"lookup",blob},"owner"),{code:"missing_artifact"});
	const old=read();assert.equal(old.nodes.lookup.state,"blocked");assert.ok(!old.nodes.lookup.preview&&!old.nodes.lookup.priorSource);
	original.close();sourceThread.close();f.owner.close();
	const inspections=scriptedInspections(f.root);let forms=0,approve=false;
	const owner=f.runtime(f.root,{...inspections,autoConfirm:async()=>true,confirm:async msg=>{
		assert.ok(!typed);forms++;for(const v of [file,blob,supplier.id,consumer.id])assert.ok(msg.includes(v));return approve;
	}},createRuntime);
	const writer=settleSubmitted(f.runtime(consumer.cwd,inspections,createRuntime)),producer=settleSubmitted(f.runtime(supplier.cwd,inspections,createRuntime));
	owner.turn("owner");await owner.flush();assert.equal(read().nodes.lookup.state,"blocked","old unbound working-copy metadata is not a grant");
	await producer.operation("publish",{...args,...(!typed && {forInput:"lookup"})},supplier.id);
	if(!typed){
		owner.turn("owner");await owner.flush();assert.equal(read().nodes.lookup.state,"blocked");assert.equal(forms,0);
		const advice=owner.inspect({run},"owner").recovery.find(a=>a.kind==="input" && a.grain==="lookup");
		assert.deepEqual(advice?.arguments,{run,input:{grain:"lookup",blob}},"show the exact native matching decision without asking the owner to republish");
		await assert.rejects(owner.operation("input",{run,grain:"lookup",blob},"owner"),{code:"approval_declined"});
		assert.equal(read().nodes.lookup.state,"blocked");approve=true;await owner.operation("input",{run,grain:"lookup",blob},"owner");
	}
	owner.turn("owner");await owner.flush();
	const state=read(),n=state.nodes.lookup;
	assert.equal(n.state,"writing","a fresh authenticated response should reopen this stopped consumer");
	assert.notEqual(n.token,consumer.token);assert.equal(n.worker,consumer.id);assert.deepEqual(n.inputs,old.nodes.lookup.inputs);
	const notice=state.effects.find(e=>e.kind==="repair" && e.input);assert.ok(notice?.kind==="repair" && notice.input && notice.state==="done");
	assert.ok(notice.input.offer!==undefined);const offer=state.artifacts?.[notice.input.offer];assert.equal(offer?.publisher,supplier.id);
	assert.equal(offer?.source?.assignment,state.effects.find(e=>e.kind==="writer" && e.grain==="source")?.id);
	assert.ok(offer?.source && !offer.source.component && offer.source.consumer==="lookup");
	assert.ok(!state.artifacts?.some(a=>a.publisher==="owner"));assert.equal(f.workers.size,2);
	put(supplier.cwd,file,"other draft");assert.equal(git(consumer.cwd,"cat-file","blob",blob),"the row");
	put(consumer.cwd,target+"/value",git(consumer.cwd,"cat-file","blob",blob));await writer.operation("submit",{run,token:n.token,usedArtifacts:[blob]},consumer.id);
	put(supplier.cwd,file,"source output");await producer.operation("submit",{run,token:supplier.token},supplier.id);
	owner.turn("owner");await owner.flush();assert.ok(owner.inspect({run},"owner").qualified);
	assert.deepEqual(read().nodes.lookup.inputs,{});
	assert.equal(read().effects.filter(e=>e.kind==="repair" && e.input).length,1);assert.equal(forms,typed?0:2);
});

for(const fixed of [false,true])test(`a requested checked source can publish only its original immutable candidate, not its worktree or another grant / ${fixed?"fixed":"chartered"}`,async t=>{
	const {f,read,supplier,consumer,blob}=await setup(t,factory,true,fixed);
	const writer=f.runtime(consumer.cwd),producer=f.runtime(supplier.cwd);
	const check=read().nodes.source.check,pin=read().nodes.lookup.inputs?.source;assert.ok(check&&pin);
	await writer.operation("submit",{run,token:consumer.token,missingInput:"Need this exact reference from the checked source.",inputBlob:blob,inputSource:{grain:"source",file}},consumer.id);
	const req=read().nodes.lookup.stop?.input?.source;assert.ok(req);
	assert.equal(req.component,check);assert.equal(req.revision,pin);
	const before=read().nodes.lookup,args={run,file,to:[target],token:supplier.token,forInput:"lookup"};
	const message=read().instructions?.find(e=>e.args.session_id===supplier.id && e.issuer===consumer.id);
	assert.ok(message?.state==="done","the requesting writer must reach the actual producer without an owner relay");
	assert.ok(String(message.args.message).includes(blob));assert.ok(!String(message.args.message).includes(supplier.token));
	const action=producer.inspect({run},supplier.id).recovery.find(row=>row.tool==="foundry_publish");
	assert.deepEqual(action?.arguments,args);
	assert.ok(!JSON.stringify(f.owner.inspect({run},"owner").recovery).includes(supplier.token));
	const [route]=[...supplierRequests(read())];assert.ok(route);
	assert.deepEqual([route.producer.worker,route.consumer.worker,route.blob,route.file,route.to,route.component,route.revision],
		[supplier.id,consumer.id,blob,file,[target],check,pin]);
	await assert.rejects(producer.operation("publish",args,consumer.id));await assert.rejects(f.owner.operation("publish",{...args,token:undefined},"owner"));
	await assert.rejects(producer.operation("publish",{...args,to:["parts"]},supplier.id));
	await assert.rejects(producer.operation("publish",{...args,file:"parts/source/other"},supplier.id));
	put(f.root,"duplicate","the row");await f.owner.operation("publish",{run,file:"duplicate",to:[target]},"owner");
	await assert.rejects(f.owner.operation("input",{run,grain:"lookup",blob},"owner"),{code:"missing_artifact"});
	assert.deepEqual(read().nodes.lookup,before);
	put(supplier.cwd,file,"unchecked new value");
	await producer.operation("publish",action.arguments,supplier.id);f.owner.turn("owner");await f.owner.flush();
	const state=read(),n=state.nodes.lookup,offer=state.artifacts?.at(-1);assert.ok(offer?.source);
	assert.equal(offer.blob,blob);assert.equal(offer.base,pin);assert.equal(offer.source.component,check);
	assert.deepEqual([...supplierRequests(state)],[]);
	assert.equal(n.state,"writing");assert.equal(n.worker,consumer.id);assert.deepEqual(n.inputs,{source:pin});
	const forged=structuredClone(state),last=forged.artifacts?.at(-1);assert.ok(last?.source);
	last.publisher=consumer.id;assert.throws(()=>decode(forged),{code:"corrupt_run"});
	put(consumer.cwd,target+"/value",git(consumer.cwd,"cat-file","blob",blob));await writer.operation("submit",{run,token:n.token},consumer.id);
	f.owner.turn("owner");await f.owner.flush();assert.ok(f.owner.inspect({run},"owner").qualified);
});

test("a supplier response cannot outlive either binding or be read by a different recipient",async t=>{
	const {f,read,supplier,consumer,blob}=await setup(t,factory,false),writer=f.runtime(consumer.cwd),publisher=f.runtime(supplier.cwd);
	const request={run,token:consumer.token,missingInput:"Need the source row.",inputBlob:blob,inputSource:{grain:"source",file}};
	await assert.rejects(writer.operation("submit",{...request,inputSource:{grain:"source",file:"outside"}},consumer.id),{code:"stale_assignment"});
	await writer.operation("submit",request,consumer.id);
	const before=read(),args={run,file,to:[target],token:supplier.token,forInput:"lookup"};
	assert.equal([...supplierRequests(before)].length,1);
	put(supplier.cwd,file,"wrong bytes");
	await assert.rejects(publisher.operation("publish",args,supplier.id),{code:"missing_artifact"});
	assert.equal(read().artifacts?.length??0,0);
	put(supplier.cwd,file,"the row");const captured=preparePublication(rootAt(supplier.cwd),before,supplier.id,args);
	for(const which of ["producer grant","consumer attempt","changed supporting grant","frozen producer","rebound worker","paused"]){
		const r=structuredClone(before);
		if(which==="producer grant")r.nodes.source.token="other-token";
		else if(which==="consumer attempt")r.nodes.lookup.token="other-attempt";
		else if(which==="changed supporting grant")r.nodes.lookup.supporting=["contract"];
		else if(which==="frozen producer")r.nodes.source.state="checking";
		else if(which==="rebound worker")r.nodes.source.worker="another-session";
		else r.active=false;
		assert.deepEqual([...supplierRequests(r)],[],which);assert.throws(()=>captured(r));assert.equal(r.artifacts?.length??0,0);
	}
	const same=structuredClone(before);captured(same);assert.equal([...supplierRequests(same)].length,0);
	const a=same.artifacts?.at(-1);assert.ok(a);
	assert.ok(offered(a,same.nodes.lookup));assert.ok(!offered(a,{...same.nodes.lookup,worker:"another-session"}));
	assert.ok(!offered(a,{...same.nodes.lookup,grain:{...same.nodes.lookup.grain,id:"replacement",directory:target+"/child"}}));
});

for(const when of ["before pooling","after pooling","historical unnamed stop"])test(`retrieve a checked dependency without borrowing its pooled writer / ${when}`,async t=>{
	const previous=process.env.FOUNDRY_POOLED_INPUT_FIXTURE;
	/** @type {typeof factory} */ const build=previous ? (await import(previous)).factory : when==="historical unnamed stop" ? await historicalFactory(t,94) : factory;
	const f=build(t,run,source,{[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Read the checked row and finish both outputs.",
		goalCheck:"goal.mjs",productCheck:"product.mjs",squads:[{id:"entries",areas:["parts"],charter:"brief",checks:["unit.mjs"]}]}),
		".foundry/catalog/journey.md":"Finish both outputs.",brief:"Produce the assigned output.","product.mjs":"",
		"unit.mjs":`import {readFileSync as read} from "node:fs";if(process.env.FOUNDRY_GRAIN==="lookup" && read("${target}/value","utf8")!=="checked row")process.exit(1);`,
		"goal.mjs":`import {existsSync as has} from "node:fs";process.exit(has("${file}")&&!has("parts/index/value")?2:has("${target}/value")&&has("parts/third/done")?0:1);`});
	let available=false;
	const idleWriter=async(/** @type {string} */ worker)=>available?f.workers.get(worker)?.cwd:undefined;
	const startOwner=f.runtime(f.root,{idleWriter});await f.start(startOwner);
	await startOwner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const job=(/** @type {string} */ id,/** @type {string[]} */ needs=[])=>({id,directory:"parts/"+id,task:`Create ${id}.`,check:"unit.mjs",needs});
	await f.scouts[0].report({outcome:"regenerate",reason:"The catalog is missing.",evidence:["brief"],grains:[job("source"),job("lookup",["source"]),job("index"),job("third",["index"])]});
	const db=openDatabase(f.root);t.after(()=>db.close());const state=()=>db.read(run)??assert.fail();
	const worker=(/** @type {string} */ id)=>f.workers.get(state().nodes[id].worker??"")??assert.fail();
	const first=worker("source"),publisher=f.runtime(first.cwd,{idleWriter});
	put(first.cwd,file,"checked row");const blob=git(first.cwd,"hash-object",file);
	await publisher.operation("submit",{run,token:first.token},first.id);await f.settle();
	const c=worker("lookup"),thread=f.runtime(c.cwd,{idleWriter}),want={run,token:c.token,missingInput:"Need the original checked row.",inputBlob:blob,inputSource:{grain:"source",file}};
	assert.notEqual(c.id,first.id);const pin=state().nodes.lookup.inputs?.source,component=state().nodes.source.check;assert.ok(pin&&component);
	if(when==="before pooling")await thread.operation("submit",want,c.id);
	else if(when==="historical unnamed stop")await thread.operation("submit",{run,token:c.token,missingInput:"Need the original checked row."},c.id);
	available=true;
	const index=worker("index"),indexWriter=f.runtime(index.cwd,{idleWriter});put(index.cwd,"parts/index/value","index");
	await indexWriter.operation("submit",{run,token:index.token},index.id);
	await f.settle();const reused=state().nodes.third,w=state().effects.find(e=>e.id===reused.workspace);
	assert.ok(w?.kind==="writer" && w.pooled && w.state==="done","the third assignment must have a confirmed native handoff");
	assert.equal(reused.worker,first.id);assert.notEqual(reused.token,first.token);assert.equal(f.workers.size,3);
	const location=(await publisher.operation("workspace",{run,token:reused.token},first.id)).nodes.find(n=>n.grain==="third")?.workspace;assert.ok(location);
	const root=path.join(first.cwd,location);put(root,"parts/third/done","unrelated draft");
	put(root,file,"different pooled checkout");put(first.cwd,file,"changed old checkout");
	const active=structuredClone(state()),lookup=active.nodes.lookup,at={grain:"third",file:"parts/third/done"};
	const own=requestedSource(active,lookup,at);
	assert.equal(own.assignment,w.id);assert.equal(own.worker,first.id);assert.equal(own.revision,reused.generation);
	assert.ok(sourceBinding(active,own),"the pooled writer has its own new producing grant");
	const claimed=active.effects.find(e=>e.id===w.id);assert.ok(claimed?.kind==="writer" && claimed.pooled);
	claimed.pooled.from=state().effects.find(e=>e.kind==="writer" && e.grain==="index")?.id??assert.fail();
	assert.throws(()=>requestedSource(active,lookup,at),{code:"stale_assignment"},"a different writer's completed assignment cannot lend this native session");
	assert.ok(!sourceBinding(active,own));
	const publish={run,token:first.token,file,to:[target],forInput:"lookup"};
	await assert.rejects(publisher.operation("publish",publish,first.id));await assert.rejects(publisher.operation("publish",{...publish,token:reused.token},first.id));
	if(previous || when==="historical unnamed stop"){
		if(when==="after pooling")await assert.rejects(thread.operation("submit",want,c.id),{code:"stale_assignment"});
		else {
			startOwner.turn("owner");await startOwner.flush();assert.equal(state().nodes.lookup.state,"blocked");
			await assert.rejects(startOwner.operation("input",{run,grain:"lookup",blob},"owner"),{code:"missing_artifact"});
		}
	}
	f.owner.close();startOwner.close();publisher.close();thread.close();indexWriter.close();
	const old=state(),signed=old.effects.find(e=>e.id===component),inspections=scriptedInspections(f.root);
	/** @type {string[]} */ const addressed=[];let forms=0;
	/** @type {typeof f.execute} */ const execute=async(tool,args,key)=>{if(tool==="send_session_message")addressed.push(String(args.session_id));return f.execute(tool,args,key);};
	const host={...inspections,execute},owner=f.runtime(f.root,{...host,confirm:async msg=>{
		forms++;assert.ok(when==="historical unnamed stop"&&[file,blob,pin,component].every(v=>msg.includes(v)));return true;
	}},createRuntime);
	const consumer=settleSubmitted(f.runtime(c.cwd,host,createRuntime));
	if(when==="after pooling"){
		await assert.rejects(consumer.operation("submit",{...want,inputBlob:git(f.root,"rev-parse",`${f.tip}:brief`)},c.id));
		await consumer.operation("submit",want,c.id);
	}
	const claim={run,grain:"lookup",blob,...(when==="historical unnamed stop" && {inputSource:{grain:"source",file}})},otherBlob=git(f.root,"rev-parse",`${f.tip}:brief`);
	const pooledId=w.id,verify=(/** @type {import("./model.js").NativeCall} */ e)=>db.verifySigned(run,e);
	for(const variant of ["wrong blob","wrong version","replacement","unreviewed","no independent review","unconfirmed handoff","missing from product"]){
		const r=structuredClone(state()),s=r.nodes.source;
		if(variant==="replacement"){delete r.nodes.source;r.nodes.replacement={...s,grain:{...s.grain,id:"replacement"}};}
		if(variant==="wrong version")s.candidate=f.tip;
		if(variant==="unreviewed")r.inspections=r.inspections?.filter(i=>i.component!==component);
		if(variant==="no independent review")delete r.inspections;
		if(variant==="unconfirmed handoff"){const call=r.effects.find(e=>e.id===pooledId);assert.ok(call?.kind==="writer");call.state="uncertain";delete call.nativeId;}
		if(variant==="missing from product"){const p=r.products.at(-1);assert.ok(p);delete p.outputs.source;}
		assert.throws(()=>prepareInput(f.root,r,"owner",{...claim,...(variant==="wrong blob" && {blob:otherBlob})},verify),variant);
	}
	const absent=new Error("missing original runner signature");
	assert.throws(()=>prepareInput(f.root,state(),"owner",claim,e=>{if(e.id===component)throw absent;verify(e);}),error=>error===absent);
	await assert.rejects(owner.operation("input",{...claim,inputSource:{grain:"source",file:"brief"}},"owner"),{code:"stale_assignment"});
	await assert.rejects(owner.operation("input",{...claim,inputSource:{grain:"index",file:"parts/index/value"}},"owner"),{code:"stale_assignment"});
	if(when==="historical unnamed stop")await owner.operation("input",claim,"owner");
	owner.turn("owner");await owner.flush();const resumed=state().nodes.lookup;
	assert.equal(resumed.state,"writing","recover the original stopped consumer from its checked input, without publishing from the retired grant");
	assert.equal(resumed.worker,c.id);assert.equal(resumed.generation,old.nodes.lookup.generation);assert.deepEqual(resumed.inputs,{source:pin});assert.notEqual(resumed.token,c.token);
	assert.ok(!state().artifacts?.length,"reading an existing dependency must not impersonate any publisher");
	const [notice,...other]=state().effects.filter(e=>e.kind==="repair" && e.input);
	assert.ok(notice?.kind==="repair" && notice.input?.dependency && !other.length);
	assert.equal(notice.input.offer,undefined);assert.equal(notice.input.dependency.pooled,w.id);
	assert.equal(notice.input.dependency.source.component,component);assert.equal(notice.input.dependency.source.revision,pin);
	assert.deepEqual(notice.input.prior.grain,resumed.grain);
	const forged=structuredClone(state()),bad=forged.effects.find(e=>e.id===notice.id);assert.ok(bad?.kind==="repair" && bad.input?.dependency);
	bad.input.dependency.pooled=component;assert.throws(()=>decode(forged),{code:"corrupt_run"});
	assert.deepEqual(state().effects.find(e=>e.id===component),signed);assert.deepEqual(state().nodes.third,reused);assert.equal(forms,when==="historical unnamed stop"?1:0);
	assert.ok(!addressed.includes(first.id));assert.deepEqual(state().instructions,old.instructions);assert.equal(state().nodes.source.check,component);
	const pooled=settleSubmitted(f.runtime(first.cwd,host,createRuntime));
	await assert.rejects(pooled.operation("publish",publish,first.id));await assert.rejects(pooled.operation("submit",{run,token:first.token},first.id));
	assert.equal(consumer.inspect({run},c.id).nodes.find(n=>n.grain==="lookup")?.suppliedInput,blob);
	put(c.cwd,target+"/value",git(c.cwd,"cat-file","blob",blob));await consumer.operation("submit",{run,token:resumed.token,usedArtifacts:[blob]},c.id);
	await pooled.operation("submit",{run,token:reused.token},first.id);owner.turn("owner");await owner.flush();
	const final=owner.inspect({run},"owner").qualified;assert.ok(final);
	assert.equal(git(f.root,"show",`${final}:${target}/value`),"checked row");assert.equal(git(f.root,"show",`${final}:parts/third/done`),"unrelated draft");
});

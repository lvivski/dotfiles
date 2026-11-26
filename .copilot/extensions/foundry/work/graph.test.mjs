import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, put, recoveryClock } from "../test/fixture.mjs";
import { historicalRuntime } from "../test/legacy-readers.mjs";
import { failedFinalDiagnostic } from "../test/ownership.mjs";
import { observe, parseObservation } from "./graph.mjs";
import { createRuntime } from "./runtime.mjs";
import { fixture, propose, run, stored } from "../test/release.mjs";
import { openDatabase } from "./database.mjs";

test("the new interpreter resumes the same paused dependency graph, tokens and signed assessment",async t=>{
	const previous=process.env.FOUNDRY_MACHINE_FIXTURE;
	const f=fixture(t,["producer","consumer"],`has("${stored}") && read("${stored}")==="checked"`,4,
		previous ? (await import(previous)).factory : undefined);
	await f.start();const [producer,consumer]=f.scouts, db=openDatabase(f.root);t.after(()=>db.close());
	await producer.report(propose("producer"));await consumer.report(propose("consumer",undefined,["producer"]));
	const original=db.read(run), p=f.workers.get(original?.nodes.producer.worker??"");assert.ok(original && p);
	const signed=original.effects.find(e=>e.kind==="goal");assert.ok(signed?.kind==="goal" && signed.receipt?.exit===1);
	db.verifySigned(run,signed);
	put(p.cwd,"producer/value","checked");
	await f.owner.operation("pause",{run},"owner");f.owner.close();
	const clock=recoveryClock(), issuer=f.runtime(f.root,{watchRecovery:clock.watch},createRuntime);
	issuer.sessionStart("owner",f.root);await clock.pulse(issuer,8);
	const paused=db.read(run);assert.ok(paused && !paused.active);
	assert.deepEqual(paused.nodes,original.nodes);assert.deepEqual(paused.effects,original.effects);
	await issuer.operation("resume",{source:original.policy.source},"owner");
	assert.equal(f.workers.size,1);
	await f.runtime(p.cwd,{},createRuntime).operation("submit",{run,token:p.token},p.id);
	const dependent=db.read(run)?.nodes.consumer,c=f.workers.get(dependent?.worker??"");assert.ok(c);
	put(c.cwd,stored,git(c.cwd,"show","HEAD:producer/value"));
	await f.runtime(c.cwd,{},createRuntime).operation("submit",{run,token:c.token},c.id);
	await clock.pulse(issuer,8);
	const done=issuer.inspect({run,detail:"proof"},"owner");
	assert.ok(done.qualified && done.goal?.receipt?.commit===done.qualified && done.products?.at(-1)?.receipt?.commit===done.qualified);
	assert.deepEqual(db.read(run)?.effects.find(e=>e.id===signed.id),signed);
	assert.equal(f.scouts.length,2);assert.equal(f.workers.size,2);
});

test("a late producer admits the original consumer report once, including after issuer reload",async t=>{
	const prior=process.env.FOUNDRY_PRIOR_FIXTURE;
	const f=fixture(t,["consumer","producer"],`has("${stored}") && read("${stored}")==="checked"`,4,
		prior ? (await import(prior)).factory : undefined);
	await f.start();
	const [consumer,producer]=f.scouts, db=openDatabase(f.root);t.after(()=>db.close());
	const report=propose("consumer",undefined,["producer"]);
	await consumer.report(report);
	const held=db.read(run), saved=held?.effects.find(e=>e.id===consumer.id);
	assert.ok(held && saved?.kind==="scout" && saved.state==="blocked");
	assert.equal(saved.error,"Unknown required output: producer");
	assert.deepEqual(held.nodes,{},"never admit a dangling edge");
	const originalGoal=held.effects.find(e=>e.kind==="goal");assert.ok(originalGoal?.receipt);
	await producer.report(propose("producer"));
	const started=db.read(run)?.nodes.producer;
	assert.ok(started?.worker);assert.equal(f.workers.size,1);
	if(prior)assert.equal(db.read(run)?.nodes.consumer,undefined,"old reader must leave this same report stranded");
	f.owner.close();
	const clock=recoveryClock(), issuer=f.runtime(f.root,{watchRecovery:clock.watch},createRuntime);
	issuer.sessionStart("owner",f.root);await clock.pulse(issuer,8);
	const now=db.read(run), admitted=now?.effects.find(e=>e.id===saved.id);
	assert.ok(now && admitted?.kind==="scout");
	assert.equal(admitted.state,"observed",admitted.error??"the reported producer is now present");
	const {error,...original}=saved;
	assert.deepEqual(admitted,{...original,state:"observed"});
	assert.equal(now.nodes.consumer.review,consumer.id);assert.equal(now.nodes.consumer.state,"waiting");
	assert.deepEqual(now.nodes.consumer.grain.needs,["producer"]);assert.deepEqual(now.nodes.producer,started);
	const p=f.workers.get(started.worker);assert.ok(p);
	put(p.cwd,"producer/value","checked");
	await f.runtime(p.cwd,{},createRuntime).operation("submit",{run,token:p.token},p.id);
	const bound=db.read(run)?.nodes.consumer, c=f.workers.get(bound?.worker??"");assert.ok(c);
	assert.equal(bound?.inputs?.producer,db.read(run)?.nodes.producer.candidate);
	put(c.cwd,stored,git(c.cwd,"show","HEAD:producer/value"));
	await f.runtime(c.cwd,{},createRuntime).operation("submit",{run,token:c.token},c.id);
	await clock.pulse(issuer,8);
	const done=issuer.inspect({run,detail:"proof"},"owner");
	assert.ok(done.qualified && done.goal?.receipt?.commit===done.qualified && done.products?.at(-1)?.receipt?.commit===done.qualified);
	assert.deepEqual(db.read(run)?.effects.find(e=>e.id===originalGoal.id),originalGoal);
	assert.equal(f.scouts.length,2);assert.equal(f.workers.size,2);
});

test("reverse-order fan-in waits for every declared producer and every checked pin",async t=>{
	const ids=["consumer","middle","peer","root"], f=fixture(t,ids,`has("${stored}")`,8);
	await f.start();
	const [leaf,mid,peer,root]=f.scouts, db=openDatabase(f.root);t.after(()=>db.close());
	await leaf.report(propose("consumer",undefined,["middle","peer"]));
	await mid.report(propose("middle",undefined,["root"]));
	await peer.report(propose("peer"));
	assert.deepEqual(Object.keys(db.read(run)?.nodes??{}),["peer"]);
	await root.report(propose("root"));
	const joined=db.read(run);assert.ok(joined);
	assert.deepEqual([joined.nodes.consumer.state,joined.nodes.middle.state],["waiting","waiting"]);
	assert.equal(f.workers.size,2);
	for(const id of ["root","middle","peer","consumer"]){
		const n=db.read(run)?.nodes[id],w=f.workers.get(n?.worker??"");
		const status=f.owner.inspect({run},"owner");
		assert.ok(n&&w,JSON.stringify({id,node:n,assignments:status.assignments,reviews:status.reviews.map(r=>[r.squad,r.state]),blocker:status.blocker}));
		if(id==="peer")assert.equal(db.read(run)?.nodes.consumer.worker,undefined);
		if(id==="consumer")assert.deepEqual(Object.keys(n.inputs??{}).sort(),["middle","peer","root"]);
		put(w.cwd,id==="consumer"?stored:`${id}/value`,id);
		await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	assert.ok(f.owner.inspect({run},"owner").qualified);assert.equal(f.scouts.length,4);assert.equal(f.workers.size,4);
});

test("a cycle of missing reports cannot admit itself; a producer cannot undo an operator pause",async t=>{
	const f=fixture(t,["consumer","peer","root"],`has("${stored}")`,6);
	await f.start();const [consumer,peer,root]=f.scouts;
	await consumer.report(propose("consumer",undefined,["root"]));
	await peer.report(propose("peer",undefined,["other"]));
	await root.report({...propose("root"),grains:[{...propose("root").grains[0],id:"other",needs:["peer"]}]});
	const clock=recoveryClock(), issuer=f.runtime(f.root,{watchRecovery:clock.watch});
	issuer.sessionStart("owner",f.root);await clock.pulse(issuer,8);
	assert.deepEqual(issuer.inspect({run},"owner").nodes,[]);assert.equal(f.scouts.length,3);

	const g=fixture(t,["consumer","producer"],`has("${stored}")`,4);
	await g.start();const [waiting,offered]=g.scouts;
	await waiting.report(propose("consumer",undefined,["producer"]));
	await g.owner.operation("pause",{run},"owner");
	await offered.report(propose("producer"));
	const paused=g.runtime(g.root,{watchRecovery:clock.watch});paused.sessionStart("owner",g.root);await clock.pulse(paused,8);
	assert.deepEqual(paused.inspect({run},"owner").nodes,[]);assert.equal(g.workers.size,0);
});

test("upgrading cannot refund a scout that already consumed the last writer's assignment",
	{skip:!process.env.FOUNDRY_PRIOR_FIXTURE},async t=>{
	const old=await import(String(process.env.FOUNDRY_PRIOR_FIXTURE));
	const f=fixture(t,["consumer","middle","peer","root"],`has("${stored}")`,8,old.factory);
	await f.start();const [leaf,mid,peer,root]=f.scouts, db=openDatabase(f.root);t.after(()=>db.close());
	await root.report(propose("root"));await mid.report(propose("middle",undefined,["root"]));
	await peer.report(propose("peer"));await leaf.report(propose("consumer",undefined,["middle","peer"]));
	for(const id of ["root","middle","peer"]){
		const w=f.workers.get(db.read(run)?.nodes[id].worker??"");assert.ok(w);
		put(w.cwd,`${id}/value`,id);await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	const before=db.read(run),oldStatus=f.owner.inspect({run},"owner");
	assert.ok(before && before.nodes.consumer.state==="waiting" && !before.nodes.consumer.worker);
	assert.deepEqual(oldStatus.assignments,{used:8,limit:8});f.owner.close();
	const clock=recoveryClock(), issuer=f.runtime(f.root,{watchRecovery:clock.watch},createRuntime);
	issuer.sessionStart("owner",f.root);await clock.pulse(issuer,8);
	const after=issuer.inspect({run},"owner");assert.deepEqual(after.assignments,oldStatus.assignments);
	assert.equal(after.qualified,null);assert.deepEqual(db.read(run)?.nodes,before.nodes);assert.deepEqual(db.read(run)?.products,before.products);
	assert.equal(f.workers.size,3);assert.equal(f.scouts.length,5);
});

test("a disjoint stopped writer's successor can publish while mixed ownership still holds release",async t=>{
	const {f,db,run,ledger,component,implementation,regression}=await failedFinalDiagnostic(t,"production successor");
	const held=ledger.nodes.selector.restoration, stopped=ledger.nodes.routes;
	assert.ok(held && component.commit && stopped.check && stopped.stop?.kind==="writer-relinquished");
	const old=await historicalRuntime(t,61), owner=f.runtime(f.root,{confirm:async()=>true},old);
	await owner.operation("remediate",{run,diagnostic:component.id,candidate:component.commit,checkpoint:held.checkpoint,goal:held.goal,
		producer:"buttons",files:[implementation,regression],task:"Check the activation route."},"owner");
	const repair=[...f.workers.values()].at(-1);assert.ok(repair);
	put(repair.cwd,regression,"draft awaiting a working input");
	await f.runtime(repair.cwd,{},old).operation("submit",{run,token:repair.token,missingInput:"The fixture did not expose the first control."},repair.id);
	const directory="unit/routes/keys", file="unit/routes/entry";
	put(f.root,"comparison","The checked route is inactive.");
	const offer=(await owner.operation("publish",{run,file:"comparison",to:[directory]},"owner")).artifacts.find(a=>a.file==="comparison");
	assert.ok(offer);
	owner.close();

	const prior=db.read(run);assert.ok(prior?.goal);
	const current=f.runtime(f.root,{confirm:async()=>true},createRuntime);
	const request={run,receipt:held.goal,directory,files:[file],blob:offer.blob,question:"Activate the current route.",
		successor:{from:"routes",check:stopped.check,to:"keys"},source:{commit:prior.goal.commit,file,excerpt:"inactive"}};
	await assert.rejects(current.operation("iterate",{...request,files:[file,implementation]},"owner"),{code:"ownership_transition"});
	assert.deepEqual(db.read(run),prior);
	await current.operation("iterate",request,"owner");await f.settle();
	const review=f.scouts.at(-1);assert.ok(review && review.prompt.includes("keys"));
	const report={outcome:"regenerate",reason:"The route is inactive on the checkpoint.",evidence:[file],
		grains:[{id:"keys",directory:{primary:directory,files:[file]},task:"Activate the route.",check:"route.mjs",needs:["core"]}]};
	const pending=db.read(run), scout=pending?.effects.find(e=>e.id===review.id);assert.ok(pending && scout?.kind==="scout");
	for (const overlap of [{...report,evidence:[file,implementation]},{...report,grains:[{...report.grains[0],needs:["buttons"]}]}]) {
		assert.throws(()=>observe(f.root,pending,scout,parseObservation(pending.policy.squads[0],overlap)),{code:"ownership_transition"});
	}
	await review.report(report);
	const bound=current.inspect({run},"owner").nodes.find(n=>n.grain==="keys");
	const writer=bound && f.workers.get(bound.worker??"");assert.ok(writer,"the reviewed successor must actually bind");
	assert.equal(readFileSync(path.join(writer.cwd,file),"utf8"),"inactive");
	put(writer.cwd,file,"active");put(writer.cwd,`${directory}/case`,"covered");
	await f.runtime(writer.cwd,{},createRuntime).operation("submit",{run,token:writer.token},writer.id);
	const end=db.read(run);assert.ok(end);
	const check=end.effects.find(e=>e.id===end.nodes.keys.check);assert.ok(check?.kind==="component" && check.receipt?.exit===0);
	db.verifySigned(run,check);assert.equal(git(f.root,"show",`${check.commit}:${file}`),"active");
	assert.equal(end.nodes.keys.state,"published");assert.equal(end.nodes.routes.check,stopped.check);
	for (const id of ["buttons","selector"]) assert.deepEqual(end.nodes[id],prior.nodes[id]);
	assert.deepEqual(end.effects.slice(0,prior.effects.length),prior.effects);
	assert.deepEqual(end.products,prior.products);assert.deepEqual(end.goal,prior.goal);
	assert.equal(current.inspect({run,detail:"proof"},"owner").qualified,null);
	assert.equal(readFileSync(path.join(repair.cwd,regression),"utf8"),"draft awaiting a working input");
});

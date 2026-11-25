import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { git, put } from "../test/fixture.mjs";
import { historicalRuntime } from "../test/legacy-readers.mjs";
import { failedFinalDiagnostic } from "../test/ownership.mjs";
import { observe, parseObservation } from "./graph.mjs";
import { createRuntime } from "./runtime.mjs";

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

import { markInspection } from "./inspections.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { factory, git, put, scriptedInspections } from "../test/fixture.mjs";
import { validDeliveries } from "./batch.mjs";
import { openDatabase } from "./database.mjs";
import { deliveryResult } from "./delivery.mjs";
import { currentInspection } from "./inspection.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";

const run="catalog", source=".foundry/catalog.json", ids=["names","dates","store"];
for (const outcome of ["pass","component","product","review blocker","review pending at reload","unmet goal","mixed","moved target","repinned checker"]) test(`deliver stopped tests on the original run: ${outcome}`,async t=>{
	const product=".foundry/catalog/product.mjs";
	const build=outcome==="pass" ? await historicalFactory(t,61) : factory;
	const f=build(t,run,source,{
		[source]:JSON.stringify({version:1,id:run,target:"refs/heads/main",direction:"Verify both catalog views.",limits:{repairs:0,assignments:4},
			productCheck:product,goalCheck:"goal.mjs",squads:[{id:"catalog",charter:"spec",grains:ids}],
			grains:ids.map(id=>({id,directory:id,specification:"spec",boundary:["api"],check:id==="store"?"store.mjs":"view.mjs"}))}),
		spec:"Keep both catalog checks.",api:"Read the current store.","store.mjs":"",
		"view.mjs":`await import("./"+process.env.FOUNDRY_DIRECTORY+"/suite.mjs");`,
		[product]:`if(Object.keys(JSON.parse(process.env.FOUNDRY_OUTPUTS)).length===3) process.exit(${outcome==="product"?1:0});`,
		"goal.mjs":`import {existsSync} from "node:fs"; process.exit(["names/suite.mjs","dates/suite.mjs","store/data"].every(existsSync)?${outcome==="unmet goal"?1:0}:1);`,
		...(outcome==="mixed" && {"dates/shipped":"original production"}),
	});
	await f.start();
	await f.scouts[0].report({outcome:"regenerate",reason:"Restore both checks.",evidence:["spec"],grains:ids});
	const start=await f.status();
	for (const id of ids) {
		const w=f.workers.get(start.nodes.find(n=>n.grain===id)?.worker ?? "");assert.ok(w);
		if (id==="store") put(w.cwd,"store/data","current production");
		else put(w.cwd,`${id}/suite.mjs`,`import {existsSync} from "node:fs";
			process.exit(!existsSync("store/data") ? 2 : ${outcome==="component" && id==="dates"} && existsSync("names/suite.mjs") ? 1 : 0);`);
		const writer=f.runtime(w.cwd);await writer.operation("submit",{run,token:w.token},w.id);await writer.flush();
	}
	const db=openDatabase(f.root);t.after(()=>db.close());
	const original=db.read(run), p=original?.products.at(-1);assert.ok(original?.goal && p);
	f.owner.close();
	const reviews=scriptedInspections(f.root);
	let hold=outcome==="review pending at reload";
	const inspectionState=async(/** @type {string} */ id)=>{
		const e=await reviews.inspectionState(id), i=db.read(run)?.inspections?.find(i=>i.id===e.result.inspection);
		assert.ok(i);
		if (i.grain!=="dates") return e;
		return hold ? {...e,status:"running",result:undefined} : outcome==="review blocker" ?
			{...e,result:{...e.result,outcome:"changes",summary:"This test skips its assertion."}} : e;
	};
	const host={confirm:async()=>true,...reviews,inspectionState};
	let owner=f.runtime(f.root,host,createRuntime);
	const reruns=[];
	for (const id of ids.slice(0,2)) {
		assert.equal(original.nodes[id].state,"blocked");
		const mixed=outcome==="mixed" && id==="dates";
		await owner.operation("recheck",{run,check:original.nodes[id].check,product:p.commit,
			harness:[mixed ? `${id}/suite.mjs` : id],current:mixed ? ["store","dates/shipped"] : ["store"]},"owner");
		const e=db.read(run)?.effects.at(-1);assert.ok(e?.kind==="rerun" && e.receipt?.exit===0);reruns.push(e.id);
	}
	const args={run,checkpoint:p.check,goal:original.goal.check,reruns};
	if (outcome==="repinned checker") {
		const side=path.join(path.dirname(f.root),"product-checker");
		git(f.root,"worktree","add","-q","--detach",side,f.tip);
		put(side,product,'console.log("replacement checker",process.env.FOUNDRY_OUTPUTS);');
		git(side,"commit","-qam","Update the product evaluator only");
		await owner.operation("repin",{run,kind:"product",from:f.tip,revision:git(side,"rev-parse","HEAD"),files:[product]},"owner");
		const repinned=db.read(run), checkpoint=repinned?.products.at(-1);assert.ok(checkpoint && repinned?.goal);
		assert.equal(checkpoint.commit,p.commit);assert.notEqual(checkpoint.check,p.check);
		await assert.rejects(owner.operation("deliver",args,"owner"),{code:"stale_assignment"});
		args.checkpoint=checkpoint.check;args.goal=repinned.goal.check;
	}
	const before=db.read(run);assert.ok(before);
	const declined=f.runtime(f.root,{confirm:async()=>false},createRuntime);
	await assert.rejects(owner.operation("deliver",args,"outsider"),{code:"foreign_run"});
	await assert.rejects(owner.operation("deliver",{...args,checkpoint:original.goal.check},"owner"),{code:"stale_assignment"});
	if (outcome==="mixed") {
		await assert.rejects(owner.operation("deliver",args,"owner"),{code:"ineligible_delivery"});
		assert.deepEqual(db.read(run),before);return;
	}
	await assert.rejects(declined.operation("deliver",args,"owner"),{code:"approval_declined"});
	assert.deepEqual(db.read(run),before);
	if (outcome==="moved target") {
		const racing=f.runtime(f.root,{confirm:async()=>{git(f.root,"commit","--allow-empty","-qm","Concurrent target update");return true;}},createRuntime);
		await assert.rejects(racing.operation("deliver",args,"owner"),{code:"unsettled_checkpoint"});
		assert.deepEqual(db.read(run),before);return;
	}
	if (outcome==="pass") {
		const issuer=f.runtime(f.root,{confirm:async()=>true,execute:async(tool,args,id)=>{
			const result=await f.execute(tool,args,id);
			await owner.operation("pause",{run},"owner");
			return result;
		}},createRuntime);
		await issuer.operation("deliver",args,"owner");issuer.close();
		const paused=db.read(run);assert.ok(paused && !paused.active);
		assert.deepEqual(paused.nodes,before.nodes);
		const issued=paused.effects.slice(before.effects.length);
		assert.equal(issued.length,1);assert.equal(issued[0].receipt?.exit,0);
		await f.runtime(f.root,{},createRuntime).operation("resume",{source},"owner");
	} else {await owner.operation("deliver",args,"owner");await owner.flush();}
	if (hold) {
		const parked=db.read(run);assert.ok(parked);
		assert.equal(parked.join,undefined);assert.deepEqual(parked.nodes,before.nodes);assert.deepEqual(parked.products,before.products);
		const i=parked.inspections?.find(i=>i.grain==="dates" && i.state==="issued");assert.ok(i?.workflow);
		assert.ok(currentInspection(parked,i));assert.equal(currentInspection(parked,{...i,task:"a different batch"}),false);
		assert.equal(currentInspection(parked,{...i,scope:{directories:["dates","store"],files:[]}}),false);
		const held=structuredClone(parked), review=held.inspections?.find(r=>r.id===i.id), batch=held.deliveries?.at(-1);assert.ok(review && batch);
		markInspection(review,"approved",{summary:"The second directory passes review."});review.permissionHold="issuer may not publish";
		deliveryResult(f.root,held,batch,f.tip);
		assert.equal(held.join,undefined);assert.deepEqual(held.nodes,parked.nodes);assert.deepEqual(held.effects,parked.effects);
		owner.close();hold=false;owner=f.runtime(f.root,host,createRuntime);
		owner.turn("owner");await owner.flush();
		const resumed=db.read(run)?.inspections?.find(x=>x.id===i.id);
		assert.equal(resumed?.state,"approved");assert.equal(resumed.workflow,i.workflow);assert.equal(resumed.dispatch,i.dispatch);
	}
	const end=db.read(run);assert.ok(end?.goal);
	const added=end.effects.slice(before.effects.length), components=added.filter(e=>e.kind==="component");
	assert.equal(components.length,2);
	for (const e of components) {assert.ok(e.kind==="component" && e.runnerClaim);db.verifySigned(run,e);}
	assert.equal(components[0].commit,components[1].commit);
	if (outcome==="pass") assert.equal(end.inspections,undefined,"upgrading a stopped run does not change its original authority");
	if (outcome==="unmet goal") {
		const d=end.deliveries?.at(-1);assert.ok(d);
		const approvals=end.inspections?.filter(i=>components.some(c=>c.id===i.component));
		assert.deepEqual(approvals?.map(i=>[i.grain,i.state,i.generation,i.base,i.candidate,i.scope]),
			ids.slice(0,2).map(id=>[id,"approved",p.commit,p.commit,d.assembly,{directories:[id],files:[]}]));
		for (const c of components) {
			/** @type {import("./model.js").Run} */ const missing=structuredClone(end);
			missing.inspections=missing.inspections?.filter(i=>i.component!==c.id);
			assert.equal(validDeliveries(missing),false,"a checked batch cannot lose either exact approval");
		}
	}
	const changed=structuredClone(end);assert.ok(changed.deliveries?.[0]);
	changed.deliveries[0].selected[0].rerun=reruns[1];
	assert.throws(()=>decode(changed),{code:"corrupt_run"});
	assert.deepEqual(end.effects.slice(0,before.effects.length),before.effects);
	assert.equal(f.workers.size,3);assert.equal(git(f.root,"rev-parse","HEAD"),f.tip);
	if (outcome==="component" || outcome==="product" || outcome==="review blocker") {
		assert.deepEqual(end.products,before.products);assert.deepEqual(end.nodes,before.nodes);assert.deepEqual(end.goal,before.goal);
		assert.equal(added.filter(e=>e.kind==="product").length,outcome==="product"?1:0);
		assert.equal(added.filter(e=>e.kind==="goal").length,0);
		if (outcome==="review blocker") {
			assert.ok(components.every(c=>c.receipt?.exit===0));
			assert.match(end.deliveries?.at(-1)?.error??"",/This test skips its assertion.*separate write grant/);
			assert.deepEqual(end.inspections?.filter(i=>components.some(c=>i.component===c.id)).map(i=>i.state),["approved","changes"]);
		}
		if (outcome==="component") {
			assert.ok(end.inspections?.every(i=>!components.some(c=>i.component===c.id)),"a failing assembly does not start publication review");
			const card=owner.readBoard(run,"owner").nodes.find(n=>n.id==="dates");
			assert.ok(card);
			assert.deepEqual([card.state,card.checked,card.passedOnBuild],["blocked",null,reruns[1]]);
			assert.deepEqual(card.attempts?.map(a=>[a.kind,a.status]),[
				["component","unavailable"],["rerun","passed"],["delivery","failed"]
			],"the later failure was on the combined delivery, not another check of the original candidate");
		}
		await assert.rejects(owner.operation("deliver",{...args,reruns:[...reruns].reverse()},"owner"),{code:"duplicate_delivery"});
		return;
	}
	const joined=end.products.at(-1);assert.ok(joined);
	assert.deepEqual(added.filter(e=>e.tool==="bash").map(e=>e.kind),["component","component","product","goal"]);
	assert.equal(joined.commit,components[0].commit);assert.equal(end.goal.commit,joined.commit);
	assert.equal(joined.outputs.store,p.outputs.store);
	assert.deepEqual(git(f.root,"diff","--name-only",p.commit,joined.commit).split("\n"),["dates/suite.mjs","names/suite.mjs"]);
	for (const id of ids.slice(0,2)) {
		assert.equal(end.nodes[id].state,"qualified");assert.equal(end.nodes[id].candidate,joined.commit);
		assert.equal(git(f.root,"rev-parse",`${joined.commit}:${id}`),git(f.root,"rev-parse",`${original.nodes[id].candidate}:${id}`));
	}
	assert.equal(!!joined.qualifiedAt,outcome!=="unmet goal");
	const report=owner.inspect({run,detail:"proof"},"owner");
	if(outcome==="pass"){
		// Reader 61 signed the old store verdict, not its scope wire. The later delivery
		// checked two other grains; it can't certify what was supplied to this capture.
		const originalStore=end.effects.find(e=>e.id===original.nodes.store.check);
		assert.ok(originalStore?.kind==="component" && originalStore.receipt?.exit===0 && !originalStore.receipt.inputs);
		db.verifySigned(run,originalStore);
		assert.equal(report.qualified,joined.commit);assert.equal(report.qualification,null);
		assert.match(report.qualificationUnavailable??"",/store.*historical scope protocol/);
	}else assert.equal(!!report.qualification,outcome!=="unmet goal");
	if (outcome==="repinned checker") assert.match(added.find(e=>e.kind==="product")?.receipt?.output ?? "",/replacement checker/);
});

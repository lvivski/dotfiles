import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { factory, git, put } from "./fixture.mjs";
import { openDatabase } from "../work/database.mjs";
import { prepareRestoration } from "../work/restoration.mjs";
import { createRuntime } from "../work/runtime.mjs";

for (const mode of ["prevent","legacy join","issued writer","restore issued","restore joined","restore pending","restore cited"]) test(`partial repartition of a checked mixed grant / ${mode}`,
	{skip:mode!=="prevent" && !process.env.FOUNDRY_SUCCESSOR_BEFORE},async t=>{
	const previous=process.env.FOUNDRY_SUCCESSOR_BEFORE;
	/** @type {typeof factory} */
	const build=mode==="prevent"||!previous?factory:(await import(pathToFileURL(path.resolve(previous,"test/fixture.mjs")).href)).factory;
	const run="display", brief=".foundry/display.json", primary="unit/picker", parent="unit/controls", file=`${parent}/entry`;
	const cited=mode==="restore cited", pending=cited || mode==="restore pending";
	const f=build(t,run,brief,{[brief]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Render a selection.",ownership:"exact-files",
		productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"view",areas:["unit"],charter:"brief",checks:["unit.mjs"]}]}),
		".foundry/display/journey.md":"Select the item.","brief":"Maintain the selector.",[file]:"old","unit.mjs":mode==="restore issued"?
			`import {existsSync} from "node:fs";if(process.env.FOUNDRY_GRAIN==="controls"&&!existsSync("${parent}/fixed"))process.exit(1)`:"",
		"product.mjs":`console.log(process.env.FOUNDRY_OWNERSHIP)`,
		"goal.mjs":`import {existsSync as has} from "node:fs";process.exit(!has("unit/core/result")?1:!has("${primary}/result")?2:!has("${parent}/fixed")?1:${mode==="restore joined"?'!has("unit/done/result")?2:0':pending?`!has("${parent}/button")||!has("unit/rail/change")?1:0`:0})`});
	const proposal=(/** @type {string} */ id,/** @type {unknown} */ directory,/** @type {string} */ evidence)=>({
		outcome:"regenerate",reason:"Implement missing behavior.",evidence:[evidence],grains:[{id,directory,task:`Implement ${id}`,check:"unit.mjs",needs:[]}]});
	await f.start();await f.scouts[0].report(proposal("core","unit/core","brief"));
	const [core]=f.workers.values();put(core.cwd,"unit/core/result","ready");await f.runtime(core.cwd).operation("submit",{run,token:core.token},core.id);
	const owner=f.runtime(f.root,{confirm:async()=>true}), goal=owner.inspect({run,detail:"proof"},"owner").goalChecks?.at(-1);assert.ok(goal);
	put(f.root,"reference","Connect the selector.");
	const [offer]=(await owner.operation("publish",{run,file:"reference",to:[primary]},"owner")).artifacts;
	await owner.operation("iterate",{run,receipt:goal.id,blob:offer.blob,question:"Connect the selector.",directory:primary,files:[file],
		source:{commit:goal.commit,file,excerpt:"old"}},"owner");await f.settle();
	await f.scouts.at(-1)?.report(proposal("picker",{primary,files:[file]},file));
	const [,picker]=f.workers.values();put(picker.cwd,`${primary}/result`,"keep");put(picker.cwd,file,"connected");
	await f.runtime(picker.cwd).operation("submit",{run,token:picker.token},picker.id);await f.settle();
	const before=owner.inspect({run,detail:"proof"},"owner");assert.ok(before.outputs?.picker && before.goal?.receipt?.exit===1);
	const broadPlan=proposal("controls",parent,"brief"), railPlan=proposal("rail","unit/rail","brief").grains[0];
	if (cited) broadPlan.grains.push(railPlan);
	await f.scouts.at(-1)?.report(broadPlan);
	const issued=owner.inspect({run,detail:"proof"},"owner");
	if(mode==="prevent"){
		assert.ok(issued.nodes.some(n=>n.grain==="picker" && n.state==="qualified"),"the checked primary lost its owner");
		assert.ok(!issued.nodes.some(n=>n.grain==="controls"));assert.equal(f.workers.size,2);
		assert.match(issued.reviews.at(-1)?.reason??"",/mixed grant|exact.file/);return;
	}
	assert.ok(!issued.nodes.some(n=>n.grain==="picker"));const [,,worker]=f.workers.values();assert.ok(worker);
	f.owner.close();owner.close();
	if(mode==="restore issued"){
		const read=f.runtime(f.root,{confirm:async()=>true},createRuntime), broad=f.runtime(worker.cwd,{},createRuntime);
		put(worker.cwd,file,"new control");
		const submitted=await broad.operation("submit",{run,token:worker.token},worker.id);
		const repair=submitted.nodes.find(n=>n.grain==="controls");assert.ok(repair?.state==="writing" && repair.token!==worker.token && repair.receipt && repair.receipt.exit===1,"retain the original writer's bounded repair while integration is held");
		const checkpoint=before.products?.at(-1)?.check, goal=before.goalChecks?.at(-1)?.id;
		await read.operation("restore",{run,from:"picker",historical:checkpoint,retainer:"controls",to:"selector",checkpoint,goal},"owner");
		const attester=[...f.workers.values()].at(-1);assert.ok(attester && attester.id!==worker.id);
		await f.runtime(attester.cwd,{},createRuntime).operation("submit",{run,token:attester.token},attester.id);
		assert.deepEqual(read.inspect({run,detail:"proof"},"owner").products,before.products);
		put(worker.cwd,`${parent}/fixed`,"available");
		await broad.operation("submit",{run,token:repair.token},worker.id);
		const end=read.inspect({run,detail:"proof"},"owner");assert.ok(end.qualified && end.outputs?.selector && end.outputs.controls && !end.outputs.picker);
		assert.equal(git(f.root,"show",`${end.qualified}:${file}`),"new control");
		assert.deepEqual(end.products?.slice(0,-1),before.products);return;
	}
	const runtime=f.runtime(worker.cwd,{},mode==="issued writer"?createRuntime:undefined);
	put(worker.cwd,file,"new control");put(worker.cwd,`${parent}/fixed`,"available");
	await runtime.operation("submit",{run,token:worker.token},worker.id);
	const proof=f.runtime(f.root,{},mode==="issued writer"?createRuntime:undefined).inspect({run,detail:"proof"},"owner");
	if(pending){
		await f.settle();
		const review=f.scouts.at(-1);assert.ok(review);
		const citation=`${primary}/result`;
		const plan=proposal("buttons",parent,cited?citation:"brief");if(!cited) plan.grains.push(railPlan);
		await review.report(plan);
		const jobs=f.runtime(f.root).inspect({run},"owner");
		const buttons=f.workers.get(jobs.nodes.find(n=>n.grain==="buttons")?.worker??""), rail=f.workers.get(jobs.nodes.find(n=>n.grain==="rail")?.worker??"");
		assert.ok(buttons && rail);
		put(buttons.cwd,file,"current button");put(buttons.cwd,`${parent}/fixed`,"available");put(buttons.cwd,`${parent}/button`,"ready");
		await f.runtime(buttons.cwd,{},createRuntime).operation("submit",{run,token:buttons.token},buttons.id);
		put(rail.cwd,"unit/rail/change","reordered");await f.runtime(rail.cwd,{},createRuntime).operation("submit",{run,token:rail.token},rail.id);
		const owner=f.runtime(f.root,{confirm:async msg=>{
			assert.ok(msg.includes("buttons") && msg.includes("selector"));
			if (cited) assert.ok(msg.includes(review.id) && msg.includes(citation));
			return true;
		}},createRuntime);
		const current=owner.inspect({run,detail:"proof"},"owner"), a=current.nodes.find(n=>n.grain==="buttons"), b=current.nodes.find(n=>n.grain==="rail");
		assert.ok(a?.state==="published" && b?.state==="published" && a.checked && b.checked);
		assert.deepEqual(current.products,proof.products);const priorChecks=[...f.checks];
		const request={run,from:"picker",historical:before.products?.at(-1)?.check,retainer:"buttons",to:"selector",checkpoint:current.products?.at(-1)?.check,goal:current.goalChecks?.at(-1)?.id};
		if (cited && process.env.FOUNDRY_RESTORE_BEFORE) {
			const old=(await import(pathToFileURL(path.resolve(process.env.FOUNDRY_RESTORE_BEFORE,"work/runtime.mjs")).href)).createRuntime;
			const blocked=f.runtime(f.root,{confirm:async()=>assert.fail("unexpected approval")},old);
			await assert.rejects(blocked.operation("restore",request,"owner"),{code:"dispatch_held"});
			assert.deepEqual(blocked.inspect({run,detail:"proof"},"owner").products,current.products);blocked.close();
		}
		if (cited) {
			const db=openDatabase(f.root);t.after(()=>db.close());
			const snapshot=db.read(run);assert.ok(snapshot);
			const oldPin=before.outputs?.picker;assert.ok(oldPin);
			/** @param {(r:import("../work/model.js").Run)=>void} change @param {RegExp} reason */
			function refused(change,reason) {
				assert.ok(snapshot);
				const r=structuredClone(snapshot);change(r);
				assert.throws(()=>prepareRestoration(f.root,r,"owner",request,e=>db.verifySigned(run,e)),{code:"dispatch_held",message:reason});
			}
			refused(r=>{r.nodes.buttons.state="writing";},/buttons \(writing\)/);
			refused(r=>{r.nodes.buttons.inputs={picker:oldPin};},/buttons \(published\)/);
			refused(r=>{r.nodes.buttons.grain.needs=["core"];r.nodes.core.grain.needs=["picker"];},/buttons \(published\)/);
			refused(r=>{r.nodes.buttons.supporting=[citation];},/buttons \(published\)/);
			refused(r=>{
				const scout=r.effects.find(e=>e.id===r.nodes.rail.review);assert.ok(scout?.kind==="scout" && scout.observation);
				scout.observation.evidence.push(citation);
			},/rail \(published\)/);
			refused(r=>{
				const scout=r.effects.find(e=>e.id===review.id);assert.ok(scout?.kind==="scout" && scout.packet);
				delete scout.packet.files[citation];
			},/buttons \(published\)/);
			refused(r=>{
				const scout=r.effects.find(e=>e.id===review.id);assert.ok(scout?.kind==="scout" && scout.packet);
				scout.base=scout.packet.base=f.tip;
			},/buttons \(published\)/);
			refused(r=>{const call=r.effects.find(e=>e.grain==="buttons" && e.kind==="writer");assert.ok(call);call.state="uncertain";},/writer .*uncertain/);
		}
		await owner.operation("restore",request,"owner");
		const attester=[...f.workers.values()].at(-1);assert.ok(attester && attester.id!==rail.id);
		const fresh=f.runtime(attester.cwd,{},createRuntime);
		if (cited) {
			put(attester.cwd,citation,"changed");
			await assert.rejects(fresh.operation("submit",{run,token:attester.token},attester.id),{code:"changed_restoration"});
			put(attester.cwd,citation,"keep");
		}
		await fresh.operation("submit",{run,token:attester.token},attester.id);
		const end=owner.inspect({run,detail:"proof"},"owner");assert.ok(end.qualified && end.outputs?.selector);
		assert.equal(end.outputs.buttons,a.checked);assert.equal(end.outputs.rail,b.checked);assert.equal(end.outputs.controls,undefined);
		assert.equal(git(f.root,"show",`${end.qualified}:${file}`),"current button");assert.equal(git(f.root,"show",`${end.qualified}:unit/rail/change`),"reordered");
		assert.equal(git(f.root,"show",`${end.qualified}:${citation}`),"keep");
		assert.deepEqual(end.reviews.find(r=>r.id===review.id),current.reviews.find(r=>r.id===review.id));
		assert.deepEqual(end.goalChecks?.slice(0,-1),current.goalChecks);assert.deepEqual(end.products?.slice(0,-1),current.products);
		assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check joined product","Check final goal"]);return;
	}
	if(mode==="restore joined"){
		assert.ok(proof.outputs?.controls && !proof.outputs.picker && proof.checkpoint && !proof.qualified);
		const read=f.runtime(f.root,{confirm:async()=>true},createRuntime);
		const receipt=proof.goalChecks?.at(-1)?.id, historical=before.products?.at(-1)?.check;
		assert.ok(receipt && historical && proof.goal?.receipt?.exit===2);
		const request={run,from:"picker",historical,retainer:"controls",to:"selector",checkpoint:proof.products?.at(-1)?.check,goal:receipt};
		assert.equal(read.inspect({run,detail:"proof"},"owner").release?.reason,"ownership-conflict");
		await assert.rejects(read.operation("restore",{...request,retainer:"core"},"owner"),{code:"invalid_restoration"});
		await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("restore",request,"owner"),{code:"approval_declined"});
		await read.operation("restore",request,"owner");await f.settle();
		const writer=[...f.workers.values()].at(-1);assert.ok(writer && writer.id!==worker.id);
		assert.equal(git(writer.cwd,"show",`HEAD:${primary}/result`),"keep");
		put(writer.cwd,`${primary}/result`,"different");
		const fresh=f.runtime(writer.cwd,{},createRuntime);
		await assert.rejects(fresh.operation("submit",{run,token:writer.token},writer.id),{code:"changed_restoration"});
		put(writer.cwd,`${primary}/result`,"keep");put(writer.cwd,file,"not granted");
		await fresh.operation("submit",{run,token:writer.token},writer.id);
		const after=read.inspect({run,detail:"proof"},"owner");assert.ok(after.outputs?.selector && !after.outputs.picker);
		assert.equal(after.outputs.controls,proof.outputs.controls);assert.notEqual(after.checkpoint,proof.checkpoint);
		assert.equal(git(f.root,"rev-parse",`${after.checkpoint}^{tree}`),git(f.root,"rev-parse",`${proof.checkpoint}^{tree}`));
		assert.deepEqual(after.products?.slice(0,-1),proof.products);assert.deepEqual(after.goalChecks?.slice(0,-1),proof.goalChecks);
		assert.match(after.products?.at(-1)?.receipt?.output??"",/"selector":\{"directories":\["unit\/picker"\],"files":\[\]\}/);
		assert.equal(after.goal?.receipt?.exit,2);assert.equal(after.goal?.receipt?.commit,after.checkpoint);assert.equal(after.qualified,null);
		assert.ok(after.checkpoint && after.goalChecks?.at(-1)?.id);put(f.root,"next","Complete the independent behavior.");
		const ref=(await read.operation("publish",{run,file:"next",to:["unit/done"]},"owner")).artifacts.at(-1);assert.ok(ref);
		await read.operation("iterate",{run,receipt:after.goalChecks.at(-1)?.id,blob:ref.blob,question:"Complete the independent behavior.",directory:"unit/done",source:{commit:after.checkpoint,file,excerpt:"new control"}},"owner");await f.settle();
		await f.scouts.at(-1)?.report(proposal("finish","unit/done",file));
		const end=[...f.workers.values()].at(-1);assert.ok(end && end.id!==writer.id);put(end.cwd,"unit/done/result","ok");
		await f.runtime(end.cwd,{},createRuntime).operation("submit",{run,token:end.token},end.id);
		const final=read.inspect({run,detail:"proof"},"owner");assert.ok(final.qualified && final.outputs?.selector===after.outputs.selector);return;
	}
	if(mode==="legacy join"){
		assert.ok(proof.qualified && !proof.outputs?.picker && proof.outputs?.controls);
		assert.equal(git(f.root,"show",`${proof.qualified}:${primary}/result`),"keep");
		assert.equal(git(f.root,"show",`${proof.qualified}:${file}`),"new control");
		assert.doesNotMatch(proof.products?.at(-1)?.receipt?.output??"",/"picker":/);return;
	}
	assert.equal(proof.qualified,null);assert.deepEqual(proof.products,before.products);assert.deepEqual(proof.goalChecks,before.goalChecks);
	assert.equal(proof.nodes.find(n=>n.grain==="controls")?.state,"published");
	assert.match(proof.blocker??"",/picker.*controls|controls.*picker/);assert.equal(f.workers.size,3);
});

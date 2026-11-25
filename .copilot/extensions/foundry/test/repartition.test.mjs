import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { factory, git, put } from "./fixture.mjs";
import { openDatabase } from "../work/database.mjs";
import { currentPair, preparePair } from "../work/pairing.mjs";
import { decode } from "../work/snapshot.mjs";
import { partitionConflict } from "../work/partition.mjs";
import { prepareRestoration } from "../work/restoration.mjs";
import { createRuntime } from "../work/runtime.mjs";

for (const mode of ["prevent","legacy join","issued writer","restore issued","restore joined","restore pending","restore cited","failed attestation","negative pair","unchanged pair"]) test(`partial repartition of a checked mixed grant / ${mode}`,
	{skip:mode!=="prevent" && !process.env.FOUNDRY_SUCCESSOR_BEFORE},async t=>{
	const previous=process.env.FOUNDRY_SUCCESSOR_BEFORE;
	/** @type {typeof factory} */
	const build=mode==="prevent"||!previous?factory:(await import(pathToFileURL(path.resolve(previous,"test/fixture.mjs")).href)).factory;
	const run="display", brief=".foundry/display.json", primary="unit/picker", parent="unit/controls", file=`${parent}/entry`;
	const failed=["failed attestation","negative pair","unchanged pair"].includes(mode), cited=mode==="restore cited" || failed, pending=cited || mode==="restore pending";
	const first=failed && process.env.FOUNDRY_PAIR_BEFORE ? (await import(pathToFileURL(path.resolve(process.env.FOUNDRY_PAIR_BEFORE,"work/runtime.mjs")).href)).createRuntime : createRuntime;
	const f=build(t,run,brief,{[brief]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Render a selection.",ownership:"exact-files",
		productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"view",areas:["unit"],charter:"brief",checks:["unit.mjs"]}]}),
		".foundry/display/journey.md":"Select the item.","brief":"Maintain the selector.",[file]:"old","unit.mjs":mode==="restore issued"?
			`import {existsSync} from "node:fs";if(process.env.FOUNDRY_GRAIN==="controls"&&!existsSync("${parent}/fixed"))process.exit(1)`:
			failed?`import {readFileSync} from "node:fs";if(process.env.FOUNDRY_DIRECTORY==="${primary}"&&!process.env.FOUNDRY_FILES){const control=readFileSync("${file}","utf8");console.log("Checked control: "+control);if(control!=="current button"||${mode==="negative pair"})process.exit(1);}`:"",
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
	const siblings=failed ? ["alpha","bravo","charlie","delta"] : [];
	for (const id of siblings) broadPlan.grains.push(proposal(id,`unit/${id}`,"brief").grains[0]);
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
		put(buttons.cwd,file,mode==="unchanged pair"?"new control":"current button");put(buttons.cwd,`${parent}/fixed`,"available");put(buttons.cwd,`${parent}/button`,"ready");
		await f.runtime(buttons.cwd,{},createRuntime).operation("submit",{run,token:buttons.token},buttons.id);
		put(rail.cwd,"unit/rail/change","reordered");await f.runtime(rail.cwd,{},createRuntime).operation("submit",{run,token:rail.token},rail.id);
		for (const id of siblings) {
			const w=f.workers.get(jobs.nodes.find(n=>n.grain===id)?.worker??"");assert.ok(w);
			put(w.cwd,`unit/${id}/change`,id);await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
		}
		const owner=f.runtime(f.root,{confirm:async msg=>{
			assert.ok(msg.includes("buttons") && msg.includes("selector"));
			if (cited) assert.ok(msg.includes(review.id) && msg.includes(citation));
			return true;
		}},first);
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
		const fresh=f.runtime(attester.cwd,{},first);
		if (cited) {
			put(attester.cwd,citation,"changed");
			await assert.rejects(fresh.operation("submit",{run,token:attester.token},attester.id),{code:"changed_restoration"});
			put(attester.cwd,citation,"keep");
		}
		await fresh.operation("submit",{run,token:attester.token},attester.id);
		if (failed) {
			const stalled=owner.inspect({run,detail:"proof"},"owner"), node=stalled.nodes.find(n=>n.grain==="selector");
			assert.equal(node?.state,"blocked");assert.ok(node?.check && node.receipt && node.receipt.exit===1);
			assert.match(node.receipt.output,/Checked control: new control/);
			const commit=node.receipt.commit;assert.ok(stalled.checkpoint);
			assert.equal(git(f.root,"rev-parse",`${commit}:${primary}`),git(f.root,"rev-parse",`${stalled.checkpoint}:${primary}`));
			assert.equal(git(f.root,"rev-parse",`${commit}:${file}`),git(f.root,"rev-parse",`${stalled.checkpoint}:${file}`));
			assert.equal(git(f.root,"show",`${a.checked}:${file}`),mode==="unchanged pair"?"new control":"current button");
			await assert.rejects(owner.operation("restore",{...request,to:"second-selector"},"owner"),{code:"invalid_restoration"});
			await assert.rejects(owner.operation("recheck",{run,check:node.check},"owner"),{code:"not_recoverable"});
			const after=owner.inspect({run,detail:"proof"},"owner");
			assert.deepEqual(after.nodes,stalled.nodes);assert.deepEqual(after.products,current.products);
			assert.deepEqual(after.goalChecks,current.goalChecks);assert.equal(after.qualified,null);
			assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector"]);
			assert.ok(a.check);
			const args={run,grain:"selector",failed:node.check,retainer:"buttons",candidate:a.checked,component:a.check,checkpoint:request.checkpoint,goal:request.goal};
			const db=openDatabase(f.root), original=db.read(run)?.effects.find(e=>e.id===node.check);assert.ok(original);
			t.after(()=>db.close());owner.close();fresh.close();
			const state=db.read(run);assert.ok(state);
			const pins=Object.fromEntries(Object.entries(state.nodes).flatMap(([id,n])=>n.state==="published" ? [[id,n.candidate]] : []));
			assert.equal(Object.keys(pins).length,6);
			const number=f.workers.size;
			const next=f.runtime(f.root,{confirm:async msg=>{assert.ok([args.failed,args.candidate,args.component].every(x=>msg.includes(x)));return true;}},createRuntime);
			if (mode==="unchanged pair") {
				await assert.rejects(next.operation("pair",args,"owner"),{code:"unchanged_pair"});
				assert.deepEqual(db.read(run),state);assert.equal(f.workers.size,number);return;
			}
			await assert.rejects(next.operation("pair",{...args,candidate:commit},"owner"),{code:"stale_assignment"});
			await assert.rejects(next.operation("pair",{...args,retainer:"rail",candidate:b.checked,component:b.check},"owner"),{code:"invalid_pair"});
			await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("pair",args,"owner"),{code:"approval_declined"});
			const inspect=(/** @type {typeof state} */ s)=>preparePair(f.root,s,"owner",args,e=>db.verifySigned(run,e));
			const consumer=structuredClone(state);consumer.nodes.rail.supporting=[citation];
			assert.throws(()=>inspect(consumer),{code:"dispatch_held",message:/rail/});
			const changed=structuredClone(state);assert.ok(changed.nodes.selector.restoration);
			changed.nodes.selector.restoration.tree=f.tip;
			assert.throws(()=>inspect(changed),{code:"invalid_pair"});
			const evaluator=structuredClone(state);evaluator.nodes.selector.grain.check="product.mjs";
			assert.throws(()=>inspect(evaluator),{code:"invalid_pair"});
			const preview=inspect(state), stale=structuredClone(state);stale.nodes.buttons.check=b.check;
			assert.throws(()=>preview.apply(stale),{code:"stale_assignment"});
			const reserved=structuredClone(state);preview.apply(reserved);
			const e=reserved.effects.at(-1);assert.ok(e?.kind==="component" && e.pair && currentPair(f.root,reserved,e));
			reserved.nodes.rail.supporting=[citation];assert.equal(currentPair(f.root,reserved,e),false);
			const racing=f.runtime(f.root,{confirm:async()=>{await next.operation("pair",args,"owner");return true;}},createRuntime);
			await assert.rejects(racing.operation("pair",args,"owner"),{code:mode==="negative pair"?"invalid_pair":"goal_met"});
			const end=next.inspect({run,detail:"proof"},"owner"), checked=end.nodes.find(n=>n.grain==="selector");
			assert.equal(f.workers.size,number);assert.deepEqual(db.read(run)?.effects.find(e=>e.id===node.check),original);
			assert.ok(checked?.receipt && checked.check!==node.check);
			assert.match(checked.receipt.output,/Checked control: current button/);
			assert.equal(git(f.root,"rev-parse",`${checked.receipt.commit}:${primary}`),git(f.root,"rev-parse",`${commit}:${primary}`));
			assert.equal(git(f.root,"rev-parse",`${checked.receipt.commit}:${parent}`),git(f.root,"rev-parse",`${a.checked}:${parent}`));
			assert.equal(git(f.root,"diff-tree","-r","--name-only",commit,checked.receipt.commit,"--","unit/rail"),"");
			const receipt=end.checkRecovery?.find(r=>r.check===checked.check);
			assert.deepEqual(receipt?.originalReceipt,node.receipt);assert.deepEqual(receipt?.receipt,checked.receipt);
			assert.ok(receipt?.pair?.failed===args.failed && receipt.pair.component===args.component && receipt.issuer==="owner");
			const saved=db.read(run);assert.ok(saved);const paired=saved.effects.find(e=>e.id===checked.check);
			assert.ok(paired?.kind==="component" && paired.pair);db.verifySigned(run,paired);
			const forged={...paired,pair:{...paired.pair,tree:f.tip}};
			assert.throws(()=>db.verifySigned(run,forged),{code:"wrong_outcome"});
			assert.equal(git(f.root,"rev-parse","refs/heads/main"),f.tip);
			assert.ok(Object.entries(pins).every(([id,pin])=>saved.nodes[id].candidate===pin && saved.nodes[id].check===state.nodes[id].check));
			if (mode==="negative pair") {
				assert.ok(checked.state==="blocked" && checked.receipt.exit===1 && !end.qualified);
				assert.deepEqual(end.products,current.products);assert.deepEqual(end.goalChecks,current.goalChecks);
				await assert.rejects(next.operation("pair",{...args,failed:checked.check},"owner"),{code:"invalid_pair"});
				await assert.rejects(next.operation("pair",args,"owner"),{code:"invalid_pair"});
				assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check selector"]);return;
			}
			assert.ok(end.qualified && end.qualification && end.outputs?.selector===checked.receipt.commit);
			const restored=end.qualification.outputs.find(o=>o.id==="selector");
			assert.deepEqual(restored?.pair,receipt.pair);
			assert.deepEqual(end.qualification.ownership?.selector,{directories:[primary],files:[]});
			assert.deepEqual(end.qualification.ownership?.buttons,{directories:[parent],files:[]});
			assert.ok(Object.entries(pins).every(([id,pin])=>end.outputs?.[id]===pin));
			assert.ok(!next.inspect({run,detail:"cleanup"},"owner").handoff?.writers?.some(w=>w.id===attester.id));
			const broken=structuredClone(saved), altered=broken.effects.find(e=>e.id===checked.check);assert.ok(altered?.kind==="component" && altered.pair);
			altered.pair.component=b.check??"";assert.throws(()=>decode(broken),{code:"corrupt_run"});
			reserved.nodes.selector.state="published";delete reserved.nodes.rail.supporting;
			assert.equal(partitionConflict(reserved),undefined);reserved.nodes.buttons.check=b.check;
			assert.match(partitionConflict(reserved)??"",/no longer matches/);
			assert.deepEqual(end.products?.slice(0,-1),current.products);assert.deepEqual(end.goalChecks?.slice(0,-1),current.goalChecks);
			assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check selector","Check joined product","Check final goal"]);return;
		}
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

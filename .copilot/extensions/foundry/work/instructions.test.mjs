import assert from "node:assert/strict";
import test from "node:test";
import { git, put, scriptedInspections, settleSubmitted } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { assignmentCount } from "./capacity.mjs";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { queueInstructions, writerInstructions } from "./instructions.mjs";

for(const outcome of ["finish","unknown","refused","frozen","paused","stop during permission","target during permission"])test(`deliver the linked blocker to its original writable thread / ${outcome}`,async t=>{
	const run="items",source=".foundry/items.json",dir="desk/items",grain="open-row",step="open-item",old=await historicalFactory(t,94);
	const f=old(t,run,source,{[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Open a selected item.",productCheck:"product.mjs",
		goalCheck:"goal.mjs",limits:{assignments:3},squads:[{id:"desk",areas:["desk"],charter:"desk.md",checks:["component.mjs"]}]}),
		".foundry/items/journey.md":"Select and open an item.","desk.md":"Own the open action.","product.mjs":"","component.mjs":"",
		"goal.mjs":`import {existsSync} from "node:fs";const open=existsSync("${dir}/open");console.log(open?"Opened":"Selected item failed to open");process.exit(open?0:1);`});
	await f.start();const s=f.scouts[0];await s.report({outcome:"regenerate",reason:"Missing open behavior.",evidence:["desk.md"],
		grains:[{id:grain,directory:dir,check:"component.mjs",task:"Open the selected row.",needs:[]}]});
	const [w]=f.workers.values(),db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	const receipt=read().goal?.check??assert.fail();
	await f.owner.operation("attribute",{run,receipt,id:step,directory:dir,blocked:2,excerpt:"Selected item failed to open"},"owner");await f.settle();
	const review=f.scouts.at(-1)??assert.fail();assert.notEqual(review.id,s.id);
	await review.report({outcome:"no-gap",reason:"The current task already covers the failure.",evidence:["desk.md"],grains:[],addresses:[{id:step,grain,worker:w.id}]});
	const before=read();assert.equal(f.owner.inspect({run},"owner").sharedBlockers?.[0].worker,w.id);
	assert.equal(before.effects.filter(e=>e.tool==="send_session_message" && e.args.session_id===w.id).length,0);
	if(outcome==="paused")await f.owner.operation("pause",{run},"owner");
	if(outcome==="frozen"){
		put(w.cwd,`${dir}/open`,"done");await f.runtime(w.cwd,{execute:async(tool,args,key)=>tool==="bash"?{resultType:"unknown"}:f.execute(tool,args,key)})
			.operation("submit",{run,token:w.token},w.id);
		assert.equal(read().nodes[grain].state,"checking");
	}
	f.owner.close();const inspect=scriptedInspections(f.root),writer=settleSubmitted(f.runtime(w.cwd,inspect,createRuntime));
	/** @type {string[]} */ const notices=[];
	let stopped=false;
	const owner=f.runtime(f.root,{...inspect,permissionBlocker:async()=>{
		if(outcome==="stop during permission" && !stopped && read().instructions?.some(e=>e.state==="ready")){
			stopped=true;await writer.operation("submit",{run,token:w.token,missingInput:"The needed observation is unavailable."},w.id);
		}else if(outcome==="target during permission" && !stopped && read().instructions?.some(e=>e.state==="ready")){
			stopped=true;git(f.root,"commit","--allow-empty","-qm","Advance target while permission is sampled");
		}return null;
	},execute:async(tool,args,key)=>{
		if(tool==="send_session_message" && String(args.message).startsWith("Foundry instruction:")){
			notices.push(String(args.message));assert.equal(args.session_id,w.id);assert.ok(!String(args.message).includes(w.token));
			assert.ok([grain,step,receipt,"foundry_status"].every(s=>String(args.message).includes(s)));
			if(outcome==="unknown")return {resultType:"unconfirmed"};
			if(outcome==="refused")return {resultType:"denied"};
		}return f.execute(tool,args,key);
	}},createRuntime);
	owner.turn("owner");await owner.flush();
	if(outcome==="target during permission"){
		assert.ok(stopped);assert.equal(notices.length,0,"do not tell the writer to act on an old target");
		assert.ok(!writer.inspect({run},w.id).recovery.some(a=>a.kind==="blocker" && a.disposition==="act"));return;
	}
	if(outcome==="stop during permission"){
		assert.ok(stopped);assert.equal(notices.length,0);assert.equal(read().nodes[grain].state,"blocked");
		assert.ok(!owner.inspect({run},"owner").recovery.some(a=>a.kind==="blocker"));assert.equal(assignmentCount(read()),assignmentCount(before));return;
	}
	if(outcome==="paused" || outcome==="frozen"){
		assert.equal(notices.length,0);const guidance=writer.inspect({run},w.id).recovery;
		assert.ok(!guidance.some(a=>a.kind==="blocker" && a.disposition==="act"));
		assert.ok(guidance.some(a=>outcome==="paused"?a.disposition==="decision" && a.role==="operator":a.disposition==="wait" && a.source===read().nodes[grain].check));return;
	}
	assert.equal(notices.length,1,"assigned is not enough: the original writer must actually receive the failed step");
	const state=read();assert.equal(assignmentCount(state),assignmentCount(before));assert.deepEqual(state.nodes[grain],before.nodes[grain]);
	assert.equal(f.workers.size,1);assert.equal(state.instructions?.length,1);
	const forged=structuredClone(state),notice=forged.instructions?.[0]??assert.fail();notice.args.session_id="other-thread";
	assert.throws(()=>decode(forged),{code:"corrupt_run"});
	owner.turn("owner");await owner.flush();writer.turn(w.id);await writer.flush();assert.equal(notices.length,1);
	if(outcome!=="finish"){
		assert.equal(state.instructions?.[0].state,outcome==="unknown"?"uncertain":"refused");
		if(outcome==="refused")assert.equal(writer.inspect({run},w.id).recovery.find(a=>a.kind==="blocker")?.disposition,"unsupported","a refused call isn't pending");
		return;
	}
	const action=writer.inspect({run},w.id).recovery?.find(a=>a.kind==="blocker");
	assert.equal(action?.disposition,"act");assert.equal(action?.session,w.id);assert.equal(action?.tool,"foundry_submit");
	assert.deepEqual(action?.arguments,{run,token:w.token});assert.ok(action?.message.includes("Selected item failed to open"));
	assert.ok(!JSON.stringify(owner.inspect({run},"owner").recovery).includes(w.token));
	const inconsistent=structuredClone(before),bound=inconsistent.nodes[grain],sourceReview=inconsistent.effects.find(e=>e.id===bound.review);
	assert.ok(sourceReview?.kind==="scout");sourceReview.correction={worker:w.id,clause:"not part of this task",file:"desk.md",excerpt:"other evidence",blob:inconsistent.policy.base};
	queueInstructions(inconsistent,"owner");
	assert.deepEqual(inconsistent.instructions?.map(e=>e.instruction?.kind),["blocker"],"an unsubstantiated instruction must not stop independent delivery");
	const withheld=writerInstructions(inconsistent,[bound],"owner").find(a=>a.kind==="correction");
	assert.equal(withheld?.disposition,"unsupported");assert.equal(withheld?.source,sourceReview.id);assert.equal(withheld?.arguments,undefined);
	put(w.cwd,`${dir}/open`,"fixed by the original writer");
	await writer.operation("submit",action.arguments,w.id);owner.turn("owner");await owner.flush();
	const qualified=owner.inspect({run},"owner").qualified;assert.ok(qualified);assert.equal(git(f.root,"show",`${qualified}:${dir}/open`),"fixed by the original writer");
	assert.equal(read().instructions?.length,1);assert.ok(!writer.inspect({run},w.id).recovery?.some(a=>a.kind==="blocker"));
});


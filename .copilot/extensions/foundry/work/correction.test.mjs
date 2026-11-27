import assert from "node:assert/strict";
import test from "node:test";
import { factory, git, put } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { openDatabase } from "./database.mjs";
import { sourceAt } from "./description.mjs";
import { recordedAttempt } from "./requirements.mjs";
import { createRuntime } from "./runtime.mjs";

for (const legacy of [true,false]) for (const stopped of [false,true]) test(`correct the original ordinary assignment ${stopped?"after a preview-only stop":"while bound"} / ${legacy?"reader 61":"reviewed"}`,async t=>{
	const run="composer", source=".foundry/composer.json", dir="channels/UI", grain="root-action", file="coverage/inventory";
	const clause="Expose cancel on the nonempty composer.", task="Implement discard for a nonempty composer.", excerpt="nonempty -> request discard";
	const make=legacy?await historicalFactory(t,61):factory, f=make(t,run,source,{
		[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Discard a nonempty draft.",
			productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"channels",charter:"brief",areas:["channels"],checks:["component.mjs"]}]}),
		".foundry/composer/journey.md":"Discard and confirm.","brief":"Follow the checked composer contract.",
		[file]:excerpt,[`${dir}/action`]:"send","component.mjs":`import {readFileSync} from "node:fs";
			process.exit(readFileSync("${dir}/action","utf8")==="discard" && readFileSync("${dir}/test","utf8")==="nonempty" ? 0 : 1);`,
		"product.mjs":"","goal.mjs":`import {readFileSync} from "node:fs";process.exit(readFileSync("${dir}/action","utf8")==="discard"?0:1);`,
	});
	await f.start();
	const review=f.scouts[0];
	await review.report({outcome:"regenerate",reason:"Missing nonempty control.",evidence:["brief"],grains:[
		{id:grain,task:`${task} ${clause}`,directory:dir,check:"component.mjs",needs:[]}]});
	const [w]=f.workers.values(), old=f.runtime(w.cwd);
	put(w.cwd,`${dir}/test`,"nonempty");
	const preview=(await old.operation("preview",{run,token:w.token},w.id)).nodes[0].preview;assert.ok(preview);
	const bound={run,grain,worker:w.id,review:review.id,file,excerpt,clause};
	if(legacy)await assert.rejects(f.owner.operation("correct",bound,"owner"),{code:"invalid_correction"});
	if (stopped) await old.operation("submit",{run,token:w.token,missingInput:"The task contradicts the checked contract."},w.id);
	const args=stopped ? {...bound,preview} : bound;
	await f.settle();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const before=db.read(run);assert.ok(before);const n=before.nodes[grain];
	assert.equal(n.check,undefined);assert.equal(n.preview,preview);
	old.close();f.owner.close();
	const owner=f.runtime(f.root,{confirm:async prompt=>{assert.ok(prompt.includes(clause)&&prompt.includes(excerpt));return true;}},createRuntime);
	const writer=f.runtime(w.cwd,{},createRuntime), count=f.scouts.length, checks=[...f.checks], notices=f.inbox.length;
	await assert.rejects(owner.operation("correct",{...args,excerpt:"not in the inventory"},"owner"),{code:"invalid_correction"});
	await assert.rejects(owner.operation("correct",{...args,preview:f.tip},"owner"),{code:"stale_assignment"});
	if (stopped) await assert.rejects(owner.operation("correct",bound,"owner"),{code:"stale_assignment"});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("correct",args,"owner"),{code:"approval_declined"});
	assert.deepEqual(db.read(run),before);
	const guarded=f.runtime(f.root,{confirm:async()=>true,execute:async(tool,args,id)=>{
		assert.equal(tool,"send_session_message");assert.ok(String(args.message).includes(task));
		assert.ok(!String(args.message).includes(file));
		const token=writer.inspect({run},w.id).nodes[0].token;assert.ok(token);
		await assert.rejects(writer.operation("submit",{run,token},w.id),{code:"dispatch_held"});
		return f.execute(tool,args,id);
	}},createRuntime);
	await (stopped?guarded:owner).operation("correct",args,"owner");
	const after=db.read(run);assert.ok(after);const current=writer.inspect({run},w.id).nodes[0];
	if(!stopped){
		const sent=after.instructions?.find(e=>e.instruction?.kind==="correction");assert.equal(sent?.state,"done");
		assert.equal(sent.args.session_id,w.id);assert.ok(String(sent.args.message).includes(task));assert.ok(!String(sent.args.message).includes(excerpt));
	}
	assert.equal(current.task?.trim(),task);assert.equal(current.state,"writing");assert.equal(current.preview,preview);
	assert.equal(current.worker,w.id);assert.equal(current.generation,n.generation);assert.deepEqual(current.inputs,n.inputs);
	assert.equal(current.directory,dir);assert.equal(current.evaluator,n.grain.check);assert.equal(current.readGrant,undefined);
	assert.ok(!JSON.stringify(current).includes(excerpt),"owner-only evidence is not a writer read");
	assert.deepEqual(f.checks,checks);assert.equal(f.scouts.length,count);assert.equal(f.workers.size,1);
	assert.equal(after.nodes[grain].candidate,undefined);assert.equal(after.nodes[grain].check,undefined);
	const evidence=after.effects.find(e=>e.id===review.id);assert.ok(evidence?.kind==="scout");
	assert.deepEqual(evidence.observation,reviewRecord(before));assert.equal(current.repairs,n.repairs+Number(stopped));
	assert.equal(f.inbox.length,notices+Number(stopped));
	if (stopped) {
		assert.notEqual(current.token,w.token);assert.deepEqual(f.inbox.at(-1),{worker:w.id,token:current.token});
		await assert.rejects(writer.operation("submit",{run,token:w.token},w.id),{code:"stale_assignment"});
		assert.ok(JSON.stringify(evidence.correction).includes(n.reason ?? assert.fail()));
	} else assert.equal(current.token,w.token);
	put(w.cwd,`${dir}/action`,"discard");
	await writer.operation("submit",{run,token:current.token},w.id);
	const result=owner.inspect({run,detail:"proof"},"owner");assert.ok(result.qualified);
	assert.equal(git(f.root,"show",`${result.qualified}:${dir}/test`),"nonempty");
	assert.equal(git(f.root,"show",`${result.qualified}:${dir}/action`),"discard");
	assert.equal(git(f.root,"show",`${result.qualified}:${file}`),excerpt);
	assert.equal(result.products?.at(-1)?.receipt?.commit,result.qualified);
	assert.equal(result.goal?.receipt?.commit,result.qualified);
	const end=db.read(run);assert.ok(end);
	const launch=end.effects.find(e=>e.kind==="writer" && e.grain===grain),original=before.effects.find(e=>e.id===launch?.id);
	assert.ok(launch?.kind==="writer" && original?.kind==="writer");assert.deepEqual(launch.writing,original.writing);
	const c=end.effects.find(e=>e.id===end.nodes[grain].check);assert.ok(c?.kind==="component" && c.commit);db.verifySigned(run,c);
	if(legacy)assert.equal(end.inspections,undefined);
	else{
		const i=end.inspections?.find(i=>i.component===c.id);assert.ok(i?.state==="approved");
		assert.equal(i.task.trim(),task);assert.ok(c.attempt?.version===3 && c.attempt.source.kind==="writer" && c.attempt.source.id===launch.id);
		/** @param {typeof end} r */
		const published=r=>{
			const p=r.effects.find(e=>e.id===r.products.at(-1)?.check);assert.ok(p?.kind==="product");
			return recordedAttempt(r,p,sourceAt(r,p));
		};
		assert.equal(published(end),true);assert.equal(published({...end,inspections:[]}),false);
		const changed=structuredClone(end),r=changed.effects.find(e=>e.id===review.id);assert.ok(r?.kind==="scout" && r.correction);
		r.correction.worker="unbound-peer";assert.equal(published(changed),false);
	}
	/** @param {import("./model.js").Run} r */
	function reviewRecord(r) {const e=r.effects.find(e=>e.id===review.id);return e?.kind==="scout" && e.observation;}
});

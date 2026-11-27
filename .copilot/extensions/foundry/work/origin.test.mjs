import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { editions } from "../test/cutover98.mjs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { factory, put } from "../test/fixture.mjs";
import { guideReplay, launchDescription, recipient } from "../test/portable.mjs";
import { checksum, openDatabase } from "./database.mjs";
import { requestedSource, sourceBinding } from "./supplier.mjs";
import { declaredWriter } from "./origin.mjs";
import { publishedComponent } from "./publication.mjs";

test("a new writer publishes its own bytes; a dependent can spend only the reviewed transitive input versions",async t=>{
	const run="entries",source=".foundry/entries.json",ids=["raw","index","page"],check="component.mjs";
	const needs=[[],["raw"],["index"]],f=factory(t,run,source,{
		[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Publish the complete index.",goalCheck:"goal.mjs",
			productCheck:"product.mjs",squads:[{id:"entries",areas:["entries"],charter:"brief",checks:[check]}]}),
		brief:"Write the assigned entry.",".foundry/entries/journey.md":"Read the final page.",
		[check]:`import {readFileSync} from "node:fs";const id=process.env.FOUNDRY_GRAIN; if(readFileSync("entries/"+id+"/value","utf8")!==id)process.exit(1);`,
		"product.mjs":`import {readFileSync} from "node:fs";for(const id of ${JSON.stringify(ids)})if(readFileSync("entries/"+id+"/value","utf8")!==id)process.exit(1);`,
		"goal.mjs":`import {existsSync} from "node:fs";if(!existsSync("entries/page/value"))process.exit(1);`});
	await f.start();await f.scouts[0].report({outcome:"regenerate",reason:"The entries do not exist.",evidence:["brief"],
		grains:ids.map((id,k)=>({id,directory:"entries/"+id,needs:needs[k],task:"Publish "+id,check}))});
	const db=openDatabase(f.root);t.after(()=>db.close());
	const reader98=(await editions(t).load("database")).openDatabase(f.root);t.after(()=>reader98.close());
	const read=()=>db.read(run)??assert.fail("missing run");
	const env={...process.env,NODE_OPTIONS:`--import=${new URL("../test/claim-imports.mjs",import.meta.url).href}`};
	const evidence=new Map();
	for(const id of ids){
		const before=read(),n=before.nodes[id],worker=f.workers.get(n.worker??"");assert.ok(worker);
		const w=before.effects.find(e=>e.kind==="writer" && e.nativeId===worker.id && e.grain===id);
		assert.ok(w?.kind==="writer" && w.writing);assert.equal(db.isWriter(worker.id),true);
		assert.equal(reader98.isWriter(worker.id),true);assert.deepEqual(reader98.involving(worker.id),[run]);
		assert.throws(()=>reader98.read(run),{code:"corrupt_run"});
		assert.deepEqual(w.writing.inputs,Object.fromEntries(evidence),id);
		if(id!=="raw"){
			const s=requestedSource(before,n,{grain:"raw",file:"entries/raw/value"});
			assert.equal(s.component,evidence.get("raw").component);assert.ok(sourceBinding(before,s));
			assert.equal(sourceBinding(before,{...s,assignment:w.id}),false);
		}
		put(worker.cwd,`entries/${id}/value`,id);
		const writer=f.runtime(worker.cwd,{execute:async(tool,args,call)=>{
			if(tool!=="bash")return f.execute(tool,args,call);
			const child=spawnSync("/bin/sh",["-c",String(args.command)],{cwd:worker.cwd,encoding:"utf8",env});
			assert.equal(child.status,0,child.stderr);return {resultType:"success",textResultForLlm:child.stdout};
		}});
		await writer.operation("submit",{run,token:worker.token},worker.id);
		const after=read(),node=after.nodes[id],c=after.effects.find(e=>e.id===node.check),i=after.inspections?.find(i=>i.component===node.check);
		assert.ok(c?.kind==="component" && c.attempt?.version===3 && c.receipt?.exit===0);db.verifySigned(run,c);
		assert.ok(i?.workflow && i.dispatch && i.state==="approved");evidence.set(id,{revision:c.commit,component:c.id,review:i.id});
	}
	const state=read(),at=state.products.at(-1),proof=f.owner.inspect({run,detail:"proof"},"owner").qualification;
	assert.ok(at?.qualifiedAt && proof && proof.commit===at.commit && state.goal?.check!==at.check);
	const held=structuredClone(state),inspection=held.inspections?.find(i=>i.grain==="raw"),page=held.effects.find(e=>e.kind==="writer" && e.grain==="page");
	assert.ok(inspection?.state==="approved" && page?.kind==="writer");inspection.permissionHold="Current use requires permission";
	assert.equal(publishedComponent(held,inspection.component,"raw",inspection.candidate),undefined);
	assert.ok(declaredWriter(held,page),"a later hold cannot make the original dependent grant unreadable");
	for(const c of state.effects)if(c.tool==="bash"){assert.equal(c.attempt?.version,3);db.verifySigned(run,c);}
	const dest=recipient(f.root,proof,"separate-ledger-free-clone"),replay=guideReplay(dest,launchDescription(dest,"release"));assert.equal(replay.status,0,replay.stderr);
	const raw=new DatabaseSync(db.file);t.after(()=>raw.close());
	const original=raw.prepare("SELECT document FROM runs WHERE id=?").get(run);assert.ok(typeof original?.document==="string");
	const save=(/** @type {string} */ doc)=>raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc,checksum(doc),run);
	for(const change of ["extra","missing","remapped","unreviewed"]){
		const wire=JSON.parse(original.document),w=wire.effects.find((/** @type {import("./model.js").NativeCall} */ e)=>e.kind==="writer" && e.grain==="page");
		if(change==="extra")w.writing.inputs.page=evidence.get("page");
		if(change==="missing")delete w.writing.inputs.raw;
		if(change==="remapped")w.writing.inputs.raw={...w.writing.inputs.index};
		if(change==="unreviewed")w.writing.inputs.raw.review=w.writing.inputs.index.review;
		try{save(JSON.stringify(wire));assert.throws(read,{code:"corrupt_run"},change);}finally{save(original.document);}
	}
	assert.deepEqual(read().products.at(-1),at);
});

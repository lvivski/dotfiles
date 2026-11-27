import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { factory, git, put } from "../test/fixture.mjs";
import { fixture, propose, proof, run, worker } from "../test/release.mjs";
import { guideReplay, launchDescription, launchPlan, recipient } from "../test/portable.mjs";
import { changedFiles } from "./product.mjs";

for(const inline of [false,true])test(`portable goal requires the exact private scheduling input without disclosing it / ${inline?"inline and file":"file"}`,async t=>{
	const privateValue='{"observation":"private fixture measurement"}';
	const prior=process.env.FOUNDRY_FIXTURE_MEASUREMENT;process.env.FOUNDRY_FIXTURE_MEASUREMENT=privateValue;
	t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_FIXTURE_MEASUREMENT;else process.env.FOUNDRY_FIXTURE_MEASUREMENT=prior;});
	const f=fixture(t,["producer"],"true",undefined,(t,id,source,files)=>factory(t,id,source,{...files,
		"goal.mjs":`import {existsSync,writeFileSync,readFileSync} from "node:fs";
		if(!existsSync("producer/result")){${inline?'console.log("FOUNDRY_GOAL_FEEDBACK="+process.env.FOUNDRY_FIXTURE_MEASUREMENT)':'writeFileSync(process.env.FOUNDRY_GOAL_FEEDBACK_FILE,process.env.FOUNDRY_FIXTURE_MEASUREMENT)'};process.exit(1);}
		const delta=readFileSync(process.env.FOUNDRY_GOAL_DELTA_FILE,"utf8");
		if(process.env.FOUNDRY_GOAL_DELTA!==${inline?"delta":"undefined"})process.exit(2);
		if((await import("node:crypto")).createHash("sha256").update(JSON.stringify(JSON.parse(delta).previous)).digest("hex")!=="${createHash("sha256").update(privateValue).digest("hex")}")process.exit(2);`}));
	await f.start();await f.scouts[0].report(propose("producer"));
	const w=worker(f,"producer");put(w.cwd,"producer/result","observed");
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);await f.settle();
	const record=proof(f).qualification;assert.ok(record);
	const v=record.receipts.goal.inputs;assert.equal(v.delta?.inline,inline);assert.equal(JSON.stringify(record).includes("private fixture measurement"),false);
	const dest=recipient(f.root,record),calls=f.checks.slice();
	assert.throws(()=>launchPlan(dest,"goal"),/private scheduling input/);
	const local=join(dest,"separately-supplied.json");writeFileSync(local,"wrong");assert.throws(()=>launchPlan(dest,"goal",local),/private scheduling input/);
	const delta=JSON.stringify({version:1,base:f.tip,head:record.commit,paths:changedFiles(f.root,f.tip,record.commit),previous:JSON.parse(privateValue)});
	writeFileSync(local,delta);const description=launchDescription(dest,"goal",local);
	/** @type {import("../../../skills/foundry/scripts/materialize.mjs").Step} */ const check=JSON.parse(description).steps[1],env=check.env;
	assert.equal(env.FOUNDRY_GOAL_DELTA,undefined);assert.equal(env.FOUNDRY_PREPARED_DIR,undefined);assert.equal(env.FOUNDRY_OUTPUTS,undefined);
	assert.equal(readFileSync(env.FOUNDRY_GOAL_DELTA_FILE??assert.fail(),"utf8"),delta);
	assert.equal(check.envFiles?.FOUNDRY_GOAL_DELTA,inline?env.FOUNDRY_GOAL_DELTA_FILE:undefined);
	assert.ok(!JSON.stringify(check).includes("private fixture measurement"));
	const replay=guideReplay(dest,description);assert.equal(replay.status,0,replay.stderr);
	assert.deepEqual(f.checks,calls);
	const db=openDatabase(f.root);try{
		const state=db.read(run),g=state?.effects.find(e=>e.id===state.goal?.check);assert.ok(g?.tool==="bash" && g.receipt?.inputs);
		assert.deepEqual(g.receipt.inputs,v);db.verifySigned(run,g);
		const privateBlob=state?.effects.find(e=>e.kind==="goal" && e.receipt?.exit===1)?.receipt?.feedbackFile?.blob;assert.ok(privateBlob);
		assert.throws(()=>git(dest,"cat-file","-e",privateBlob),"The private feedback blob is not a bundle input");
	}finally{db.close();}
});

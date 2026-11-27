import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { factory } from "../test/fixture.mjs";
import { checksum, openDatabase } from "./database.mjs";

test("a current activation cannot sit inside the historical prefix in either reader; restoring its original row resumes that call",async t=>{
	const run="count",source=".foundry/count.json",f=factory(t,run,source,{[source]:JSON.stringify({version:2,id:run,direction:"Count the entries.",
		target:"refs/heads/main",productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"counts",areas:["entries"],charter:"brief",checks:["product.mjs"]}]}),
		brief:"Count the entries.",".foundry/count/journey.md":"Observe zero.","goal.mjs":"","product.mjs":""});
	const owner=f.runtime(f.root,{execute:async()=>({resultType:"unconfirmed"})});await f.start(owner);
	const db=openDatabase(f.root);t.after(()=>db.close());const r=db.read(run)??assert.fail();
	const c=r.effects.find(e=>e.id===r.goal?.check);assert.ok(c?.tool==="bash" && c.attempt?.version===3 && c.callId && !c.runnerClaim);
	const raw=new DatabaseSync(db.file);t.after(()=>raw.close());
	const row=raw.prepare("SELECT document FROM runs WHERE id=?").get(run);assert.ok(typeof row?.document==="string");
	const save=(/** @type {string} */ doc)=>raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(doc,checksum(doc),run);
	const keys=join(dirname(f.root),"claim-keys"),env={...process.env,FOUNDRY_TEST_KEYS:keys,NODE_OPTIONS:`--import=${new URL("../test/key-trace.mjs",import.meta.url).href}`};
	const shell=()=>spawnSync("/bin/sh",["-c",String(c.args.command)],{cwd:f.root,encoding:"utf8",env});
	for(const change of ["current check in the historical prefix","legacy review exemption on a fresh activation"]){
		const doc=JSON.parse(row.document);
		if(change.startsWith("current"))doc.historicalPrefix={length:1,last:c.id};
		else{doc.reviewContract="legacy-no-review";delete doc.inspections;}
		try{
			save(JSON.stringify(doc));
			const rejected=shell();assert.notEqual(rejected.status,0,change);
			assert.equal(existsSync(keys),false,"refuse before generating a key, not just before publication");
			assert.throws(()=>db.read(run),{code:"corrupt_run"});
		}finally{save(row.document);}
	}
	const result=shell();assert.equal(result.status,0,result.stderr);assert.deepEqual(readFileSync(keys,"utf8").trim().split("\n"),[c.id]);
	owner.turn("owner");await owner.flush();const at=db.read(run)?.effects.find(e=>e.id===c.id);
	assert.ok(at?.tool==="bash" && at.callId===c.callId && at.receipt?.exit===0);db.verifySigned(run,at);
});

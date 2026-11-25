import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { git, put } from "../test/fixture.mjs";
import { activation, failedFinalDiagnostic } from "../test/ownership.mjs";
import { createRuntime } from "./runtime.mjs";

const fixedActivation=activation('state==="idle" || state==="dismissed"');
const reopenTest=`import assert from "node:assert/strict";
import {transition} from "./activation.mjs";
const first=transition("idle","activate"), dismissed=transition(first,"dismiss");
assert.equal(first,"open"); assert.equal(dismissed,"dismissed");
assert.equal(transition(dismissed,"activate"),"open","must reopen after dismissal");`;

for (const mode of ["production pass","production fail","production primary"]) test(`partial repartition of a checked mixed grant / ${mode}`,async t=>{
	const {f,db,ledger:original,component,producer,implementation,regression,sourceFile:observer,offer,run,citation,file}=await failedFinalDiagnostic(t,mode);
	const pass=mode!=="production fail", diagnostic=component.id, other=producer==="selector"?citation:file;
	const prior=original.nodes[producer];
	assert.ok(component.commit && prior && original.goal);
	const otherBytes=git(f.root,"show",`${component.commit}:${other}`);
	const cases=original.nodes.selector.restoration;assert.ok(cases);
	const task="Reproduce reopening in the normal regression suite before changing the production behavior.";
	const choice={run,diagnostic,candidate:component.commit,goal:cases.goal,checkpoint:cases.checkpoint,producer,files:[implementation,regression],task};
	const owner=f.runtime(f.root,{confirm:async msg=>{assert.ok([diagnostic,implementation,regression,original.nodes.buttons.check].every(p=>p && msg.includes(p)));return true;}},createRuntime);
	await assert.rejects(owner.operation("iterate",{run,receipt:cases.goal,directory:prior.grain.directory,blob:offer.blob,question:task},"owner"),{code:"ownership_transition"});
	assert.deepEqual(db.read(run),original);
	async function grant() {
		await owner.operation("remediate",choice,"owner");
		const writer=[...f.workers.values()].at(-1);assert.ok(writer && writer.prompt.includes(implementation));
		assert.equal(git(writer.cwd,"rev-parse","HEAD"),choice.candidate);
		assert.equal(owner.inspect({run,detail:"proof"},"owner").qualified,null);
		return {writer,edit:f.runtime(writer.cwd,{},createRuntime),submit:{run,token:writer.token}};
	}
	// A locally green probe is not an instruction to modify production.
	if (!pass) {
		const {writer,edit,submit}=await grant(), count=f.checks.length;
		await edit.operation("submit",{...submit,missingInput:"The reported mismatch did not reproduce."},writer.id);
		assert.deepEqual(db.read(run)?.nodes,original.nodes);assert.equal(f.checks.length,count);
		assert.match(owner.inspect({run,detail:"proof"},"owner").productionRepairs?.at(-1)?.reason??"",/did not reproduce/);
		const saved=db.read(run);
		await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("remediate",choice,"owner"),{code:"approval_declined"});
		await assert.rejects(owner.operation("remediate",{...choice,files:[observer]},"owner"),{code:"production_scope"});
		await assert.rejects(owner.operation("remediate",{...choice,goal:diagnostic},"owner"),{code:"invalid_production"});
		await assert.rejects(owner.operation("remediate",choice,"another-session"),{code:"foreign_run"});
		const moved=f.runtime(f.root,{confirm:async()=>{git(f.root,"update-ref","refs/heads/main",choice.candidate,f.tip);return true;}},createRuntime);
		try {await assert.rejects(moved.operation("remediate",choice,"owner"),{code:"stale_assignment"});}
		finally {git(f.root,"update-ref","refs/heads/main",f.tip,choice.candidate);}
		assert.deepEqual(db.read(run),saved);
	}
	const {writer,edit,submit}=await grant();
	put(writer.cwd,regression,reopenTest);
	const check=()=>spawnSync(process.execPath,[regression],{cwd:writer.cwd,encoding:"utf8"});
	const red=check();assert.equal(red.status,1);assert.match(red.stderr,/must reopen after dismissal/);
	put(writer.cwd,implementation,fixedActivation);
	assert.equal(check().status,0);
	put(writer.cwd,other,"outside grant");
	await assert.rejects(edit.operation("submit",submit,writer.id),{code:"production_scope"});
	put(writer.cwd,other,otherBytes);
	const calls=f.checks.length;
	await edit.operation("submit",submit,writer.id);owner.turn("owner");await owner.flush();
	const done=owner.inspect({run,detail:"proof"},"owner"), updated=db.read(run);assert.ok(updated);
	const checks=updated.effects.filter(e=>e.kind==="component" && !original.effects.some(x=>x.id===e.id));
	assert.deepEqual(checks.map(e=>e.grain).sort(),["buttons","selector"]);assert.equal(checks[0].commit,checks[1].commit);
	for (const e of checks) {
		assert.ok(e.kind==="component" && e.remedy);
		db.verifySigned(run,e);assert.throws(()=>db.verifySigned(run,{...e,remedy:undefined}),{code:"wrong_outcome"});
	}
	for (const e of original.effects.filter(e=>e.tool==="bash")) assert.deepEqual(updated.effects.find(x=>x.id===e.id),e);
	for (const [id,n] of Object.entries(original.nodes)) if(!["buttons","selector"].includes(id)) {
		assert.equal(updated.nodes[id].candidate,n.candidate);assert.equal(updated.nodes[id].check,n.check);
	}
	if(pass){
		assert.ok(done.qualified && done.qualification);assert.ok(checks.every(c=>c.receipt?.exit===0));
		assert.equal(done.qualification.receipts.product.commit,done.qualified);assert.equal(done.qualification.receipts.goal.commit,done.qualified);
		assert.equal(git(f.root,"show",`${done.qualified}:${implementation}`),fixedActivation);assert.equal(git(f.root,"show",`${done.qualified}:${regression}`),reopenTest);
		assert.equal(git(f.root,"show",`${done.qualified}:${observer}`),"after-event");
	}else{
		assert.equal(checks.find(e=>e.grain===producer)?.receipt?.exit,0);
		assert.equal(checks.find(e=>e.grain!==producer)?.receipt?.exit,1);
		assert.equal(done.qualified,null);assert.deepEqual(updated.products,original.products);assert.deepEqual(updated.goal,original.goal);
		assert.deepEqual(updated.nodes,original.nodes);assert.equal(f.checks.length,calls+2);
		const fresh=await grant();
		put(fresh.writer.cwd,regression,reopenTest);put(fresh.writer.cwd,implementation,fixedActivation);
		await assert.rejects(fresh.edit.operation("submit",fresh.submit,fresh.writer.id),{code:"unchanged_candidate"});
		assert.equal(f.checks.length,calls+2);
	}
});

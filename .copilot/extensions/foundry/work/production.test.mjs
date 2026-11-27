import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { git, put } from "../test/fixture.mjs";
import { activation, failedFinalDiagnostic } from "../test/ownership.mjs";
import { candidatePacket } from "./critique.mjs";
import { currentInspection, inspectComponent, markInspection } from "./inspection.mjs";
import { productionResult } from "./production.mjs";
import { createRuntime } from "./runtime.mjs";
import { grant as ownership } from "./transfer.mjs";

const fixedActivation=activation('state==="idle" || state==="dismissed"');
const reopenTest=`import assert from "node:assert/strict";
import {transition} from "./activation.mjs";
const first=transition("idle","activate"), dismissed=transition(first,"dismiss");
assert.equal(first,"open"); assert.equal(dismissed,"dismissed");
assert.equal(transition(dismissed,"activate"),"open","must reopen after dismissal");`;

/** Use the real receipts from the disposable historical failure, on a private planning snapshot.
 * The old run itself never opts into a new authority contract.
 * @param {string} cwd @param {import("./model.js").Run} draft @param {import("./model.js").Run} original @param {string} producer */
function exerciseReviews(cwd,draft,original,producer) {
	const n=draft.nodes[producer], job=draft.effects.find(e=>e.kind==="writer" && e.token===n.token);
	const producerCheck=draft.effects.find(e=>e.id===n.check), cohort=draft.effects.filter(e=>e.kind==="component" && e.remedy?.writer===job?.id);
	assert.ok(job?.kind==="writer" && job.production && producerCheck?.kind==="component" && cohort.length===2);
	const held=original.nodes.buttons, previous=draft.effects.find(e=>e.id===held.check);
	assert.ok(previous?.kind==="component" && previous.commit);
	const failed=draft.effects.find(e=>e.id===job.production?.diagnostic);assert.ok(failed?.kind==="component" && failed.observer);
	const pair=draft.effects.find(e=>e.id===failed.observer?.pair);assert.ok(pair?.kind==="component" && pair.pair);
	/** @param {import("./model.js").Inspection} i @param {"approved"|"changes"} outcome */
	function report(i,outcome) {
		markInspection(i,"issue",{dispatch:`dispatch-${i.id}`});markInspection(i,"bind",{workflow:`workflow-${i.id}`});
		markInspection(i,outcome,{summary:outcome==="approved"?"No blocking findings.":"The changed assertion no longer checks the result."});
	}
	draft.inspections=[];
	const before=inspectComponent(draft,held,previous,draft.owner);assert.ok(before);report(before,"approved");
	const count=draft.effects.length;
	/** @param {import("./model.js").Run} r */
	function settle(r) {
		const w=r.effects.find(e=>e.id===job?.id), e=r.effects.find(e=>e.id===producerCheck?.id);
		assert.ok(w?.kind==="writer" && e?.kind==="component");
		productionResult(cwd,r,w,e);
	}
	settle(draft);
	if (cohort.some(c=>c.receipt?.exit!==0)) {
		assert.deepEqual(draft.inspections,[before],"one passing check cannot authorize either assembly inspection");
		assert.deepEqual(draft.nodes,original.nodes);return;
	}
	assert.equal(draft.nodes[producer].state,"checking","neither owner may publish before independent approval");
	assert.equal(draft.join,undefined);
	const first=draft.inspections.find(i=>i.component===cohort[0].id);assert.ok(first);
	assert.equal(first.grain,pair.grain);assert.equal(first.generation,pair.commit);
	assert.deepEqual(first.scope,{directories:[],files:[...producer===first.grain ? job.production.files : [],failed.observer.file]});
	assert.match(candidatePacket(cwd,first).prompt,/after-event/,"the approved production grant alone misses the earlier diagnostic edit");
	assert.ok(currentInspection(draft,first));assert.equal(currentInspection(draft,{...first,scope:{directories:["unit"],files:[]}}),false);
	const foreign=structuredClone(draft), stolen=foreign.inspections?.find(i=>i.id===first.id);assert.ok(stolen && job.nativeId);
	stolen.issuer=job.nativeId;assert.equal(currentInspection(foreign,stolen),false,"a production writer cannot claim its peer's review packet");
	report(first,"approved");settle(draft);
	const second=draft.inspections.find(i=>i.component===cohort[1].id);assert.ok(second);
	assert.equal(draft.nodes[producer].state,"checking");assert.deepEqual(draft.products,original.products);
	assert.equal(second.grain,pair.pair.retainer);
	assert.deepEqual(second.scope,producer===second.grain ? {directories:[],files:job.production.files} : ownership(held));
	const blocked=structuredClone(draft), other=blocked.inspections?.find(i=>i.id===second.id);assert.ok(other);
	report(other,"changes");settle(blocked);settle(blocked);
	assert.match(blocked.effects.find(e=>e.id===job.id)?.error??"",/assertion no longer checks.*does not authorize another submission/);
	assert.deepEqual(blocked.nodes,original.nodes);assert.deepEqual(blocked.products,original.products);assert.equal(blocked.effects.length,count);
	assert.equal(currentInspection(blocked,other),false);
	report(second,"approved");second.permissionHold="issuer may not publish";settle(draft);
	assert.equal(draft.nodes[producer].state,"checking");
	delete second.permissionHold;settle(draft);
	for (const c of cohort) {const node=draft.nodes[c.grain??""];assert.equal(node.state,"published");assert.equal(node.check,c.id);assert.equal(node.candidate,c.commit);}
	const finished=structuredClone(draft);settle(draft);assert.deepEqual(draft,finished);
}

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
	/** @type {import("./model.js").Run|undefined} */ let checked;
	async function grant() {
		await owner.operation("remediate",choice,"owner");
		const writer=[...f.workers.values()].at(-1);assert.ok(writer && writer.prompt.includes(implementation));
		assert.equal(git(writer.cwd,"rev-parse","HEAD"),choice.candidate);
		assert.equal(owner.inspect({run,detail:"proof"},"owner").qualified,null);
		return {writer,edit:f.runtime(writer.cwd,{execute:async(tool,args,id)=>{
			const reply=await f.execute(tool,args,id);
			const latest=db.read(run), cohort=latest?.effects.filter(e=>e.kind==="component" && e.remedy);
			if (latest?.nodes[producer].state==="checking" && cohort?.length===2 && cohort.every(c=>c.receipt)) checked=latest;
			return reply;
		}},createRuntime),submit:{run,token:writer.token}};
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
	assert.equal(updated.inspections,undefined);assert.ok(checked);exerciseReviews(f.root,structuredClone(checked),original,producer);
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

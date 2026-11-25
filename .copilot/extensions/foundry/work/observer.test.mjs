import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { git, put } from "../test/fixture.mjs";
import { observerInputs, replacementInputs } from "../test/ownership.mjs";
import { prepareObserver } from "./observer.mjs";
import { createRuntime } from "./runtime.mjs";

for (const mode of ["observer pass","observer fail"]) test(`partial repartition of a checked mixed grant / ${mode}`,async t=>{
	const {f,run,db,approve,author,attester,buttons,beforeIndependent,paired,number,sourceFile,citation,file,saved,original,pins,priorChecks,end}=await observerInputs(t,mode);
	assert.ok(paired.pair);
	await assert.rejects(approve.operation("diagnose",{...author,file,blob:git(f.root,"rev-parse",`${paired.commit}:${file}`)},"owner"),{code:"observer_scope"});
	await assert.rejects(approve.operation("diagnose",{...author,file:citation,blob:git(f.root,"rev-parse",`${paired.commit}:${citation}`)},"owner"),{code:"observer_scope"});
	await assert.rejects(approve.operation("diagnose",{...author,blob:f.tip},"owner"),{code:"observer_scope"});
	await assert.rejects(approve.operation("diagnose",author,attester.id),{code:"foreign_run"});
	const consent=prepareObserver(f.root,saved,"owner",author,e=>db.verifySigned(run,e));
	const moved=structuredClone(saved);moved.nodes.buttons.candidate=f.tip;
	assert.throws(()=>consent.apply(moved),{code:"stale_assignment"});
	const consuming=structuredClone(saved);consuming.nodes.rail.supporting=[sourceFile];
	assert.throws(()=>consent.apply(consuming),{code:"stale_assignment"});
	const limited=structuredClone(saved);limited.policy.assignments=1;
	assert.throws(()=>consent.apply(limited),{code:"limit"});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("diagnose",author,"owner"),{code:"approval_declined"});
	assert.deepEqual(db.read(run),saved);
	await approve.operation("diagnose",author,"owner");
	const w=[...f.workers.values()].at(-1);assert.ok(w && w.id!==attester.id && w.id!==buttons.id);
	assert.equal(f.workers.size,number+1);assert.equal(git(w.cwd,"rev-parse","HEAD^{tree}"),paired.pair.tree);
	const wr=f.runtime(w.cwd,{},beforeIndependent), submission={run,token:w.token};
	await assert.rejects(wr.operation("submit",{run,token:attester.token},attester.id),{code:"stale_assignment"});
	await assert.rejects(wr.operation("submit",submission,w.id),{code:"observer_scope"});
	put(w.cwd,sourceFile,"phase-aware");put(w.cwd,citation,"outside approved file");
	await assert.rejects(wr.operation("preview",submission,w.id),{code:"observer_scope"});
	put(w.cwd,citation,"keep");
	const peek=await wr.operation("preview",submission,w.id), preview=peek.nodes.find(n=>n.grain==="selector")?.preview;assert.ok(preview);
	await assert.rejects(wr.operation("submit",submission,w.id),{code:"approval_required"});
	const decline=f.runtime(f.root,{confirm:async()=>false},createRuntime);
	await assert.rejects(decline.operation("diagnose",{...author,preview},"owner"),{code:"approval_declined"});
	await assert.rejects(wr.operation("submit",submission,w.id),{code:"approval_required"});
	await approve.operation("diagnose",{...author,preview},"owner");
	put(w.cwd,sourceFile,"different");await assert.rejects(wr.operation("submit",submission,w.id),{code:"stale_assignment"});
	put(w.cwd,sourceFile,"phase-aware");await wr.operation("submit",submission,w.id);
	const proof=approve.inspect({run,detail:"proof"},"owner"), result=proof.nodes.find(n=>n.grain==="selector");
	assert.ok(result?.receipt);assert.equal(result.receipt.exit,mode==="observer pass"?0:1);
	const settled=db.read(run);assert.ok(settled);assert.deepEqual(settled.effects.find(e=>e.id===paired.id),paired);
	const freshCheck=settled.effects.find(e=>e.id===result?.check);assert.ok(freshCheck?.kind==="component" && freshCheck.observer?.after);
	db.verifySigned(run,freshCheck);
	assert.throws(()=>db.verifySigned(run,{...freshCheck,observer:undefined}),{code:"wrong_outcome"});
	assert.deepEqual(settled.effects.find(e=>e.id===original.id),original);
	assert.ok(Object.entries(pins).every(([id,pin])=>settled.nodes[id].check===saved.nodes[id].check && settled.nodes[id].candidate===pin));
	assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector","Check selector","Check selector",...(mode==="observer pass"?["Check joined product","Check final goal"]:[])]);
	if (mode==="observer fail") {
		assert.equal(proof.qualified,null);assert.deepEqual(proof.products,end.products);assert.equal(result?.state,"blocked");
		await assert.rejects(approve.operation("diagnose",author,"owner"),{code:"invalid_observer"});
	} else {
		assert.ok(proof.qualification && proof.qualified && result?.check);
		assert.equal(proof.qualification.receipts.product.commit,proof.qualified);
		assert.equal(proof.qualification.receipts.goal.commit,proof.qualified);
		assert.equal(git(f.root,"show",`${proof.qualified}:${sourceFile}`),"phase-aware");
		assert.ok(Object.entries(pins).every(([id,pin])=>proof.outputs?.[id]===pin));
	}
});

for (const mode of ["replacement pass","replacement fail"]) test(`partial repartition of a checked mixed grant / ${mode}`,async t=>{
	const {f,run,db,owner,request,previous,settled,paired,file,citation,w,phases,diagnosticReader,submission,sourceFile,frames,primary,freshCheck,original,pins,number,proof}=await replacementInputs(t,mode);
	const approval=prepareObserver(f.root,settled,"owner",request,e=>db.verifySigned(run,e));
	const moved=structuredClone(settled);moved.nodes.buttons.candidate=f.tip;
	assert.throws(()=>approval.apply(moved),{code:"stale_assignment"});
	const refuse=f.runtime(f.root,{confirm:async()=>assert.fail("invalid writer reached consent")},createRuntime);
	await assert.rejects(refuse.operation("diagnose",{...request,previous:{...previous,candidate:paired.commit}},"owner"),{code:"invalid_observer"});
	await assert.rejects(refuse.operation("diagnose",{...request,previous:{...previous,check:paired.id}},"owner"),{code:"invalid_observer"});
	await assert.rejects(refuse.operation("diagnose",{...request,file:citation},"owner"),{code:"invalid_observer"});
	await assert.rejects(refuse.operation("diagnose",request,w.id),{code:"foreign_run"});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("diagnose",request,"owner"),{code:"approval_declined"});
	assert.deepEqual(db.read(run),settled);
	await owner.operation("diagnose",request,"owner");
	const next=[...f.workers.values()].at(-1);assert.ok(next && next.id!==w.id && phases.every(p=>next.prompt.includes(p)));
	assert.equal(git(next.cwd,"rev-parse","HEAD"),previous.candidate);
	const worker=f.runtime(next.cwd,{},diagnosticReader), submit={run,token:next.token};
	await assert.rejects(owner.operation("diagnose",request,"owner"),{code:"invalid_observer"});
	await assert.rejects(f.runtime(w.cwd,{},createRuntime).operation("submit",submission,w.id),{code:"stale_assignment"});
	await assert.rejects(worker.operation("submit",submit,next.id),{code:"observer_scope"});
	put(next.cwd,sourceFile,"aggregate");
	await assert.rejects(worker.operation("preview",submit,next.id),{code:"observer_scope"});
	put(next.cwd,sourceFile,"after-event");
	const control=mkdtempSync(path.join(tmpdir(),"observer-controls-"));t.after(()=>rmSync(control,{recursive:true,force:true}));
	for (const path of [sourceFile,file,"unit.mjs"]) put(control,path,path===sourceFile?"after-event":git(f.root,"show",`${previous.candidate}:${path}`));
	for (const fault of [-1,0,1,2]) {
		const expected=[true,false,true];if (fault>=0) expected[fault]=!expected[fault];
		put(control,"device/events.json",frames(expected));
		const check=spawnSync(process.execPath,["unit.mjs"],{cwd:control,encoding:"utf8",env:{FOUNDRY_DIRECTORY:primary}});
		assert.equal(check.status,fault<0?0:1,check.stderr);
		if (fault>=0) assert.ok(check.stdout.includes(phases[fault]+": expected "));
	}
	const draft=(await worker.operation("preview",submit,next.id)).nodes.find(n=>n.grain==="selector")?.preview;assert.ok(draft);
	await assert.rejects(worker.operation("submit",submit,next.id),{code:"approval_required"});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("diagnose",{...request,preview:draft},"owner"),{code:"approval_declined"});
	await owner.operation("diagnose",{...request,preview:draft},"owner");
	put(next.cwd,sourceFile,"not approved");await assert.rejects(worker.operation("submit",submit,next.id),{code:"stale_assignment"});
	put(next.cwd,sourceFile,"after-event");
	await worker.operation("submit",submit,next.id);owner.close();
	const after=f.runtime(f.root,{},diagnosticReader);
	after.turn("owner");await after.flush();
	const final=after.inspect({run,detail:"proof"},"owner"), outcome=final.nodes.find(n=>n.grain==="selector");
	assert.ok(outcome?.receipt && outcome.check);
	const ledger=db.read(run);assert.ok(ledger);
	const component=ledger.effects.find(e=>e.id===outcome.check);assert.ok(component?.kind==="component" && component.observer);
	db.verifySigned(run,component);assert.throws(()=>db.verifySigned(run,{...component,observer:freshCheck.observer}),{code:"wrong_outcome"});
	for(const e of [original,paired,freshCheck]) assert.deepEqual(ledger.effects.find(i=>i.id===e.id),e);
	assert.ok(Object.entries(pins).every(([id,pin])=>ledger.nodes[id].candidate===pin && ledger.nodes[id].check===settled.nodes[id].check));
	assert.equal(f.workers.size,number+2);assert.equal(final.pending.length,0);
	if (mode==="replacement pass") {
		assert.ok(final.qualified && final.qualification);assert.equal(final.qualification.receipts.goal.commit,final.qualified);
		assert.equal(final.qualification.receipts.product.commit,final.qualified);
		assert.equal(git(f.root,"show",`${final.qualified}:${sourceFile}`),"after-event");assert.equal(git(f.root,"show",`${final.qualified}:${file}`),"current button");
		assert.ok(Object.entries(pins).every(([id,pin])=>final.outputs?.[id]===pin));
	} else {
		assert.equal(final.qualified,null);assert.deepEqual(final.products,proof.products);assert.deepEqual(final.goalChecks,proof.goalChecks);
		assert.equal(outcome.receipt.exit,1);assert.match(outcome.receipt.output,/post-dismissal reopen: expected true got false/);
		assert.match(outcome.reason??"",/owner/i);
		await assert.rejects(after.operation("diagnose",{...request,blob:git(f.root,"rev-parse",`${outcome.receipt.commit}:${sourceFile}`),previous:{...previous,check:outcome.check,candidate:outcome.receipt.commit}},"owner"),{code:"invalid_observer"});
		await assert.rejects(after.operation("recheck",{run,check:outcome.check},"owner"),{code:"not_recoverable"});
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { git } from "../test/fixture.mjs";
import { firstObserver } from "../test/ownership.mjs";
import { prepareCheckpoint } from "./checkpoint.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";

for (const mode of ["independent pass","independent fail","independent incomplete"]) test(`partial repartition of a checked mixed grant / ${mode}`,async t=>{
	const {f,run,db,approve,wr,settled,result,args,original,paired,stages,loadInputs,w,b,proof,pins,file,number}=await firstObserver(t,mode);
	const alpha=settled.nodes.alpha, selected=[{grain:"alpha",candidate:alpha.candidate,component:alpha.check}];
	assert.ok(alpha.check && alpha.candidate && result.check && args.component);
	const evidence=[original.id,paired.id,result.check,args.component,alpha.check].map(component=>{
		const key=component===alpha.check?"alpha":component===args.component?"buttons":"selector";
		return {component,stages:Object.fromEntries(stages.map(stage=>[stage,[
			{file:"unit.mjs",excerpt:loadInputs,inventory:{file:"build.json",keys:[key,stage]},reason:stage==="component"?"The evaluator reads the selected grain's declared inputs directly":"No generated or packaged dependency: the direct file assertion runs in the evaluator."}
		]]))};
	});
	const batch={run,observer:result.check,checkpoint:args.checkpoint,goal:args.goal,target:f.tip,selected,evidence};
	await assert.rejects(approve.operation("checkpoint",batch,"owner"),{code:"unknown_operation"});
	approve.close();wr.close();
	const candidate=alpha.candidate;
	let movedBefore=false;
	const fresh=f.runtime(f.root,{confirm:async msg=>{assert.ok(msg.includes(candidate) && msg.includes(result.check??"!"));return true;},
		permissionBlocker:async()=>{
			if (mode==="independent pass" && !movedBefore && db.read(run)?.independent) {
				git(f.root,"update-ref","refs/heads/main",candidate,f.tip);movedBefore=true;
			}
			return null;
		},
		execute:async(tool,a,id)=>{
			const reply=await f.execute(tool,a,id);
			if (mode==="independent pass" && String(a.description).startsWith("Check joined product"))
				git(f.root,"update-ref","refs/heads/main",candidate,f.tip);
			return reply;
		}},createRuntime);
	if(mode==="independent pass"){
		const refused=f.runtime(f.root,{confirm:async()=>assert.fail("invalid batch reached approval")},createRuntime);
		await assert.rejects(refused.operation("checkpoint",{...batch,evidence:evidence.slice(1)},"owner"),{code:"incomplete_evidence"});
		await assert.rejects(refused.operation("checkpoint",{...batch,selected:[]},"owner"),{code:"incomplete_evidence"});
		await assert.rejects(refused.operation("checkpoint",{...batch,selected:[...selected,{...selected[0],grain:"delta"}]},"owner"),{code:"dependent_output"});
		await assert.rejects(refused.operation("checkpoint",{...batch,selected:[{...selected[0],component:args.component}]},"owner"),{code:"dependent_output"});
		await assert.rejects(refused.operation("checkpoint",{...batch,target:alpha.candidate},"owner"),{code:"stale_assignment"});
		await assert.rejects(refused.operation("checkpoint",batch,w.id),{code:"foreign_run"});
		for (const index of [evidence.length-1,0]) {
			const cross=structuredClone(evidence);cross[index].stages.runtime[0].inventory.keys=["bundle","component"];
			await assert.rejects(refused.operation("checkpoint",{...batch,evidence:cross},"owner"),{code:"dependent_output"});
		}
		const missing=structuredClone(evidence);missing[0].stages.runtime[0].inventory.keys=["unknown","runtime"];
		await assert.rejects(refused.operation("checkpoint",{...batch,evidence:missing},"owner"),{code:"incomplete_evidence"});
		const declined=f.runtime(f.root,{confirm:async()=>false},createRuntime);
		await assert.rejects(declined.operation("checkpoint",batch,"owner"),{code:"approval_declined"});
		const prepare=(/** @type {typeof settled} */ r)=>prepareCheckpoint(f.root,r,"owner",batch,e=>db.verifySigned(run,e));
		const consent=prepare(settled), stale=structuredClone(settled);
		stale.nodes.alpha.check=b.check;assert.throws(()=>consent.apply(stale),{code:"dependent_output"});
		const pending=structuredClone(settled);
		const job=pending.effects.find(e=>e.kind==="writer" && e.grain==="delta");assert.ok(job);job.state="uncertain";
		assert.throws(()=>prepare(pending),{code:"dispatch_held"});
		const reads=structuredClone(settled);reads.nodes.buttons.supporting=["unit/alpha/change"];
		assert.throws(()=>prepare(reads),{code:"dependent_output"});
		const unscoped=structuredClone(settled);unscoped.nodes.alpha.generation=original.commit;
		assert.throws(()=>prepare(unscoped),{code:"dependent_output"});
		assert.deepEqual(db.read(run),settled);
	}
	const calls=f.checks.length;
	await fresh.operation("checkpoint",batch,"owner");
	if (mode==="independent pass") {
		assert.ok(movedBefore);assert.equal(f.checks.length,calls,"moving before issue must not spend a call");
		git(f.root,"update-ref","refs/heads/main",f.tip,candidate);
		fresh.turn("owner");await fresh.flush();
		const pending=fresh.inspect({run,detail:"proof"},"owner");
		assert.equal(pending.candidate?.receipt?.exit,0);assert.deepEqual(pending.products,proof.products);
		assert.equal(f.checks.length,calls+1,"moving before settlement must not advance or retry the passing product");
		git(f.root,"update-ref","refs/heads/main",f.tip,candidate);
	}
	fresh.close();
	const reloaded=f.runtime(f.root,{},createRuntime);reloaded.turn("owner");await reloaded.flush();
	const report=reloaded.inspect({run,detail:"proof"},"owner");
	assert.equal(report.qualified,null);assert.equal(report.qualification,null);
	assert.equal(reloaded.inspect({run,detail:"cleanup"},"owner").handoff,null);
	assert.deepEqual(report.checkRecovery,proof.checkRecovery);
	const updated=db.read(run);assert.ok(updated?.independent);
	const updatedReceipt=updated.effects.find(e=>e.id===updated.independent?.product);assert.ok(updatedReceipt?.kind==="product");
	db.verifySigned(run,updatedReceipt);assert.throws(()=>db.verifySigned(run,{...updatedReceipt,isolation:undefined}),{code:"wrong_outcome"});
	assert.deepEqual(updated.effects.slice(0,settled.effects.length),settled.effects);
	assert.deepEqual(updated.products.slice(0,settled.products.length),settled.products);
	assert.ok(Object.entries(pins).every(([id,pin])=>updated.nodes[id].candidate===pin && updated.nodes[id].check===settled.nodes[id].check));
	const stripped=structuredClone(updated);delete stripped.independent;assert.throws(()=>decode(stripped),{code:"corrupt_run"});
	assert.throws(()=>db.planAndSwap(run,r=>{r.nodes.buttons.state="qualified";}),{code:"ownership_transition"});
	assert.deepEqual(db.read(run),updated);
	if(mode==="independent pass"){
		assert.deepEqual(report.outputs,{...proof.outputs,alpha:alpha.candidate});assert.notEqual(report.checkpoint,proof.checkpoint);
		assert.equal(report.goal?.receipt?.exit,0);assert.equal(report.goal?.receipt?.commit,report.checkpoint);
		assert.equal(git(f.root,"diff-tree","--no-commit-id","-r","--name-only",proof.checkpoint??"",report.checkpoint??""),"unit/alpha/change");
		assert.equal(git(f.root,"show",`${report.checkpoint}:${file}`),"new control");
		const goalCheck=updated.effects.at(-1);assert.ok(goalCheck?.kind==="goal");db.verifySigned(run,goalCheck);
	}else{assert.deepEqual(report.products,proof.products);assert.deepEqual(report.goalChecks,proof.goalChecks);assert.equal(report.candidate?.receipt?.exit,mode==="independent fail"?1:null);}
	assert.equal(report.nodes.find(n=>n.grain==="buttons")?.state,"published");
	assert.deepEqual(report.nodes.find(n=>n.grain==="selector"),result);
	await assert.rejects(reloaded.operation("checkpoint",batch,"owner"),{code:"ownership_transition"});
	assert.equal(f.workers.size,number+1);assert.equal(report.pending.length,0);
	assert.equal(f.checks.length,calls+(mode==="independent pass"?2:1));
});

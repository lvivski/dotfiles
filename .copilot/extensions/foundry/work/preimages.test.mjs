import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { factory, git, put, recoveryClock, scriptedInspections } from "../test/fixture.mjs";
import { openDatabase } from "./database.mjs";
import { draftAllowed, draftId } from "./drafts.mjs";
import { pendingScope } from "./commission.mjs";
import { nextAuthor } from "./authors.mjs";
import { prepareDraft } from "./authorship.mjs";
import { reviewBinding } from "./inspection.mjs";
import { inspectComponent } from "./inspections.mjs";
import { validDraftScope } from "./preimages.mjs";
import { memberApproval } from "./receipt.mjs";
import { stagePatch } from "./product.mjs";
import { integrityHolds } from "./revision.mjs";
import { rolloutPlan } from "./rollout.mjs";
import { decode } from "./snapshot.mjs";
import { digest } from "./values.mjs";

const run="records",source=".foundry/records.json",check=".foundry/check.mjs",goal=".foundry/goal.mjs",product=".foundry/product.mjs";
const charter=".foundry/records.md",flag=".foundry/format",first="entries/alpha/value",second="entries/beta/value",sibling="entries/alpha/note",unchanged="entries/alpha/other";
/** @param {string} file @param {string} before @param {string} after */
const edit=(file,before,after)=>`--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

for(const mixed of [false,true])test(mixed?"only an explicit signed-stop scope may select between independent defects":
	"a restored review scope belongs to the finding, not the last runner or an adjacent file",async t=>{
	const ids=["alpha","beta"],f=factory(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Publish both records.",
		productCheck:product,goalCheck:goal,squads:[{id:"entries",charter,areas:["entries"],checks:[check]}]}),
		".foundry/records/journey.md":"Publish both records.",[charter]:"Keep the records distinct.",[check]:"",[product]:"",[flag]:"old\n",
		[goal]:`import {existsSync} from "node:fs";process.exit(existsSync("${first}")||existsSync("${second}")?2:1)`});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"The two records are absent.",evidence:[charter],
		grains:ids.map(id=>({id,directory:`entries/${id}`,task:`Publish the ${id} record.`,check,needs:id==="beta"?["alpha"]:[]}))});
	const db=openDatabase(f.root);t.after(()=>db.close());
	const read=()=>db.read(run)??assert.fail();
	for(const id of ids){
		const w=f.workers.get(read().nodes[id].worker??"");assert.ok(w);
		put(w.cwd,`entries/${id}/value`,"draft\n");if(id==="alpha"){put(w.cwd,sibling,"old note\n");put(w.cwd,unchanged,"not in the delta\n");}
		await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	await f.settle();
	const at=read(),checkpoint=at.products.at(-1);assert.ok(checkpoint);f.owner.close();
	put(f.root,check,`import {readFileSync} from "node:fs";process.exit(readFileSync("${first}","utf8")==="draft\\n"${mixed?' || process.env.FOUNDRY_GRAIN==="beta"':""}?1:0)`);
	git(f.root,"add",check);git(f.root,"commit","-qm","Check the adopted records");
	const target=git(f.root,"rev-parse","HEAD"),reviewer=scriptedInspections(f.root);
	const owner=f.runtime(f.root,{...reviewer,confirm:async()=>true,formIdle:async()=>false,confirmProposal:async()=>true,
		inspectionState:async w=>{const e=await reviewer.inspectionState(w);return {...e,result:{...e.result,outcome:"changes",
			summary:`${first}:1: remove the leading space. ${unchanged}:1 is not part of this diff.`}};}});
	await owner.operation("repin",{run,kind:"target",from:f.tip,revision:target,checkpoint:checkpoint.check,goal:at.goal?.check,
		files:[check],acceptance:"Check both records at the adopted target."},"owner");
	const join=read().join;assert.ok(join);
	/** @param {string} from @param {string} delta */
	async function offer(from,delta){
		const candidate=stagePatch(f.root,from,target,delta);
		put(f.root,"records.diff",git(f.root,"diff","--full-index",from,candidate)+"\n");
		const r=await owner.operation("publish",{run,file:"records.diff",to:["entries"]},"owner");
		return {blob:r.artifacts.at(-1)?.blob,assembly:from};
	}
	await owner.operation("rollout",{run,check:join.check,...await offer(join.commit,edit(first,"draft"," ready")+edit(second,"draft","ready")+edit(sibling,"old note","new note")+edit(flag,"old","new"))},"owner");
	await owner.flush();const clock=recoveryClock();
	if(mixed){
		// Record a genuine independent producer review on the already signed two-member batch.
		const [head,tail]=read().effects.filter(e=>memberApproval(e));
		assert.ok(head?.kind==="component" && tail?.kind==="component");db.verifySigned(run,head);db.verifySigned(run,tail);
		assert.deepEqual([head.receipt?.exit,tail.receipt?.exit],[0,1]);
		db.mutateLocked(run,r=>{const b=reviewBinding(r,head);assert.ok(b);inspectComponent(r,b.node,head,r.owner,b.overrides);});
		owner.turn("owner");await owner.flush();
		const stopped=read();assert.equal(stopped.inspections?.find(i=>i.component===head.id)?.state,"changes");
		assert.equal(stopped.correctionDrafts?.length??0,0,"neither detector may choose for the operator");
		await owner.operation("draft",{run,check:tail.id,files:[second]},"owner");
		const d=read().correctionDrafts?.at(-1);assert.ok(d && !d.finding && !d.automatic && draftAllowed(d));
		assert.equal(d.check,tail.id);assert.equal(d.parts[0].source.grain,"beta");assert.equal(d.parts[0].files[0].file,second);
		return;
	}
	const issuer=f.runtime(f.root,{watchRecovery:clock.watch,confirmProposal:async()=>assert.fail("Not idle"),formIdle:async()=>false,
		draftAgent:async()=>assert.fail("No scope approval")});
	issuer.sessionStart("owner",f.root);await clock.pulse(issuer,3);issuer.close();
	const state=read(),d=state.correctionDrafts?.find(d=>d.finding);assert.ok(d?.finding && !d.decision);
	const batch=state.effects.filter(e=>memberApproval(e));
	assert.deepEqual(batch.map(c=>c.grain),ids);for(const c of batch){assert.ok(c.kind==="component");db.verifySigned(run,c);}
	assert.equal(d.check,batch[0].id);assert.equal(d.finding.frontier,batch[1].id);
	assert.equal(draftAllowed(d),false);assert.equal(pendingScope(state)?.id,d.id);
	const review=state.inspections?.find(i=>i.id===d.finding?.inspection);assert.ok(review?.state==="changes" && review.workflow);
	assert.deepEqual(d.parts.flatMap(p=>p.files.map(f=>f.file)),[first]);

	/** @param {(draft:import("./model.js").CorrectionDraft,r:import("./model.js").Run)=>void} change */
	function changed(change){
		const r=structuredClone(state),copy=r.correctionDrafts?.find(v=>v.id===d?.id);assert.ok(copy);
		change(copy,r);copy.id=draftId(copy);return r;
	}
	const earlier=changed(v=>{assert.ok(v.finding);v.finding.frontier=batch[0].id;});
	const old=earlier.correctionDrafts?.find(v=>v.finding);assert.ok(old);
	await t.test("a saved scope waits for remaining budget and outstanding inspections",()=>{
		const r=structuredClone(state),copy=r.correctionDrafts?.find(v=>v.id===d.id);assert.ok(copy);
		const budget=r.policy.assignments;r.policy.assignments=0;assert.equal(pendingScope(r),undefined);
		r.policy.assignments=budget;
		const tail=r.effects.find(e=>e.id===batch[1].id);assert.ok(tail?.kind==="component");
		const b=reviewBinding(r,tail);assert.ok(b && inspectComponent(r,b.node,tail,r.owner,b.overrides)?.state==="ready");
		assert.equal(pendingScope(r),undefined);
		copy.decision={status:"answered",answer:copy.id};
		assert.equal(nextAuthor(r),undefined,"an existing scope waits; a pending inspection must not permanently hold its author");
	});
	await t.test("an earlier signed prefix stays readable after the next member passes",()=>{
		// The draft has no serialized issuance order relative to the second runner. A
		// shorter cut is indistinguishable from a genuine old record, not today's cut.
		assert.doesNotThrow(()=>decode(earlier));
		assert.ok(!draftAllowed(old));
		const reopened=prepareDraft(f.root,earlier,"owner",{run,check:old.check,files:[first]},c=>db.verifySigned(run,c));
		assert.equal(reopened.scope?.id,old.id,"manual reopening addresses the original decision, not a second form on identical files");
	});
	await t.test("the frozen prefix cannot mix, reorder or relabel genuine observations",()=>{
		assert.throws(()=>decode(changed(v=>{assert.ok(v.finding);v.finding.frontier=join.check;})),{code:"corrupt_run"},"the signed join is not a member of this rollout");
		assert.throws(()=>decode(changed((v,r)=>{assert.ok(v.finding);v.finding.frontier=batch[0].id;
			const [a,b]=batch.map(c=>r.effects.findIndex(e=>e.id===c.id));[r.effects[a],r.effects[b]]=[r.effects[b],r.effects[a]];
		})),{code:"corrupt_run"},"the approved order is part of the prefix");
		assert.throws(()=>decode(changed(v=>{assert.ok(v.finding);v.decision={status:"answered",answer:v.id};v.finding.frontier=batch[0].id;})),
			{code:"corrupt_run"},"consent to one prefix cannot be relabelled");
		assert.throws(()=>decode(changed(v=>{v.check=batch[1].id;})),{code:"corrupt_run"},"the frontier did not receive this review");
		assert.throws(()=>decode(changed((v,r)=>{const i=r.inspections?.find(i=>i.id===review.id);assert.ok(i && v.finding);
			i.task=r.policy.direction;v.finding.stamp=digest(i);})),{code:"corrupt_run"},"rehashing another task does not make it the reviewed assignment");
	});
	await t.test("a path needs both a citation and evidence in the reviewed delta",()=>{
		for(const file of [sibling,unchanged])assert.throws(()=>decode(changed(v=>{v.parts[0].files=[
			{file,before:git(f.root,"rev-parse",`${d.assembly}:${file}`),mode:"100644"}];})),{code:"corrupt_run"},file);
		assert.throws(()=>decode(changed(v=>{v.parts[0].files[0].before=git(f.root,"rev-parse",`${join.commit}:${first}`);})),{code:"corrupt_run"},"original output is not the reviewed preimage");
	});
	await t.test("no scope presentation can be inferred from a claim or a previous refusal",()=>{
		assert.throws(()=>decode(changed(v=>{v.parts[0].state="issued";v.parts[0].dispatch="unapproved";})),{code:"corrupt_run"});
		assert.throws(()=>decode(changed(v=>{v.parts[0].changes=[];})),{code:"corrupt_run"});
		assert.throws(()=>decode(changed(v=>{v.previous=[{status:"dismissed"}];})),{code:"corrupt_run"});
		assert.throws(()=>decode(changed(v=>{v.decision={status:"presenting"};})),{code:"corrupt_run"},"a form must name its presentation");
	});
	await t.test("a foreign frontier row or missing member receipt withholds the saved question",()=>{
		const mail=new DatabaseSync(db.file+".outcomes");try{
			const readRow=mail.prepare("SELECT signature,document FROM outcomes WHERE run=? AND effect=?"),save=mail.prepare("INSERT OR REPLACE INTO outcomes VALUES(?,?,?,?)");
			const foreign=readRow.get(run,join.check);assert.ok(foreign);
			for(const c of batch){
				const prior=readRow.get(run,c.id);assert.ok(prior);
				if(c.id===d.check)mail.prepare("DELETE FROM outcomes WHERE run=? AND effect=?").run(run,c.id);
				else save.run(run,c.id,foreign.signature,foreign.document);
				try{const held=read();assert.ok(integrityHolds(held).some(h=>h.effect===c.id));
					assert.deepEqual(held.correctionDrafts,state.correctionDrafts);assert.ok(!pendingScope(held));
					assert.equal(validDraftScope(held,d),false,"a missing signer anywhere in the requested prefix prevents its use");
					assert.equal(validDraftScope(held,old),c.id!==old.finding?.frontier,"only the named prefix attests the historical draft");}
				finally{save.run(run,c.id,prior.signature,prior.document);}
			}
		}finally{mail.close();}
	});
	await t.test("a later permission hold withholds the question without rewriting the original review",async()=>{
		const before=process.env.FOUNDRY_FINDING_LINEAGE_BEFORE;
		const held=f.runtime(f.root,{watchRecovery:clock.watch,formIdle:async()=>false,confirmProposal:async()=>assert.fail("Not idle"),
			permissionBlocker:async()=>({scope:"session",message:"Manual approvals."})},before?(await import(`${before}/work/runtime.mjs`)).createRuntime:undefined);
		held.sessionStart("owner",f.root);held.turn("owner");await clock.pulse(held,2);
		if(before)assert.throws(()=>held.inspect({run},"owner"),{code:"corrupt_run"});held.close();
		const saved=read();assert.ok(saved.inspections?.find(i=>i.id===review.id)?.permissionHold);
		assert.deepEqual(saved.correctionDrafts,state.correctionDrafts);assert.ok(!pendingScope(saved));
		const resumed=f.runtime(f.root,{watchRecovery:clock.watch,formIdle:async()=>false,confirmProposal:async()=>assert.fail("Not idle")});
		resumed.sessionStart("owner",f.root);resumed.turn("owner");await clock.pulse(resumed,3);resumed.close();
		assert.deepEqual(read().inspections?.find(i=>i.id===review.id),review);assert.equal(pendingScope(read())?.id,d.id);
	});
	await t.test("new bytes require the actual execution boundary, not the readable older prefix",async()=>{
		const change=await offer(d.assembly,edit(first," ready","ready")),blob=change.blob,frontier=old.finding?.frontier;assert.ok(blob && frontier);
		assert.throws(()=>rolloutPlan(f.root,read(),"owner",d.assembly,frontier,blob,c=>db.verifySigned(run,c)),
			{code:"stale_pin"},"a genuine older observation cannot withdraw or replace work after it");
		await owner.operation("rollout",{run,check:batch[1].id,...change},"owner");await owner.flush();
		const later=read();assert.equal(later.join?.check,join.check);
		/** @param {typeof import("./runtime.mjs").createRuntime} [edition] */
		async function polls(edition){
			let count=0;const r=f.runtime(f.root,{watchRecovery:clock.watch,formIdle:async()=>{count++;return false;},
				confirmProposal:async()=>assert.fail("Not idle")},edition);
			r.sessionStart("owner",f.root);await clock.pulse(r,5);r.close();return count;
		}
		const before=process.env.FOUNDRY_FINDING_LINEAGE_BEFORE;
		if(before)assert.ok(await polls((await import(`${before}/work/runtime.mjs`)).createRuntime)>0);
		assert.equal(await polls(),0);assert.deepEqual(read().correctionDrafts,state.correctionDrafts);assert.ok(!pendingScope(later));
	});
});

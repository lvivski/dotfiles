import assert from "node:assert/strict";
import { pairedWork } from "../test/install.mjs";
import { guideReplay, launchDescription, launchPlan, observed, recipient } from "../test/portable.mjs";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { artifactDigest, stagePatch } from "./product.mjs";
import { factory, git, put, recoveryClock, scriptedInspections } from "../test/fixture.mjs";
import { activation, failedFinalDiagnostic, submittedGrant } from "../test/ownership.mjs";
import { directory, historicalFactory, historicalRuntime } from "../test/legacy-readers.mjs";
import { rolloutPlan } from "./rollout.mjs";
import { currentCheck } from "./reservation.mjs";
import { claimOutcome } from "./outcomes.mjs";

const source=".foundry/catalog.json",spec="brief",component="unit.mjs",goal="goal.mjs",product="product.mjs";
const fixture=process.env.FOUNDRY_ROLLOUT_FIXTURE,fixtureVersion=fixture && readFileSync(join(fixture,"work/reader.version"),"utf8").trim();
const root="unit/picker",file=`${root}/result`,helper="unit/shared/format",retainedFile="unit/controls/entry";
/** @param {string} p @param {string} from @param {string} to */
const edit=(p,from,to)=>`--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-${from}\n\\ No newline at end of file\n+${to}\n\\ No newline at end of file\n`;
const needs=`import {readFileSync as read} from "node:fs";const value=file=>read(file,"utf8");`;
const background=`if(process.env.CATALOG_ALLOW_FOREGROUND)throw Error("Foreground leaked to background evaluator");`;
/** @param {import("node:test").TestContext} t @param {boolean} consumer @param {boolean} deferOwner @param {typeof factory} [make] @param {typeof createRuntime} [upgrade] @param {boolean} [tail] */
async function ordinary(t,consumer,deferOwner,make=factory,upgrade,tail=false){
	const run="catalog",f=make(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Publish the catalog.",
		squads:[{id:"entries",areas:["unit"],charter:spec,checks:[component]}],productCheck:product,goalCheck:goal}),
		".foundry/catalog/journey.md":"Show both catalog entries.",[spec]:"Keep the requested entries.",[component]:"",[product]:background,
		[goal]:`import {existsSync} from "node:fs"; process.exit(existsSync("${file}")||existsSync("${retainedFile}")?2:1);`,[helper]:"old"});
	await f.start();
	const issuer=upgrade?f.runtime(f.root,{},upgrade):f.owner;
	await issuer.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const controls={id:"controls",directory:"unit/controls",task:"Provide the controls.",check:component,needs:consumer?["selector"]:[]};
	const selector={id:"selector",directory:root,task:"Provide the selected entry.",check:component,needs:[]};
	await f.scouts[0].report({outcome:"regenerate",reason:"The catalog is missing two entries.",evidence:[spec],
		grains:upgrade?[controls,selector]:[selector,controls,...(tail?[{id:"nested",directory:"unit/nested",task:"Verify the entry.",check:component,needs:["selector"]}]:[])]});
	const entries=[["selector",file,"keep"],["controls",retainedFile,"connected"]];
	if(tail)entries.push(["nested","unit/nested/result","verified"]);
	for(const [id,p,bytes] of upgrade?entries.reverse():entries){
		if(deferOwner && id==="selector")continue;
		const w=f.workers.get((await f.status()).nodes.find(n=>n.grain===id)?.worker??"");assert.ok(w);
		put(w.cwd,p,bytes);await f.runtime(w.cwd,{},id==="selector"?upgrade:undefined).operation("submit",{run,token:w.token},w.id);
	}
	return {f,run};
}

/** Repartition an actual historical mixed grant, not a mock node with its review pointer erased.
 * @param {import("node:test").TestContext} t @param {typeof createRuntime} old */
async function restored(t,old){
	const {f,run,proof,before}=await submittedGrant(t,"owned adoption");
	const issuer=f.runtime(f.root,{confirm:async()=>true},old);
	await issuer.operation("restore",{run,from:"picker",historical:before.products?.at(-1)?.check,retainer:"controls",to:"selector",
		checkpoint:proof.products?.at(-1)?.check,goal:proof.goalChecks?.at(-1)?.id},"owner");
	const w=[...f.workers.values()].at(-1);assert.ok(w);
	const writer=f.runtime(w.cwd,{},old);
	put(w.cwd,file,"not authorized");
	await assert.rejects(writer.operation("submit",{run,token:w.token},w.id),{code:"changed_restoration"});
	put(w.cwd,file,"keep");await writer.operation("submit",{run,token:w.token},w.id);
	issuer.close();writer.close();return {f,run};
}

/** The two original component receipts on this assembly share a commit, not a grant. The
 * production writer's exact files exclude the restored output's new correction.
 * @param {import("node:test").TestContext} t @param {typeof createRuntime} old */
async function paired(t,old){
	const {f,run,ledger,component:c,producer,implementation,regression}=await failedFinalDiagnostic(t,"production adoption");
	const basis=ledger.nodes[producer].restoration;assert.ok(basis && c.commit);
	const owner=f.runtime(f.root,{confirm:async()=>true},old);
	await owner.operation("remediate",{run,diagnostic:c.id,candidate:c.commit,checkpoint:basis.checkpoint,goal:basis.goal,producer,
		files:[implementation,regression],task:"Restore reactivation and retain the observer assertions."},"owner");
	const w=[...f.workers.values()].at(-1);assert.ok(w);
	put(w.cwd,implementation,activation('state==="idle" || state==="dismissed"'));
	put(w.cwd,regression,'import assert from "node:assert/strict";import {transition} from "./activation.mjs";assert.equal(transition("dismissed","activate"),"open");');
	const writer=f.runtime(w.cwd,{},old);
	await writer.operation("submit",{run,token:w.token},w.id);owner.turn("owner");await owner.flush();
	const p=owner.inspect({run,detail:"proof"},"owner");
	assert.ok(p.outputs?.selector && p.outputs.selector===p.outputs.buttons && p.goal?.receipt?.exit===2);
	writer.close();owner.close();return {f,run};
}

/** @param {import("node:test").TestContext} t @param {{reader94?:boolean,before?:number,legacy?:boolean,consumer?:boolean,production?:boolean,prepared?:boolean,deferOwner?:boolean,rollout?:boolean,preJournal?:boolean,failedWitness?:boolean,tail?:boolean,probe?:boolean}} [options] */
async function failedAssembly(t,{reader94=false,before:edition,legacy=false,consumer=false,production=false,prepared=false,deferOwner=false,rollout=false,preJournal=false,failedWitness=false,tail=false,probe=false}={}){
	const sourceReader=process.env.FOUNDRY_OWNED_FIXTURE;
	const reader=rollout && fixture;
	const frozen=reader94?94:!reader && edition;
	/** @type {typeof createRuntime} */ const old=frozen?await historicalRuntime(t,frozen):reader?(await import(`${reader}/work/runtime.mjs`)).createRuntime:legacy?(sourceReader?(await import(sourceReader)).createRuntime:await historicalRuntime(t,81)):createRuntime;
	const {f,run}=production?await paired(t,old):legacy?await restored(t,old):await ordinary(t,consumer,deferOwner,
		frozen?await historicalFactory(t,frozen):preJournal?await historicalFactory(t,22):reader?(await import(`${reader}/test/fixture.mjs`)).factory:factory,
		preJournal?await historicalRuntime(t,95):undefined,tail);
	const db=openDatabase(f.root);t.after(()=>db.close());
	const read=()=>db.read(run)??assert.fail("missing original run");
	const initial=read(),p=initial.products.at(-1),at=initial.goal;assert.ok(p && at);
	const ownedFile=production?`${root}/observer`:file,previousText=production?"after-event":"keep",correctedText=`${previousText}:local`;
	assert.equal(initial.nodes.selector.state,deferOwner?"writing":"qualified");
	if(legacy)assert.ok(!initial.nodes.selector.review && initial.effects.some(e=>e.kind==="writer" && e.grain==="selector" && e.restoration));
	const files=[component,goal];
	if(rollout){
		put(f.root,".foundry/accept.mjs",`export const accepts=()=>false;\n`);files.push(".foundry/accept.mjs");
	}
	if(prepared){
		const hook=".foundry/prepare-components";
		put(f.root,hook,`#!/bin/sh\nset -eu\ntest -z "\${FOUNDRY_GRAIN-}\${FOUNDRY_OUTPUTS-}\${FOUNDRY_FILES-}"\ncp ${file} "$1/catalog-entry"\n`);
		chmodSync(join(f.root,hook),0o755);files.push(hook);
	}
	put(f.root,component,needs+(rollout?`
		if(value("${file}")==="keep:local"){
			if(value(process.env.FOUNDRY_PREPARED_DIR+"/entry")!=="keep:local")throw Error("Missing prepared output");
			${probe?`{
				const {appendFileSync,writeFileSync}=await import("node:fs"),dir=process.env.FOUNDRY_PREPARED_DIR;
				if(value(dir+"/recipe")!==process.env.CATALOG_RECIPE)throw Error("Wrong prepared recipe");
				appendFileSync(process.env.CATALOG_PROBE,JSON.stringify([process.env.FOUNDRY_GRAIN,process.ppid,process.cwd(),dir])+"\\n");
				writeFileSync(dir+"/entry","private mutation");
			}`:""}
			if(value("${helper}")==="foreground required"){console.log("Foreground not observed");process.exit(2);}
			${tail?`const id=process.env.FOUNDRY_GRAIN;
			if(id==="nested"){${background}}else{
				const {spawnSync}=await import("node:child_process");
				const result=spawnSync("sh",[id==="selector"?"${root}/check.sh":"unit/controls/check.sh"],{stdio:"inherit"});
				if(result.status!==0)process.exit(result.status??3);
			}`:""}
			if(value("${helper}").startsWith("declared lane")){
				const id=process.env.FOUNDRY_GRAIN;
				if(id==="selector" || id==="controls" && value("${helper}")==="declared lane pair"){
					const {spawnSync}=await import("node:child_process");
					const result=spawnSync("sh",[id==="selector"?"${root}/declared.sh":"unit/controls/declared.sh"],{stdio:"inherit"});
					if(result.status!==0)process.exit(result.status??3);
				}else{${background}}
			}
		}
		if(process.env.FOUNDRY_GRAIN==="controls" && (${failedWitness?`value("${helper}")==="current"`:`value("${file}")==="keep:first"`}))process.exit(1);`:"")+(prepared?`if(value(process.env.FOUNDRY_PREPARED_DIR+"/catalog-entry")!==value("${file}"))throw Error("Wrong prepared catalog");`:"")+`
		if(process.env.FOUNDRY_GRAIN==="core" && value("${helper}")!=="current")process.exit(1);
		${deferOwner?`if(process.env.FOUNDRY_GRAIN==="controls" && value("${file}")==="keep:local" && value("${helper}")!=="current")process.exit(1);`:""}
		if(process.env.FOUNDRY_GRAIN==="selector" && value("${ownedFile}")!==${JSON.stringify(correctedText)} ${rollout?`&& value("${file}")!=="keep:first"`:""}){console.log("Missing entry category");process.exit(1);}`);
	put(f.root,goal,needs+background+(rollout?`import {accepts} from "./.foundry/accept.mjs";if(!accepts())process.exit(2);`:"")+`if(value("${ownedFile}")!==${JSON.stringify(correctedText)} || value("operator")!=="retain")process.exit(1);`);
	put(f.root,"operator","retain");git(f.root,"add",".");git(f.root,"commit","-qm","Review the new catalog contract");
	const revision=git(f.root,"rev-parse","HEAD"),issuer=f.runtime(f.root,{confirm:async()=>true},old);
	if(deferOwner){
		const w=f.workers.get(initial.nodes.selector.worker??"");assert.ok(w);
		put(w.cwd,file,"keep");await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
		assert.equal(read().nodes.selector.state,"published");assert.equal(read().products.at(-1)?.check,p.check);
	}
	await issuer.operation("repin",{run,kind:"target",from:f.tip,revision,checkpoint:p.check,goal:at.check,files,
		acceptance:"Require the catalog category and retain the operator's contribution."},"owner");
	const offer=async(/** @type {string} */ bytes,/** @type {string[]} */ to)=>{
		put(f.root,"fix.patch",bytes);
		const result=await issuer.operation("publish",{run,file:"fix.patch",to},"owner");return result.artifacts.at(-1)?.blob??assert.fail();
	};
	if(legacy){
		const first=read().join;assert.ok(first);assert.equal(read().effects.find(c=>c.id===first.check)?.receipt?.components?.core.exit,1);
		// The first correction is inherited and leaves every output pin unchanged.
		const blob=await offer(edit(helper,"old","current"),["unit/shared"]);
		await issuer.flush();
		if(read().join?.check===first.check)await issuer.operation("inherit",{run,check:first.check,blob},"owner");
	}
	if(rollout){
		for(const [from,to] of [["old","intermediate"],["intermediate","current"]]){
			const j=read().join;assert.ok(j);
			const blob=await offer(edit(helper,from,to),["unit/shared"]);
			await issuer.flush();
			if(read().join?.check===j.check)await issuer.operation("inherit",{run,check:j.check,blob},"owner");
		}
		assert.equal(read().productRepins?.at(-1)?.amendments?.length,2);
	}
	const before=read(),prior=before.join,failed=before.effects.find(c=>c.id===prior?.check);
	assert.ok(prior && failed?.kind==="product" && failed.receipt?.exit===null && failed.receipt.components?.[failedWitness?"controls":"selector"]?.exit===1);
	assert.equal(before.goal?.check,at.check);assert.equal(before.products.at(-1)?.check,p.check);issuer.close();
	const publisher=f.runtime(f.root,{},old);
	async function publish(/** @type {string} */ bytes,to=[root]){
		put(f.root,"correction.diff",bytes);await publisher.operation("publish",{run,file:"correction.diff",to},"owner");
		return read().artifacts?.at(-1)?.blob??assert.fail();
	}
	return {f,run,db,read,publish,prior,failed,p,revision,old,publisher,ownedFile,previousText,correctedText};
}

for(const intrude of [false,true])test(`writer-drafted multi-owner correction / ${intrude?"attempted crossing":"disjoint sources"}`,async t=>{
	const {f,run,prior,failed,read,old,publisher,revision}=await failedAssembly(t,{reader94:true,consumer:true});
	f.owner.close();publisher.close();const fresh=`${root}/notes.txt`,before=read();let authors=0,forms=0;
	/** @type {ReturnType<typeof createRuntime>} */ const issuer=f.runtime(f.root,{...scriptedInspections(f.root),formIdle:async()=>true,
		confirmProposal:async msg=>{forms++;assert.ok(msg.includes(fresh));return true;},
		draftAgent:async ticket=>{
			const id=`isolated-${++authors}`,p=await issuer.draftPacket(ticket,"owner",id),selector=p.source.grain==="selector";
			assert.deepEqual(p.files.map(f=>f.file).sort(),selector?[file,fresh].sort():[retainedFile]);
			assert.equal(p.source.output,prior.outputs[selector?"selector":"controls"]);
			return {runId:id,status:"completed",workflowName:"foundry-draft",result:{subject:ticket.subject,reason:"Preserve both sides of the change.",
				edits:p.files.map(f=>({file:intrude?(selector?retainedFile:file):f.file,before:f.before,text:f.file===file?"keep:local":f.file===fresh?"notes":"still connected"}))}};
		}},process.env.FOUNDRY_DRAFT_RED?old:createRuntime);
	await issuer.operation("draft",{run,check:failed.id,files:[file,retainedFile,fresh]},"owner");await issuer.flush();
	const end=read(),proof=issuer.inspect({run,detail:"proof"},"owner").qualification;
	if(intrude){assert.equal(proof,null);assert.equal(forms,1);assert.equal(authors,1);assert.deepEqual(end.effects,before.effects);return;}
	assert.ok(proof,JSON.stringify(issuer.inspect({run},"owner").correctionDrafts));assert.equal(authors,2);assert.equal(forms,2);
	assert.deepEqual(end.products.at(-1)?.outputs,{selector:proof.commit,controls:proof.commit});assert.equal(end.nodes.controls.inputs?.selector,proof.commit);
	assert.equal(git(f.root,"show",`${proof.commit}:${fresh}`),"notes");assert.equal(proof.receipts.product.evaluatorRevision,revision);
	assert.deepEqual(end.repins,before.repins,"an implementation-only batch cannot repin any evaluator");
	assert.deepEqual(end.inspections?.filter(i=>i.candidate===proof.commit).map(i=>[i.grain,i.state]).sort(),[["controls","approved"],["selector","approved"]]);
});

for(const outcome of ["pass","withheld","decline","stale","component withheld","foreground retry","foreground pair","foreground fails","review changes","runner refused","previous owned output","pre-journal output","pre-journal without passing witness"])test(`exact harness rollout from a second failed amendment / ${outcome}`,async t=>{
	const foreground=outcome.startsWith("foreground"),pair=outcome==="foreground pair",declaration=`${root}/declared.sh`;
	const previous=outcome==="previous owned output",preJournal=outcome.startsWith("pre-journal"),failedWitness=outcome==="pre-journal without passing witness";
	const {f,run,db,read,publish,revision,old,publisher}=await failedAssembly(t,{consumer:!previous && !preJournal,rollout:true,preJournal,failedWitness,before:foreground && outcome!=="foreground retry"?89:undefined});
	if(previous){
		const stopped=read(),check=stopped.join?.check,blob=await publish(edit(file,"keep","keep:first"));
		const owner=f.runtime(f.root,{confirmProposal:async()=>true},old);
		await owner.operation("owned",{run,check,blob},"owner");await owner.flush();owner.close();
		assert.ok(read().nodes.selector.candidate===read().join?.commit && read().nodes.selector.state==="published" && !read().nodes.selector.worker);
	}
	const prior=read().join,failed=read().effects.find(c=>c.id===prior?.check);assert.ok(prior && failed?.kind==="product");
	const hook=".foundry/prepare-components",program=`#!/bin/sh\nset -eu\ntest -z "\${CATALOG_ALLOW_FOREGROUND-}" && cp ${file} "$1/entry"\n`;
	const patch=edit(file,previous?"keep:first":"keep","keep:local")+edit(retainedFile,"connected","retained")+edit(helper,"current",pair?"declared lane pair":foreground?"declared lane":outcome==="component withheld"?"foreground required":"new harness input")+
		(foreground?(pair?[declaration,"unit/controls/declared.sh"]:[declaration]).map(p=>`diff --git a/${p} b/${p}\nnew file mode 100755\n--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,2 @@\n+#!/bin/sh\n+./${root}/lane --require-foreground\n`).join("")+
			`diff --git a/${root}/lane b/${root}/lane\nnew file mode 100755\n--- /dev/null\n+++ b/${root}/lane\n@@ -0,0 +1,3 @@\n+#!/bin/sh\n+test "$1" = --require-foreground && test "\${CATALOG_ALLOW_FOREGROUND-}" = 1 && exit ${outcome==="foreground fails"?1:0}\n+echo 'Set CATALOG_ALLOW_FOREGROUND=1 only on an authorized desktop.' >&2; exit 2\n`:"")+
		`diff --git a/.foundry/accept.mjs b/.foundry/accept.mjs\n--- a/.foundry/accept.mjs\n+++ b/.foundry/accept.mjs\n@@ -1 +1 @@\n-export const accepts=()=>false;\n+export const accepts=()=>${outcome==="withheld"?"false":"true"};\n`+
		`diff --git a/${hook} b/${hook}\nnew file mode 100755\n--- /dev/null\n+++ b/${hook}\n@@ -0,0 +1,3 @@\n${program.trimEnd().split("\n").map(l=>"+"+l).join("\n")}\n`;
	const candidate=stagePatch(f.root,prior.commit,revision,patch);
	const full=git(f.root,"diff","--full-index",prior.commit,candidate)+"\n";
	const bad=await publish(full.replace(/^index ([a-f0-9]+)\.\./m,(_,oid)=>`index ${"a".repeat(oid.length)}..`),["unit"]);
	const blob=await publish(full,["unit"]),args={run,assembly:prior.commit,check:failed.id,blob};
	assert.notEqual(bad,blob);
	const stopped=read(),count=f.checks.length;
	if(preJournal){
		const component=stopped.effects.find(e=>e.id===stopped.nodes.controls.check),p=stopped.products.at(-1),entry=failed.receipt?.components?.controls;
		assert.ok(component?.kind==="component" && component.runnerStarted && !component.runnerClaim && component.receipt?.exit===0);
		assert.ok(p && entry?.exit===(failedWitness?1:0) && entry.check===component.check && p.outputs.controls===prior.outputs.controls);
		assert.throws(()=>db.verifySigned(run,component),{code:"missing_receipt"});
		if(fixtureVersion==="83")await assert.rejects(publisher.operation("rollout",args,"owner"),/Missing exact included output evidence for controls/);
		if(failedWitness){
			const owner=f.runtime(f.root,{confirmProposal:async()=>assert.fail("no native decision without corroboration")},createRuntime);
			db.verifySigned(run,failed);
			await assert.rejects(owner.operation("rollout",args,"owner"),/pre-journal output controls/);
			assert.deepEqual(read(),stopped);assert.equal(f.checks.length,count);return;
		}
		const wrong=structuredClone(stopped),checkpoint=wrong.products.at(-1);assert.ok(checkpoint);checkpoint.outputs.controls=prior.commit;
		assert.throws(()=>rolloutPlan(f.root,wrong,"owner",prior.commit,failed.id,blob,e=>db.verifySigned(run,e)),/pre-journal output controls/);
		const corrupt=structuredClone(stopped),receipt=corrupt.effects.find(e=>e.id===failed.id)?.receipt;assert.ok(receipt?.components);
		delete receipt.components.controls;
		assert.throws(()=>rolloutPlan(f.root,corrupt,"owner",prior.commit,failed.id,blob,e=>db.verifySigned(run,e)),{code:"conflicting_outcome"});
		assert.deepEqual(read(),stopped);
	}
	await assert.rejects(publisher.operation("owned",{run,check:failed.id,blob},"owner"));
	if(fixtureVersion==="82")await assert.rejects(publisher.operation("rollout",args,"owner"),{code:"unknown_operation"});
	publisher.close();let forms=0;
	const inspector=scriptedInspections(f.root);
	const initialRuntime=foreground && outcome!=="foreground retry"?await historicalRuntime(t,89):createRuntime;
	const owner=f.runtime(f.root,{...inspector,inspectionState:async id=>{
		const reply=await inspector.inspectionState(id);
		return outcome==="review changes"?{...reply,result:{...reply.result,outcome:"changes",summary:"Assertion removed"}}:reply;
	},execute:async(tool,args,key)=>outcome==="runner refused" && tool==="bash"?{resultType:"denied"}:
		pair && tool==="bash" && read().effects.some(e=>e.tool==="bash" && e.lane && args.shellId===e.args.shellId)?{resultType:"unconfirmed"}:f.execute(tool,args,key),
		autoConfirm:async()=>true,confirmProposal:async msg=>{
		forms++;assert.ok([prior.commit,revision,failed.id,blob,hook,retainedFile,"100755","selector","controls"].every(s=>msg.includes(s)),msg);
		assert.deepEqual(read().effects,stopped.effects);
		if(outcome==="stale"){put(f.root,"operator","changed");git(f.root,"commit","-qam","Target moved during form");}
		return outcome!=="decline";
	}},initialRuntime);
	for(const wrong of [{assembly:revision},{check:stopped.goal?.check},{blob:revision}])await assert.rejects(owner.operation("rollout",{...args,...wrong},"owner"));
	await assert.rejects(owner.operation("rollout",args,"participant"),{code:"foreign_run"});
	await assert.rejects(owner.operation("rollout",{...args,blob:bad},"owner"),{code:"invalid_patch"});
	assert.equal(forms,0);
	if(outcome==="decline" || outcome==="stale"){
		await assert.rejects(owner.operation("rollout",args,"owner"),{code:outcome==="decline"?"approval_declined":"stale_pin"});
		assert.equal(forms,1);assert.deepEqual(read().nodes,stopped.nodes);assert.deepEqual(read().join,prior);assert.deepEqual(read().effects,stopped.effects);
		return;
	}
	await owner.operation("rollout",args,"owner");await owner.flush();
	let current=owner;
	if(foreground){
		const held=read(),c=held.effects.find(e=>e.kind==="component" && e.rollout && e.receipt?.exit===2);assert.ok(c?.kind==="component" && c.commit);
		db.verifySigned(run,c);
		const request={run,assembly:c.commit,check:c.id,declarations:[{grain:"selector",file:declaration,line:2}]};
		if(pair)request.declarations.push({grain:"controls",file:"unit/controls/declared.sh",line:2});
		if(initialRuntime!==createRuntime){
			await owner.operation("foreground",request,"owner");await owner.flush();
			const saved=read(),lane=saved.adoptions?.find(a=>a.foreground)?.foreground;assert.ok(lane);
			const retry=saved.effects.find(e=>e.id===lane.retry);assert.ok(retry?.kind==="component");
			if(pair){
				assert.ok(retry.callId && !retry.runnerClaim && !retry.receipt);
				assert.equal(currentCheck(saved,retry),false);
				assert.throws(()=>claimOutcome(run,{...retry,state:"issued"}),{code:"unissued_check"});
			}else{
				assert.equal(retry.receipt?.exit,1);db.verifySigned(run,retry);
				assert.throws(()=>db.verifySigned(run,{...retry,lane:undefined}),{code:"wrong_outcome"});
			}
		}
		const saved=read();owner.close();current=f.runtime(f.root,{...inspector,execute:async()=>assert.fail("no replay or escalation")},createRuntime);
		await assert.rejects(current.operation("foreground",request,"owner"),{code:"unknown_operation"});
		current.turn("owner");await current.flush();
		const tail=initialRuntime===createRuntime?undefined:saved.effects.find(e=>e.kind==="component" && e.grain==="controls" && e.rollout && e.state==="ready");
		if(initialRuntime!==createRuntime){assert.ok(tail?.tool==="bash" && !tail.callId && !tail.runnerStarted && !tail.receipt);}
		assert.deepEqual(read().effects,saved.effects.map(e=>e===tail?{...e,attempt:{version:1,closure:"never-issued"}}:e),
			"only the unissued tail is positively closed; no new desktop permission, call, key or receipt");
		assert.equal(current.inspect({run,detail:"proof"},"owner").qualification,null);return;
	}
	const end=read(),step=end.productRepins?.at(-1)?.amendments?.at(-1),a=end.adoptions?.find(a=>a.rollout),r=a?.rollout;
	if(["component withheld","review changes","runner refused"].includes(outcome)){
		assert.ok(r);assert.deepEqual(end.join,prior);assert.deepEqual(end.nodes,stopped.nodes);
		assert.deepEqual(end.products,stopped.products);assert.deepEqual(end.repins,stopped.repins);
		assert.ok(!end.effects.slice(stopped.effects.length).some(e=>e.kind==="product"||e.kind==="goal"));
		assert.ok(!owner.inspect({run,detail:"proof"},"owner").qualification);
		const checks=owner.inspect({run},"owner").harnessRollout?.checks??[];
		if(outcome==="component withheld"){
			const held=checks.find(c=>c.exit===2);assert.ok(held && checks.some(c=>c.state==="ready"));
			await assert.rejects(owner.operation("foreground",{run,assembly:a?.assembly,check:held.id,declarations:[]},"owner"),{code:"unknown_operation"});
			assert.deepEqual(read(),end);
		}
		if(outcome==="runner refused")assert.ok(checks.some(c=>c.state==="refused") && checks.every(c=>c.exit===undefined));
		return;
	}
	assert.ok(a && r && a.assembly && step?.harness,JSON.stringify({blocker:current.inspect({run},"owner").blocker,checks:f.checks.slice(count),effects:end.effects.slice(stopped.effects.length).map(c=>[c.state,c.receipt?.exit,c.error,c.receipt?.output]),reviews:end.inspections?.slice(stopped.inspections?.length).map(i=>[i.state,i.summary])}));
	assert.equal(forms,1);assert.deepEqual(step.prior,prior);assert.equal(step.harness,r.harness);assert.equal(git(f.root,"rev-parse","HEAD"),revision);
	assert.deepEqual(end.effects.slice(0,stopped.effects.length),stopped.effects);
	assert.deepEqual(end.products.slice(0,stopped.products.length),stopped.products);
	assert.equal(end.policy.contractTarget,revision);if(!previous && !preJournal)assert.equal(end.nodes.controls.inputs?.selector,a.assembly);
	if(preJournal)assert.equal(r.included.controls.legacy,stopped.nodes.controls.check);
	const fresh=end.effects.slice(stopped.effects.length).filter(c=>c.tool==="bash");
	assert.deepEqual(fresh.map(c=>c.kind).sort(),["component","component","goal","product"]);
	for(const c of fresh){assert.ok(c.tool==="bash");assert.equal(c.commit,a.assembly);db.verifySigned(run,c);}
	const product=fresh.find(c=>c.kind==="product"),goal=fresh.find(c=>c.kind==="goal");
	assert.equal(product?.receipt?.evaluatorRevision,r.harness);assert.equal(goal?.receipt?.productEvaluatorRevision,r.harness);
	assert.equal(goal?.receipt?.evaluatorRevision,r.harness);assert.deepEqual(Object.keys(product?.receipt?.components??{}),Object.keys(prior.outputs));
	assert.equal(goal?.receipt?.exit,outcome==="withheld"?2:0);assert.equal(!!current.inspect({run,detail:"proof"},"owner").qualification,outcome!=="withheld");
	if(outcome==="pass"){
		const proof=current.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);
		const dest=recipient(f.root,proof,"joined-only","release"),description=launchDescription(dest,"release");
		/** @type {import("../../../skills/foundry/scripts/materialize.mjs").Step[]} */ const steps=JSON.parse(description).steps;
		assert.equal(steps.filter(s=>s.kind==="prepare").length,1,"the joined build is prepared once on its own pristine export");
		assert.deepEqual(steps.filter(s=>s.kind==="check").map(s=>s.role),[...Object.keys(prior.outputs).map(id=>"joined:"+id),"product","goal"]);
		const replay=guideReplay(dest,description);assert.equal(replay.status,0,replay.stderr);
		const altered=structuredClone(proof),other=Object.values(altered.receipts.product.components??{})[1];assert.ok(other?.disclosure.preparation);
		other.disclosure.preparation.carrier=altered.receipts.goal.disclosure.subject.carrier;put(dest,"manifest.json",JSON.stringify(altered));
		assert.throws(()=>launchPlan(dest,"release"),/disagree about their shared preparation/);
	}
	const forged=structuredClone(end);delete forged.productRepins?.at(-1)?.amendments?.at(-1)?.harness;
	assert.throws(()=>decode(forged),{code:"corrupt_run"});
});

test("an ineligible owner diff cannot wedge unrelated work or the next valid correction",async t=>{
	const {f,run,read,prior,revision,publisher}=await failedAssembly(t,{consumer:true,rollout:true});
	publisher.close();const preview=join(f.root,"..","offer-preview");git(f.root,"worktree","add","-q","--detach",preview,prior.commit);
	put(preview,component,readFileSync(join(preview,component),"utf8")+"\n// offered change outside the harness\n");
	put(preview,file,"keep:local");put(preview,".foundry/accept.mjs","export const accepts=()=>true;\n");
	const full=git(preview,"diff","--full-index",prior.commit)+"\n";put(f.root,"invalid.diff",full);
	let forms=0;const owner=f.runtime(f.root,{confirmProposal:async()=>{forms++;return false;}},createRuntime);
	const before=read();const posted=await owner.operation("publish",{run,file:"invalid.diff",to:["unit"]},"owner");
	const blob=posted.artifacts.find(r=>r.file==="invalid.diff")?.blob;assert.ok(blob);
	put(f.root,"unrelated.txt","unrelated reference");await owner.operation("publish",{run,file:"unrelated.txt",to:["unit"]},"owner");await owner.flush();
	const s=owner.inspect({run},"owner");assert.ok(s.blocker?.includes(blob) && s.blocker.includes("contract changed"));assert.deepEqual(read().effects,before.effects);assert.equal(forms,0);
	const good=stagePatch(f.root,prior.commit,revision,edit(file,"keep","keep:local")+`--- a/.foundry/accept.mjs\n+++ b/.foundry/accept.mjs\n@@ -1 +1 @@\n-export const accepts=()=>false;\n+export const accepts=()=>true;\n`);
	put(f.root,"valid.diff",git(f.root,"diff","--full-index",prior.commit,good)+"\n");await owner.operation("publish",{run,file:"valid.diff",to:["unit"]},"owner");await owner.flush();
	assert.equal(forms,1);assert.deepEqual(read().join,prior);
});

for(const scenario of ["pending checks","changed recipe","corrupt bytes","forged digest"])test(`standalone rollout preparation / ${scenario}`,async t=>{
	const upgrade=scenario==="pending checks",oldBuild=upgrade && fixtureVersion==="86" && !existsSync(join(String(fixture),"work/cache.mjs"));
	const {f,run,db,read,publish,prior,failed,revision,publisher}=await failedAssembly(t,{consumer:true,rollout:true,tail:true,probe:true,before:upgrade?95:undefined});
	const dir=mkdtempSync(join(tmpdir(),"foundry-cache-test-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
	const install=pairedWork(dir),probe=join(dir,"observations");
	cpSync(upgrade?join(oldBuild?String(fixture):directory(t,95),"work"):new URL("./",import.meta.url),install,{recursive:true});
	const program=["#!/bin/sh","set -eu",`cp ${file} "$1/entry"`,`printf %s "$CATALOG_RECIPE" > "$1/recipe"`,`echo build >> "$CATALOG_PROBE.builds"`];
	const patch=edit(file,"keep","keep:local")+edit(retainedFile,"connected","retained")+
		[root,"unit/controls"].map(p=>`--- /dev/null\n+++ b/${p}/check.sh\n@@ -0,0 +1 @@\n+test "$(cat "$FOUNDRY_PREPARED_DIR/entry")" = 'private mutation'\n`).join("")+
		`diff --git a/.foundry/prepare-components b/.foundry/prepare-components\nnew file mode 100755\n--- /dev/null\n+++ b/.foundry/prepare-components\n@@ -0,0 +1,${program.length} @@\n${program.map(l=>"+"+l).join("\n")}\n`+
		`--- a/.foundry/accept.mjs\n+++ b/.foundry/accept.mjs\n@@ -1 +1 @@\n-export const accepts=()=>false;\n+export const accepts=()=>true;\n`;
	const candidate=stagePatch(f.root,prior.commit,revision,patch);
	const blob=await publish(git(f.root,"diff","--full-index",prior.commit,candidate)+"\n",["unit"]);publisher.close();
	/** @type {string[]} */ const pending=[];
	/** @type {string[]} */ const launched=[];
	/** @type {string[]} */ const logs=[];
	/** @type {import("./model.js").Effect|undefined} */ let beforeUpgrade;
	const open=(/** @type {typeof createRuntime} */ version)=>f.runtime(f.root,{...scriptedInspections(f.root),confirmProposal:async()=>true,execute:async(tool,args,key)=>{
		if(tool!=="bash")return f.execute(tool,args,key);
		const id=String(args.shellId).slice(8),r=read(),standalone=r.effects.some(c=>c.id===id && c.kind==="component" && c.rollout);
		if(standalone){
			if(!pending.length)pending.push(...r.effects.filter(c=>c.kind==="component" && c.rollout).map(c=>c.id));
			launched.push(id);
			if(["corrupt bytes","forged digest"].includes(scenario) && launched.length===3){
				const [entry]=readdirSync(dir).filter(n=>n.startsWith("foundry-build-"));
				assert.ok(entry,"no cached build to corrupt");
				const [tree]=readdirSync(join(dir,entry)),payload=realpathSync(join(dir,entry,tree));
				put(payload,"entry","substituted");
				if(scenario==="forged digest")renameSync(payload,join(dir,entry,artifactDigest(f.root,payload)+tree.slice(64)));
			}
		}
		const result=spawnSync("/bin/sh",["-c",String(args.command)],{cwd:f.root,encoding:"utf8",env:{...process.env,TMPDIR:dir,
			CATALOG_PROBE:probe,CATALOG_RECIPE:scenario==="changed recipe" && launched.length>=3?"second":"first"}});
		assert.equal(result.status,0,result.stderr);
		if(standalone){
			logs.push(result.stdout);
			if(launched.length===1){
				beforeUpgrade=read().effects.find(c=>c.id===id);assert.ok(beforeUpgrade?.receipt?.exit===0);
				if(upgrade)cpSync(new URL("./",import.meta.url),install,{recursive:true});
			}
		}
		return {resultType:"success",textResultForLlm:result.stdout};
	}},version);
	let owner=open((await import(join(install,"runtime.mjs"))).createRuntime);
	const issuing=owner.operation("rollout",{run,assembly:prior.commit,check:failed.id,blob},"owner").then(()=>owner.flush());
	if(upgrade && fixtureVersion!==readFileSync(new URL("./reader.version",import.meta.url),"utf8").trim()){
		await assert.rejects(issuing,{code:"stale_reader"});
		owner.close();owner=open(createRuntime);owner.turn("owner");await owner.flush();
	}else await issuing;
	const end=read(),fresh=end.effects.filter(c=>c.kind==="component" && c.rollout && c.receipt);
	assert.equal(pending.length,3);assert.deepEqual(launched,fresh.map(c=>c.id));
	assert.deepEqual(fresh.map(c=>c.tool==="bash" && c.attempt?.version===2?c.attempt.previous??c.id:c.id),pending);
	if(upgrade)for(const id of pending.slice(1)){
		const old=end.effects.find(c=>c.id===id);
		assert.ok(old?.tool==="bash" && old.attempt?.version===1 && old.attempt.closure==="never-issued" && !old.callId && !old.runnerStarted && !old.receipt);
	}
	assert.deepEqual(end.effects.find(c=>c.id===pending[0]),beforeUpgrade);
	assert.equal(readFileSync(probe+".builds","utf8").trim().split("\n").length,
		oldBuild || scenario!=="pending checks"?3:2,"count actual hook processes (including one separate joined build)");
	const proof=owner.inspect({run,detail:"proof"},"owner");assert.equal(proof.qualified,candidate,proof.blocker??"original batch did not qualify");
	if(upgrade){assert.equal(proof.qualification,null);assert.match(proof.qualificationUnavailable??"",/actual prepared bytes/);}
	else assert.equal(proof.qualification?.commit,candidate);
	for(const c of fresh){assert.ok(c.kind==="component" && c.receipt?.exit===0);db.verifySigned(run,c);}
	const observations=readFileSync(probe,"utf8").trim().split("\n").map(l=>JSON.parse(l));
	assert.deepEqual(observations.slice(0,3).map(o=>o[0]),fresh.map(c=>c.grain));
	assert.equal(new Set(observations.slice(0,3).map(o=>o[1])).size,3,"separate runner processes");
	for(const i of [2,3])assert.equal(new Set(observations.map(o=>o[i])).size,observations.length,"no shared export or prepared directory");
	assert.match(logs[oldBuild?1:0],/Foundry preparation: built/);
	assert.match(logs[oldBuild?2:1],/Foundry preparation: reused/);
	if(scenario!=="pending checks")assert.match(logs[2],/Foundry preparation: built/);
	if(["corrupt bytes","forged digest"].includes(scenario))assert.match(fresh[2].receipt?.output??"",/Foundry preparation: rejected invalid cached build/);
});

for(const scenario of ["pass","negative","second follow-up","second follow-up with unchanged harness"])test(`follow-up rollout on the same stopped foreground batch / ${scenario}`,async t=>{
	const negative=scenario!=="pass",again=scenario.startsWith("second follow-up"),same=scenario.endsWith("unchanged harness");
	const {f,run,db,read,old,prior,failed,revision,publisher}=await failedAssembly(t,{consumer:true,rollout:true,tail:true,before:89});
	const inspect=scriptedInspections(f.root);
	let decisions=0,consent=true,prompt="";
	const begin=(/** @type {typeof createRuntime} */ implementation)=>f.runtime(f.root,{...inspect,formIdle:async()=>false,confirmProposal:async msg=>{decisions++;prompt=msg;return consent;}},implementation);
	const archived=await historicalRuntime(t,89),first=begin(fixtureVersion==="85" || fixtureVersion==="87"?old:archived);
	/** @param {typeof first} issuer @param {string} from @param {string} check @param {string} patch */
	async function offer(issuer,from,check,patch){
		const candidate=stagePatch(f.root,from,revision,patch);
		put(f.root,"delta.patch",git(f.root,"diff","--full-index",from,candidate)+"\n");
		await issuer.operation("publish",{run,file:"delta.patch",to:["unit"]},"owner");
		const blob=read().artifacts?.at(-1)?.blob;assert.ok(blob);
		return {args:{run,assembly:from,check,blob},candidate};
	}
	/** @param {string} path @param {string[]} lines */
	const add=(path,lines)=>`diff --git a/${path} b/${path}\nnew file mode 100755\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l=>"+"+l).join("\n")}\n`;
	const script=`${root}/check.sh`,mixed="unit/controls/check.sh",preflight=`./${root}/observe --require-foreground`,hidden=`test -z "\${CATALOG_ALLOW_FOREGROUND-}" || exit 3`;
	const shared=".foundry/observers/entry.sh",observer="unit/controls/Tests/observe.sh",broken=`cat "\${1:-${retainedFile}.old}"`,fixed=`cat "\${1:-${retainedFile}}"`;
	const assertion='test "$(sh "$1")" = connected',diagnostic=`actual=$(sh "$1"${same?` ${retainedFile}`:""}) && test "$actual" = connected`;
	const orig=await offer(first,prior.commit,failed.id,edit(file,"keep","keep:local")+
		add(".foundry/prepare-components",["#!/bin/sh",hidden,`cp ${file} "$1/entry"`])+
		add(script,["#!/bin/sh",preflight])+add(mixed,["#!/bin/sh",hidden,preflight])+
		(again?add(shared,["#!/bin/sh",broken]):"")+
		add(`${root}/observe`,["#!/bin/sh",'test "$1:$CATALOG_ALLOW_FOREGROUND" = --require-foreground:1 && exit 0',
			"echo 'Set CATALOG_ALLOW_FOREGROUND=1 only on an authorized desktop.'; exit 2"])+
		`--- a/.foundry/accept.mjs\n+++ b/.foundry/accept.mjs\n@@ -1 +1 @@\n-export const accepts=()=>false;\n+export const accepts=()=>true;\n`);
	await first.operation("rollout",orig.args,"owner");await first.flush();
	const held=read().effects.findLast(e=>e.kind==="component" && e.rollout && e.receipt?.exit===2);assert.ok(held?.grain==="selector");
	await first.operation("foreground",{run,assembly:orig.candidate,check:held.id,declarations:[{grain:"selector",file:script,line:2}]},"owner");await first.flush();
	const saved=read(),parent=saved.adoptions?.find(a=>a.foreground),stop=saved.effects.findLast(e=>e.kind==="component" && e.receipt?.exit===2);
	assert.ok(stop?.kind==="component" && stop.grain==="controls" && parent?.foreground);
	const retry=saved.effects.find(e=>e.id===parent.foreground?.retry);
	assert.ok(retry?.kind==="component" && retry.receipt?.exit===0);
	const tail=saved.effects.find(e=>e.kind==="component" && e.rollout===parent.id && e.grain==="nested");
	assert.ok(tail?.state==="ready");
	const route="CATALOG_ALLOW_FOREGROUND=1 "+preflight;
	const invocation=['sh "$here/Tests/observe.sh" \\',`   "$root/${shared}"`];
	const mixedLines=again?[`${route} || exit $?`,"root=$PWD","here=$root/unit/controls",...invocation]:[route+(negative?" && exit 1":"")];
	const patch=`--- a/${script}\n+++ b/${script}\n@@ -1,2 +1,3 @@\n #!/bin/sh\n-${preflight}\n+${hidden}\n+${route}\n`+
		`--- a/${mixed}\n+++ b/${mixed}\n@@ -2,2 +2,${mixedLines.length+1} @@\n ${hidden}\n-${preflight}\n${mixedLines.map(l=>"+"+l).join("\n")}\n`+
		(again?add(observer,["#!/bin/sh",assertion]):negative?add(".foundry/followup-marker",["#!/bin/sh","exit 0"]):"");
	const next=await offer(first,orig.candidate,stop.id,patch);
	if(fixtureVersion==="85")await assert.rejects(first.operation("rollout",next.args,"owner"),{code:"stale_pin"});
	first.close();publisher.close();const upgrading=again && fixtureVersion==="87",owner=begin(upgrading?old:same?archived:createRuntime);
	for(const invalid of [{check:held.id},{check:retry.id},{assembly:prior.commit},{blob:orig.args.blob}]){
		await assert.rejects(owner.operation("rollout",{...next.args,...invalid},"owner"));assert.equal(decisions,1);
	}
	consent=false;await assert.rejects(owner.operation("rollout",next.args,"owner"),{code:"approval_declined"});
	assert.deepEqual(read().effects,saved.effects);assert.deepEqual(read().join,prior);
	consent=true;await owner.operation("rollout",next.args,"owner");await owner.flush();
	const end=read(),a=end.adoptions?.find(a=>a.rollout?.followup?.proposal===parent.id),r=a?.rollout;
	assert.ok(r?.followup && a?.assembly===next.candidate && r.followup.check===stop.id && r.followup.files.length===(negative?3:2) && !a.foreground);
	assert.equal(decisions,3);assert.equal(end.effects.find(e=>e.id===tail.id)?.state,"withdrawn");
	for(const e of saved.effects.filter(e=>e!==tail)){
		assert.deepEqual(end.effects.find(x=>x.id===e.id),e);
		if(e.tool==="bash" && e.runnerClaim)db.verifySigned(run,e);
	}
	assert.deepEqual(end.products.slice(0,saved.products.length),saved.products);
	const fresh=end.effects.filter(e=>e.kind==="component" && e.rollout===a.id);
	assert.deepEqual(fresh.map(e=>e.grain),["selector","controls","nested"]);
	assert.deepEqual(fresh.map(e=>e.receipt?.exit),negative?[0,1,undefined]:[0,0,0]);
	for(const e of fresh)assert.equal(e.commit,next.candidate);
	if(negative){assert.deepEqual(end.nodes,saved.nodes);assert.deepEqual(end.join,prior);assert.ok(!owner.inspect({run},"owner").qualified);}
	else{
		const final=owner.inspect({run,detail:"proof"},"owner").qualification;assert.equal(final?.commit,next.candidate);
		for(const e of fresh){assert.ok(e.kind==="component");db.verifySigned(run,e);assert.ok(end.inspections?.some(i=>i.component===e.id && i.state==="approved"));}
		assert.deepEqual(Object.keys(end.products.at(-1)?.outputs??{}),Object.keys(prior.outputs));
	}
	await assert.rejects(owner.operation("rollout",next.args,"owner"));assert.deepEqual(read(),end);
	if(!again)return;
	const [passed,latest,waiting]=fresh;
	assert.ok(latest.kind==="component" && latest.grain==="controls" && waiting.state==="ready" && !waiting.callId);
	const replace=(/** @type {string} */ path,/** @type {string} */ before,/** @type {string} */ after,/** @type {number} */ line)=>{
		const lines=git(f.root,"show",`${next.candidate}:${path}`).split("\n");
		assert.equal(lines[line-1],before);
		return `--- a/${path}\n+++ b/${path}\n@@ -1,${lines.length} +1,${lines.length} @@\n`+
			lines.map((s,i)=>i===line-1?`-${s}\n+${after}`:` ${s}`).join("\n")+"\n";
	};
	const delta=(same?"":replace(shared,broken,fixed,2))+replace(observer,assertion,diagnostic,2);
	const final=await offer(owner,next.candidate,latest.id,delta);
	if(upgrading)await assert.rejects(owner.operation("rollout",final.args,"owner"),{code:"stale_pin"});
	owner.close();const current=begin(same?archived:createRuntime),forms=decisions;
	for(const args of [next.args,{...final.args,check:passed.id},{...final.args,assembly:orig.candidate}])
		await assert.rejects(current.operation("rollout",args,"owner"),{code:"stale_pin"});
	consent=false;
	for(const other of [edit(retainedFile,"connected","other"),replace(script,hidden,"exit 0",2),
		replace(".foundry/accept.mjs","export const accepts=()=>true;","export const accepts=()=>false;",1),
		add(".foundry/other-helper.sh",["#!/bin/sh","true"]),replace(mixed,mixedLines[0],`${route} || exit 3`,3)]){
		const wrong=await offer(current,next.candidate,latest.id,delta+other);
		await assert.rejects(current.operation("rollout",wrong.args,"owner"),{code:same?"patch_scope":"approval_declined"});
		if(!same)assert.ok(prompt.includes(wrong.args.blob));assert.deepEqual(read().effects,end.effects);
	}
	const before=git(f.root,"rev-parse",`${next.candidate}:${observer}`);
	put(f.root,"stale.patch",git(f.root,"diff","--full-index",next.candidate,final.candidate).replace(`index ${before}..`,`index ${before.replace(/^./,before[0]==="a"?"b":"a")}..`)+"\n");
	const stale=await current.operation("publish",{run,file:"stale.patch",to:["unit"]},"owner");
	await assert.rejects(current.operation("rollout",{...final.args,blob:stale.artifacts.at(-1)?.blob},"owner"),{code:"invalid_patch"});
	const issued=structuredClone(read()),later=issued.effects.find(e=>e.id===waiting.id);assert.ok(later);
	later.state="issued";later.callId="already-issued";
	assert.throws(()=>rolloutPlan(f.root,issued,"owner",next.candidate,latest.id,final.args.blob,e=>db.verifySigned(run,e)),{code:"stale_pin"});
	assert.equal(decisions,forms+(same?0:5));assert.deepEqual(read().effects,end.effects);
	await assert.rejects(current.operation("rollout",final.args,"owner"),{code:"approval_declined"});
	assert.deepEqual(read().effects,end.effects);assert.deepEqual(read().join,prior);
	assert.equal(decisions,forms+(same?1:6));
	if(!same)return;
	// The archived reader creates the old recipe-shaped record. The new reader never infers authority from that recipe.
	current.close();const historical=begin(archived);consent=true;await historical.operation("rollout",final.args,"owner");await historical.flush();
	const completed=read(),last=completed.adoptions?.find(o=>o.rollout?.followup?.proposal===a.id);
	assert.ok(last?.rollout?.followup && last.assembly===final.candidate && last.rollout.followup.check===latest.id && !last.foreground);
	assert.equal(last.rollout.followup.assembly,next.candidate);
	const recipe=last.rollout.followup.recipe;assert.ok(recipe);
	assert.equal(recipe.file,mixed);assert.equal(recipe.blob,git(f.root,"rev-parse",`${next.candidate}:${mixed}`));
	assert.ok(recipe.command.includes('"$here/Tests/observe.sh"') && recipe.command.includes(`"$root/${shared}"`) && prompt.includes(recipe.command));
	assert.deepEqual(last.rollout.followup.files.map(f=>f.file),[observer]);assert.equal(decisions,forms+2);
	assert.equal(r.harness,parent.rollout?.harness);assert.equal(last.rollout.harness===r.harness,same);
	assert.deepEqual(completed.products.slice(0,end.products.length),end.products);
	assert.equal(completed.effects.find(e=>e.id===waiting.id)?.state,"withdrawn");
	for(const e of end.effects.filter(e=>e.id!==waiting.id)){
		assert.deepEqual(completed.effects.find(c=>c.id===e.id),e);
		if(e.tool==="bash" && e.runnerClaim)db.verifySigned(run,e);
	}
	const checks=completed.effects.slice(end.effects.length).filter(c=>c.tool==="bash");
	assert.deepEqual(checks.map(c=>c.kind),["component","component","component","product","goal"]);
	for(const c of checks){
		assert.ok(c.tool==="bash" && c.commit===final.candidate && c.receipt?.exit===0);db.verifySigned(run,c);
		if(c.kind==="component")assert.ok(c.rollout===last.id && completed.inspections?.some(i=>i.component===c.id && i.state==="approved"));
	}
	// Reader 89 reported the standalone batch's build digest, but prepared the joined
	// components independently. Their signed observations identify the check and exit, not that tree.
	assert.match(checks[0].receipt?.output??"",/Foundry preparation: built [0-9a-f]{64}/);
	const joined=checks.find(c=>c.kind==="product")?.receipt;assert.ok(joined);
	assert.deepEqual(joined.components,Object.fromEntries(Object.keys(prior.outputs).map(id=>[id,{check:component,exit:0}])));
	assert.doesNotMatch(joined.output,/Foundry preparation:/);
	const original=historical.inspect({run},"owner").handoff;
	assert.deepEqual(original,{mode:"goal",commit:final.candidate,targetRef:completed.policy.target,target:revision});
	historical.close();const reopened=begin(createRuntime).inspect({run,detail:"proof"},"owner");
	assert.deepEqual(reopened.handoff,original);assert.equal(reopened.qualified,final.candidate);
	assert.equal(git(f.root,"rev-parse",completed.policy.target),revision);
	assert.equal(reopened.qualification,null);assert.match(reopened.qualificationUnavailable??"",/did not identify the actual prepared bytes/);
	assert.deepEqual(read(),completed,"proof inspection must preserve the original checks, receipts and checkpoint");
});

for(const origin of ["fresh reviewed owner","upgrade the stranded restoration","upgrade the paired production owner"])test(`an approved exact edit replaces only the failed output / ${origin}`,async t=>{
	const legacy=origin!=="fresh reviewed owner",production=origin==="upgrade the paired production owner";
	const {f,run,db,read,publish,prior,failed,p,revision,publisher,ownedFile,previousText,correctedText}=await failedAssembly(t,{legacy,production});
	const blob=await publish(edit(ownedFile,previousText,correctedText));
	if(legacy){
		publisher.turn("owner");await publisher.flush();
		assert.match(publisher.inspect({run},"owner").targetAdoption?.message??"",/No assigning charter area/);
	}
	const before=read(),prev=before.nodes.selector,checks=f.checks.length,count=f.workers.size;publisher.close();
	let approvals=0;
	const clock=recoveryClock(),owner=f.runtime(f.root,{watchRecovery:clock.watch,autoConfirm:async()=>true,confirm:async msg=>{
		approvals++;assert.ok([blob,ownedFile,prior.commit,failed.id,prev.check,prev.candidate].every(s=>s && msg.includes(s)),msg);
		assert.deepEqual(read().effects,before.effects);return true;
	}},createRuntime);
	owner.sessionStart("owner",f.root);await clock.pulse(owner,4);
	assert.equal(approvals,1,"a cached owned-output hold must turn into one exact proposal on an ordinary owner wake");
	const end=read(), final=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(final);
	assert.deepEqual(end.effects.find(c=>c.id===failed.id),failed);db.verifySigned(run,failed);
	assert.deepEqual(end.products.slice(0,-1),before.products);
	assert.deepEqual(end.products.at(-1)?.outputs,{...prior.outputs,selector:final.commit});
	assert.equal(git(f.root,"diff","--name-only",prior.commit,final.commit),ownedFile);
	assert.equal(git(f.root,"show",`${final.commit}:${ownedFile}`),correctedText);
	assert.equal(git(f.root,"rev-parse",`${prior.commit}:${retainedFile}`),git(f.root,"rev-parse",`${final.commit}:${retainedFile}`));
	assert.equal(git(f.root,"rev-parse","main"),revision);assert.equal(git(f.root,"show",`${final.commit}:operator`),"retain");
	assert.equal(f.workers.size,count);assert.equal(end.nodes.selector.worker,undefined);assert.equal(end.nodes.selector.token,undefined);
	const peer=production?"buttons":"controls";
	assert.deepEqual(end.nodes[peer],before.nodes[peer]);
	if(production){
		assert.equal(prior.outputs.selector,prior.outputs[peer]);assert.notEqual(final.commit,end.nodes[peer].candidate);
		assert.ok(before.effects.some(e=>e.kind==="writer" && e.observer?.file===ownedFile));
		const job=before.effects.findLast(e=>e.kind==="writer" && e.production);assert.ok(job?.kind==="writer" && job.production && !job.production.files.includes(ownedFile));
	}
	const replacement=end.effects.find(e=>e.id===end.nodes.selector.check);assert.ok(replacement?.kind==="component" && replacement.issuer==="owner");
	assert.equal(replacement.receipt?.exit,0);assert.equal(replacement.commit,final.commit);db.verifySigned(run,replacement);
	assert.throws(()=>db.verifySigned(run,{...replacement,replacement:undefined}),{code:"wrong_outcome"});
	assert.deepEqual(f.checks.slice(checks).map(c=>c.split(" at ")[0]),["Check selector","Check joined product","Check final goal"]);
	assert.equal(final.receipts.goal.commit,final.commit);
	if(!legacy){
		const dest=recipient(f.root,final,"owned","component:selector"),result=await observed(dest,"component:selector");
		assert.equal(result.status,0,result.stderr);
		assert.throws(()=>launchPlan(dest,"goal"),/replay|revision|ref|verify/i,"an owned-only transfer contains no goal carrier");
	}
	if(end.inspections){
		const review=end.inspections.find(i=>i.component===replacement.id);assert.ok(review?.state==="approved");
		assert.equal(review.generation,prior.commit);assert.deepEqual(review.scope,{directories:[],files:[ownedFile]});
	}
	assert.ok(end.productRepins?.at(-1)?.amendments?.some(s=>s.prior.check===prior.check));
	const forged=structuredClone(end),last=forged.products.at(-1);assert.ok(last);last.outputs[peer]=final.commit;
	assert.throws(()=>decode(forged),{code:"corrupt_run"});
	await clock.pulse(owner,3);assert.deepEqual(read(),end);assert.equal(p.check,end.products.at(-2)?.check);
});

for(const hold of ["consumer","component","review","declined","refused","other owner"])test(`an owned correction preserves the failed join / ${hold}`,async t=>{
	const {f,run,read,publish,prior,failed}=await failedAssembly(t,{consumer:hold==="consumer"});
	const patch=edit(file,"keep",hold==="component"?"still wrong":"keep:local")+(hold==="other owner"?edit(retainedFile,"connected","overwritten"):"");
	const blob=await publish(patch,["unit"]),base=read(),checks=f.checks.length;
	const inspections=scriptedInspections(f.root);let asked=0;
	const owner=f.runtime(f.root,{confirm:async()=>{asked++;return hold!=="declined";},execute:async(tool,args,key)=>{
		if(hold==="refused" && tool==="bash")return {resultType:"denied"};
		return f.execute(tool,args,key);
	},inspectionState:async id=>{
		const r=await inspections.inspectionState(id);return {...r,result:{...r.result,outcome:"changes",summary:"This change loses the original assertion."}};
	},startInspection:inspections.startInspection},createRuntime);
	owner.turn("owner");await owner.flush();
	if(hold==="consumer" || hold==="other owner"){
		assert.equal(asked,0);assert.match(owner.inspect({run},"owner").blocker??"",hold==="consumer"?/consum|pin/i:/owned|grant|scope/);
	}else assert.equal(asked,1);
	assert.deepEqual(read().join,prior);assert.deepEqual(read().products,base.products);assert.deepEqual(read().nodes,base.nodes);
	assert.deepEqual(f.checks.slice(checks).map(c=>c.split(" at ")[0]),hold==="component" || hold==="review"?["Check selector"]:[]);
	if(hold==="component" || hold==="review"){
		const proof=owner.inspect({run,detail:"proof"},"owner");assert.match(proof.blocker??"",hold==="component"?/still wrong|Missing entry category|exit 1/:/loses the original assertion/);
		await assert.rejects(owner.operation("owned",{run,check:failed.id,blob},"owner"),/already|observed|same|blocked/i);
		owner.turn("owner");await owner.flush();assert.equal(asked,1);assert.equal(owner.inspect({run},"owner").qualified,null);
	}
	if(hold==="component"){
		const old=read().effects.at(-1),corrected=await publish(edit(file,"keep","keep:local"));
		const next=f.runtime(f.root,{confirm:async msg=>{assert.ok(msg.includes(corrected));return true;}});
		next.turn("owner");await next.flush();
		assert.ok(next.inspect({run},"owner").qualified);assert.deepEqual(read().effects.find(c=>c.id===old?.id),old);
	}
});

test("the replacement component uses the adopted target's verified build, not a local fallback",async t=>{
	const {f,run,read,publish,failed}=await failedAssembly(t,{prepared:true});
	const blob=await publish(edit(file,"keep","keep:local")),owner=f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("owned",{run,check:failed.id,blob},"owner");await owner.flush();
	assert.ok(owner.inspect({run},"owner").qualified,"the exact standalone owner check needs its own fresh prepared input");
	assert.equal(read().effects.find(c=>c.id===read().nodes.selector.check)?.receipt?.exit,0);
});

test("manual selection binds the original failure, owner, and patch without widening the inherited grant",async t=>{
	const {f,run,read,publish,prior,failed}=await failedAssembly(t);
	const blob=await publish(edit(file,"keep","keep:local")),args={run,check:failed.id,blob};
	let prompts=0;const owner=f.runtime(f.root,{confirm:async msg=>{
		prompts++;assert.ok(msg.includes(prior.commit) && msg.includes(blob));return true;
	}});
	await assert.rejects(owner.operation("inherit",args,"owner"),{code:"patch_scope"});
	await assert.rejects(owner.operation("owned",args,"stranger"),{code:"foreign_run"});
	await assert.rejects(owner.operation("owned",{...args,check:read().nodes.selector.check},"owner"),{code:"stale_pin"});
	assert.equal(prompts,0);
	await owner.operation("owned",args,"owner");await owner.flush();
	assert.equal(prompts,1);assert.ok(owner.inspect({run},"owner").qualified);
	await assert.rejects(owner.operation("owned",args,"owner"),{code:"goal_met"});assert.equal(prompts,1);
});

test("a late review cannot publish an owned correction on a different target; restoring the pin reuses the original review",async t=>{
	const {f,run,read,publish,prior,revision}=await failedAssembly(t);
	await publish(edit(file,"keep","keep:local"));
	const initial=read(),checks=f.checks.length,reviewer=scriptedInspections(f.root);let moved="",asks=0,starts=0;
	const owner=f.runtime(f.root,{confirm:async()=>{asks++;return true;},startInspection:async(...a)=>{starts++;return reviewer.startInspection(...a);},
		inspectionState:async id=>{
			if(!moved){put(f.root,"operator","later");git(f.root,"commit","-qam","Change the target while examining the correction");moved=git(f.root,"rev-parse","HEAD");}
			return reviewer.inspectionState(id);
		}});
	owner.turn("owner");await owner.flush();
	assert.ok(moved);assert.equal(asks,1);assert.equal(starts,1);assert.deepEqual(read().join,prior);assert.deepEqual(read().nodes,initial.nodes);
	assert.deepEqual(f.checks.slice(checks).map(c=>c.split(" at ")[0]),["Check selector"]);
	git(f.root,"update-ref","refs/heads/main",revision,moved);
	owner.turn("owner");await owner.flush();assert.ok(owner.inspect({run},"owner").qualified);
	assert.equal(asks,1);assert.equal(starts,1);
});

test("a later amendment keeps a repaired owner that was not on the original checkpoint",async t=>{
	const {f,run,read,publish,p,prior}=await failedAssembly(t,{deferOwner:true});
	assert.ok(!p.outputs.selector && prior.outputs.selector);
	await publish(edit(file,"keep","keep:local"));let asked=0;
	const owner=f.runtime(f.root,{confirm:async()=>{asked++;return true;}});
	owner.turn("owner");await owner.flush();
	const midway=read(),first=midway.join;assert.ok(first && first.outputs.selector!==prior.outputs.selector);
	assert.equal(midway.effects.find(e=>e.id===first.check)?.receipt?.components?.controls.exit,1);
	await publish(edit(helper,"old","current"),["unit/shared"]);
	owner.turn("owner");await owner.flush();
	const end=read(),final=owner.inspect({run,detail:"proof"},"owner").qualification;
	assert.ok(final,owner.inspect({run},"owner").blocker??"The amended product did not qualify");
	assert.equal(asked,2);assert.equal(end.nodes.selector.check,midway.nodes.selector.check);
	assert.deepEqual(end.products.at(-1)?.outputs,first.outputs);
});

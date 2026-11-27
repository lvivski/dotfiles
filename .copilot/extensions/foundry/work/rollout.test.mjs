import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter, once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { factory, git, put, recoveryClock, scriptedInspections } from "../test/fixture.mjs";
import { historicalFactory, historicalRuntime } from "../test/legacy-readers.mjs";
import { guideReplay, launchDescription, launchPlan, launchStep, observed, recipient } from "../test/portable.mjs";
import { portableReceipt } from "./portable.mjs";
import { replacementBlob } from "./inputs.mjs";
import { observedOverlay } from "./attestation.mjs";
import { candidatePacket } from "./critique.mjs";
import { openDatabase } from "./database.mjs";
import { qualifiedProduct } from "./evidence.mjs";
import { git as rawGit, stagePatch } from "./product.mjs";
import { createRuntime } from "./runtime.mjs";
import { decode } from "./snapshot.mjs";
import { authorDefinition } from "./author.mjs";
import { patchPlan } from "./patch.mjs";

const run="report",source=".foundry/report.json",charter=".foundry/team.md",spec=".foundry/entry.md",boundary=".foundry/units.md";
const component=".foundry/check.mjs",product=".foundry/product.mjs",goal=".foundry/goal.mjs",rule=".foundry/verdict",hold=".foundry/hold";
const format=product+".d/format",dir="entries/report",value=dir+"/total",space=dir+"/release notes.txt",hook=".foundry/prepare-components";
const requirement="Report totals must be in whole units.",fixture=process.env.FOUNDRY_ROLLOUT_FIXTURE;
const legacy=fixture && readFileSync(join(fixture,"work/reader.version"),"utf8").trim()==="86"?fixture:undefined;
/** @param {string} file @param {string} from @param {string} to */
const edit=(file,from,to)=>`--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-${from}\n+${to}\n`;
/** @param {string} file @param {string[]} lines @param {boolean} [executable] */
const add=(file,lines,executable)=>`diff --git a/${file} b/${file}\nnew file mode ${executable?"100755":"100644"}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n${lines.map(l=>"+"+l).join("\n")}\n`;
const observe=`import {existsSync,readFileSync} from "node:fs";const read=f=>existsSync(f)?readFileSync(f,"utf8").trim():"absent";
	const entry=read("${value}"),rule=read("${rule}"),hold=read("${hold}"),format=read("${format}"),foreground=process.env.REVIEW_ALLOW_FOREGROUND??"absent";
	console.log(JSON.stringify({entry,rule,hold,format,foreground}));`;
/** @param {import("node:test").TestContext} t @param {boolean} archived @param {{goal?:string,product?:string,files?:Record<string,string>,control?:string,check?:string,total?:string,area?:boolean,task?:string,reader?:89|90|94|95,sourceEdition?:string,unobserved?:boolean}} [rules] */
async function stopped(t,archived,rules={}){
	const reader=rules.reader??(rules.control?89:undefined);
	const sourceEdition=rules.sourceEdition??(archived?legacy:undefined);
	/** @type {typeof factory} */ const build=sourceEdition?(await import(`${sourceEdition}/test/fixture.mjs`)).factory:reader?await historicalFactory(t,reader):factory;
	/** @type {typeof createRuntime} */ const original=sourceEdition?(await import(`${sourceEdition}/work/runtime.mjs`)).createRuntime:reader?await historicalRuntime(t,reader):createRuntime;
	const f=build(t,run,source,{[source]:JSON.stringify(rules.area?{version:2,id:run,direction:"Publish a report.",target:"refs/heads/main",
		productCheck:product,goalCheck:goal,squads:[{id:"reports",charter,areas:["entries"],boundary:[spec,boundary],checks:[component]}]}:{version:1,id:run,direction:"Publish a report.",target:"refs/heads/main",
		productCheck:product,goalCheck:goal,squads:[{id:"reports",charter,grains:["entry"]}],
		grains:[{id:"entry",directory:dir,specification:spec,boundary:[boundary],check:component,needs:[]}]}),
		[charter]:"Publish the full report.",[spec]:requirement+"\n",[boundary]:"One total per line.\n",[component]:"",
		[rule]:"release\n",[format]:"plain\n",[product]:observe+(rules.product??""),[goal]:observe+
			`process.exit(entry==="absent"?1:entry!=="draft" && (${rules.goal??'rule==="release" && hold==="absent" && foreground==="absent"'})?0:2);`});
	if(rules.control){put(f.root,component+".control",rules.control);chmodSync(join(f.root,component+".control"),0o755);git(f.root,"add",component+".control");git(f.root,"commit","-qm","Freeze independent controls");}
	const base=git(f.root,"rev-parse","HEAD");
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"The report is missing.",evidence:[charter],grains:rules.area?[{id:"entry",directory:dir,task:rules.task??requirement,needs:[],check:component}]:["entry"]});
	const [w]=f.workers.values();put(w.cwd,value,(rules.total??"draft")+"\n");put(w.cwd,space,"previous wording\n");
	for(const [file,bytes] of Object.entries(rules.files??{}))put(w.cwd,file,bytes);
	await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);await f.settle();
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	const initial=read(),p=initial.products.at(-1),i=initial.inspections?.find(i=>i.component===initial.nodes.entry.check);assert.ok(p && i);
	assert.ok(candidatePacket(f.root,i).prompt.includes(requirement));
	put(f.root,component,rules.check??observe+`if(entry==="draft" || process.env.FOUNDRY_PREPARED_DIR && read(process.env.FOUNDRY_PREPARED_DIR+"/scope")==="joined" && entry!=="settled")process.exit(1);`);
	git(f.root,"add",component);git(f.root,"commit","-qm","Check the report on the assembled target");const target=git(f.root,"rev-parse","HEAD");
	/** @type {string[]} */ const forms=[];let consent=true;
	/** @type {Map<string,string>} */ const packets=new Map();
	/** @param {typeof createRuntime} version @param {Parameters<typeof f.runtime>[1]} [host] */
	function open(version,host){
		const scripted=scriptedInspections(f.root);
		/** @type {ReturnType<typeof createRuntime>} */ const owner=f.runtime(f.root,{...scripted,formIdle:async()=>false,confirm:async()=>consent,
			confirmProposal:async msg=>{forms.push(msg);return consent;},
			startInspection:async(...args)=>{
				const started=await scripted.startInspection(...args);
				const packet=await owner.inspectionPacket(...args,started.runId);
				packets.set(packet.component,packet.prompt);return started;
			},execute:(tool,args,key)=>f.execute(tool,legacy && version===original && tool==="bash"?{...args,command:`export REVIEW_ALLOW_FOREGROUND=1; ${args.command}`}:args,key),...host
		},version);
		return owner;
	}
	const owner=open(original);
	await owner.operation("repin",{run,kind:"target",from:base,revision:target,checkpoint:p.check,goal:initial.goal?.check,files:[component],acceptance:"Check the assembled report."},"owner");
	await owner.flush();
	const j=read().join;assert.ok(j);assert.equal(read().effects.find(c=>c.id===j.check)?.receipt?.components?.entry.exit,rules.unobserved?2:1);
	/** @param {typeof owner} issuer @param {import("./model.js").Product} at @param {string} delta @param {(full:string)=>string} [transform] */
	async function offer(issuer,at,delta,transform){
		const candidate=stagePatch(f.root,at.commit,target,delta),full=git(f.root,"diff","--full-index",at.commit,candidate)+"\n";
		put(f.root,"entry.diff",transform?transform(full):full);
		const result=await issuer.operation("publish",{run,file:"entry.diff",to:[dir]},"owner");
		const blob=result.artifacts.at(-1)?.blob;assert.ok(blob);
		return {candidate,full,args:{run,assembly:at.commit,check:at.check,blob}};
	}
	/** @param {string} id */
	function signed(id){
		const c=read().effects.find(e=>e.id===id);assert.ok(c?.tool==="bash" && c.receipt);db.verifySigned(run,c);return c;
	}
	return {f,open,owner,original,read,j,offer,target,forms,packets,signed,consent:(/** @type {boolean} */ v)=>{consent=v;}};
}

for(const wake of ["ordinary wake","unchanged clock","restored issuer"])test(`an unissued correction waits for evidence, then uses its original reservation / ${wake}`,async t=>{
	const reload=wake==="restored issuer";
	const {f,owner,open,original,read,j,offer,target,signed}=await stopped(t,false,{sourceEdition:reload?process.env.FOUNDRY_ISSUER_BEFORE:undefined});
	const change=await offer(owner,j,edit(value,"draft","ready")+edit(format,"plain","detailed"));
	owner.close();
	const clock=recoveryClock(),before=signed(j.check);
	let moved="",samples=0,forms=0,starts=0,limit=1;
	/** @type {(()=>Promise<unknown>)|undefined} */ let originalCall;
	/** @type {Parameters<typeof f.runtime>[1]} */
	const host={
		watchRecovery:clock.watch,watchReceipts:()=>()=>{},
		// Bound a broken issuer's immediate refill loop without issuing a call or changing its ledger.
		mode:async()=>samples>limit?"plan":"autopilot",
		confirmProposal:async()=>{forms++;return true;},
		execute:async(tool,args,key)=>{
			if(tool==="bash" && read().effects.some(e=>e.kind==="component" && e.rollout && e.callId===key)){
				starts++;
				if(reload){originalCall=()=>f.execute(tool,args,key);return {resultType:"unconfirmed"};}
			}
			return f.execute(tool,args,key);
		},
		permissionBlocker:async()=>{
			if(read().effects.some(e=>e.kind==="component" && e.rollout && !e.callId)){
				samples++;
				if(!moved){put(f.root,"operator-note","Keep this work.");git(f.root,"add","operator-note");
					git(f.root,"commit","-qm","Move target after approval");moved=git(f.root,"rev-parse","HEAD");}
			}
			return null;
		},
	};
	let issuer=open(reload?original:createRuntime,host);
	await issuer.operation("rollout",change.args,"owner");await issuer.flush();
	const saved=read(),member=saved.effects.find(e=>e.kind==="component" && e.rollout);
	assert.ok(moved && member?.kind==="component" && member.state==="ready" && !member.callId && !member.runnerClaim);
	if(reload){
		issuer.close();samples=0;issuer=open(createRuntime,host);
		issuer.sessionStart("owner",f.root);await clock.pulse(issuer);
	}
	assert.equal(samples,1,"an unchanged unissued claim must not schedule its own second permission sample");
	if(reload){await clock.pulse(issuer,5);assert.equal(samples,1,"unchanged ledger and ref need no further permission samples");}
	if(wake==="unchanged clock"){
		limit=4;await clock.pulse(issuer,8);
		assert.ok(samples<=2,"a moved ref can wake its peers once, not ask for permission on every clock sample");
	}
	assert.deepEqual(read().effects,saved.effects);
	samples=0;
	git(f.root,"update-ref","refs/heads/main",target,moved);
	await clock.pulse(issuer,3);
	if(reload){
		const uncertain=read().effects.find(e=>e.id===member.id);
		assert.ok(originalCall && uncertain?.state==="uncertain" && uncertain.callId && !uncertain.runnerClaim);
		await clock.pulse(issuer,3);assert.deepEqual(read().effects.find(e=>e.id===member.id),uncertain);assert.equal(starts,1);
		await originalCall();await clock.pulse(issuer,5);
	}
	assert.equal(issuer.inspect({run},"owner").qualified,change.candidate);
	assert.equal(signed(member.id).receipt?.exit,0);assert.deepEqual(signed(j.check),before);
	assert.deepEqual(read().effects.filter(e=>e.kind==="component" && e.rollout).map(e=>e.id),[member.id]);
	assert.equal(starts,1);assert.equal(forms,1);
});

test("the verbatim published consumer observes a prepared release with the runner's noninteractive stdio",async t=>{
	const home=mkdtempSync(join(tmpdir(),"foundry-guide-"));t.after(()=>rmSync(home,{recursive:true,force:true}));
	const trace=join(home,"calls"),fault=join(home,"fail-product"),module=".foundry/inspect-stdio.mjs";
	const call=(/** @type {string} */ role)=>`(await import("./inspect-stdio.mjs")).observe(${JSON.stringify(role)})`;
	const check=observe+`if(entry==="draft")process.exit(1);${call("component")};if(read(process.env.FOUNDRY_PREPARED_DIR+"/ready")!=="ready")process.exit(2);`;
	const {f,owner,j,read,offer}=await stopped(t,false,{check,product:`if(entry==="ready")${call("product")};`,goal:`rule==="measured" && ${call("goal")}`});
	const code=`import {appendFileSync,existsSync,fstatSync,readFileSync,writeFileSync} from "node:fs";import {isatty} from "node:tty";
export function observe(role){
 const interactive=[0,1,2].some(fd=>isatty(fd)),ignored=fstatSync(0).isCharacterDevice(),input=interactive?-1:readFileSync(0).length;
 const piped=[1,2].every(fd=>fstatSync(fd).isSocket()||fstatSync(fd).isFIFO());
 appendFileSync(${JSON.stringify(trace)},role+"\\n");
 if(interactive||!ignored||input!==0||!piped){console.error("Wrong stdio: "+JSON.stringify({role,interactive,ignored,input,piped}));process.exit(73);}
 if(role==="prepare"){writeFileSync(1,"x".repeat(1024*1024+128)+"large-build-complete\\n");writeFileSync(2,"build diagnostic\\n");}
 if(role==="product"&&existsSync(${JSON.stringify(fault)})){console.error("fixture product failed");process.exit(17);}
 return true;
}`;
	const change=await offer(owner,j,edit(value,"draft","ready")+edit(rule,"release","measured")+add(module,code.split("\n"))+
		add(hook,["#!/usr/bin/env node",`import("./inspect-stdio.mjs").then(m=>{m.observe("prepare");require("node:fs").writeFileSync(process.argv[2]+"/ready","ready")});`],true));
	await owner.operation("rollout",change.args,"owner");await owner.flush();
	const state=read(),proof=owner.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);
	const prior=readFileSync(trace,"utf8"),calls=f.checks.slice(),dest=recipient(f.root,proof,"documented");
	assert.equal(prior,"prepare\ncomponent\nprepare\ncomponent\nproduct\ngoal\n","the runner observed standalone and joined checks independently");
	const description=launchDescription(dest,"release");assert.equal(readFileSync(trace,"utf8"),prior,"transfer and planning are inert");
	const result=guideReplay(dest,description);assert.equal(result.status,0,result.stderr);
	assert.ok(result.stdout.includes("x".repeat(1024*1024+128)+"large-build-complete"),"do not truncate piped output at 1 MiB");
	assert.match(result.stderr,/build diagnostic/);assert.equal(readFileSync(trace,"utf8"),prior+"prepare\ncomponent\nproduct\ngoal\n");
	writeFileSync(fault,"stop");const failed=guideReplay(dest,launchDescription(dest,"release"));assert.notEqual(failed.status,0);
	assert.match(failed.stderr,/fixture product failed/);assert.match(failed.stderr,/product.*17/);
	assert.equal(readFileSync(trace,"utf8"),prior+"prepare\ncomponent\nproduct\ngoal\nprepare\ncomponent\nproduct\n");
	assert.deepEqual(read(),state);assert.deepEqual(f.checks,calls);
});

test("reader-89 foreground observations without a prepare hook remain checked but not portable",async t=>{
	const script=`${dir}/observe.sh`,probe=`${dir}/probe`;
	const check=observe+`if(entry==="draft")process.exit(1);const {spawnSync}=await import("node:child_process");
		process.exit(spawnSync("./${script}",[],{stdio:"inherit"}).status??3);`;
	const {f,open,owner,read,j,offer,target,signed}=await stopped(t,false,{reader:89,check,goal:'rule==="measured" && foreground==="absent"'});
	const {args,candidate}=await offer(owner,j,edit(value,"draft","ready")+edit(rule,"release","measured")+
		add(script,["#!/bin/sh",`./${probe} --require-foreground`],true)+add(probe,["#!/bin/sh",
			'test "$1:$REVIEW_ALLOW_FOREGROUND" = --require-foreground:1 && exit 0',
			"echo 'Set REVIEW_ALLOW_FOREGROUND=1 only on an authorized desktop.'; exit 2"],true));
	assert.equal(git(f.root,"ls-tree",candidate,"--",hook),"");
	await owner.operation("rollout",args,"owner");await owner.flush();
	const held=read().effects.findLast(c=>c.kind==="component" && c.commit===candidate && c.receipt?.exit===2);assert.ok(held);
	await owner.operation("foreground",{run,assembly:candidate,check:held.id,declarations:[{grain:"entry",file:script,line:2}]},"owner");await owner.flush();
	owner.turn("owner");await owner.flush();
	const state=read(),last=state.products.at(-1);assert.ok(last?.qualifiedAt && last.commit===candidate);
	const standalone=signed(state.nodes.entry.check??assert.fail()),joined=signed(last.check),g=signed(state.goal?.check??assert.fail());
	assert.ok(standalone.lane && standalone.lane===joined.lane && !g.lane);
	assert.deepEqual([standalone.receipt?.exit,joined.receipt?.components?.entry.exit,joined.receipt?.exit,g.receipt?.exit],[0,0,0,0]);
	assert.equal(JSON.parse(standalone.receipt?.output??"").foreground,"1");
	assert.equal(JSON.parse(joined.receipt?.output??"").foreground,"absent","only the joined component, not its aggregate, received the lane");
	const handoff=owner.inspect({run},"owner").handoff;owner.close();f.owner.close();
	const calls=f.checks.slice(),restored=open(createRuntime,{execute:async()=>assert.fail("Inspecting an old pass must not reissue it")});
	const result=restored.inspect({run,detail:"proof"},"owner");assert.deepEqual(result.handoff,handoff);assert.equal(result.qualified,candidate);
	const db=openDatabase(f.root);t.after(()=>db.close());
	/** @param {import("./model.js").NativeCall} c */
	const portable=c=>portableReceipt({cwd:f.root,verify:e=>db.verifySigned(run,e)},state,c,last);
	for(const c of [standalone,joined]){
		assert.throws(()=>db.verifySigned(run,{...c,lane:undefined}),{code:"wrong_outcome"});
		assert.throws(()=>portable(c),/foreground environment that v5 cannot represent/);
	}
	assert.equal(portable(g).inputs.scope.kind,"goal","the goal itself had no foreground lane");
	assert.equal(result.qualification,null);assert.match(result.qualificationUnavailable??"",/foreground environment that v5 cannot represent/);
	assert.equal(git(f.root,"rev-parse",state.policy.target),target);assert.deepEqual(read(),state);assert.deepEqual(f.checks,calls);
});

for(const outcome of ["qualified","foreign path","wrong preimage","uncertain","pause","decline"])test(`writer-drafted adopted correction / ${outcome}`,async t=>{
	const {f,owner,open,read,j,target,signed,original}=await stopped(t,false,{reader:94,area:true});
	const edition=process.env.FOUNDRY_DRAFT_RED?original:createRuntime;
	const before=read(),failure=signed(j.check),producer=before.nodes.entry.check,count=f.checks.length;
	owner.close();f.owner.close();
	put(f.root,"operator-notes","staged");git(f.root,"add","operator-notes");put(f.root,"operator-notes","private draft");
	const index=git(f.root,"write-tree");
	let calls=0,decisions=0;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(edition,{formIdle:async()=>true,
		...(outcome==="qualified" && {startInspection:async(/** @type {string} */ id,/** @type {string} */ inspection,/** @type {string} */ dispatch,/** @type {string} */ actor)=>{
			// A returned draft is not an independent code review, even if a provider repeats its native ID.
			await assert.rejects(now.inspectionPacket(id,inspection,dispatch,actor,"author-1"),{code:"wrong_workflow"});
			const original=read().correctionDrafts?.at(-1)?.parts[0];assert.equal(original?.workflow,"author-1");
			const correct=`inspection-${inspection}`;
			await now.inspectionPacket(id,inspection,dispatch,actor,correct);return {runId:correct,status:"running"};
		},inspectionState:async(/** @type {string} */ workflow)=>{
			const i=read().inspections?.find(i=>i.workflow===workflow);assert.ok(i);
			return {runId:workflow,status:"completed",result:{inspection:i.id,component:i.component,candidate:i.candidate,outcome:"approved",summary:"Checked the corrected implementation."}};
		}}),
		draftAgent:async ticket=>{
			calls++;if(outcome==="uncertain")throw Error("lost native start response");
			const id=`author-${calls}`;
			if(outcome==="qualified"){
				await assert.rejects(now.draftPacket(ticket,"other",id),{code:"wrong_workflow"});
				const workflow=authorDefinition(()=>now),reject=()=>assert.fail("Unexpected proposal writer operation");
				/** @type {import("@github/copilot-sdk/extension").WorkflowContext<typeof ticket>} */ const ctx={
					args:ticket,runId:id,signal:new AbortController().signal,session:/** @type {import("@github/copilot-sdk").CopilotSession} */({sessionId:"owner"}),
					agents:{},phase(){},log(){},step:async(_,f)=>f(),parallel:reject,pipeline:reject,pause:reject,workflow:reject,
					agent:async(msg,opts)=>{
						assert.equal(opts?.agent,"foundry-proposal-writer");const packet=JSON.parse(msg.split("\n").at(-1)??"");
						assert.equal(packet.source.component,producer);assert.equal(packet.source.producer,before.nodes.entry.worker);
						assert.deepEqual(packet.files.map((/** @type {{file:string}} */ f)=>f.file).sort(),[space,value].sort());
						assert.equal(packet.assembly,j.commit);assert.equal(packet.check,failure.id);
						assert.ok(!msg.includes(before.nodes.entry.token??assert.fail()));
						const row=packet.files.find((/** @type {{file:string}} */ f)=>f.file===value);
						return {reason:"Keep the promised entry.",edits:[{file:value,before:row.before,text:"ready\n"}]};
					}
				};
				return {runId:id,status:"completed",result:await workflow.run(ctx)};
			}
			const packet=await now.draftPacket(ticket,"owner",id);
			assert.equal(packet.check,j.check);assert.equal(packet.assembly,j.commit);
			assert.equal(packet.source.component,producer);assert.equal(packet.source.grain,"entry");
			assert.deepEqual(packet.files.map(f=>f.file).sort(),[space,value].sort());
			assert.ok(!packet.files.some(f=>f.file.startsWith(".foundry/")));
			const b=packet.files.find(f=>f.file===value);assert.ok(b);assert.equal(b.text,"draft\n");
			if(outcome==="pause")await now.operation("pause",{run},"owner");
			return {runId:id,status:"completed",workflowName:"foundry-draft",result:{subject:ticket.subject,reason:"Use the completed report.",
				edits:[{file:outcome==="foreign path"?charter:value,before:outcome==="wrong preimage"?target:b.before,text:"ready\n"}]}};
		},confirmProposal:async message=>{
			decisions++;assert.ok(message.includes(value) && message.includes("ready") && message.includes(j.check));
			assert.equal(f.checks.length,count,"draft itself cannot start a check");return outcome!=="decline";
		}});
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();now.turn("owner");await now.flush();
	assert.equal(calls,1,"an ordinary wake must bind one bounded author on the original stopped run, without an owner patch");
	assert.deepEqual(signed(j.check),failure);assert.deepEqual(read().artifacts,before.artifacts);
	if(outcome==="qualified"){
		const proof=now.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof);
		assert.equal(git(f.root,"diff","--name-only",j.commit,proof.commit),value);
		assert.equal(git(f.root,"show",`${proof.commit}:${value}`),"ready");assert.equal(proof.receipts.product.components?.entry.exit,0);
		assert.equal(proof.receipts.goal.exit,0);assert.ok(read().inspections?.some(i=>i.candidate===proof.commit && i.state==="approved"));
		const forged=structuredClone(read()),draft=forged.correctionDrafts?.at(-1);assert.ok(draft);
		draft.parts[0].changes?.splice(0,1,{file:charter,mode:"100644",before:target,result:j.commit});
		assert.throws(()=>decode(forged),{code:"corrupt_run"});
	}else{assert.equal(now.inspect({run},"owner").qualified,null);assert.equal(f.checks.length,count);}
	assert.equal(decisions,["qualified","decline"].includes(outcome)?1:0);
	assert.equal(git(f.root,"rev-parse","HEAD"),target);assert.equal(git(f.root,"write-tree"),index);
	assert.equal(readFileSync(join(f.root,"operator-notes"),"utf8"),"private draft");
	now.close();const again=open(edition,{draftAgent:async()=>{calls++;throw Error("duplicate dispatch");}});
	again.sessionStart("owner",f.root);again.turn("owner");await again.flush();assert.equal(calls,1);
});

test("a 95 ledger already carrying conflicting workflow identities stays intact on reopen",async t=>{
	const {f,open,owner,original,j,signed}=await stopped(t,false,{reader:95,area:true});
	const failed=signed(j.check);owner.close();f.owner.close();
	const id="shared-historical-workflow";let authorCalls=0,reviewCalls=0;
	const old=open(original,{formIdle:async()=>true,confirmProposal:async()=>true,
		draftAgent:async ticket=>{
			authorCalls++;const packet=await old.draftPacket(ticket,"owner",id),file=packet.files.find(f=>f.file===value);assert.ok(file);
			return {runId:id,status:"completed",result:{subject:ticket.subject,reason:"Keep the promised total.",edits:[{file:value,before:file.before,text:"ready\n"}]}};
		},
		startInspection:async(run,job,ticket,actor)=>{
			reviewCalls++;await old.inspectionPacket(run,job,ticket,actor,id);return {runId:id,status:"running"};
		},inspectionState:async()=>assert.fail("No outcome for the conflicting historical identity")});
	old.turn("owner");await old.flush();old.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const raw=new DatabaseSync(db.file,{readOnly:true});t.after(()=>raw.close());
	const row=()=>raw.prepare("SELECT document,checksum FROM runs WHERE id=?").get(run);
	const saved=row();assert.ok(saved && authorCalls===1 && reviewCalls===1);
	const state=JSON.parse(String(saved.document)),last=state.inspections.at(-1);
	assert.equal(last.workflow,id);assert.equal(state.correctionDrafts.at(-1).parts[0].workflow,id);
	assert.equal(last.state,"issued");assert.equal(state.effects.find((/** @type {import("./model.js").Effect} */ e)=>e.id===failed.id).receipt.exit,failed.receipt?.exit);
	const checks=[...f.checks],current=open(createRuntime,{startInspection:async()=>assert.fail("Do not replay a conflicted call")});
	assert.throws(()=>current.inspect({run},"owner"),{code:"corrupt_run"});
	await assert.rejects(current.operation("resume",{run,source},"owner"),{code:"corrupt_run"});
	assert.deepEqual(row(),saved);assert.deepEqual(f.checks,checks);current.close();
});

test("writer-drafted rollout partitions harness and owned paths before the first author runs",async t=>{
	const {f,owner,open,read,j,signed,original}=await stopped(t,false,{reader:94,area:true,goal:'rule==="measured"'});owner.close();f.owner.close();
	/** @type {string[][]} */ const groups=[];let prompts=0;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(process.env.FOUNDRY_DRAFT_RED?original:createRuntime,{formIdle:async()=>true,
		draftAgent:async ticket=>{
			const id=`part-${groups.length+1}`,p=await now.draftPacket(ticket,"owner",id);
			groups.push(p.files.map(f=>f.file));assert.equal(p.files.length,1);
			const [row]=p.files;
			return {runId:id,status:"completed",workflowName:"foundry-draft",result:{subject:ticket.subject,reason:"Keep both observers in agreement.",
				edits:[{file:row.file,before:row.before,text:row.file===value?"ready\n":"measured\n"}]}};
		},confirmProposal:async()=>{prompts++;return true;}});
	await assert.rejects(now.operation("draft",{run,check:j.check,files:[value,charter]},"owner"),/protected|conserved/i);
	await assert.rejects(now.operation("draft",{run,check:j.check,files:[value,value]},"owner"),/duplicate/i);
	await now.operation("draft",{run,check:j.check,files:[value,rule]},"owner");await now.flush();
	assert.deepEqual(groups.sort(),[[rule],[value]].sort());assert.equal(prompts,2,"scope and bytes, never a request to author either");
	const end=read(),offer=end.adoptions?.find(a=>a.rollout && a.decision?.status==="answered");assert.ok(offer?.rollout && offer.assembly);
	assert.equal(now.inspect({run},"owner").qualified,offer.assembly);assert.equal(signed(j.check).receipt?.components?.entry.exit,1);
	assert.equal(git(f.root,"diff","--name-only",j.commit,offer.assembly).split("\n").sort().join(),[value,rule].sort().join());
});

test("writer-drafted uncertain launch accepts only its late original binding after reload",async t=>{
	const {f,owner,open,read,j,original}=await stopped(t,false,{reader:94,area:true});owner.close();f.owner.close();
	/** @type {import("./author.mjs").Ticket|undefined} */ let issued;
	const edition=process.env.FOUNDRY_DRAFT_RED?original:createRuntime;
	let starts=0,reads=0,forms=0,finished=false,resumes=0;
	const lost=open(edition,{draftAgent:async ticket=>{starts++;issued=ticket;throw Error("No launch confirmation");}});
	lost.sessionStart("owner",f.root);lost.turn("owner");await lost.flush();assert.equal(starts,1,"claim the source before the lost native response");
	assert.ok(issued);lost.close();const t0=issued,id="original-author";
	/** @type {import("./author.mjs").Packet|undefined} */ let originalPacket;
	const now=open(edition,{formIdle:async()=>true,draftAgent:async()=>{starts++;throw Error("replayed original");},
		confirmProposal:async()=>{forms++;return true;},resumeScout:async()=>{resumes++;throw Error("A user pause must stand");},draftState:async observed=>{
			reads++;assert.equal(observed,id);
			if(!finished)return {runId:observed,status:"paused",pauseInfo:{type:"user"}};
			const p=originalPacket;assert.ok(p);const row=p.files.find(f=>f.file===value);assert.ok(row);
			return {runId:observed,status:"completed",result:{subject:p.subject,edits:[{file:value,before:row.before,text:"ready\n"}],reason:"Finish the original proposal."}};
		}});
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();assert.equal(starts,1);assert.equal(reads,0);
	await assert.rejects(now.draftPacket({...t0,dispatch:"foreign"},"owner",id),{code:"wrong_workflow"});
	originalPacket=await now.draftPacket(t0,"owner",id);
	await assert.rejects(now.draftPacket(t0,"owner","replacement-author"),{code:"wrong_workflow"});
	now.turn("owner");await now.flush();
	assert.equal(read().correctionDrafts?.[0].parts[0].state,"issued","a paused original is not a final answer");
	assert.equal(forms,0);const previousReads=reads;assert.ok(previousReads>0);finished=true;
	now.turn("owner");await now.flush();now.turn("owner");await now.flush();
	assert.ok(now.inspect({run,detail:"proof"},"owner").qualification);assert.equal(reads,previousReads+1);assert.equal(forms,1);assert.equal(starts,1);assert.equal(resumes,0);
	assert.equal(read().correctionDrafts?.[0].parts[0].workflow,id);assert.ok(read().effects.find(e=>e.id===j.check)?.receipt);
});

for(const lost of [false,true])test(`an author's start acknowledgment before packet delivery / ${lost?"previous issuer lost the ID":"reload retains the ID"}`,async t=>{
	const {f,owner,open,read,j,signed}=await stopped(t,false,{reader:94,area:true});owner.close();f.owner.close();
	const id="original-admission",failure=signed(j.check);
	/** @type {import("./author.mjs").Ticket|undefined} */ let ticket;
	let starts=0,forms=0,reads=0;
	const first=open(lost?await historicalRuntime(t,95):createRuntime,{draftAgent:async t=>{starts++;ticket=t;return {runId:id,status:"running",workflowName:"foundry-draft"};}});
	first.sessionStart("owner",f.root);first.turn("owner");await first.flush();first.close();
	const issued=read().correctionDrafts?.at(-1)?.parts[0];
	assert.ok(ticket && issued?.dispatch===ticket.dispatch);
	assert.equal(issued.workflow,lost?undefined:id,"only an actually retained acknowledgment survives the old issuer");
	assert.equal(issued.awaitingPacket,lost?undefined:true);
	/** @type {import("./author.mjs").Packet|undefined} */ let packet;
	const restored=open(createRuntime,{formIdle:async()=>true,draftAgent:async()=>assert.fail("No replacement launch"),
		confirmProposal:async()=>{forms++;return true;},draftState:async workflow=>{
			assert.equal(workflow,id);reads++;
			const row=packet?.files.find(f=>f.file===value);
			if(!row)return {runId:id,status:"running"};
			return {runId:id,status:"completed",result:{subject:packet?.subject,reason:"Produce the promised value.",edits:[{file:value,before:row.before,text:"ready\n"}]}};
		}});
	restored.sessionStart("owner",f.root);restored.turn("owner");await restored.flush();
	assert.equal(forms,0);assert.equal(reads>0,!lost);assert.equal(read().join?.check,j.check);
	if(!lost)await assert.rejects(restored.draftPacket(ticket,"owner","other-admission"),{code:"wrong_workflow"});
	packet=await restored.draftPacket(ticket,"owner",id);
	restored.turn("owner");await restored.flush();restored.turn("owner");await restored.flush();
	assert.ok(restored.inspect({run,detail:"proof"},"owner").qualification);
	assert.deepEqual(signed(j.check),failure);assert.equal(starts,1);assert.equal(forms,1);
});

test("ordinary writer reference bytes cannot stand in for a bound proposal or external owner import",async t=>{
	const {f,owner,read,j,offer,target}=await stopped(t,false,{reader:94,area:true});
	const external=await offer(owner,j,edit(value,"draft","ready")),r=structuredClone(read()),db=openDatabase(f.root);t.after(()=>db.close());
	const preflight=()=>patchPlan(f.root,r,"owner",target,c=>db.verifySigned(run,c),j.check,external.args.blob);
	assert.equal(preflight().offer.assembly,external.candidate);
	const ref=r.artifacts?.at(-1);assert.ok(ref);
	ref.publisher=r.nodes.entry.worker??assert.fail();ref.assembly=j.commit;
	assert.throws(preflight,{code:"patch_selection"},"same blob, base, assembly and destination are still not a proposal writer binding");
});

for(const interruption of ["permission","operator pause","provider disconnect"])test(`recover the same correction author before its first result / ${interruption}`,async t=>{
	const {f,owner,open,read,j,signed}=await stopped(t,false,{reader:94,area:true});owner.close();f.owner.close();
	const native="first-author";let starts=0,resumes=0,permitted=true;
	/** @type {import("./author.mjs").Ticket|undefined} */ let ticket;
	const paused=()=>({runId:native,workflowName:"foundry-draft",status:interruption==="provider disconnect"?"halted":"paused",
		...(interruption==="provider disconnect"?{failure:{type:"workflow_provider_disconnected"}}:{pauseInfo:{type:"checkpoint",key:`permission:${ticket?.dispatch}`}})});
	/** @type {ReturnType<typeof createRuntime>} */ const issuer=open(createRuntime,{permissionBlocker:async()=>permitted?null:{scope:"session",message:"Permission withheld"},
		draftAgent:async t=>{
			starts++;ticket=t;
			if(interruption==="operator pause")await issuer.operation("pause",{run},"owner");
			if(interruption==="permission")permitted=false;
			if(interruption==="provider disconnect")await issuer.draftPacket(t,"owner",native);
			else await assert.rejects(issuer.draftPacket(t,"owner",native),{code:"draft_wait"});
			return paused();
		}});
	issuer.turn("owner");await issuer.flush();const row=read().correctionDrafts?.[0].parts[0];
	assert.equal(row?.state,"issued");assert.equal(row?.workflow,native,"the original author is identifiable even when no packet can be disclosed");assert.ok(ticket);
	if(interruption!=="operator pause")assert.ok(issuer.inspect({run},"owner").recovery.some(a=>a.kind==="author" && a.source===j.check && a.disposition==="wait"));
	issuer.close();permitted=true;
	/** @type {ReturnType<typeof createRuntime>} */ const restored=open(createRuntime,{formIdle:async()=>true,confirmProposal:async()=>true,
		draftAgent:async()=>assert.fail("Do not launch another writer"),draftState:async()=>paused(),resumeScout:async id=>{
			assert.equal(id,native);resumes++;
			const p=await restored.draftPacket(ticket??assert.fail(),"owner",id),row=p.files.find(f=>f.file===value);assert.ok(row);
			return {runId:id,workflowName:"foundry-draft",status:"completed",result:{subject:p.subject,reason:"Complete the original report.",edits:[{file:value,before:row.before,text:"ready\n"}]}};
		}});
	if(interruption==="operator pause"){
		restored.turn("owner");await restored.flush();assert.equal(resumes,0);
		await restored.operation("resume",{source,run},"owner");
	}
	restored.turn("owner");await restored.flush();restored.turn("owner");await restored.flush();
	assert.equal(starts,1);assert.equal(resumes,1);assert.equal(signed(j.check).receipt?.components?.entry.exit,1);
	assert.ok(restored.inspect({run,detail:"proof"},"owner").qualification);
});

test("a positively ended author that never took a packet releases its slot without silently launching another",async t=>{
	const {f,owner,open,read,j}=await stopped(t,false,{reader:94,area:true});owner.close();f.owner.close();
	let starts=0;const native="never-started-author";
	/** @type {ReturnType<typeof createRuntime>} */ const first=open(createRuntime,{draftAgent:async()=>{
		starts++;await first.operation("pause",{run},"owner");
		return {runId:native,workflowName:"foundry-draft",status:"error",error:"The workflow could not enter its body"};
	}});
	first.turn("owner");await first.flush();const part=read().correctionDrafts?.[0].parts[0];
	assert.equal(part?.state,"held","the exact terminal response must not leave an unbound author occupying a slot");
	assert.equal(part?.workflow,native);assert.equal(part.changes,undefined);first.close();
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(createRuntime,{formIdle:async()=>true,confirmProposal:async()=>true,draftAgent:async t=>{
		starts++;const id="selected",p=await now.draftPacket(t,"owner",id),b=p.files.find(f=>f.file===value);assert.ok(b);
		return {runId:id,status:"completed",result:{subject:p.subject,reason:"Finish the approved file.",edits:[{file:value,before:b.before,text:"ready\n"}]}};
	}});
	await now.operation("resume",{run,source},"owner");await now.flush();assert.equal(starts,1);
	await now.operation("draft",{run,check:j.check,files:[value]},"owner");await now.flush();
	assert.equal(starts,2);assert.ok(now.inspect({run,detail:"proof"},"owner").qualification);
});

for(const joined of [false,true])test(`writer-drafted correction on an already stopped ${joined?"rollout join":"standalone rollout"}`,async t=>{
	const {f,owner,open,read,j,offer,signed,original}=await stopped(t,false,{reader:94,goal:joined?undefined:'rule==="measured"'});
	const counter=JSON.stringify(join(dirname(f.root),"previous-report"));
	const first=await offer(owner,j,joined?edit(value,"draft","ready")+add(hook,["#!/bin/sh","set -eu",
		`if test -f ${counter} && cmp -s ${counter} ${value}; then echo joined; else echo standalone; fi > "$1/scope"`,`cp ${value} ${counter}`],true):
		edit(space,"previous wording","measure totals")+edit(rule,"release","measured"));
	await owner.operation("rollout",first.args,"owner");await owner.flush();
	const saved=read(),failure=joined?signed(saved.join?.check??assert.fail()):saved.effects.findLast(c=>c.kind==="component" && c.rollout && c.receipt?.exit===1);
	assert.ok(failure?.commit===first.candidate);owner.close();f.owner.close();let calls=0,decisions=0;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(process.env.FOUNDRY_DRAFT_RED?original:createRuntime,{formIdle:async()=>true,
		draftAgent:async ticket=>{
			calls++;const id="next-author",p=await now.draftPacket(ticket,"owner",id);
			assert.equal(p.assembly,first.candidate);assert.equal(p.check,failure.id);assert.ok(p.source.producer && p.source.producer!=="owner");
			const row=p.files.find(f=>f.file===value);assert.ok(row);
			return {runId:id,status:"completed",result:{subject:ticket.subject,reason:"Complete the previously withheld report.",
				edits:[{file:value,before:row.before,text:joined?"settled\n":"ready\n"}]}};
		},confirmProposal:async()=>{decisions++;return true;}});
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();now.turn("owner");await now.flush();
	assert.equal(calls,1,"the saved rollout boundary must reach a writer without an owner making another diff");
	const q=now.inspect({run,detail:"proof"},"owner").qualification;assert.ok(q,JSON.stringify(now.inspect({run},"owner").correctionDrafts));
	assert.equal(decisions,1);assert.deepEqual(read().artifacts,saved.artifacts);assert.deepEqual(signed(failure.id),failure);
	assert.equal(git(f.root,"show",`${q.commit}:${value}`),joined?"settled":"ready");assert.equal(q.receipts.goal.exit,0);
});

test("writer-drafted distinct bytes recover an already failed standalone owned correction",async t=>{
	const {f,owner,open,read,j,offer,signed,original}=await stopped(t,false,{reader:94,area:true,check:observe+'if(entry!=="ready")process.exit(1);'});
	const first=await offer(owner,j,edit(value,"draft","almost"));await owner.operation("owned",{run,check:j.check,blob:first.args.blob},"owner");await owner.flush();
	const saved=read(),prior=saved.effects.findLast(c=>c.kind==="component" && c.replacement && c.receipt?.exit===1);assert.ok(prior);
	owner.close();f.owner.close();let authors=0,decisions=0;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(process.env.FOUNDRY_DRAFT_RED?original:createRuntime,{formIdle:async()=>true,
		draftAgent:async ticket=>{
			authors++;const id="next-owned-author",p=await now.draftPacket(ticket,"owner",id);
			assert.equal(p.previous?.check,prior.id);assert.equal(p.previous?.files.find(f=>f.file===value)?.text,"almost\n");
			const row=p.files.find(f=>f.file===value);assert.ok(row);
			return {runId:id,status:"completed",result:{subject:ticket.subject,reason:"Use the required ready record.",edits:[{file:value,before:row.before,text:"ready\n"}]}};
		},confirmProposal:async()=>{decisions++;return true;}});
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();
	assert.equal(authors,1,"the negative replacement must reach one fresh, bounded author without an owner patch");
	assert.equal(decisions,1);assert.ok(now.inspect({run,detail:"proof"},"owner").qualification);
	assert.deepEqual(signed(prior.id),prior);assert.deepEqual(read().artifacts,saved.artifacts);
});

for(const detector of ["check","review","declined scope","declined bytes","unavailable","uncited","stale scope","uncertain author"])test(`repair the same unpadded output / ${detector}`,async t=>{
	const task=requirement+" Consumers must receive the token without leading spaces.",finding=`${value}:1: remove the leading space; a raw consumer rejects it.`;
	const check=observe+`if(entry==="draft"${detector==="check"?` || readFileSync(${JSON.stringify(value)},"utf8").startsWith(" ")`:""}){console.error("The raw token is invalid.");process.exit(1);}`;
	const {f,owner,original,open,j,offer,read,signed,target,packets}=await stopped(t,false,{area:true,task,check,goal:'rule==="verified"',sourceEdition:process.env.FOUNDRY_FINDING_BEFORE});
	const change=await offer(owner,j,edit(value,"draft"," ready")+edit(rule,"release","verified"));owner.close();
	const reviewer=scriptedInspections(f.root);
	const seed=open(original,{...reviewer,inspectionState:async w=>{
		const r=await reviewer.inspectionState(w);return {...r,result:{...r.result,outcome:detector==="unavailable"?"unavailable":"changes",
			summary:detector==="uncited"?`${rule}:1: change the evaluator instead.`:finding}};
	}});
	await seed.operation("rollout",change.args,"owner");await seed.flush();seed.close();f.owner.close();
	const stoppedRun=read(),member=stoppedRun.effects.find(e=>e.kind==="component" && e.rollout && e.commit===change.candidate);
	assert.ok(member?.kind==="component");const stop=signed(member.id),review=stoppedRun.inspections?.find(i=>i.component===member.id);
	assert.equal(stop.receipt?.exit,detector==="check"?1:0);assert.equal(review?.state,detector==="check"?undefined:detector==="unavailable"?"unavailable":"changes");
	const before=git(f.root,"rev-parse",`${change.candidate}:${value}`),clock=recoveryClock(),events=/** @type {string[]} */([]);let idle=false;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(createRuntime,{watchRecovery:clock.watch,formIdle:async()=>idle,
		draftAgent:async ticket=>{
			events.push("author");if(detector==="uncertain author")throw Error("Lost author start");
			const workflow="bound-author",p=await now.draftPacket(ticket,"owner",workflow);
			assert.equal(p.check,member.id);assert.equal(p.source.grain,"entry");assert.equal(p.task,task);
			assert.equal(p.source.producer,stoppedRun.nodes.entry.worker);
			if(review){const body=JSON.stringify(p);for(const v of [review.id,review.workflow,finding])assert.ok(v && body.includes(v));}
			const f=p.files.find(f=>f.file===value);assert.ok(f && f.before===before && f.text===" ready\n");
			return {runId:workflow,status:"completed",result:{subject:ticket.subject,reason:"Supply the raw token.",edits:[{file:value,before,text:"ready\n"}]}};
		},confirmProposal:async prompt=>{
			const d=read().correctionDrafts?.at(-1);assert.ok(d);
			if(!d.blob){
				events.push("scope");assert.equal(d.automatic,false);assert.deepEqual(d.parts.flatMap(p=>p.files.map(f=>f.file)),[value]);
				for(const v of [value,before,member.id])assert.ok(prompt.includes(v));
				if(detector==="review")await assert.rejects(now.operation("draft",{run,check:member.id,files:[value]},"participant"),{code:"foreign_run"});
				if(detector==="stale scope")git(f.root,"commit","--allow-empty","-qm","Move approval target");
				return detector!=="declined scope";
			}
			events.push("bytes");assert.ok(prompt.includes(d.blob));return detector!=="declined bytes";
		}});
	now.sessionStart("owner",f.root);if(detector!=="check"){await clock.pulse(now,3);assert.deepEqual(events,[]);}
	idle=true;await clock.pulse(now,8);
	const end=read(),expected=detector==="check"?["author","bytes"]:detector==="unavailable" || detector==="uncited"?[]:
		detector==="declined scope" || detector==="stale scope"?["scope"]:detector==="uncertain author"?["scope","author"]:["scope","author","bytes"];
	assert.deepEqual(events,expected);assert.deepEqual(signed(member.id),stop);
	assert.deepEqual(end.inspections?.find(i=>i.component===member.id),review);assert.deepEqual(end.artifacts,stoppedRun.artifacts);
	const q=now.inspect({run,detail:"proof"},"owner").qualification;
	if(detector==="check" || detector==="review"){
		assert.ok(q);assert.equal(q.target.commit,target);assert.equal(rawGit(f.root,["show",`${q.commit}:${value}`]).toString(),"ready\n");
		const fresh=end.effects.slice(stoppedRun.effects.length).filter(e=>e.tool==="bash");
		assert.deepEqual(fresh.map(e=>e.kind),["component","product","goal"]);for(const e of fresh)assert.equal(signed(e.id).receipt?.exit,0);
		assert.ok(end.inspections?.some(i=>i.component===fresh[0].id && i.state==="approved"));
		assert.ok(packets.get(fresh[0].id)?.includes(task),"the bound replacement reviewer receives the product requirement, not just the diff instruction");
	}else{assert.equal(q,null);assert.deepEqual(end.effects,stoppedRun.effects);assert.deepEqual(end.nodes,stoppedRun.nodes);}
	await clock.pulse(now,4);assert.deepEqual(events,expected);
});

test("writer-drafted implementation-only follow-up keeps both evaluator pins unchanged",async t=>{
	const {owner,open,read,j,target,original}=await stopped(t,false,{reader:94,area:true,check:observe+'if(entry!=="ready")process.exit(1);'});
	owner.close();const notes=dir+"/notes.txt";let calls=0,decisions=0;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(process.env.FOUNDRY_DRAFT_RED?original:createRuntime,{formIdle:async()=>true,
		draftAgent:async ticket=>{
			const id=`production-only-${++calls}`,p=await now.draftPacket(ticket,"owner",id),row=p.files.find(f=>f.file===value);assert.ok(row);
			const edits=[{file:value,before:row.before,text:calls===1?"almost\n":"ready\n"}];
			if(calls===1)edits.push({file:notes,before:null,text:"Keep these notes.\n"});
			return {runId:id,status:"completed",result:{subject:ticket.subject,reason:"Keep the approved notes and complete the report.",edits}};
		},confirmProposal:async()=>{decisions++;return true;}});
	const pins=read().repins;await now.operation("draft",{run,check:j.check,files:[value,notes]},"owner");await now.flush();
	assert.equal(calls,2);assert.equal(decisions,3);
	const proof=now.inspect({run,detail:"proof"},"owner").qualification;assert.ok(proof,"a production-only follow-up must not invent an empty evaluator repin");
	assert.deepEqual(read().repins,pins);assert.equal(proof.receipts.product.evaluatorRevision,target);assert.equal(proof.receipts.goal.evaluatorRevision,target);
});

for(const accept of [true,false])test(`normal wake reconciles the third owner-offered harness patch / ${accept?"accept":"decline"}`,async t=>{
	const obsolete=dir+"/obsolete observer.txt";
	const {f,owner,open,j,offer,read,signed}=await stopped(t,false,{reader:90,files:{[obsolete]:"duplicate reader\n"}});
	const first=await offer(owner,j,edit(space,"previous wording","first")+edit(rule,"release","first"));
	await owner.operation("rollout",first.args,"owner");await owner.flush();
	const stop=()=>read().effects.findLast(c=>c.kind==="component" && c.rollout && c.receipt?.exit===1)??assert.fail();
	const c1=stop(),next=await offer(owner,{...j,commit:first.candidate,check:c1.id},edit(space,"first","second")+edit(rule,"first","second"));
	await owner.operation("rollout",next.args,"owner");await owner.flush();const c2=stop();assert.notEqual(c1.id,c2.id);
	const delta=edit(value,"draft","ready")+edit(rule,"second","release")+`--- a/${obsolete}\n+++ /dev/null\n@@ -1 +0,0 @@\n-duplicate reader\n`;
	const final=await offer(owner,{...j,commit:next.candidate,check:c2.id},delta);
	await assert.rejects(owner.operation("rollout",final.args,"owner"));const before=read();owner.close();
	let decisions=0;const now=open(createRuntime,{formIdle:async()=>true,confirmProposal:async message=>{
		decisions++;assert.ok(message.includes(c2.id) && message.includes(final.args.blob) && message.includes(`deleted file mode 100644`));return accept;
	}});
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();now.turn("owner");await now.flush();
	assert.equal(decisions,1,"a normal owner wake must discover the exact pending full-index diff without a grant command");
	for(const e of before.effects.filter(e=>e.receipt))assert.deepEqual(signed(e.id),e);
	if(accept){
		assert.equal(now.inspect({run},"owner").qualified,final.candidate);
		assert.equal(git(f.root,"ls-tree",final.candidate,"--",obsolete),"");
		const r=read().adoptions?.find(a=>a.rollout?.blob===final.args.blob)?.rollout;
		assert.ok(r?.followup && !r.followup.recipe && r.followup.check===c2.id);
	}else{assert.deepEqual(read().effects,before.effects);assert.equal(now.inspect({run},"owner").qualified,null);}
});

test("a full-index patch published during a healthy rollout waits for the original call, not for a failure",async t=>{
	const {f,owner,j,open,offer,read,signed}=await stopped(t,false,{reader:90});owner.close();
	let inFlight=false,completed=false,dialogs=0,changed="",during="";
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(createRuntime,{formIdle:async()=>true,confirmProposal:async()=>{
		if(++dialogs===2)assert.ok(completed,"never interrupt an issued check or invent a stop");return true;
	},execute:async(tool,args,key)=>{
		const checked=read().effects.find(e=>e.id===String(args.shellId).slice(8));
		if(tool==="bash" && !inFlight && checked?.kind==="component" && checked.rollout && checked.commit){
			inFlight=true;during=checked.id;
			const pending=await offer(now,{...j,commit:checked.commit,check:checked.id},edit(space,"previous wording","shared correction")+edit(rule,"hold","release"));changed=pending.candidate;
			assert.equal(dialogs,1);assert.equal(read().effects.find(e=>e.id===checked.id)?.receipt,undefined);
			const result=await f.execute(tool,args,key);completed=true;return result;
		}return f.execute(tool,args,key);
	}});
	await offer(now,j,edit(value,"draft","ready")+edit(rule,"release","hold"));await now.flush();now.turn("owner");await now.flush();
	assert.equal(dialogs,2);assert.equal(signed(during).receipt?.exit,0);
	assert.equal(now.inspect({run},"owner").qualified,changed);
});

test("two eligible historical harness offers never choose or approve one another",async t=>{
	const {f,owner,j,open,offer,read}=await stopped(t,false,{reader:90});
	const a=await offer(owner,j,edit(value,"draft","ready")+edit(format,"plain","one"));
	const b=await offer(owner,j,edit(value,"draft","ready")+edit(format,"plain","two"));owner.close();
	let forms=0;/** @type {ReturnType<typeof createRuntime>} */ const now=open(createRuntime,{formIdle:async()=>true,confirmProposal:async()=>{
		forms++;now.turn("owner");await new Promise(resolve=>setImmediate(resolve));return true;
	}});
	const before=read();now.sessionStart("owner",f.root);now.turn("owner");await now.flush();const s=now.inspect({run},"owner");
	assert.ok(s.blocker?.includes(a.args.blob) && s.blocker.includes(b.args.blob));assert.equal(forms,0);
	assert.deepEqual(read().effects,before.effects);await now.operation("rollout",b.args,"owner");await now.flush();
	assert.equal(forms,1);assert.equal(now.inspect({run},"owner").qualified,b.candidate);
});

for(const kind of ["owned","rollout"])test(`the approved ${kind} change depends on its inputs, not an unrelated reference delivery`,async t=>{
	const {f,owner,open,read,j,offer,signed,original}=await stopped(t,false,{reader:95,area:true});
	const change=await offer(owner,j,edit(value,"draft","ready")+(kind==="rollout"?edit(format,"plain","detailed"):""));
	owner.close();
	const args=kind==="owned"?{run,check:j.check,blob:change.args.blob}:change.args;
	/** @type {ReturnType<typeof createRuntime>} */ const oldOwner=open(original,{formIdle:async()=>false,confirmProposal:async()=>{
		put(f.root,"historical-note","Reference from another writer.");await oldOwner.operation("publish",{run,file:"historical-note",to:[dir]},"owner");return true;
	}});
	await assert.rejects(oldOwner.operation(kind,args,"owner"),{code:"stale_pin"});const ended=read();
	assert.equal(ended.join?.check,j.check);assert.ok(!ended.adoptions?.at(-1)?.decision || ended.adoptions.at(-1)?.decision?.status==="unavailable");oldOwner.close();
	let asked=0;
	/** @type {ReturnType<typeof createRuntime>} */ const current=open(createRuntime,{formIdle:async()=>false,confirmProposal:async prompt=>{
		asked++;assert.ok(prompt.includes(change.args.blob));put(f.root,"reading.txt","An unrelated observation; not a patch.");
		await current.operation("publish",{run,file:"reading.txt",to:[dir]},"owner");return true;
	}});
	const old=signed(j.check);
	await current.operation(kind,args,"owner");await current.flush();
	assert.equal(asked,1);assert.deepEqual(signed(j.check),old);
	assert.equal(current.inspect({run,detail:"proof"},"owner").qualification?.commit,change.candidate);
	assert.ok(read().artifacts?.some(a=>a.file==="reading.txt"));
});

for(const kind of ["owned","rollout"])test(`restore the explicitly selected ${kind} bytes on the same native question, not their competitor`,async t=>{
	const {f,owner,open,read,j,offer}=await stopped(t,false,{reader:95,area:true});
	const create=(/** @type {string} */ detail)=>edit(value,"draft","ready")+
		(kind==="owned"?edit(space,"previous wording",detail):edit(format,"plain",detail));
	const first=await offer(owner,j,create("one")),selected=await offer(owner,j,create("two"));owner.close();
	const signal=new EventEmitter(),openForm=once(signal,"open"),oldAnswer=once(signal,"answer");
	const issuer=open(createRuntime,{formIdle:async()=>false,confirmProposal:async()=>{signal.emit("open");await oldAnswer;return true;}});
	const args=kind==="owned"?{run,check:j.check,blob:selected.args.blob}:selected.args;
	const waiting=issuer.operation(kind,args,"owner").catch(()=>{});await openForm;issuer.close();
	let forms=0;const clock=recoveryClock(),restored=open(createRuntime,{watchRecovery:clock.watch,formIdle:async()=>true,formVacant:async()=>true,confirmProposal:async m=>{
		forms++;assert.ok(m.includes(selected.args.blob));assert.ok(!m.includes(first.args.blob));return true;
	}});
	restored.sessionStart("owner",f.root);await clock.pulse(restored,6);signal.emit("answer");await waiting;
	assert.equal(forms,1);assert.equal(restored.inspect({run},"owner").qualified,selected.candidate);
	assert.ok(!read().adoptions?.some(a=>(a.patch??a.rollout)?.blob===first.args.blob && a.decision?.status==="answered"));
});

for(const scenario of ["joined component","unobserved joined component","standalone rollout","genuine product failure"])test(`saved ${scenario} test recovers on its exact assembly`,async t=>{
	const standalone=scenario==="standalone rollout",defect=scenario==="genuine product failure",unobserved=scenario==="unobserved joined component";
	const control=`#!/usr/bin/env node
const {readFileSync,writeFileSync}=require("node:fs"),cwd=process.argv[3],f=require("node:path").join(cwd,${JSON.stringify(value)}),before=readFileSync(f);
if(process.env.FOUNDRY_GRAIN!=="entry" || process.env.FOUNDRY_DIRECTORY!==${JSON.stringify(dir)})process.exit(2);
${standalone?'if(readFileSync(process.env.FOUNDRY_PREPARED_DIR+"/ready","utf8")!=="prepared")process.exit(2);':""}
try{writeFileSync(f,JSON.stringify({count:process.argv[2]==="good"?3:4}));const r=require("node:child_process").spawnSync(process.execPath,[${JSON.stringify(component)}],{cwd});
if(r.status!==0 && r.status!==1)process.exitCode=2;else{console.log(JSON.stringify({assertion:"count",matched:r.status===0}));process.exitCode=r.status;}}
finally{writeFileSync(f,before);}`;
	const body='import {readFileSync} from "node:fs";const row=JSON.parse(readFileSync('+JSON.stringify(value)+'));'+(unobserved?'if(row.live && row.previous===undefined)process.exit(2);':'')+'process.exit(row.previous===3?0:1);';
	const fixed=body.replaceAll("row.previous","row.count");
	const {f,owner,open,j,read,offer,forms,signed}=await stopped(t,false,{control,check:body,total:unobserved?'{"count":3,"live":true}':defect?'{"count":4}':'{"count":3}',goal:defect?'JSON.parse(entry).count===3':'rule==="measured"',area:defect,unobserved,...(unobserved && {reader:90})});
	let assembly=j.commit;
	if(standalone){
		const next=await offer(owner,j,edit(rule,"release","measured")+edit(space,"previous wording","whole units")+add(hook,["#!/bin/sh",'printf prepared > "$1/ready"'],true));
		await owner.operation("rollout",next.args,"owner");await owner.flush();assembly=next.candidate;
	}
	const before=read(),old=before.effects.findLast(e=>e.commit===assembly && (standalone?e.kind==="component" && e.receipt?.exit===1:e.id===j.check));assert.ok(old);
	owner.close();const count=forms.length;
	/** @type {ReturnType<typeof createRuntime>} */ const now=open(createRuntime,{repairAgent:async(phase,p,ticket)=>{
		await now.mechanicPacket(ticket,"owner",phase);
		return {id:phase,subject:p.subject,reason:"Measure the count, keeping the unit and comparison.",...(phase==="author"?{change:fixed}:{approved:true})};
	}});
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();
	const end=read(),repair=end.testRepairs?.find(r=>r.stop===old.id);assert.ok(repair,"no test diagnosis on the original signed stop");assert.equal(repair.state,"applied",repair.reason??"no reviewed repair");
	assert.equal(signed(old.id).receipt?.exit,standalone?1:null);assert.equal(forms.length,count);
	if(defect){
		const failed=end.join;assert.ok(failed);assert.equal(signed(failed.check).receipt?.components?.entry.exit,1);
		assert.equal(now.inspect({run},"owner").qualified,null);
		const correction=await offer(now,failed,edit(value,'{"count":4}','{"count":3}'));
		await now.flush();
		if(!read().adoptions?.some(a=>a.patch?.blob===correction.args.blob && a.decision?.status==="answered"))await now.operation("owned",{run,check:failed.check,blob:correction.args.blob},"owner");
		await now.flush();
		assert.equal(now.inspect({run},"owner").qualified,correction.candidate,"the real implementation fix must pass the certified observer");
		assert.equal(read().testRepairs?.length,1);return;
	}
	const checkpoint=end.products.at(-1);assert.equal(checkpoint?.commit,assembly);
	const result=signed(checkpoint?.check??assert.fail());assert.equal(replacementBlob(result.receipt?.components?.entry),repair.blob);
	if(standalone){
		const {qualification:proof,qualificationUnavailable}=now.inspect({run,detail:"proof"},"owner");assert.ok(proof,qualificationUnavailable??"Missing portable proof");
		const dest=recipient(f.root,proof,"recipient","all"),joined=proof.receipts.product.components?.entry;assert.ok(joined);
		for(const [name,observation] of /** @type {const} */ ([["component:entry",proof.outputs[0].receipt],["joined:entry",joined]])){
			assert.equal(observation.inputs.checker.blob,repair.blob);assert.ok(observation.inputs.prepared);
			const steps=launchPlan(dest,name);assert.deepEqual(steps.map(s=>s.kind),["verify","prepare","verify","copy-prepared","verify","check","verify"]);
			assert.notEqual(launchStep(steps[3]).status,0,"an unbuilt empty tree cannot be supplied");
			put(steps[1].argv[0],"ready","different");assert.match(launchStep(steps[3]).stderr,/does not match/);
			const result=await observed(dest,name);
			assert.equal(result.status,0,result.stderr);
		}
		assert.deepEqual(launchPlan(dest,"release").filter(s=>s.kind==="check").map(s=>s.role),["joined:entry","product","goal"]);
	}
});

test("fixed contracts never reach a rollout form; the reviewer gets the frozen specification for a spaced-path change",async t=>{
	const {open,owner,read,j,offer,forms,packets,consent,signed}=await stopped(t,true);
	const base=edit(value,"draft","ready"),unsafe=await offer(owner,j,base+edit(spec,requirement,"Changed requirement."));
	if(legacy){
		consent(false);await assert.rejects(owner.operation("rollout",unsafe.args,"owner"),{code:"approval_declined"});
		assert.ok(read().adoptions?.some(a=>a.rollout?.blob===unsafe.args.blob && a.decision?.status==="dismissed"));
	}
	const delta=base+edit(rule,"release","hold")+edit(space,"previous wording","approved wording")+add(`${dir}/unit notes.txt`,["Whole units."]);
	const valid=await offer(owner,j,delta);assert.ok(valid.full.includes(`--- a/${space}\t\n+++ b/${space}\t\n`));
	if(legacy)await assert.rejects(owner.operation("rollout",valid.args,"owner"),{code:"invalid_patch"});
	owner.close();consent(true);const now=open(createRuntime),before=read(),count=forms.length;
	for(const proposal of [unsafe,await offer(now,j,base+edit(boundary,"One total per line.","Another unit."))])
		await assert.rejects(now.operation("rollout",proposal.args,"owner"),{code:"patch_scope"});
	const invalid=await offer(now,j,delta,full=>full.replace(`+++ b/${space}\t\n`,`+++ b/${space}\t2020-01-01\n`));
	await assert.rejects(now.operation("rollout",invalid.args,"owner"),{code:"invalid_patch"});
	assert.equal(forms.length,count);assert.deepEqual(read().effects,before.effects);
	await now.operation("rollout",valid.args,"owner");await now.flush();
	const end=read(),c=signed(end.nodes.entry.check??assert.fail()),review=end.inspections?.find(i=>i.component===c.id);
	assert.ok(review?.state==="approved" && review.specification===spec && review.base===j.commit);
	assert.ok(packets.get(c.id)?.includes(requirement));assert.ok(packets.get(c.id)?.includes("approved wording"));
	const tampered=structuredClone(end);delete tampered.inspections?.find(i=>i.id===review.id)?.specification;
	assert.throws(()=>decode(tampered),{code:"corrupt_run"});
	assert.equal(end.products.at(-1)?.commit,valid.candidate);
});

test("Git's canonical quoted create and edit headers bind the same paths, blobs and modes as the manifest",async t=>{
	const quoted=dir+'/release notes "final".txt',other=dir+'/units "v2".txt';
	const {f,owner,j,offer,forms,read}=await stopped(t,false,{files:{[other]:"Draft units.\n"}}),copy=join(dirname(f.root),"quoted-preview");
	git(f.root,"worktree","add","-q","--detach",copy,j.commit);
	put(copy,value,"ready\n");put(copy,rule,"hold\n");put(copy,quoted,"Release note.\n");put(copy,other,"Final units.\n");
	git(copy,"add","--",value,rule,quoted,other);
	const first=await offer(owner,j,git(copy,"diff","--cached","--full-index",j.commit)+"\n");
	const encoded=JSON.stringify(`b/${quoted}`),section=first.full.slice(first.full.indexOf(`diff --git ${JSON.stringify("a/"+quoted)}`)).split("\ndiff --git ")[0];
	const editHeader=first.full.slice(first.full.indexOf(`diff --git ${JSON.stringify("a/"+other)}`)).split("\n");
	const index=editHeader[1];assert.match(index,/^index [a-f0-9]+\.\.[a-f0-9]+ 100644$/);
	assert.ok(editHeader[2].startsWith(`--- ${JSON.stringify("a/"+other)}`) && editHeader[3].startsWith(`+++ ${JSON.stringify("b/"+other)}`));
	const count=forms.length;
	for(const alter of [
		/** @param {string} full */ full=>full.replace(`+++ ${encoded}`,`+++ ${JSON.stringify("b/"+other)}`),
		/** @param {string} full */ full=>full.replace(`+++ ${encoded}`,`+++ ${encoded}\t2020-01-01`),
		/** @param {string} full */ full=>full.replace(index,index.replace(/^index [a-f0-9]+/,"index "+"1".repeat(j.commit.length))),
		/** @param {string} full */ full=>full.replace(index,index.replace("100644","100755")),
		/** @param {string} full */ full=>full+section+"\n",
	]){
		const selected=await offer(owner,j,first.full,alter);
		await assert.rejects(owner.operation("rollout",selected.args,"owner"),{code:"invalid_patch"});
	}
	assert.equal(forms.length,count);await owner.operation("rollout",first.args,"owner");await owner.flush();
	assert.equal(read().products.at(-1)?.commit,first.candidate);
	assert.equal(git(f.root,"show",first.candidate+":"+other),"Final units.");
	assert.equal(git(f.root,"show",first.candidate+":"+quoted),"Release note.");
});

test("a legacy contract edit is read-only without holding a healthy run of the same owner",{skip:!legacy},async t=>{
	const {f,owner,original,open,j,offer,read,signed}=await stopped(t,true);
	const unsafe=await offer(owner,j,edit(value,"draft","ready")+edit(boundary,"One total per line.","Use a different unit."));
	owner.close();const old=f.runtime(f.root,{confirmProposal:async()=>true},original);
	await old.operation("rollout",unsafe.args,"owner");await old.flush();
	const proof=old.inspect({run,detail:"proof"},"owner");assert.equal(proof.qualified,unsafe.candidate);
	const other="another",file=".foundry/another.json",check=".foundry/another.mjs",marker=join(dirname(f.root),"observation");
	const policy=JSON.parse(git(f.root,"show",`HEAD:${source}`));
	put(f.root,file,JSON.stringify({...policy,id:other,goalCheck:check}));put(f.root,check,`import {existsSync} from "node:fs";process.exit(existsSync(${JSON.stringify(marker)})?0:2);`);
	git(f.root,"add",file,check);git(f.root,"commit","-qm","Separate report");
	await old.operation("start",{source:file},"owner");await old.flush();
	assert.equal(old.inspect({run:other},"owner").goal?.receipt?.exit,2);old.close();
	const db=openDatabase(f.root);t.after(()=>db.close());
	const before=read();db.verifySigned(run,signed(before.goal?.check??assert.fail()));
	const stamp=db.stamp(run),updated=open(createRuntime);
	updated.sessionStart("owner",f.root);updated.turn("owner");await updated.flush();
	const held=updated.inspect({run,detail:"proof"},"owner");
	assert.equal(held.qualified,null);assert.equal(held.qualification,null);assert.equal(held.handoff,null);
	assert.match(held.blocker??"",/conserved fixed specification or boundary.*read-only/);
	assert.deepEqual(held.goalChecks,proof.goalChecks);assert.deepEqual(held.products,proof.products);
	assert.deepEqual(held.targetProposals,proof.targetProposals);
	for(const op of ["pause","resume"])await assert.rejects(updated.operation(op,op==="resume"?{run,source}:{run},"owner"),{code:"contract_hold"});
	assert.throws(()=>db.planAndSwap(run,()=>assert.fail()),{code:"contract_hold"});
	assert.throws(()=>db.mutateLocked(run,()=>assert.fail()),{code:"contract_hold"});
	put(dirname(f.root),"observation","available");const target=git(f.root,"rev-parse","HEAD");
	await updated.operation("resume",{run:other,source:file},"owner");await updated.flush();
	assert.equal(updated.inspect({run:other,detail:"proof"},"owner").qualification?.commit,target);
	assert.equal(db.stamp(run),stamp);assert.deepEqual(read(),before);
});

for(const outcome of ["goal-holds","goal-passes","product-holds","before-handoff","equivalent"])
test(`old signed passes after a rollout: ${outcome}`,{skip:!legacy},async t=>{
	const rejectProduct=outcome==="product-holds",rejectGoal=outcome==="goal-holds" || outcome==="before-handoff";
	const {f,owner,original,read,j,offer,signed,target}=await stopped(t,true,{
		goal:`hold==="go"${rejectGoal?' && rule==="hold"':""}`,
		...(rejectProduct && {product:'if(entry==="ready" && format==="plain")process.exit(1);'}),
	});
	const patch=await offer(owner,j,edit(value,"draft","ready")+edit(rule,"release","hold")+
		(rejectProduct?edit(format,"plain","detailed"):"")+add(hold,["wait"]));
	await owner.operation("rollout",patch.args,"owner");await owner.flush();
	const rolled=signed(read().goal?.check??assert.fail()),h=rolled.evaluatorRevision;assert.ok(h && rolled.receipt?.exit===2);
	if(rejectProduct){
		const plain=stagePatch(f.root,h,h,edit(format,"detailed","plain"));
		await owner.operation("repin",{run,kind:"product",from:h,revision:plain,files:[format]},"owner");await owner.flush();
		const product=signed(read().products.at(-1)?.check??assert.fail());
		assert.equal(product.evaluatorRevision,plain);assert.equal(JSON.parse(product.receipt?.output??"").format,"detailed");
	}
	const revert=!rejectProduct && outcome!=="equivalent";
	const revision=stagePatch(f.root,h,h,(revert?edit(rule,"hold","release"):"")+edit(hold,"wait","go"));
	owner.close();
	const old=f.runtime(f.root,{confirm:async()=>true,mode:async()=>{
		const r=read(),finished=r.products.at(-1)?.qualifiedAt || outcome==="before-handoff" && r.effects.find(e=>e.id===r.goal?.check)?.receipt?.exit===0;
		return finished?"plan":"interactive";
	}},original);
	await old.operation("repin",{run,from:h,revision,files:revert?[rule,hold]:[hold]},"owner");await old.flush();old.close();
	const before=read(),p=before.products.at(-1),g=signed(before.goal?.check??assert.fail());
	assert.ok(p && p.commit===patch.candidate);assert.equal(g.evaluatorRevision,revision);
	assert.equal(g.receipt?.exit,0);assert.equal(JSON.parse(g.receipt.output).rule,"hold");assert.equal(g.receipt.overlay,undefined);
	assert.equal(!!p.qualifiedAt,outcome!=="before-handoff");
	assert.equal(before.active,outcome==="before-handoff");
	assert.ok(!p.qualifiedAt || before.effects.some(e=>e.kind==="handoff" && e.token===p.check && !e.callId));
	/** @type {string[]} */ const notices=[];
	const now=f.runtime(f.root,{notify:async msg=>{notices.push(msg);return "notification";}},createRuntime);
	const status=()=>now.inspect({run,detail:"proof"},"owner");
	if(outcome==="equivalent"){
		assert.equal(status().qualification?.commit,patch.candidate);
		await now.operation("resume",{run,source},"owner");assert.deepEqual(read().effects,before.effects);
		now.sessionStart("owner",f.root);now.turn("owner");await now.flush();
		assert.equal(notices.length,1);assert.equal(read().effects.length,before.effects.length);return;
	}
	now.sessionStart("owner",f.root);now.turn("owner");await now.flush();
	const held=status();
	assert.equal(notices.length,0);assert.equal(held.qualified,null);assert.equal(held.handoff,null);assert.equal(held.qualification,null);
	assert.equal(held.metrics?.qualified.commit,null);assert.equal(now.inspect({run,detail:"cleanup"},"owner").handoff,null);
	assert.match(held.blocker??"",/Handoff withheld/);assert.equal(held.release?.reason,"unproven-handoff");assert.deepEqual(read().effects,before.effects);
	if(outcome==="goal-holds"){
		const nested=openDatabase(join(f.root,".foundry"));t.after(()=>nested.close());
		assert.equal(qualifiedProduct(nested.read(run)??assert.fail()),undefined,"pathspecs must still inspect the repository's evaluator files");
	}
	const denied=f.runtime(f.root,{permissionBlocker:async()=>({scope:"session",message:"no native checks"})},createRuntime);
	await assert.rejects(denied.operation("resume",{run,source},"owner"),{code:"permissions_unready"});denied.close();
	await assert.rejects(now.operation("resume",{run,source},"stranger"),{code:"run_conflict"});
	git(f.root,"update-ref","refs/heads/main",f.tip,target);
	await assert.rejects(now.operation("resume",{run,source},"owner"),{code:"stale_pin"});
	git(f.root,"update-ref","refs/heads/main",target,f.tip);
	assert.deepEqual(read().effects,before.effects);
	await now.operation("resume",{run,source},"owner");await now.flush();
	const after=read(),oldProduct=after.products.find(x=>x.check===p.check),w=oldProduct?.withdrawnHandoff;assert.ok(w);
	assert.equal(w.goal,g.id);assert.equal(w.qualifiedAt,p.qualifiedAt);assert.equal(oldProduct.qualifiedAt,undefined);
	assert.deepEqual(after.effects.slice(0,before.effects.length),before.effects);assert.deepEqual(after.inspections,before.inspections);
	assert.deepEqual(after.nodes,before.nodes);assert.deepEqual(after.productRepins,before.productRepins);assert.deepEqual(after.repins,before.repins);
	assert.equal(git(f.root,"rev-parse","HEAD"),target);
	const fresh=signed(w.recheck);
	assert.equal(fresh.commit,p.commit);assert.equal(fresh.evaluatorRevision,signed(p.check).evaluatorRevision);
	assert.match(observedOverlay(fresh.receipt)??"",/^[a-f0-9]{64}$/);
	assert.deepEqual(after.effects.slice(before.effects.length).filter(e=>e.kind==="product").map(e=>e.id),[fresh.id]);
	if(rejectProduct){
		assert.equal(fresh.receipt?.exit,1);assert.equal(JSON.parse(fresh.receipt.output).format,"plain");
		assert.equal(after.goal?.check,g.id);assert.equal(after.join?.check,fresh.id);assert.equal(status().qualified,null);
		assert.equal(status().release?.reason,"handoff-recheck-held");
		await now.operation("resume",{run,source},"owner");await now.flush();assert.deepEqual(read().effects,after.effects);
	}else{
		assert.equal(fresh.receipt?.exit,0);assert.equal(fresh.receipt.components?.entry.exit,0);
		const freshGoal=signed(after.goal?.check??assert.fail());assert.notEqual(freshGoal.id,g.id);
		assert.equal(freshGoal.evaluatorRevision,g.evaluatorRevision);assert.equal(freshGoal.commit,p.commit);
		assert.equal(JSON.parse(freshGoal.receipt?.output??"").rule,"release");
		assert.match(observedOverlay(freshGoal.receipt)??"",/^[a-f0-9]{64}$/);assert.equal(freshGoal.receipt?.exit,rejectGoal?2:0);
		assert.equal(status().qualification?.commit??null,rejectGoal?null:p.commit);
		now.turn("owner");await now.flush();assert.deepEqual(read().effects,after.effects);
	}
	assert.equal(notices.length,outcome==="goal-passes"?1:0);
	assert.deepEqual(signed(g.id),g);
});

for(const issued of [false,true])test(`upgrade a fixed review without a specification / ${issued?"already issued":"never issued"}`,{skip:!legacy},async t=>{
	const {f,owner,original,open,j,offer,read,signed,packets}=await stopped(t,true);
	const a=await offer(owner,j,edit(value,"draft","ready")+edit(rule,"release","hold"));owner.close();
	const old=f.runtime(f.root,{confirmProposal:async()=>true,startInspection:issued?async()=>({runId:"original-review",status:"running"}):undefined,
		inspectionState:async()=>({runId:"original-review",status:"running"})},original);
	await old.operation("rollout",a.args,"owner");await old.flush();
	const before=read(),i=before.inspections?.at(-1);
	assert.ok(i && !i.specification && i.candidate===a.candidate && i.state===(issued?"issued":"ready"));
	const c=signed(i.component);old.close();const now=open(createRuntime);now.turn("owner");await f.settle();await now.flush();
	const end=read(),review=end.inspections?.find(r=>r.id===i.id);
	if(issued){
		assert.match(end.conflict??"",/was issued without the frozen specification/);
		assert.deepEqual(end.inspections,before.inspections);assert.deepEqual(end.effects,before.effects);assert.deepEqual(end.join,j);
	}else{
		assert.equal(review?.state,"approved");
		assert.ok(review?.component===c.id && packets.get(c.id)?.includes(requirement));
		assert.deepEqual(signed(c.id),c);assert.equal(end.products.at(-1)?.commit,a.candidate);
	}
});

test("goal and product repins execute approved reversions and removals on the same rolled product without ambient permission",async t=>{
	const sourceEdition=process.env.FOUNDRY_VERIFICATION_BEFORE;
	const {f,owner,open,original,j,offer,read,signed,target}=await stopped(t,true,{sourceEdition});
	const staged=await offer(owner,j,edit(value,"draft","ready")+edit(rule,"release","hold")+edit(format,"plain","detailed")+add(hold,["pending"]));
	await owner.operation("rollout",staged.args,"owner");await owner.flush();
	const rolled=read(),first=signed(rolled.goal?.check??assert.fail()),h=first.evaluatorRevision;assert.ok(h && first.commit===staged.candidate);
	assert.deepEqual(JSON.parse(first.receipt?.output??""),{entry:"ready",rule:"hold",hold:"pending",format:"detailed",foreground:"absent"});
	const revert=stagePatch(f.root,h,h,edit(rule,"hold","release")+`--- a/${hold}\n+++ /dev/null\n@@ -1 +0,0 @@\n-pending\n`);
	assert.equal(git(f.root,"show",`${target}:${rule}`),git(f.root,"show",`${revert}:${rule}`));
	let from=h;
	if(legacy){
		await owner.operation("repin",{run,from:h,revision:revert,files:[rule,hold]},"owner");await owner.flush();
		const wrong=signed(read().goal?.check??assert.fail());
		assert.equal(wrong.evaluatorRevision,revert);assert.equal(wrong.receipt?.exit,2);
		assert.deepEqual(JSON.parse(wrong.receipt?.output??""),{entry:"ready",rule:"hold",hold:"pending",format:"detailed",foreground:"1"});
		from=revert;
	}
	const saved=read();owner.close();const now=open(sourceEdition?original:createRuntime);
	const plain=stagePatch(f.root,h,h,edit(format,"detailed","plain"));
	await now.operation("repin",{run,kind:"product",from:h,revision:plain,files:[format]},"owner");await now.flush();
	const p=signed(read().products.at(-1)?.check??assert.fail());assert.equal(p.commit,staged.candidate);assert.equal(p.evaluatorRevision,plain);
	assert.deepEqual(JSON.parse(p.receipt?.output??""),{entry:"ready",rule:"hold",hold:"pending",format:"plain",foreground:"absent"});
	if(!legacy){
		await now.operation("repin",{run,from,revision:revert,files:[rule,hold]},"owner");await now.flush();
	}
	// A freshly approved product check also requests a new goal on the *existing* goal pin.
	const final=read(),g=signed(final.goal?.check??assert.fail());
	assert.equal(g.commit,staged.candidate);assert.equal(g.evaluatorRevision,revert);assert.equal(g.productEvaluatorRevision,plain);
	assert.deepEqual(JSON.parse(g.receipt?.output??""),{entry:"ready",rule:"release",hold:"absent",format:"detailed",foreground:"absent"});
	assert.equal(g.receipt?.exit,0);assert.equal(now.inspect({run,detail:"proof"},"owner").qualification?.commit,staged.candidate);
	assert.deepEqual(final.effects.slice(0,saved.effects.length),saved.effects);assert.deepEqual(final.inspections,saved.inspections);
	assert.equal(git(f.root,"show",`${staged.candidate}:${hold}`),"pending");
	const calls=f.checks.slice();
	if(sourceEdition){assert.notEqual(now.inspect({run,detail:"proof"},"owner").qualification?.format,"foundry-qualification/v5");now.close();}
	const current=sourceEdition?open(createRuntime,{execute:async()=>assert.fail("No replay of a historical attempt")}):now;
	const {qualification:proof,qualificationUnavailable}=current.inspect({run,detail:"proof"},"owner");assert.ok(proof,qualificationUnavailable??"Missing portable proof");
	const dest=recipient(f.root,proof);
	assert.deepEqual(proof.receipts.goal.disclosure.overlay.find(e=>e.path===hold),{path:hold,mode:null,blob:null});
	assert.deepEqual(proof.receipts.goal.disclosure.overlay.find(e=>e.path===rule),{path:rule,mode:"100644",blob:git(f.root,"rev-parse",`${revert}:${rule}`)});
	for(const [field,actual] of /** @type {const} */ ([["goal",g],["product",p]])){
		assert.equal(proof.receipts[field].inputEvidence,sourceEdition?"reconstructed":"signed");
		const result=await observed(dest,field);
		assert.deepEqual(JSON.parse(result.stdout),JSON.parse(actual.receipt?.output??""),`The imported ${field} must see the signed inputs (portable exit ${result.status})`);
		assert.equal(result.status,actual.receipt?.exit);
	}
	assert.deepEqual(read().effects,final.effects);assert.deepEqual(f.checks,calls);
});

for(const fixed of [true,false])test(`same signed rollout join gets one exact owned correction / ${fixed?"qualifies":"remains stopped"}`,async t=>{
	const {f,owner,open,original,j,offer,read,signed,forms,consent,packets,target}=await stopped(t,true);
	const counter=JSON.stringify(join(dirname(f.root),"prepared-entry"));
	const program=["#!/bin/sh","set -eu",'test -z "${REVIEW_ALLOW_FOREGROUND-}"',`if test -f ${counter} && cmp -s ${counter} ${value}; then echo joined; else echo standalone; fi > "$1/scope"`,`cp ${value} ${counter}`];
	const first=await offer(owner,j,edit(value,"draft","ready")+add(hook,program,true));await owner.operation("rollout",first.args,"owner");await owner.flush();
	const held=read(),current=held.join;assert.ok(current && current.commit===first.candidate);
	const failed=signed(current.check),standalone=signed(held.nodes.entry.check??assert.fail()),h=failed.evaluatorRevision;
	assert.ok(h && h!==target && standalone.receipt?.exit===0 && held.inspections?.some(i=>i.component===standalone.id && i.state==="approved"));
	assert.equal(failed.receipt?.components?.entry.exit,1);
	const publisher=f.runtime(f.root,{},original);
	const fix=await offer(publisher,current,edit(value,"ready",fixed?"settled":"again")),args={run,check:failed.id,blob:fix.args.blob};
	publisher.turn("owner");await publisher.flush();publisher.close();
	if(legacy)await assert.rejects(owner.operation("owned",args,"owner"),{code:"stale_pin"});
	owner.close();const now=open(createRuntime,{formIdle:async()=>true}),n=forms.length;
	await assert.rejects(now.operation("owned",{...args,check:standalone.id},"owner"),{code:"stale_pin"});
	await assert.rejects(now.operation("rollout",fix.args,"owner"),{code:"stale_pin"});
	assert.equal(forms.length,n);
	consent(false);
	// Reopening the owner uses the ordinary proposal path, including a previously cached negative preflight.
	now.turn("owner");await now.flush();
	assert.ok(forms.at(-1)?.includes(failed.id) && forms.at(-1)?.includes(h));
	assert.equal(read().adoptions?.find(a=>a.patch?.blob===args.blob)?.decision?.status,"dismissed");
	assert.deepEqual(read().effects,held.effects);assert.deepEqual(read().join,current);
	consent(true);await now.operation("owned",args,"owner");await now.flush();
	const end=read(),replacement=signed(end.nodes.entry.check??assert.fail()),i=end.inspections?.find(i=>i.component===replacement.id);
	assert.ok(replacement.replacement && replacement.id!==standalone.id && replacement.receipt?.exit===0 && i?.state==="approved" && i.specification===spec);
	assert.ok(packets.get(replacement.id)?.includes(requirement));assert.equal(end.nodes.entry.review,held.nodes.entry.review);
	assert.deepEqual(end.effects.slice(0,held.effects.length),held.effects);assert.deepEqual(end.inspections?.slice(0,held.inspections?.length),held.inspections);
	const step=end.productRepins?.at(-1)?.amendments?.at(-1);assert.ok(step);assert.deepEqual(step.prior,current);
	const joined=signed(step.recheck);assert.equal(joined.evaluatorRevision,h);assert.equal(joined.commit,fix.candidate);
	assert.equal(joined.receipt?.components?.entry.exit,fixed?0:1);
	if(fixed){
		const g=signed(end.goal?.check??assert.fail());assert.equal(g.evaluatorRevision,h);assert.equal(g.receipt?.exit,0);
		assert.equal(now.inspect({run,detail:"proof"},"owner").qualification?.commit,fix.candidate);
	}else{
		assert.ok(end.join);const next=await offer(now,end.join,edit(value,"again","settled"));
		await assert.rejects(now.operation("owned",{run,check:joined.id,blob:next.args.blob},"owner"),{code:"not_recoverable"});
		assert.deepEqual(read().join,end.join);assert.deepEqual(read().products,held.products);
		assert.equal(now.inspect({run,detail:"proof"},"owner").qualification,null);
	}
});

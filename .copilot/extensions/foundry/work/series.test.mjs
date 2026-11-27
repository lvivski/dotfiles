import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { factory, git, put, recoveryClock, scriptedInspections } from "../test/fixture.mjs";
import { guideReplay, launchDescription, recipient } from "../test/portable.mjs";
import { checksum, openDatabase } from "./database.mjs";
import { digest } from "./values.mjs";
import { stagePatch } from "./product.mjs";

/** @typedef {import("./model.js").NativeCall} Check */
/** @param {import("node:test").TestContext} t @param {boolean|"both"} nonpassing @param {boolean} [unchanged] @param {boolean} [dependent] @param {boolean} [reverse] */
async function stopped(t,nonpassing,unchanged=false,dependent=false,reverse=false){
	const run="index",source=".foundry/index.json",unit=".foundry/component.mjs",goal=".foundry/goal.mjs",product=".foundry/product.mjs",ids=["left","right"],included=unchanged?[...ids,"middle"]:ids;
	const f=factory(t,run,source,{[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Publish both entries.",goalCheck:goal,productCheck:product,
		squads:[{id:"entries",areas:["entries"],charter:".foundry/brief",checks:[unit]}]}),
		".foundry/brief":"Publish both entries.",".foundry/index/journey.md":"Read both entries.",
		[unit]:"",[product]:"",[goal]:`import {existsSync,readFileSync} from "node:fs";const files=${JSON.stringify(included)}.map(id=>"entries/"+id+"/value");
			process.exit(!files.some(f=>existsSync(f))?1:files.every(f=>existsSync(f) && readFileSync(f,"utf8")==="correct\\n")?0:2);`});
	const h=dirname(f.root),trace=join(h,"checks"),build=join(h,"builds"),keys=join(h,"keys");
	const contents=(/** @type {string} */ file)=>existsSync(file)?readFileSync(file,"utf8"):"";
	const env={...process.env,TMPDIR:h,FOUNDRY_TEST_KEYS:keys,FOUNDRY_TEST_SERIES_TRACE:trace,FOUNDRY_TEST_SERIES_BUILD:build,
		NODE_OPTIONS:`--import=${new URL("../test/key-trace.mjs",import.meta.url).href} --import=${new URL("../test/claim-imports.mjs",import.meta.url).href}`};
	const shell=(/** @type {Check} */ e)=>spawnSync("/bin/sh",["-c",String(e.args.command)],{cwd:f.root,env,encoding:"utf8"});
	await f.start();await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	await f.scouts[0].report({outcome:"regenerate",reason:"Entries are missing.",evidence:[".foundry/brief"],
		grains:(reverse?included.toReversed():included).map(id=>({id,directory:"entries/"+id,needs:dependent && id==="right"?["left"]:[],check:unit,task:"Publish the "+id+" entry."}))});
	const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	for(const id of included){
		const n=read().nodes[id],w=f.workers.get(n.worker??"");assert.ok(w);
		put(w.cwd,`entries/${id}/value`,id==="middle"?"correct\n":"draft\n");await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
	}
	f.owner.turn("owner");await f.owner.flush();await f.settle();
	const before=read(),p=before.products.at(-1);assert.ok(p && before.goal);
	assert.ok(!before.join && !before.blocker && before.goal.commit===p.commit && Object.keys(p.outputs).length===included.length &&
		!before.effects.some(e=>["issued","uncertain"].includes(e.state)),
		JSON.stringify({join:before.join,blocker:before.blocker,outputs:p.outputs,goal:before.goal,calls:before.effects.map(e=>[e.kind,e.grain,e.state,e.receipt?.exit])}));
	put(f.root,unit,`import {appendFileSync,readFileSync} from "node:fs";const id=process.env.FOUNDRY_GRAIN;
		if(process.env.FOUNDRY_TEST_SERIES_TRACE)appendFileSync(process.env.FOUNDRY_TEST_SERIES_TRACE,id+"\\n");
		if(readFileSync("entries/"+id+"/value","utf8")!=="correct\\n")process.exit(1);`);
	git(f.root,"add",unit);git(f.root,"commit","-qm","Apply both entry checks to the target");
	const target=git(f.root,"rev-parse","HEAD"),adopter=f.runtime(f.root,{confirm:async()=>true,formIdle:async()=>false});
	await adopter.operation("repin",{run,kind:"target",from:f.tip,revision:target,checkpoint:p.check,goal:before.goal.check,files:[unit],acceptance:"Require both entries at the checked target."},"owner");
	const failure=read().join;assert.ok(failure);const original=read().effects.find(e=>e.id===failure.check);
	assert.ok(original?.tool==="bash" && original.receipt?.components?.[reverse?"right":"left"]?.exit===1);
	db.verifySigned(run,original);
	const diff=ids.map(id=>{const file=`entries/${id}/value`;return `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-draft\n+${nonpassing==="both" || nonpassing && id==="left"?"almost":"correct"}\n`;}).join("")+
		`diff --git a/.foundry/prepare-components b/.foundry/prepare-components\nnew file mode 100755\n--- /dev/null\n+++ b/.foundry/prepare-components\n@@ -0,0 +1,2 @@\n+#!/usr/bin/env node\n+const fs=require("node:fs");if(process.env.FOUNDRY_TEST_SERIES_BUILD)fs.appendFileSync(process.env.FOUNDRY_TEST_SERIES_BUILD,"prepared\\n");fs.writeFileSync(process.argv[2]+"/index","ready");\n`;
	const assembly=stagePatch(f.root,failure.commit,target,diff);
	put(f.root,"entries.diff",git(f.root,"diff","--full-index",failure.commit,assembly)+"\n");
	const published=await adopter.operation("publish",{run,file:"entries.diff",to:ids.map(id=>"entries/"+id)},"owner");
	const blob=published.artifacts.at(-1)?.blob;assert.ok(blob);adopter.close();f.owner.close();
	return {run,f,read,db,ids,assembly,shell,original,trace:()=>contents(trace),builds:()=>contents(build),keys:()=>contents(keys).trim().split("\n").filter(Boolean),
		args:{run,check:failure.check,assembly:failure.commit,blob}};
}

test("a two-owner correction carries an unaffected signed output through the joined check without rebinding it",async t=>{
	const o=await stopped(t,false,true),before=o.read(),middle=before.nodes.middle;
	const owner=o.f.runtime(o.f.root,{formIdle:async()=>false,confirmProposal:async()=>true,...scriptedInspections(o.f.root)});
	await owner.operation("rollout",o.args,"owner");owner.turn("owner");await owner.flush();
	const end=o.read(),product=end.products.at(-1),joined=end.effects.find(c=>c.id===product?.check);
	assert.ok(product?.qualifiedAt && joined?.kind==="product" && joined.receipt?.components?.middle.exit===0);
	assert.equal(product.outputs.middle,middle.candidate);assert.equal(end.nodes.middle.check,middle.check);
	assert.equal(end.nodes.middle.worker,middle.worker);assert.deepEqual(end.effects.find(e=>e.id===middle.check),before.effects.find(e=>e.id===middle.check));
	assert.deepEqual(end.effects.filter(e=>e.kind==="component" && e.commit===o.assembly).map(c=>c.grain),o.ids);
	o.db.verifySigned(o.run,joined);
});

test("a replacement review sees its own original inline assignment alongside the rollout instruction",async t=>{
	const o=await stopped(t,false),{f,run}=o,clock=recoveryClock(),script=scriptedInspections(f.root);
	const packets=new Map(),start=script.startInspection;
	const owner=f.runtime(f.root,{...script,watchRecovery:clock.watch,formIdle:async()=>false,confirmProposal:async()=>true,
		startInspection:async(...args)=>{
			const flow=await start(...args),packet=await owner.inspectionPacket(...args,flow.runId);
			packets.set(packet.component,packet.prompt);return flow;
		}});
	await owner.operation("rollout",o.args,"owner");await clock.pulse(owner,3);
	const end=o.read();
	for(const id of o.ids){
		const c=end.effects.find(e=>e.kind==="component" && e.grain===id && e.commit===o.assembly),i=end.inspections?.find(i=>i.component===c?.id);
		assert.ok(c?.id && i?.state==="approved");const prompt=packets.get(c.id);
		assert.ok(prompt?.includes(`Publish the ${id} entry.`),`The ${id} reviewer never saw the original task`);
		assert.ok(prompt.includes(i.task));assert.ok(!prompt.includes(`Publish the ${id==="left"?"right":"left"} entry.`));
	}
	assert.ok(end.products.at(-1)?.qualifiedAt);assert.equal(packets.size,2);
});

test("a scoped correction composes each owner's returned bytes before one independent byte decision",async t=>{
	const o=await stopped(t,"both"),{f,run}=o,clock=recoveryClock();
	const first=f.runtime(f.root,{formIdle:async()=>false,confirmProposal:async()=>true});
	await first.operation("rollout",o.args,"owner");await first.flush();first.close();
	const before=o.read(),[failed,unused]=before.effects.filter(e=>e.kind==="component" && e.commit===o.assembly);
	assert.ok(failed?.kind==="component" && failed.receipt?.exit===1 && unused?.state==="ready" && !unused.callId);o.db.verifySigned(run,failed);
	const paths=o.ids.map(id=>`entries/${id}/value`),sources=new Set(),forms=[];
	const owner=f.runtime(f.root,{watchRecovery:clock.watch,formIdle:async()=>false,confirmProposal:async prompt=>{
		assert.ok(prompt.includes(failed.id));forms.push(prompt);return true;
	},draftAgent:async ticket=>{
		const workflow="author-"+ticket.subject,packet=await owner.draftPacket(ticket,"owner",workflow),id=String(packet.source.grain);
		assert.ok(o.ids.includes(id) && !sources.has(id));sources.add(id);
		assert.equal(packet.source.producer,before.nodes[id].worker);assert.equal(packet.source.component,before.nodes[id].check);
		assert.equal(packet.files.length,1);const [file]=packet.files;assert.equal(file.file,`entries/${id}/value`);assert.equal(file.text,"almost\n");
		return {runId:workflow,status:"completed",workflowName:"foundry-draft",result:{subject:ticket.subject,reason:"Finish my entry.",
			edits:[{file:file.file,before:file.before,text:"correct\n"}]}};
	}});
	const request={run,check:failed.id,files:paths};
	await assert.rejects(owner.operation("draft",request,"not-owner"),{code:"foreign_run"});assert.equal(forms.length,0);
	await owner.operation("draft",request,"owner");await clock.pulse(owner,3);
	const drafted=o.read(),d=drafted.correctionDrafts?.at(-1);assert.ok(d?.decision?.status==="answered" && d.decision.answer===d.id && d.blob);
	assert.deepEqual(sources,new Set(o.ids));assert.equal(forms.length,1);assert.deepEqual(drafted.effects,before.effects);
	assert.equal(d.parts.length,2);assert.equal(new Set(d.parts.map(p=>p.workflow)).size,2);
	await owner.operation("rollout",{run,check:failed.id,assembly:o.assembly,blob:d.blob},"owner");await clock.pulse(owner,4);
	const end=o.read(),offer=end.adoptions?.at(-1),joined=end.products.at(-1);
	assert.ok(offer?.decision?.status==="answered" && offer.decision.answer===d.blob && joined?.qualifiedAt && end.goal?.commit===joined.commit);
	assert.equal(forms.length,2);assert.deepEqual(end.correctionDrafts,drafted.correctionDrafts);assert.deepEqual(end.artifacts,before.artifacts);
	assert.deepEqual(end.effects.find(e=>e.id===failed.id),failed);const suffix=end.effects.find(e=>e.id===unused.id);assert.ok(suffix?.state==="withdrawn" && !suffix.callId);
	for(const file of paths)assert.equal(git(f.root,"show",`${joined.commit}:${file}`),"correct");
});

test("a finding on a passing member requires separately offered and approved bytes, not a failing verdict",async t=>{
	const o=await stopped(t,false),{f,run}=o,transport=scriptedInspections(f.root),clock=recoveryClock(),file="entries/right/note",finding="Include the required note.";
	let forms=0;const workflows=new Map();
	const owner=f.runtime(f.root,{...transport,watchRecovery:clock.watch,formIdle:async()=>false,confirmProposal:async()=>{forms++;return true;},
		startInspection:async(...args)=>{const reply=await transport.startInspection(...args);workflows.set(reply.runId,args[1]);return reply;},
		inspectionState:async id=>{
			const reply=await transport.inspectionState(id),i=o.read().inspections?.find(i=>i.id===workflows.get(id));
			return i?.grain==="right" && i.candidate===o.assembly?{...reply,result:{...reply.result,outcome:"changes",summary:finding}}:reply;
		}});
	await owner.operation("rollout",o.args,"owner");await clock.pulse(owner,3);
	const at=o.read(),members=at.effects.filter(e=>e.kind==="component" && e.commit===o.assembly),[left,right]=members;
	const i=at.inspections?.find(i=>i.component===right.id);assert.ok(i?.state==="changes" && i.summary===finding);
	assert.equal(left.receipt?.exit,0);assert.equal(right.receipt?.exit,0);assert.equal(forms,1);
	const status=owner.inspect({run},"owner");assert.deepEqual(status.harnessRollout?.checks.map(c=>c.id),members.map(c=>c.id));
	assert.match(status.harnessRollout?.checks[1].reason??"",/separately authorized correction/);assert.equal(status.qualified,null);
	const candidate=stagePatch(f.root,o.assembly,at.join?.target??assert.fail(),`--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+checked\n`);
	put(f.root,"follow.diff",git(f.root,"diff","--no-renames","--full-index",o.assembly,candidate)+"\n");
	const sent=await owner.operation("publish",{run,file:"follow.diff",to:["entries/right"]},"owner"),blob=sent.artifacts.at(-1)?.blob;assert.ok(blob);
	await owner.operation("rollout",{run,assembly:o.assembly,check:right.id,blob},"owner");await clock.pulse(owner,3);
	const end=o.read();assert.equal(forms,2);assert.equal(owner.inspect({run},"owner").qualified,candidate);
	assert.deepEqual(end.inspections?.find(r=>r.id===i.id),i);assert.deepEqual(end.effects.find(c=>c.id===right.id),right);
	assert.equal(end.adoptions?.at(-1)?.rollout?.followup?.observation,0);assert.equal(end.correctionDrafts?.length??0,0);
});

for(const [dependent,reverse] of [[true,false],[true,true],[false,false]])test(dependent?
	`an admitted review dependency obtains the original review / ${reverse?"consumer":"producer"} listed first`:
	"independent members do not wait for each other's outstanding review",async t=>{
	const o=await stopped(t,false,false,dependent,reverse),{run,f}=o,reviewed=dependent && process.env.FOUNDRY_TEST_SEQUENCE==="reviewed";
	const transport=scriptedInspections(f.root),clock=recoveryClock(),starts=new Map();
	/** @type {string[]} */ const calls=[];
	let released=false,forms=0;
	const owner=f.runtime(f.root,{watchRecovery:clock.watch,...transport,formIdle:async()=>false,confirmProposal:async()=>{forms++;return true;},
		startInspection:async(...args)=>{
			const w=await transport.startInspection(...args),i=o.read().inspections?.find(i=>i.id===args[1]);assert.ok(i);
			starts.set(w.runId,i.grain);return w;
		},
		inspectionState:id=>!released && starts.get(id)==="left"?Promise.resolve({runId:id,status:"running",workflowName:"foundry-inspect"}):transport.inspectionState(id),
		execute:async(tool,args,key)=>{
			if(tool!=="bash")return f.execute(tool,args,key);
			const r=o.read(),c=r.effects.find(e=>e.callId===key);assert.ok(c?.tool==="bash");
			if(reviewed && c.kind==="component" && c.grain==="right"){
				const i=r.inspections?.find(i=>i.grain==="left" && i.candidate===o.assembly);assert.equal(i?.state,"approved");assert.ok(i);
				const raw=new DatabaseSync(o.db.file);
				try{
					const row=raw.prepare("SELECT document FROM runs WHERE id=?").get(run);assert.ok(typeof row?.document==="string");
					const put=(/** @type {string} */ bytes)=>raw.prepare("UPDATE runs SET document=?, checksum=? WHERE id=?").run(bytes,checksum(bytes),run);
					try{
						const doc=JSON.parse(row.document),prior=doc.inspections.find((/** @type {{id:string}} */ p)=>p.id===i.id);
						prior.task="A different task";put(JSON.stringify(doc));const keys=o.keys();
						assert.notEqual(o.shell(c).status,0);assert.deepEqual(o.keys(),keys);
					}finally{put(row.document);}
				}finally{raw.close();}
			}
			calls.push(c.id);const executed=o.shell(c);assert.equal(executed.status,0,executed.stderr);
			return {resultType:"success",textResultForLlm:executed.stdout};
		}});
	await owner.operation("rollout",o.args,"owner");await clock.pulse(owner,2);
	const r=o.read(),checks=r.effects.filter(e=>e.kind==="component" && e.commit===o.assembly);
	const accepted=r.adoptions?.find(a=>a.assembly===o.assembly)?.accepted;assert.ok(accepted?.inputs);
	assert.deepEqual(accepted.inputs.filter(f=>"member" in f),reviewed?[{member:"right",afterReviewOf:"left"}]:[]);
	const [left,right]=o.ids.map(id=>checks.find(e=>e.grain===id)??assert.fail()),order=reverse && !reviewed?[right.id,left.id]:[left.id,right.id];
	assert.ok(left.receipt?.exit===0);const first=r.inspections?.find(i=>i.component===left.id);assert.ok(first?.workflow && first.state==="issued");
	assert.equal(!!right.callId,!reviewed);assert.equal(!!right.runnerClaim,!reviewed);assert.deepEqual(o.keys(),reviewed?[left.id]:order);
	released=true;await clock.pulse(owner,4);
	const final=o.read(),p=final.products.at(-1);assert.ok(p?.qualifiedAt && final.goal?.commit===p.commit);
	assert.deepEqual(calls,[...order,p.check,final.goal.check]);assert.equal(forms,1);assert.equal(starts.size,2);
	assert.equal(final.inspections?.find(i=>i.component===left.id)?.workflow,first.workflow);
});

for(const nonpassing of [true,false])test(`a newly approved two-writer series cannot bypass its ${nonpassing?"nonpassing":"pending"} first check`,async t=>{
	const o=await stopped(t,nonpassing),{f,run}=o;
	const previous=o.read(),old=Object.fromEntries(o.ids.map(id=>[id,previous.nodes[id].check]));
	const cross=process.env.FOUNDRY_TEST_SERIES_SOURCES==="cross",auto=cross && !process.env.FOUNDRY_TEST_SERIES_CALIBRATION;
	/** @type {Check[]} */ const launched=[];let decisions=0,hold=true;
	const owner=f.runtime(f.root,{formIdle:async()=>auto,confirmProposal:async()=>{decisions++;return true;},...scriptedInspections(f.root),
		execute:async(tool,args,call)=>{
			if(tool!=="bash")return f.execute(tool,args,call);
			await owner.pre(tool,args,"owner",call);
			const e=o.read().effects.find(c=>c.args.shellId===args.shellId);assert.ok(e?.tool==="bash");
			launched.push(e);if(hold)return {resultType:"unconfirmed"};
			const r=o.shell(e);assert.equal(r.status,0,r.stderr);return {resultType:"success",textResultForLlm:r.stdout};
		}});
	if(auto){owner.sessionStart("owner",f.root);owner.turn("owner");}
	else await owner.operation("rollout",o.args,"owner");
	await owner.flush();
	const members=()=>o.read().effects.filter(/** @returns {e is Check} */ e=>e.kind==="component" && e.commit===o.assembly);
	const [first,second]=members();assert.ok(first.callId && !first.runnerClaim && !second.callId);
	const repeated=()=>{owner.turn("owner");return owner.flush();};await repeated();assert.deepEqual(launched.map(e=>e.id),[first.id]);
	assert.notEqual(o.shell(second).status,0);assert.deepEqual(o.keys(),[]);assert.equal(o.builds(),"");assert.equal(o.trace(),"");
	assert.deepEqual(o.ids.map(id=>o.read().nodes[id].check),Object.values(old));
	const live=git(f.root,"rev-parse","refs/heads/main");
	git(f.root,"commit","--allow-empty","-qm","Unrelated new target");
	try{assert.notEqual(o.shell(first).status,0,"moved target before claim");assert.deepEqual(o.keys(),[]);}
	finally{git(f.root,"update-ref","refs/heads/main",live,git(f.root,"rev-parse","refs/heads/main"));}
	const raw=new DatabaseSync(o.db.file);t.after(()=>raw.close());
	const doc=raw.prepare("SELECT document FROM runs WHERE id=?").get(run)?.document;assert.ok(typeof doc==="string");
	const write=(/** @type {string} */ str)=>raw.prepare("UPDATE runs SET document=?,checksum=? WHERE id=?").run(str,checksum(str),run);
	for(const kind of ["target","build-group","review"]){
		const text=JSON.parse(doc),c=text.effects.find((/** @type {Check} */ c)=>c.id===first.id),a=c.attempt;
		const n=a.facts.findIndex((/** @type {{kind:string}} */ f)=>f.kind===kind);assert.ok(n>=0);a.facts.splice(n,1);
		c.verification.grant=a.grant=digest(["foundry-power/v3",run,text.owner,text.policy.source,c.check,a.source,a.use,a.facts]);
		try{write(JSON.stringify(text));assert.notEqual(o.shell(first).status,0,"missing "+kind);assert.deepEqual(o.keys(),[]);}finally{write(doc);}
	}
	assert.ok(first.attempt?.version===3);
	const peer=old.right;assert.ok(peer);
	if(cross){
		const spool=new DatabaseSync(o.db.file+".outcomes");t.after(()=>spool.close());
		const row=spool.prepare("SELECT document,signature FROM outcomes WHERE run=? AND effect=?").get(run,peer);
		assert.ok(typeof row?.document==="string" && typeof row.signature==="string");
		spool.prepare("DELETE FROM outcomes WHERE run=? AND effect=?").run(run,peer);
		try{
			assert.notEqual(o.shell(first).status,0,"the peer's missing original row must withhold even the first writer's key");
			assert.deepEqual(o.keys(),[]);assert.equal(o.builds(),"");assert.equal(o.trace(),"");
		}finally{spool.prepare("INSERT INTO outcomes(run,effect,document,signature) VALUES(?,?,?,?)").run(run,peer,row.document,row.signature);}
	}
	assert.equal(first.attempt.facts.some(f=>f.kind==="signed" && f.check===peer),cross);
	const original=o.shell(first);assert.equal(original.status,0,original.stderr);assert.deepEqual(o.keys(),[first.id]);
	hold=false;await repeated();const state=o.read(),[one,two]=members();assert.equal(decisions,1);assert.equal(one.id,first.id);assert.equal(two.id,second.id);
	assert.deepEqual(state.effects.find(e=>e.id===o.original.id),o.original);o.db.verifySigned(run,one);
	if(nonpassing){
		assert.equal(one.receipt?.exit,1);assert.equal(two.callId,undefined);assert.equal(two.runnerClaim,undefined);assert.deepEqual(o.keys(),[first.id]);
		assert.deepEqual(o.ids.map(id=>state.nodes[id].check),Object.values(old));assert.equal(o.trace(),"left\n");assert.equal(owner.inspect({run},"owner").qualified,null);
		owner.close();const clock=recoveryClock();let delivered=0,answers=0;
		const issuer=f.runtime(f.root,{watchRecovery:clock.watch,formIdle:async()=>true,confirmProposal:async prompt=>{
			assert.equal(o.read().effects.filter(e=>e.tool==="bash").length,state.effects.filter(e=>e.tool==="bash").length,"drafting cannot run checks");
			assert.ok(prompt.includes(one.id));answers++;return true;
		},
			draftAgent:async ticket=>{
				const id="left-author",packet=await issuer.draftPacket(ticket,"owner",id);
				assert.deepEqual([packet.check,packet.source.grain,packet.source.component,packet.files.map(row=>row.file)],[one.id,"left",old.left,["entries/left/value"]]);
				const [file]=packet.files;assert.equal(file.text,"almost\n");delivered++;
				return {runId:id,status:"completed",workflowName:"foundry-draft",result:{subject:ticket.subject,reason:"Finish the entry as specified.",
					edits:[{file:file.file,before:file.before,text:"correct\n"}]}};
			}});
		issuer.sessionStart("owner",f.root);await clock.pulse(issuer,4);
		const after=o.read(),joined=after.products.at(-1);assert.ok(joined?.qualifiedAt && after.goal?.commit===joined.commit);
		assert.equal(delivered,1);assert.equal(answers,1);assert.notEqual(joined.commit,one.commit);
		assert.deepEqual(after.effects.find(c=>c.id===one.id),one);assert.equal(after.effects.find(c=>c.id===two.id)?.state,"withdrawn");
		assert.equal(issuer.inspect({run},"owner").qualified,joined.commit);
		return;
	}
	assert.equal(one.receipt?.exit,0);assert.equal(two.receipt?.exit,0);o.db.verifySigned(run,two);
	assert.match(two.receipt?.output??"",new RegExp("reused .* from "+first.id));
	const joined=state.products.at(-1),goal=state.goal;assert.ok(joined?.qualifiedAt && goal);
	assert.deepEqual(o.keys(),[first.id,second.id,joined.check,goal.check]);assert.equal(o.trace(),"left\nright\nleft\nright\n");assert.equal(o.builds(),"prepared\nprepared\n");
	assert.deepEqual(o.ids.map(id=>state.nodes[id].check),[first.id,second.id]);
	for(const id of [first.id,second.id])assert.ok(state.inspections?.some(i=>i.component===id && i.state==="approved" && i.workflow && i.dispatch));
	const proof=owner.inspect({run,detail:"proof"},"owner").qualification;assert.equal(proof?.commit,o.assembly);assert.ok(proof);
	const dest=recipient(f.root,proof,"independent-series"),replay=guideReplay(dest,launchDescription(dest,"release"));assert.equal(replay.status,0,replay.stderr);
	assert.deepEqual(o.keys(),[first.id,second.id,joined.check,goal.check]);assert.equal(decisions,1);
	t.diagnostic(JSON.stringify({series:{tree:git(f.root,"rev-parse",o.assembly+"^{tree}"),roles:launched.map(c=>[c.kind,c.grain??null]),
		outputs:o.ids.map(id=>git(f.root,"show",`${o.assembly}:entries/${id}/value`)),reviews:members().map(c=>state.inspections?.find(i=>i.component===c.id)?.state),
		checks:o.trace(),preparations:o.builds(),observations:[one.receipt?.exit,two.receipt?.exit,proof.receipts.product.exit,proof.receipts.goal.exit],
		decisions,replay:replay.status},extraPrerequisite:cross}));
});

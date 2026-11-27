import assert from "node:assert/strict";
import { openDatabase } from "../work/database.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { factory, git, put } from "./fixture.mjs";
import { historicalFactory, historicalRuntime } from "./legacy-readers.mjs";

export const activation=(/** @type {string} */ canOpen)=>`export function transition(state,event) {
	if (event==="dismiss" && state==="open") return "dismissed";
	if (event==="activate" && (${canOpen})) return "open";
	return state;
}`;
const originalActivation=activation('state==="idle"');

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function mixedGrant(t,mode) {
	const build=mode==="prevent"?factory:await historicalFactory(t,52);
	const run="display", brief=".foundry/display.json", primary="unit/picker", parent="unit/controls", file=`${parent}/entry`;
	const production=mode.startsWith("production "), replacement=mode.startsWith("replacement ") || production, independent=mode.startsWith("independent "), observer=mode.startsWith("observer ") || independent || replacement, negative=mode==="negative pair" || observer, sourceFile=`${primary}/observer`;
	const producer=mode==="production primary" || mode==="production adoption"?"selector":"buttons", scope=producer==="selector"?primary:parent;
	const implementation=`${scope}/activation.mjs`, regression=`${scope}/test.mjs`;
	const diagnosticReader=production?await historicalRuntime(t,60):createRuntime;
	const beforeIndependent=replacement?await historicalRuntime(t,59):independent?await historicalRuntime(t,58):createRuntime;
	const phases=["first keyboard open","dismissal","post-dismissal reopen"];
	const phaseCheck=`const frames=JSON.parse(readFileSync("device/events.json","utf8")),wanted=[true,false,true];
		const sample=readFileSync(${JSON.stringify(sourceFile)},"utf8");
		${production && mode!=="production fail"?`const route=existsSync("${implementation}") && (await import("./${implementation}")).transition;
		const reopened=route && route(route(route("idle","activate"),"dismiss"),"activate")==="open";`:""}
		for (const [i,label] of ${JSON.stringify(phases)}.entries()){
			const observed=${production && mode!=="production fail"?'i===2 && sample==="after-event" && reopened || ':""}frames[i][sample==="after-event"?"after":"before"];
			if(observed!==wanted[i]){console.log(sample==="after-event"?label+": expected "+wanted[i]+" got "+observed:"missing field");process.exit(1);}
		}`;
	const frames=(/** @type {boolean[]} */ values)=>JSON.stringify(values.map((after,i)=>({before:i>0 && values[i-1],after})));
	const loadInputs='const actions=JSON.parse(readFileSync("build.json","utf8"));const data=actions[process.env.FOUNDRY_GRAIN]?.component;';
	const stages=["component","generated","package","runtime"];
	const action=(/** @type {string[]} */ data)=>Object.fromEntries(stages.map(stage=>[stage,stage==="component"?data:[]]));
	const failed=["failed attestation","unchanged pair"].includes(mode) || negative, cited=mode==="restore cited" || failed;
	const pending=cited || mode==="restore pending";
	const first=failed?await historicalRuntime(t,55):createRuntime;
	const stoppedPeer=mode==="production successor";
	const f=build(t,run,brief,{[brief]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Render a selection.",ownership:"exact-files",
		productCheck:"product.mjs",goalCheck:"goal.mjs",squads:[{id:"view",areas:["unit"],charter:"brief",checks:stoppedPeer?["unit.mjs","route.mjs"]:["unit.mjs"]}]}),
		...(stoppedPeer?{"unit/routes/entry":"inactive","route.mjs":`import {readFileSync} from "node:fs";
			if(readFileSync("unit/routes/entry","utf8")!=="active")process.exit(1);
			if(process.env.FOUNDRY_GRAIN==="routes"){console.log("Secondary observation unavailable.");process.exit(251)}`}:{}),
		...(independent?{"build.json":JSON.stringify({alpha:action(["unit/alpha/change"]),buttons:action([file]),selector:action([file,sourceFile]),
			bundle:action(["unit"]),unknown:{runtime:"inputs discovered at runtime"}})}:{}),
		...(replacement?{"device/events.json":frames([true,false,mode==="replacement pass"])}:{}),
		...(mode.endsWith(" adoption")?{"unit/shared/format":"old"}:{}),
		".foundry/display/journey.md":"Select the item.","brief":"Maintain the selector.",[file]:"old","unit.mjs":mode==="restore issued"?
			`import {existsSync} from "node:fs";if(process.env.FOUNDRY_GRAIN==="controls"&&!existsSync("${parent}/fixed"))process.exit(1)`:
			failed?`import {existsSync,readFileSync} from "node:fs";${production?`if(process.env.FOUNDRY_GRAIN==="${producer}" && existsSync("${regression}"))await import("./${regression}");`:""}${independent?`import assert from "node:assert/strict";${loadInputs}if(process.env.FOUNDRY_GRAIN==="alpha")assert.equal(readFileSync(data[0],"utf8"),"alpha");if(process.env.FOUNDRY_GRAIN==="buttons")assert.equal(readFileSync(data[0],"utf8"),"current button");`:""}if(process.env.FOUNDRY_DIRECTORY==="${primary}"&&!process.env.FOUNDRY_FILES){const control=readFileSync(${independent?"data[0]":JSON.stringify(file)},"utf8");console.log("Checked control: "+control);if(control!=="current button")process.exit(1);${replacement?phaseCheck:`if(${observer?`readFileSync(${independent?"data[1]":JSON.stringify(sourceFile)},"utf8")!=="phase-aware" || ${mode==="observer fail" || independent}`:negative})process.exit(1);`}}`:"",
		"product.mjs":`console.log(process.env.FOUNDRY_OWNERSHIP);${mode==="independent fail"?'if(JSON.parse(process.env.FOUNDRY_OUTPUTS).alpha)process.exit(1);':mode==="independent incomplete"?'import {writeFileSync} from "node:fs";if(JSON.parse(process.env.FOUNDRY_OUTPUTS).alpha)writeFileSync("unit/alpha/change","altered");':""}`,
		"goal.mjs":`import {existsSync as has} from "node:fs";${independent?'if(has("unit/alpha/change"))process.exit(0);':""}process.exit(!has("unit/core/result")?1:!has("${primary}/result")?2:!has("${parent}/fixed")?1:${mode==="restore joined"||mode==="owned adoption"?'!has("unit/done/result")?2:0':pending?`!has("${parent}/button")||!has("unit/rail/change")?1:${mode==="production adoption"?2:0}`:0})`});
	const proposal=(/** @type {string} */ id,/** @type {unknown} */ directory,/** @type {string} */ evidence)=>({
		outcome:"regenerate",reason:"Implement missing behavior.",evidence:[evidence],grains:[{id,directory,task:`Implement ${id}`,check:"unit.mjs",needs:[]}]});
	await f.start();await f.scouts[0].report(proposal("core","unit/core","brief"));
	const [core]=f.workers.values();put(core.cwd,"unit/core/result","ready");await f.runtime(core.cwd).operation("submit",{run,token:core.token},core.id);
	const owner=f.runtime(f.root,{confirm:async()=>true}), goal=owner.inspect({run,detail:"proof"},"owner").goalChecks?.at(-1);assert.ok(goal);
	put(f.root,"reference","Connect the selector.");
	const [offer]=(await owner.operation("publish",{run,file:"reference",to:production?[primary,parent]:[primary]},"owner")).artifacts;
	await owner.operation("iterate",{run,receipt:goal.id,blob:offer.blob,question:"Connect the selector.",directory:primary,files:[file],
		source:{commit:goal.commit,file,excerpt:"old"}},"owner");await f.settle();
	await f.scouts.at(-1)?.report(proposal("picker",{primary,files:[file]},file));
	const [,picker]=f.workers.values();put(picker.cwd,`${primary}/result`,"keep");put(picker.cwd,file,"connected");
	if (observer) put(picker.cwd,sourceFile,"aggregate");
	if (producer==="selector") put(picker.cwd,implementation,originalActivation);
	await f.runtime(picker.cwd).operation("submit",{run,token:picker.token},picker.id);await f.settle();
	const before=owner.inspect({run,detail:"proof"},"owner");assert.ok(before.outputs?.picker && before.goal?.receipt?.exit===1);
	const broadPlan=proposal("controls",parent,"brief"), railPlan=proposal("rail","unit/rail","brief").grains[0];
	if (cited) broadPlan.grains.push(railPlan);
	const siblings=failed ? ["alpha","bravo","charlie","delta"] : [];
	for (const id of siblings) broadPlan.grains.push(proposal(id,`unit/${id}`,"brief").grains[0]);
	if (stoppedPeer) broadPlan.grains.push({...proposal("routes","unit/routes","brief").grains[0],check:"route.mjs"});
	await f.scouts.at(-1)?.report(broadPlan);
	const issued=owner.inspect({run,detail:"proof"},"owner");
	return {mode,f,run,primary,parent,file,sourceFile,implementation,regression,producer,phases,frames,loadInputs,stages,first,beforeIndependent,diagnosticReader,production,observer,negative,cited,offer,proposal,before,owner,issued,siblings,railPlan};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function displacedGrant(t,mode) {
	const c=await mixedGrant(t,mode);
	const {issued,f,owner}=c;
	assert.ok(!issued.nodes.some(n=>n.grain==="picker"));const [,,worker]=f.workers.values();assert.ok(worker);
	f.owner.close();owner.close();
	return {...c,worker};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function submittedGrant(t,mode) {
	const c=await displacedGrant(t,mode);
	const {f,run,worker,file,parent}=c;
	const runtime=f.runtime(worker.cwd,{},mode==="issued writer"?createRuntime:undefined);
	put(worker.cwd,file,"new control");put(worker.cwd,`${parent}/fixed`,"available");
	await runtime.operation("submit",{run,token:worker.token},worker.id);
	const proof=f.runtime(f.root,{},mode==="issued writer"?createRuntime:undefined).inspect({run,detail:"proof"},"owner");
	return {...c,proof};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function publishedRetainer(t,mode) {
	const c=await submittedGrant(t,mode);
	const {f,run,primary,parent,file,cited,production,producer,implementation,proposal,railPlan,siblings,first,before,proof}=c;
	await f.settle();
	const review=f.scouts.at(-1);assert.ok(review);
	const citation=`${primary}/result`;
	const plan=proposal("buttons",parent,cited?citation:"brief");if(!cited) plan.grains.push(railPlan);
	await review.report(plan);
	const jobs=f.runtime(f.root).inspect({run},"owner");
	const buttons=f.workers.get(jobs.nodes.find(n=>n.grain==="buttons")?.worker??""), rail=f.workers.get(jobs.nodes.find(n=>n.grain==="rail")?.worker??"");
	assert.ok(buttons && rail);
	put(buttons.cwd,file,mode==="unchanged pair"?"new control":"current button");put(buttons.cwd,`${parent}/fixed`,"available");put(buttons.cwd,`${parent}/button`,"ready");
	if (production && producer==="buttons") put(buttons.cwd,implementation,originalActivation);
	// These submissions precede the *original* affected reader. Do not cross
	// the document fence and then ask reader 54/55/60 to write backwards.
	const preparing=await historicalRuntime(t,95);
	await f.runtime(buttons.cwd,{},preparing).operation("submit",{run,token:buttons.token},buttons.id);
	put(rail.cwd,"unit/rail/change","reordered");await f.runtime(rail.cwd,{},preparing).operation("submit",{run,token:rail.token},rail.id);
	for (const id of siblings) {
		const w=f.workers.get(jobs.nodes.find(n=>n.grain===id)?.worker??"");assert.ok(w);
		put(w.cwd,`unit/${id}/change`,id);await f.runtime(w.cwd,{},preparing).operation("submit",{run,token:w.token},w.id);
	}
	if (mode==="production successor") {
		const writer=f.workers.get(jobs.nodes.find(n=>n.grain==="routes")?.worker??"");assert.ok(writer);
		const runtime=f.runtime(writer.cwd,{},preparing);
		put(writer.cwd,"unit/routes/entry","active");
		const result=await runtime.operation("submit",{run,token:writer.token},writer.id);
		const repair=result.nodes.find(n=>n.grain==="routes"), check=f.runtime(f.root,{},preparing).inspect({run},"owner").nodes.find(n=>n.grain==="routes")?.check;
		assert.ok(repair?.receipt && repair.token && check,JSON.stringify(repair));
		assert.equal(repair.receipt.exit,251);
		await runtime.operation("submit",{run,token:repair.token,relinquish:{check,reason:"Secondary observation unavailable."}},writer.id);
	}
	const owner=f.runtime(f.root,{confirm:async msg=>{
		assert.ok(msg.includes("buttons") && msg.includes("selector"));
		if (cited) assert.ok(msg.includes(review.id) && msg.includes(citation));
		return true;
	}},first);
	const current=owner.inspect({run,detail:"proof"},"owner"), a=current.nodes.find(n=>n.grain==="buttons"), b=current.nodes.find(n=>n.grain==="rail");
	assert.ok(a?.state==="published" && b?.state==="published" && a.checked && b.checked);
	assert.deepEqual(current.products,proof.products);const priorChecks=[...f.checks];
	const request={run,from:"picker",historical:before.products?.at(-1)?.check,retainer:"buttons",to:"selector",checkpoint:current.products?.at(-1)?.check,goal:current.goalChecks?.at(-1)?.id};
	return {...c,buttons,rail,owner,current,a,b,request,review,citation,priorChecks};
}

/** @param {Awaited<ReturnType<typeof publishedRetainer>>} c */
export async function restorePrimary(c) {
	const {f,run,owner,request,rail,first}=c;
	await owner.operation("restore",request,"owner");
	const attester=[...f.workers.values()].at(-1);assert.ok(attester && attester.id!==rail.id);
	const fresh=f.runtime(attester.cwd,{},first);
	await fresh.operation("submit",{run,token:attester.token},attester.id);
	return {...c,attester,fresh};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function pairInputs(t,mode) {
	const c=await restorePrimary(await publishedRetainer(t,mode));
	const {f,run,owner,primary,file,a,request,current,priorChecks,fresh,observer}=c;
	const stalled=owner.inspect({run,detail:"proof"},"owner"), node=stalled.nodes.find(n=>n.grain==="selector");
	assert.equal(node?.state,"blocked");assert.ok(node?.check && node.receipt && node.receipt.exit===1);
	assert.match(node.receipt.output,/Checked control: new control/);
	const commit=node.receipt.commit;assert.ok(stalled.checkpoint);
	assert.equal(git(f.root,"rev-parse",`${commit}:${primary}`),git(f.root,"rev-parse",`${stalled.checkpoint}:${primary}`));
	assert.equal(git(f.root,"rev-parse",`${commit}:${file}`),git(f.root,"rev-parse",`${stalled.checkpoint}:${file}`));
	assert.equal(git(f.root,"show",`${a.checked}:${file}`),mode==="unchanged pair"?"new control":"current button");
	await assert.rejects(owner.operation("restore",{...request,to:"second-selector"},"owner"),{code:"invalid_restoration"});
	await assert.rejects(owner.operation("recheck",{run,check:node.check},"owner"),{code:"not_recoverable"});
	const after=owner.inspect({run,detail:"proof"},"owner");
	assert.deepEqual(after.nodes,stalled.nodes);assert.deepEqual(after.products,current.products);
	assert.deepEqual(after.goalChecks,current.goalChecks);assert.equal(after.qualified,null);
	assert.deepEqual(f.checks.slice(priorChecks.length).map(s=>s.split(" at ")[0]),["Check selector"]);
	assert.ok(a.check && a.checked);
	const args={run,grain:"selector",failed:node.check,retainer:"buttons",candidate:a.checked,component:a.check,checkpoint:request.checkpoint,goal:request.goal};
	const db=openDatabase(f.root), original=db.read(run)?.effects.find(e=>e.id===node.check);assert.ok(original);
	t.after(()=>db.close());owner.close();fresh.close();
	const state=db.read(run);assert.ok(state);
	const pins=Object.fromEntries(Object.entries(state.nodes).flatMap(([id,n])=>n.state==="published" ? [[id,n.candidate]] : []));
	assert.equal(Object.keys(pins).length,6);
	const number=f.workers.size;
	const beforeObserver=observer?await historicalRuntime(t,56):createRuntime;
	const next=f.runtime(f.root,{confirm:async msg=>{assert.ok([args.failed,args.candidate,args.component].every(x=>msg.includes(x)));return true;}},beforeObserver);
	return {...c,stalled,node,commit,after,args,db,original,state,pins,number,beforeObserver,next};
}

/** @param {Awaited<ReturnType<typeof pairInputs>>} c */
export async function checkedPair(c) {
	const {run,next,args,db,node}=c;
	const end=next.inspect({run,detail:"proof"},"owner"), checked=end.nodes.find(n=>n.grain==="selector");
	assert.ok(checked?.receipt && checked.check!==node.check);
	const receipt=end.checkRecovery?.find(r=>r.check===checked.check);
	assert.ok(receipt?.pair?.failed===args.failed && receipt.pair.component===args.component && receipt.issuer==="owner");
	const saved=db.read(run);assert.ok(saved);const paired=saved.effects.find(e=>e.id===checked.check);
	assert.ok(paired?.kind==="component" && paired.pair);db.verifySigned(run,paired);
	return {...c,end,checked,receipt,saved,paired};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function observerInputs(t,mode) {
	const c=await pairInputs(t,mode);
	const {f,run,next,args,sourceFile,beforeIndependent}=c;
	await next.operation("pair",args,"owner");
	const state=await checkedPair(c), {paired}=state;
	const approve=f.runtime(f.root,{confirm:async msg=>{assert.ok(msg.includes(sourceFile) && msg.includes(paired.id));return true;}},beforeIndependent);
	const author={run,grain:"selector",pair:paired.id,file:sourceFile,blob:git(f.root,"rev-parse",`${paired.commit}:${sourceFile}`)};
	next.close();
	return {...state,approve,author};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function firstObserver(t,mode) {
	const c=await observerInputs(t,mode);
	const {f,run,sourceFile,paired,beforeIndependent,approve,author,db}=c;
	await approve.operation("diagnose",author,"owner");
	const w=[...f.workers.values()].at(-1);assert.ok(w);
	const wr=f.runtime(w.cwd,{},beforeIndependent), submission={run,token:w.token};
	put(w.cwd,sourceFile,"phase-aware");
	const peek=await wr.operation("preview",submission,w.id), preview=peek.nodes.find(n=>n.grain==="selector")?.preview;assert.ok(preview);
	await approve.operation("diagnose",{...author,preview},"owner");
	await wr.operation("submit",submission,w.id);
	const proof=approve.inspect({run,detail:"proof"},"owner"), result=proof.nodes.find(n=>n.grain==="selector");
	assert.ok(result?.receipt);assert.equal(result.receipt.exit,mode==="observer pass"?0:1);
	const settled=db.read(run);assert.ok(settled);assert.deepEqual(settled.effects.find(e=>e.id===paired.id),paired);
	const freshCheck=settled.effects.find(e=>e.id===result?.check);assert.ok(freshCheck?.kind==="component" && freshCheck.observer?.after);
	db.verifySigned(run,freshCheck);
	return {...c,w,wr,submission,proof,result,settled,freshCheck};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function replacementInputs(t,mode) {
	const c=await firstObserver(t,mode);
	const {f,run,approve,wr,author,phases,args,diagnosticReader,result,freshCheck}=c;
	assert.ok(freshCheck.commit && freshCheck.observer?.after && result.check && result.receipt && result.receipt.output.includes("missing field"));
	const previous={check:result.check,candidate:freshCheck.commit,phases};
	const request={...author,blob:freshCheck.observer.after,previous};
	approve.close();wr.close();
	const owner=f.runtime(f.root,{confirm:async msg=>{assert.ok([previous.check,previous.candidate,...phases,args.candidate].every(p=>msg.includes(p)));return true;}},diagnosticReader);
	return {...c,previous,request,owner};
}

/** @param {import("node:test").TestContext} t @param {string} mode */
export async function failedFinalDiagnostic(t,mode) {
	const c=await replacementInputs(t,mode);
	const {f,run,owner,request,diagnosticReader,sourceFile,db}=c;
	await owner.operation("diagnose",request,"owner");
	const next=[...f.workers.values()].at(-1);assert.ok(next);
	const worker=f.runtime(next.cwd,{},diagnosticReader), submit={run,token:next.token};
	put(next.cwd,sourceFile,"after-event");
	const draft=(await worker.operation("preview",submit,next.id)).nodes.find(n=>n.grain==="selector")?.preview;assert.ok(draft);
	await owner.operation("diagnose",{...request,preview:draft},"owner");
	await worker.operation("submit",submit,next.id);owner.close();
	const after=f.runtime(f.root,{},diagnosticReader);
	after.turn("owner");await after.flush();
	const final=after.inspect({run,detail:"proof"},"owner"), outcome=final.nodes.find(n=>n.grain==="selector");
	assert.ok(outcome?.receipt && outcome.check);
	const ledger=db.read(run);assert.ok(ledger);
	const component=ledger.effects.find(e=>e.id===outcome.check);assert.ok(component?.kind==="component" && component.observer);
	assert.equal(outcome.receipt.exit,1);
	assert.equal(final.qualified,null);
	return {...c,ledger,component};
}

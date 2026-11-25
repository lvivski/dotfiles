import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { decode } from "../work/snapshot.mjs";
import { factory, git, put } from "./fixture.mjs";

for (const route of ["explicit replacement", "linked blocker", "no permitted action", "independent work", "relabelled sample", "bound correction"]) test(`an idle checked repair yields to fresh discovery / ${route}`, async t => {
	const run = "display", source = ".foundry/display.json", dir = "device/display", check = "unit.mjs", charter = "display.md";
	const id = "read-value", grain = (/** @type {string} */ id, /** @type {string} */ task) => ({ id, task, directory: dir, check, needs: [] });
	const previous=route==="bound correction" && process.env.FOUNDRY_SUCCESSOR_BEFORE;
	/** @type {typeof factory} */
	const build=previous ? (await import(pathToFileURL(path.resolve(previous,"test/fixture.mjs")).href)).factory : factory;
	const f = build(t, run, source, {
		[source]: JSON.stringify({ id:run, version:2, target:"refs/heads/main", direction:"Display the measured value.",
			productCheck:"product.mjs", goalCheck:"goal.mjs", limits:{workers:route === "independent work" ? 2 : 1}, squads:[{id:"device",charter,areas:["device"],checks:[check]}] }),
		".foundry/display/journey.md":"Read the value.", [charter]:"Display the configured value.", "product.mjs":"",
		"device/display/control":"unconnected",
		...(route==="bound correction" && {[`${dir}/contract`]:"The local control is named display; the service request is named measurement."}),
		[check]:`if(process.env.FOUNDRY_GRAIN==="sample"){console.log("Phase attached; displayed value unobserved.");process.exit(2)}`,
		"goal.mjs":`import {existsSync} from "node:fs";
			if(!existsSync("${dir}/value")){console.log("Display unavailable."); ${route === "linked blocker" ?
				`console.log('FOUNDRY_BLOCKERS=[{"id":"${id}","directory":"${dir}","blocked":4}]');` : ""}process.exit(1)}`,
	});
	await f.start();
	const make = (/** @type {ReturnType<typeof grain>} */ g) => ({ outcome:"regenerate",reason:g.task,evidence:[`${dir}/control`],grains:[g] });
	const original = grain("sample","Take exactly one sample; a second sample is not allowed.");
	const proposal = make(original);
	if (route === "independent work") proposal.grains.push({...grain("logger","Implement the logger."),directory:"device/log"});
	await f.scouts[0].report(proposal);
	const [w] = f.workers.values(), writer = f.runtime(w.cwd);
	put(w.cwd,`${dir}/draft`,"midpoint");
	const preview = (await writer.operation("preview",{run,token:w.token},w.id)).nodes[0].preview;
	assert.ok(preview);
	put(w.cwd,`${dir}/draft`,"recorded sample");
	const response = await writer.operation("submit",{run,token:w.token},w.id);
	await f.settle(); const node = response.nodes[0];
	assert.ok(node.state === "writing" && node.token && node.token !== w.token && node.receipt && node.receipt.exit === 2);
	const owner = f.runtime(f.root), before = await owner.operation("status",{run,detail:"proof"},"owner");
	const failed = before.nodes[0].check; assert.ok(failed);
	const reason = "The authorized single sample was taken. The reported phase does not identify the displayed value.";
	const stop = {run,token:node.token,cannotRepair:{check:failed,reason}};
	const calls = [...f.checks], count = f.scouts.length, workers = f.workers.size;
	owner.turn("owner"); await owner.flush(); await f.settle();
	assert.equal(f.scouts.length,count,"an idle writer alone does not surrender ownership");
	put(w.cwd,`${dir}/draft`,"unsubmitted edits");
	const recovered = f.runtime(w.cwd);
	const fresh = recovered.inspect({run},w.id).nodes[0];
	if (route !== "independent work") {
		assert.equal(fresh.cannotRepair?.check,failed,"the original writer must be able to find the safe stop from its own status");
		await assert.rejects(owner.operation("submit",stop,"owner"),/assignment/);
		await assert.rejects(owner.operation("submit",stop,w.id),/worktree/);
		await assert.rejects(recovered.operation("submit",{...stop,token:w.token},w.id),/assignment/);
		await assert.rejects(recovered.operation("submit",{...stop,cannotRepair:{check:"wrong",reason}},w.id),/component check/);
		await assert.rejects(recovered.operation("submit",{...stop,usedArtifacts:[]},w.id),/Unsupported field/);
		await assert.rejects(f.runtime(w.cwd,{runningHelpers:async()=>["unjoined"]}).operation("submit",stop,w.id),/helpers/);
		await assert.rejects(f.runtime(w.cwd,{mode:async()=>"plan"}).operation("submit",stop,w.id),/Activation context changed/);
		await assert.rejects(f.runtime(w.cwd,{permissionBlocker:async()=>({scope:"session",message:"Awaiting approval"})}).operation("submit",stop,w.id),/Awaiting approval/);
	}
	assert.equal(owner.inspect({run},"owner").nodes[0].state,"writing");
	await recovered.operation("submit",route === "independent work" ? {run,token:node.token,missingInput:reason} : stop,w.id); await f.settle();
	const db = openDatabase(f.root); t.after(()=>db.close());
	const state = db.read(run), n = state?.nodes.sample; assert.ok(n);
	assert.equal(n.state,"blocked"); assert.equal(n.check,failed); assert.equal(n.candidate,node.receipt.commit);
	assert.equal(n.preview,preview); assert.equal(git(f.root,"show",`${preview}:${dir}/draft`),"midpoint");
	assert.equal(n.worker,w.id); assert.equal(n.repairs,node.repairs);
	assert.equal(git(f.root,"show",`${n.candidate}:${dir}/draft`),"recorded sample");
	const next = f.scouts.at(-1); assert.ok(next && f.scouts.length === count + 1);
	for (const evidence of [reason,failed,"Phase attached; displayed value unobserved."]) assert.ok(next.prompt.includes(evidence));
	assert.deepEqual(f.checks,calls); assert.equal(f.workers.size,workers);
	assert.ok(state);
	const tampered = structuredClone(state);
	tampered.nodes.sample.candidate = f.tip;
	assert.throws(()=>decode(tampered),/Invalid Foundry task graph/);
	const oldReceipt = state.effects.find(e=>e.id===failed);
	await assert.rejects(owner.operation("publish",{run,readBaselines:["sample"]},"owner"),/original bound missing-input/);
	await assert.rejects(recovered.operation("submit",stop,w.id),/writable|assignment/);
	await assert.rejects(recovered.operation("submit",{run,token:node.token},w.id),/writable|assignment/);
	if (route === "no permitted action") {
		await next.report({outcome:"unresolved",reason:"A second sample is not permitted and no independent observation exists.",evidence:[charter],grains:[]});
		owner.turn("owner"); await owner.flush(); await f.settle();
		const s = owner.inspect({run},"owner"); assert.match(s.blocker ?? "",/second sample is not permitted/);
		assert.equal(s.qualified,null); assert.equal(f.scouts.length,count+1); assert.deepEqual(f.checks,calls);
		return;
	}
	if (route === "relabelled sample") {
		await next.report({...make({...original,id:"sample-again"}),replace:["sample"]});
		assert.match(owner.inspect({run},"owner").reviews.at(-1)?.handoffHold ?? "",/Not a distinct task/);
		assert.equal(f.workers.size,workers); assert.deepEqual(f.checks,calls);
		return;
	}
	if (route === "independent work") {
		await next.report(make({...grain("separate","Provide the independent counter."),directory:"device/count"}));
		const live = db.read(run); assert.deepEqual(live?.nodes.logger,state.nodes.logger);
		assert.equal(live?.nodes.sample.candidate,node.receipt.commit); assert.ok(live?.nodes.separate.worker);
		assert.deepEqual(f.checks,calls);
		return;
	}
	const clause=" targeting `measurement`";
	const originalTask="Connect the missing value using the existing control";
	let review=next;
	if (route==="bound correction") {
		await next.report({outcome:"needs-evidence",reason:"Identify the local control.",file:`${dir}/control`,evidence:[charter],grains:[]});
		review=f.scouts.at(-1)??assert.fail();assert.notEqual(review.id,next.id);
	}
	await review.report({...make(grain("connect",originalTask+(route==="bound correction"?clause:"")+".")),
		...(route === "linked blocker" ? {addresses:[{id,grain:"connect"}]} : {replace:["sample"]})});
	const after = owner.inspect({run},"owner"), assigned = after.nodes.find(n=>n.grain==="connect"), successor = f.workers.get(assigned?.worker ?? "");
	assert.ok(successor && successor.id !== w.id,JSON.stringify(after.reviews.at(-1)));
	assert.equal(f.workers.size,2); assert.deepEqual(f.checks,calls);
	assert.equal(existsSync(path.join(successor.cwd,dir,"draft")),false);
	const history = db.read(run)?.effects.find(e=>e.id===review.id);
	assert.ok(history?.kind === "scout" && history.predecessor && history.predecessor.candidate === n.candidate && history.predecessor.check === failed);
	assert.equal(history.predecessor.preview,preview);
	assert.match(successor.prompt,/not permission to repeat/);
	if (route==="bound correction") {
		const request={run,grain:"connect",review:review.id,worker:successor.id,clause,file:`${dir}/contract`,excerpt:"The local control is named display"};
		if (previous) await assert.rejects(owner.operation("correct",request,"owner"),{code:"invalid_correction"});
		const before=db.read(run);assert.ok(before);assert.ok(history.wake && !history.iteration);
		const approve=f.runtime(f.root,{confirm:async msg=>{assert.ok(msg.includes(failed)&&msg.includes(clause)&&msg.includes(request.excerpt));return true;}},createRuntime);
		await assert.rejects(approve.operation("correct",{...request,worker:w.id},"owner"),{code:"stale_assignment"});
		await assert.rejects(f.runtime(f.root,{confirm:async()=>false},createRuntime).operation("correct",request,"owner"),{code:"approval_declined"});
		assert.deepEqual(db.read(run),before);
		await approve.operation("correct",request,"owner");
		const current=f.runtime(successor.cwd,{},createRuntime).inspect({run},successor.id).nodes.find(n=>n.grain==="connect");
		assert.equal(current?.task,originalTask+".");assert.equal(current.token,successor.token);assert.equal(current.correction?.clause,clause);
		assert.deepEqual(db.read(run)?.effects.find(e=>e.id===failed),oldReceipt);
		assert.deepEqual(f.checks,calls);assert.equal(f.workers.size,2);
	}
	const nextWriter = f.runtime(successor.cwd,{},createRuntime);
	put(successor.cwd,`${dir}/draft`,"recorded sample");
	await assert.rejects(nextWriter.operation("submit",{run,token:successor.token},successor.id),/do not replay/);
	assert.deepEqual(f.checks,calls);
	put(successor.cwd,`${dir}/value`,"visible");
	await nextWriter.operation("submit",{run,token:successor.token},successor.id);
	const end = await f.runtime(f.root,{},createRuntime).operation("status",{run,detail:"proof"},"owner");
	assert.ok(end.qualified && end.goal?.receipt?.commit === end.qualified && end.products?.at(-1)?.receipt?.commit === end.qualified);
	assert.equal(git(f.root,"show",`${end.qualified}:${dir}/value`),"visible");
	assert.deepEqual(end.goalChecks?.slice(0,-1),before.goalChecks);
	assert.deepEqual(db.read(run)?.effects.find(e=>e.id===failed),oldReceipt);
});

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./database.mjs";
import { createRuntime } from "./runtime.mjs";
import { factory, git, put } from "../test/fixture.mjs";

// An optional reader-50 fixture produces the stranded ledger before the current reader opens it.
for (const scenario of ["goal passes","observation missing","product fails","unconfirmed product","unchanged","stale citation","moved target"]) test(`integrate an ordinary published output after exit 2 / ${scenario}`, async t => {
	const run="meters", source=".foundry/meters.json", product=".foundry/product.mjs", prior=process.env.FOUNDRY_JOIN_BEFORE;
	/** @type {typeof factory} */
	const build=prior ? (await import(pathToFileURL(path.resolve(prior,"test/fixture.mjs")).href)).factory : factory;
	const f=build(t,run,source,{
		[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Publish both readings.",
			productCheck:product,goalCheck:"goal.mjs",squads:["hub","sensor"].map(id=>({id,charter:`${id}.md`,areas:[id],checks:["unit.mjs"]}))}),
		".foundry/meters/journey.md":"Read the meter.", "hub.md":"Add the hub.", "sensor.md":"Check the sensor.",
		"hub/scale":"old", "sensor/value":"old","unit.mjs":"",
		[product]:`import {readFileSync} from "node:fs"; if(${scenario==="product fails"} && readFileSync("sensor/value","utf8")==="new") process.exit(1)`,
		"goal.mjs":`import {existsSync,readFileSync} from "node:fs"; process.exit(!existsSync("hub/ready") ? 1 :
			${scenario==="goal passes"} && readFileSync("sensor/value","utf8")==="new" ? 0 : 2)`,
	});
	await f.start(); await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	for (let s of [...f.scouts]) {
		const id=s.squad, evidence=[`${id}.md`];
		if (id==="sensor" && scenario==="stale citation") {
			await s.report({outcome:"needs-evidence",reason:"Read the scale.",file:"hub/scale",evidence,grains:[]});
			s=f.scouts.at(-1) ?? assert.fail(); evidence.push("hub/scale");
		}
		await s.report({outcome:"regenerate",reason:`Build ${id}.`,evidence,grains:[{id,directory:id,task:`Build ${id}.`,needs:[],check:"unit.mjs"}]});
	}
	const db=openDatabase(f.root); t.after(()=>db.close());
	const read=()=>db.read(run) ?? assert.fail(), worker=(/** @type {string} */ id)=>f.workers.get(read().nodes[id].worker ?? "") ?? assert.fail();
	const hub=worker("hub"), sensor=worker("sensor");
	put(hub.cwd,"hub/ready","ready"); put(hub.cwd,"hub/scale","new");
	await f.runtime(hub.cwd).operation("submit",{run,token:hub.token},hub.id);
	const saved=read(), original=saved.products.at(-1); assert.ok(original && saved.goal?.commit===original.commit);
	assert.equal(saved.effects.find(e=>e.id===saved.goal?.check)?.receipt?.exit,2);
	if (scenario==="moved target") {
		put(f.root,"external","new target"); git(f.root,"add","external"); git(f.root,"commit","-qm","Advance target");
	}
	put(sensor.cwd,"sensor/value",scenario==="unchanged"?"old":"new");
	/** @type {(()=>Promise<unknown>)|undefined} */ let finish;
	/** @type {typeof f.execute} */
	const execute=async (tool,args,call)=>{
		if (scenario==="unconfirmed product" && tool==="bash" && String(args.description).startsWith("Check joined product")) {
			assert.equal(finish,undefined,"an outstanding check must not be issued twice");
			finish=()=>f.execute(tool,args,call);
			return {resultType:"unconfirmed"};
		}
		return f.execute(tool,args,call);
	};
	const writer=f.runtime(sensor.cwd,{execute}); await writer.operation("submit",{run,token:sensor.token},sensor.id);
	writer.close(); f.owner.close();
	const before=read(), candidate=before.effects.find(e=>e.id===before.nodes.sensor.check);
	assert.equal(candidate?.receipt?.exit,0);
	const r=before.effects.find(e=>e.id===before.nodes.sensor.review);
	assert.ok(r?.kind==="scout" && !r.lead && !r.iteration && !before.nodes.sensor.reuse && before.nodes.sensor.base!==original.commit);
	if (prior) {
		assert.deepEqual(before.goal,saved.goal); assert.deepEqual(before.products,saved.products);
		assert.deepEqual(Object.values(before.nodes).filter(n=>n.state==="published").map(n=>n.grain.id),["sensor"]);
	}
	let prompts=0;
	const owner=f.runtime(f.root,{execute,confirm:async()=>{prompts++; return false;}},createRuntime);
	const pin={run,kind:"product",from:f.tip,revision:"",files:[product]};
	if (scenario==="observation missing") {
		const side=path.join(path.dirname(f.root),"checker");
		git(f.root,"worktree","add","-q","--detach",side,f.tip); put(side,product,"// Revised checker\n");
		git(side,"commit","-qam","Revise product checker"); pin.revision=git(side,"rev-parse","HEAD");
		if (prior) await assert.rejects(owner.operation("repin",pin,"owner"),{code:"unsettled_checkpoint"});
	}
	owner.turn("owner"); await owner.flush(); owner.turn("owner"); await owner.flush();
	if (scenario==="unconfirmed product") {
		const pending=read(); assert.ok(finish && pending.join && !pending.effects.find(e=>e.id===pending.join?.check)?.receipt);
		assert.deepEqual(pending.goal,saved.goal); assert.deepEqual(pending.products,saved.products);
		await finish(); owner.turn("owner"); await owner.flush();
		assert.ok(read().products.some(p=>p.check===pending.join?.check));
	}
	const end=read(), proof=owner.inspect({run,detail:"proof"},"owner");
	assert.equal(prompts,0); assert.deepEqual(end.productRepins,saved.productRepins);
	assert.deepEqual(end.effects.filter(e=>e.kind==="scout" || e.kind==="writer").map(e=>e.id),
		saved.effects.filter(e=>e.kind==="scout" || e.kind==="writer").map(e=>e.id));
	assert.deepEqual(end.effects.slice(0,saved.effects.length).filter(e=>e.tool==="bash"),saved.effects.filter(e=>e.tool==="bash"));
	assert.deepEqual(end.effects.find(e=>e.id===candidate?.id),candidate);
	assert.deepEqual(end.products.slice(0,saved.products.length),saved.products);
	assert.equal(end.effects.filter(e=>e.kind==="component" && e.grain==="sensor").length,1);
	const fresh=end.effects.slice(saved.effects.length).filter(e=>e.kind==="product" || e.kind==="goal");
	if (scenario==="moved target") {
		assert.deepEqual(fresh,[]); assert.deepEqual(end.goal,saved.goal); assert.deepEqual(end.products,saved.products);
		assert.equal(end.nodes.sensor.state,"published");
	} else if (scenario==="unchanged" || scenario==="stale citation") {
		assert.deepEqual(fresh,[]); assert.deepEqual(end.goal,saved.goal);
		assert.equal(end.nodes.sensor.state,scenario==="unchanged"?"repeated":"blocked");
		assert.match(end.nodes.sensor.reason ?? "",scenario==="unchanged"?/unchanged/:/hub\/scale/);
	} else {
		const pass=scenario!=="product fails";
		assert.deepEqual(fresh.map(e=>[e.kind,e.receipt?.exit]),pass?[["product",0],["goal",scenario==="goal passes"?0:2]]:[["product",1]]);
		const joined=fresh[0].commit; assert.ok(joined && joined!==original.commit);
		assert.equal(git(f.root,"show",`${joined}:sensor/value`),"new"); assert.equal(git(f.root,"show",`${joined}:hub/ready`),"ready");
		if (pass) {assert.equal(end.goal?.commit,joined); assert.equal(end.products.at(-1)?.outputs.sensor,candidate?.commit);}
		else {assert.deepEqual(end.goal,saved.goal); assert.deepEqual(end.products,saved.products);}
	}
	assert.equal(!!proof.qualified,scenario==="goal passes");
	if (scenario==="observation missing") {
		await assert.rejects(owner.operation("repin",pin,"owner"),{code:"approval_declined"});
		assert.equal(prompts,1,"the new checkpoint is eligible for a separate checker approval");
		assert.deepEqual(read(),end);
	}
});

for (const phase of ["missing", "pending", "reconnect", "changed citation"]) test(`continue a bound checkpoint writer's failed component after a sibling advances / ${phase}`, async t => {
	const run = "panels", source = ".foundry/panels.json", ids = ["data", "theme", "view"];
	if (phase === "reconnect") ids.push("spare");
	const f = factory(t, run, source, {
		[source]: JSON.stringify({version:2, id:run, target:"refs/heads/main", direction:"Show a styled data view.",
			productCheck:"unit.mjs", goalCheck:"goal.mjs", squads:ids.map(id => ({id, areas:[id], charter:`${id}.md`, checks:["check.mjs"]}))}),
		".foundry/panels/journey.md":"Show the view.", ...Object.fromEntries(ids.map(id => [`${id}.md`, `Own ${id}.`])),
		"theme/ui/color":"blue", "view/ui/script":"stage nothing", "unit.mjs":"",
		"check.mjs":`import {existsSync} from "node:fs"; if (process.env.FOUNDRY_GRAIN === "view" && !existsSync("view/ui/helper")) {
			console.log("Fixture omitted helper"); process.exit(1); }`,
		"goal.mjs":`import {existsSync as has} from "node:fs"; if (!has("data/ui/value")) {
			console.log('FOUNDRY_BLOCKERS=[{"id":"theme","directory":"theme/ui","blocked":1},{"id":"view","directory":"view/ui","blocked":1}]');process.exit(1);}
			if (!has("theme/ui/ready") || !has("view/ui/helper")) process.exit(2);`,
	});
	/** @param {string} id @param {string[]} evidence */
	const proposal = (id,evidence) => ({outcome:"regenerate",reason:`Build ${id}.`,evidence,
		grains:[{id,directory:`${id}/ui`,check:"check.mjs",task:`Build ${id}.`,needs:id==="data"?[]:["data"]}]});
	await f.start();
	for (const s of [...f.scouts].filter(s => s.squad !== "spare")) await s.report(s.squad === "data" ? proposal("data",["data.md"]) :
		{outcome:"no-gap",reason:"Wait for data.",evidence:[`${s.squad}.md`],grains:[]});
	const [data] = f.workers.values();
	put(data.cwd,"data/ui/value","data");
	await f.runtime(data.cwd).operation("submit",{run,token:data.token},data.id); await f.settle();
	for (let s of f.scouts.slice(ids.length)) {
		const evidence = [s.squad==="theme"?"theme/ui/color":"view/ui/script"];
		if (phase === "changed citation" && s.squad === "view") {
			await s.report({outcome:"needs-evidence",reason:"Check the palette for the fixture.",file:"theme/ui/color",evidence,grains:[]});
			s = f.scouts.at(-1) ?? assert.fail("missing citation follow-up"); evidence.push("theme/ui/color");
		}
		await s.report(proposal(s.squad,evidence));
	}
	await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");
	const assigned = await f.status(), worker = (/** @type {string} */ id) => f.workers.get(assigned.nodes.find(n=>n.grain===id)?.worker ?? "") ?? assert.fail(`missing ${id}`);
	const theme = worker("theme"), view = worker("view"), events = new EventEmitter(), held = once(events,"issued"), release = once(events,"release");
	const sibling = f.runtime(theme.cwd,{execute:async(tool,args,call)=>{
		if (phase==="pending" && tool==="bash" && String(args.description).includes("final goal")) {events.emit("issued"); await release;}
		return f.execute(tool,args,call);
	}});
	put(theme.cwd,"theme/ui/color","green"); put(theme.cwd,"theme/ui/ready","ready");
	const submit = sibling.operation("submit",{run,token:theme.token},theme.id);
	try {
		if (phase==="pending") await Promise.race([held, submit.then(()=>assert.fail("goal was not issued"))]); else await submit;
		const original = assigned.nodes.find(n=>n.grain==="view");
		const checkpoint = f.owner.inspect({run,detail:"proof"},"owner").goalChecks?.at(-1);
		assert.ok(checkpoint && checkpoint.commit!==assigned.checkpoint);
		assert.equal(checkpoint.receipt?.exit,phase==="pending" ? undefined : 2);
		if (phase === "reconnect") await f.owner.operation("configure",{run,revision:1,workers:1},"owner");
		put(view.cwd,"view/ui/script","stage the view");
		const writer = f.runtime(view.cwd);
		await writer.operation("submit",{run,token:view.token},view.id);
		const owner = f.runtime(f.root);
		if (phase === "reconnect") {
			const waiting = owner.inspect({run},"owner").nodes.find(n=>n.grain==="view");
			assert.equal(waiting?.state,"waiting"); assert.ok(waiting.receipt && waiting.receipt.exit===1); assert.equal(waiting.repairs,0);
			assert.deepEqual(f.inbox.filter(m=>m.worker===view.id).map(m=>m.token),[view.token]);
			await owner.operation("configure",{run,revision:2,workers:null},"owner");
		}
		owner.turn("owner"); await owner.flush(); await f.settle();
		const node = owner.inspect({run,detail:"proof"},"owner").nodes.find(n=>n.grain==="view"); assert.ok(node?.check);
		assert.equal(node.worker,view.id); assert.equal(node.generation,original?.generation);
		assert.equal(f.workers.size,3);
		if (phase==="changed citation") {
			assert.equal(node.state,"blocked"); assert.match(node.reason ?? "",/supporting file/); assert.equal(node.repairs,0); return;
		}
		assert.equal(node.state,"writing","the original failed component must receive its bounded repair on the newer checkpoint");
		assert.equal(node.repairs,1); assert.deepEqual(node.inputs,original?.inputs);
		const token = writer.inspect({run},view.id).nodes.find(n=>n.grain==="view")?.token; assert.ok(token && token!==view.token);
		if (phase === "reconnect") assert.deepEqual(f.inbox.filter(m=>m.worker===view.id).map(m=>m.token),[view.token,token]);
		assert.equal(f.checks.filter(c=>c.startsWith("Check view at")).length,1);
		assert.equal(owner.inspect({run},"owner").qualified,null);
		const reloaded = f.runtime(view.cwd);
		await assert.rejects(reloaded.operation("submit",{run,token:view.token},view.id),/assignment/);
		put(view.cwd,"view/ui/helper","staged");
		await reloaded.operation("submit",{run,token},view.id);
		if (phase==="pending") {
			assert.equal(owner.inspect({run},"owner").qualified,null); events.emit("release"); await submit;
		}
		await f.settle();
		const end = owner.inspect({run,detail:"proof"},"owner"); assert.ok(end.qualified && end.qualified===end.goal?.receipt?.commit);
		assert.equal(end.goalChecks?.filter(g=>g.commit===checkpoint.commit).length,1);
		assert.equal(git(f.root,"show",`${end.qualified}:view/ui/helper`),"staged");
		assert.equal(git(f.root,"show",`${end.qualified}:theme/ui/color`),"green");
		assert.equal(f.checks.filter(c=>c.startsWith("Check view at")).length,2);
	} finally {events.emit("release"); await submit;}
});

import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { chmodSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { openDatabase } from "../work/database.mjs";
import { createRuntime } from "../work/runtime.mjs";
import { factory, git, put } from "./fixture.mjs";

const run = "example", source = ".foundry/example.json", journey = ".foundry/example/journey.md";
const api = "producer/version", stored = "consumer/stored";
/** @param {import("node:test").TestContext} t @param {string[]} ids @param {string} goal @param {number} [assignments] @param {typeof factory} [build] */
function fixture(t, ids, goal, assignments, build = factory) {
	return build(t, run, source, {
		[source]: JSON.stringify({ version:2, id:run, target:"refs/heads/main", direction:"Ship a usable output.",
			productCheck:"product.mjs", goalCheck:"goal.mjs", limits:{assignments},
			squads:ids.map(id => ({id, areas:[id], charter:`${id}.md`, checks:["unit.mjs"]})) }),
		[journey]:"Ship a usable output.", ...Object.fromEntries(ids.map(id => [`${id}.md`,`Own ${id}.`])),
		[api]:"v1", "consumer/version":"v1", "reference":"Another implementation.", "manual/next":"Further evidence.",
		"product.mjs":"", "unit.mjs":"", "goal.mjs":`import {existsSync as has, readFileSync} from "node:fs";
		const read = p => readFileSync(p,"utf8"); if (!(${goal})) process.exit(1);`,
	});
}
/** @param {string} id @param {string[]} [evidence] @param {string[]} [needs] */
const propose = (id, evidence = [`${id}.md`], needs = []) => ({outcome:"regenerate", reason:`Implement ${id}.`, evidence,
	grains:[{id, directory:id, task:`Implement ${id}.`, check:"unit.mjs", needs}]});
/** @param {string} id */
const noGap = id => ({outcome:"no-gap",reason:"Nothing to change.",evidence:[`${id}.md`],grains:[]});
/** @param {string} file */
const readFile = file => ({outcome:"needs-evidence",reason:"Read the interface.",file,evidence:[journey],grains:[]});
/** @param {ReturnType<typeof fixture>} f @param {string} id */
const worker = (f,id) => f.workers.get(f.owner.inspect({run},"owner").nodes.find(n=>n.grain===id)?.worker ?? "") ?? assert.fail(`missing ${id}`);
/** @param {ReturnType<typeof fixture>} f @param {ReturnType<typeof worker>} w */
const submit = (f,w) => f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);
/** @param {ReturnType<typeof fixture>} f */
const proof = f => f.owner.inspect({run,detail:"proof"},"owner");

test("a checkpoint comparison finishes from delivered evidence after a duplicate read", async t => {
	const before = process.env.FOUNDRY_COMPARISON_BEFORE;
	/** @type {typeof factory} */
	const build = before ? (await import(pathToFileURL(path.resolve(before,"test/fixture.mjs")).href)).factory : factory;
	const f = fixture(t, ["producer","consumer"], `has("consumer/done") || (has("producer/done") ? process.exit(2) : false)`, undefined, build);
	await f.start();
	for (const s of [...f.scouts]) await s.report(s.squad === "producer" ? propose("producer") : noGap("consumer"));
	const p = worker(f,"producer"); put(p.cwd,"producer/done","ready"); await submit(f,p);
	const checkpoint = proof(f), goal = checkpoint.goalChecks?.at(-1); assert.ok(goal?.receipt?.exit === 2);
	const owner = f.runtime(f.root,{confirm:async () => true});
	const file = "consumer/version", [offer] = (await owner.operation("publish",{run,file:"reference",to:["consumer"]},"owner")).artifacts;
	await owner.operation("iterate",{run,receipt:goal.id,directory:"consumer",blob:offer.blob,
		question:"Use the producer's new output.",source:{commit:goal.commit,file,excerpt:"v1"}},"owner");
	await f.settle();
	const opening = f.scouts.at(-1); assert.ok(opening?.packet.files[file]);
	const count = f.scouts.length, checks = [...f.checks];
	await opening.report(readFile(file));
	const rejected = proof(f).reviews.find(r => r.id === opening.id);
	assert.ok(rejected?.state === "blocked" && rejected.reason?.includes("pinned evidence is unchanged"));
	let current = owner;
	if (before) {
		owner.turn("owner"); await owner.flush(); await f.settle();
		assert.equal(f.scouts.length,count,"the previous reader left this comparison stranded");
		assert.equal(proof(f).qualified,null);
		owner.close(); f.owner.close();
		current = f.runtime(f.root,{},createRuntime);
	} else assert.equal(f.scouts.length,count+1,"the decision must be delivered without reopening the run");
	current.turn("owner"); await current.flush(); await f.settle();
	const decision = f.scouts.at(-1);
	assert.ok(decision && decision.id !== opening.id,"the same comparison must get its decision");
	assert.equal(f.scouts.length,count+1);
	const interim = current.inspect({run,detail:"proof"},"owner");
	assert.deepEqual(interim.reviews.find(r => r.id === opening.id),rejected);
	assert.equal(interim.reviews.at(-1)?.iterationFrom,opening.id);
	assert.equal(decision.packet.files[file],opening.packet.files[file]);
	assert.deepEqual(interim.goalChecks,checkpoint.goalChecks); assert.deepEqual(f.checks,checks);
	await current.scoutResult(run,opening.dispatch,opening.issuer,opening.workflowId,opening.id,readFile(file),opening.packet);
	await decision.report(propose("consumer",[file],["producer"]));
	const w = f.workers.get(current.inspect({run},"owner").nodes.find(n => n.grain === "consumer")?.worker ?? "");
	assert.ok(w); put(w.cwd,"consumer/done","ready");
	await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
	const end = current.inspect({run,detail:"proof"},"owner");
	assert.ok(end.qualified && end.qualified !== goal.commit);
	assert.equal(git(f.root,"show",`${end.qualified}:consumer/done`),"ready");
	assert.deepEqual(end.goalChecks?.find(e => e.id === goal.id),goal);
	assert.equal(f.scouts.length,count+1,"neither the original nor the sibling review is replayed");
});

for (const scenario of ["pin changed","pin unchanged","delayed change","delayed unchanged","simultaneous change","simultaneous deletion",
	"simultaneous mode","unrelated change","incidental read","consumer first","fresh review","reciprocal"]) test(`writer input at integration / ${scenario}`,async t=>{
	const pin = scenario.startsWith("pin"), delayed = scenario.startsWith("delayed"), reciprocal = scenario==="reciprocal", replace=scenario==="fresh review";
	const f=fixture(t,delayed ? ["producer","consumer","gate"] : ["producer","consumer"],
		pin || replace ? `has("${stored}") && read("${stored}") === read("${api}")` : `has("producer/done")`);
	await f.start();
	const initial = new Map(f.scouts.map(s=>[s.squad,s]));
	await initial.get("consumer")?.report(readFile(api));
	const cited=f.scouts.at(-1); assert.ok(cited?.packet.files[api]);
	let producer=initial.get("producer"); assert.ok(producer);
	if(reciprocal) {await producer.report(readFile("consumer/version")); producer=f.scouts.at(-1); assert.ok(producer?.packet.files["consumer/version"]);}
	await producer.report(propose("producer",reciprocal?["consumer/version"]:undefined));
	if(delayed) await initial.get("gate")?.report(propose("gate"));
	await cited.report(propose("consumer",scenario==="incidental read"?["consumer.md"]:[api],pin?["producer"]:delayed?["gate"]:[]));
	const p=worker(f,"producer");
	const changed=!scenario.endsWith("unchanged") && scenario!=="unrelated change" && scenario!=="simultaneous mode";
	if(scenario!=="simultaneous deletion") put(p.cwd,api,changed?"v2":"v1");
	if(scenario==="simultaneous mode") chmodSync(path.join(p.cwd,api),0o755);
	put(p.cwd,"producer/done","yes");
	if(pin || delayed) {
		await submit(f,p);
		if(delayed) {
			const g=worker(f,"gate"); put(g.cwd,"gate/result","ready"); await submit(f,g);
			if(changed) {
				assert.equal(proof(f).nodes.find(n=>n.grain==="consumer")?.state,"blocked");
				assert.equal(f.workers.size,2,"no reservation for a stale brief"); return;
			}
		}
		const w=worker(f,"consumer"), pinned=git(w.cwd,"show",`HEAD:${api}`);
		put(w.cwd,stored,pinned); await submit(f,w);
		const end=proof(f); assert.ok(end.qualified,end.blocker ?? "missing checked release");
		assert.equal(git(f.root,"show",`${end.qualified}:${stored}`),changed?"v2":"v1");
		assert.equal(w.prompt.includes(`Read-only supporting file: ${f.tip}:${api}`),delayed); return;
	}
	const c=worker(f,"consumer"), beforeConflict=f.scouts.length;
	assert.equal(c.prompt.includes(`Read-only supporting file: ${f.tip}:${api}`),scenario!=="incidental read");
	put(c.cwd,stored,scenario==="incidental read"?"independent":"v1"); put(c.cwd,"consumer/version","v2");
	if(scenario==="consumer first") {
		await submit(f,c); const accepted=proof(f).checkpoint; assert.ok(accepted);
		await submit(f,p); assert.ok(proof(f).qualified);
		assert.equal(git(f.root,"show",`${proof(f).qualified}:${stored}`),"v1"); return;
	}
	const events=new EventEmitter(), held=once(events,"held"), release=once(events,"release");
	const writer=f.runtime(p.cwd,{execute:async(tool,args,call)=>{
		if(tool==="bash" && String(args.description).startsWith("Check joined product")) { events.emit("held"); await release; }
		return f.execute(tool,args,call);
	}});
	const first=writer.operation("submit",{run,token:p.token},p.id);
	try {
		await Promise.race([held,first.then(()=>assert.fail("missing issued product"))]);
		await submit(f,c);
	} finally {events.emit("release"); await first;}
	const end=proof(f), consumer=end.nodes.find(n=>n.grain==="consumer");
	assert.ok(consumer?.receipt && consumer.receipt.exit===0);
	if(scenario==="incidental read") {assert.ok(end.qualified); assert.equal(git(f.root,"show",`${end.qualified}:${stored}`),"independent"); return;}
	if(scenario==="unrelated change") {assert.ok(end.qualified); assert.equal(git(f.root,"show",`${end.qualified}:${stored}`),"v1");return;}
	assert.equal(consumer?.state,"blocked"); assert.match(consumer.reason ?? "",/producer\/version/);
	if(replace) {
		assert.equal(end.goal?.receipt?.exit,1);
		const fresh=f.scouts.findLast(s=>s.squad==="consumer"); assert.ok(fresh && fresh.base===end.checkpoint && fresh.id!==cited.id);
		await fresh.report({...propose("consumer",["consumer.md"],["producer"]),replace:["consumer"],
			grains:[{...propose("consumer",[],["producer"]).grains[0],id:"updated"}]});
		const next=worker(f,"updated"); put(next.cwd,stored,git(next.cwd,"show",`HEAD:${api}`)); await submit(f,next);
		assert.ok(proof(f).qualified); assert.equal(git(f.root,"show",`${proof(f).qualified}:${stored}`),"v2"); return;
	}
	if(reciprocal) {
		assert.equal(end.qualified,null); assert.equal(end.nodes.find(n=>n.grain==="producer")?.state,"blocked");
		f.owner.turn("owner"); await f.owner.flush(); await f.settle();
		assert.equal(f.scouts.length,beforeConflict); assert.equal(f.workers.size,2); return;
	}
	assert.ok(end.qualified,end.blocker ?? "missing checked release"); assert.ok(!git(f.root,"ls-tree","-r","--name-only",end.qualified,"--",stored));
});

// Point this at a frozen pre-fix extension directory to exercise an actual upgrade:
// only the native transport is scripted. Keep the original ledger, Git objects and signed journal.
const before=process.env.FOUNDRY_RELEASE_BEFORE;
for(const pending of [false,true]) test(`upgrade the original run / ${pending?"already issued stale join":"stranded ambiguous writer"}`,
	{skip:before?false:"requires FOUNDRY_RELEASE_BEFORE"},async t=>{
	const old=await import(pathToFileURL(path.resolve(before ?? "", "test/fixture.mjs")).href);
	const f=fixture(t,["consumer","producer"],`has("producer/done")`,undefined,old.factory);
	await f.start();
	await f.scouts.find(s=>s.squad==="producer")?.report(propose("producer"));
	await f.scouts.find(s=>s.squad==="consumer")?.report(readFile(api));
	await f.scouts.at(-1)?.report(propose("consumer",[api],pending?[]:["producer"]));
	const p=worker(f,"producer"); put(p.cwd,api,"v2"); put(p.cwd,"producer/done","yes");
	const events=new EventEmitter(), held=once(events,"held"), release=once(events,"release");
	let count=0;
	const writer=f.runtime(p.cwd,{execute:async(tool,args,id)=>{
		if(pending && tool==="bash" && String(args.description).startsWith("Check joined product")) {
			if(++count===1){events.emit("held");await release;}
			else if(count===2) await f.owner.operation("pause",{run},"owner");
		}
		return f.execute(tool,args,id);
	}});
	const first=writer.operation("submit",{run,token:p.token},p.id);
	try {
		if(pending) await Promise.race([held,first.then(()=>assert.fail("missing pending product"))]); else await first;
		const c=worker(f,"consumer"); assert.ok(c.prompt.includes(`Read-only supporting file: ${f.tip}:${api}`));
		put(c.cwd,stored,"v1"); await submit(f,c);
	} finally {events.emit("release");await first;}
	const db=openDatabase(f.root); t.after(()=>db.close());
	const saved=proof(f), state=db.read(run), stale=state?.join;
	assert.equal(saved.qualified,null); assert.ok(state);
	if(pending) {
		assert.ok(!saved.active && stale && state.effects.find(e=>e.id===stale.check)?.receipt?.exit===0);
		assert.equal(git(f.root,"show",`${stale.commit}:${stored}`),"v1");
	} else {
		assert.equal(saved.release?.reason,"include-admitted-work"); assert.equal(state.nodes.consumer.state,"published");
		assert.equal(saved.goal?.receipt?.exit,0); f.owner.turn("owner"); await f.owner.flush(); assert.equal(proof(f).qualified,null);
	}
	const checks=[...f.checks]; f.owner.close(); writer.close();
	const fixed=createRuntime(f.root,{mode:async()=>"interactive",permissionBlocker:async()=>null,execute:f.execute,notify:async()=>"notice"});
	t.after(()=>fixed.close());
	if(pending) await fixed.operation("resume",{source},"owner"); else {fixed.turn("owner");await fixed.flush();}
	const end=fixed.inspect({run,detail:"proof"},"owner"); assert.ok(end.qualified);
	assert.equal(git(f.root,"show",`${end.qualified}:${api}`),"v2"); assert.ok(!git(f.root,"ls-tree","-r","--name-only",end.qualified,"--",stored));
	const consumer=end.nodes.find(n=>n.grain==="consumer"); assert.equal(consumer?.state,"blocked");
	assert.deepEqual(consumer.receipt,saved.nodes.find(n=>n.grain==="consumer")?.receipt);
	if(stale) {
		assert.ok(!end.products?.some(p=>p.check===stale.check));
		assert.deepEqual(db.read(run)?.effects.find(e=>e.id===stale.check)?.receipt,state.effects.find(e=>e.id===stale.check)?.receipt);
	} else {assert.equal(end.qualified,saved.checkpoint);assert.deepEqual(end.goalChecks,saved.goalChecks);assert.deepEqual(f.checks,checks);}
});

for(const scenario of ["stopped","refused","unfunded writer","unfunded read","funded read","live","uncertain","held"]) test(`passing checkpoint obligations / ${scenario}`,async t=>{
	const read=scenario.endsWith("read"), capped=read || scenario==="unfunded writer";
	const f=fixture(t,["core","side"],`has("core/ok")`,capped ? scenario==="funded read"?5:4 : undefined);
	let manual=false;
	const owner=f.runtime(f.root,{execute:async(tool,args,call)=>{
		if(tool==="create_session" && String(args.name).startsWith("side ")) {
			if(scenario==="refused") return {resultType:"denied"};
			if(scenario==="uncertain") throw Error("launch acknowledgement lost");
		}
		return f.execute(tool,args,call);
	},permissionBlocker:async()=>manual ? {scope:"session",message:"Manual dispatch hold."} : null});
	await f.start(owner);
	for(const s of [...f.scouts]) await s.report(s.squad==="core"?propose("core"):noGap("side"));
	const artifact=(await owner.operation("publish",{run,file:"reference",to:["side"]},"owner")).artifacts[0];
	const core=worker(f,"core"), events=new EventEmitter(), held=once(events,"held"), release=once(events,"release");
	const issuer=f.runtime(core.cwd,{execute:async(tool,args,call)=>{
		if(tool==="bash" && String(args.description).startsWith("Check final goal")) {events.emit("held"); await release;}
		return f.execute(tool,args,call);
	}});
	put(core.cwd,"core/ok","yes");
	const first=issuer.operation("submit",{run,token:core.token},core.id);
	try {
		await Promise.race([held,first.then(()=>assert.fail("missing issued goal"))]);
		const product=proof(f).products?.at(-1); assert.ok(product);
		await owner.operation("iterate",{run,directory:"side",receipt:product.check,blob:artifact.blob,question:"Compare the side output."},"owner");
		await f.settle();
		const job=f.scouts.at(-1); assert.equal(job?.squad,"side");
		manual=scenario==="held";
		await job.report(read?readFile("manual/next"):propose("side"));
		if(scenario==="stopped") {
			const w=worker(f,"side");
			await f.runtime(w.cwd).operation("submit",{run,token:w.token,missingInput:"Reference is unavailable."},w.id);
		}
		events.emit("release"); await first; await f.settle();
		const end=proof(f); assert.equal(end.goal?.receipt?.exit,0); assert.equal(end.checkpoint,product.commit);
		if(["live","uncertain","held","funded read"].includes(scenario)) {
			assert.equal(end.qualified,null);
			if(scenario==="live") {
				const w=worker(f,"side"); put(w.cwd,"side/ok","yes"); await submit(f,w);
				assert.ok(proof(f).qualified && proof(f).qualified!==product.commit);
			} else if(scenario==="funded read") {
				const next=f.scouts.at(-1); assert.ok(next && next.id!==job.id); await next.report(noGap("side"));
				assert.equal(proof(f).qualified,product.commit);
			} else assert.ok(end.pending.some(e=>e.grain==="side" && (scenario==="held"?!!e.reason:e.state==="uncertain")));
		} else {
			assert.equal(end.qualified,product.commit);
			assert.equal(end.qualification?.receipts.goal.commit,product.commit);
			assert.equal(end.qualification?.receipts.product.commit,product.commit);
			assert.equal(f.checks.filter(c=>c.startsWith("Check final goal")).length,2);
			const db=openDatabase(f.root); t.after(()=>db.close());
			const note=db.read(run)?.effects.find(e=>e.kind==="handoff")?.args.message;
			assert.match(String(note),scenario==="stopped"?/Reference is unavailable/:scenario==="refused"?/permission refused/:/no assignment remains/i);
		}
	} finally {events.emit("release"); await first;}
});

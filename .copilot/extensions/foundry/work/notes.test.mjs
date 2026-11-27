import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { observe, parseObservation } from "./graph.mjs";
import { factory, git, put } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { createRuntime } from "./runtime.mjs";

test("a saved single-directory report names its checked consumer and is admitted once that dependency clears",async t=>{
	const run="measure",source=".foundry/measure.json",build=await historicalFactory(t,90);
	const make=(/** @type {string} */ id,/** @type {string} */ dir,/** @type {string[]} */ needs=[])=>({id,directory:dir,task:`Implement ${id}.`,check:"unit.mjs",needs});
	const f=build(t,run,source,{[source]:JSON.stringify({version:2,id:run,target:"refs/heads/main",direction:"Render a checked measurement.",
		goalCheck:"goal.mjs",productCheck:"unit.mjs",squads:["data","display"].map(id=>({id,charter:id+".md",areas:[id],checks:["unit.mjs"]}))}),
		".foundry/measure/journey.md":"Provide the measurement and label.","data.md":"Keep measurement.","display.md":"Keep label.","unit.mjs":"",
		"goal.mjs":'import {existsSync as has} from "node:fs";process.exit(has("display/label/value")?2:1);'});
	await f.start();const db=openDatabase(f.root);t.after(()=>db.close());const read=()=>db.read(run)??assert.fail();
	for(const [s,g] of /** @type {const} */([["data",make("producer","data/item")],["display",make("consumer","display/label",["producer"])]])){
		const scout=f.scouts.find(r=>r.squad===s);assert.ok(scout);await scout.report({outcome:"regenerate",reason:"Produce the requested output.",evidence:[s+".md"],grains:[g]});
	}
	for(const [id,dir] of [["producer","data/item"],["consumer","display/label"]]){
		const w=f.workers.get(read().nodes[id].worker??"");assert.ok(w);put(w.cwd,dir+"/value",id);
		await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id);await f.settle();
	}
	for(const scout of f.scouts.slice(2))if(read().effects.some(e=>e.id===scout.id && e.state==="issued"))
		await scout.report({outcome:"no-gap",reason:"No other work.",evidence:[scout.squad+".md"],grains:[]});
	const basis=read(),p=basis.products.at(-1),at=basis.goal;assert.ok(p && at);const before=basis.nodes.consumer;
	async function compare(/** @type {typeof f.owner} */ owner,/** @type {string} */ dir,/** @type {string} */ prior,/** @type {string} */ next){
		put(f.root,next+".txt",`A distinct task for ${dir}.`);const [a]=(await owner.operation("publish",{run,file:next+".txt",to:[dir]},"owner")).artifacts.filter(a=>a.file===next+".txt");
		const file=dir+"/value";
		await owner.operation("iterate",{run,directory:dir,receipt:at?.check,blob:a.blob,source:{file,excerpt:prior,commit:p?.commit},question:`Provide ${next}.`},"owner");
		await f.settle();const r=f.scouts.at(-1);assert.ok(r && r.prompt.includes(next));await r.report({outcome:"regenerate",reason:`Provide ${next}.`,evidence:[file],grains:[make(next,dir)]});return r.id;
	}
	const old=f.runtime(f.root,{confirm:async()=>true}),id=await compare(old,"data/item","producer","new-data");old.close();
	const original=read().effects.find(r=>r.kind==="scout" && r.id===id);assert.ok(original?.kind==="scout" && original.error==="This comparison is for one independent directory: data/item");
	f.owner.close();const now=f.runtime(f.root,{confirm:async()=>true},createRuntime);now.turn("owner");await now.flush();
	const held=read().effects.find(r=>r.id===id);assert.match(held?.error??"",/consumer.*display\/label/);assert.deepEqual(read().nodes.consumer,before);
	assert.ok(!read().nodes["new-data"]);assert.equal(held?.workflowId,original.workflowId);
	await compare(now,"display/label","consumer","new-label");now.turn("owner");await now.flush();
	const end=read(),report=end.effects.find(r=>r.id===id);assert.equal(report?.state,"observed");assert.equal(report.workflowId,original.workflowId);
	assert.equal(end.nodes["new-data"].review,id);assert.equal(end.nodes["new-data"].state,"writing");
	assert.ok(end.nodes["new-label"].worker);assert.deepEqual(end.products,basis.products);assert.equal(end.effects.filter(e=>e.kind==="scout" && e.retryOf===id).length,0);
});

for (const stranded of [true, false]) test(`noted checkpoint comparison keeps its evidence and only staffs its directory / ${stranded ? "reconnect after failed goal" : "bounded first dispatch"}`, async t => {
	const run = "chart", source = ".foundry/chart.json", directory = "screen/layout", charter = "screen.md", check = "unit.mjs";
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 2, id: run, target: "refs/heads/main", direction: "Display a plotted value.",
		goalCheck: "goal.mjs", productCheck: check, squads: [{ id: "screen", charter, areas: ["screen"], checks: [check] }] }),
		[charter]: "Plot the value beside its legend.", [check]: "", ".foundry/chart/journey.md": "Show the plotted value.",
		"goal.mjs": `import {existsSync} from "node:fs"; if (!existsSync("${directory}/legend")) {console.log("screen/chart: legend missing"); process.exit(1)}`,
		...Object.fromEntries(Array.from({length: 300}, (_, i) => [`screen/archive/${i}-unrelated-panel.txt`, `archived ${i}`])),
	});
	const change = (/** @type {string} */ id, /** @type {string} */ path, /** @type {string[]} */ needs = []) =>
		({ outcome:"regenerate", evidence:[charter], reason:"The graph needs the checked value.", grains:[{id, directory:path, check, needs, task:`Implement ${id}.`}] });
	await f.start();
	const before = await f.owner.operation("status", { run, detail:"proof" }, "owner"), historical = before.goalChecks?.[0]; assert.ok(historical);
	await f.scouts[0].report(change("input", "screen/input"));
	const [w] = f.workers.values(), events = new EventEmitter(), pending = once(events, "pending"), release = once(events, "release");
	const writer = f.runtime(w.cwd, {execute: async (tool, args, id) => {
		if (tool === "bash" && String(args.description).includes("final goal")) { events.emit("pending"); await release; }
		return f.execute(tool, args, id);
	}});
	put(w.cwd, "screen/input/value", "42");
	const submit = writer.operation("submit", {run, token:w.token}, w.id);
	const db = openDatabase(f.root); t.after(() => db.close());
	const question = "Keep the legend beside the value.", note = "Preserve the previously observed missing legend.";
	let budget = stranded ? 1 : 14000;
	const issuer = f.runtime(f.root, { scoutBudget: async () => budget });
	let original, checkpoint, blob;
	try {
		await Promise.race([pending, submit.then(() => assert.fail("expected the checkpoint goal in flight"))]);
		checkpoint = (await f.status()).products?.at(-1); assert.ok(checkpoint);
		await issuer.operation("review_note", {run, squad:"screen", receipt:historical.id, question:note}, "owner");
		put(f.root, "comparison.txt", "Use the compact legend.");
		[{blob}] = (await issuer.operation("publish", {run, file:"comparison.txt", to:[directory]}, "owner")).artifacts;
		await issuer.operation("iterate", {run, directory, blob, receipt:checkpoint.check, question}, "owner"); await f.settle();
		original = (await f.status()).reviews.at(-1); assert.ok(original?.workflowId && original.note?.receipt === historical.id);
		assert.equal(original.iteration?.basis, "checkpoint");
		if (stranded) { assert.match(String(original.reason), /pinned file index/); issuer.close(); }
		else assert.equal(original.state, "reading", String(original.reason));
	} finally { events.emit("release"); await submit; }
	const settled = await f.owner.operation("status", {run, detail:"proof"}, "owner"), verdict = settled.goalChecks?.at(-1);
	assert.ok(verdict?.receipt?.exit === 1 && verdict.commit === checkpoint.commit);
	const checks = [...f.checks], args = {run, review:original.id};
	if (stranded) {
		const retry = f.runtime(f.root, { scoutBudget: async () => budget, confirmNoReport: async prior => {
			assert.equal(prior.workflowId, original.workflowId); assert.equal(prior.packet, undefined);
		} });
		const recover = () => retry.operation("rereview", args, "owner");
		await assert.rejects(recover(), /scout budget/);
		assert.deepEqual((await f.status()).reviews.at(-1), original);
		budget = 14000;
		const race = await Promise.allSettled([recover(), recover()]);
		assert.equal(race.filter(r => r.status === "fulfilled").length, 1, JSON.stringify(race.map(r => r.status === "rejected" ? String(r.reason) : r.status)));
		await f.settle();
		assert.deepEqual((await f.status()).reviews.find(r => r.id === original.id), original);
	}
	let focused = f.scouts.at(-1); assert.ok(focused && focused.base === checkpoint.commit);
	assert.equal(f.scouts.length, 2);
	for (const s of [question, note, historical.id, blob, checkpoint.check]) assert.ok(focused.prompt.includes(s), s);
	assert.ok(focused.packet.partial && Buffer.byteLength(focused.prompt) <= budget);
	// Follow the historical note by its exact receipt; neither a retry nor a page widens the comparison.
	await focused.report({outcome:"needs-evidence", evidence:[charter], grains:[], receipt:historical.id, reason:"Check the earlier diagnostic."});
	focused = f.scouts.at(-1); assert.ok(focused && focused.packet.read?.source === `receipt:${historical.id}`);
	assert.ok(focused.prompt.includes(question) && focused.prompt.includes(note));
	const snapshot = structuredClone(db.read(run)); assert.ok(snapshot);
	const page = snapshot.effects.find(e => e.id === focused.id); assert.ok(page?.kind === "scout");
	page.packet = focused.packet;
	assert.throws(() => observe(f.root, snapshot, page, parseObservation(snapshot.policy.squads[0], change("other", "screen/other"))), /one independent directory/);
	assert.ok(!snapshot.nodes.other);
	await focused.report(change("layout", directory, ["input"]));
	const repaired = (await f.status()).nodes.find(n => n.grain === "layout"), worker = f.workers.get(repaired?.worker ?? "");
	assert.ok(worker && worker.prompt.includes(blob)); assert.equal(f.workers.size, 2);
	assert.deepEqual(f.checks, checks);
	put(worker.cwd, `${directory}/legend`, "compact"); await f.runtime(worker.cwd).operation("submit", {run, token:worker.token}, worker.id);
	const after = await f.owner.operation("status", {run, detail:"proof"}, "owner");
	assert.ok(after.qualified && after.qualified !== checkpoint.commit);
	assert.equal(git(f.root, "show", `${after.qualified}:${directory}/legend`), "compact");
	assert.deepEqual(after.goalChecks?.filter(g => g.commit === checkpoint.commit), [verdict]);
	assert.equal(db.read(run)?.effects.filter(e => e.kind === "scout" && e.retryOf === original.id).length, Number(stranded));
});

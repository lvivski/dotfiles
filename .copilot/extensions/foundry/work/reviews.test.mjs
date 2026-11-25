import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "./database.mjs";
import { observe, parseObservation, reserveIteration } from "./graph.mjs";
import { prepareReuse } from "./reuse.mjs";
import { exhaustedCandidate } from "./evidence.mjs";
import { status } from "./status.mjs";
import { factory, git, loadEntry, put } from "../test/fixture.mjs";
import { historicalFactory } from "../test/legacy-readers.mjs";
import { createRuntime } from "./runtime.mjs";

test("a scoped comparison can start product work alongside an independent writer without repeating release validation", async t => {
	const run = "panels", source = ".foundry/panels.json";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ id: run, version: 2, target: "refs/heads/main", direction: "Build a working chart.", goalCheck: "goal.mjs", productCheck: "unit.mjs",
			squads: ["screen", "data"].map(id => ({ id, charter: `${id}.md`, areas: [id], checks: ["unit.mjs"] })) }),
		".foundry/panels/journey.md": "Inspect the real product.", "screen.md": "The graph must stay visible next to its legend.",
		"data.md": "Publish the data.", "unit.mjs": "", "goal.mjs": "process.exit(1);",
	});
	await f.start();
	const screen = f.scouts.find(s => s.squad === "screen"), data = f.scouts.find(s => s.squad === "data"); assert.ok(screen && data);
	await screen.report({ outcome: "no-gap", reason: "No mismatch in this evidence.", evidence: ["screen.md"], grains: [] });
	await data.report({ outcome: "regenerate", reason: "Produce independent data.", evidence: ["data.md"],
		grains: [{ id: "input", directory: "data/input", check: "unit.mjs", task: "Produce the values.", needs: [] }] });
	const file = "references/comparison.txt", expected = "At normal width the legend displaces the graph.";
	put(f.root, file, "wide ".repeat(12000) + expected + " end".repeat(12000));
	const [artifact] = (await f.owner.operation("publish", { run, file, to: ["screen/layout"] }, "owner")).artifacts;
	put(f.root, file, "Unselected private reference");
	await f.owner.operation("publish", { run, file, to: ["data/input"] }, "owner");
	const [receipt] = (await f.owner.operation("status", { run, detail: "proof" }, "owner")).goalChecks ?? [];
	const args = { run, directory: "screen/layout", blob: artifact.blob, receipt: receipt.id, question: "Keep the graph wider than the legend." };
	const checks = [...f.checks];
	assert.equal(f.scouts.length, 2, "an ordinary reference offer isn't an assignment");
	await f.runtime(f.root,{scoutBudget:async () => 16000}).operation("iterate", args, "owner"); await f.settle();
	let focused = f.scouts.at(-1); assert.ok(focused && focused.squad === "screen" && focused.id !== screen.id);
	assert.ok(focused.prompt.includes(args.question) && focused.prompt.includes(artifact.blob));
	await f.runtime(f.root).operation("iterate", args, "owner"); await f.settle(); assert.equal(f.scouts.length, 3);
	await assert.rejects(f.owner.operation("iterate", { ...args, directory: "data/input" }, "owner"), /not offered/);
	await assert.rejects(f.owner.operation("iterate", args, "worker-1"), /owner/);
	assert.ok(focused.packet.sources?.includes(`detail:${artifact.blob}`), "scout can request the immutable comparison");
	assert.ok(!focused.prompt.includes(expected) && !focused.prompt.includes("Unselected private reference"));
	await focused.report({outcome:"needs-evidence",detail:artifact.blob,match:"At normal width",reason:"Read the observed layout.",evidence:["screen.md"],grains:[]});
	focused = f.scouts.at(-1); assert.ok(focused?.packet.read?.source === `detail:${artifact.blob}`);
	assert.ok(focused.prompt.includes(expected) && !focused.prompt.includes("Unselected private reference") && Buffer.byteLength(focused.prompt) <= 16000);
	assert.ok(!Object.hasOwn(focused.packet.files,file) && focused.packet.excerpt?.path !== file);
	await focused.report({ outcome: "regenerate", reason: "Implement the observed sizing change.", evidence: ["screen.md"],
		grains: [{ id: "layout", directory: args.directory, check: "unit.mjs", task: "Give the graph the larger column.", needs: [] }] });
	assert.equal(f.workers.size, 2); assert.deepEqual(f.checks, checks);
	const status = await f.status();
	assert.deepEqual(status.nodes.filter(n => n.state === "writing").map(n => n.grain).sort(), ["input", "layout"]);
	assert.equal(status.qualified, null);
});

for (const saved of [false, true]) test(`unmet-goal comparison fits its directory and delivers the repair / ${saved ? "recover with two checked inputs" : "fresh root comparison"}`, async t => {
	const run = "dashboard", source = ".foundry/dashboard.json", directory = saved ? "screen/layout" : "screen", budget = 16000;
	const f = factory(t, run, source, {
		[source]: JSON.stringify({id:run, version:2, target:"refs/heads/main", direction:"Display the current values.", goalCheck:"goal.mjs", productCheck:"unit.mjs",
			squads:["screen", "data"].map(id => ({id, charter:`${id}.md`, areas:[id], checks:["unit.mjs"]}))}),
		".foundry/dashboard/journey.md":"Open the dashboard.", "screen.md":"Show both values.", "data.md":"Supply the requested values.", "unit.mjs":"",
		"goal.mjs":`import {existsSync} from "node:fs"; process.exit(existsSync("${directory}/ready") ? 0 : 1);`,
		[`${directory}/view`]:"Dashboard has no ready state.",
		...Object.fromEntries(Array.from({length:350}, (_, i) => [`${saved ? "screen/archive" : "archive"}/${i}-unrelated-dashboard-panel.txt`, "unrelated"])),
	});
	const quiet = (/** @type {string} */ squad) => ({outcome:"no-gap", reason:"No work from the initial survey.", evidence:[`${squad}.md`], grains:[]});
	await f.start();
	const screen = f.scouts.find(s => s.squad === "screen"), data = f.scouts.find(s => s.squad === "data"); assert.ok(screen && data);
	await screen.report(quiet("screen"));
	const needs = saved ? ["first", "second"] : [];
	if (saved) {
		await data.report({outcome:"regenerate", reason:"Supply both values independently.", evidence:["data.md"],
			grains:needs.map(id => ({id, directory:`data/${id}`, task:`Supply ${id}.`, check:"unit.mjs", needs:[]}))});
		const inputs = await f.status();
		for (const id of needs) {
			const w = f.workers.get(inputs.nodes.find(n => n.grain === id)?.worker ?? ""); assert.ok(w);
			put(w.cwd, `data/${id}/value`, id); await f.runtime(w.cwd).operation("submit", {run, token:w.token}, w.id);
		}
		for (const s of f.scouts.slice(2)) await s.report(quiet(s.squad));
	} else await data.report(quiet("data"));
	const before = await f.owner.operation("status", {run, detail:"proof"}, "owner"), goal = before.goalChecks?.at(-1);
	assert.ok(goal?.receipt?.exit === 1);
	put(f.root, "comparison.txt", "The dashboard opens without displaying the ready state.");
	const [offer] = (await f.owner.operation("publish", {run, file:"comparison.txt", to:[directory]}, "owner")).artifacts;
	const checks = [...f.checks], count = f.scouts.length, question = "Which change makes the ready state visible?";
	const issuer = f.runtime(f.root, {scoutBudget:async () => saved ? 1 : budget});
	await issuer.operation("iterate", {run, directory, blob:offer.blob, question, receipt:goal.id}, "owner"); await f.settle();
	const original = (await f.status()).reviews.at(-1); assert.ok(original && !original.iteration?.basis);
	if (saved) {
		assert.match(String(original.reason), /pinned file index/); assert.equal(f.scouts.length, count);
		issuer.close();
		await f.runtime(f.root, {scoutBudget:async () => budget, confirmNoReport:async r => {
			assert.equal(r.id, original.id); assert.equal(r.packet, undefined);
		}}).operation("rereview", {run, review:original.id}, "owner"); await f.settle();
		assert.deepEqual((await f.status()).reviews.find(r => r.id === original.id), original);
	}
	assert.equal(f.scouts.length, count + 1, String(original.reason));
	const scout = f.scouts.at(-1); assert.ok(scout && scout.base === goal.commit);
	assert.ok(scout.packet.partial && Buffer.byteLength(scout.prompt) <= budget && scout.packet.files[`${directory}/view`]);
	for (const marker of [offer.blob, goal.id, question]) assert.ok(scout.prompt.includes(marker), marker);
	for (const id of needs) assert.equal(scout.packet.outputs[id], before.products?.at(-1)?.outputs[id]);
	await scout.report({outcome:"regenerate", reason:"Display the supplied values when ready.", evidence:[`${directory}/view`],
		grains:[{id:"render", directory, needs, task:"Display the ready state.", check:"unit.mjs"}]});
	const worker = f.workers.get((await f.status()).nodes.find(n => n.grain === "render")?.worker ?? "");
	assert.ok(worker); assert.deepEqual(f.checks, checks);
	for (const id of needs) assert.equal(git(worker.cwd, "show", `HEAD:data/${id}/value`), id);
	put(worker.cwd, `${directory}/ready`, "visible"); await f.runtime(worker.cwd).operation("submit", {run, token:worker.token}, worker.id);
	const after = await f.owner.operation("status", {run, detail:"proof"}, "owner");
	assert.ok(after.qualified && after.goal?.receipt?.commit === after.qualified);
	assert.equal(git(f.root, "show", `${after.qualified}:${directory}/ready`), "visible");
	assert.deepEqual(after.goalChecks?.find(g => g.id === goal.id), goal);
});

for (const scenario of ["pending", "superseded", "changed input", "pass during review"]) test(`a checked checkpoint can staff an independent comparison without qualifying the old tree: ${scenario}`, async t => {
	const run = "pending", source = ".foundry/pending.json", goalCheck = ".foundry/pending/goal.mjs";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({id: run, version: 2, target: "refs/heads/main", direction: "Show a graph with its data.", goalCheck, productCheck: "unit.mjs",
			squads: ["screen", "data"].map(id => ({id, charter: `${id}.md`, areas: [id], checks: ["unit.mjs"]}))}),
		".foundry/pending/journey.md": "Show data and legend.", "screen.md": "Build the graph.", "data.md": "Supply data.",
		"layout-guide.txt": "The legend must fit beside the graph.",
		"unit.mjs": "", [goalCheck]: 'import {existsSync} from "node:fs"; process.exit(existsSync("data/input/value") ? 0 : 1);',
	});
	const file = "comparison.txt"; put(f.root, file, "The legend hides the data.");
	await f.start(); const [artifact] = (await f.owner.operation("publish", {run, file, to: ["screen/layout"]}, "owner")).artifacts;
	const original = (await f.owner.operation("status", {run, detail:"proof"}, "owner")).goalChecks?.[0]; assert.ok(original);
	const screen = f.scouts.find(r => r.squad === "screen"), data = f.scouts.find(r => r.squad === "data"); assert.ok(screen && data);
	await screen.report({outcome:"no-gap", reason:"No layout comparison yet.", grains:[], evidence:["screen.md"]});
	await data.report({outcome:"regenerate", reason:"Provide data.", evidence:["data.md"], grains:[{id:"input",directory:"data/input",task:"Generate the values.",check:"unit.mjs",needs:[]}]});
	const [w] = f.workers.values(), events = new EventEmitter(), waiting = once(events, "pending"), release = once(events, "release");
	const writer = f.runtime(w.cwd, {execute: async (tool, args, id) => {
		if (tool === "bash" && String(args.description).includes("final goal")) { events.emit("pending"); await release; }
		return f.execute(tool,args,id);
	}});
	put(w.cwd, "data/input/value", "42");
	const first = writer.operation("submit", {run,token:w.token}, w.id);
	try {
		await Promise.race([waiting, first.then(() => assert.fail("Expected an in-flight goal"))]);
		if (scenario === "superseded") {
			const side = path.join(path.dirname(f.root), "evaluator");
			git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
			put(side, goalCheck, readFileSync(path.join(side, goalCheck), "utf8") + "\n// Correct diagnostic.\n");
			git(side, "commit", "-qam", "Reviewed evaluator");
			await f.runtime(f.root, {confirm: async () => true}).operation("repin", {run, from:f.tip, revision:git(side,"rev-parse","HEAD"), files:[goalCheck]}, "owner");
		}
		const status = await f.status(), checkpoint = status.products?.at(-1); assert.ok(checkpoint?.receipt?.exit === 0);
		const checks = [...f.checks], scoutCount = f.scouts.length;
		const input = {run, directory:"screen/layout", blob:artifact.blob, receipt:checkpoint.check, question:"Keep the data visible beside the legend."};
		if (scenario === "pending") {
			await f.owner.operation("configure", {run, revision:0, checkpointReviews:false}, "owner");
			await assert.rejects(f.owner.operation("iterate", input, "owner"), /scheduling policy/);
			await f.owner.operation("configure", {run, revision:1, checkpointReviews:true}, "owner");
		}
		await assert.rejects(f.owner.operation("iterate", {...input, receipt:original.id}, "owner"), /checkpoint/);
		await f.owner.operation("iterate", input, "owner"); await f.settle();
		await f.runtime(f.root).operation("iterate", {...input, question:"Same comparison."}, "owner"); await f.settle();
		assert.equal(f.scouts.length, scoutCount + 1);
		let review = f.scouts.at(-1); assert.ok(review && review.base === checkpoint.commit && review.prompt.includes(input.question));
		assert.match(review.prompt, /passing product checkpoint, not a goal verdict/);
		if (scenario === "pending") await f.owner.operation("configure", {run, revision:2, checkpointReviews:false}, "owner");
		if (scenario === "pass during review") {
			events.emit("release"); await first;
			assert.equal((await f.status()).qualified, null);
			await review.report({outcome:"needs-evidence",reason:"Check the layout rule.",evidence:["screen.md"],file:"layout-guide.txt",grains:[]});
			review = f.scouts.at(-1); assert.ok(review && review.prompt.includes("The legend must fit beside the graph.") && review.prompt.includes(input.question));
		}
		await review.report({outcome:"regenerate",reason:"Use the checked values beside the narrower legend.",evidence:["screen.md"],
			grains:[{id:"layout",directory:input.directory,check:"unit.mjs",task:"Resize the graphic.",needs:["input"]}]});
		const worker = [...f.workers.values()].find(x => x.id !== w.id); assert.ok(worker, "writer must start before the goal returns");
		assert.equal(git(worker.cwd, "show", "HEAD:data/input/value"), "42");
		assert.equal(f.checks.length, checks.length + Number(scenario === "pass during review"));
		assert.equal(f.scouts.length, scoutCount + (scenario === "pass during review" ? 2 : 1));
		put(f.root, "comparison.txt", "A different comparison of the same live pane.");
		const [other] = (await f.owner.operation("publish", {run,file,to:[input.directory]},"owner")).artifacts.filter(a => a.blob !== input.blob);
		await assert.rejects(f.owner.operation("iterate",{...input,blob:other.blob},"owner"), /existing assignment|checkpoint/);
		if (scenario === "changed input") {
			put(f.root, "data/input/value", "99"); git(f.root,"add","data/input/value"); git(f.root,"commit","-qm","Change the checked prerequisite");
		}
		put(worker.cwd, "screen/layout/legend", "narrow"); await f.runtime(worker.cwd).operation("submit",{run,token:worker.token},worker.id);
		const pending = await f.status();
		if (scenario !== "pass during review") {
			assert.equal(pending.nodes.find(n => n.grain === "layout")?.state,"published");
			assert.equal(pending.checkpoint, checkpoint.commit); assert.equal(pending.qualified,null);
		}
	} finally { events.emit("release"); await first; }
	const result = await f.status();
	if (scenario === "changed input") {
		assert.equal(result.qualified, null); assert.equal(result.products?.length, 1); assert.match(result.blocker ?? "", /modification|changed/i); return;
	}
	assert.ok(result.qualified && result.qualified === result.goal?.receipt?.commit);
	assert.equal(git(f.root, "show", `${result.qualified}:screen/layout/legend`), "narrow");
	assert.equal(result.products?.at(-1)?.receipt?.commit, result.qualified);
});

for (const scenario of ["repair","recover omitted source","unsupported","cited sibling changed","target moved during approval"]) test(`new source comparison after settled exit 2 / ${scenario}`, async t => {
	const run = "codec", plan = ".foundry/codec.json", directory = "format/decode", output = `${directory}/mode`, excerpt = "legacy";
	const sibling = scenario==="cited sibling changed", file = sibling ? "format/rules/version" : output;
	const modeText = " ".repeat(50000) + excerpt + ": mode table\n" + " ".repeat(20000) + "alternate mode";
	const f = factory(t,run,plan,{
		[plan]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Decode the current format.",productCheck:"unit.mjs",goalCheck:"goal.mjs",
			squads:["format","input"].map(id=>({id,charter:`${id}.md`,areas:[id],checks:["unit.mjs"]}))}),
		".foundry/codec/journey.md":"Decode a checked sample.","format.md":"Read the current format.","input.md":"Supply a sample and an independent index.",
		...(sibling ? Object.fromEntries(Array.from({length:240}, (_,i)=>[`${directory}/table/${i}`,"entry"])) : {}),
		"unit.mjs":"", [file]:modeText, "goal.mjs":`import {existsSync} from "node:fs";
			if (!existsSync("input/sample/value")) process.exit(1);
			console.log("Release observation unavailable."); process.exit(2);`,
	});
	await f.start();
	const format=f.scouts.find(s=>s.squad==="format"), input=f.scouts.find(s=>s.squad==="input"); assert.ok(format && input);
	await format.report({outcome:sibling?"regenerate":"no-gap",reason:sibling?"Maintain the format rules.":"No mismatch on initial survey.",
		grains:sibling?[{id:"rules",directory:"format/rules",check:"unit.mjs",task:"Maintain the rules.",needs:[]}]:[],evidence:["format.md"]});
	await input.report({outcome:"regenerate",reason:"Provide independent inputs.",evidence:["input.md"],grains:["sample","index"].map(id=>({
		id,directory:`input/${id}`,check:"unit.mjs",task:`Build ${id}.`,needs:[]}))});
	const nodes=(await f.status()).nodes, sample=f.workers.get(nodes.find(n=>n.grain==="sample")?.worker ?? ""), peer=f.workers.get(nodes.find(n=>n.grain==="index")?.worker ?? "");
	assert.ok(sample && peer);
	put(sample.cwd,"input/sample/value","v2"); await f.runtime(sample.cwd).operation("submit",{run,token:sample.token},sample.id); await f.settle();
	const proof=()=>f.owner.inspect({run,detail:"proof"},"owner");
	const before=proof(), at=before.goalChecks?.at(-1); assert.ok(at?.receipt?.exit===2 && at.commit && at.commit===before.checkpoint && at.commit!==f.tip);
	const source={commit:at.commit,file,excerpt}, reference="references/format.txt", question="Does the decoder support the checked sample?";
	put(f.root,reference,"Decoder should use current mode."); const [offer]=(await f.owner.operation("publish",{run,file:reference,to:[directory,"input/index"]},"owner")).artifacts;
	const args={run,receipt:at.id,directory,blob:offer.blob,question,source};
	const checks=[...f.checks], scouts=f.scouts.length, workers=f.workers.size; let approvals=0;
	const owner=f.runtime(f.root,{scoutBudget:async()=>16000,confirm:async prompt=>{
		approvals++; for(const s of [at.id,source.commit,source.file,excerpt,offer.blob,directory,question]) assert.ok(prompt.includes(s),s);
		if(scenario==="target moved during approval"){put(f.root,"unrelated","edit");git(f.root,"add","unrelated");git(f.root,"commit","-qm","Advance target");}
		return true;
	}});
	await assert.rejects(f.runtime(f.root,{confirm:async()=>false}).operation("iterate",args,"owner"),/not approved/i);
	await assert.rejects(owner.operation("iterate",args,peer.id),/owner/);
	await assert.rejects(owner.operation("iterate",{...args,source:{...source,commit:f.tip}},"owner"),/checked product/);
	await assert.rejects(owner.operation("iterate",{...args,source:{...source,excerpt:"not in file"}},"owner"),/verbatim/);
	await assert.rejects(owner.operation("iterate",{...args,source:{...source,file:"input/sample/value",excerpt:"v2"}},"owner"),/writable areas/);
	await assert.rejects(owner.operation("iterate",{...args,directory:"input/index",source:{...source,file:"input/sample/value",excerpt:"v2"}},"owner"),/existing assignment/);
	assert.equal(approvals,0); assert.equal(f.scouts.length,scouts);
	if(scenario==="target moved during approval"){
		await assert.rejects(owner.operation("iterate",args,"owner"),/checked product|target/);
		assert.equal(f.scouts.length,scouts); assert.deepEqual(f.checks,checks); return;
	}
	await owner.operation("iterate",args,"owner"); await f.settle();
	await owner.operation("iterate",args,"owner"); await f.settle();
	await assert.rejects(owner.operation("iterate",{...args,question:"A different question."},"owner"),/existing review/);
	assert.equal(approvals,1); assert.equal(f.scouts.length,scouts+1); assert.equal(f.workers.size,workers); assert.deepEqual(f.checks,checks);
	let review=f.scouts.at(-1); assert.ok(review && review.base===at.commit);
	if(scenario==="recover omitted source"){
		const original=review, request={run,review:original.id};
		// Model the old workflow's actual delivery: charter text, but only an index entry for the source.
		delete original.packet.excerpt; delete original.packet.read;
		assert.ok(original.packet.partial && original.packet.files["format.md"] && !original.packet.files[file]);
		const report={outcome:"needs-evidence",reason:"Need surrounding mode definitions.",file,match:excerpt,evidence:[file],grains:[]};
		await original.report(report);
		const blocked=proof().reviews.at(-1); assert.ok(blocked?.state==="blocked");
		assert.equal(blocked.reason,`Text of ${file} at ${git(f.root,"rev-parse",`${at.commit}:${file}`)} was not delivered in this packet`);
		owner.close();
		const recover=f.runtime(f.root,{scoutBudget:async()=>16000,confirm:async()=>assert.fail("the omitted source was already approved")});
		await assert.rejects(recover.operation("rereview",request,peer.id),{code:"foreign_run"});
		await assert.rejects(f.runtime(f.root,{scoutBudget:async()=>1}).operation("rereview",request,"owner"),{code:"packet_budget"});
		await assert.rejects(f.runtime(f.root,{scoutBudget:async()=>{
			await f.owner.operation("configure",{run,revision:0,checkpointReviews:false},"owner");return 16000;
		}}).operation("rereview",request,"owner"),{code:"dispatch_held"});
		await f.owner.operation("configure",{run,revision:1,checkpointReviews:true},"owner");
		assert.equal(f.scouts.length,scouts+1);
		await recover.operation("rereview",request,"owner"); await f.settle();
		await assert.rejects(recover.operation("rereview",request,"owner"),/current|already/);
		await f.owner.scoutResult(run,original.dispatch,"owner",original.workflowId,original.id,report,original.packet);
		review=f.scouts.at(-1); assert.ok(review && review.id!==original.id && review.base===original.base);
		assert.equal(f.scouts.length,scouts+2); assert.equal(proof().reviews.at(-1)?.retryOf,original.id);
		assert.deepEqual(proof().reviews.find(r=>r.id===original.id),blocked);
		assert.deepEqual(proof().goalChecks,before.goalChecks); assert.equal(f.workers.size,workers); assert.deepEqual(f.checks,checks);
	}
	const part=review.packet.excerpt;
	assert.ok(part?.path===file, "first packet must deliver a citable range of the approved source");
	assert.equal(part.oid,git(f.root,"rev-parse",`${at.commit}:${file}`));
	assert.ok(part.start<=modeText.indexOf(excerpt) && part.end>=modeText.indexOf(excerpt)+excerpt.length);
	assert.ok(review.prompt.includes(JSON.stringify(modeText.slice(part.start,part.end))) && Buffer.byteLength(review.prompt)<=16000);
	if(sibling) assert.match(review.prompt,/File catalog \(paths only\)/);
	else assert.ok(review.prompt.includes(question));
	if(scenario==="unsupported"){
		await review.report({outcome:"regenerate",evidence:["format.md"],reason:"Repeat the request.",grains:[{id:"decode",directory,check:"unit.mjs",task:"Update decoder.",needs:[]}]});
		assert.equal(proof().reviews.at(-1)?.state,"blocked");
		await assert.rejects(owner.operation("rereview",{run,review:review.id},"owner"),{code:"not_recoverable"});
		assert.equal(f.workers.size,workers); assert.deepEqual(f.checks,checks); return;
	}
	if(!sibling){
		await review.report({outcome:"needs-evidence",reason:"Inspect the alternative.",file,match:"alternate mode",evidence:[file],grains:[]});
		review=f.scouts.at(-1); assert.ok(review?.packet.excerpt?.path===file);
		assert.equal(review.packet.read?.hit,modeText.indexOf("alternate mode"));
	}
	await review.report({outcome:"regenerate",evidence:[file],reason:"The checked mode is still legacy.",grains:[
		{id:"decode",directory,check:"unit.mjs",task:"Use current mode.",needs:["sample"]}]});
	const worker=f.workers.get(proof().nodes.find(n=>n.grain==="decode")?.worker ?? ""); assert.ok(worker);
	assert.deepEqual(f.checks,checks);
	let current=before;
	if(sibling){
		const rules=f.workers.get(nodes.find(n=>n.grain==="rules")?.worker ?? ""); assert.ok(rules);
		put(rules.cwd,file,"v3"); await f.runtime(rules.cwd).operation("submit",{run,token:rules.token},rules.id);
		current=proof(); assert.notEqual(current.checkpoint,before.checkpoint);
		assert.equal(git(f.root,"show",`${current.checkpoint}:${file}`),"v3");
		assert.deepEqual(current.goalChecks?.slice(0,-1),before.goalChecks);
	}
	put(worker.cwd,output,"current"); await f.runtime(worker.cwd).operation("submit",{run,token:worker.token},worker.id);
	const end=proof();
	if(sibling){
		const excluded=end.nodes.find(n=>n.grain==="decode");
		assert.equal(excluded?.state,"blocked"); assert.match(excluded.reason ?? "",/frozen evidence.*changed before integration/);
		assert.equal(end.checkpoint,current.checkpoint);
		assert.deepEqual(end.goalChecks,current.goalChecks); return;
	}
	assert.notEqual(end.checkpoint,at.commit); assert.ok(end.checkpoint); assert.equal(git(f.root,"show",`${end.checkpoint}:${output}`),"current");
	assert.equal(end.goal?.receipt?.exit,2); assert.equal(end.qualified,null); assert.deepEqual(end.goalChecks?.slice(0,-1),before.goalChecks);
	assert.deepEqual(end.nodes.find(n=>n.worker===peer.id),before.nodes.find(n=>n.worker===peer.id));
});

for (const scenario of ["manual renewal","reader 64 recovery","Autopilot renewal","Allow All renewal","Autopilot with a product question","Interactive with a product question","new approval","declined","unanswered","missing input pin","target moved during preflight","owned scope with a checked consumer"])
test(`renew a superseded source comparison on its original run after a disjoint writer joins: ${scenario}`, async t => {
	const run = "labels", plan = ".foundry/labels.json", file = "labels/spec/sample", directory = "labels/output";
	const ids = ["data","labels","palette"], unit = "unit.mjs";
	const startFactory = scenario==="new approval" ? factory : await historicalFactory(t,64);
	const f = startFactory(t,run,plan,{
		[plan]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Render labels in color.",productCheck:unit,goalCheck:"goal.mjs",
			squads:ids.map(id=>({id,charter:`${id}.md`,areas:[id],checks:[unit]}))}),
		".foundry/labels/journey.md":"Read the colored labels.", ...Object.fromEntries(ids.map(id=>[`${id}.md`,`Own ${id}.`])),
		[file]:"Units required", "palette/spec/sample":"Use blue", [unit]:"",
		"goal.mjs":`import {existsSync as has} from "node:fs"; process.exit(!has("data/input/value") ? 1 :
			has("labels/output/value") && has("palette/output/value") ? 0 : 2);`,
	});
	const report = (/** @type {string} */ id, /** @type {string} */ directory, /** @type {string} */ evidence) => ({
		outcome:"regenerate",reason:`Implement ${id}.`,evidence:[evidence],
		grains:[{id,directory,task:`Implement ${id}.`,check:unit,needs:id==="data"?[]:["data"]}],
	});
	const submit = async (/** @type {string} */ id, /** @type {string} */ file, /** @type {string} */ value) => {
		const w = f.workers.get((await f.status()).nodes.find(n=>n.grain===id)?.worker ?? ""); assert.ok(w,`No writer for ${id}`);
		put(w.cwd,file,value); await f.runtime(w.cwd).operation("submit",{run,token:w.token},w.id); await f.settle();
	};
	await f.start();
	const incumbent=scenario==="owned scope with a checked consumer";
	for (const s of [...f.scouts].sort((a,b)=>Number(b.squad==="labels")-Number(a.squad==="labels"))) {
		const data=report("data","data/input","data.md"), base=report("prior","labels/output","labels.md");
		base.grains[0].needs=[];
		if (incumbent) data.grains[0].needs=["prior"];
		await s.report(s.squad==="data" ? data : incumbent && s.squad==="labels" ? base :
			{outcome:"no-gap",evidence:[`${s.squad}.md`],reason:"Wait for data.",grains:[]});
	}
	if (incumbent) await submit("prior","labels/output/kept","keep");
	await submit("data","data/input/value","2");
	for (const s of f.scouts.slice(ids.length)) await s.report({outcome:"no-gap",evidence:[`${s.squad}.md`],reason:"Inputs ready.",grains:[]});
	const first = f.owner.inspect({run,detail:"proof"},"owner").goalChecks?.at(-1); assert.ok(first?.commit && first.receipt?.exit===2);
	put(f.root,"sample","A blue label with units.");
	const productQuestion=scenario==="Autopilot with a product question" || scenario==="Interactive with a product question";
	const [offer] = (await f.owner.operation("publish",{run,file:"sample",to:[directory,"palette/output",...(productQuestion?["palette/legend"]:[])]},"owner")).artifacts;
	const args = {run,receipt:first.id,directory,blob:offer.blob,question:"Show the units.",source:{commit:first.commit,file,excerpt:"Units required"}};
	const owner = f.runtime(f.root,{confirm:async()=>true});
	await owner.operation("iterate",args,"owner"); await f.settle();
	const old = f.scouts.at(-1); assert.ok(old?.base===first.commit);
	await owner.operation("iterate",{...args,directory:"palette/output",question:"Use the color.",
		source:{commit:first.commit,file:"palette/spec/sample",excerpt:"Use blue"}},"owner"); await f.settle();
	const sibling = f.scouts.at(-1); assert.ok(sibling?.squad==="palette");
	await sibling.report(report("color","palette/output","palette/spec/sample"));
	await submit("color","palette/output/value","blue");
	const proposed = report("units",directory,file);
	if (scenario==="missing input pin") proposed.grains[0].needs=["color"];
	if (incumbent) proposed.grains[0].needs=[];
	await old.report(proposed); owner.close();
	const read = f.runtime(f.root), blocked = read.inspect({run,detail:"proof"},"owner");
	const current = blocked.goalChecks?.at(-1), review = blocked.reviews.find(r=>r.id===old.id);
	assert.ok(current?.commit && current.commit!==first.commit && current.receipt?.exit===2);
	assert.equal(git(f.root,"diff","--name-only",first.commit,current.commit),"palette/output/value");
	if (scenario!=="new approval") {
		assert.equal(review?.state,"blocked"); assert.ok(!blocked.nodes.some(n=>n.grain==="units"));
	}
	if (scenario!=="manual renewal") {
		const question="Which color should the legend use?";
		if (productQuestion) {
			const peer=f.runtime(f.root,{confirm:async()=>true});
			await peer.operation("iterate",{...args,receipt:current.id,directory:"palette/legend",question,
				source:{commit:current.commit,file:"palette/spec/sample",excerpt:"Use blue"}},"owner");
			await f.settle(); const scout=f.scouts.at(-1); assert.ok(scout?.squad==="palette");
			await scout.report({outcome:"needs-decision",ownerInput:"product-choice",reason:question,evidence:["palette/spec/sample"],grains:[]});
			peer.close();
		}
		const workers=f.workers.size, scouts=f.scouts.length, checks=[...f.checks];
		if (scenario==="declined" || scenario==="unanswered") {
			const checkpoint=blocked.products?.at(-1)?.check; assert.ok(checkpoint);
			const db=openDatabase(f.root); t.after(()=>db.close());
			db.planAndSwap(run,r=>{
				const saved=r.effects.find(e=>e.id===old.id); assert.ok(saved?.kind==="scout");
				saved.renewal={checkpoint,goal:current.id,...(scenario==="declined" ?
					{state:"closed",reason:"The owner declined continuation."} : {state:"presenting"})};
			});
		}
		const autopilot=scenario.startsWith("Autopilot"), automatic=autopilot || scenario==="Allow All renewal";
		let execution=autopilot ? "autopilot" : "interactive";
		let permission=scenario==="Allow All renewal" ? "allow-all" : "assisted", failClosed=automatic, restricted=true;
		const events=new EventEmitter(), ctx={sessionId:"owner"}, hook={...ctx,timestamp:new Date(),workingDirectory:f.root};
		/** @type {string[]} */ const prompts=[];
		/** @type {string[]} */ const questions=[];
		let move=scenario==="target moved during preflight";
		const entry=await loadEntry({...ctx,on:events.on.bind(events),send:async()=>"notice",
			ui:{input:async (/** @type {string} */ message)=>{questions.push(message); return new Promise(()=>{});},
			elicitation:async (/** @type {{message:string}} */ {message})=>{prompts.push(message);return {action:"decline"};}},
			rpc:{mode:{get:async()=>execution},permissions:{getMode:async()=>({mode:permission})},
				managedSettings:{get:async()=>{
					if (move) {
						move=false;
						put(f.root,"moved","target changed");git(f.root,"add","moved");git(f.root,"commit","-qm","Move the target");
					}
					return {failClosed,bypassPermissionsDisabled:restricted};
				}},
				tools:{execute:(/** @type {{name:string,arguments:import("./model.js").Effect["args"],toolCallId:string}} */ c)=>f.execute(c.name,c.arguments,c.toolCallId)}}});
		await entry.hooks?.onSessionStart?.({...hook,source:"startup"},ctx);
		t.after(()=>entry.hooks?.onSessionEnd?.({...hook,reason:"complete"},ctx));
		const turn=async()=>{events.emit("assistant.turn_start",{data:{}}); await f.settle();};
		if (automatic) {
			await turn(); assert.equal(prompts.length,0); assert.equal(f.workers.size,workers);
			failClosed=false;
			const allowed=permission;
			permission=autopilot ? "manual" : "allow-all";
			await turn(); assert.equal(prompts.length,0); assert.equal(f.workers.size,workers);
			const pending=f.runtime(f.root,{},createRuntime).inspect({run},"owner").reviews.find(r=>r.id===old.id);
			assert.equal(pending?.renewal?.state,"needed","a permission hold must leave the original repair recoverable");
			permission=allowed; restricted=autopilot;
		}
		await turn();
		if (productQuestion) { assert.equal(questions.length,1); assert.ok(questions[0].includes(question)); }
		if (automatic || productQuestion || scenario==="reader 64 recovery") {
			assert.equal(prompts.length,0,"the background repair must not ask for a click");
			assert.equal(f.workers.size,workers+1,"the owner turn must continue the saved repair without waiting for unrelated input");
		}
		if (scenario==="declined" || scenario==="unanswered") { execution="autopilot"; permission="allow-all"; restricted=false; await turn(); }
		const again=f.runtime(f.root,{confirm:async()=>assert.fail("Must not prompt again on reload")},createRuntime);
		again.turn("owner"); await again.flush(); await f.settle();
		const proof=()=>again.inspect({run,detail:"proof"},"owner");
		const node=proof().nodes.find(n=>n.grain==="units");
		assert.equal(prompts.length,0,"continuing an unchanged repair is not a new owner decision");
		assert.equal(f.scouts.length,scouts,"do not rediscover the proposed repair"); assert.deepEqual(f.checks,checks);
		if (incumbent || ["declined","unanswered","missing input pin","target moved during preflight"].includes(scenario)) {
			assert.equal(node,undefined); assert.equal(f.workers.size,workers);
			if (scenario==="unanswered") assert.equal(proof().reviews.find(r=>r.id===old.id)?.renewal?.state,"presenting");
			if (scenario==="missing input pin") assert.match(proof().reviews.find(r=>r.id===old.id)?.reason ?? "",/color/);
			if (incumbent) {
				const why=proof().reviews.find(r=>r.id===old.id)?.reason ?? "";
				assert.ok(why.includes("prior") && why.includes("data"),`expected current owner and dependent, got ${why}`);
				assert.deepEqual(proof().products,blocked.products);assert.deepEqual(proof().nodes,blocked.nodes);
			}
			return;
		}
		assert.ok(node?.worker,"the original reported task must reach a writer without a second review");
		const w=f.workers.get(node.worker);assert.ok(w);
		assert.equal(node.directory,directory);assert.equal(node.task,proposed.grains[0].task);
		assert.equal(proof().reviews.find(r=>r.id===old.id)?.base,first.commit);
		assert.deepEqual(proof().reviews.find(r=>r.id===old.id)?.observation,review?.observation);
		assert.equal(f.workers.size,scenario==="new approval" ? 3 : workers+1);
		put(w.cwd,`${directory}/value`,"2 units");
		await f.runtime(w.cwd,{},createRuntime).operation("submit",{run,token:w.token},w.id);
		const end=proof();assert.ok(end.qualified && end.qualified===end.goal?.receipt?.commit);
		assert.equal(end.products?.at(-1)?.receipt?.commit,end.qualified);
		assert.equal(git(f.root,"show",`${end.qualified}:palette/output/value`),"blue");
		assert.equal(git(f.root,"show",`${end.qualified}:${directory}/value`),"2 units");
		assert.deepEqual(end.goalChecks?.slice(0,-1),blocked.goalChecks); return;
	}
	assert.ok(review);
	assert.ok(review.reason?.includes(first.commit) && review.reason.includes(current.commit) && review.reason.includes("approval"),
		`expected both product pins and the approval boundary, got: ${review.reason}`);
	const fresh = {...args,receipt:current.id,source:{...args.source,commit:current.commit}}, count=f.scouts.length;
	const checks=[...f.checks]; let approvals=0;
	const recover = f.runtime(f.root,{confirm:async prompt=>{
		assert.ok(prompt.includes(fresh.source.commit) && prompt.includes(current.id) && prompt.includes(args.question)); return ++approvals>1;
	}});
	await assert.rejects(recover.operation("iterate",args,"owner"),{code:"invalid_receipt"});
	await assert.rejects(recover.operation("iterate",fresh,"owner"),{code:"approval_declined"});
	assert.equal(f.scouts.length,count); assert.deepEqual(f.checks,checks);
	await recover.operation("iterate",fresh,"owner"); await f.settle();
	const next = f.scouts.at(-1); assert.ok(next && next.base===current.commit && next.id!==old.id);
	await recover.scoutResult(run,old.dispatch,old.issuer,old.workflowId,old.id,proposed,old.packet);
	await recover.operation("iterate",fresh,"owner"); await f.settle();
	assert.equal(f.scouts.length,count+1); assert.equal(approvals,2);
	await next.report(proposed); await submit("units",`${directory}/value`,"2 units");
	const done = recover.inspect({run,detail:"proof"},"owner"); assert.ok(done.qualified && done.qualified===done.goal?.receipt?.commit);
	assert.equal(git(f.root,"show",`${done.qualified}:${directory}/value`),"2 units");
	assert.equal(git(f.root,"show",`${done.qualified}:palette/output/value`),"blue");
	assert.deepEqual(done.goalChecks?.slice(0,-1),blocked.goalChecks);
	assert.equal(done.reviews.find(r=>r.id===old.id)?.state,"blocked");
});

for (const scenario of ["repair", "step observed", "moved target", "unchanged repair", "saved conflicting task", "changed correction evidence", "reuse exhausted candidate", "allow-all reuse", "autopilot reuse", "late sibling"]) test(`route an omitted same-product failure after repin, without replay: ${scenario}`, async t => {
	const run = "outline", source = ".foundry/outline.json", goalCheck = ".foundry/outline/goal.mjs", directory = "pane/ui", step = "outline/child.expand";
	const reuse = ["reuse exhausted candidate","allow-all reuse","autopilot reuse"].includes(scenario);
	const conflicting = scenario === "saved conflicting task" || scenario === "changed correction evidence" || reuse, file = "pane/journal/effects.json";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, target: "refs/heads/main", direction: "Expand the child.", goalCheck, productCheck: "unit.mjs",
			squads: [{ id: "pane", charter: "pane.md", areas: ["pane"], checks: ["unit.mjs"] }] }),
		".foundry/outline/journey.md": "Expand the child after creation.", "pane.md": "The parent must remain expandable.",
		"unit.mjs": conflicting ? `import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
if (process.env.FOUNDRY_GRAIN === "disclosure") {
  const {press} = await import("./pane/ui/disclosure.mjs"), seen = [];
  let expanded = true;
  for (let i = 0; i < 2; i++) expanded = press(expanded, value => seen.push(value));
  assert.deepEqual(seen, JSON.parse(readFileSync(${JSON.stringify(file)},"utf8")).queued);
  assert.equal(expanded,true);
  ${reuse ? 'assert.equal(readFileSync("pane/ui/selection","utf8"),"explicit only");' : ""}
}` : "",
		"pane/ui/button": conflicting ? "disabled\n" + " ".repeat(50000) : "disabled",
		[file]: '{"action":"expand","queued":[false,true]}', [goalCheck]: `console.log("${step}: failed at parent disclosure"); process.exit(1)`,
	});
	const change = (/** @type {string} */ id, /** @type {string} */ dir) => ({ id, directory: dir, check: "unit.mjs", task: `Implement ${id}.`, needs: [] });
	await f.start(); const [initial] = (await f.owner.operation("status", {run, detail:"proof"}, "owner")).goalChecks ?? [];
	await f.scouts[0].report({ outcome:"regenerate", evidence:["pane.md"], reason:"Supply independent inputs.", grains:[change("input","pane/input"), change("journal","pane/journal")] });
	const write = async (/** @type {string} */ grain, /** @type {string} */ file, /** @type {string} */ value) => {
		const n = (await f.status()).nodes.find(n => n.grain === grain), w = f.workers.get(n?.worker ?? ""); assert.ok(w, `expected bound ${grain}`);
		put(w.cwd, file, value); await f.runtime(w.cwd).operation("submit", {run, token:w.token}, w.id);
	};
	await write("input", "pane/input/value", "ready");
	await f.scouts.at(-1)?.report({ outcome:"no-gap", evidence:["pane.md"], reason:"No other input work.", grains:[] });
	const side = path.join(path.dirname(f.root), "overlay"); git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, goalCheck, `import {existsSync,readFileSync} from "node:fs";
if (existsSync("pane/ui/selection") && readFileSync("pane/ui/selection","utf8") === "explicit only") process.exit(0);
console.log(${JSON.stringify(scenario === "step observed" ? `${step}: passed` : "baseline passed; full observation unavailable")}); process.exit(2)`);
	git(side,"commit","-qam","Refine the observation harness");
	const owner = f.runtime(f.root, { confirm: async () => true });
	await owner.operation("repin", {run, from:f.tip, revision:git(side,"rev-parse","HEAD"), files:[goalCheck]}, "owner"); owner.close();
	const proof = () => f.owner.operation("status", {run, detail:"proof"}, "owner");
	const saved = await proof(), product = saved.products?.at(-1), failed = saved.goalChecks?.at(-2), missing = saved.goalChecks?.at(-1);
	assert.ok(product && failed?.receipt?.exit === 1 && missing?.receipt?.exit === 2 && failed.commit === missing.commit && missing.commit === product.commit);
	const expected = "queue the projected change", clause = " or queuing a change", originalTask = `Expand the item without opening it${clause}.`;
	put(f.root, "comparison.txt", JSON.stringify({ expected }));
	const [offer] = (await f.owner.operation("publish", {run, file:"comparison.txt", to:[directory]}, "owner")).artifacts;
	const input = {run, receipt:missing.id, directory, blob:offer.blob, question:"Determine whether the disclosure is still disabled.", historical:{receipt:failed.id, step}};
	const scouts = f.scouts.length, checks = [...f.checks];
	const issuer = conflicting ? f.runtime(f.root,{scoutBudget:async () => 16000}) : f.owner;
	const iterate = (args = input) => issuer.operation("iterate", args, "owner");
	const {historical, ...ordinary} = input;
	await assert.rejects(f.owner.operation("iterate", {...ordinary, question:`${ordinary.question} Earlier receipt: ${historical.receipt}`}, "owner"), /current unmet goal/);
	await assert.rejects(iterate({...input, historical:{receipt:initial.id, step}}));
	await assert.rejects(iterate({...input, receipt:failed.id}));
	await assert.rejects(iterate({...input, historical:{receipt:failed.id, step:"unknown.step"}}));
	if (scenario === "step observed") {
		await assert.rejects(iterate(), /step|observation/i); assert.equal(f.scouts.length, scouts); assert.deepEqual(f.checks, checks); return;
	}
	await iterate(); await f.settle(); await iterate(); await f.settle();
	let review = f.scouts.at(-1); assert.ok(review); assert.equal(f.scouts.length, scouts + 1);
	for (const value of [missing.id, failed.id, product.check, offer.blob, step, "failed at parent disclosure", "full observation unavailable"])
		assert.ok(review.prompt.includes(value), value);
	const firstReview = review.id;
	if (scenario === "repair") assert.ok(review.prompt.includes(expected), "initial scout must receive the comparison's text");
	if (conflicting)
		await review.report({ outcome:"needs-evidence", reason:"Inspect the control.", file:"pane/ui/button", grains:[], evidence:["pane.md"] });
	else
		await review.report({ outcome:"needs-evidence", reason:"Read the earlier observation.", receipt:failed.id, grains:[], evidence:["pane.md"] });
	review = f.scouts.at(-1); assert.ok(review && review.id !== firstReview);
	if (!conflicting) assert.equal(review.packet.read?.source, `receipt:${failed.id}`);
	else assert.equal(review.packet.excerpt?.path,"pane/ui/button");
	if (scenario === "repair") assert.ok(review.prompt.includes(expected), "follow-up scout must receive the comparison's text");
	if (scenario === "moved target") { put(f.root,"neighbor","changed"); git(f.root,"add","neighbor"); git(f.root,"commit","-qm","Concurrent target update"); }
	const proposal = change("disclosure",directory); if (conflicting) proposal.task = originalTask;
	await review.report({ outcome:"regenerate", evidence:["pane/ui/button"], reason:"The button is disabled in the reviewed product.", grains:[proposal] });
	if (scenario === "moved target") {
		const after = await proof(); assert.equal(after.reviews.at(-1)?.state, "blocked"); assert.equal(after.nodes.some(n => n.grain === "disclosure"), false);
		assert.deepEqual(f.checks, checks); assert.equal(f.workers.size, 2); return;
	}
	assert.equal(f.workers.size, 3); assert.deepEqual(f.checks, checks);
	if (scenario === "late sibling") {
		put(f.root,"other.txt","Provide an independent control.");
		const other = (await f.owner.operation("publish",{run,file:"other.txt",to:["pane/other"]},"owner")).artifacts.at(-1); assert.ok(other);
		await iterate({...input,blob:other.blob,directory:"pane/other"}); await f.settle();
		await f.scouts.at(-1)?.report({outcome:"regenerate",reason:"Add a disjoint control.",evidence:["pane.md"],grains:[change("other","pane/other")]});
		await write("journal", "pane/journal/item", "also ready");
		await write("other","pane/other/control","independent");
		const before = await proof(); assert.notEqual(before.checkpoint,product.commit); assert.equal(before.goal?.receipt?.exit,2);
		await write("disclosure","pane/ui/selection","explicit only");
		const reload = f.runtime(f.root); reload.turn("owner"); await reload.flush();
		const after = await proof();
		assert.ok(after.qualified,JSON.stringify({checkpoint:after.checkpoint, goal:after.goal, blocker:after.blocker,nodes:after.nodes.map(n => [n.grain,n.state,n.reason])}));
		assert.equal(git(f.root,"show",`${after.qualified}:pane/other/control`),"independent");
		assert.equal(git(f.root,"show",`${after.qualified}:pane/ui/selection`),"explicit only");
		assert.deepEqual(after.goalChecks?.slice(0,-1),before.goalChecks);
		return;
	}
	if (conflicting) {
		const before = await proof(), n = before.nodes.find(n => n.grain === "disclosure"), w = f.workers.get(n?.worker ?? ""); assert.ok(w && n);
		const count = f.scouts.length, token = w.token;
		const excerpt = '"queued":[false,true]';
		const request = { run, grain:n.grain, review:review.id, worker:w.id, clause, file, excerpt };
		const owner = f.runtime(f.root, {confirm:async prompt => {
			assert.ok([originalTask,"Expand the item without opening it.",file,excerpt,offer.blob].every(value => prompt.includes(value))); return true;
		}});
		await assert.rejects(owner.operation("correct",request,w.id), /owner/);
		await assert.rejects(owner.operation("correct",{...request, excerpt:"Different evidence"}, "owner"), /verbatim|excerpt/);
		await assert.rejects(owner.operation("correct",{...request, review:firstReview}, "owner"), /assignment|review/);
		await assert.rejects(owner.operation("correct",{...request,worker:"other"}, "owner"), /assignment|writer/);
		await assert.rejects(owner.operation("correct",{...request,clause:originalTask}, "owner"), /entire task/);
		await assert.rejects(f.runtime(f.root,{confirm:async () => false}).operation("correct",request,"owner"), /declined|not approved/);
		const racing = f.runtime(f.root,{confirm:async () => {
			await f.runtime(w.cwd).operation("preview",{run,token},w.id); return true;
		}});
		put(w.cwd,"pane/ui/button","in progress");
		await assert.rejects(racing.operation("correct",request,"owner"), /changed during approval/);
		const draft = (await proof()).nodes.find(n => n.grain === "disclosure")?.preview; assert.ok(draft);
		assert.equal(git(f.root,"show",`${draft}:pane/ui/button`),"in progress");
		await owner.operation("correct",request,"owner"); owner.close();
		const writer = f.runtime(w.cwd), own = await writer.operation("status",{run},w.id), corrected = own.nodes.find(n => n.grain === "disclosure");
		assert.ok(corrected); assert.equal(corrected.task,"Expand the item without opening it.");
		assert.deepEqual(corrected.correction,{worker:w.id, clause, file, excerpt, blob:offer.blob});
		assert.deepEqual([corrected.token, corrected.worker, corrected.generation, corrected.inputs, corrected.evaluator], [token, w.id, n.generation, n.inputs, n.evaluator]);
		assert.equal(corrected.preview,draft);
		const fresh = await proof(), history = fresh.reviews.find(r => r.id === review.id);
		assert.deepEqual(history?.observation, before.reviews.find(r => r.id === review.id)?.observation);
		assert.equal(history?.iterationFrom,firstReview); assert.equal(history?.iteration?.blob,offer.blob);
		assert.ok(w.prompt.includes(originalTask) && w.prompt.includes(offer.blob));
		assert.equal(f.workers.size,3); assert.equal(f.scouts.length,count); assert.deepEqual(f.checks,checks);
		put(w.cwd,"pane/ui/button","queued");
		put(w.cwd,"pane/ui/disclosure.mjs","export function press(expanded, queue) { queue(!expanded); return !expanded; }\n");
		if (reuse) put(w.cwd,"pane/ui/selection","opened");
		let current=saved;
		if (scenario === "changed correction evidence") {
			await write("journal", file, '{"action":"expand","queued":[]}');
			current=await proof(); assert.notEqual(current.checkpoint,product.commit);
			assert.equal(git(f.root,"show",`${current.checkpoint}:${file}`),'{"action":"expand","queued":[]}');
			assert.deepEqual(current.goalChecks?.slice(0,-1),saved.goalChecks);
		}
		await writer.operation("submit",{run,token,usedArtifacts:[offer.blob]},w.id);
		if (reuse) {
			const retry = (await writer.operation("status",{run},w.id)).nodes.find(n => n.worker === w.id)?.token;
			assert.ok(retry && retry !== token);
			put(w.cwd,"pane/ui/keep","retained across attempts");
			await writer.operation("submit",{run,token:retry},w.id);
			const store = openDatabase(f.root), old = store.read(run)?.nodes.disclosure; store.close();
			assert.ok(old?.state === "blocked" && old.repairs === 1 && old.check && old.candidate);
			await assert.rejects(writer.operation("submit",{run,token:retry},w.id), /no longer writable/);
			const reference = "selection-fix.txt"; put(f.root, reference, "explicit only");
			const patch = (await f.owner.operation("publish",{run,file:reference,to:[directory]},"owner")).artifacts.find(a => a.file === reference);
			assert.ok(patch);
			// Another independent component joins before the operator requests reuse.
			await write("journal",file,'{"action":"expand","queued":[false,true]}');
			put(f.root,reference,"Repair a disjoint control");
			const separate = (await f.owner.operation("publish",{run,file:reference,to:["pane/other"]},"owner")).artifacts.at(-1);
			assert.ok(separate); await iterate({...input,directory:"pane/other",blob:separate.blob}); await f.settle();
			await f.scouts.at(-1)?.report({outcome:"regenerate",reason:"Create the other control.",evidence:["pane.md"],grains:[change("other","pane/other")]});
			await write("other","pane/other/control","independent");
			const latest = await proof(); assert.notEqual(latest.checkpoint,product.commit);
			const beforeChecks = [...f.checks], previous = f.workers.size;
			const args = {run,grain:"disclosure",check:old.check,candidate:old.candidate,blob:patch.blob};
			const pins = openDatabase(f.root), pending = pins.read(run); pins.close(); assert.ok(pending);
			const requestReuse = prepareReuse(f.root,pending,"owner",args);
			const capped = structuredClone(pending); capped.policy.assignments = 0;
			assert.throws(() => requestReuse.apply(capped), /slot/);
			const moved = structuredClone(pending); moved.nodes.disclosure.base = old.candidate;
			assert.throws(() => requestReuse.apply(moved), /directory.*changed/);
			const recovering = f.runtime(f.root,{confirm:async prompt => {
				assert.ok([directory, old.candidate, old.check, patch.blob, latest.checkpoint].every(pin => pin && prompt.includes(pin))); return true;
			}});
			await assert.rejects(f.runtime(f.root,{confirm:async () => false}).operation("reuse",args,"owner"), /not approved/);
			await assert.rejects(recovering.operation("reuse",args,w.id), /owner/);
			await assert.rejects(recovering.operation("reuse",{...args,blob:separate.blob},"owner"), /not offered/);
			if (scenario === "allow-all reuse" || scenario === "autopilot reuse") {
				let mode="assisted", execution="interactive", restricted=false, prompts=0;
				const entry=await loadEntry({sessionId:"owner",on(){},ui:{elicitation:async (/** @type {{message:string}} */ form)=>{
					assert.match(form.message,/give a new writer access/i); prompts++; return {action:"decline"};
				}},rpc:{mode:{get:async()=>execution},managedSettings:{get:async()=>({failClosed:false,bypassPermissionsDisabled:restricted})},
					permissions:{getMode:async()=>({mode})},tools:{execute:(/** @type {{name:string,arguments:import("./model.js").Effect["args"],toolCallId:string}} */ c)=>f.execute(c.name,c.arguments,c.toolCallId)}}});
				const ctx={sessionId:"owner"},hook={...ctx,timestamp:new Date(),workingDirectory:f.root};
				await entry.hooks?.onSessionStart?.({...hook,source:"startup"},ctx);
				t.after(()=>entry.hooks?.onSessionEnd?.({...hook,reason:"complete"},ctx));
				const name="foundry_reuse", handler=entry.tools?.find((/** @type {import("@github/copilot-sdk").Tool} */ tool)=>tool.name===name)?.handler; assert.ok(handler);
				const call=()=>handler(args,{...ctx,toolName:name,toolCallId:`reuse-${execution}-${mode}-${restricted}`,arguments:args});
				assert.match(JSON.stringify(await call()),/not approved/); assert.equal(prompts,1);
				if (scenario === "autopilot reuse") execution="autopilot";
				mode="allow-all"; restricted=true;
				assert.match(JSON.stringify(await call()),/Managed policy/); assert.equal(f.workers.size,previous);
				restricted=false;
				if (execution==="autopilot") {
					mode="manual"; assert.match(JSON.stringify(await call()),/manual tool approvals/); assert.equal(f.workers.size,previous);
					mode="assisted";
				}
				const result=await call();
				assert.equal(prompts,1,"the allowed tool call must not open a second Foundry confirmation");
				assert.equal(typeof result,"string",JSON.stringify(result));
			} else await recovering.operation("reuse",args,"owner");
			assert.equal(f.workers.size,previous+1); assert.deepEqual(f.checks,beforeChecks);
			const successor = [...f.workers.values()].at(-1); assert.ok(successor && successor.id !== w.id);
			const bound = (await recovering.operation("status",{run},"owner")).nodes.find(n => n.worker === successor.id);
			assert.ok(bound?.reuse?.assignment && bound.reuse.check === old.check && bound.reuse.candidate === old.candidate && bound.repairs === 1);
			assert.equal(git(successor.cwd,"show","HEAD:pane/ui/keep"),"retained across attempts");
			assert.equal(git(successor.cwd,"show","HEAD:pane/other/control"),"independent");
			assert.match(successor.prompt,/Expand the item without opening it\./);
			await assert.rejects(recovering.operation("reuse",args,"owner"));
			await assert.rejects(writer.operation("submit",{run,token:retry},w.id));
			const resumed = f.runtime(successor.cwd);
			await assert.rejects(resumed.operation("submit",{run,token:successor.token},successor.id), /unchanged|change the assigned directory/i);
			assert.deepEqual(f.checks,beforeChecks);
			put(successor.cwd,"pane/ui/selection","explicit only");
			await resumed.operation("submit",{run,token:successor.token,usedArtifacts:[patch.blob]},successor.id);
			const result = await proof(); assert.ok(result.qualified && result.qualified !== latest.checkpoint, JSON.stringify({
				checkpoint:result.checkpoint,blocker:result.blocker,nodes:result.nodes.map(n => [n.grain,n.state,n.reason])
			}));
			assert.equal(git(f.root,"show",`${result.qualified}:pane/ui/keep`),"retained across attempts");
			assert.equal(git(f.root,"show",`${result.qualified}:pane/ui/selection`),"explicit only");
			assert.deepEqual(result.goalChecks?.slice(0,-1), latest.goalChecks);
			assert.equal(result.qualification?.receipts.product.commit,result.qualified);
			const db = openDatabase(f.root), saved = db.read(run); db.close();
			assert.equal(saved?.effects.find(e => e.id === old.check)?.receipt?.exit,1);
			return;
		}
		const after = await proof();
		if (scenario === "changed correction evidence") {
			assert.equal(after.checkpoint,current.checkpoint); assert.equal(after.qualified,null);
			const excluded=after.nodes.find(n=>n.grain==="disclosure");
			assert.deepEqual(after.goalChecks,current.goalChecks); assert.equal(excluded?.state,"blocked");
			assert.match(excluded.reason ?? "", /frozen evidence.*changed before integration/);
			return;
		}
		assert.ok(after.checkpoint && after.checkpoint !== product.commit);
		const component = after.nodes.find(n => n.grain === "disclosure")?.receipt;
		assert.ok(component && component.exit === 0);
		assert.equal(git(f.root,"show",`${after.checkpoint}:pane/ui/button`),"queued"); assert.equal(after.qualified,null);
		assert.deepEqual(after.goalChecks?.filter(e => e.commit === product.commit),[failed,missing]);
		await assert.rejects(f.owner.operation("correct",request,"owner"), /current|writable|assignment/);
		return;
	}
	if (scenario === "repair") {
		const w = f.workers.get((await f.status()).nodes.find(n => n.grain === "disclosure")?.worker ?? ""); assert.ok(w);
		await write("journal", "pane/journal/item", "also ready");
		const current=await proof(); assert.notEqual(current.checkpoint,product.commit);
		assert.deepEqual(current.goalChecks?.slice(0,-1),saved.goalChecks);
		await assert.rejects(iterate(), /receipt|observation/i);
		const events = new EventEmitter(), pending = once(events,"checking"), release = once(events,"release");
		const writer = f.runtime(w.cwd, {execute: async (tool,args,id) => {
			if (tool === "bash" && String(args.description).includes("joined product")) { events.emit("checking"); await release; }
			return f.execute(tool,args,id);
		}});
		put(w.cwd,"pane/ui/button","enabled");
		const submission = writer.operation("submit",{run,token:w.token},w.id);
		try {
			await Promise.race([pending, submission.then(() => assert.fail("Expected a new product check"))]);
			f.owner.turn("owner"); await f.owner.flush();
			const checking = await proof(); assert.equal(checking.candidate?.receipt, undefined);
			assert.deepEqual(checking.goalChecks, current.goalChecks); assert.equal(checking.qualified,null);
		} finally { events.emit("release"); await submission; }
	} else await write("disclosure", "pane/ui/button", "disabled");
	const after = await proof(); assert.equal(after.qualified, null);
	assert.deepEqual(after.goalChecks?.filter(e => e.commit === product.commit), [failed,missing]);
	if (scenario === "unchanged repair") {
		assert.match(after.nodes.find(n => n.grain === "disclosure")?.reason ?? "", /unchanged/);
		assert.equal(after.checkpoint, product.commit); assert.equal(f.checks.length, checks.length + 1); return;
	}
	assert.ok(after.checkpoint && after.checkpoint !== product.commit && after.products?.at(-1)?.receipt?.exit === 0);
	assert.equal(git(f.root,"show",`${after.checkpoint}:pane/ui/button`),"enabled");
	assert.equal(git(f.root,"show",`${after.checkpoint}:pane/journal/item`),"also ready");
	assert.equal(after.goal?.receipt?.commit, after.checkpoint); assert.equal(after.goal?.receipt?.exit, 2);
	await assert.rejects(iterate(), /receipt|observation/i);
});

for (const scenario of ["saved overlap", "fresh report", "saved unmet-goal overlap"]) test(`a recovered comparison hands off a stopped writer without replay / ${scenario}`, async t => {
	const saved = scenario !== "fresh report", unmet = scenario === "saved unmet-goal overlap";
	const run = "panes", source = ".foundry/panes.json", dir = "pane/layout", check = "unit.mjs", charter = "pane.md";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({id:run, version:2, target:"refs/heads/main", direction:"Display the pane.", goalCheck:"goal.mjs", productCheck:check,
			squads:[{id:"pane", charter, areas:["pane"], checks:[check]}]}),
		".foundry/panes/journey.md":"Keep the pane visible.", [charter]:"Render the saved layout.", [check]:"",
		"goal.mjs":`import {existsSync} from "node:fs"; process.exit(existsSync("${dir}/ready") ? 0 : 1);`,
	});
	const grain = (/** @type {string} */ id, /** @type {string} */ directory, /** @type {string[]} */ needs = []) =>
		({id, directory, task:`Implement ${id}.`, check, needs});
	const proposal = (/** @type {ReturnType<typeof grain>[]} */ grains) => ({outcome:"regenerate", grains, evidence:[charter], reason:"Implement the missing behavior."});
	await f.start(); await f.scouts[0].report(proposal([grain("export", dir), grain("input","pane/input")]));
	const nodes = (await f.status()).nodes, old = f.workers.get(nodes.find(n => n.grain === "export")?.worker ?? ""),
		input = f.workers.get(nodes.find(n => n.grain === "input")?.worker ?? ""); assert.ok(old && input);
	const oldWriter = f.runtime(old.cwd), oldArgs = {run,token:old.token};
	put(old.cwd, `${dir}/draft`, "private preview");
	const preview = (await oldWriter.operation("preview", oldArgs, old.id)).nodes[0].preview; assert.ok(preview);
	await oldWriter.operation("submit", {...oldArgs,missingInput:"Export device unavailable."}, old.id);
	await f.settle();
	const stoppedReview = f.scouts.at(-1); assert.ok(stoppedReview && stoppedReview.id !== f.scouts[0].id);
	await stoppedReview.report({outcome:"no-gap",grains:[],reason:"No substitute for the missing input.",evidence:[charter]});
	const events = new EventEmitter(), pending = once(events,"pending"), release = once(events,"release");
	const publisher = f.runtime(input.cwd, {execute: async (tool,args,id) => {
		if (tool === "bash" && String(args.description).includes("final goal")) { events.emit("pending"); await release; }
		return f.execute(tool,args,id);
	}});
	put(input.cwd,"pane/input/value","41");
	const submit = publisher.operation("submit",{run,token:input.token},input.id);
	const db = openDatabase(f.root); t.after(() => db.close());
	let prior;
	try {
		await Promise.race([pending, submit.then(() => assert.fail("expected a pending checkpoint goal"))]);
		const checkpoint = (await f.status()).products?.at(-1); assert.ok(checkpoint);
		if (unmet) {
			events.emit("release"); await submit; await f.settle();
			await f.scouts.at(-1)?.report({outcome:"no-gap",grains:[],reason:"No other index work.",evidence:[charter]});
		}
		put(f.root,"comparison.txt","Place the value beside the chart.");
		const [offered] = (await f.owner.operation("publish",{run,file:"comparison.txt",to:[dir]},"owner")).artifacts;
		const issuer = f.runtime(f.root,{scoutBudget:async () => 1});
		const receipt = unmet ? (await issuer.operation("status",{run,detail:"proof"},"owner")).goalChecks?.at(-1)?.id : checkpoint.check;
		await issuer.operation("iterate",{run,blob:offered.blob,receipt,directory:dir,question:"Render the checked value."},"owner"); await f.settle();
		prior = (await f.status()).reviews.at(-1); assert.ok(prior?.iteration && prior.workflowId);
		assert.equal(prior.iteration.basis,unmet ? undefined : "checkpoint"); assert.match(String(prior.reason), /pinned file index/);
	} finally { events.emit("release"); await submit; }
	const owner = f.runtime(f.root,{scoutBudget:async () => 32000, confirmNoReport:async r => {assert.equal(r.id, prior.id);}});
	await owner.operation("rereview",{run,review:prior.id},"owner"); await f.settle();
	const job = f.scouts.at(-1); assert.ok(job && (await f.status()).reviews.at(-1)?.retryOf === prior.id);
	const report = proposal([grain("render",dir,unmet ? [] : ["input"])]), checks = [...f.checks], scouts = f.scouts.length;
	if (saved) {
		// Reader 31 kept the original packet and observation but could not admit a retry's report.
		db.mutateLocked(run, r => {
			const e = r.effects.find(e => e.id === job.id); assert.ok(e?.kind === "scout" && e.retryOf && e.workflowId);
			e.observation = parseObservation(r.policy.squads[0], report); e.packet = job.packet;
			e.state = "blocked"; e.error = "Writable directories must be disjoint";
		});
		const snapshot = db.read(run); assert.ok(snapshot);
		const reload = f.runtime(f.root); reload.turn("owner"); await reload.flush(); await f.settle();
		const applied = (await f.status()).reviews.find(r => r.id === job.id);
		assert.equal(applied?.state,"observed",String(applied?.reason));
		for (const conflict of ["candidate","consumer","call","unscoped retry"]) {
			/** @type {import("./model.js").Run} */
			const copy = structuredClone(snapshot);
			if (conflict === "candidate") copy.nodes.export.candidate = preview;
			if (conflict === "consumer") copy.nodes.input.grain.needs.push("export");
			if (conflict === "call") {
				const call = copy.effects.find(e => e.kind === "artifact" && e.grain === "export") ??
					copy.effects.find(e => e.kind === "writer" && e.grain === "export"); assert.ok(call);
				call.state = "uncertain";
			}
			if (conflict === "unscoped retry") {
				/** @type {import("./model.js").Effect|undefined} */
				const source = copy.effects.find(e => e.id === prior.id); assert.ok(source?.kind === "scout");
				delete source.iteration;
			}
			/** @type {import("./model.js").Effect|undefined} */
			const e = copy.effects.find(e => e.id === job.id); assert.ok(e?.kind === "scout" && e.observation);
			const observation = e.observation;
			assert.throws(() => observe(f.root,copy,e,observation), /disjoint|handoff/i);
			assert.equal(copy.nodes.export.worker,old.id); assert.ok(!copy.nodes.render);
			const held = status(copy,"owner").reviews.find(r => r.id === job.id);
			if (conflict !== "unscoped retry")
				assert.match(String(held?.handoffHold), conflict === "candidate" ? /candidate/ : conflict === "consumer" ? /input.*consum/ : /writer.*uncertain/);
		}
	} else await job.report(report);
	const after = await f.status(), admitted = after.reviews.find(r => r.id === job.id);
	assert.equal(admitted?.state,"observed",String(admitted?.reason));
	assert.equal(admitted?.predecessor?.preview,preview);
	const successor = f.workers.get(after.nodes.find(n => n.grain === "render")?.worker ?? "");
	assert.ok(successor && successor.id !== old.id); assert.equal(f.workers.size,3);
	const final = db.read(run); assert.ok(final);
	const stored = final.effects.find(e => e.id === job.id); assert.ok(stored?.kind === "scout");
	assert.deepEqual(stored.observation,parseObservation(final.policy.squads[0],report)); assert.deepEqual(stored.packet,job.packet);
	assert.equal(stored.predecessor?.preview,preview); assert.equal(stored.predecessor?.worker,old.id);
	assert.equal(git(f.root,"show",`${preview}:${dir}/draft`),"private preview");
	assert.equal(readFileSync(path.join(old.cwd,dir,"draft"),"utf8"),"private preview");
	assert.ok(!existsSync(path.join(successor.cwd,dir,"draft")));
	await assert.rejects(oldWriter.operation("submit",oldArgs,old.id), /assignment/);
	owner.turn("owner"); await owner.flush(); assert.equal(f.scouts.length,scouts); assert.equal(f.workers.size,3); assert.deepEqual(f.checks,checks);
	put(successor.cwd,`${dir}/ready`,"displayed"); const done = await f.runtime(successor.cwd).operation("submit",{run,token:successor.token},successor.id);
	assert.ok((await f.status()).qualified); assert.equal(done.nodes[0].state,"qualified");
});

for (const moved of [false,true]) test(`an admitted checkpoint comparison recovers an exhausted directory after a missing goal: ${moved ? "new product" : "original product"}`, async t => {
	const run = "inventory", source = ".foundry/inventory.json", dir = "catalog/ui", check = "unit.mjs";
	const f = factory(t,run,source,{
		[source]:JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Display the inventory.",goalCheck:"goal.mjs",productCheck:check,
			squads:[{id:"catalog",charter:"catalog.md",areas:["catalog"],checks:[check]}]}),
		".foundry/inventory/journey.md":"Display the actual inventory.", "catalog.md":"Use the checked inventory.",
		[check]:'if (process.env.FOUNDRY_GRAIN === "draft") process.exit(1);',
		"goal.mjs":`import {existsSync} from "node:fs"; process.exit(existsSync("${dir}/parts") ? 0 : existsSync("${moved ? "catalog/extra/value" : "catalog/data/parts"}") ? 2 : 1);`,
	});
	const grain = (/** @type {string} */ id, /** @type {string} */ directory, /** @type {string[]} */ needs = []) =>
		({id,directory,needs,check,task:`Implement ${id}.`});
	const proposal = (/** @type {ReturnType<typeof grain>[]} */ grains) => ({outcome:"regenerate",grains,evidence:["catalog.md"],reason:"Implement the distinct behavior."});
	await f.start(); await f.scouts[0].report(proposal([grain("draft",dir),grain("inventory","catalog/data"),...(moved ? [grain("extra","catalog/extra")] : [])]));
	const worker = async (/** @type {string} */ grain) => {const w = f.workers.get((await f.status()).nodes.find(n => n.grain === grain)?.worker ?? ""); assert.ok(w); return w;};
	const old = await worker("draft"), data = await worker("inventory"), writer = f.runtime(old.cwd);
	put(old.cwd,`${dir}/old`,"failed draft"); await writer.operation("submit",{run,token:old.token},old.id);
	const token = (await writer.operation("status",{run},old.id)).nodes[0]?.token; assert.ok(token && token !== old.token);
	put(old.cwd,`${dir}/old`,"failed repair"); await writer.operation("submit",{run,token},old.id);
	const db = openDatabase(f.root); t.after(() => db.close());
	const terminal = db.read(run)?.nodes.draft; assert.ok(terminal?.check && terminal.candidate && terminal.state === "blocked");
	assert.equal(terminal.repairs,1,JSON.stringify(terminal));
	const exhaustedRun = db.read(run); assert.ok(exhaustedRun);
	assert.ok(exhaustedCandidate(exhaustedRun,terminal),"expected a conclusive failed component after the last repair");
	const fresh = f.scouts.at(-1); if (fresh && fresh !== f.scouts[0]) await fresh.report({outcome:"no-gap",reason:"Wait for the inventory.",evidence:["catalog.md"],grains:[]});
	const events = new EventEmitter(), pending = once(events,"pending"), release = once(events,"release");
	const publisher = f.runtime(data.cwd,{execute:async (tool,args,id) => {
		if (tool === "bash" && String(args.description).includes("final goal")) {events.emit("pending"); await release;}
		return f.execute(tool,args,id);
	}});
	put(data.cwd,"catalog/data/parts","bolt"); const submission = publisher.operation("submit",{run,token:data.token},data.id);
	let review, blob;
	const report = proposal([grain("parts",dir,["inventory"])]);
	try {
		await Promise.race([pending,submission.then(() => assert.fail("expected an in-flight goal"))]);
		const product = (await f.status()).products?.at(-1); assert.ok(product);
		put(f.root,"sample","Display the inventory in the catalog.");
		const [offer] = (await f.owner.operation("publish",{run,file:"sample",to:[dir]},"owner")).artifacts;
		blob = offer.blob;
		await f.owner.operation("iterate",{run,receipt:product.check,blob:offer.blob,directory:dir,question:"Display the checked inventory."},"owner"); await f.settle();
		review = f.scouts.at(-1); assert.ok(review);
		// An older reader journaled the whole report and its rejected admission.
		const job = review;
		if (!moved) db.mutateLocked(run,r => {const e = r.effects.find(e => e.id === job.id); assert.ok(e?.kind === "scout");
			e.packet = job.packet; e.observation = parseObservation(r.policy.squads[0],report);
			e.state = "blocked"; e.error = "Writable directories must be disjoint";});
	} finally {events.emit("release"); await submission;}
	if (moved) {
		const extra = await worker("extra"); put(extra.cwd,"catalog/extra/value","independent");
		await f.runtime(extra.cwd).operation("submit",{run,token:extra.token},extra.id);
		const job = review;
		db.mutateLocked(run,r => {const e = r.effects.find(e => e.id === job.id); assert.ok(e?.kind === "scout");
			e.packet = job.packet; e.observation = parseObservation(r.policy.squads[0],report);
			e.state = "blocked"; e.error = "Writable directories must be disjoint";});
		const before = await f.owner.operation("status",{run,detail:"proof"},"owner");
		assert.ok(before.checkpoint && before.checkpoint !== job.base); assert.equal(before.goal?.receipt?.exit,2);
		const receipt = before.goalChecks?.at(-1)?.id; assert.ok(receipt);
		const input = {run,receipt,blob,directory:dir,question:"Compare the current inventory."};
		const snapshot = db.read(run); assert.ok(snapshot);
		for (const hold of ["consumer","call","pin","changed bytes","different comparison"]) {
			/** @type {import("./model.js").Run} */
			const copy = structuredClone(snapshot);
			if (hold === "consumer") copy.nodes.extra.grain.needs.push("draft");
			if (hold === "call") {
				/** @type {import("./model.js").Effect|undefined} */
				const e = copy.effects.find(e => e.id === terminal.check); assert.ok(e); e.state = "uncertain";
			}
			if (hold === "pin") copy.nodes.inventory.candidate = f.tip;
			if (hold === "changed bytes") {
				const branch = path.join(path.dirname(f.root),"changed");
				git(f.root,"worktree","add","-q","--detach",branch,before.checkpoint);
				put(branch,`${dir}/concurrent`,"changed"); git(branch,"add","."); git(branch,"commit","-qm","Changed UI");
				const changed = git(branch,"rev-parse","HEAD"), p = copy.products.at(-1); assert.ok(p && copy.goal);
				for (const id of [p.check,copy.goal.check]) {
					const e = copy.effects.find(e => e.id === id); assert.ok(e?.receipt); e.commit = e.receipt.commit = changed;
				}
				p.commit = copy.goal.commit = changed;
			}
			assert.throws(() => reserveIteration(f.root,copy,"owner",hold === "different comparison" ? {...input,blob:f.tip} : input),/current unmet goal|offered/,hold);
		}
		await f.owner.operation("iterate",input,"owner"); await f.settle();
		review = f.scouts.at(-1); assert.ok(review && review.base === before.checkpoint && review.id !== job.id);
		await review.report({outcome:"needs-evidence",reason:"Inspect the selected comparison.",evidence:["catalog.md"],detail:blob,grains:[]});
		review = f.scouts.at(-1); assert.ok(review && review.packet.read?.source === `detail:${blob}`);
		await review.report(report);
		assert.equal((await f.status()).reviews.find(r => r.id === job.id)?.state,"blocked");
	}
	const reload = f.runtime(f.root); reload.turn("owner"); await reload.flush();
	const s = await f.status(); assert.equal(s.goal?.receipt?.exit,2);
	const admitted = s.reviews.find(r => r.id === review.id);
	assert.equal(admitted?.state,"observed",String(admitted?.handoffHold ?? admitted?.reason));
	const next = await worker("parts"); assert.notEqual(next.id,old.id); assert.ok(!existsSync(path.join(next.cwd,dir,"old")));
	assert.equal(git(next.cwd,"show","HEAD:catalog/data/parts"),"bolt");
	await assert.rejects(writer.operation("submit",{run,token},old.id));
	put(next.cwd,`${dir}/parts`,"bolt"); await f.runtime(next.cwd).operation("submit",{run,token:next.token},next.id);
	const after = await f.status(); assert.ok(after.qualified); assert.equal(git(f.root,"show",`${after.qualified}:${dir}/parts`),"bolt");
	assert.equal(db.read(run)?.effects.find(e => e.id === terminal.check)?.receipt?.exit,1);
});

test("an overlapping comparison cannot repurpose a live repair awaiting external evidence", async t => {
	const run = "display", source = ".foundry/display.json", directory = "pane/ui", check = "component.mjs";
	const f = factory(t, run, source, {
		[source]: JSON.stringify({id:run,version:2,target:"refs/heads/main",direction:"Show saved details.",goalCheck:"goal.mjs",productCheck:"product.mjs",
			squads:[{id:"pane",charter:"pane.md",areas:["pane"],checks:[check]}]}),
		".foundry/display/journey.md":"Show labels and saved details.", "pane.md":"Build the pane.", "product.mjs":"",
		[check]:`import {existsSync,readFileSync} from "node:fs";
			if (process.env.FOUNDRY_GRAIN === "labels" && !existsSync(readFileSync("pane/ui/device","utf8"))) process.exit(2);`,
		"goal.mjs":`import {existsSync,readFileSync} from "node:fs"; process.exit(existsSync("pane/ui/detail") &&
			readFileSync("pane/ui/detail","utf8") === readFileSync("pane/model/detail","utf8") && existsSync("pane/ui/label") ? 0 : 1);`,
	});
	const proposal = (/** @type {string} */ id, /** @type {string} */ dir, /** @type {string[]} */ needs = []) =>
		({id,directory:dir,check,needs,task:`Implement ${id}.`});
	const report = (/** @type {ReturnType<typeof proposal>[]} */ grains) => ({outcome:"regenerate",reason:"Implement the missing behavior.",evidence:["pane.md"],grains});
	await f.start(); await f.scouts[0].report(report([proposal("labels",directory),proposal("model","pane/model")]));
	const worker = async (/** @type {string} */ grain) => {const w = f.workers.get((await f.status()).nodes.find(n => n.grain === grain)?.worker ?? ""); assert.ok(w); return w;};
	const old = await worker("labels"), model = await worker("model"), writer = f.runtime(old.cwd);
	const device = path.join(path.dirname(f.root),"unlocked");
	put(old.cwd,`${directory}/device`,device); put(old.cwd,`${directory}/label`,"Tuesday");
	await writer.operation("submit",{run,token:old.token},old.id);
	const db = openDatabase(f.root); t.after(() => db.close());
	const original = db.read(run)?.nodes.labels; assert.ok(original?.state === "writing" && original.check && original.token !== old.token);
	const receipt = db.read(run)?.effects.find(e => e.id === original.check)?.receipt; assert.equal(receipt?.exit,2);
	put(model.cwd,"pane/model/detail","saved"); await f.runtime(model.cwd).operation("submit",{run,token:model.token},model.id);
	put(f.root,"reference","Render the model's saved detail."); const [offer] = (await f.owner.operation("publish",{run,file:"reference",to:[directory]},"owner")).artifacts;
	const owner = f.runtime(f.root), before = db.read(run); assert.ok(before?.goal);
	await assert.rejects(owner.operation("iterate",{run,receipt:before.goal.check,blob:offer.blob,directory,question:"Render the newly checked detail."},"owner"),
		/labels.*writing.*not queued.*distinct work must wait/is);
	assert.deepEqual(db.read(run),before); assert.equal(f.workers.size,2);
	assert.equal(git(f.root,"show",`${receipt.commit}:${directory}/label`),"Tuesday");

	writeFileSync(device,"ready");
	await writer.operation("submit",{run,token:original.token},old.id);
	const joined = await f.status(); assert.ok(joined.checkpoint && joined.nodes.find(n => n.grain === "labels")?.state === "qualified");
	assert.equal(db.read(run)?.effects.find(e => e.id === original.check)?.receipt?.exit,2);
	await f.settle(); const current = f.scouts.at(-1); assert.equal(current?.base,joined.checkpoint);
	await current.report(report([proposal("saved-detail",directory,["model"])]));
	const detail = await worker("saved-detail"); assert.notEqual(detail.id,old.id);
	put(detail.cwd,`${directory}/label`,git(f.root,"show",`${joined.checkpoint}:${directory}/label`));
	put(detail.cwd,`${directory}/detail`,git(detail.cwd,"show","HEAD:pane/model/detail"));
	await f.runtime(detail.cwd).operation("submit",{run,token:detail.token},detail.id);
	assert.ok((await f.status()).qualified);
});

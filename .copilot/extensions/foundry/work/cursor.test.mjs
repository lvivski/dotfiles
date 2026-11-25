import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createRuntime } from "./runtime.mjs";
import { factory, git, put } from "../test/fixture.mjs";
import { fixture, noGap, proof, propose, readFile, run, submit, worker } from "../test/release.mjs";

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

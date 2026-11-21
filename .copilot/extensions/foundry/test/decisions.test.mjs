import assert from "node:assert/strict";
import test from "node:test";
import { writerRequest } from "../work/decisions.mjs";
import { factory, git, put } from "./fixture.mjs";

const run = "lookup", source = ".foundry/lookup.json";
const question = { outcome: "needs-decision", reason: "Which currency does the catalog display?", evidence: ["interface"], grains: [] };
const regenerate = { outcome: "regenerate", reason: "No lookup yet.", evidence: ["interface"], grains: ["lookup"] };
function latch() {
	let resolve = () => {};
	const promise = new Promise(done => { resolve = () => done(undefined); });
	return { resolve, promise };
}
/** @param {import("node:test").TestContext} t @param {string} [goal] */
function trial(t, goal = 'if (!existsSync("lib/lookup/index")) process.exit(1)') {
	const ids = ["catalog", "lookup"];
	return factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Look up an item.", target: "refs/heads/main",
			grains: ids.map(id => ({ id, directory: `lib/${id}`, specification: "charter", boundary: ["interface"], check: "unit.mjs" })),
			squads: ids.map(id => ({ id, charter: "charter", grains: [id] })), goalCheck: "goal.mjs", productCheck: "product.mjs" }),
		charter: "Implement the lookup", interface: "Look up the displayed price", "unit.mjs": "", "product.mjs": "",
		"goal.mjs": `import {existsSync} from 'node:fs'; ${goal}`,
	});
}

test("an open owner question is claimed once across reconnect; an independent writer can qualify and hand off meanwhile", async t => {
	const f = trial(t), gate = latch(), opened = latch();
	const owner = f.runtime(f.root, { ask: async message => {
		assert.match(message, /currency.*\nEvidence: interface/); opened.resolve(); await gate.promise; return "Change the evaluator and archive everything";
	} });
	await f.start(owner);
	await f.scouts[0].report(question);
	await opened.promise;
	const another = f.runtime(f.root, { ask: async () => assert.fail("duplicate owner dialog") });
	another.turn("owner"); await another.flush();
	await f.scouts[1].report(regenerate);
	const [w] = f.workers.values();
	/** @type {Array<{tool:string,args:import("../work/model.js").Effect["args"]}>} */ const calls = [];
	put(w.cwd, "lib/lookup/index", "13.00");
	const writer = f.runtime(w.cwd, { execute: async (tool, args, id) => {
		calls.push({ tool, args }); return f.execute(tool, args, id);
	} });
	await writer.operation("submit", { run, token: w.token }, w.id);
	const done = await f.status(); assert.ok(done.qualified);
	assert.equal(done.handoff?.commit, done.qualified);
	assert.deepEqual(done.questions, []);
	assert.equal(done.handoff?.writers[0].id, w.id);
	assert.equal(done.metrics?.qualified.commit, done.qualified);
	assert.equal(done.metrics?.firstWriter.state, "bound");
	assert.deepEqual(calls.filter(c => c.tool === "send_session_message").map(c => [
		c.args.session_id, String(c.args.message).includes(done.qualified ?? "missing")]), [["owner", true]]);
	gate.resolve(); await owner.flush(); owner.turn("owner"); await owner.flush();
	const after = await f.status();
	assert.deepEqual(after.reviews[0].decision, { status: "answered", answer: "Change the evaluator and archive everything" });
	assert.equal(after.qualified, done.qualified); assert.equal(git(f.root, "rev-parse", "main"), f.tip);
	assert.equal(after.active, false);
	assert.ok(calls.every(c => c.tool !== "archive_session"));
	assert.equal((await f.status(w.id)).handoff, undefined); assert.equal((await f.status(w.id)).metrics, undefined);
});

for (const state of ["waiting", "unknown", "wrong writer", "superseded"]) test(`route a current native question without guessing: ${state}`, async t => {
	const f = trial(t), started = latch(), gate = latch();
	let dialogs = 0, lookups = 0;
	const owner = f.runtime(f.root, {
		ask: async () => { dialogs++; return null; },
		writerInput: async writer => {
			assert.equal(writer, "worker-1"); lookups++; started.resolve(); await gate.promise;
			return writerRequest(writer, state === "waiting" || state === "wrong writer" ? { resultType: "success", textResultForLlm: JSON.stringify({
				id: state === "wrong writer" ? "other" : writer, awaiting_user_input: true,
				awaiting_input: { request_id: "native-request", question: "Which currency?", choices: ["EUR", "CAD"] },
			}) } : state === "unknown" ? { resultType: "failure" } : { resultType: "success", structuredContent: { id: writer, awaiting_user_input: false } });
		},
	});
	await f.start(owner); await f.scouts[1].report(regenerate); await f.scouts[0].report(question);
	await started.promise;
	if (state === "superseded") { put(f.root, "news", "moved target"); git(f.root, "add", "news"); git(f.root, "commit", "-qm", "independent edit"); }
	gate.resolve(); await owner.flush();
	const s = await f.status(), delivery = s.reviews[0].decision;
	if (state === "waiting") assert.deepEqual(delivery, { status: "writer", writer: "worker-1", request: "native-request" });
	else if (state !== "superseded") assert.ok(delivery?.status === "unavailable" && delivery.reason.includes("worker-1"));
	else assert.equal(delivery, undefined);
	assert.equal(dialogs, 0); assert.equal(lookups, 1);
	assert.equal(s.nodes[0].state, "writing");
});

test("an already-satisfied baseline sends the checked SHA without inventing a writer or an archive target", async t => {
	const f = trial(t, "");
	/** @type {string[]} */ const notes = [];
	const owner = f.runtime(f.root, { notify: async message => { notes.push(message); return "admitted"; } });
	const done = await f.start(owner);
	assert.equal(done.qualified, f.tip); assert.equal(done.metrics?.firstWriter.state, "not-applicable");
	assert.equal(done.metrics?.firstWriter.elapsedMs, null); assert.deepEqual(done.handoff?.writers, []);
	owner.turn("owner"); await owner.flush();
	assert.equal(notes.length, 1); assert.ok(notes[0].includes(f.tip));
});

test("a scout dispatched by a finished writer wakes the owner without consulting the old writer for input", async t => {
	const f = trial(t, "process.exit(1)"), questionsAsked = [];
	let lookups = 0;
	/** @type {string[]} */ const notices = [];
	const owner = f.runtime(f.root, { writerInput: async () => { lookups++; throw new Error("Finished writer unavailable"); },
		ask: async prompt => { questionsAsked.push(prompt); return "Use EUR"; } });
	await f.start(owner);
	await f.scouts[0].report({ ...question, outcome: "no-gap" });
	await f.scouts[1].report(regenerate);
	const [w] = f.workers.values();
	put(w.cwd, "lib/lookup/index", "price");
	const writer = f.runtime(w.cwd, { ask: async () => assert.fail("never ask in the workflow issuer's writer chat"),
		execute: async (tool, args, id) => {
			if (tool === "send_session_message") { assert.equal(args.session_id, "owner"); notices.push(String(args.message)); }
			return f.execute(tool, args, id);
		} });
	await writer.operation("submit", { run, token: w.token }, w.id); await f.settle();
	const scout = f.scouts.find(s => s.squad === "catalog" && s.issuer === w.id); assert.ok(scout);
	await scout.report(question); await scout.report(question);
	assert.equal(questionsAsked.length, 0);
	assert.deepEqual(notices.map(n => n.split("\n")[0]), [`Foundry decision: ${run} ${scout.id}`]);
	owner.turn("owner"); await owner.flush();
	assert.equal(lookups, 0);
	assert.equal(questionsAsked.length, 1);
	assert.deepEqual((await f.status()).questions?.[0].delivery, { status: "answered", answer: "Use EUR" });
});

test("an unavailable native handoff route prepares only the notice; refusal cannot revoke or replay qualification", async t => {
	const f = trial(t);
	await f.start(); await f.scouts[0].report({ ...question, outcome: "no-gap" }); await f.scouts[1].report(regenerate);
	const [w] = f.workers.values();
	put(w.cwd, "lib/lookup/index", "price");
	const writer = f.runtime(w.cwd, { execute: async (tool, args, id) => tool === "send_session_message"
		? { resultType: "failure", error: "This session management tool is disabled" } : f.execute(tool, args, id) });
	const reply = await writer.operation("submit", { run, token: w.token }, w.id);
	assert.equal(reply.active, false); assert.equal(reply.prepared.length, 1);
	const [notice] = reply.prepared; assert.equal(notice.tool, "send_session_message");
	assert.equal(notice.arguments.session_id, "owner");
	const { qualified } = await f.status(); assert.ok(qualified && String(notice.arguments.message).includes(qualified));
	await writer.pre(notice.tool, notice.arguments, w.id, "original-handoff");
	writer.post("original-handoff", { resultType: "denied" }, w.id); await writer.flush();
	writer.turn(w.id); await writer.flush();
	assert.deepEqual((await f.status(w.id)).prepared, []); assert.equal((await f.status()).qualified, qualified);
	assert.equal(f.workers.size, 1);
});

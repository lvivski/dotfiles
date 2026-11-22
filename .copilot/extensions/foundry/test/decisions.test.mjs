import assert from "node:assert/strict";
import test from "node:test";
import { factory, git, put } from "./fixture.mjs";

const run = "lookup", source = ".foundry/lookup.json";
const noGap = { outcome: "no-gap", reason: "No owned change needed.", evidence: ["interface"], grains: [] };
const question = { ...noGap, outcome: "needs-decision", ownerInput: "product-choice", reason: "Which currency does the catalog display?" };
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
	assert.equal(done.handoff?.writers, undefined, "ordinary handoff does not invite cleanup");
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

for (const moved of [false, true]) test(`a charter clarification wakes only its current review, target moved: ${moved}`, async t => {
	const f = trial(t), opened = latch(), release = latch();
	let asks = 0;
	const owner = f.runtime(f.root, { ask: async () => {
		asks++; opened.resolve(); await release.promise; return "Use EUR";
	}, execute: (tool, args, id) => {
		assert.notEqual(tool, "get_session", "an unrelated writer's pending request is not a charter decision");
		return f.execute(tool, args, id);
	} });
	await f.start(owner);
	await f.scouts[1].report(regenerate);
	await f.scouts[0].report(question); await opened.promise;
	if (moved) { put(f.root, "news", "new tip"); git(f.root, "add", "news"); git(f.root, "commit", "-qm", "independent change"); }
	release.resolve(); await owner.flush(); await f.settle();
	const follow = f.scouts.slice(2);
	if (moved) assert.equal(follow.length, 0);
	else {
		assert.deepEqual(follow.map(j => j.squad), ["catalog"]);
		assert.match(follow[0].prompt, /Which currency.*Use EUR/);
		await follow[0].report(question); owner.turn("owner"); await owner.flush(); await f.settle();
		assert.equal(asks, 1); assert.equal(f.scouts.length, 3);
		assert.match(String((await f.status()).questions?.[0].delivery?.status), /unavailable/);
	}
	assert.deepEqual((await f.status()).reviews[0].decision, { status: "answered", answer: "Use EUR" });
	assert.equal(f.workers.size, 1);
});

for (const hold of ["none", "pause", "plan"]) test(`an in-scope answer reaches the stalled charter once, hold: ${hold}`, async t => {
	const f = trial(t), opened = latch(), release = latch();
	let mode = "interactive", asks = 0;
	const owner = f.runtime(f.root, { mode: async () => mode, ask: async () => { asks++; opened.resolve(); await release.promise; return "Use EUR"; } });
	await f.start(owner); await f.scouts[0].report(noGap); await f.scouts[1].report(question);
	await opened.promise; assert.match(String((await f.status()).blocker), /No actionable grain/);
	if (hold === "pause") await owner.operation("pause", { run }, "owner");
	if (hold === "plan") mode = "plan";
	release.resolve(); await owner.flush(); await f.settle();
	assert.equal((await f.status()).reviews[1].decision?.status, "answered");
	if (hold !== "none") {
		assert.equal(f.scouts.length, 2); assert.equal(f.workers.size, 0);
		mode = "interactive";
		if (hold === "pause") await f.start(owner);
		else { owner.turn("owner"); await owner.flush(); await f.settle(); }
	}
	const fresh = f.scouts[2]; assert.equal(fresh.squad, "lookup"); assert.match(fresh.prompt, /Use EUR/);
	await fresh.report(regenerate);
	const [w] = f.workers.values(); put(w.cwd, "lib/lookup/index", "EUR");
	await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	assert.ok((await f.status()).qualified); assert.equal(f.scouts.length, 3); assert.equal(asks, 1);
});

test("a warning-heavy combined check delivers the retained terminal failure to the scout", async t => {
	const f = trial(t, `console.error("compiler warning\\n".repeat(600)); console.error(["Window", "Inbox missing"].join(": ")); process.exit(1)`);
	await f.start();
	const result = (await f.status()).goal?.receipt;
	assert.ok(result?.output.endsWith("Window: Inbox missing\n"));
	assert.ok(f.scouts[0].prompt.includes("Window: Inbox missing"), "the inspector needs the actual failed step");
});

for (const research of [false, true]) test(`a diagnostic question after a focused read never opens an owner dialog: research ${research}`, async t => {
	const f = factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Open the Inbox.", target: "refs/heads/main",
			squads: ["account", "window"].map(id => ({ id, areas: [id], charter: "charter", checks: ["unit.mjs"], boundary: ["interface"],
				...(id === "account" && research ? { researchAgent: "foundry-research" } : {}) })), goalCheck: "goal.mjs", productCheck: "product.mjs" }),
		charter: "Use the shared account.", interface: "a".repeat(9000), "unit.mjs": "", "product.mjs": "",
		"goal.mjs": `console.error("warning\\n".repeat(700)); console.error(["Window", "Inbox missing"].join(": ")); process.exit(1)`,
	});
	let asks = 0;
	const owner = f.runtime(f.root, { ask: async () => { asks++; return null; } });
	await f.start(owner); const [account, window] = f.scouts;
	await account.report({ outcome: "needs-evidence", file: "interface", reason: "Check the account API.", evidence: ["charter"], grains: [] });
	const focus = f.scouts.at(-1); assert.ok(focus && focus.id !== window.id);
	const reason = "Did the Rust account step fail? The combined exit does not say.";
	await focus.report({ outcome: "needs-decision", reason, evidence: ["interface"], grains: [] });
	await owner.flush();
	assert.equal(asks, 0, "an operator is not a test runner");
	if (research) {
		const job = f.scouts.at(-1); assert.ok(job && job.id !== focus.id);
		assert.ok(job.prompt.includes(reason) && job.prompt.includes("Window: Inbox missing"));
		await job.report({ status: "unknown", reason: "No independent Rust verdict.", findings: [] });
	}
	await window.report({ outcome: "regenerate", reason: "Repair ordinary launch.", evidence: ["charter"],
		grains: [{ id: "window", directory: "window", check: "unit.mjs", task: "Display the Inbox.", needs: [] }] });
	owner.turn("owner"); await owner.flush(); await f.settle();
	const s = await f.status();
	assert.equal(asks, 0); assert.deepEqual(s.questions, []);
	assert.equal(s.reviews.filter(r => r.squad === "account").at(-1)?.observation?.outcome, "unresolved");
	assert.equal(f.workers.size, 1); assert.equal(s.nodes[0].grain, "window");
	assert.equal(f.scouts.length, research ? 4 : 3); assert.equal(s.qualified, null);
});

test("an already-satisfied baseline sends the checked SHA without inventing a writer or an archive target", async t => {
	const f = trial(t, "");
	/** @type {string[]} */ const notes = [];
	const owner = f.runtime(f.root, { notify: async message => { notes.push(message); return "admitted"; } });
	const done = await f.start(owner);
	assert.equal(done.qualified, f.tip); assert.equal(done.metrics?.firstWriter.state, "not-applicable");
	assert.equal(done.metrics?.firstWriter.elapsedMs, null); assert.equal(done.handoff?.writers, undefined);
	owner.turn("owner"); await owner.flush();
	assert.equal(notes.length, 1); assert.ok(notes[0].includes(f.tip));
});

test("a scout dispatched by a finished writer wakes the owner without consulting the old writer for input", async t => {
	const f = trial(t, "process.exit(1)"), questionsAsked = [];
	/** @type {string[]} */ const notices = [];
	const owner = f.runtime(f.root, { ask: async prompt => { questionsAsked.push(prompt); return "Use EUR"; } });
	await f.start(owner);
	await f.scouts[0].report(noGap);
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
	assert.equal(questionsAsked.length, 1);
	assert.deepEqual((await f.status()).reviews.find(r => r.id === scout.id)?.decision, { status: "answered", answer: "Use EUR" });
});

test("an unavailable native handoff route prepares only the notice; refusal cannot revoke or replay qualification", async t => {
	const f = trial(t);
	await f.start(); await f.scouts[0].report(noGap); await f.scouts[1].report(regenerate);
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

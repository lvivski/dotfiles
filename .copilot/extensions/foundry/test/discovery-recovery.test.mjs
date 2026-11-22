import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { openDatabase } from "../work/database.mjs";
import { scoutDefinition } from "../work/scouts.mjs";
import { factory, git, loadEntry, put } from "./fixture.mjs";

const run = "catalog", source = ".foundry/catalog.json";
/** @param {import("node:test").TestContext} t @param {string[]} [ids] @param {object} [policy] */
function trial(t, ids = ["price"], policy = {}) {
	const grains = ids.map(id => ({ id, directory: `src/${id}`, specification: "charter", boundary: ["interface"], check: "unit.mjs" }));
	return factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Look up the price of a product.", target: "refs/heads/main",
			grains, squads: ids.map(id => ({ id, charter: "charter", grains: [id] })), productCheck: "product.mjs", ...policy }),
		"goal.mjs": "process.exit(1)",
		charter: "Own the requested directory.", interface: "Return a decimal price.", "unit.mjs": "", "product.mjs": "",
	});
}
const noGap = { outcome: "no-gap", reason: "Nothing to change here.", evidence: ["charter"], grains: [] };

test("explicit review of one proven no-report charter, including the legacy ledger reason", async t => {
	const f = trial(t, ["price", "browse"], { goalCheck: "goal.mjs", limits: { assignments: 3, workers: 2 } });
	await f.start(); const [old, sibling] = f.scouts;
	await old.report(null); await sibling.report(noGap);
	const before = (await f.status()).reviews;
	assert.equal(before[0].reason, "Invalid scout result: No structured scout report was returned");
	assert.match(String((await f.status()).blocker), /No actionable/);
	const label = `scout:${old.squad}:${old.id}@${old.base}`, call = `call-${old.id}`;
	let status = "running", error = "Permission denied", toolCalls = 0, manual = false, launches = 0, budget = 1;
	let failed = [old.id];
	const conf = await loadEntry({ sessionId: "owner", on() {}, rpc: { mode: { get: async () => "interactive" },
		metadata: { getContextAttribution: async () => ({ contextAttribution: { promptTokenLimit: 2 * budget, categories: {
			systemPrompt: 0, customInstructions: 0, systemTools: 0, mcpTools: 0 } } }) },
		managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: manual ? "manual" : "assisted" }) },
		eventLog: { read: async () => ({ cursorStatus: "ok", hasMore: false, events: [
			{ type: "subagent.failed", data: { toolCallId: call, error, totalToolCalls: toolCalls } }] }) },
	}, workflow: {
		getRun: async () => ({ runId: old.workflowId, status, result: { reported: 1, failed } }),
		getRunDetail: async () => ({ runId: old.workflowId, workflowName: "foundry-scout", status,
			agents: [{ label, runId: old.workflowId, toolCallId: call, status: "failed" }] }),
		run: async (/** @type {string} */ name, /** @type {{args:{run:string,dispatch:string}}} */ opts) => {
			launches++; assert.equal(name, "foundry-scout");
			const jobs = await f.owner.scoutBatch(run, opts.args.dispatch, "owner", "fresh-workflow");
			assert.deepEqual(jobs.map(j => j.squad), [old.squad]);
			await f.owner.scoutResult(run, opts.args.dispatch, "owner", "fresh-workflow", jobs[0].id, noGap, jobs[0].packet);
			return { runId: "fresh-workflow", status: "completed" };
		} } });
	const ctx = { sessionId: "owner" }, hook = { ...ctx, timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "resume" }, ctx);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const tool = conf.tools?.find(t => t.name === "foundry_rereview"); assert.ok(tool?.handler, "missing foundry_rereview");
	const request = (review = old.id) => tool.handler?.({ run, review }, { ...ctx, arguments: {}, toolName: tool.name, toolCallId: "rereview" });
	assert.match(JSON.stringify(await request()), /terminal|completed/i);
	status = "completed";
	assert.match(JSON.stringify(await request()), /budget|recoverable/);
	error = "Request exceeds the model's prompt budget after reserving output (3210 tokens; limit 1234). Reduce context or compact before continuing.";
	toolCalls = 1; assert.match(JSON.stringify(await request()), /budget|recoverable/);
	toolCalls = 0; failed = [sibling.id]; assert.match(JSON.stringify(await request()), /no.report|failed/i);
	failed = [old.id]; manual = true; assert.match(JSON.stringify(await request()), /manual/i);
	manual = false;
	assert.match(JSON.stringify(await request(sibling.id)), /no.report|blocked/i);
	assert.match(JSON.stringify(await request()), /scout budget/);
	budget = 16000;
	assert.equal(launches, 0); assert.deepEqual((await f.status()).reviews, before);
	assert.equal(typeof await request(), "string");
	for (let i = 0; i < 20 && (await f.status()).reviews.at(-1)?.state !== "observed"; i++) await nextTurn();
	const after = (await f.status()).reviews;
	assert.deepEqual(after.slice(0, 2), before);
	assert.equal(after.length, 3); assert.deepEqual([after[2].squad, after[2].base, after[2].state], [old.squad, old.base, "observed"]);
	assert.match(JSON.stringify(await request()), /superseded|current/); assert.equal(launches, 1);
});

test("a proven zero-agent packet failure admits just one first scout with an exact current excerpt", async t => {
	const f = trial(t, ["price", "browse"], { goalCheck: "goal.mjs", limits: { assignments: 3 } });
	const excerpt = "price/cart: mismatch at checkout", code = `console.log("browse/row: unrelated failure\\n" + "x".repeat(150000) + "\\nprice/other: different failure\\n${excerpt}\\nprice/again: mismatch at checkout\\n" + "y".repeat(9000));process.exitCode=1`;
	put(f.root, "goal.mjs", code); git(f.root, "commit", "-qam", "verbose diagnostic");
	// This allowance cannot even fit the index, regardless of any diagnostic reduction.
	await f.start(f.runtime(f.root, { scoutBudget: async () => 1 }));
	const before = (await f.status()).reviews, [old] = before;
	assert.equal(f.scouts.length, 0); assert.match(String(old.reason), /pinned file index/);
	const db = openDatabase(f.root); t.after(() => db.close());
	const proof = db.read(run)?.goal?.check; assert.ok(proof);
	const original = db.read(run)?.effects.find(e => e.id === proof)?.receipt; assert.ok(original);
	assert.ok(original.output.includes(excerpt) && original.output.length >= 150000);
	let launched = 0, budget = 1, priorAgents = 0;
	const conf = await loadEntry({ sessionId: "owner", on() {}, rpc: { mode: { get: async () => "interactive" },
		metadata: { getContextAttribution: async () => ({ contextAttribution: { promptTokenLimit: 2 * budget, categories: {
			systemPrompt: 0, customInstructions: 0, systemTools: 0, mcpTools: 0 } } }) },
		managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: "assisted" }) }
	}, workflow: {
		getRun: async () => ({ runId: old.workflowId, status: "completed", result: { reported: 0, failed: [] } }),
		getRunDetail: async () => ({ runId: old.workflowId, workflowName: "foundry-scout", status: "completed", agents: Array(priorAgents).fill({}) }),
		run: async (/** @type {string} */ name, /** @type {{args:{dispatch:string}}} */ opts) => {
			launched++; const [job, ...others] = await f.owner.scoutBatch(run, opts.args.dispatch, "owner", "first-scout");
			assert.equal(name, "foundry-scout"); assert.deepEqual(others, []); assert.equal(job.squad, old.squad);
			assert.ok(job.prompt.includes(excerpt) && !job.prompt.includes("x".repeat(1000)) && job.packet.partial);
			await f.owner.scoutResult(run, opts.args.dispatch, "owner", "first-scout", job.id, { ...noGap, outcome: "unresolved" }, job.packet);
			return { runId: "first-scout", status: "completed" };
		} } });
	const ctx = { sessionId: "owner" }, hook = { ...ctx, timestamp: new Date(), workingDirectory: f.root };
	await conf.hooks?.onSessionStart?.({ ...hook, source: "resume" }, ctx);
	t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const tool = conf.tools?.find(t => t.name === "foundry_rereview"); assert.ok(tool?.handler);
	const request = () => tool.handler?.({ run, review: old.id },
		{ ...ctx, arguments: {}, toolName: tool.name, toolCallId: "request-first-scout" });
	assert.match(JSON.stringify(await request()), /scout budget/);
	budget = 16000; priorAgents = 1; assert.match(JSON.stringify(await request()), /zero.agent|no agents/);
	priorAgents = 0;
	assert.equal(launched, 0); assert.deepEqual((await f.status()).reviews, before);
	assert.equal(typeof await request(), "string");
	for (let i = 0; i < 30 && (await f.status()).reviews.at(-1)?.state !== "observed"; i++) await nextTurn();
	const after = (await f.status()).reviews;
	assert.deepEqual(after.slice(0, 2), before); assert.equal(after.length, 3); assert.equal(after[2].state, "observed");
	assert.equal(after[2].retryOf, old.id); assert.equal(after[2].squad, old.squad);
	assert.match(JSON.stringify(await request()), /superseded|current/);
	assert.equal(launched, 1); assert.equal(f.checks.length, 1); assert.deepEqual(db.read(run)?.effects.find(e => e.id === proof)?.receipt, original);
});

for (const changed of ["target", "paused", "limit"]) test(`owner rereview cannot bypass ${changed} during native verification`, async t => {
	const limit = changed === "limit" ? 1 : 2, f = trial(t, ["price"], { goalCheck: "goal.mjs", limits: { assignments: limit } });
	await f.start(); const [job] = f.scouts; await job.report(null);
	let reads = 0;
	const r = f.runtime(f.root, { confirmNoReport: async () => {
		reads++;
		if (changed === "paused") await f.owner.operation("pause", { run }, "owner");
		else { put(f.root, "changed-product", "a different product"); git(f.root, "add", "changed-product"); git(f.root, "commit", "-qm", "new product"); }
	}, scout: async () => assert.fail("no new work") });
	const args = { run, review: job.id };
	await assert.rejects(r.operation("rereview", args, "stranger"), { code: "foreign_run" });
	await assert.rejects(r.operation("rereview", args, "owner"), { code: changed === "target" ? "superseded" : changed });
	assert.equal(reads, changed === "limit" ? 0 : 1);
	assert.equal((await f.status()).reviews.length, 1);
});

const full = "This session already has 4 active workflow runs, which is the concurrent limit";

test("a full native workflow slot queues the same scout until admission, without an operator turn", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = trial(t, ["price", "browse"], { limits: { assignments: 2 } });
	/** @type {string[]} */ const tickets = [];
	let occupied = 4;
	const issuer = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		tickets.push(ticket);
		if (occupied === 4) throw Error(full);
		const jobs = await f.owner.scoutBatch(id, ticket, actor, "admitted");
		for (const job of jobs) await f.owner.scoutResult(id, ticket, actor, "admitted", job.id, noGap, job.packet);
		return { runId: "admitted", status: "completed" };
	} });
	const before = await f.start(issuer);
	assert.deepEqual(before.pending.map(e => e.state), ["ready", "ready"]);
	assert.match(String(before.pending[0].reason), /capacity/i);
	issuer.turn("owner"); await issuer.flush();
	assert.equal(tickets.length, 1, "other wakes must not hammer a full session");
	t.mock.timers.tick(60_000); await nextTurn(); await issuer.flush();
	assert.equal(tickets.length, 2, "still full, only one attempt for the batch");
	occupied--;
	t.mock.timers.tick(60_000); await nextTurn(); await issuer.flush();
	assert.equal(tickets.length, 3);
	assert.deepEqual((await f.status()).reviews.map(e => [e.id, e.state]), before.reviews.map(e => [e.id, "observed"]));
	await assert.rejects(f.owner.scoutBatch(run, tickets[0], "owner", "late"), { code: "foreign_assignment" });
});

test("a capacity wake does not dispatch through a pause", async t => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const f = trial(t);
	let attempts = 0;
	const issuer = f.runtime(f.root, { scout: async () => { attempts++; throw Error(full); } });
	await f.start(issuer);
	await issuer.operation("pause", { run }, "owner");
	t.mock.timers.tick(60_000); await nextTurn(); await issuer.flush();
	assert.equal(attempts, 1);
	const s = await f.status();
	assert.equal(s.pending[0].state, "ready");
});

test("reconnect recovers a persisted capacity rejection but never reissues a bound scout", async t => {
	const f = trial(t, ["price", "browse"]);
	const old = f.runtime(f.root, { scout: async () => { throw Error("lost reply"); } });
	const before = await f.start(old); old.close();
	const db = openDatabase(f.root);
	try {
		db.update(run, r => {
			// Reproduce one reader-7 unbound rejection and a separate workflow already bound.
			for (const e of r.effects) if (e.kind === "scout") {
				if (e.squad === "price") e.error = `Discovery unconfirmed: Error: ${full}. Resume to retry unbound discovery.`;
				else { e.callId = "other-dispatch"; e.workflowId = "existing"; }
			}
		});
	} finally { db.close(); }
	f.owner.turn("owner"); await f.owner.flush(); await f.settle();
	assert.deepEqual(f.scouts.map(s => s.id), [before.reviews[0].id]);
	await f.scouts[0].report(noGap);
	assert.deepEqual((await f.status()).reviews.map(r => [r.state, r.workflowId]),
		[["observed", f.scouts[0].workflowId], ["reading", "existing"]]);
});

test("an unbound workflow launch is not retried on turns; explicit resume invalidates its old dispatch", async t => {
	const f = trial(t);
	/** @type {string[]} */ const tickets = [];
	const old = f.runtime(f.root, { scout: async (_, ticket) => { tickets.push(ticket); throw Error("dynamic_workflows_unavailable"); } });
	const s = await f.start(old);
	assert.equal(tickets.length, 1); assert.equal(s.reviews.length, 1);
	assert.match(String(s.pending[0]?.reason), /dynamic_workflows_unavailable/);
	old.turn("owner"); await old.flush();
	assert.equal(tickets.length, 1); assert.equal(f.workers.size, 0); assert.equal(f.scouts.length, 0);
	old.close();
	await f.owner.operation("resume", { source }, "owner"); await f.settle();
	const [job] = f.scouts; assert.equal(job.id, s.reviews[0].id); assert.notEqual(job.dispatch, tickets[0]);
	await assert.rejects(f.owner.scoutBatch(run, tickets[0], "owner", "late-workflow"), { code: "foreign_assignment" });
	await job.report(noGap);
	assert.equal((await f.status()).reviews[0].state, "observed");
});

test("resume cannot start a missing run or disturb a bound workflow", async t => {
	const f = trial(t);
	await assert.rejects(f.owner.operation("resume", { source }, "owner"), { code: "missing_run" });
	assert.equal(f.scouts.length, 0); assert.equal(f.workers.size, 0);
	const live = await f.start();
	assert.deepEqual(await f.owner.operation("resume", { source }, "owner"), live);
	assert.equal(f.scouts.length, 1);
});

for (const status of ["paused", "halted"]) test(`explicit resume continues only the missing report of a bound ${status} batch`, async t => {
	const f = trial(t, ["price", "browse"]), workflow = "original-workflow";
	let dispatch = "", starts = 0, resumes = 0;
	const owner = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		dispatch = ticket; starts++;
		const [first] = await f.owner.scoutBatch(id, ticket, actor, workflow);
		await f.owner.scoutResult(id, ticket, actor, workflow, first.id, noGap, first.packet);
		return { runId: workflow, status };
	} });
	const stopped = await f.start(owner);
	assert.deepEqual(stopped.reviews.map(r => r.state), ["observed", "reading"]);
	assert.equal(stopped.reviews[1].workflowId, workflow);
	owner.close();
	let held = true;
	const issuer = f.runtime(f.root, {
		permissionBlocker: async () => held ? { scope: "session", message: "Manual approvals." } : null,
		scout: async () => assert.fail("No replacement workflow"),
		scoutState: async id => ({ runId: id, status }),
		scoutSnapshot: async id => ({ runId: id, status }),
		resumeScout: async id => {
			resumes++; assert.equal(id, workflow);
			const jobs = await f.owner.scoutBatch(run, dispatch, "owner", workflow);
			assert.deepEqual(jobs.map(j => j.id), [stopped.reviews[1].id]);
			await f.owner.scoutResult(run, dispatch, "owner", workflow, jobs[0].id, noGap, jobs[0].packet);
			return { runId: workflow, status: "completed" };
		},
	});
	issuer.turn("owner"); await issuer.flush(); await nextTurn();
	assert.equal(resumes, 0);
	await assert.rejects(issuer.operation("resume", { source }, "owner"), /Manual approvals/);
	held = false;
	await issuer.operation("start", { source }, "owner"); await nextTurn();
	assert.equal(resumes, 0);
	await issuer.operation("resume", { source }, "owner"); await nextTurn(); await issuer.flush();
	assert.deepEqual((await f.status()).reviews.map(r => r.state), ["observed", "observed"]);
	await issuer.operation("resume", { source }, "owner");
	assert.deepEqual([starts, resumes, f.workers.size], [1, 1, 0]);
});

for (const envelope of [{ status: "cancelled" }, { status: "error", failure: { type: "workflow_limit_reached" } },
	{ status: "halted", failure: { type: "workflow_resume_declined" } }])
	test(`a ${envelope.failure?.type ?? envelope.status} envelope cannot authorize scout continuation`, async t => {
		const f = trial(t), workflow = "original-workflow";
		let starts = 0, resumes = 0;
		const owner = f.runtime(f.root, {
			scout: async (id, ticket, actor) => { starts++; await f.owner.scoutBatch(id, ticket, actor, workflow); return { runId: workflow, ...envelope }; },
			scoutSnapshot: async id => ({ runId: id, ...envelope }),
			resumeScout: async id => { resumes++; return { runId: id, status: "completed" }; },
		});
		assert.equal((await f.start(owner)).reviews[0].state, "blocked");
		await owner.operation("resume", { source }, "owner");
		assert.deepEqual([starts, resumes, f.workers.size], [1, 0, 0]);
	});

test("owner resume respects a newer native refusal even when Foundry last saw a paused attempt", async t => {
	const f = trial(t), workflow = "original-workflow";
	const owner = f.runtime(f.root, {
		scout: async (id, ticket, actor) => { await f.owner.scoutBatch(id, ticket, actor, workflow); return { runId: workflow, status: "paused" }; },
		scoutSnapshot: async id => ({ runId: id, status: "halted", failure: { type: "workflow_resume_declined" } }),
		resumeScout: async () => assert.fail("Stale paused envelope cannot override refusal"),
	});
	assert.equal((await f.start(owner)).reviews[0].state, "reading");
	const refused = await owner.operation("resume", { source }, "owner");
	assert.equal(refused.reviews[0].state, "blocked");
	assert.match(String(refused.reviews[0].reason), /workflow_resume_declined/);
	assert.equal(f.workers.size, 0);
});

test("a permission hold inside the resumed workflow checkpoints the original dispatch instead of completing it", async t => {
	const f = trial(t); await f.start(); const [job] = f.scouts;
	let manual = true, calls = 0;
	const issuer = f.runtime(f.root, { permissionBlocker: async () => manual ? { scope: "session", message: "Manual approvals." } : null });
	const workflow = scoutDefinition(() => issuer);
	/** @type {Parameters<typeof workflow.run>[0]} */
	const ctx = { runId: job.workflowId, args: { run, dispatch: job.dispatch }, session: /** @type {typeof ctx.session} */ ({ sessionId: job.issuer }),
		signal: new AbortController().signal, log() {}, phase() {}, step: async (_key, fn) => fn(), parallel: fs => Promise.all(fs.map(fn => fn())),
		agent: async () => { calls++; return noGap; }, pause: async key => { assert.equal(key, "dispatch-held:1"); throw new DOMException("paused", "AbortError"); },
		pipeline: () => assert.fail("unexpected pipeline"), workflow: () => assert.fail("nested workflow") };
	await assert.rejects(workflow.run(ctx), { name: "AbortError" });
	assert.equal(calls, 0);
	assert.equal((await f.status()).reviews[0].workflowId, job.workflowId);
	manual = false;
	assert.deepEqual(await workflow.run(ctx), { reported: 1, failed: [] });
	assert.equal(calls, 1); assert.equal(f.scouts.length, 1);
});

test("a reconnected issuer observes the original workflow; evidence received through a pause issues work only on resume", async t => {
	const f = trial(t), first = f.runtime(f.root);
	await f.start(first); const [job] = f.scouts; first.close();
	/** @type {string[]} */ const lookups = [];
	/** @type {() => void} */ let finish = () => {};
	const complete = new Promise(resolve => { finish = () => resolve(undefined); });
	const issuer = f.runtime(f.root, {
		scout: async () => assert.fail("A bound workflow must never be relaunched"),
		scoutState: async id => { lookups.push(id); await complete; return { runId: id, status: "completed" }; },
	});
	issuer.turn("owner"); await issuer.flush();
	issuer.turn("owner"); await issuer.flush();
	assert.deepEqual(lookups, [job.workflowId]);
	await issuer.operation("pause", { run }, "owner");
	await issuer.scoutResult(run, job.dispatch, job.issuer, job.workflowId, job.id,
		{ outcome: "regenerate", reason: "The price lookup is missing.", evidence: ["charter"], grains: ["price"] }, job.packet);
	finish(); await nextTurn();
	const paused = await f.status();
	assert.equal(paused.reviews[0].state, "reported"); assert.deepEqual(paused.nodes, []); assert.equal(f.workers.size, 0);
	const live = await issuer.operation("resume", { source }, "owner");
	assert.equal(live.reviews[0].state, "observed"); assert.equal(live.nodes[0].state, "writing"); assert.equal(f.workers.size, 1);
});

test("simultaneous reports with no new assignments require just one scheduler wake", async t => {
	const f = trial(t, ["price", "browse", "export", "index"]);
	let reads = 0;
	const issuer = f.runtime(f.root, { mode: async () => { reads++; return "interactive"; } });
	await f.start(issuer);
	assert.equal(f.scouts.length, 4);
	reads = 0;
	await Promise.all(f.scouts.map(job => job.report(noGap)));
	assert.equal(reads, 1, "a single executable-mode read served the merged wake");
	assert.ok((await f.status()).reviews.every(r => r.state === "observed"));
});

test("the issuer consumes a durable report even when a different runtime received it", async t => {
	const f = trial(t), workflow = "bound-workflow";
	const issuer = f.runtime(f.root, { scout: async (id, ticket, actor) => {
		const [job] = await f.owner.scoutBatch(id, ticket, actor, workflow);
		await f.owner.scoutResult(id, ticket, actor, workflow, job.id,
			{ ...noGap, outcome: "regenerate", grains: ["price"] }, job.packet);
		return { runId: workflow, status: "completed" };
	} });
	await f.start(issuer); await issuer.flush();
	assert.equal((await f.status()).reviews[0].state, "observed"); assert.equal(f.workers.size, 1);
});

test("a workflow cannot use another review's delivery receipt or another base", async t => {
	const f = trial(t, ["price", "browse"]); await f.start();
	const [a, b] = f.scouts;
	await f.owner.scoutResult(run, a.dispatch, a.issuer, a.workflowId, a.id, noGap, b.packet);
	await f.owner.scoutResult(run, b.dispatch, b.issuer, b.workflowId, b.id, noGap, { ...b.packet, base: "a".repeat(40) });
	await a.report(noGap); await b.report(noGap);
	for (const review of (await f.status()).reviews) {
		assert.equal(review.state, "blocked"); assert.match(String(review.reason), /mismatched journaled scout packet/);
	}
	assert.equal(f.workers.size, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { scoutDefinition } from "../work/scouts.mjs";
import { factory } from "./fixture.mjs";

const run = "catalog", source = ".foundry/catalog.json";
/** @param {import("node:test").TestContext} t @param {string[]} [ids] */
function trial(t, ids = ["price"]) {
	const grains = ids.map(id => ({ id, directory: `src/${id}`, specification: "charter", boundary: ["interface"], check: "unit.mjs" }));
	return factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Look up the price of a product.", target: "refs/heads/main",
			grains, squads: ids.map(id => ({ id, charter: "charter", grains: [id] })), productCheck: "product.mjs" }),
		charter: "Own the requested directory.", interface: "Return a decimal price.", "unit.mjs": "", "product.mjs": "",
	});
}
const noGap = { outcome: "no-gap", reason: "Nothing to change here.", evidence: ["charter"], grains: [] };

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

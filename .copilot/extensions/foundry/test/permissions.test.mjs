import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { ledgerPath } from "../work/database.mjs";
import { permissionCheck } from "../work/permissions.mjs";
import { factory, loadEntry } from "./fixture.mjs";

const source = ".foundry/trial.json", run = "trial", actor = "owner";
function trial(/** @type {import("node:test").TestContext} */ t) {
	const charter = "brief.md", check = ".foundry/component.mjs", goal = ".foundry/goal.mjs";
	const squads = ["codec", "projection", "storage", "command"].map(id => ({
		id, charter, areas: [`stock/${id}`], boundary: ["interface.md"], checks: [check]
	}));
	return factory(t, run, source, {
		[source]: JSON.stringify({ version: 2, id: run, direction: "Generate an inventory journal.", target: "refs/heads/main",
			productCheck: check, goalCheck: goal, squads }),
		[charter]: "Implement the assigned area.", "interface.md": "Export journal operations.", [check]: "process.exit(0)", [goal]: "process.exit(1)"
	});
}

test("the selected mode must be permitted by the resolved snapshot, not merely available", async () => {
	/** @param {Awaited<ReturnType<Parameters<typeof permissionCheck>[0]>>} policy @param {string} mode */
	const decide = (policy, mode) => permissionCheck(async () => policy, async () => ({ mode }))();
	const resolved = { failClosed: false, permissionsContext: { failClosed: false } };
	assert.equal(await decide({ ...resolved, bypassPermissionsDisabled: true }, "assisted"), null);
	assert.equal(await decide({ ...resolved, bypassPermissionsDisabled: false }, "allow-all"), null);
	assert.equal((await decide(resolved, "manual"))?.scope, "session");
	for (const mode of ["manual", "assisted"]) {
		assert.equal((await decide({ ...resolved, failClosed: true }, mode))?.scope, "run");
		assert.equal((await decide({ ...resolved, permissionsContext: { failClosed: true } }, mode))?.scope, "run");
	}
	assert.equal((await decide({ ...resolved, bypassPermissionsDisabled: true }, "allow-all"))?.scope, "run");
	assert.equal((await decide(resolved, "allow-all"))?.scope, "run");
	assert.equal((await decide(resolved, "unknown"))?.scope, "run");
});

test("concurrent permission reads share a timeout, not a decision for the next batch", { timeout: 3000 }, async () => {
	let reads = 0, release = () => {}, mode = "assisted";
	const resolved = { failClosed: false };
	const first = new Promise(resolve => { release = () => resolve(resolved); });
	const check = permissionCheck(async () => ++reads === 1 ? first : resolved, async () => ({ mode }), 20);
	const [a, b] = await Promise.all([check(), check()]);
	assert.equal(reads, 1);
	assert.equal(a?.scope, "run");
	assert.equal(b, a);
	mode = "manual";
	release();
	assert.equal((await check())?.scope, "session");
	mode = "assisted";
	assert.equal(await check(), null);
});

test("extension entry: unresolved permissions stop confirmation, baseline and all four scouts; Assisted resumes once", async t => {
	const f = trial(t);
	let failClosed = true, mode = "manual", policyReads = 0, modeReads = 0, confirmations = 0, loseOnConfirm = false;
	/** @type {string[]} */ const calls = [], notices = [];
	const getMode = async () => { modeReads++; return { mode }; };
	/** @type {{getMode?:typeof getMode}} */ const permissions = { getMode };
	const session = {
		sessionId: actor, on() {}, log: (/** @type {string} */ message) => notices.push(message),
		ui: { confirm: async () => { confirmations++; if (loseOnConfirm) failClosed = true; return true; } },
		rpc: { mode: { get: async () => "autopilot" }, permissions,
			managedSettings: { get: async () => { policyReads++; return { failClosed, permissionsContext: { failClosed }, bypassPermissionsDisabled: true }; } },
			tools: { execute: async (/** @type {{name:string,arguments:import("../work/model.js").Effect["args"],toolCallId:string}} */ call) => {
				calls.push(call.name);
				const result = await f.execute(call.name, call.arguments, call.toolCallId);
				if (call.name === "bash") failClosed = true;
				return result;
			} },
		},
	};
	const declaration = await loadEntry(session);
	const hook = { sessionId: actor, timestamp: new Date(), workingDirectory: f.root }, ctx = { sessionId: actor };
	await declaration.hooks?.onSessionStart?.({ ...hook, source: "startup" }, ctx);
	t.after(() => declaration.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const handler = declaration.tools?.find(tool => tool.name === "foundry_start")?.handler;
	assert.ok(handler);
	const start = () => handler({ source }, { sessionId: actor, toolName: "foundry_start", toolCallId: "start", arguments: { source } });
	/** @param {RegExp} reason */
	async function blocked(reason) {
		const result = await start();
		assert.ok(result && typeof result === "object" && "resultType" in result && result.resultType === "failure" && "textResultForLlm" in result);
		assert.match(String(result.textResultForLlm), reason);
		assert.deepEqual(calls, []);
		assert.equal(existsSync(ledgerPath(f.root)), false);
	}
	await blocked(/not resolved/);
	assert.deepEqual([policyReads, modeReads, confirmations], [1, 1, 0]);
	failClosed = false;
	await blocked(/manual tool approvals/);
	delete permissions.getMode;
	await blocked(/could not confirm/);
	permissions.getMode = async () => { throw Error("RPC unavailable"); };
	await blocked(/could not confirm/);
	assert.equal(confirmations, 0);
	permissions.getMode = getMode;
	mode = "assisted"; loseOnConfirm = true;
	await blocked(/not resolved/);
	assert.equal(confirmations, 1);

	failClosed = false; loseOnConfirm = false;
	assert.equal(typeof await start(), "string");
	const paused = await f.status();
	assert.equal(paused.active, false);
	assert.match(String(paused.blocker), /not resolved/);
	assert.equal(paused.goal?.receipt?.exit, 1);
	assert.deepEqual(calls, ["bash"]);
	assert.equal(notices.length, 1);

	failClosed = false;
	assert.equal(typeof await start(), "string");
	const resumed = await f.status();
	assert.equal(resumed.active, true);
	assert.equal(resumed.blocker, undefined);
	assert.deepEqual(resumed.goal, paused.goal);
	assert.deepEqual(resumed.reviews.map(r => r.id), paused.reviews.map(r => r.id));
	assert.equal(f.workers.size, 4);
	assert.deepEqual(calls, ["bash", ...Array(4).fill("create_session")]);
});

test("permission loss after the baseline pauses once; explicit resumption dispatches the same four scouts", async t => {
	const f = trial(t);
	let failClosed = false;
	/** @type {string[]} */ const notices = [];
	const owner = f.runtime(f.root, { permissionBlocker: permissionCheck(async () => ({ failClosed }), async () => ({ mode: "assisted" })),
		log: m => notices.push(m), execute: async (...args) => {
		const result = await f.execute(...args);
		if (args[0] === "bash") failClosed = true;
		return result;
	} });
	const stopped = await owner.operation("start", { source }, actor);
	assert.equal(stopped.active, false);
	assert.match(String(stopped.blocker), /not resolved/);
	assert.equal(stopped.goal?.receipt?.exit, 1);
	assert.equal(f.workers.size, 0);
	failClosed = false;
	owner.turn(actor); await owner.flush();
	assert.equal(f.workers.size, 0);
	assert.equal(notices.length, 1);
	const resumed = await owner.operation("start", { source }, actor);
	assert.equal(resumed.blocker, undefined);
	assert.equal(resumed.active, true);
	assert.deepEqual(resumed.goal, stopped.goal);
	assert.deepEqual(resumed.reviews.map(r => r.id), stopped.reviews.map(r => r.id));
	assert.equal(f.workers.size, 4);
});

test("a scout's Manual setting holds its writer reservation, not the other scouts' work", async t => {
	const f = trial(t);
	const { reviews } = await f.start();
	const [codec, projection] = [...f.workers.values()];
	let mode = "manual";
	const permissions = permissionCheck(async () => ({ failClosed: false }), async () => ({ mode }));
	const scout = f.runtime(codec.cwd, { permissionBlocker: permissions });
	/** @param {typeof codec} worker @param {string} id @param {typeof scout} runtime */
	const propose = (worker, id, runtime) => runtime.operation("observe", { run, token: worker.token, outcome: "regenerate",
		reason: `Implement ${id}`, evidence: ["brief.md"], grains: [{ id, directory: `stock/${id}`, task: id, check: ".foundry/component.mjs" }] }, worker.id);
	await propose(codec, reviews[0].squad, scout);
	const held = await f.status();
	assert.equal(held.active, true);
	assert.equal(held.blocker, undefined);
	const reservation = held.pending.find(e => e.kind === "writer" && e.issuer === codec.id);
	assert.ok(reservation);
	assert.match(String(reservation.reason), /manual tool approvals/i);
	assert.equal(reservation.state, "ready");
	await propose(projection, reviews[1].squad, f.runtime(projection.cwd));
	const writer = [...f.workers.values()].at(-1); assert.ok(writer && writer.prompt.includes("complete stock/projection/"));
	await f.runtime(writer.cwd).operation("submit", { run, token: writer.token }, writer.id);
	const receipt = (await f.status()).nodes.find(n => n.grain === "projection")?.receipt;
	assert.ok(receipt && receipt.exit === 0);
	scout.close();
	const reopened = f.runtime(codec.cwd, { permissionBlocker: permissions });
	f.owner.turn(actor); reopened.turn(codec.id); await Promise.all([f.owner.flush(), reopened.flush()]);
	assert.deepEqual((await f.status()).pending.find(e => e.id === reservation.id), reservation);
	assert.equal(f.workers.size, 5);
	mode = "assisted";
	reopened.turn(codec.id); await reopened.flush();
	assert.equal(f.workers.size, 6);
	assert.equal((await f.status()).nodes.find(n => n.grain === "codec")?.worker, [...f.workers.keys()].at(-1));
	reopened.turn(codec.id); await reopened.flush();
	assert.equal(f.workers.size, 6);
});

test("prepared calls survive local holds and global pauses; stale preflight cannot undo issuance", async t => {
	const f = trial(t);
	let mode = "assisted", failClosed = false;
	const owner = f.runtime(f.root, { permissionBlocker: permissionCheck(async () => ({ failClosed }), async () => ({ mode })),
		execute: async (...args) => args[0] === "bash" ? f.execute(...args) : { resultType: "failure", error: "This session management tool is disabled" } });
	const { prepared } = await owner.operation("start", { source }, actor);
	assert.equal(prepared.length, 4);
	const [call] = prepared;
	mode = "manual";
	await assert.rejects(owner.pre(call.tool, call.arguments, actor, "local"), /manual tool approvals/i);
	const local = await f.status();
	assert.equal(local.active, true);
	assert.equal(local.blocker, undefined);
	assert.equal(local.prepared.length, 0);
	assert.ok(local.pending.every(e => e.state === "ordinary" && /manual tool approvals/i.test(String(e.reason))));
	failClosed = true;
	await assert.rejects(owner.pre(call.tool, call.arguments, actor, "held"), /not resolved/);
	const held = await f.status();
	assert.equal(held.active, false);
	assert.ok(held.pending.every(e => e.state === "ordinary"));
	mode = "assisted"; failClosed = false;
	const resumed = await owner.operation("start", { source }, actor);
	assert.deepEqual(resumed.prepared, prepared);
	let release = () => {};
	const late = f.runtime(f.root, { permissionBlocker: () => new Promise(resolve => { release = () => resolve({ scope: "run", message: "Unresolved policy" }); }) });
	const stale = late.pre(call.tool, call.arguments, actor, "late");
	await owner.pre(call.tool, call.arguments, actor, "original");
	release();
	await assert.rejects(stale, /reservation changed/i);
	const claimed = await f.status();
	assert.equal(claimed.active, true);
	assert.equal(claimed.pending.filter(e => e.state === "issued").length, 1);
	assert.equal(f.workers.size, 0);
});

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ledgerPath } from "./database.mjs";
import { permissionCheck } from "./permissions.mjs";
import { factory, git, loadEntry, put } from "../test/fixture.mjs";

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

/** @param {string} id @param {string} [directory] @param {string[]} [needs] */
const grain = (id, directory = `stock/${id}`, needs = []) => ({ id, directory, needs, task: `Implement ${id}`, check: ".foundry/component.mjs" });
/** @param {ReturnType<typeof grain>[]} grains */
const report = grains => ({ outcome: grains.length ? "regenerate" : "no-gap", reason: "Implement the missing journal operations", evidence: ["brief.md"], grains });

test("the selected mode must be permitted by the resolved snapshot, not merely available", async () => {
	/** @param {Awaited<ReturnType<Parameters<typeof permissionCheck>[0]>>} policy @param {string} mode */
	const decide = (policy, mode) => permissionCheck(async () => policy, async () => ({ mode })).blocker();
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
	const {blocker:check} = permissionCheck(async () => ++reads === 1 ? first : resolved, async () => ({ mode }), 20);
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

for (const approval of ["the form's accept button","effective allow-all on this call","Autopilot on this call"]) test(`extension entry: repin needs only ${approval}`, async t => {
	const f = trial(t), file = ".foundry/goal.mjs", side = path.join(path.dirname(f.root), "repin");
	await f.start();
	for (const scout of [...f.scouts]) await scout.report(report([]));
	const before = await f.status();
	assert.ok(before.blocker);
	git(f.root, "worktree", "add", "-q", "--detach", side, f.tip);
	put(side, file, "process.exit(2)"); git(side, "commit", "-qam", "Fix evaluator");
	const revision = git(side, "rev-parse", "HEAD"), args = { run, from: f.tip, revision, files: [file] };
	let action = "decline", mode = "assisted", execution = "interactive", failClosed = false, restricted = false, prompts = 0;
	const declaration = await loadEntry({ sessionId: actor, on() {},
		ui: { elicitation: async (/** @type {import("@github/copilot-sdk").ElicitationParams} */ form) => {
			prompts++; assert.deepEqual(form.requestedSchema, { type: "object", properties: {} });
			assert.ok([f.tip, revision, file].every(s => form.message.includes(s)));
			return { action };
		} }, rpc: { mode: { get: async () => execution }, managedSettings: { get: async () => ({ failClosed, bypassPermissionsDisabled: restricted }) },
			permissions: { getMode: async () => ({ mode }) },
			tools: { execute: async (/** @type {{name:string,arguments:import("./model.js").Effect["args"],toolCallId:string}} */ c) => f.execute(c.name, c.arguments, c.toolCallId) } } });
	const ctx = { sessionId: actor }, hook = { ...ctx, timestamp: new Date(), workingDirectory: f.root };
	await declaration.hooks?.onSessionStart?.({ ...hook, source: "startup" }, ctx);
	t.after(() => declaration.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	const handler = declaration.tools?.find(x => x.name === "foundry_repin")?.handler; assert.ok(handler);
	if (approval !== "the form's accept button") {
		const call=()=>handler(args,{...ctx,toolName:"foundry_repin",toolCallId:`repin-${execution}-${mode}-${restricted}-${failClosed}`,arguments:args});
		execution="autopilot";
		mode="allow-all"; restricted=true;
		const blocked=await call(); assert.deepEqual((await f.status()).goalChecks,before.goalChecks);
		if (approval === "Autopilot on this call") {
			assert.match(JSON.stringify(blocked),/Managed policy/); assert.equal(prompts,0);
		}
		restricted=false; failClosed=true;
		if (approval === "Autopilot on this call") mode="assisted";
		else execution="interactive";
		await call(); assert.deepEqual((await f.status()).goalChecks,before.goalChecks);
		if (execution==="autopilot") {
			assert.equal(prompts,0,"an unresolved permission cannot be approved via a Foundry prompt");
			failClosed=false; mode="manual";
			assert.match(JSON.stringify(await call()),/manual tool approvals/); assert.equal(prompts,0);
			execution="plan"; mode="assisted";
			assert.match(JSON.stringify(await call()),/Plan mode|executable/i); assert.equal(prompts,0);
			execution="autopilot";
		}
		failClosed=false; const last=prompts;
		const result=await call();
		assert.equal(prompts,last,`${approval} must not elicit an evaluator-change confirmation`);
		assert.equal(typeof result,"string",JSON.stringify(result));
		const after=await f.status();
		assert.equal(after.goal?.pin,revision); assert.equal(after.goal?.receipt?.exit,2); return;
	}
	for (action of ["decline", "cancel", "accept"]) {
		const result = await handler(args, { ...ctx, toolName: "foundry_repin", toolCallId: action, arguments: args });
		const after = await f.status();
		if (action !== "accept") {
			assert.ok(result && typeof result === "object" && "resultType" in result && result.resultType === "rejected");
			assert.ok("textResultForLlm" in result && String(result.textResultForLlm).includes(before.blocker));
			assert.equal(after.active, true);
			assert.deepEqual(after.goalChecks, before.goalChecks);
		}
		assert.equal(after.goal?.pin, action === "accept" ? revision : f.tip);
	}
});

test("extension entry: explicit start and resume need no Foundry dialog and still enforce host permissions", async t => {
	const f = trial(t);
	let failClosed = true, mode = "manual", policyReads = 0, modeReads = 0;
	/** @type {string[]} */ const calls = [], notices = [];
	/** @type {{name:string,args:{run:string,dispatch:string}}[]} */ const batches = [];
	const getMode = async () => { modeReads++; return { mode }; };
	/** @type {{getMode?:typeof getMode}} */ const permissions = { getMode };
	const session = {
		sessionId: actor, on() {}, log: (/** @type {string} */ message) => notices.push(message),
		ui: { elicitation: async () => assert.fail("unexpected second activation prompt") },
		workflow: { run: async (/** @type {string|{meta:{name:string}}} */ workflow, /** @type {{args:{run:string,dispatch:string}}} */ options) => {
			calls.push("workflow.run");
			batches.push({ name: typeof workflow === "string" ? workflow : workflow.meta.name, args: options.args });
			return new Promise(() => {}); // Admitted workflow, no results yet.
		} },
		rpc: { mode: { get: async () => "autopilot" }, permissions,
			managedSettings: { get: async () => { policyReads++; return { failClosed, permissionsContext: { failClosed }, bypassPermissionsDisabled: true }; } },
			tools: { execute: async (/** @type {{name:string,arguments:import("./model.js").Effect["args"],toolCallId:string}} */ call) => {
				calls.push(call.name);
				const result = await f.execute(call.name, call.arguments, call.toolCallId);
				if (call.name === "bash") failClosed = true;
				return result;
			} },
		},
	};
	const declaration = await loadEntry(session);
	assert.equal(declaration.tools?.some(tool => tool.name === "foundry_observe"), false, "only workflow results can report scout work");
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
	assert.deepEqual([policyReads, modeReads], [1, 1]);
	failClosed = false;
	await blocked(/manual tool approvals/);
	delete permissions.getMode;
	await blocked(/could not confirm/);
	permissions.getMode = async () => { throw Error("RPC unavailable"); };
	await blocked(/could not confirm/);
	permissions.getMode = getMode;
	mode = "assisted";
	assert.equal(typeof await start(), "string");
	const paused = await f.status();
	assert.equal(paused.active, false);
	assert.match(String(paused.blocker), /not resolved/);
	assert.equal(paused.goal?.receipt?.exit, 1);
	assert.deepEqual(calls, ["bash"]);
	assert.equal(notices.length, 1);

	failClosed = false;
	const resume = declaration.tools?.find(tool => tool.name === "foundry_resume")?.handler; assert.ok(resume);
	assert.equal(typeof await resume({ source }, { sessionId: actor, toolName: "foundry_resume", toolCallId: "resume", arguments: { source } }), "string");
	await f.settle();
	const resumed = await f.status();
	assert.equal(resumed.active, true);
	assert.equal(resumed.blocker, undefined);
	assert.deepEqual(resumed.goal, paused.goal);
	assert.deepEqual(resumed.reviews.map(r => r.id), paused.reviews.map(r => r.id));
	assert.equal(resumed.reviews.length, 4);
	assert.equal(f.workers.size, 0);
	assert.deepEqual(calls, ["bash", "workflow.run"]);
	assert.equal(batches.length, 1);
	assert.ok(declaration.workflows?.some(w => w.meta.name === batches[0].name));
	assert.equal(batches[0].args.run, run); assert.ok(batches[0].args.dispatch);
	assert.deepEqual(Object.keys(batches[0].args).sort(), ["dispatch", "run"]);
});

test("permission loss after the baseline pauses once; explicit resumption dispatches the same four scouts", async t => {
	const f = trial(t);
	let failClosed = false;
	/** @type {string[]} */ const notices = [];
	const owner = f.runtime(f.root, { permissionBlocker: permissionCheck(async () => ({ failClosed }), async () => ({ mode: "assisted" })).blocker,
		log: m => notices.push(m), execute: async (...args) => {
		const result = await f.execute(...args);
		if (args[0] === "bash") failClosed = true;
		return result;
	} });
	const stopped = await f.start(owner);
	assert.equal(stopped.active, false);
	assert.match(String(stopped.blocker), /not resolved/);
	assert.equal(stopped.goal?.receipt?.exit, 1);
	assert.equal(f.scouts.length, 0); assert.equal(f.workers.size, 0);
	failClosed = false;
	owner.turn(actor); await owner.flush();
	assert.equal(f.scouts.length, 0); assert.equal(f.workers.size, 0);
	assert.equal(notices.length, 1);
	const resumed = await f.start(owner);
	assert.equal(resumed.blocker, undefined);
	assert.equal(resumed.active, true);
	assert.deepEqual(resumed.goal, stopped.goal);
	assert.deepEqual(resumed.reviews.map(r => r.id), stopped.reviews.map(r => r.id));
	assert.equal(f.scouts.length, 4);
	assert.deepEqual(f.scouts.map(s => s.id), resumed.reviews.map(r => r.id));
	assert.equal(new Set(f.scouts.map(s => s.workflowId)).size, 1);
	assert.equal(f.workers.size, 0);
});

test("switching to Manual between workflow dispatch and batch binding admits no scout jobs", async t => {
	const f = trial(t);
	let mode = "assisted";
	const {blocker:permissionBlocker} = permissionCheck(async () => ({ failClosed: false }), async () => ({ mode }));
	/** @type {ReturnType<typeof f.owner.scoutBatch>|undefined} */ let attempted;
	/** @type {typeof f.owner} */
	const owner = f.runtime(f.root, { permissionBlocker, scout: async (id, dispatch, issuer) => {
		mode = "manual";
		const workflowId = "admitted-before-mode-switch";
		attempted = owner.scoutBatch(id, dispatch, issuer, workflowId);
		await attempted;
		return { runId: workflowId, status: "completed" };
	} });
	await f.start(owner);
	assert.ok(attempted); assert.deepEqual(await attempted, []);
	const held = await f.status();
	assert.equal(held.active, true);
	assert.equal(held.blocker, undefined);
	assert.equal(held.pending.length, 4);
	assert.ok(held.pending.every(e => e.state === "ready" && /manual tool approvals/i.test(String(e.reason))));
	owner.close();
	const reopened = f.runtime(f.root, { permissionBlocker });
	reopened.turn(actor); await reopened.flush(); await f.settle();
	assert.equal(f.scouts.length, 0);
	mode = "assisted";
	reopened.turn(actor); await reopened.flush(); await f.settle();
	assert.deepEqual(f.scouts.map(s => s.id), held.reviews.map(r => r.id));
	assert.equal(f.workers.size, 0);
});

test("a writer's Manual setting holds its dependent writer reservation, not a sibling's check", async t => {
	const f = trial(t);
	await f.start();
	const [codec, projection, ...others] = f.scouts;
	await codec.report(report([grain("codec", "stock/codec/parse"), grain("emit", "stock/codec/emit", ["codec"])]));
	const [parser] = f.workers.values(); assert.ok(parser, "one result can dispatch a writer while other scouts are still reading");
	await projection.report(report([grain("projection")]));
	for (const scout of others) await scout.report(report([]));
	const writer = [...f.workers.values()].at(-1); assert.ok(writer && writer.prompt.includes("complete stock/projection/"));
	let mode = "assisted";
	const {blocker:permissions} = permissionCheck(async () => ({ failClosed: false }), async () => ({ mode }));
	const issuing = f.runtime(parser.cwd, { permissionBlocker: permissions, execute: async (...args) => {
		const result = await f.execute(...args);
		if (args[0] === "bash") mode = "manual"; // The check ran; its dependent's native start has not.
		return result;
	} });
	put(parser.cwd, "stock/codec/parse/index.mjs", "export default 1;");
	await issuing.operation("submit", { run, token: parser.token }, parser.id);
	const held = await f.status();
	assert.equal(held.active, true);
	assert.equal(held.blocker, undefined);
	const reservation = held.pending.find(e => e.kind === "writer" && e.issuer === parser.id);
	assert.ok(reservation);
	assert.match(String(reservation.reason), /manual tool approvals/i);
	assert.equal(reservation.state, "ready");
	await f.owner.operation("resume", { source }, actor);
	assert.deepEqual((await f.status()).pending.find(e => e.id === reservation.id), reservation);
	put(writer.cwd, "stock/projection/index.mjs", "export default 2;");
	await f.runtime(writer.cwd).operation("submit", { run, token: writer.token }, writer.id);
	const receipt = (await f.status()).nodes.find(n => n.grain === "projection")?.receipt;
	assert.ok(receipt && receipt.exit === 0);
	issuing.close();
	const reopened = f.runtime(parser.cwd, { permissionBlocker: permissions });
	f.owner.turn(actor); reopened.turn(parser.id); await Promise.all([f.owner.flush(), reopened.flush()]);
	assert.deepEqual((await f.status()).pending.find(e => e.id === reservation.id), reservation);
	assert.equal(f.workers.size, 2);
	mode = "assisted";
	reopened.turn(parser.id); await reopened.flush();
	assert.equal(f.workers.size, 3);
	assert.equal((await f.status()).nodes.find(n => n.grain === "emit")?.worker, [...f.workers.keys()].at(-1));
	reopened.turn(parser.id); await reopened.flush();
	assert.equal(f.workers.size, 3);
});

for (const closed of [false, true]) test(`owner resume claims a published writer's never-issued dependent once / ${closed ? "closed" : "racing"} issuer`, async t => {
	const f = trial(t);
	await f.start(); const [first, ...others] = f.scouts;
	await first.report(report([grain("codec", "stock/codec/parse"), grain("emit", "stock/codec/emit", ["codec"])]));
	for (const scout of others) await scout.report(report([]));
	const [parser] = f.workers.values();
	put(parser.cwd, "stock/codec/parse/index.mjs", "export default 1;");
	let checked = false, starts = 0;
	let reading = () => {}, release = () => {};
	const preflight = new Promise(resolve => { reading = () => resolve(undefined); });
	const gate = new Promise(resolve => { release = () => resolve(undefined); });
	const worker = f.runtime(parser.cwd, { permissionBlocker: async () => {
		if (checked) { reading(); await gate; }
		return null;
	}, execute: async (...args) => {
		if (args[0] === "create_session") starts++;
		const result = await f.execute(...args);
		checked ||= args[0] === "bash"; return result;
	} });
	const submitting = worker.operation("submit", { run, token: parser.token }, parser.id);
	await preflight;
	const before = await f.status();
	const e = before.pending.find(p => p.grain === "emit"); assert.equal(e?.issuer, parser.id);
	assert.equal(e.state, "ready"); assert.equal(before.nodes.find(n => n.grain === "codec")?.state, "published");
	if (closed) worker.close();
	const denied = f.runtime(f.root, { permissionBlocker: async () => ({ scope: "session", message: "Manual approvals." }) });
	await denied.operation("resume", { source }, actor).catch(error => assert.match(String(error), /Manual approvals/));
	assert.deepEqual((await f.status()).pending.find(p => p.id === e.id), e);
	f.owner.turn(actor); await f.owner.flush(); assert.equal(f.workers.size, 1);
	try {
		const resumed = await f.owner.operation("resume", { source }, actor);
		assert.ok(resumed.nodes.find(n => n.grain === "emit")?.worker);
		assert.deepEqual(resumed.nodes.find(n => n.grain === "codec"), before.nodes.find(n => n.grain === "codec"));
		assert.deepEqual(resumed.assignments, before.assignments);
	} finally {
		release();
		if (closed) await assert.rejects(submitting, { code: "runtime_closed" }); else await submitting;
	}
	await f.owner.operation("resume", { source }, actor);
	assert.equal(starts, 0); assert.equal(f.workers.size, 2);
});

test("owner resume leaves prepared, refused, uncertain and in-flight dependent launches with their issuer", async t => {
	const f = trial(t), deps = ["prepared", "denied", "uncertain", "inflight"];
	await f.start(); const [first, ...others] = f.scouts;
	await first.report(report([grain("codec", "stock/codec/parse"), ...deps.map(id => grain(id, `stock/codec/${id}`, ["codec"]))]));
	for (const scout of others) await scout.report(report([]));
	const [parser] = f.workers.values(); put(parser.cwd, "stock/codec/parse/index.mjs", "export default 1;");
	let count = 0, started = () => {}, release = () => {};
	const allIssued = new Promise(resolve => { started = () => resolve(undefined); });
	const hold = new Promise(resolve => { release = () => resolve(undefined); });
	const worker = f.runtime(parser.cwd, { execute: async (...args) => {
		if (args[0] !== "create_session") return f.execute(...args);
		if (++count === deps.length) started();
		const kind = String(args[1].name).split(" ")[0];
		if (kind === "prepared") return { resultType: "failure", error: "This session management tool is disabled" };
		if (kind === "denied") return { resultType: "denied" };
		if (kind === "inflight") await hold;
		return { resultType: "unconfirmed" };
	} });
	const submit = worker.operation("submit", { run, token: parser.token }, parser.id);
	try {
		await allIssued; await new Promise(resolve => setImmediate(resolve));
		const before = await f.status();
		assert.equal(before.pending.find(e => e.grain === "prepared")?.state, "ordinary");
		assert.equal(before.pending.find(e => e.grain === "uncertain")?.state, "uncertain");
		assert.equal(before.pending.find(e => e.grain === "inflight")?.state, "issued");
		assert.match(String(before.nodes.find(n => n.grain === "denied")?.reason), /refused/);
		const resumed = await f.owner.operation("resume", { source }, actor);
		assert.deepEqual(resumed.pending, before.pending);
		assert.deepEqual(resumed.nodes, before.nodes);
		assert.equal(resumed.prepared.length, 0);
		assert.equal((await f.status(parser.id)).prepared.length, 1);
		assert.equal(f.workers.size, 1);
	} finally { release(); await submit; }
});

test("prepared calls survive local holds and global pauses; stale preflight cannot undo issuance", async t => {
	const f = trial(t);
	let mode = "assisted", failClosed = false;
	const owner = f.runtime(f.root, { permissionBlocker: permissionCheck(async () => ({ failClosed }), async () => ({ mode })).blocker,
		execute: async (...args) => args[0] === "bash" ? f.execute(...args) : { resultType: "failure", error: "This session management tool is disabled" } });
	await f.start(owner);
	for (const scout of f.scouts) await scout.report(report([grain(scout.squad)]));
	const { prepared } = await f.status();
	assert.equal(prepared.length, 4);
	assert.ok(prepared.every(p => p.tool === "create_session"));
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

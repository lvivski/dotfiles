import assert from "node:assert/strict";
import test from "node:test";
import { realpathSync } from "node:fs";
import { factory, git, loadEntry, put } from "./fixture.mjs";
import { openDatabase } from "../work/database.mjs";

const run = "labels", source = ".foundry/labels.json";
/** @param {string} type @param {object} data */
const event = (type, data) => ({ id: crypto.randomUUID(), parentId: type === "session.start" ? null : crypto.randomUUID(), type, data });
/** @param {import("node:test").TestContext} t */
async function trial(t) {
	const g = { id: "parser", directory: "parser", specification: "brief", boundary: ["api"], check: "check.mjs" };
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, target: "refs/heads/main",
		direction: "Read labels.", seed: [g.id], grains: [g], limits: { assignments: 1 }, productCheck: "product.mjs" }),
		brief: "Read input.", api: "Return a string.", "check.mjs": 'import {read} from "./parser/index.mjs"; if (read() !== "green") process.exit(1)',
		"product.mjs": "" });
	let call = "", args = {};
	const launcher = f.runtime(f.root, { execute: async (tool, a, id) => {
		await f.execute(tool, a, id); call = id; args = a;
		throw Error("Lost native reply");
	} });
	await f.start(launcher); launcher.close();
	const [w] = f.workers.values(), cwd = realpathSync(w.cwd), generation = git(cwd, "rev-parse", "HEAD");
	const request = event("external_tool.requested", { sessionId: "owner", toolName: "create_session", toolCallId: call, arguments: args, requestId: "launch" });
	const ownerHistory = [request, event("external_tool.completed", { requestId: "launch" })];
	const identity = { id: w.id, session_type: "worktree", path: cwd, creator_session_id: "owner" };
	const childHistory = [event("session.start", { sessionId: w.id, context: { cwd, headCommit: generation } }),
		event("user.message", { content: w.prompt, source: "agent-owner", parentAgentTaskId: "telemetry-context" }),
		event("external_tool.requested", { sessionId: w.id, toolName: "get_session", toolCallId: "lookup", requestId: "lookup",
			arguments: { project_session_id: w.id } }),
		event("tool.execution_complete", { toolCallId: "lookup", success: true, result: { content: JSON.stringify(identity) } })];
	/** @param {string} actor @param {string} dir @param {typeof childHistory} history */
	async function entry(actor, dir, history) {
		const conf = await loadEntry({ sessionId: actor, on() {}, rpc: { mode: { get: async () => "interactive" },
			managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: "assisted" }) },
			eventLog: { read: async (/** @type {{types:string[],cursor?:string}} */ page) => {
				const rows = history.filter(e => page.types.includes(e.type)), at = Number(page.cursor ?? 0);
				return { cursor: String(at+1), cursorStatus: "ok", hasMore: at+1 < rows.length, events: rows.slice(at, at+1) };
			} }, tasks: { list: async () => ({ tasks: [] }) }, tools: { execute: (/** @type {{name:string,arguments:import("../work/model.js").Effect["args"],toolCallId:string}} */ a) => f.execute(a.name, a.arguments, a.toolCallId) } } });
		const ctx = { sessionId: actor }, hook = { ...ctx, timestamp: new Date(), workingDirectory: dir };
		await conf.hooks?.onSessionStart?.({ ...hook, source: "resume" }, ctx);
		t.after(() => conf.hooks?.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
		return (/** @type {string} */ name, /** @type {object} */ args, /** @type {object} */ extra = {}) => {
			const tool = conf.tools?.find(t => t.name === name); assert.ok(tool?.handler, `missing ${name}`);
			return tool.handler(args, { ...ctx, arguments: args, toolCallId: name, toolName: name, ...extra });
		};
	}
	const owner = await entry("owner", f.root, ownerHistory), child = await entry(w.id, cwd, childHistory);
	const store = openDatabase(f.root); t.after(() => store.close());
	return { f, store, owner, child, call, ownerHistory, childHistory, w, cwd, generation, identity, args };
}
const selector = { run, grain: "parser" };

test("lost create reply: prove both sides, bind the existing child, then run the ordinary component check", async t => {
	const { f, owner, child, w, generation } = await trial(t);
	assert.match(JSON.stringify(await owner("foundry_claim", selector)), /existing writer must claim/i);
	assert.equal(typeof await child("foundry_claim", selector), "string");
	assert.match(JSON.stringify(await child("foundry_submit", { run, token: w.token })), /No current worker/);
	assert.equal((await f.status()).nodes[0].worker, undefined);
	assert.equal(typeof await owner("foundry_claim", selector), "string");
	assert.match(JSON.stringify(await owner("foundry_claim", selector)), /no.*uncertain/i);
	const before = await f.status();
	assert.deepEqual([before.nodes[0].worker, before.nodes[0].generation, before.nodes[0].receipt, before.assignments?.used, f.checks.length],
		[w.id, generation, undefined, 1, 0]);
	put(w.cwd, "parser/index.mjs", 'export const read = () => "green";');
	assert.equal(typeof await child("foundry_submit", { run, token: w.token }), "string");
	const after = await f.status();
	assert.ok(after.nodes[0].receipt); assert.equal(after.nodes[0].receipt.exit, 0); assert.equal(after.assignments?.used, 1); assert.equal(f.workers.size, 1);
});

test("a token, later pasted prompt, caller-supplied ID, foreign creator, or dismissal cannot bind", async t => {
	const { child, owner, childHistory, ownerHistory, f, w, identity, call, cwd, generation } = await trial(t);
	const first = childHistory[1], lookup = childHistory.pop(); assert.ok(lookup);
	const attempt = () => child("foundry_claim", selector);
	assert.match(JSON.stringify(await child("foundry_claim", { ...selector, child: w.id })), /Unsupported field/);
	assert.match(JSON.stringify(await child("foundry_claim", selector, { agentId: "helper" })), /not its subagents/);
	assert.match(JSON.stringify(await attempt()), /get_session lookup/);
	childHistory.push(lookup);
	childHistory.splice(1, 0, event("user.message", { source: "user", content: w.prompt }));
	assert.match(JSON.stringify(await attempt()), /first native/); childHistory.splice(1, 1);
	childHistory[1] = event("user.message", { source: "agent-owner", content: w.prompt + "\ncopy" });
	assert.match(JSON.stringify(await attempt()), /first native/); childHistory[1] = first;
	childHistory[3] = event("tool.execution_complete", { toolCallId: "lookup", success: true, result: { content: JSON.stringify({ ...identity, creator_session_id: "stranger" }) } });
	assert.match(JSON.stringify(await attempt()), /creator/); childHistory[3] = lookup;
	assert.equal(typeof await attempt(), "string");
	const launch = ownerHistory.shift(); assert.ok(launch);
	assert.match(JSON.stringify(await owner("foundry_claim", selector)), /external_tool.requested/);
	ownerHistory.unshift(launch, launch); assert.match(JSON.stringify(await owner("foundry_claim", selector)), /Conflicting original/);
	ownerHistory.shift(); ownerHistory.push(event("permission.completed", { toolCallId: call, result: { kind: "denied-by-user" } }));
	assert.match(JSON.stringify(await owner("foundry_claim", selector)), /refusal/);
	ownerHistory.pop(); git(cwd, "checkout", "-q", "--detach", f.tip);
	assert.match(JSON.stringify(await owner("foundry_claim", selector)), /parentless generation/);
	git(cwd, "checkout", "-q", "--detach", generation);
	assert.equal((await f.status()).nodes[0].worker, undefined); assert.deepEqual(f.checks, []);
});

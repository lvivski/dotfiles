import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { factory, git, loadEntry, put } from "./fixture.mjs";

const source = ".foundry/codec.json", run = "codec", dir = "lib/codec";
/** @param {import("node:test").TestContext} t */
function trial(t) {
	const charter = "codec.md", boundary = ["api.md"], check = ".foundry/component.mjs", productCheck = ".foundry/product.mjs";
	return factory(t, run, source, {
		[source]: JSON.stringify({ version: 1, id: run, direction: "Round-trip a label through a URL component.", target: "refs/heads/main",
			productCheck, seed: ["codec"], limits: { workers: 1 }, squads: [{ id: "labels", charter, grains: ["codec"] }],
			grains: [{ id: "codec", directory: dir, specification: charter, boundary, check }] }),
		[charter]: "Encode and decode labels without losing their text.", "api.md": "Export encode and decode from index.mjs.",
		[check]: `import {encode,decode} from "../${dir}/index.mjs"; if (encode("a/b") !== "a%2Fb" || decode("a%2Fb") !== "a/b") throw Error("bad codec");`,
		[productCheck]: `import {encode,decode} from "../${dir}/index.mjs"; if (decode(encode("red / green?")) !== "red / green?") throw Error("bad round trip");`
	});
}

/** @param {import("node:test").TestContext} t @param {string} sessionId @param {string} workingDirectory
 * @param {{execute:ReturnType<typeof factory>["execute"],tasks?:()=>Promise<unknown>}} options */
async function entry(t, sessionId, workingDirectory, { execute, tasks }) {
	const config = await loadEntry({ sessionId, on() {}, ui: { confirm: async () => true }, rpc: {
		mode: { get: async () => "autopilot" }, managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: "assisted" }) },
		tasks: { list: tasks }, tools: { execute: (/** @type {{name:string,arguments:import("../work/model.js").Effect["args"],toolCallId:string}} */ a) =>
			execute(a.name, a.arguments, a.toolCallId) }
	} });
	const ctx = { sessionId }, hook = { ...ctx, timestamp: new Date(), workingDirectory }, hooks = config.hooks;
	assert.ok(hooks);
	await hooks.onSessionStart?.({ ...hook, source: "startup" }, ctx);
	t.after(() => hooks.onSessionEnd?.({ ...hook, reason: "complete" }, ctx));
	/** @param {string} name @param {object} args @param {Partial<import("@github/copilot-sdk").ToolInvocation>} [actor] */
	function call(name, args, actor = {}) {
		const handler = config.tools?.find(tool => tool.name === name)?.handler; assert.ok(handler);
		return handler(args, { ...ctx, toolName: name, toolCallId: name, arguments: args, ...actor });
	}
	return { hooks, hook, ctx, call };
}

test("two helpers in one capped assignment finish before its writer publishes one integrated directory", async t => {
	const f = trial(t);
	await f.start();
	const [w] = f.workers.values(), args = { run, token: w.token };
	mkdirSync(path.join(w.cwd, dir), { recursive: true });
	const jobs = ["encode", "decode"].map(name => {
		const worker = new Worker(`
			const { parentPort, workerData: { file, name } } = require("node:worker_threads");
			const { writeFileSync, appendFileSync } = require("node:fs");
			writeFileSync(file, "export const " + name + " = ");
			parentPort.once("message", () => appendFileSync(file, name + "URIComponent;\\n"));
			parentPort.postMessage("partial");`, { eval: true, workerData: { name, file: path.join(w.cwd, dir, `${name}.mjs`) } });
		return { name, worker, ready: once(worker, "message"), done: once(worker, "exit") };
	});
	// No local starts to count: a reloaded writer has to consult the host.
	const writer = await entry(t, w.id, w.cwd, { execute: f.execute, tasks: async () => ({ tasks: [
		...jobs.map(({ name, worker }) => ({ type: "agent", id: name, status: worker.threadId === -1 ? "completed" : "running" })),
		{ type: "shell", id: "unrelated", status: "running" }, { type: "agent", id: "finished-turn", status: "idle" }
	] }) });
	try {
		assert.deepEqual(await Promise.all(jobs.map(j => j.ready)), [["partial"], ["partial"]]);
		for (const { name } of jobs)
			assert.match(JSON.stringify(await writer.call("foundry_submit", args, { agentId: name })), /subagents|primary/i);
		assert.match(JSON.stringify(await writer.call("foundry_status", { run }, { sessionId: "helper-session" })), /subagents|primary/i);
		assert.match(JSON.stringify(await writer.call("foundry_submit", args)), /helpers.*running|agents.*running/i);
		assert.equal((await f.status()).nodes[0].state, "writing");
		assert.deepEqual(f.checks, []);
	} finally {
		for (const j of jobs) j.worker.postMessage("finish");
		assert.deepEqual(await Promise.all(jobs.map(j => j.done)), [[0], [0]]);
	}
	assert.match(w.prompt, /\btask\b/i);
	put(w.cwd, `${dir}/index.mjs`, 'export * from "./encode.mjs"; export * from "./decode.mjs";\n');
	assert.equal(typeof await writer.call("foundry_submit", args), "string");
	const done = await f.status();
	assert.ok(done.qualified);
	assert.equal(done.limit, 1);
	assert.equal(done.products?.[0].receipt?.commit, done.qualified);
	const { receipt } = done.nodes[0]; assert.ok(receipt);
	assert.equal(receipt.commit, done.outputs?.codec);
	assert.equal(git(f.root, "ls-tree", "--name-only", `${done.qualified}:${dir}`), "decode.mjs\nencode.mjs\nindex.mjs");
	assert.equal(f.checks.length, 2); // One component check and one combined check.
	assert.equal(f.workers.size, 1);
});

test("a failed task lookup or a pause during it cannot consume a repair token", async t => {
	const f = trial(t);
	await f.start();
	const [w] = f.workers.values();
	// An actual failed check returns an inline repair in the same writer.
	const first = await f.runtime(w.cwd).operation("submit", { run, token: w.token }, w.id);
	const token = first.nodes[0].token;
	assert.ok(token && token !== w.token && first.nodes[0].repairs === 1);
	let pause = false;
	const writer = await entry(t, w.id, w.cwd, { execute: f.execute, tasks: async () => {
		if (!pause) throw Error("task registry unavailable");
		await f.owner.operation("pause", { run }, "owner");
		return { tasks: [] };
	} });
	assert.match(JSON.stringify(await writer.call("foundry_submit", { run, token: w.token })), /assignment/i);
	assert.match(JSON.stringify(await writer.call("foundry_submit", { run, token })), /task registry unavailable/);
	pause = true;
	assert.match(JSON.stringify(await writer.call("foundry_submit", { run, token })), /paused/i);
	const node = (await f.status(w.id)).nodes[0];
	assert.equal(node.token, token);
	assert.equal(node.state, "writing");
	assert.equal(node.repairs, 1);
	assert.equal(f.workers.size, 1);
	assert.equal(f.checks.length, 1);
});

test("helper lifecycle and tool hooks cannot take or settle the primary agent's prepared call", async t => {
	const f = trial(t);
	const owner = await entry(t, "owner", f.root, { execute: async () => ({ resultType: "failure", error: "This session management tool is disabled" }) });
	const { hooks, hook, ctx } = owner;
	const helper = { ...hook, parentAgentId: "root", workingDirectory: "/not-the-assignment" };
	await hooks.onSessionStart?.({ ...helper, source: "startup", initialPrompt: `Foundry assignment: ${run} 00000000-0000-0000-0000-000000000001\n` }, ctx);
	assert.equal(typeof await owner.call("foundry_start", { source }), "string");
	const [p] = (await f.status()).prepared;
	const pre = { ...hook, toolName: p.tool, toolArgs: p.arguments, toolCallId: "reserved" };
	for (const actor of [{ agentId: "nested" }, { parentAgentId: "root" }, { sessionId: "helper-session" }]) {
		assert.equal((await hooks.onPreToolUse?.({ ...pre, ...actor }, ctx))?.permissionDecision, "deny");
		assert.equal((await hooks.onPreToolUse?.({ ...pre, ...actor, toolName: "foundry_status", toolArgs: { run } }, ctx))?.permissionDecision, "deny");
		assert.equal(await hooks.onPreToolUse?.({ ...pre, ...actor, toolName: "bash", toolArgs: { command: "true" } }, ctx), undefined);
	}
	assert.equal((await f.status()).prepared.length, 1);
	assert.equal(await hooks.onPreToolUse?.(pre, ctx), undefined);
	await f.execute(p.tool, p.arguments, "reserved");
	await hooks.onPostToolUse?.({ ...pre, agentId: "nested", toolResult: { resultType: "denied", textResultForLlm: "not the primary call" } }, ctx);
	await hooks.onSessionEnd?.({ ...hook, sessionId: "helper-session", reason: "complete" }, ctx);
	assert.equal((await f.status()).pending[0].state, "issued");
	const [w] = f.workers.values();
	await hooks.onPostToolUse?.({ ...pre, toolResult: { resultType: "success", textResultForLlm: JSON.stringify({ project_session_id: w.id }) } }, ctx);
	assert.equal((await f.status()).nodes[0].worker, w.id);
});

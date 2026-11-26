import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { record } from "./work/values.mjs";
import { factory, git, loadEntry, put } from "./test/fixture.mjs";

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
 * @param {{execute:ReturnType<typeof factory>["execute"],tasks?:()=>Promise<unknown>,workflow?:object,
 * agent?:import("@github/copilot-sdk/extension").WorkflowContext["agent"]}} options */
async function entry(t, sessionId, workingDirectory, { execute, tasks, workflow, agent }) {
	/** @type {Awaited<ReturnType<typeof loadEntry>>} */ let config;
	/** @type {Map<string,Promise<unknown>>} */ const calls=new Map();
	config = await loadEntry({ sessionId, workflow:{...(agent && {
		async start(/** @type {string} */ name,/** @type {{args:Record<string,string>,notifyOnComplete:boolean}} */ options){
			assert.equal(name,"foundry-inspect");assert.equal(options.notifyOnComplete,false);
			const definition=config.workflows.find(w=>w.meta.name===name);
			assert.ok(definition && "run" in definition && typeof definition.run==="function");
			const runId=randomUUID(),reject=()=>assert.fail("Unexpected reviewer operation");
			/** @type {import("@github/copilot-sdk/extension").WorkflowContext} */ const context={args:options.args,runId,signal:new AbortController().signal,
				session:/** @type {import("@github/copilot-sdk").CopilotSession} */ ({sessionId,
					rpc:{agent:{list:async()=>({agents:[{id:"rubber-duck",name:"rubber-duck",source:"builtin"}]})}}}),
				agent,agents:{},step:async(_,fn)=>fn(),phase(){},log(){},parallel:reject,pipeline:reject,pause:reject,workflow:reject};
			calls.set(runId,Promise.resolve(definition.run(context)));
			return {runId,status:"running"};
		},
		async waitForRun(/** @type {string} */ runId){assert.ok(calls.has(runId));return {runId,status:"completed",result:await calls.get(runId)};},
	}),...workflow}, on() {}, rpc: {
		mode: { get: async () => "autopilot" }, managedSettings: { get: async () => ({ failClosed: false }) }, permissions: { getMode: async () => ({ mode: "assisted" }) },
		metadata:{getContextAttribution:async()=>({contextAttribution:{promptTokenLimit:64000,categories:{systemPrompt:0,customInstructions:0,systemTools:0,mcpTools:0}}})},
		tasks: { list: tasks }, tools: { execute: (/** @type {{name:string,arguments:import("./work/model.js").Effect["args"],toolCallId:string}} */ a) =>
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

test("writers keep their host branches before binding and after reconnect; session titles remain editable", async t => {
	const seed = ["encoder", "decoder"];
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, direction: "Round-trip a label.", target: "refs/heads/main",
		productCheck: "product.mjs", seed, squads: [{ id: "labels", charter: "job.md", grains: seed }],
		grains: seed.map(id => ({ id, directory: id, specification: "job.md", boundary: ["api"], check: "unit.mjs" })) }),
		"job.md": "Encode and decode labels.", api: "Label codec", "unit.mjs": "", "product.mjs": "" });
	/** @param {Awaited<ReturnType<typeof entry>>} s @param {boolean} writer */
	async function check(s, writer) {
		const call = { ...s.hook, toolName: "rename_branch", toolArgs: { name: "label-codec" }, toolCallId: "rename" };
		for (const actor of [{}, { agentId: "helper" }, { sessionId: "helper-session" }]) {
			const result = await s.hooks.onPreToolUse?.({ ...call, ...actor }, s.ctx);
			assert.equal(result?.permissionDecision, writer ? "deny" : undefined);
		}
		assert.equal(await s.hooks.onPreToolUse?.({ ...call, toolName: "rename_session", toolArgs: { title: "Label codec" } }, s.ctx), undefined);
	}
	// Exercise the first tool call before the host has returned its binding receipt.
	const status = await f.start(f.runtime(f.root, { execute: async (tool, args, id) => {
		const reply = await f.execute(tool, args, id);
		const w = [...f.workers.values()].find(w => w.prompt === record(args.kickoff).prompt);
		assert.ok(w);
		if (w === f.workers.values().next().value) {
			const s = await entry(t, w.id, w.cwd, f);
			await s.hooks.onSessionStart?.({ ...s.hook, source: "startup",
				initialPrompt: `<cross_session_message>\nFrom owner\n</cross_session_message>\n\n<branch_rename_request>\nRename before editing.\n</branch_rename_request>\n\n${w.prompt}` }, s.ctx);
			await check(s, true);
		}
		return reply;
	} }));
	assert.equal(f.workers.size, 2);
	assert.deepEqual(status.nodes.map(n => n.worker).sort(), [...f.workers.keys()].sort());
	for (const w of f.workers.values()) {
		const s = await entry(t, w.id, w.cwd, f); // Reconnect without an initial prompt.
		await check(s, true);
	}
	await check(await entry(t, "owner", f.root, f), false);
	await check(await entry(t, "ordinary-session", f.root, f), false);
	assert.deepEqual(f.checks, []);
});

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
	let independent=0;
	const writer = await entry(t, w.id, w.cwd, { execute: f.execute,agent:async(prompt,options)=>{
		assert.equal(options?.agent,"rubber-duck");assert.ok(prompt.includes("encodeURIComponent") && prompt.includes("decodeURIComponent"));
		assert.ok(prompt.includes("Encode and decode labels without losing their text."));
		assert.ok(!prompt.includes(w.token));independent++;return {outcome:"approved",summary:`${dir}/index.mjs:1 re-exports the matching encode and decode implementations.`};
	}, tasks: async () => ({ tasks: [
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
	await turn();
	const done = await f.status();
	assert.equal(independent,1);assert.equal(done.nodes[0].codeReview?.state,"approved");
	assert.ok(done.qualified);
	assert.equal(done.limit, 1);
	assert.equal(done.products?.[0].receipt?.commit, done.qualified);
	const { receipt } = done.nodes[0]; assert.ok(receipt);
	assert.equal(receipt.commit, done.outputs?.codec);
	assert.equal(git(f.root, "ls-tree", "--name-only", `${done.qualified}:${dir}`), "decode.mjs\nencode.mjs\nindex.mjs");
	assert.equal(f.checks.length, 2); // One component check and one combined check.
	assert.equal(f.workers.size, 1);
});

test("the native hook confines only the active factory reviewer, including ambiguous tool calls, and leaves its result channel open", async t => {
	const f=trial(t); await f.start(); const [w]=f.workers.values();
	put(w.cwd,`${dir}/index.mjs`,"export const encode=encodeURIComponent, decode=decodeURIComponent;\n");
	/** @type {Awaited<ReturnType<typeof entry>>} */ let writer;
	/** @type {Record<string,string|undefined>} */ const observed={};
	let label="",detailMode="ok",lookups=0,reviewed=0;
	const direct="native-duck",manual={agentId:"manual-duck",agentType:"rubber-duck"};
	/** @param {string} toolName @param {Partial<Parameters<NonNullable<typeof writer.hooks.onPreToolUse>>[0]>} actor */
	async function decision(toolName,actor) {
		const result=await writer.hooks.onPreToolUse?.({...writer.hook,...actor,toolName,toolArgs:{agentId:"not-the-reviewer"},toolCallId:"current-child-tool"},writer.ctx);
		return result?.permissionDecision;
	}
	writer=await entry(t,w.id,w.cwd,{execute:f.execute,tasks:async()=>({tasks:[]}),workflow:{
		async getRunDetail(/** @type {string} */ id) {
			lookups++;
			if (detailMode==="offline") throw Error("workflow registry is unavailable");
			const a={runId:id,agentType:"rubber-duck",agentId:direct,toolCallId:"original-native-launch",label,status:"running"};
			return {runId:detailMode==="foreign-run"?"unrelated":id,workflowName:detailMode==="foreign-workflow"?"other":"foundry-inspect",
				status:"running",agents:[{...a,status:"completed",agentId:"older-attempt"},
					...(detailMode==="missing"?[]:[detailMode==="wrong-launch"?{...a,toolCallId:""}:a]),
					...(detailMode==="ambiguous"?[{...a,agentId:"second-direct"}]:[])]};
		},
	}, agent:async(_prompt,options)=>{
		reviewed++;label=options?.label??"";
		for (const tool of ["view","apply_patch","bash","mcp.example.external","web_fetch","task","ask_user","foundry_reference","rename_branch","submit_review_result"])
			observed[tool]=await decision(tool,{agentId:direct});
		observed.descendant=await decision("view",{agentId:"nested",parentAgentId:direct,agentType:"explore"});
		observed.unattributed=await decision("view",{sessionId:"child-session"});
		observed.blank=await decision("view",{agentId:" "});
		observed.typeOnly=await decision("view",{agentType:"rubber-duck"});
		observed.ordinary=await decision("view",{agentId:"unrelated-helper",agentType:"explore"});
		observed.otherDuck=await decision("view",manual);
		for (detailMode of ["foreign-run","foreign-workflow","missing","wrong-launch","ambiguous","offline"]) {
			observed[detailMode]=await decision("view",{agentId:"unattributed",agentType:"rubber-duck"});
			observed[`primary-${detailMode}`]=await decision("view",{});
		}
		return {outcome:"approved",summary:`${dir}/index.mjs:1 — Encode and decode use matching URL component semantics.`};
	}});
	assert.equal(await decision("view",manual),undefined);assert.equal(lookups,0);
	await writer.call("foundry_submit",{run,token:w.token});await turn();
	assert.equal(reviewed,1);
	for (const tool of ["view","apply_patch","bash","mcp.example.external","web_fetch","task","ask_user","foundry_reference","rename_branch","submit_review_result",
		"descendant","unattributed","typeOnly","blank","foreign-run","foreign-workflow","missing","wrong-launch","ambiguous","offline"])
		assert.equal(observed[tool],"deny",tool);
	for (const key of ["ordinary","otherDuck",...Object.keys(observed).filter(k=>k.startsWith("primary-"))])
		assert.equal(observed[key],undefined,key);
	assert.ok(lookups>0);const prior=lookups;
	assert.equal(await decision("view",manual),undefined);assert.equal(lookups,prior);
	const status=await f.status();assert.equal(status.nodes[0].codeReview?.state,"approved");assert.ok(status.qualified);
});

test("a writer can submit with its helper idle while its session hosts independent discovery", async t => {
	const grain = (/** @type {string} */ id) => ({ id, directory: id, specification: `${id}.md`, boundary: ["api"], check: "unit.mjs" });
	const ids = ["encoder", "analysis"];
	const f = factory(t, run, source, { [source]: JSON.stringify({ version: 1, id: run, direction: "Encode a sample.", target: "refs/heads/main",
		productCheck: "product.mjs", grains: ids.map(grain), squads: ids.map(id => ({ id, charter: `${id}.md`, grains: [id] })) }),
		"encoder.md": "Write the encoded sample.", "analysis.md": "Analyze independent inputs.", api: "Work independently.",
		"unit.mjs": "import {accessSync} from 'node:fs'; accessSync('encoder/sample');", "product.mjs": "" });
	await f.start();
	const [encoder, analysis] = f.scouts;
	await encoder.report({ outcome: "regenerate", evidence: ["encoder.md"], reason: "Missing sample.", grains: ["encoder"] });
	await analysis.report({ outcome: "no-gap", evidence: ["analysis.md"], reason: "No new evidence.", grains: [] });
	const [w] = f.workers.values(), args = { run, token: w.token };
	put(f.root, "analysis/input", "New source"); git(f.root, "add", "analysis/input"); git(f.root, "commit", "-qm", "New analysis evidence");
	const issuer = f.runtime(w.cwd);
	issuer.turn(w.id); await issuer.flush(); await f.settle();
	const review = f.scouts.at(-1); assert.ok(review && review.squad === "analysis" && review.issuer === w.id);
	put(w.cwd, "encoder/sample", "saved");

	let helper = "running", analysisCall = "call:scout-task";
	const agent = (/** @type {string} */ id, /** @type {string} */ status) => ({ type: "agent", id, toolCallId: `call:${id}`, displayName: "analysis", status });
	const writer = await entry(t, w.id, w.cwd, { execute: f.execute, tasks: async () => ({ tasks: [agent("writer-helper", helper), agent("scout-task", "running")] }),
		workflow: { getRunDetail: async (/** @type {string} */ id) => {
			assert.equal(id, review.workflowId);
			return { runId: id, workflowName: "foundry-scout", agents: [{ runId: id, agentId: "scout-task", toolCallId: analysisCall, status: "running" }] };
		}, waitForRun: () => new Promise(() => {}) } });
	const refused = await writer.call("foundry_submit", args);
	assert.match(JSON.stringify(refused), /helpers.*running/i); assert.deepEqual(f.checks, []);
	helper = "idle";
	analysisCall = "different-launch";
	const unverified = await writer.call("foundry_submit", args);
	assert.equal((await f.status(w.id)).nodes[0].state, "writing");
	analysisCall = "call:scout-task";
	const result = await writer.call("foundry_submit", args);
	assert.equal(typeof result, "string", JSON.stringify(result));
	const status = await f.status(w.id);
	const { receipt, token } = status.nodes[0]; assert.ok(receipt);
	assert.equal(receipt.exit, 0); assert.equal(token, w.token);
	assert.equal((await f.status()).reviews.find(r => r.id === review.id)?.state, "reading");
	assert.match(JSON.stringify(unverified), /scout-task/);
	assert.match(JSON.stringify(refused), /writer-helper/); assert.doesNotMatch(JSON.stringify(refused), /scout-task/);
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

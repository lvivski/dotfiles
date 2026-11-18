import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHooks } from "../hooks.mjs";
import { prepareDispatch } from "./native.mjs";
import { pickupBatch, recoverCreations } from "./pickup.mjs";
import { createRuntime } from "./runtime.mjs";
import { json, record } from "./values.mjs";
import { renderBoard } from "./board.mjs";
import { issueWake, observeWake, recoverDeliveries, wakeRequest } from "./transport.mjs";
import { openWorkStore } from "./store.mjs";

/** @param {import("node:test").TestContext} t */
function fixture(t) {
	const root = mkdtempSync(path.join(os.tmpdir(), "foundry-pickup-"));
	execFileSync("git", ["init", "--quiet", root]);
	const runtime = createRuntime({ directory: root, log: () => {} });
	const db = runtime.store();
	t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
	const scope = { mode: /** @type {const} */ ("autopilot"), delegation: true, paths: ["."], workTypes: ["code"], restrictions: [] };
	db.createGoal({ id: "job", title: "job", scope, limits: { workers: 2 } }, "owner");
	const add = (/** @type {string} */ id, /** @type {Partial<Parameters<typeof db.createTask>[0]>} */ fields = {}, owner = "owner") =>
		db.createTask({ goalId: "job", id, title: id, assignment: id, workType: "code", ...fields }, owner);
	return { root, runtime, db, add, scope };
}

test("first owner pickup starts independent reservations before either receipt, never reissues on a raced pickup", async t => {
	const { db, add } = fixture(t);
	const prepared = ["a","b"].map(id => prepareDispatch(db, add(id).id, "owner"));
	add("c");
	assert.throws(() => prepareDispatch(db, "c", "owner"), { code: "capacity_wait" });
	/** @type {Array<()=>void>} */ const receipts = [];
	const running = pickupBatch(db, { prepared, blocked: [] }, "owner", async args => {
		const name = record(args).name;
		await new Promise(resolve => receipts.push(() => resolve(undefined)));
		return { resultType: "success", structuredContent: { id: `native:${name}` } };
	});
	assert.equal(receipts.length, 2);
	const duplicate = await pickupBatch(db, { prepared, blocked: [] }, "owner", async () => assert.fail("duplicate native writer"));
	assert.equal(duplicate.blocked.length, 2);
	assert.equal(db.snapshot().attempts.filter(attempt => attempt.slot).length, 2);
	receipts.forEach(resolve => resolve());
	assert.equal((await running).started.length, 2);
});

test("known disabled adapter returns only fresh ordinary calls; ambiguous issuance survives reopen and recovers from native history", async t => {
	const { db, root, add } = fixture(t);
	let disabled = false;
	const first = prepareDispatch(db, add("fallback").id, "owner");
	const result = await pickupBatch(db, { prepared: [first], blocked: [] }, "owner", async () =>
		({ resultType: "failure", error: "This session management tool is disabled" }), () => { disabled = true; });
	assert.equal(disabled, true);
	assert.equal(result.prepared.length, 1);
	assert.notEqual(result.prepared[0].token, first.token);
	assert.equal(record(db.getEffect(first.effectId).result).neverIssued, true);
	const call = prepareDispatch(db, add("lost-ack").id, "owner");
	const lost = await pickupBatch(db, { prepared: [call], blocked: [] }, "owner", async () => { throw new Error("transport lost"); });
	assert.equal(lost.prepared.length, 0);
	const resumed = createRuntime({ directory: root, log: () => {} });
	t.after(() => resumed.close());
	assert.equal(resumed.store().getEffect(call.effectId).state, "uncertain");
	const recovered = await recoverCreations(resumed.store(), "owner", "job", async (_actor, id) => ({
		start: { type: "tool.execution_start", data: { turnId: "turn", toolCallId: id, toolName: "create_session", arguments: call.arguments } },
		completion: { id: "native-event", type: "tool.execution_complete", data: { turnId: "turn", toolCallId: id, success: true,
			result: { content: JSON.stringify({ project_session_id: "known-worker" }) } } },
	}));
	assert.deepEqual(recovered, [{ effectId: call.effectId, state: "bound", nativeId: "known-worker" }]);
});

test("shared coordinator never switches branches, cannot run commands or forge children before binding or after restart", async t => {
	const { db, add, root } = fixture(t);
	const call = prepareDispatch(db, add("squad", { role: "coordinator" }).id, "owner");
	const args = record(call.arguments);
	assert.equal(args.workspace_type, "branch");
	assert.equal(args.base_branch, undefined);
	const key = "native:coordinator";
	for (const phase of ["kickoff", "resume"]) {
		const child = createRuntime({ directory: root, log: () => {} });
		t.after(() => child.close());
		child.attachUsage(key);
		if (phase === "kickoff") child.beginUsage(key, call.token);
		const hooks = buildHooks(child);
		for (const tool of ["bash", "apply_patch", "create_session", "foundry_run_check", "foundry_start_task"]) {
			const refusal = await hooks.onPreToolUse({ toolName: tool, toolArgs: {}, timestamp: new Date(), workingDirectory: root, sessionId: key }, { sessionId: key });
			assert.equal(refusal?.permissionDecision, "deny", `${phase}: ${tool}`);
		}
		if (phase === "kickoff") {
			db.issueAttempt(call.attemptId, "owner", call.effectId, json({ ...args, nativeToolCallId: "original" }));
			db.bindAttempt(call.attemptId, key, "owner", { id: key });
		}
	}
});

test("publication reaches each declared peer without a director, including a consumer still waiting on another output", async t => {
	const { db, add, runtime, scope } = fixture(t);
	for (const peer of ["native","quality"]) db.createGoal({ id: peer, scope, title: peer }, `${peer}-lead`);
	add("architecture");
	add("other");
	for (const peer of ["native","quality"]) add(`${peer}-consumer`, { goalId: peer, inputs: [
		{ taskId: "architecture", output: "contract" }, ...(peer === "native" ? [{ taskId: "other", output: "fixture" }] : []),
	] }, `${peer}-lead`);
	db.reassignTask("quality-consumer", "quality-worker", "quality-lead");
	const call = prepareDispatch(db, "architecture", "owner");
	await pickupBatch(db, { prepared: [call], blocked: [] }, "owner", async () => ({ resultType: "success", structuredContent: { id: "publisher" } }));
	await runtime.operation("report_result", { taskId: "architecture", summary: "Done", state: "done",
		outputs: [{ name: "contract", kind: "analysis", reference: "contract:v1", version: "v1" }] }, "publisher");
	const wakes = db.outgoingWakes("publisher").filter(w => ["native","quality"].includes(w.goalId));
	assert.equal(wakes.length, 2);
	for (const wake of wakes) {
		assert.ok(db.canRelayOutput(wake.id, "publisher", "job"));
		assert.equal(db.canRelayOutput(wake.id, "unrelated", "job"), false);
		assert.equal(db.canRelayOutput(wake.id, "publisher", "unrelated"), false);
		assert.deepEqual(wake.relatedReasons, ["output:architecture"]);
		const claim = db.claimWakeDelivery(wake.id, wake.generation, undefined, { session_id: wake.owner }, "publisher");
		assert.ok(claim);
		if (wake.owner === "quality-worker") {
			db.settleWakeDelivery(wake.id, claim.id, wake.generation, {resultType:"failure",error:"session archived"},false,"publisher",true);
			const [fallback] = db.outgoingWakes("publisher").filter(item => item.owner === "quality-lead");
			assert.deepEqual(fallback.relatedReasons, [`unavailable:${wake.id}`]);
			assert.equal(db.canRelayOutput(fallback.id, "publisher", "job"), true);
			assert.equal(db.canRelayOutput(fallback.id, "unrelated", "job"), false);
		}
	}
	const html = renderBoard(db.snapshot());
	assert.match(html, /other\/fixture/);
	assert.match(html, /eligible for owner pickup/);
	assert.match(html, /not landing receipts/);
});

test("ordinary app delivery claims its real call before sending, rejects a replay after restart and recovers only matching native events", async t => {
	const { db, add, root, runtime } = fixture(t);
	const task = add("ready");
	db.reassignTask(task.id, "peer", "owner");
	const [wake] = db.outgoingWakes("owner"), args = wakeRequest(wake);
	issueWake(db, args, "owner", "original-call");
	const resumed = openWorkStore(root);
	t.after(() => resumed.close());
	await assert.rejects(runtime.operation("mark_wake_sent",{wakeId:wake.id,generation:wake.generation},"owner"), {code:"wake_receipt_required"});
	observeWake(resumed, args, {resultType:"success"}, "owner", "unrelated-call");
	assert.throws(() => issueWake(resumed, args, "owner", "other-call"), { code: "wake_delivery_pending" });
	const read = (/** @type {typeof args} */ original, content = "Message accepted for priority delivery to session 'Peer'.") => async () => ({
		start: { type: "tool.execution_start", id: "s", data: { toolCallId: "original-call", toolName: "send_session_message", arguments: original, turnId: "one" } },
		completion: { type: "tool.execution_complete", id: "e", data: { toolCallId: "original-call", turnId: "one", success: true, result: { content } } },
	});

	assert.equal((await recoverDeliveries(resumed,"owner","job",read({ ...args, session_id: "different" })))[0].state, "reconciliation-required");
	assert.equal((await recoverDeliveries(resumed,"owner","job",read(args, "No queue receipt.")))[0].state, "reconciliation-required");
	assert.equal(resumed.pendingDeliveries("owner").length, 1);
	assert.equal((await recoverDeliveries(resumed,"owner","job",read(args)))[0].state, "queue-confirmed");
	assert.equal(resumed.pendingWakes("peer")[0].consumed, 0);
	assert.equal(resumed.pendingWakes("peer")[0].sent, wake.generation);
	assert.equal(resumed.pendingDeliveries("owner").length, 0);
	assert.equal(record(await runtime.operation("mark_wake_sent",{wakeId:wake.id,generation:wake.generation},"owner")).sent, wake.generation);
});

test("known transient queue refusal backs off and stops until work changes; advance does not spin a recipient", t => {
	const { db, add, root } = fixture(t);
	add("ready"); db.reassignTask("ready", "peer", "owner");
	let now = Date.now();
	const timed = openWorkStore(root, { clock: () => new Date(now) });
	t.after(() => timed.close());
	const [wake] = db.pendingWakes("peer");
	for (let n = 1; n <= 3; n++) {
		const claimed = timed.claimWakeDelivery(wake.id, wake.generation, undefined, {}, "owner");
		assert.ok(claimed);
		const failed = timed.settleWakeDelivery(wake.id, claimed.id, wake.generation, {resultType:"failure",error:"transient"},false,"owner");
		assert.equal(failed.retry?.failures, n);
		if (n > 1) assert.equal(timed.wakeCanSend(wake.id), false);
		now += 5000;
	}
	assert.equal(timed.wakeCanSend(wake.id), false);
	add("new-evidence"); timed.reassignTask("new-evidence", "peer", "owner");
	assert.equal(timed.wakeCanSend(wake.id), true);
});

test("a publisher reconciles an issued peer wake from its originating goal without membership in the recipient goal", async t => {
	const { root, db, add, scope } = fixture(t);
	db.createGoal({ id: "consumer", scope, title: "consumer" }, "peer");
	add("producer");
	add("use-result", { goalId: "consumer", inputs: [{ taskId: "producer", output: "contract" }] }, "peer");
	const call = prepareDispatch(db, "producer", "owner");
	await pickupBatch(db, { prepared: [call], blocked: [] }, "owner", async () => ({ resultType: "success", structuredContent: { id: "publisher" } }));
	const issued = new Map();
	const sender = createRuntime({ directory: root, log() {}, execute: async (name, args, callId) => {
		assert.equal(name, "send_session_message");
		issued.set(callId, args);
		throw new Error("transport uncertain");
	} });
	await sender.operation("report_result", { taskId: "producer", summary: "Done", state: "done",
		outputs: [{ name: "contract", kind: "analysis", reference: "v1", version: "v1" }] }, "publisher");
	await sender.flushNotifications();
	sender.close();
	const pending = db.pendingDeliveries("publisher", "job").find(d => d.goalId === "consumer");
	assert.ok(pending);
	assert.deepEqual(db.pendingDeliveries("peer", "job"), []);
	const resumed = createRuntime({ directory: root, log() {}, readCommand: async (actor, id) => {
		assert.equal(actor, "publisher");
		assert.ok(issued.has(id));
		return { start: { type: "tool.execution_start", id: "start", data: { toolName: "send_session_message", toolCallId: id, turnId: "turn", arguments: issued.get(id) } },
			completion: { type: "tool.execution_complete", id: "end", data: { toolCallId: id, turnId: "turn", success: true, result: { content: "Message accepted for priority delivery to session 'Peer'." } } } };
	} });
	t.after(() => resumed.close());
	await assert.rejects(resumed.operation("advance", { goalId: "consumer" }, "publisher"), { code: "foreign_goal" });
	await resumed.operation("advance", { goalId: "job" }, "publisher");
	assert.equal(db.getDelivery(pending.id).state, "settled");
	assert.equal(db.pendingWakes("peer").find(w => w.id === pending.wakeId)?.consumed, 0);
});

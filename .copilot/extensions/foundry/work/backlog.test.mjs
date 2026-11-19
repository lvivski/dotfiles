import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attemptToken } from "./prompt.mjs";
import { createRuntime } from "./runtime.mjs";
import { record, text } from "./values.mjs";

/** @param {import("node:test").TestContext} t @param {{lineage?:boolean,mixed?:boolean,qualify?:boolean,completionTaskId?:string,workers?:number,maximumJobs?:number,names?:string[]}} [options] */
async function setup(t, {lineage, mixed, qualify, completionTaskId = qualify ? "mail" : undefined, workers = 4, maximumJobs = 2, names = ["mail", "quality", "design"]} = {}) {
	const root = mkdtempSync(path.join(os.tmpdir(), "foundry-discovery-"));
	execFileSync("git", ["init", "-q", root]);
	mkdirSync(path.join(root, ".foundry"));
	const scope = { mode: "autopilot", delegation: true, paths: ["."], workTypes: ["product"], restrictions: [] };
	const source = ".foundry/factory.json";
	const knowledge = { path: ".foundry/scenario.txt", sha256: createHash("sha256").update("Account A must not see account B's drafts.").digest("hex") };
	writeFileSync(path.join(root, knowledge.path), "Account A must not see account B's drafts.");
	const outcomes = [{ id: "routing", title: "Correct account routing", success: "Two isolated accounts", priority: 1 },
		{ id: "labels", title: "Correct labels", success: "Labels match", priority: 2 }];
	const policy = { format: "foundry-factory", version: 2, id: "product", mechanism: "native", maximumJobs,
		...(qualify ? { delivery: { level: "qualified", acceptance: "artifact-command", targetRef: "refs/heads/product" } } : {}), completionTaskId,
		direction: { revision: 1, outcomes, constraints: ["No real-account writes"], nonGoals: ["Network sync"] },
		goal: { title: "Native Mail", scope, limits: { workers }, tasks: names.map(id => ({
			id, title: `Validate ${id} behavior`, assignment: `Prove ${id} behavior using isolated scenarios`, workType: "product",
			checks: [{ id: "scenario", kind: "command", requirement: "Pass the checked scenario", command: `grep -qx correct ${id}/product.txt`, artifactFiles: (lineage && id === "design" ? names : [id]).map(name => `${name}/product.txt`) }],
		})) },
		...(lineage ? { requiredProducts: [{ consumer: "design", producer: "mail", output: "folder-store" }, {consumer: "design", producer: "quality", output: "editor-routing"}] } : {}),
		charters: names.map(name => ({ name, taskIds: mixed && name === "design" ? [name, "mail"] : [name], outcomes: outcomes.map(outcome => outcome.id), scope: { paths: lineage && name === "design" ? names : [name], workTypes: ["product"] },
			context: ["Compare scoped evidence to the desired behavior."], knowledgeFiles: [knowledge], discoveryLimit: 1 })) };
	for (const name of names) { mkdirSync(path.join(root, name)); writeFileSync(path.join(root, name, "product.txt"), "correct\n"); }
	writeFileSync(path.join(root, source), JSON.stringify(policy));
	if (qualify) {
		const git = (/** @type {string[]} */ ...args) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args]);
		git("add", "."); git("commit", "-qm", "baseline"); git("branch", "product");
	}
	let worker = "leaf", receipt = 0;
	/** @type {Map<string,()=>void>} */ const turns = new Map();
	/** @type {string[]} */
	const recipients = [];
	const runtime = createRuntime({ directory: root, readMode: async () => "interactive", log() {},
		execute: async (name, args) => {
			if (name === "send_session_message") {
				const recipient = text(record(args).session_id, "recipient");
				recipients.push(recipient); turns.get(recipient)?.();
				return { resultType: "success", textResultForLlm: "Queued" };
			}
			assert.equal(name, "bash");
			runtime.pre(name, args, worker, `receipt-call-${++receipt}`);
			const execution = spawnSync("/bin/sh", ["-c", text(record(args).command, "oracle")], { encoding: "utf8" });
			assert.equal(execution.status, 0, execution.stderr);
			const result = { resultType: "success", textResultForLlm: execution.stdout };
			runtime.post(name, args, result, worker);
			return result;
		} });
	t.after(() => { runtime.close(); rmSync(root, { recursive: true, force: true }); });
	const start = record(await runtime.operation("start_factory", { source }, "director"));
	assert.ok(Array.isArray(start.prepared));
	assert.equal(start.prepared.length, Math.min(names.length, workers));
	const db = runtime.store();
	assert.equal(db.snapshot().completions?.length, 0);
	assert.deepEqual(db.backlog("director").items, []);
	for (const call of start.prepared) {
		const task = db.getTask(call.taskId);
		assert.ok(!db.backlog("director").squads.find(squad => squad.taskId === task.id)?.bound);
		runtime.pre("create_session", call.arguments, "director", `native-${call.taskId}`);
		const lead = task.title.split(" ")[0];
		runtime.post("create_session", call.arguments, { id: lead }, "director");
		assert.equal(db.getTask(task.id).owner, lead);
	}
	/** @param {string} actor */
	function binding(actor) {
		const squad = db.backlog(actor).squads[0];
		return { squadId: squad.id, generation: squad.generation, revision: squad.revision, activation: squad.activation };
	}
	/** @param {string} actor @param {string} gapKey @param {Record<string,unknown>} [extra] */
	function observation(actor, gapKey, extra = {}) {
		return { ...binding(actor), observation: { kind: "gap", gapKey, title: `Resolve ${gapKey}`, outcome: "routing", template: actor,
			gap: "Reference scenario distinguishes two account routes", improvement: "Match reference routing", stop: "Independent scenario passes",
			evidence: [knowledge], ...extra } };
	}
	/** @param {string} actor @param {string} gapKey @param {Record<string,unknown>} [extra] */
	function admit(actor, gapKey, extra) {
		const result = db.observeWork(observation(actor, gapKey, extra), actor).observation;
		assert.ok(result.disposition === "recorded" || result.disposition === "duplicate");
		return result.itemId;
	}
	/** @param {string} actor @param {string} id */
	function job(actor, id) {
		db.advanceSquads(actor);
		const item = db.backlog(actor).items.find(entry => entry.id === id);
		assert.ok(item?.goalId);
		return { item, tasks: db.snapshot(item.goalId).tasks };
	}
	/** @param {string} actor @param {string} itemId @param {string} publish */
	async function produce(actor, itemId, publish) {
		const { tasks } = job(actor, itemId);
		const taskId = text(tasks.find(task => task.deliverable === publish)?.id, "product task");
		const call = record(await runtime.operation("dispatch", { taskIds: [taskId] }, actor));
		assert.ok(Array.isArray(call.prepared));
		const args = call.prepared[0].arguments;
		worker = `${itemId}-worker`;
		runtime.pre("create_session", args, actor, itemId);
		runtime.post("create_session", args, { id: worker }, actor);
		return publishTask(taskId, publish);
	}
	/** @param {string} taskId @param {string} publish */
	async function publishTask(taskId, publish) {
		worker = db.getTask(taskId).owner;
		const result = record(await runtime.operation("run_check", { taskId, checkId: "scenario", publish }, worker));
		assert.equal(result.promoted, true);
		return db.getTask(taskId);
	}
	return { root, runtime, db, binding, observation, admit, job, policy, source, knowledge, recipients, produce, publishTask, turns };
}

test("cold discovery requires binding and verified evidence; duplicate, advisory, scope and empty-lane dispositions create no demand", async t => {
	const { db, runtime, binding, observation, admit, knowledge } = await setup(t);
	const item = admit("mail", "account-routing");
	assert.deepEqual(db.observeWork(observation("quality", "Account-Routing"), "quality").observation, { disposition: "duplicate", itemId: item });
	assert.throws(() => db.observeWork(observation("mail", "foreign"), "director"), { code: "unbound_squad" });
	assert.throws(() => db.observeWork(observation("mail", "foreign"), "design"), { code: "unbound_squad" });
	assert.throws(() => db.observeWork(observation("mail", "forged", { evidence: [{ ...knowledge, sha256: "wrong" }] }), "mail"), { code: "unverified_observation" });
	for (const extra of [{ kind: "advisory" }, { template: "quality" }, { scope: { paths: ["quality"] } }, { evidence: [] }]) {
		assert.equal(db.observeWork(observation("mail", JSON.stringify(extra), extra), "mail").observation.disposition, "proposal");
	}
	assert.equal(db.backlog("mail").items.filter(item => item.state === "queued").length, 1);
	assert.equal(record(await runtime.operation("inspect_evidence", { ...binding("design"), path: knowledge.path }, "design")).sha256, knowledge.sha256);
	await runtime.operation("observe_work", { ...binding("design"), observation: { kind: "no-gap", gap: "No visual delta in the pinned scenario", evidence: [knowledge] } }, "design");
	await runtime.operation("get_context", {}, "design");
	await runtime.operation("advance", {}, "design");
	assert.equal(db.backlog("design").squads[0].needsDiscovery, false);
	assert.deepEqual(db.backlog("design").items, []);
	admit("quality", "compare-fixtures", { kind: "question", evidence: [] });
	assert.throws(() => admit("quality", "second-question", { kind: "question", evidence: [] }), { code: "discovery_exhausted" });
});

test("evidenced no-gap can withdraw one obsolete queue head and notify the next eligible squad without fabricating acceptance", async t => {
	const { db, binding, admit, job, knowledge } = await setup(t);
	const mail = admit("mail", "route");
	job("mail", mail); // one remaining whole-job slot
	const obsolete = admit("quality", "does-fixture-exist", { kind: "question" });
	const design = admit("design", "labels");
	const noGap = { kind: "no-gap", gap: "The pinned scenario already answers the fixture question", evidence: [knowledge] };
	const submit = (/** @type {string} */ actor, /** @type {Record<string,unknown>} */ fields) => {
		const result = db.observeWork({ ...binding(actor), observation: { ...noGap, ...fields } }, actor);
		assert.equal(result.observation.disposition, "no-gap");
	};
	submit("quality", {});
	assert.throws(() => submit("design", { withdrawItemId: obsolete }), { code: "withdrawal_conflict" });
	assert.throws(() => submit("quality", { withdrawItemId: obsolete, evidence: [] }), { code: "unverified_observation" });
	assert.throws(() => submit("mail", { withdrawItemId: mail }), { code: "withdrawal_conflict" });
	assert.equal(db.backlog("design").squads[0].canAdmit, false);
	const generation = db.getTask(db.backlog("design").squads[0].taskId).coordination?.generation;
	submit("quality", { withdrawItemId: obsolete });
	submit("quality", { withdrawItemId: obsolete });
	const withdrawn = db.backlog("quality").items.find(item => item.id === obsolete);
	assert.equal(withdrawn?.state, "retired");
	assert.equal(withdrawn.goalId, undefined);
	assert.equal(withdrawn.resultId, undefined);
	assert.equal(withdrawn.observations.filter(o => record(o).kind === "withdrawal").length, 1);
	assert.equal(db.getTask(db.backlog("design").squads[0].taskId).coordination?.generation, Number(generation) + 1);
	assert.deepEqual(db.backlog("design").squads[0].readyItems, [design]);
	assert.equal(db.backlog("design").squads[0].canAdmit, true);
	admit("mail", "needs-design", { dependencies: [design] });
	assert.throws(() => submit("design", { withdrawItemId: design }), { code: "required_item" });
	assert.equal(db.backlog("design").squads[0].canAdmit, true);
});

test("admission skips blocked items, respects whole-job capacity and replay; exact product publication opens a successor without reopening", async t => {
	const { db, runtime, admit, job } = await setup(t);
	const mail = admit("mail", "route");
	const quality = admit("quality", "counterexample");
	const blocked = admit("quality", "blocked", { dependencies: [mail], severity: 10 });
	assert.deepEqual(db.backlog("quality").squads[0].readyItems, [quality]);
	const one = job("mail", mail), two = job("quality", quality);
	assert.equal(one.tasks.length, 1); assert.equal(two.tasks.length, 1);
	assert.equal(job("mail", mail).item.goalId, one.item.goalId);
	const next = admit("mail", "labels", { outcome: "labels" });
	db.advanceSquads("mail");
	assert.equal(db.backlog("mail").items.find(i => i.id === next)?.state, "queued");
	const taskId = text(one.tasks?.[0].id, "product task");
	const call = record(await runtime.operation("dispatch", { taskIds: [taskId] }, "mail"));
	assert.ok(Array.isArray(call.prepared));
	const args = call.prepared[0].arguments;
	runtime.pre("create_session", args, "mail", "product-leaf");
	runtime.post("create_session", args, { id: "leaf" }, "mail");
	const result = record(await runtime.operation("run_check", { taskId, checkId: "scenario", publish: "product" }, "leaf"));
	assert.equal(result.promoted, true);
	const current = db.backlog("mail").items.find(item => item.id === mail);
	assert.equal(current?.state, "accepted");
	assert.equal(current.resultId, record(result.result).id);
	assert.equal(current.capacityReleased, true);
	const wake = db.snapshot().wakes.find(wake => wake.owner === "quality" && wake.relatedReasons?.includes(`output:${taskId}`));
	assert.ok(wake && db.canRelayOutput(wake.id, "leaf", current.goalId));
	assert.deepEqual(db.backlog("quality").squads[0].readyItems, [blocked]);
	const successor = admit("mail", "account-switch", { predecessor: mail, evidence: [{ resultId: current.resultId }] });
	db.advanceSquads("mail");
	assert.equal(db.backlog("mail").items.find(i => i.id === successor)?.state, "queued");
	assert.equal(job("quality", blocked).item.state, "admitted");
	assert.equal(db.backlog("mail").items.find(item => item.id === successor)?.predecessor, mail);
	assert.equal(db.snapshot().completions?.find(completion => completion.goalId === current.goalId)?.closed, true);
});

test("accepted product, consumed wake, no runnable jobs: the same lead still owes discovery without holding a slot", async t => {
	const { db, runtime, binding, admit, knowledge } = await setup(t);
	const squad = db.backlog("mail").squads[0], stale = binding("mail");
	const itemId = admit("mail", "route");
	const lead = () => db.getTask(squad.taskId);
	const wait = () => ({ taskId: squad.taskId, attemptId: lead().currentAttemptId, kind: "events",
		reason: "No further work", handledGeneration: lead().coordination?.generation });
	const advance = async () => record(await runtime.operation("advance", {}, "mail"));
	assert.deepEqual(db.backlog("mail").squads[0].readyItems, [itemId]);
	assert.equal(db.backlog("mail").squads[0].needsDiscovery, false);
	await assert.rejects(runtime.operation("wait_task", wait(), "mail"), { code: "squad_work_pending" });
	assert.equal(db.getAttempt(text(lead().currentAttemptId, "lead attempt")).slot, false);
	const batch = await advance();
	assert.ok(Array.isArray(batch.prepared));
	const taskId = batch.prepared[0].taskId;
	runtime.pre("create_session", batch.prepared[0].arguments, "mail", "leaf-create");
	runtime.post("create_session", batch.prepared[0].arguments, { id: "leaf" }, "mail");
	await runtime.operation("wait_task", wait(), "mail"); // genuinely waiting on the product
	const publication = record(await runtime.operation("run_check", { taskId, checkId: "scenario", publish: "product" }, "leaf"));
	const resultId = text(record(publication.result).id, "promoted result");
	const expected = { tool: "foundry_observe_work", arguments: binding("mail"), reason: `accepted:${itemId}`, resultId };
	assert.deepEqual((await advance()).squadActions, [expected]);
	assert.equal(db.pendingWakes("mail").length, 0);
	assert.deepEqual(db.advanceSquads("director", squad.goalId).actions, []);
	const handled = lead().coordination?.handled;
	await assert.rejects(runtime.operation("wait_task", wait(), "mail"), { code: "squad_work_pending", message: /foundry_observe_work/ });
	assert.equal(lead().coordination?.handled, handled);

	// Natural termination is allowed. The one exceptional continuation uses the
	// existing attempt and transport, even when its original wake was consumed.
	const workers = db.snapshot().attempts.length;
	runtime.agentStop("mail");
	const [continuation] = db.pendingWakes("mail");
	assert.equal(continuation?.reason, `coordination:${squad.taskId}`);
	const issued = db.claimWakeDelivery(continuation.id, continuation.generation, undefined, { session_id: "mail" }, "director");
	assert.ok(issued);
	const handoff = db.advanceSquads("director", squad.goalId).handoffs.find(h => h.owner === "mail");
	assert.equal(handoff?.state, "send-unconfirmed");
	assert.equal(handoff.deliveryId, issued.id);
	assert.equal(handoff.sender, "director");
	await runtime.operation("advance", { goalId: squad.goalId }, "director"); // never replay an issued send
	assert.equal(db.getDelivery(issued.id).state, "issued");
	db.settleWakeDelivery(continuation.id, issued.id, continuation.generation, { resultType: "success" }, true, "director");
	await runtime.flushNotifications();
	assert.equal(db.snapshot().wakes.find(w => w.id === continuation.id)?.sent, continuation.generation);
	assert.deepEqual((await advance()).squadActions, [expected]);
	runtime.agentStop("mail");
	assert.deepEqual(db.pendingWakes("mail"), []);
	const report = db.advanceSquads("director", squad.goalId).handoffs.find(h => h.owner === "mail");
	assert.equal(report?.state, "owner-stopped-with-work");
	assert.equal(report.due, "foundry_observe_work");
	assert.deepEqual(db.advanceSquads("quality", squad.goalId).handoffs, []);
	const escalated = db.pendingWakes("director").find(w => w.goalId === squad.goalId);
	assert.ok(escalated?.relatedReasons?.includes(`coordination-stalled:${squad.taskId}`));
	runtime.agentStop("mail");
	assert.equal(db.pendingWakes("director").find(w => w.goalId === squad.goalId)?.generation, escalated?.generation);
	const observation = { kind: "no-gap", gap: "Published scenario covers the charter", evidence: [{ resultId }] };
	assert.throws(() => db.observeWork({ ...stale, observation }, "mail"), { code: "stale_generation" });
	assert.throws(() => db.observeWork({ ...binding("mail"), observation: { ...observation, evidence: [{ ...knowledge, sha256: "wrong" }] } }, "mail"), { code: "unverified_observation" });
	db.observeWork({ ...binding("mail"), observation }, "mail");
	assert.deepEqual((await advance()).squadActions, []);
	assert.equal(db.advanceSquads("director", squad.goalId).handoffs.some(h => h.owner === "mail"), false);
	assert.equal(lead().coordination?.handled, lead().coordination?.generation);
	assert.equal(db.snapshot().attempts.length, workers);
	assert.equal(db.backlog("mail").items[0].state, "accepted");
});

test("backlog detail is paged, read-only and version checked; a proposal cannot dispose of a pending review", async t => {
	const { db, runtime, observation, admit } = await setup(t);
	const input = { view: "backlog" };
	const before = db.advanceSquads("mail").actions;
	db.observeWork(observation("mail", "suggestion", { kind: "advisory", gap: "large detail ".repeat(4000) }), "mail");
	const first = record(await runtime.operation("get_context", input, "mail"));
	assert.ok(typeof first.content === "string" && first.content.length <= 4096 && first.nextOffset !== undefined);
	const page = { ...input, offset: first.nextOffset, version: first.version };
	assert.ok(record(await runtime.operation("get_context", page, "mail")).content);
	assert.deepEqual(db.advanceSquads("mail").actions, before);
	assert.equal(db.backlog("quality").items.length, 0);
	await assert.rejects(runtime.operation("get_context", page, "quality"), { code: "backlog_changed" });
	admit("mail", "clarify", { kind: "question", evidence: [] });
	await assert.rejects(runtime.operation("get_context", page, "mail"), { code: "backlog_changed" });
	assert.equal(db.backlog("mail").squads[0].canAdmit, true);
	assert.equal(db.backlog("mail").squads[0].needsDiscovery, false);
});

for (const workers of [1, 2]) test(`one milestone starts and refills ${workers} worker slot(s) through final qualification, then starts its queued successor`, async t => {
	const { root, db, runtime, turns, observation, publishTask } = await setup(t, { workers, maximumJobs: 1, names: ["mail"], qualify: true });
	const producer = (/** @type {string} */ output, /** @type {string[]} */ inputs = []) => ({ template: "mail", purpose: output, output, inputs });
	const observe = (/** @type {unknown[]} */ producers) => observation("mail", "milestone", { producers });
	for (const [nodes, code] of [
		[[producer("a", ["b"])], "missing_output"], [[producer("a"), producer("a")], "duplicate_output"],
		[[producer("a", ["b"]), producer("b", ["a"])], "dependency_cycle"], [[{ ...producer("a"), template: "quality" }], "unknown_template"],
	]) {
		assert.ok(Array.isArray(nodes));
		assert.throws(() => db.observeWork(observe(nodes), "mail"), { code });
	}
	assert.equal(db.backlog("mail").items.length, 0);
	let release = () => {}; const barrier = new Promise(resolve => { release = () => resolve(undefined); });
	/** @type {string[]} */ const calls = [];
	const owner = createRuntime({ directory: root, log() {}, createSession: async args => {
		const token = text(attemptToken(text(record(record(args).kickoff).prompt, "prompt")), "attempt token");
		const task = db.getTask(text(db.attemptByToken(token)?.taskId, "assigned task"));
		calls.push(task.id); await barrier;
		return { resultType: "success", structuredContent: { id: `writer:${token}` } };
	} });
	t.after(() => owner.close());
	turns.set("mail", () => owner.ownerTurn("mail"));
	const input = observe([producer("a"), producer("b"), producer("c", ["b"])]);
	const running = owner.operation("observe_work", input, "mail");
	try {
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(calls.map(id => db.getTask(id).deliverable).sort(), workers === 1 ? ["b"] : ["a", "b"]);
		owner.ownerTurn("mail");
	} finally { release(); await running; await owner.flushNotifications(); }
	await owner.operation("observe_work", input, "mail");
	await assert.rejects(owner.operation("observe_work", observe([producer("a")]), "mail"), { code: "observation_conflict" });
	await owner.operation("observe_work", observation("mail", "next"), "mail");
	assert.equal(calls.length, workers);
	const finish = async (/** @type {string} */ id) => {
		await publishTask(id, text(db.getTask(id).deliverable, "output"));
		await runtime.flushNotifications(); await owner.flushNotifications();
	};
	const b = text(calls.find(id => db.getTask(id).deliverable === "b"), "b");
	await finish(b);
	if (workers === 2) {
		assert.equal(db.getTask(calls[2]).deliverable, "c");
		await finish(calls[2]); assert.equal(calls.length, 3);
		await finish(text(calls.find(id => db.getTask(id).deliverable === "a"), "a"));
	} else {
		assert.equal(calls.length, 2);
		await finish(calls[1]); assert.equal(calls.length, 3);
		await finish(calls[2]);
	}
	const final = db.getTask(calls[3]);
	assert.equal(final.inputs.length, 3);
	assert.throws(() => db.evolveTask({ taskId: final.id, expectedVersion: final.version, inputs: [] }, "mail"), { code: "protected_input" });
	await finish(final.id);
	assert.ok(db.deliveryStatus(final.goalId, "mail").qualified);
	assert.equal(db.deliveryStatus(final.goalId, "mail").landed, null);
	assert.equal(calls.length, 5);
	const next = db.getTask(calls[4]);
	assert.notEqual(next.goalId, final.goalId); assert.equal(next.title, "Resolve next");
	await finish(next.id); // Atomic milestone: recheck the published output on the joined tree.
	assert.deepEqual(calls.slice(4), [next.id, next.id]);
	await finish(next.id);
	assert.equal(calls.length, 6);
	assert.ok(db.deliveryStatus(next.goalId, "mail").qualified);
});

test("replayed observation returns the same unissued calls; a held lead cannot staff them or start a replacement for an uncertain call", async t => {
	const { root, db, runtime, observation } = await setup(t, { workers: 1, names: ["mail"] });
	const input = observation("mail", "fallback"), submit = async () => record(await runtime.operation("observe_work", input, "mail"));
	const { prepared } = await submit(); assert.ok(Array.isArray(prepared) && prepared.length === 1);
	assert.deepEqual((await submit()).prepared, prepared);
	const squad = db.backlog("mail").squads[0];
	await runtime.operation("wait_task", { taskId: squad.taskId, kind: "input", requestId: "native-question", reason: "Awaiting the operator" }, "mail");
	assert.throws(() => runtime.pre("create_session", prepared[0].arguments, "mail", "held-create"), { code: "squad_held" });
	let calls = 0;
	const owner = createRuntime({ directory: root, log() {}, createSession: async () => { calls++; throw Error("Receipt lost"); } });
	t.after(() => owner.close()); owner.attachUsage("mail");
	owner.ownerTurn("mail"); await owner.flushNotifications(); assert.equal(calls, 0);
	db.clearNativeInputs("mail", "mail", squad.goalId);
	owner.ownerTurn("mail"); await owner.flushNotifications(); assert.equal(calls, 1);
	owner.ownerTurn("mail"); await owner.flushNotifications(); assert.equal(calls, 1);
	assert.equal(db.getEffect(prepared[0].effectId).state, "uncertain");
});

test("yielding a lead's only slot wakes the director to start the next subscribed lead", async t => {
	const { db, runtime, root, turns } = await setup(t, { workers: 1, names: ["mail", "quality"] });
	const director = createRuntime({ directory: root, log() {}, createSession: async () => ({ resultType: "success", structuredContent: { id: "quality" } }) });
	t.after(() => director.close()); director.attachUsage("director");
	turns.set("director", () => director.ownerTurn("director"));
	const lead = db.getTask(db.backlog("mail").squads[0].taskId);
	await assert.rejects(runtime.operation("wait_task", { taskId: lead.id, attemptId: lead.currentAttemptId, kind: "events",
		reason: "Yield the slot", handledGeneration: lead.coordination?.generation }, "mail"), { code: "squad_work_pending" });
	await runtime.flushNotifications(); await director.flushNotifications();
	assert.equal(db.backlog("quality").squads[0].bound, true);
	assert.equal(db.backlog("mail").squads[0].needsDiscovery, true);
});

test("a definite native refusal frees the slot for independent work, without retrying the denied worker", async t => {
	const { root, db, observation } = await setup(t, { workers: 1, names: ["mail"] });
	let calls = 0;
	const owner = createRuntime({ directory: root, log() {}, createSession: async () => ++calls === 1
		? { resultType: "denied" } : { resultType: "success", structuredContent: { id: "independent" } } });
	t.after(() => owner.close());
	const receipt = record(await owner.operation("observe_work", observation("mail", "two-outputs", {
		producers: ["first","second"].map(output => ({ template: "mail", output, purpose: output })),
	}), "mail"));
	await owner.flushNotifications();
	assert.ok(Array.isArray(receipt.blocked) && receipt.blocked.some(b => b.code === "native_permission_refused"));
	const tasks = db.snapshot().tasks.filter(task => task.deliverable);
	assert.equal(tasks.find(task => task.deliverable === "first")?.state, "blocked");
	assert.equal(tasks.find(task => task.deliverable === "second")?.owner, "independent");
	owner.ownerTurn("mail"); await owner.flushNotifications(); assert.equal(calls, 2);
});

test("priority-only revisions reorder unstarted work, changed scope cancels issued work without erasing evidence or admitting stale proposals", async t => {
	const { db, runtime, source, root, policy, binding, admit, job, observation } = await setup(t, { maximumJobs: 1 });
	const first = admit("mail", "route"), second = admit("mail", "label", { outcome: "labels" });
	assert.deepEqual(db.backlog("mail").squads[0].readyItems, [first, second]);
	const stale = observation("mail", "old");
	policy.direction.revision = 2; policy.direction.outcomes[0].priority = 3;
	writeFileSync(path.join(root, source), JSON.stringify(policy));
	await runtime.operation("revise_direction", { factoryId: policy.id, expectedRevision: 1, source }, "director");
	assert.deepEqual(db.backlog("mail").squads[0].readyItems, [second, first]);
	assert.throws(() => db.observeWork(stale, "mail"), { code: "stale_direction" });
	const { tasks } = job("mail", second);
	const taskId = text(tasks?.[0].id, "product task"), batch = record(await runtime.operation("dispatch", { taskIds: [taskId] }, "mail"));
	assert.ok(Array.isArray(batch.prepared));
	runtime.pre("create_session", batch.prepared[0].arguments, "mail", "outstanding-native-create");
	policy.direction.revision = 3; policy.direction.outcomes.pop();
	writeFileSync(path.join(root, source), JSON.stringify(policy));
	await runtime.operation("revise_direction", { factoryId: policy.id, expectedRevision: 2, source }, "director");
	assert.equal(db.getTask(taskId).state, "cancelled");
	assert.equal(db.getEffect(batch.prepared[0].effectId).state, "issued");
	assert.equal(db.backlog("mail").items.find(item => item.id === second)?.state, "retired");
	assert.deepEqual(db.backlog("mail").squads[0].readyItems, [first]);
	await runtime.operation("pause_factory", { factoryId: policy.id }, "director");
	assert.throws(() => db.observeWork(observation("mail", "paused"), "mail"), { code: "factory_paused" });
	const staleActivation = binding("mail");
	await runtime.operation("start_factory", { source }, "director");
	assert.throws(() => db.observeWork({ ...observation("mail", "stale"), ...staleActivation }, "mail"), { code: "stale_activation" });
	assert.equal(db.backlog("mail").items.find(i => i.id === first)?.currentRevision, 3);
});

test("bound peers can commit an existing scoped output, deliver it directly and keep the destination independently runnable", async t => {
	const { db, runtime, admit, job } = await setup(t);
	const mail = admit("mail", "routing"), quality = admit("quality", "scenario", {
		producers: [{ template: "quality", purpose: "Two-account scenario", output: "scenario" }],
	});
	const source = db.backlog("mail").squads[0], destination = db.backlog("quality").squads[0];
	const consumer = job("mail", mail).tasks[0].id;
	const target = job("quality", quality);
	const part = text(target.tasks?.find(task => task.deliverable === "scenario")?.id, "scenario producer");
	const request = db.requestCollaboration({ sourceTaskId: source.taskId, destinationTaskId: destination.taskId, consumerTaskId: consumer,
		expectedVersion: 1, title: "Publish the distinguishing account case", output: "scenario", required: true }, "mail");
	assert.equal(request.goalId, db.getTask(consumer).goalId);
	assert.throws(() => db.respondCollaboration({ action: "accept", collaborationId: request.id, expectedRevision: 1, producerTaskId: part }, "mail"), { code: "forbidden" });
	const accepted = db.respondCollaboration({ action: "accept", collaborationId: request.id, expectedRevision: 1, producerTaskId: part }, "quality");
	assert.equal(accepted.destinationGoalId, target.item.goalId);
	assert.equal(db.readyTasks("mail", request.goalId, true).length, 0);
	const call = record(await runtime.operation("dispatch", { taskIds: [part] }, "quality"));
	assert.ok(Array.isArray(call.prepared));
	runtime.pre("create_session", call.prepared[0].arguments, "quality", "scenario-leaf");
	runtime.post("create_session", call.prepared[0].arguments, { id: "leaf" }, "quality");
	const result = record(await runtime.operation("run_check", { taskId: part, checkId: "scenario", publish: "scenario" }, "leaf"));
	assert.equal(result.promoted, true);
	const delivery = db.respondCollaboration({ action: "fulfill", collaborationId: request.id, expectedRevision: 2 }, "quality");
	assert.equal(delivery.bound, true); assert.equal(delivery.delivery?.version, db.getTask(part).outputs[0].version);
	assert.ok(db.readyTasks("mail", request.goalId, true).some(task => task.id === consumer));
	assert.ok(db.readyTasks("quality", target.item.goalId, true).some(task => task.deliverable === "product"));
});

test("a cold join waits without peer ID requests; admitting its last missing source wakes only its owner once", async t => {
	const { db, runtime, binding, observation, admit, recipients, produce } = await setup(t, {
		lineage: true, completionTaskId: "mail", names: ["mail", "quality", "design", "preview"],
	});
	assert.throws(() => admit("preview", "unrelated"), { code: "milestone_acceptance" });
	const consumer = db.backlog("design").squads[0];
	const advance = async () => record(await runtime.operation("advance", { goalId: consumer.goalId }, "design"));
	assert.deepEqual((await advance()).squadActions, []);
	assert.deepEqual(consumer.awaitingSources, ["folder-store", "editor-routing"]);
	await runtime.operation("wait_task", { taskId: consumer.taskId, attemptId: db.getTask(consumer.taskId).currentAttemptId,
		kind: "events", handledGeneration: db.getTask(consumer.taskId).coordination?.generation, reason: "Waiting for canonical source items" }, "design");
	const before = binding("design").generation, unrelated = binding("quality").generation;
	const first = admit("quality", "routing");
	assert.equal(binding("design").generation, before);
	assert.deepEqual(db.advanceSquads("design").actions, []);
	assert.deepEqual(db.backlog("quality").squads[0].readyItems, [first]);
	await runtime.operation("observe_work", observation("mail", "not-admitted", { kind: "advisory" }), "mail");
	assert.equal(binding("design").generation, before);
	const input = observation("mail", "folders");
	await runtime.flushNotifications();
	const sent = recipients.length;
	const second = text(record(record(await runtime.operation("observe_work", input, "mail")).observation).itemId, "last source");
	await runtime.operation("observe_work", input, "mail");
	await runtime.flushNotifications();
	assert.deepEqual(recipients.slice(sent), ["design"]);
	assert.equal(binding("design").generation, before + 1);
	assert.equal(binding("quality").generation, unrelated);
	const wake = db.snapshot().wakes.find(w => w.owner === "design" && w.goalId === consumer.goalId);
	assert.ok(wake && wake.sent === wake.generation && wake.sent > wake.consumed);
	const { squadActions } = await advance();
	assert.ok(Array.isArray(squadActions));
	assert.equal(squadActions[0].tool, "foundry_observe_work");
	const sources = Object.fromEntries(db.backlog("design").squads[0].requiredProducts.map(rule => [rule.output, rule.sources[0].itemId]));
	assert.deepEqual(sources, { "folder-store": second, "editor-routing": first });
	const join = admit("design", "join", { sources });
	assert.deepEqual(db.backlog("design").squads[0].readyItems, []);
	assert.deepEqual((await advance()).prepared, []);
	await produce("quality", first, "editor-routing");
	await runtime.flushNotifications();
	assert.deepEqual(db.backlog("design").squads[0].readyItems, []);
	const beforePublish = recipients.length;
	await produce("mail", second, "folder-store");
	await runtime.flushNotifications();
	assert.ok(recipients.slice(beforePublish).includes("design"));
	const pickup = await advance();
	assert.ok(Array.isArray(pickup.prepared) && pickup.prepared.length === 1);
	assert.equal(db.getTask(pickup.prepared[0].taskId).goalId, db.backlog("design").items.find(i => i.id === join)?.goalId);
	await produce("design", join, "product");
	assert.deepEqual((await advance()).prepared, []);
	assert.equal(db.backlog("design").items.find(item => item.id === join)?.state, "accepted");
});

test("missing sources for one template do not park discovery for an independent template in the same charter", async t => {
	const { db } = await setup(t, { lineage: true, mixed: true });
	assert.equal(db.backlog("design").squads[0].awaitingSources, undefined);
	assert.equal(db.advanceSquads("design").actions[0]?.tool, "foundry_observe_work");
});

test("a policy join requires both exact source items and the checked bytes from both published products", async t => {
	const { root, db, admit, produce } = await setup(t, { lineage: true });
	const mail = admit("mail", "folder-store"), quality = admit("quality", "editor-routing");
	const sources = { "folder-store": mail, "editor-routing": quality };
	assert.throws(() => admit("design", "missing"), { code: "required_products" });
	assert.throws(() => admit("design", "wrong", { sources: { ...sources, "folder-store": quality } }), { code: "wrong_product_source" });
	const join = admit("design", "mismatched-bytes", { sources });
	db.advanceSquads("design");
	assert.equal(db.backlog("design").items.find(i => i.id === join)?.goalId, undefined);
	const first = await produce("mail", mail, "folder-store");
	const second = await produce("quality", quality, "editor-routing");
	assert.deepEqual(db.backlog("design").squads[0].readyItems, [join]);
	writeFileSync(path.join(root, "mail/product.txt"), "unrelated bytes, same filename\n");
	await assert.rejects(produce("design", join, "product"), { code: "product_lineage_mismatch" });
	const incident = db.backlog("design").items.find(item => item.id === join);
	assert.equal(incident?.state, "admitted");
	assert.equal(db.snapshot().completions?.find(completion => completion.goalId === incident?.goalId)?.closed, false);
	const retry = admit("design", "correct-join", { sources });
	writeFileSync(path.join(root, "mail/product.txt"), "correct\n");
	const integrated = await produce("design", retry, "product");
	assert.deepEqual(integrated.inputs, [ { taskId: first.id, output: "folder-store", version: first.outputs[0].version },
		{ taskId: second.id, output: "editor-routing", version: second.outputs[0].version } ]);
	assert.equal(db.backlog("design").items.find(item => item.id === retry)?.state, "accepted");
});

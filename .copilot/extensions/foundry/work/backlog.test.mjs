import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntime } from "./runtime.mjs";
import { record, text } from "./values.mjs";

/** @param {import("node:test").TestContext} t @param {boolean} [lineage] */
async function setup(t, lineage = false) {
	const root = mkdtempSync(path.join(os.tmpdir(), "foundry-discovery-"));
	execFileSync("git", ["init", "-q", root]);
	mkdirSync(path.join(root, ".foundry"));
	const scope = { mode: "autopilot", delegation: true, paths: ["."], workTypes: ["product"], restrictions: [] };
	const source = ".foundry/factory.json";
	const knowledge = { path: ".foundry/scenario.txt", sha256: createHash("sha256").update("Account A must not see account B's drafts.").digest("hex") };
	writeFileSync(path.join(root, knowledge.path), "Account A must not see account B's drafts.");
	const outcomes = [{ id: "routing", title: "Correct account routing", success: "Two isolated accounts", priority: 1 },
		{ id: "labels", title: "Correct labels", success: "Labels match", priority: 2 }];
	const names = ["mail", "quality", "design"];
	const policy = { format: "foundry-factory", version: 2, id: "product", mechanism: "native", maximumJobs: 2,
		direction: { revision: 1, outcomes, constraints: ["No real-account writes"], nonGoals: ["Network sync"] },
		goal: { title: "Native Mail", scope, limits: { workers: 4 }, tasks: names.map(id => ({
			id, title: `Validate ${id} behavior`, assignment: `Prove ${id} behavior using isolated scenarios`, workType: "product",
			checks: [{ id: "scenario", kind: "command", requirement: "Pass the checked scenario", command: `grep -qx correct ${id}/product.txt`, artifactFiles: (lineage && id === "design" ? names : [id]).map(name => `${name}/product.txt`) }],
		})) },
		...(lineage ? { requiredProducts: [{ consumer: "design", producer: "mail", output: "folder-store" }, {consumer: "design", producer: "quality", output: "editor-routing"}] } : {}),
		charters: names.map(name => ({ name, taskIds: [name], outcomes: outcomes.map(outcome => outcome.id), scope: { paths: lineage && name === "design" ? names : [name], workTypes: ["product"] },
			context: ["Compare scoped evidence to the desired behavior."], knowledgeFiles: [knowledge], discoveryLimit: 1 })) };
	for (const name of names) { mkdirSync(path.join(root, name)); writeFileSync(path.join(root, name, "product.txt"), "correct\n"); }
	writeFileSync(path.join(root, source), JSON.stringify(policy));
	let worker = "leaf", receipt = 0;
	const runtime = createRuntime({ directory: root, readMode: async () => "interactive", log() {},
		execute: async (name, args) => {
			if (name === "send_session_message") return { resultType: "success", textResultForLlm: "Queued" };
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
	assert.equal(start.prepared.length, names.length);
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
		return text(record(db.observeWork(observation(actor, gapKey, extra), actor).item).id, "admitted item");
	}
	return { root, runtime, db, binding, observation, admit, policy, source, knowledge, selectWorker(/** @type {string} */ name) { worker = name; } };
}

test("cold discovery requires binding and verified evidence; duplicate, advisory, scope and empty-lane dispositions create no demand", async t => {
	const { db, runtime, binding, observation, admit, knowledge } = await setup(t);
	const item = admit("mail", "account-routing");
	assert.equal(db.observeWork(observation("quality", "Account-Routing"), "quality").duplicateOf, item);
	assert.throws(() => db.observeWork(observation("mail", "foreign"), "director"), { code: "unbound_squad" });
	assert.throws(() => db.observeWork(observation("mail", "foreign"), "design"), { code: "unbound_squad" });
	assert.throws(() => db.observeWork(observation("mail", "forged", { evidence: [{ ...knowledge, sha256: "wrong" }] }), "mail"), { code: "unverified_observation" });
	for (const extra of [{ kind: "advisory" }, { template: "quality" }, { scope: { paths: ["quality"] } }, { evidence: [] }]) {
		assert.equal(db.observeWork(observation("mail", JSON.stringify(extra), extra), "mail").item?.state, "proposal");
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

test("rank and pull skip blocked items, respect whole-job capacity and replay; exact product publication opens a successor without reopening", async t => {
	const { db, runtime, binding, admit } = await setup(t);
	const mail = admit("mail", "route");
	const quality = admit("quality", "counterexample");
	const blocked = admit("quality", "blocked", { dependencies: [mail], severity: 10 });
	assert.deepEqual(db.backlog("quality").squads[0].readyItems, [quality]);
	assert.throws(() => db.pullWork({ ...binding("quality"), itemId: blocked }, "quality"), { code: "not_highest_ready" });
	const one = db.pullWork({ ...binding("mail"), itemId: mail }, "mail"), two = db.pullWork({ ...binding("quality"), itemId: quality }, "quality");
	assert.equal(one.tasks?.length, 1); assert.equal(two.tasks?.length, 1);
	assert.equal(db.pullWork({ ...binding("mail"), itemId: mail }, "mail").replay, true);
	const next = admit("mail", "labels", { outcome: "labels" });
	assert.throws(() => db.pullWork({ ...binding("mail"), itemId: next }, "mail"), { code: "factory_capacity" });
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
	assert.throws(() => db.pullWork({ ...binding("mail"), itemId: successor }, "mail"), { code: "older_squad_ready" });
	assert.equal(db.pullWork({ ...binding("quality"), itemId: blocked }, "quality").replay, false);
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
	const [pull] = db.squadTurns("mail", squad.goalId).actions;
	assert.equal(pull.tool, "foundry_pull_work");
	assert.equal(db.backlog("mail").squads[0].needsDiscovery, false);
	await assert.rejects(runtime.operation("wait_task", wait(), "mail"), { code: "squad_work_pending" });
	assert.equal(db.getAttempt(text(lead().currentAttemptId, "lead attempt")).slot, false);
	const taskId = text(db.pullWork(pull.arguments, "mail").tasks?.[0].id, "product");
	const batch = record(await runtime.operation("dispatch", { taskIds: [taskId] }, "mail"));
	assert.ok(Array.isArray(batch.prepared));
	runtime.pre("create_session", batch.prepared[0].arguments, "mail", "leaf-create");
	runtime.post("create_session", batch.prepared[0].arguments, { id: "leaf" }, "mail");
	await runtime.operation("wait_task", wait(), "mail"); // genuinely waiting on the product
	const publication = record(await runtime.operation("run_check", { taskId, checkId: "scenario", publish: "product" }, "leaf"));
	const resultId = text(record(publication.result).id, "promoted result");
	const expected = { tool: "foundry_observe_work", arguments: binding("mail"), reason: `accepted:${itemId}`, resultId };
	assert.deepEqual((await advance()).squadActions, [expected]);
	assert.equal(db.pendingWakes("mail").length, 0);
	assert.deepEqual(db.squadTurns("director", squad.goalId).actions, []);
	const handled = lead().coordination?.handled;
	await assert.rejects(runtime.operation("wait_task", wait(), "mail"), { code: "squad_work_pending", message: /foundry_observe_work/ });
	assert.equal(lead().coordination?.handled, handled);

	// Natural termination is allowed. The one exceptional continuation uses the
	// existing attempt and transport, even when its original wake was consumed.
	const workers = db.snapshot().attempts.length;
	runtime.agentStop("mail");
	const [continuation] = db.pendingWakes("mail");
	assert.equal(continuation?.reason, `coordination:${squad.taskId}`);
	await runtime.operation("advance", { goalId: squad.goalId }, "director");
	await runtime.flushNotifications();
	assert.equal(db.snapshot().wakes.find(w => w.id === continuation.id)?.sent, continuation.generation);
	assert.deepEqual((await advance()).squadActions, [expected]);
	runtime.agentStop("mail");
	assert.deepEqual(db.pendingWakes("mail"), []);
	const observation = { kind: "no-gap", gap: "Published scenario covers the charter", evidence: [{ resultId }] };
	assert.throws(() => db.observeWork({ ...stale, observation }, "mail"), { code: "stale_generation" });
	assert.throws(() => db.observeWork({ ...binding("mail"), observation: { ...observation, evidence: [{ ...knowledge, sha256: "wrong" }] } }, "mail"), { code: "unverified_observation" });
	db.observeWork({ ...binding("mail"), observation }, "mail");
	assert.deepEqual((await advance()).squadActions, []);
	assert.equal(lead().coordination?.handled, lead().coordination?.generation);
	assert.equal(db.snapshot().attempts.length, workers);
	assert.equal(db.backlog("mail").items[0].state, "accepted");
});

test("backlog detail is paged, read-only and version checked; a proposal cannot dispose of a pending review", async t => {
	const { db, runtime, observation, admit } = await setup(t);
	const input = { view: "backlog" };
	const before = db.squadTurns("mail").actions;
	db.observeWork(observation("mail", "suggestion", { kind: "advisory", gap: "large detail ".repeat(4000) }), "mail");
	const first = record(await runtime.operation("get_context", input, "mail"));
	assert.ok(typeof first.content === "string" && first.content.length <= 4096 && first.nextOffset !== undefined);
	const page = { ...input, offset: first.nextOffset, version: first.version };
	assert.ok(record(await runtime.operation("get_context", page, "mail")).content);
	assert.deepEqual(db.squadTurns("mail").actions, before);
	assert.equal(db.backlog("quality").items.length, 0);
	await assert.rejects(runtime.operation("get_context", page, "quality"), { code: "backlog_changed" });
	admit("mail", "clarify", { kind: "question", evidence: [] });
	await assert.rejects(runtime.operation("get_context", page, "mail"), { code: "backlog_changed" });
	assert.equal(db.squadTurns("mail").actions[0]?.tool, "foundry_pull_work");
	assert.equal(db.backlog("mail").squads[0].needsDiscovery, false);
});

test("local spec graph preserves named acceptance; invalid plans roll back, independent outputs run together and incremental splits are idempotent", async t => {
	const { db, binding, admit } = await setup(t);
	const itemId = admit("mail", "fixture-split"), { tasks } = db.pullWork({ ...binding("mail"), itemId }, "mail");
	const final = text(tasks?.[0].id, "acceptance");
	const producer = { id: "contract", title: "Conserve folder contract", template: "mail", output: "contract", purpose: "Product-level routing", stop: "Fixture passes" };
	const counter = { ...producer, id: "counter", title: "Distinguish account ids", output: "counterexample" };
	const spec = { specification: "Route drafts by account", boundary: "Account-scoped folder", examples: ["A sees its draft"],
		negativeCases: ["B cannot see A's drafts"], producers: [producer, counter], requires: [{ taskId: "contract", output: "contract" }, { taskId: "counter", output: "counterexample" }] };
	const base = { ...binding("mail"), itemId, expectedVersion: 1, splitId: "first" };
	const before = db.snapshot().tasks.length;
	for (const [invalid, code] of [
		[{ ...spec, requires: [{ taskId: "contract", output: "wrong" }] }, "missing_output"],
		[{ ...spec, producers: [{ ...producer, inputs: [spec.requires[1]] }, { ...counter, inputs: [spec.requires[0]] }] }, "dependency_cycle"],
		[{ ...spec, producers: [{ ...producer, scope: { paths: ["quality"] } }, counter] }, "scope_widening"],
		[{ ...spec, producers: [{ ...producer, output: "" }, counter] }, "invalid_field"],
	]) {
		assert.throws(() => db.splitWork({ ...base, plan: invalid }, "mail"), { code });
		assert.equal(db.snapshot().tasks.length, before);
	}
	const first = db.splitWork({ ...base, plan: spec }, "mail");
	assert.equal(db.splitWork({ ...base, plan: spec }, "mail").replay, true);
	const ready = db.readyTasks("mail", db.getTask(final).goalId, true).map(task => task.id);
	assert.deepEqual(ready.sort(), [...first.split.taskIds].sort());
	const next = { ...base, expectedVersion: 2, splitId: "second", plan: { ...spec, producers: [{ ...producer, inputs: [{ taskId: first.split.taskIds[0], output: "contract" }] }], requires: [spec.requires[0]] } };
	db.splitWork(next, "mail");
	assert.equal(db.getTask(final).inputs.length, 3);
	assert.throws(() => db.evolveTask({ taskId: final, expectedVersion: 3, inputs: [] }, "mail"), { code: "protected_input" });
	assert.throws(() => db.evolveTask({ taskId: final, expectedVersion: 3, checks: [] }, "mail"), { code: "protected_check" });
});

test("priority-only revisions reorder unstarted work, changed scope cancels issued work without erasing evidence or admitting stale proposals", async t => {
	const { db, runtime, source, root, policy, binding, admit, observation } = await setup(t);
	const first = admit("mail", "route"), second = admit("mail", "label", { outcome: "labels" });
	assert.deepEqual(db.backlog("mail").squads[0].readyItems, [first, second]);
	const stale = observation("mail", "old");
	policy.direction.revision = 2; policy.direction.outcomes[0].priority = 3;
	writeFileSync(path.join(root, source), JSON.stringify(policy));
	await runtime.operation("revise_direction", { factoryId: policy.id, expectedRevision: 1, source }, "director");
	assert.deepEqual(db.backlog("mail").squads[0].readyItems, [second, first]);
	assert.throws(() => db.observeWork(stale, "mail"), { code: "stale_direction" });
	const { tasks } = db.pullWork({ ...binding("mail"), itemId: second }, "mail");
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
	assert.throws(() => db.pullWork({ ...binding("mail"), itemId: first }, "mail"), { code: "factory_paused" });
	const staleActivation = binding("mail");
	await runtime.operation("start_factory", { source }, "director");
	assert.throws(() => db.pullWork({ ...staleActivation, itemId: first }, "mail"), { code: "stale_activation" });
	assert.equal(db.pullWork({ ...binding("mail"), itemId: first }, "mail").item.currentRevision, 3);
});

test("bound peers can commit an existing scoped output, deliver it directly and keep the destination independently runnable", async t => {
	const { db, runtime, admit, binding } = await setup(t);
	const mail = admit("mail", "routing"), quality = admit("quality", "scenario");
	const source = db.backlog("mail").squads[0], destination = db.backlog("quality").squads[0];
	const consumer = text(db.pullWork({ ...binding("mail"), itemId: mail }, "mail").tasks?.[0].id, "product consumer");
	const target = db.pullWork({ ...binding("quality"), itemId: quality }, "quality");
	const part = db.splitWork({ ...binding("quality"), itemId: quality, expectedVersion: 1, splitId: "contract",
		plan: { specification: "Two isolated accounts", boundary: "Account router", examples: ["Open A"], negativeCases: ["Do not open B"],
			producers: [{ id: "scenario", template: "quality", title: "Two-account scenario", purpose: "Mail product input", output: "scenario", stop: "Fixture checked" }],
			requires: [{ taskId: "scenario", output: "scenario" }] } }, "quality").split.taskIds[0];
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
	assert.ok(db.readyTasks("quality", target.item.goalId, true).some(task => task.id === target.tasks?.[0].id));
});

test("a policy join requires both exact source items and the checked bytes from both published products", async t => {
	const { root, runtime, db, binding, admit, selectWorker } = await setup(t, true);
	const mail = admit("mail", "folder-store"), quality = admit("quality", "editor-routing");
	const sources = { "folder-store": mail, "editor-routing": quality };
	assert.throws(() => admit("design", "missing"), { code: "required_products" });
	assert.throws(() => admit("design", "wrong", { sources: { ...sources, "folder-store": quality } }), { code: "wrong_product_source" });
	const join = admit("design", "mismatched-bytes", { sources });
	assert.throws(() => db.pullWork({ ...binding("design"), itemId: join }, "design"), { code: "not_highest_ready" });
	/** @param {string} actor @param {string} itemId @param {string} publish */
	async function produce(actor, itemId, publish) {
		const { tasks } = db.pullWork({ ...binding(actor), itemId }, actor);
		const taskId = text(tasks?.[0].id, "product task");
		const call = record(await runtime.operation("dispatch", { taskIds: [taskId] }, actor));
		assert.ok(Array.isArray(call.prepared));
		const args = call.prepared[0].arguments, worker = `${itemId}-worker`;
		runtime.pre("create_session", args, actor, itemId);
		runtime.post("create_session", args, { id: worker }, actor);
		selectWorker(worker);
		const result = record(await runtime.operation("run_check", { taskId, checkId: "scenario", publish }, worker));
		assert.equal(result.promoted, true);
		return db.getTask(taskId);
	}
	const first = await produce("mail", mail, "folder-store");
	const second = await produce("quality", quality, "editor-routing");
	assert.deepEqual(db.backlog("design").squads[0].readyItems, [join]);
	writeFileSync(path.join(root, "mail/product.txt"), "unrelated bytes, same filename\n");
	await assert.rejects(produce("design", join, "product"), { code: "product_lineage_mismatch" });
	const incident = db.backlog("design").items.find(item => item.id === join);
	assert.equal(incident?.state, "pulled");
	assert.equal(db.snapshot().completions?.find(completion => completion.goalId === incident?.goalId)?.closed, false);
	const retry = admit("design", "correct-join", { sources });
	writeFileSync(path.join(root, "mail/product.txt"), "correct\n");
	const integrated = await produce("design", retry, "product");
	assert.deepEqual(integrated.inputs, [ { taskId: first.id, output: "folder-store", version: first.outputs[0].version },
		{ taskId: second.id, output: "editor-routing", version: second.outputs[0].version } ]);
	assert.equal(db.backlog("design").items.find(item => item.id === retry)?.state, "accepted");
});

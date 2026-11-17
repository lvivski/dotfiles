import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openWorkStore } from "./store.mjs";
import { FoundryError, decodeEvidence, digest, json } from "./values.mjs";
import { affinityId, nativeUsage } from "./usage.mjs";
import { openDatabase } from "./database.mjs";
import { createGoal, createTask } from "./tasks.mjs";
import { prepareAttempt, startLocalTask } from "./attempts.mjs";
import { claim as claimResource } from "./claims.mjs";

/** @typedef {ReturnType<typeof openWorkStore>} Store */
/** @typedef {import("./model.d.ts").Scope} Scope */
/** @typedef {import("./model.d.ts").Task} Task */
/** @typedef {import("./model.d.ts").Attempt} Attempt */
/** @typedef {import("./model.d.ts").Result} Result */
const here = path.dirname(fileURLToPath(import.meta.url));
/** @type {Scope} */
const scope = { mode: "autopilot", delegation: true, workTypes: ["code", "analysis"], paths: ["."], restrictions: ["no push"] };
/** @type {import("./model.d.ts").Check} */
const check = { id: "behavior", origin: "contract", requirement: "The command passes", kind: "command", command: "node --test", version: "oracle-v1" };

/** @param {import("node:test").TestContext} t @param {{clock?: () => Date}} [options] */
function fixture(t, options) {
	const root = path.join(here, `.store-test-${randomUUID()}`);
	mkdirSync(root);
	const repo = path.join(root, "repository");
	mkdirSync(repo);
	execFileSync("git", ["init", "--quiet", repo]);
	execFileSync("git", ["-C", repo, "-c", "user.name=Foundry tests", "-c", "user.email=foundry@example.invalid",
		"commit", "--quiet", "--allow-empty", "-m", "fixture"]);
	const store = openWorkStore(repo, options);
	t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
	return { root, repo, store };
}

/** @param {Store} store @param {string} [id] @param {string} [owner] @param {import("./model.d.ts").Limits} [limits] */
function goal(store, id = "goal", owner = "root", limits = {}) {
	return store.createGoal({ id, title: id, scope, limits }, owner);
}

/** @param {Store} store @param {string} id @param {Partial<Parameters<Store["createTask"]>[0]>} [extra] @param {string} [actor] */
function task(store, id, extra = {}, actor = "root") {
	return store.createTask({ id, goalId: "goal", title: id, assignment: `Perform ${id}`, workType: "code", ...extra }, actor);
}

/** @param {Store} store @param {Task} task @param {string} [actor] @param {string} [nativeId] */
function start(store, task, actor = "root", nativeId = `native:${task.id}`) {
	const attempt = store.prepareAttempt(task.id, actor);
	store.issueAttempt(attempt.id, actor, `create:${attempt.id}`, { task: task.id });
	return store.bindAttempt(attempt.id, nativeId, actor, { id: nativeId });
}

/** @param {Attempt} attempt @param {Partial<Omit<Result, "sender" | "createdAt">>} [extra] */
function outcome(attempt, extra = {}) {
	return {
		id: randomUUID(), attemptId: attempt.id, state: /** @type {const} */ ("done"), summary: "Completed",
		outputs: [{ name: "delivery", kind: /** @type {const} */ ("code"), reference: "commit:123", version: "v1" }],
		evidence: attempt.checks.map((assigned) => ({
			id: `evidence:${attempt.id}:${assigned.id}`, attemptId: attempt.id, checkId: assigned.id, checkVersion: assigned.version,
			outcome: /** @type {const} */ ("passed"), reference: "command:run-1", summary: "Passed",
			source: /** @type {const} */ ("runner-receipt"),
		})), findings: [], ...extra,
	};
}

/** @param {Store} store @param {Attempt} attempt @param {import("./model.d.ts").Evidence[]} [evidence] */
function admit(store, attempt, evidence = outcome(attempt).evidence) {
	for (const observation of evidence) {
		const id = `check:${randomUUID()}`;
		const request = { checkId: observation.checkId, checkVersion: observation.checkVersion };
		store.recordEffect({ id, attemptId: attempt.id, kind: "command", state: "prepared", request }, "root");
		store.recordEffect({ id, attemptId: attempt.id, kind: "command", state: "issued", request }, "root");
		store.recordEffect({ id, attemptId: attempt.id, kind: "command", state: "settled", request,
			result: json({ nativeResult: { exitCode: observation.outcome === "passed" ? 0 : 1 }, evidence: observation }) }, "root");
	}
}

/** @param {() => unknown} operation @param {string} code */
function fails(operation, code) {
	assert.throws(operation, (error) => error instanceof FoundryError && error.code === code);
}

test("one transaction spans task, attempt, claim and wake changes, including committed capacity denial", t => {
	const { repo, store } = fixture(t);
	const database = openDatabase(repo);
	/** @param {import("./database.mjs").Transaction} tx @param {string} id */
	function populate(tx, id) {
		createGoal(tx, { id, title: id, scope, limits: { workers: 1 } }, "root");
		const active = createTask(tx, { id: `${id}:active`, goalId: id, title: id, assignment: id, workType: "code" }, "root");
		const attempt = startLocalTask(tx, active.id, "root");
		assert.ok(!(attempt instanceof FoundryError));
		claimResource(tx, { attemptId: attempt.id, surface: repo, resource: "src/shared" }, "root");
		return createTask(tx, { id: `${id}:waiting`, goalId: id, title: id, assignment: id, workType: "code" }, "root");
	}
	try {
		const before = store.snapshot();
		fails(() => database.transaction(tx => {
			populate(tx, "rolled-back");
			throw new FoundryError("rollback", "Roll back every participating module");
		}), "rollback");
		assert.deepEqual(store.snapshot(), before);

		fails(() => database.transaction(tx => {
			const waiting = populate(tx, "committed");
			return prepareAttempt(tx, waiting.id, "root");
		}), "capacity_wait");
		const active = store.getTask("committed:active");
		assert.equal(active.state, "running");
		assert.ok(active.currentAttemptId);
		assert.equal(store.getAttempt(active.currentAttemptId).slot, true);
		assert.equal(store.snapshot().claims[0]?.attemptId, active.currentAttemptId);
		assert.equal(store.getTask("committed:waiting").state, "ready");
		assert.ok(store.pendingWakes("root").some(wake => wake.goalId === "committed" && wake.reason === "capacity"));
	} finally { database.close(); }
});

test("transaction callbacks reject nested and asynchronous work without retaining partial domain changes", t => {
	const { repo, store } = fixture(t);
	const database = openDatabase(repo);
	try {
		fails(() => database.transaction(tx => {
			createGoal(tx, { id: "nested", title: "Nested", scope }, "root");
			return database.transaction(() => undefined);
		}), "store_reentrant");
		fails(() => database.transaction(tx => {
			createGoal(tx, { id: "async", title: "Async", scope }, "root");
			return Promise.resolve("not synchronous");
		}), "async_transaction");
		assert.deepEqual(store.snapshot().goals, []);
		assert.equal(database.transaction(tx => tx.list("goals").length, false), 0);
	} finally { database.close(); }
	fails(() => database.transaction(() => undefined), "store_closed");
});

test("recursive organizational units retain task ancestry and never grant authority through metadata", t => {
	const { store } = fixture(t);
	goal(store);
	const organization = store.createUnit({ goalId: "goal", name: "Product", kind: "organization" }, "root");
	const directorTask = task(store, "director", { role: "coordinator", unitId: organization.id });
	const queued = task(store, "already-queued", { parentId: directorTask.id });
	const director = start(store, directorTask);
	assert.equal(store.getTask(queued.id).owner, director.nativeId);
	const team = store.createUnit({ goalId: "goal", parentId: organization.id, taskId: directorTask.id, name: "Mail" }, "native:director");
	const lead = start(store, task(store, "mail-lead", { parentId: directorTask.id, unitId: team.id, role: "coordinator" }, "native:director"), "native:director");
	const subteam = store.createUnit({ goalId: "goal", parentId: team.id, taskId: lead.taskId, name: "Authentication" }, "native:mail-lead");
	const sublead = start(store, task(store, "auth-lead", { parentId: lead.taskId, unitId: subteam.id, role: "coordinator" }, "native:mail-lead"), "native:mail-lead");
	const worker = task(store, "auth-worker", { parentId: sublead.taskId, unitId: subteam.id }, "native:auth-lead");
	assert.equal(store.snapshot().units.find(unit => unit.id === subteam.id)?.coordinatorTaskId, sublead.taskId);
	assert.equal(worker.parentId, sublead.taskId);
	fails(() => store.createUnit({ goalId: "goal", name: "Unauthorized root" }, "native:auth-lead"), "forbidden");
	fails(() => task(store, "escape", { unitId: organization.id }, "native:auth-lead"), "forbidden");
	fails(() => task(store, "wrong-boundary", { parentId: directorTask.id, unitId: subteam.id }, "native:director"), "forbidden");
	fails(() => task(store, "duplicate-role", { parentId: lead.taskId, unitId: subteam.id, role: "coordinator" }, "native:mail-lead"), "coordinator_conflict");
	fails(() => store.evolveTask({ taskId: sublead.taskId, expectedVersion: 1, checks: [check] }, "native:auth-lead"), "protected_check");
});

test("one-slot coordinators yield without ending their role, and later production reuses the same attempt", t => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const lead = start(store, task(store, "lead", { role: "coordinator" }));
	const observed = store.getTask(lead.taskId).coordination?.generation;
	store.waitTask(lead.taskId, "native:lead", { kind: "events", reason: "Ready to staff workers" },
		{ attemptId: lead.id, handledGeneration: observed, relatedIds: [] });
	assert.equal(store.getAttempt(lead.id).slot, false);
	fails(() => store.assertCommandAdmission("native:lead"), "capacity_required");
	const producer = start(store, task(store, "first", { parentId: lead.taskId }, "native:lead"), "native:lead");
	store.recordResult(outcome(producer), "native:first");
	assert.equal(store.getTask(lead.taskId).state, "waiting");
	assert.ok((store.getTask(lead.taskId).coordination?.generation ?? 0) > (observed ?? 0));
	const wake = store.pendingWakes("native:lead")[0];
	store.consumeWake(wake.id, wake.generation, "native:lead");
	assert.equal(store.getTask(lead.taskId).coordination?.handled, observed);
	const next = task(store, "second", { parentId: lead.taskId }, "native:lead");
	assert.equal(next.parentId, lead.taskId);
	assert.equal(store.getTask(lead.taskId).currentAttemptId, lead.id);
	assert.equal(store.snapshot().attempts.filter(attempt => attempt.taskId === lead.taskId).length, 1);
	const affinity = store.captureUsageAffinity(affinityId("native:lead"), "native:lead", undefined,
		{ id: "first-waking-request", timestamp: "2030-01-01T00:00:00Z" });
	assert.deepEqual(affinity.attemptIds, [lead.id]);
	fails(() => store.waitTask(lead.taskId, "native:lead", { kind: "events", reason: "Unseen work" },
		{ attemptId: lead.id, handledGeneration: 999 }), "stale_generation");
});

test("peer organization discovery reveals accountable identities without peer backlog or mutation rights", t => {
	const { store } = fixture(t);
	goal(store);
	const mail = store.createUnit({ goalId: "goal", name: "Mail organization" }, "root");
	const platform = store.createUnit({ goalId: "goal", name: "Platform organization", context: ["Private platform charter"] }, "root");
	const source = start(store, task(store, "mail", { role: "coordinator", unitId: mail.id }));
	const peer = start(store, task(store, "platform", { role: "coordinator", unitId: platform.id }));
	const directory = store.unitDirectory("native:mail", ["goal"]);
	assert.equal(directory.units.find(unit => unit.id === platform.id)?.coordinatorTaskId, peer.taskId);
	assert.equal(directory.units.find(unit => unit.id === platform.id)?.coordinator, peer.nativeId);
	assert.equal(Object.hasOwn(directory.units.find(unit => unit.id === platform.id) ?? {}, "context"), false);
	assert.equal(store.contextSnapshot("native:mail", "goal").tasks.some(task => task.id === peer.taskId), false);
	fails(() => store.cancelTask(peer.taskId, source.nativeId ?? ""), "forbidden");
	for (let index = 0; index < 99; index++) store.createUnit({ goalId: "goal", name: `Additional unit ${index}` }, "root");
	const first = store.unitDirectory("native:mail", ["goal"]);
	assert.equal(first.units.length, 100);
	assert.equal(first.nextOffset, 100);
	const last = store.unitDirectory("native:mail", ["goal"], first.nextOffset);
	assert.equal(last.units.length, 1);
	assert.equal(last.nextOffset, undefined);
	assert.equal(new Set([...first.units, ...last.units].map(unit => unit.id)).size, 101);
	goal(store, "unassigned", "another-owner");
	fails(() => store.unitDirectory("native:mail", ["unassigned"]), "foreign_goal");
});

test("natural stop retains undisposed coordination, releases settled capacity and escalates only once", t => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const lead = start(store, task(store, "lead", { role: "coordinator" }));
	const command = { id: "real-command", attemptId: lead.id, kind: /** @type {const} */ ("command"),
		request: { command: "bounded work" } };
	store.recordEffect({ ...command, state: "issued" }, "native:lead");
	assert.equal(store.parkCoordinators("native:lead").length, 0);
	assert.equal(store.getAttempt(lead.id).slot, true);
	store.recordEffect({ ...command, state: "settled", result: { exitCode: 0 } }, "native:lead");
	assert.equal(store.parkCoordinators("native:lead").length, 1);
	const generation = store.pendingWakes("root")[0].generation;
	store.parkCoordinators("native:lead");
	assert.equal(store.pendingWakes("root")[0].generation, generation);
	assert.equal(store.getAttempt(lead.id).slot, false);
	assert.equal(store.getTask(lead.taskId).coordination?.handled, 0);
});

test("new coordinator work rearms an acknowledged wake without replaying an uncertain native send", t => {
	const { store } = fixture(t);
	goal(store);
	const lead = start(store, task(store, "lead", { role: "coordinator" }));
	store.waitTask(lead.taskId, "native:lead", { kind: "events", reason: "Waiting for work" }, { attemptId: lead.id });
	const first = store.recordSignal({ goalId: "goal", taskId: lead.taskId, kind: "production", summary: "First", references: ["first"] }, "root");
	const notification = store.pendingWakes("native:lead")[0];
	store.markWakeSent(notification.id, notification.generation, "root");
	store.recordSignal({ goalId: "goal", taskId: lead.taskId, kind: "production", summary: "Second", references: ["second"] }, "root");
	const newer = store.pendingWakes("native:lead")[0];
	assert.ok(newer.generation > notification.generation);
	assert.ok(store.outgoingWakes("root").some(wake => wake.id === newer.id));
	const delivery = store.claimWakeDelivery(newer.id, newer.generation, undefined, { session_id: "native:lead" }, "root");
	assert.ok(delivery);
	store.recordSignal({ goalId: "goal", taskId: lead.taskId, kind: "production", summary: "Third", references: ["third"] }, "root");
	assert.equal(store.wakeCanSend(newer.id), false);
	assert.equal(store.claimWakeDelivery(newer.id, store.pendingWakes("native:lead")[0].generation, undefined, {}, "root"), undefined);
	assert.ok(store.getTask(lead.taskId).coordination?.causes.includes(`signal:${first.id}`));
});

/** @param {import("node:test").TestContext} t */
function collaboratingOrganizations(t) {
	const fixtureState = fixture(t);
	const { store } = fixtureState;
	goal(store);
	goal(store, "peer-goal", "peer-root");
	const source = start(store, task(store, "source", { role: "coordinator" }));
	const destination = start(store, task(store, "destination", { goalId: "peer-goal", role: "coordinator" }, "peer-root"), "peer-root");
	const consumer = task(store, "consumer", { parentId: source.taskId }, "native:source");
	const request = store.requestCollaboration({ id: "interface-request", sourceTaskId: source.taskId,
		destinationTaskId: destination.taskId, consumerTaskId: consumer.id, expectedVersion: consumer.version,
		title: "A usable interface", output: "interface" }, "native:source");
	return { ...fixtureState, source, destination, consumer, request };
}

test("cross-goal collaboration atomically staffs destination work and pins actual delivery without sharing authority", t => {
	const { store, source, destination, consumer, request } = collaboratingOrganizations(t);
	fails(() => store.prepareAttempt(consumer.id, "native:source"), "inputs_unavailable");
	const acceptance = { collaborationId: request.id, expectedRevision: request.revision, action: /** @type {const} */ ("accept"),
		producer: { title: "Interface", assignment: "Produce the requested interface", workType: "analysis" } };
	fails(() => store.respondCollaboration(acceptance, "native:source"), "forbidden");
	const accepted = store.respondCollaboration(acceptance, "native:destination");
	assert.equal(store.respondCollaboration(acceptance, "native:destination").producerTaskId, accepted.producerTaskId);
	const producer = store.getTask(accepted.producerTaskId ?? "");
	assert.equal(producer.parentId, destination.taskId);
	fails(() => store.cancelTask(consumer.id, "native:destination"), "forbidden");
	const attempt = start(store, producer, "native:destination", "native:interface");
	store.recordResult(outcome(attempt, { outputs: [{ name: "interface", kind: "analysis", reference: "artifact:interface", version: "interface-v1" }] }), "native:interface");
	const fulfilled = store.respondCollaboration({ collaborationId: request.id, expectedRevision: accepted.revision, action: "fulfill" }, "native:destination");
	assert.equal(fulfilled.bound, true);
	assert.deepEqual(store.getTask(consumer.id).inputs, [{ taskId: producer.id, output: "interface", version: "interface-v1" }]);
	store.cancelTask(producer.id, "peer-root");
	const consumption = start(store, store.getTask(consumer.id), "native:source", "native:consumer");
	assert.equal(consumption.inputs[0].version, "interface-v1");
	assert.equal(store.recordResult(outcome(consumption), "native:consumer").promoted, true);
	assert.equal(store.getTask(source.taskId).currentAttemptId, source.id);
});

test("changed consumers retain delivered collaboration bytes but need explicit source rebinding", t => {
	const { store, consumer, request } = collaboratingOrganizations(t);
	const accepted = store.respondCollaboration({ collaborationId: request.id, expectedRevision: 1, action: "accept",
		producer: { title: "Interface", assignment: "Produce the interface", workType: "analysis" } }, "native:destination");
	const producer = start(store, store.getTask(accepted.producerTaskId ?? ""), "native:destination");
	store.evolveTask({ taskId: consumer.id, expectedVersion: store.getTask(consumer.id).version,
		checks: [{ ...check, origin: "derived" }] }, "native:source");
	store.respondCollaboration({ collaborationId: request.id, expectedRevision: 2, action: "block", reason: "Source definition changed" }, "native:destination");
	store.recordResult(outcome(producer, { outputs: [{ name: "interface", kind: "analysis", reference: "artifact:interface", version: "v1" }] }), producer.nativeId ?? "");
	const fulfilled = store.respondCollaboration({ collaborationId: request.id, expectedRevision: 3, action: "fulfill" }, "native:destination");
	assert.equal(fulfilled.bound, false);
	fails(() => store.prepareAttempt(consumer.id, "native:source"), "inputs_unavailable");
	const bound = store.respondCollaboration({ collaborationId: request.id, expectedRevision: 4, action: "bind" }, "native:source");
	assert.equal(bound.bound, true);
	assert.equal(store.prepareAttempt(consumer.id, "native:source").inputs[0].version, "v1");
});

test("decline and cancellation never satisfy required requests, while explicit release preserves original inputs", t => {
	const { store, consumer, request } = collaboratingOrganizations(t);
	const original = start(store, task(store, "original-input", { parentId: "source" }, "native:source"), "native:source");
	store.recordResult(outcome(original), original.nativeId ?? "");
	const inputs = [{ taskId: original.taskId, output: "delivery" }];
	store.evolveTask({ taskId: consumer.id, expectedVersion: store.getTask(consumer.id).version, inputs }, "native:source");
	const declined = store.respondCollaboration({ collaborationId: request.id, expectedRevision: 1, action: "decline", reason: "No available service" }, "native:destination");
	fails(() => store.prepareAttempt(consumer.id, "native:source"), "inputs_unavailable");
	fails(() => store.respondCollaboration({ collaborationId: request.id, expectedRevision: declined.revision, action: "release", reason: "Drop consumer requirements" }, "native:destination"), "forbidden");
	store.respondCollaboration({ collaborationId: request.id, expectedRevision: declined.revision, action: "release", reason: "Source no longer requires this derived interface" }, "native:source");
	assert.deepEqual(store.getTask(consumer.id).inputs, inputs);
	assert.equal(store.prepareAttempt(consumer.id, "native:source").taskId, consumer.id);
	const another = task(store, "another-consumer", { parentId: "source" }, "native:source");
	const cancelled = store.requestCollaboration({ sourceTaskId: "source", destinationTaskId: "destination", consumerTaskId: another.id,
		expectedVersion: 1, title: "Cancelled requirement", output: "cancelled-output" }, "native:source");
	store.respondCollaboration({ collaborationId: cancelled.id, expectedRevision: 1, action: "cancel", reason: "Service is unavailable" }, "native:source");
	fails(() => store.prepareAttempt(another.id, "native:source"), "inputs_unavailable");
});

test("parallel collaboration grants preserve each other and each new revision remains unhandled work", t => {
	const { store, consumer, request } = collaboratingOrganizations(t);
	const second = store.requestCollaboration({ id: "another-interface", sourceTaskId: "source", destinationTaskId: "destination",
		consumerTaskId: consumer.id, expectedVersion: store.getTask(consumer.id).version, title: "Another interface", output: "interface" }, "native:source");
	const observed = store.getTask("source").coordination?.generation ?? 0;
	for (const item of [request, second]) {
		const accepted = store.respondCollaboration({ collaborationId: item.id, expectedRevision: 1, action: "accept",
			producer: { title: item.title, assignment: item.title, workType: "analysis" } }, "native:destination");
		assert.ok((store.getTask("source").coordination?.generation ?? 0) > observed);
		const producer = start(store, store.getTask(accepted.producerTaskId ?? ""), "native:destination");
		store.recordResult(outcome(producer, { outputs: [{ name: "interface", kind: "analysis", reference: `artifact:${item.id}`, version: item.id }] }), producer.nativeId ?? "");
		const fulfilled = store.respondCollaboration({ collaborationId: item.id, expectedRevision: 2, action: "fulfill" }, "native:destination");
		assert.equal(fulfilled.bound, true);
	}
	assert.equal(store.getTask(consumer.id).inputs.length, 2);
	assert.equal(store.prepareAttempt(consumer.id, "native:source").inputs.length, 2);
});

test("cross-goal wake entitlement is tied to actual requests, not shared source-goal membership", t => {
	const { store, request } = collaboratingOrganizations(t);
	const peerWake = store.outgoingWakes("native:source").find(wake => wake.goalId === request.destinationGoalId);
	assert.ok(peerWake);
	start(store, task(store, "unrelated-specialist"));
	assert.equal(store.outgoingWakes("native:unrelated-specialist").some(wake => wake.id === peerWake.id), false);
	fails(() => store.claimWakeDelivery(peerWake.id, peerWake.generation, undefined, {}, "native:unrelated-specialist"), "foreign_wake");
	assert.ok(store.claimWakeDelivery(peerWake.id, peerWake.generation, undefined, { session_id: peerWake.owner }, "native:source"));
});

test("foreign collaboration relays project only entitled reasons without swallowing newer generations", t => {
	const { store, request } = collaboratingOrganizations(t);
	const signal = store.recordSignal({ goalId: "peer-goal", taskId: "destination", kind: "production",
		summary: "Private peer backlog", references: ["peer-only"] }, "peer-root");
	const pending = store.pendingWakes("native:destination")[0];
	assert.equal(pending.reason, `signal:${signal.id}`);
	const projected = store.outgoingWakes("native:source").find(wake => wake.id === pending.id);
	assert.ok(projected);
	assert.equal(projected.reason, `collaboration:${request.id}`);
	assert.deepEqual(projected.relatedReasons, [`collaboration:${request.id}`]);
	assert.equal(projected.generation, pending.generation);
	const delivery = store.claimWakeDelivery(projected.id, projected.generation, undefined, {}, "native:source");
	assert.ok(delivery);
	store.respondCollaboration({ collaborationId: request.id, expectedRevision: request.revision, action: "accept",
		producer: { title: "Interface", assignment: "Publish the interface", workType: "analysis" } }, "native:destination");
	store.settleWakeDelivery(projected.id, delivery.id, projected.generation, {}, true, "native:source");
	const newer = store.outgoingWakes("native:source").find(wake => wake.id === pending.id);
	assert.ok(newer && newer.generation > projected.generation);
	assert.equal(store.getTask("destination").coordination?.handled, 0);
	assert.ok(store.pendingWakes("native:destination")[0].relatedReasons?.includes(`signal:${signal.id}`));
});

test("collaboration detects actual dependency cycles and rolls back staffing without rejecting peer organizations", t => {
	const { store, consumer, request } = collaboratingOrganizations(t);
	const before = store.snapshot().tasks.length;
	fails(() => store.respondCollaboration({ collaborationId: request.id, expectedRevision: 1, action: "accept",
		producer: { title: "Cycle", assignment: "Needs its own consumer", workType: "analysis", inputs: [{ taskId: consumer.id, output: "delivery" }] } }, "native:destination"), "dependency_cycle");
	assert.equal(store.snapshot().tasks.length, before);
	assert.equal(store.snapshot().collaborations[0].state, "proposed");
});

test("settled execution handoff preserves history and repairs while rejecting dirty, claimed and stale attempts", t => {
	const { store, repo } = fixture(t);
	goal(store);
	const producer = task(store, "relocatable");
	const original = store.startLocalTask(producer.id, "root");
	writeFileSync(path.join(repo, "untracked-work.txt"), "Do not lose this");
	fails(() => store.handoffTask(producer.id, original.id, "replacement", "root"), "implementation_transfer_required");
	rmSync(path.join(repo, "untracked-work.txt"));
	const claim = store.claim({ attemptId: original.id, surface: repo, resource: "work.txt" }, "root");
	fails(() => store.handoffTask(producer.id, original.id, "replacement", "root"), "settlement_required");
	store.releaseClaim(claim.id, "root");
	const handed = store.handoffTask(producer.id, original.id, "replacement", "root");
	assert.equal(handed.version, 1);
	assert.equal(handed.repairs, producer.repairs);
	const successor = start(store, handed, "replacement", "native:replacement");
	assert.equal(successor.repairOf, undefined);
	assert.equal(successor.startCommit, original.baseCommit);
	assert.equal(store.recordResult(outcome(original), "root").promoted, false);
	assert.equal(store.handoffTask(producer.id, original.id, "replacement", "root").currentAttemptId, successor.id);
	fails(() => store.handoffTask(producer.id, original.id, "another", "root"), "stale_attempt");
});

test("coordinator replacement retains native descendant ancestry and only transfers the outgoing owner's pending work", t => {
	const { store } = fixture(t);
	goal(store);
	const lead = start(store, task(store, "lead", { role: "coordinator" }));
	store.captureUsageAffinity(affinityId("native:lead"), "native:lead");
	const leaf = start(store, task(store, "delegated", { parentId: lead.taskId }, "native:lead"), "native:lead");
	const pending = task(store, "pending", { parentId: lead.taskId }, "native:lead");
	fails(() => store.reassignTask(lead.taskId, "replacement", "root"), "execution_handoff_required");
	store.handoffTask(lead.taskId, lead.id, "replacement", "root", true);
	assert.equal(store.getTask(pending.id).owner, "replacement");
	assert.equal(store.getTask(leaf.taskId).owner, "native:delegated");
	assert.equal(store.getAttempt(leaf.id).creator, "native:lead");
	assert.equal(store.getTask(leaf.taskId).parentId, lead.taskId);
	const replacement = start(store, store.getTask(lead.taskId), "replacement", "native:new-lead");
	assert.equal(store.getTask(pending.id).owner, replacement.nativeId);
	assert.equal(store.getAttempt(leaf.id).creator, "native:lead");
	assert.equal(store.getTask(lead.taskId).repairs ?? 0, 0);
});

test("handoff inspects repository-relative scope even when execution starts in a subdirectory", t => {
	const { store, repo } = fixture(t);
	goal(store);
	const producer = task(store, "nested-execution", { scope: { paths: ["work.txt"] } });
	const directory = path.join(repo, "nested");
	mkdirSync(directory);
	const nested = openWorkStore(directory);
	try {
		const attempt = nested.startLocalTask(producer.id, "root");
		writeFileSync(path.join(repo, "work.txt"), "Uncommitted implementation outside the execution subdirectory");
		fails(() => nested.handoffTask(producer.id, attempt.id, "replacement", "root"), "implementation_transfer_required");
		assert.equal(store.getTask(producer.id).state, "running");
	} finally { nested.close(); }
});

test("retired native-command evidence is rejected rather than coerced into a current runner receipt", () => {
	fails(() => decodeEvidence({ id: "old-evidence", attemptId: "attempt", checkId: "behavior", checkVersion: "oracle",
		outcome: "passed", reference: "old-command", summary: "Old check", source: "native-command" }), "invalid_field");
});

test("self-ended claims release after settlement but ancestor completion preserves the actual worker's ownership", t => {
	const { store } = fixture(t);
	goal(store);
	const own = start(store, task(store, "own"));
	assert.ok(own.nativeId);
	const owned = store.claim({ attemptId: own.id, surface: "integration", resource: "own.mjs" }, own.nativeId);
	store.recordResult(outcome(own), own.nativeId);
	assert.equal(store.snapshot().claims.length, 0);
	fails(() => store.releaseClaim(owned.id, "root"), "not_found");
	const child = start(store, task(store, "child"));
	assert.ok(child.nativeId);
	const retained = store.claim({ attemptId: child.id, surface: "integration", resource: "child.mjs" }, child.nativeId);
	store.recordResult(outcome(child), "root", child.nativeId);
	assert.deepEqual(store.snapshot().claims.map(claim => claim.id), [retained.id]);
	const peer = start(store, task(store, "peer"));
	assert.ok(peer.nativeId);
	const peerId = peer.nativeId;
	fails(() => store.claim({ attemptId: peer.id, surface: "integration", resource: "child.mjs" }, peerId), "claim_conflict");
	store.releaseClaim(retained.id, child.nativeId);
});

test("warm same-worker repair transfers claims atomically with fresh IDs and later self-completion releases them", t => {
	const { store } = fixture(t);
	goal(store);
	const original = start(store, task(store, "repair", { checks: [check] }));
	assert.ok(original.nativeId);
	const claim = store.claim({ attemptId: original.id, surface: "integration", resource: "unit.mjs" }, original.nativeId);
	const failed = outcome(original, { state: "failed", outputs: [], evidence: outcome(original).evidence.map(item => ({ ...item, outcome: "failed" })) });
	admit(store, original, failed.evidence);
	const repair = store.recordResultAndRepair(failed, original.nativeId);
	assert.ok("attempt" in repair.continuation && repair.continuation.attempt);
	const next = repair.continuation.attempt;
	assert.ok(next.nativeId);
	assert.equal(next.nativeId, original.nativeId);
	const retained = store.snapshot().claims[0];
	assert.equal(retained.attemptId, next.id);
	assert.notEqual(retained.id, claim.id);
	fails(() => store.releaseClaim(claim.id, "root"), "not_found");
	assert.equal(store.snapshot().claims[0].id, retained.id);
	admit(store, next);
	store.recordResult(outcome(next), next.nativeId);
	assert.equal(store.snapshot().claims.length, 0);
});

test("dependency revisions stop at producers without output and preserve explicit pinned consumers", t => {
	const { store } = fixture(t);
	goal(store);
	const producer = task(store, "producer");
	const consumer = task(store, "consumer", { inputs: [{ taskId: producer.id, output: "delivery" }] });
	const downstream = task(store, "downstream", { inputs: [{ taskId: consumer.id, output: "delivery" }] });
	store.evolveTask({ taskId: producer.id, expectedVersion: 1, checks: [{ ...check, origin: "derived" }] }, "root");
	assert.equal(store.getTask(producer.id).version, 2);
	assert.equal(store.getTask(consumer.id).version, 1);
	assert.equal(store.getTask(downstream.id).version, 1);
	const attempt = start(store, store.getTask(producer.id));
	assert.ok(attempt.nativeId);
	admit(store, attempt);
	store.recordResult(outcome(attempt), attempt.nativeId);
	const pinned = task(store, "pinned", { inputs: [{ taskId: producer.id, output: "delivery", version: "v1" }] });
	store.evolveTask({ taskId: producer.id, expectedVersion: 2,
		checks: [{ ...check, origin: "derived" }, { ...check, id: "additional", origin: "derived" }] }, "root");
	assert.equal(store.getTask(consumer.id).version, 2);
	assert.equal(store.getTask(downstream.id).version, 1);
	assert.equal(store.getTask(pinned.id).version, 1);
	assert.equal(store.outputForInput(pinned.inputs[0])?.version, "v1");
});

test("early native charges wait for actual binding and deduplicate manual and native receipt aliases", t => {
	const { store } = fixture(t);
	goal(store);
	const attempt = store.prepareAttempt(task(store, "worker").id, "root");
	const affinity = store.captureUsageAffinity(affinityId("native:worker"), "native:worker", attempt.token);
	const event = (/** @type {number} */ sequence, /** @type {number} */ credits, /** @type {string} */ id) => ({
		type: "assistant.usage", id, data: { accounting: { sourceSessionId: "native:worker", sequence, usageId: `call-${sequence}` },
			copilotUsage: { totalNanoAiu: credits * 1_000_000_000 }, aiCreditsStatus: "complete" },
	});
	const pending = store.recordNativeUsage(nativeUsage(event(1, 1, "early-charge"), "native:worker", affinity), "native:worker");
	assert.ok(pending);
	assert.equal(pending.goalId, undefined);
	assert.equal(store.getGoal("goal").credits, 0);
	const stranger = store.captureUsageAffinity(affinityId("stranger"), "stranger", attempt.token);
	const foreign = store.recordNativeUsage(nativeUsage({ ...event(1, 9, "foreign-charge"),
		data: { ...event(1, 9, "foreign-charge").data, accounting: { sourceSessionId: "stranger", sequence: 1, usageId: "foreign" } },
	}, "stranger", stranger), "stranger");
	assert.ok(foreign);
	assert.equal(foreign.goalId, undefined);
	store.issueAttempt(attempt.id, "root", `create:${attempt.id}`, {});
	store.bindAttempt(attempt.id, "native:worker", "root", { id: "native:worker" });
	assert.equal(store.getGoal("goal").credits, 1);
	assert.equal(store.recordUsage(attempt.id, 2, "manual-first", "root").credits, 3);
	const billed = store.recordNativeUsage(nativeUsage(event(2, 2, "manual-first"), "native:worker", affinity), "native:worker");
	assert.ok(billed);
	assert.equal(billed.debitedCredits, 2);
	assert.equal(billed.attemptId, attempt.id);
	store.recordNativeUsage(nativeUsage(event(2, 2, "native-redelivery"), "native:worker", affinity), "native:worker");
	assert.equal(store.recordUsage(attempt.id, 2, "native-redelivery", "root").credits, 3);
	fails(() => store.recordUsage(attempt.id, 3, "native-redelivery", "root"), "usage_identity_conflict");
	assert.equal(store.getGoal("goal").credits, 3);
});

test("same-worker checked repair preserves replacement ownership and retains failure at a spend limit", t => {
	for (const exhausted of [false, true]) {
		const { store } = fixture(t);
		goal(store, "goal", "root", { credits: 1 });
		const attempt = start(store, task(store, "worker", { checks: [check] }));
		store.reassignTask(attempt.taskId, "replacement", "root");
		const evidence = outcome(attempt).evidence.map(item => ({ ...item, outcome: /** @type {const} */ ("failed") }));
		admit(store, attempt, evidence);
		if (exhausted) store.recordUsage(attempt.id, 1, "actual-charge", "root");
		const repaired = store.recordResultAndRepair(outcome(attempt, { state: "failed", evidence, outputs: [] }), "native:worker");
		assert.equal(repaired.promoted, true);
		assert.equal(store.getTask(attempt.taskId).owner, "replacement");
		if (exhausted) {
			assert.equal("code" in repaired.continuation && repaired.continuation.code, "limit_exhausted");
			assert.equal(store.getTask(attempt.taskId).state, "failed");
			assert.equal(store.snapshot().attempts.length, 1);
		} else {
			assert.ok("attempt" in repaired.continuation);
			const fresh = repaired.continuation.attempt;
			assert.ok(fresh);
			assert.equal(fresh.nativeId, "native:worker");
			assert.equal(fresh.assignedOwner, "replacement");
			fails(() => task(store, "unauthorized-child", { parentId: attempt.taskId }, "native:worker"), "forbidden");
		}
	}
});

test("evolution and a prepared handoff do not spend repair allowance", t => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { repairs: 1 });
	const initial = start(store, task(store, "evolving", { checks: [{ ...check, origin: "derived" }] }));
	store.evolveTask({ taskId: initial.taskId, expectedVersion: 1, checks: [{ ...check, origin: "derived", version: "oracle-v2" }] }, "root");
	const superseded = store.prepareAttempt(initial.taskId, "root");
	store.reassignTask(initial.taskId, "replacement", "root");
	assert.equal(store.getAttempt(superseded.id).state, "cancelled");
	const attempt = store.startLocalTask(initial.taskId, "replacement");
	const evidence = outcome(attempt).evidence.map(item => ({ ...item, outcome: /** @type {const} */ ("failed") }));
	admit(store, attempt, evidence);
	const result = store.recordResultAndRepair(outcome(attempt, { state: "failed", evidence, outputs: [] }), "replacement");
	assert.equal(result.promoted, true);
	assert.equal(result.continuation.state, "running");
	assert.equal(store.getTask(attempt.taskId).repairs, 1);
	assert.ok("attempt" in result.continuation && result.continuation.attempt);
	const fresh = result.continuation.attempt;
	const nextEvidence = outcome(fresh).evidence.map(item => ({ ...item, outcome: /** @type {const} */ ("failed") }));
	admit(store, fresh, nextEvidence);
	const exhausted = store.recordResultAndRepair(outcome(fresh, { state: "failed", evidence: nextEvidence, outputs: [] }), "replacement");
	assert.equal("code" in exhausted.continuation && exhausted.continuation.code, "repair_limit");
	assert.equal(store.getTask(attempt.taskId).repairs, 1);
});

test("pure notifications coalesce unconsumed generations and carry the latest actual reason", t => {
	const { store } = fixture(t);
	goal(store);
	const worker = start(store, task(store, "reporter"));
	store.recordResult(outcome(worker), "native:reporter");
	const wake = store.pendingWakes("root")[0];
	const sent = store.claimWakeDelivery(wake.id, wake.generation, undefined, { session_id: "root" }, "native:reporter");
	assert.ok(sent);
	store.settleWakeDelivery(wake.id, sent.id, wake.generation, { resultType: "success" }, true, "native:reporter");
	const signal = store.recordSignal({ goalId: "goal", kind: "performance", summary: "A material new observation", references: ["observation:1"] }, "native:reporter");
	const newer = store.pendingWakes("root")[0];
	assert.equal(newer.reason, `signal:${signal.id}`);
	assert.equal(store.claimWakeDelivery(newer.id, newer.generation, undefined, { session_id: "root" }, "native:reporter"), undefined);
	store.consumeWake(wake.id, wake.generation, "root");
	const after = store.pendingWakes("root")[0];
	assert.equal(after.generation, newer.generation);
	assert.ok(store.claimWakeDelivery(after.id, after.generation, undefined, { session_id: "root" }, "native:reporter"));
});

test("explicit cancellation, evolution and reassignment clear parked repairs without stale replay reopening them", t => {
	for (const action of ["cancel", "evolve", "reassign"]) {
		const { store } = fixture(t);
		goal(store, "goal", "root", { workers: 1 });
		const old = start(store, task(store, "parked", { checks: [{ ...check, origin: "derived" }] }));
		const failed = outcome(old, { state: "failed", outputs: [],
			evidence: outcome(old).evidence.map(item => ({ ...item, outcome: /** @type {const} */ ("failed") })) });
		admit(store, old, failed.evidence);
		store.recordResult(failed, "native:parked");
		store.startLocalTask(task(store, "contender").id, "root");
		const parked = store.recordResultAndRepair(failed, "native:parked");
		assert.equal("code" in parked.continuation && parked.continuation.code, "capacity_wait");
		assert.ok(store.getTask(old.taskId).repairReservation);
		if (action === "cancel") store.cancelTask(old.taskId, "root");
		else if (action === "evolve") store.evolveTask({ taskId: old.taskId, expectedVersion: 2,
			checks: [{ ...check, origin: "derived", version: "changed-oracle" }] }, "root");
		else store.reassignTask(old.taskId, "replacement", "root");
		assert.equal(store.getTask(old.taskId).repairReservation, undefined);
		const replay = store.recordResultAndRepair(failed, "native:parked");
		assert.equal(replay.continuation.state, "not-repaired");
		assert.equal(store.getTask(old.taskId).repairReservation, undefined);
		assert.equal(store.snapshot().attempts.filter(attempt => attempt.taskId === old.taskId).length, 1);
	}
});

test("unit metadata cannot transfer task authority or redirect coordinator feedback", t => {
	const { store } = fixture(t);
	goal(store);
	const unit = store.createUnit({ goalId: "goal", name: "Capability research", context: ["Keep the reproducible fixture"] }, "root");
	const coordinator = task(store, "coordinator", { unitId: unit.id, role: "coordinator" });
	const coordinatorAttempt = start(store, coordinator);
	const leaf = start(store, task(store, "delegated", { parentId: coordinator.id, unitId: unit.id }, "native:coordinator"), "native:coordinator");
	const signal = store.recordSignal({ goalId: "goal", unitId: unit.id, kind: "analysis", summary: "Disproved hypothesis",
		references: ["fixture:negative"] }, "root");
	const transferred = store.reassignUnit(unit.id, "replacement", "root");
	assert.deepEqual(transferred.context, unit.context);
	assert.equal(store.getTask(coordinator.id).owner, "native:coordinator");
	assert.equal(store.getTask(leaf.taskId).owner, leaf.nativeId);
	assert.equal(store.getAttempt(coordinatorAttempt.id).creator, "root");
	assert.equal(store.getAttempt(coordinatorAttempt.id).assignedOwner, undefined);
	assert.ok(store.pendingWakes("native:coordinator").some(wake => wake.relatedReasons?.includes(`signal:${signal.id}`)));
	assert.equal(store.getTask(leaf.taskId).version, 1);
	fails(() => store.reassignUnit(unit.id, "adopted", leaf.nativeId ?? ""), "forbidden");
});

test("a larger delegated queue preserves resource ownership, coalesced wakes and capped resumption across restart", t => {
	const { store, repo } = fixture(t);
	goal(store, "goal", "root", { workers: 2 });
	const parent = start(store, task(store, "queue-parent"));
	const peer = start(store, task(store, "queue-peer"));
	let previous = parent.taskId;
	for (let index = 0; index < 100; index++) {
		previous = task(store, `nested-${index}`, { parentId: previous }, "native:queue-parent").id;
	}
	store.waitTask(parent.taskId, "native:queue-parent", { kind: "children", reason: "Local work is executing independently" });
	const leaf = store.startLocalTask(previous, "native:queue-parent");
	const claim = store.claim({ attemptId: leaf.id, surface: repo, resource: "shared-result.json" }, "native:queue-parent");
	fails(() => store.claim({ attemptId: peer.id, surface: repo, resource: "shared-result.json" }, "native:queue-peer"), "claim_conflict");
	for (let index = 0; index < 30; index++) store.reassignTask(parent.taskId, "replacement", "root");
	assert.equal(store.pendingWakes("replacement").length, 1);
	assert.equal(store.getAttempt(parent.id).creator, "root");
	assert.equal(store.getAttempt(leaf.id).nativeId, "native:queue-parent");
	store.recordResult(outcome(leaf), "native:queue-parent");
	store.close();
	const resumed = openWorkStore(repo);
	t.after(() => resumed.close());
	assert.equal(resumed.getTask(previous).owner, "native:queue-parent");
	assert.equal(resumed.ownsTask(previous, "replacement"), true);
	assert.equal(resumed.snapshot().claims.length, 0);
	fails(() => resumed.releaseClaim(claim.id, "native:queue-parent"), "not_found");
	const wake = resumed.pendingWakes("replacement")[0];
	resumed.consumeWake(wake.id, wake.generation, "replacement");
	assert.equal(resumed.pendingWakes("replacement").length, 0);
	resumed.resumeTask(parent.taskId, "native:queue-parent");
	assert.equal(resumed.snapshot().attempts.filter(attempt => attempt.slot).length, 2);
	fails(() => resumed.startLocalTask("nested-0", "replacement"), "capacity_wait");
	assert.equal(resumed.getTask(parent.taskId).owner, "replacement");
	assert.equal(resumed.snapshot().effects.filter(effect => effect.kind === "create").length, 2);
});

test("evolution retires prepared intents and keeps the actual input request without a graph-wide barrier", t => {
	const { store } = fixture(t);
	goal(store);
	const producer = start(store, task(store, "producer"));
	store.recordResult(outcome(producer), "native:producer");
	const consumer = start(store, task(store, "consumer", { inputs: [{ taskId: producer.taskId, output: "delivery" }] }));
	store.waitTask(consumer.taskId, "native:consumer", { kind: "input", reason: "An actual user decision", requestId: "native-question-17" });
	const untouched = start(store, task(store, "unrelated"));
	store.evolveTask({ taskId: producer.taskId, expectedVersion: 1, checks: [{ ...check, origin: "derived", version: "derived-v2" }] }, "root");
	assert.equal(store.getTask(consumer.taskId).version, 2);
	assert.equal(store.getAttempt(consumer.id).state, "cancelled");
	assert.equal(store.openInputRequests("root")[0].waiting?.requestId, "native-question-17");
	assert.equal(store.getAttempt(untouched.id).state, "running");
	const prepared = store.prepareAttempt(task(store, "prepared").id, "root");
	store.recordEffect({ id: `create:${prepared.id}`, attemptId: prepared.id, kind: "create", state: "prepared", request: {} }, "root");
	store.evolveTask({ taskId: prepared.taskId, expectedVersion: 1, checks: [{ ...check, origin: "derived", version: "derived-v2" }] }, "root");
	assert.equal(store.getEffect(`create:${prepared.id}`)?.state, "settled");
	assert.ok(!store.pendingEffects().some(effect => effect.attemptId === prepared.id));
	fails(() => store.clearNativeInputs("native:consumer", "unrelated-actor"), "forbidden");
	store.clearNativeInputs("native:consumer", "native:consumer");
	assert.equal(store.openInputRequests("root").length, 0);
});

test("late issued children bind as cancelled history without replacing a newer attempt", t => {
	const { store } = fixture(t);
	goal(store);
	const unit = task(store, "late");
	const old = store.prepareAttempt(unit.id, "root");
	store.issueAttempt(old.id, "root", `create:${old.id}`, {});
	store.evolveTask({ taskId: unit.id, expectedVersion: 1, checks: [{ ...check, origin: "derived" }] }, "root");
	const fresh = store.prepareAttempt(unit.id, "root");
	const late = store.bindAttempt(old.id, "native:late", "root", { id: "native:late" });
	assert.equal(late.state, "cancelled");
	assert.equal(store.getTask(unit.id).currentAttemptId, fresh.id);
	assert.equal(store.getTask(unit.id).owner, "root");
	assert.equal(store.getAttempt(fresh.id).slot, true);
	assert.ok(store.pendingEffects().some(effect => effect.kind === "stop" && effect.attemptId === old.id));
	assert.equal(store.recordResult(outcome(old), "root", "native:late").promoted, false);
});

test("pure coordinator delivery keeps native receipts and falls back without appointing an owner", t => {
	const { store, repo } = fixture(t);
	goal(store);
	const parent = start(store, task(store, "parent"));
	const leaf = start(store, task(store, "leaf", { parentId: parent.taskId }, "native:parent"), "native:parent");
	store.recordResult(outcome(leaf), leaf.nativeId ?? "");
	const notification = store.pendingWakes("native:parent")[0];
	const delivery = store.claimWakeDelivery(notification.id, notification.generation, undefined, { session_id: notification.owner }, "root");
	assert.ok(delivery);
	store.settleWakeDelivery(notification.id, delivery.id, notification.generation,
		{ resultType: "failure", textResultForLlm: "Native session is archived" }, false, "root", true);
	const fallback = store.pendingWakes("root").find(wake => wake.reason === `unavailable:${notification.id}`);
	assert.ok(fallback);
	assert.equal(store.getTask(parent.taskId).owner, "native:parent");
	assert.equal(store.getDelivery(delivery.id).state, "settled");
	assert.deepEqual(store.getDelivery(delivery.id).result, { resultType: "failure", textResultForLlm: "Native session is archived" });
	assert.ok(!store.outgoingWakes("root").some(wake => wake.id === notification.id));
	const recovery = store.claimWakeDelivery(fallback.id, fallback.generation, undefined, {}, "root");
	assert.ok(recovery);
	store.close();
	const reopened = openWorkStore(repo);
	t.after(() => reopened.close());
	assert.equal(reopened.pendingDeliveries("root")[0].id, recovery.id);
	assert.equal(reopened.claimWakeDelivery(fallback.id, fallback.generation, undefined, {}, "root"), undefined);
	reopened.markWakeSent(fallback.id, fallback.generation, "root");
	assert.equal(reopened.getDelivery(recovery.id).state, "settled");
});

test("repository worktrees and independent connections share one WAL authority, never legacy files", (t) => {
	const { store, root, repo } = fixture(t);
	const worktree = path.join(root, "worktree");
	execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "-b", "worker", worktree]);
	const legacy = path.join(repo, ".git", "foundry", "foundry.sqlite");
	writeFileSync(legacy, "untouched old database");
	goal(store);
	const other = openWorkStore(worktree);
	t.after(() => other.close());
	assert.equal(other.databasePath, store.databasePath);
	const unit = task(other, "one");
	assert.equal(store.getTask(unit.id).title, "one");
	const inspection = new DatabaseSync(store.databasePath);
	assert.equal(inspection.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
	inspection.close();
	assert.equal(readFileSync(legacy, "utf8"), "untouched old database");
	store.close();
	const reopened = openWorkStore(repo);
	assert.equal(reopened.getTask(unit.id).id, unit.id);
	reopened.close();
});

test("immediate prepare, issued boundary, trusted bind, evaluated result and immutable duplicate", (t) => {
	const { store } = fixture(t);
	goal(store);
	const unit = task(store, "one", { checks: [check] });
	const prepared = store.prepareAttempt(unit.id, "root");
	assert.ok(store.readyTasks("root").some((ready) => ready.id === unit.id));
	assert.deepEqual(store.prepareAttempt(unit.id, "root"), prepared);
	assert.equal(store.attemptByToken(prepared.token)?.id, prepared.id);
	assert.equal(store.getTask(unit.id).owner, "root");
	const create = store.issueAttempt(prepared.id, "root", "native-call", { task: unit.id });
	assert.ok(!store.readyTasks("root").some((ready) => ready.id === unit.id));
	assert.equal(create.state, "issued");
	assert.deepEqual(store.issueAttempt(prepared.id, "root", create.id, create.request), create);
	fails(() => store.issueAttempt(prepared.id, "root", "second-call", {}), "already_issued");
	const bound = store.bindAttempt(prepared.id, "worker", "root");
	assert.equal(bound.creator, "root");
	assert.equal(store.getTask(unit.id).owner, "worker");
	assert.equal(store.snapshot().effects[0].state, "settled");
	admit(store, bound);
	const report = outcome(bound, { findings: [{ summary: "Consider a refactor", evidenceIds: [] }] });
	assert.equal(store.recordResult(report, "worker").promoted, true);
	assert.equal(store.getTask(unit.id).state, "done");
	assert.equal(store.getAttempt(bound.id).slot, false);
	assert.equal(store.recordResult(report, "worker").promoted, true);
	assert.equal(store.resultsForAttempt(bound.id).length, 1);
	assert.equal(store.recordResult(outcome(bound, { state: "failed" }), "worker").promoted, false);
	assert.equal(store.getTask(unit.id).state, "done");
	fails(() => store.recordResult({ ...report, summary: "Changed" }, "worker"), "result_identity_conflict");
	assert.deepEqual(store.bindAttempt(bound.id, "worker", "root"), store.getAttempt(bound.id));
	fails(() => store.bindAttempt(bound.id, "different", "root"), "binding_conflict");
});

test("native pre/post hooks use the prepared effect identity and add only actual call attribution", (t) => {
	const { store } = fixture(t);
	goal(store);
	const prepared = store.prepareAttempt(task(store, "hooked", { checks: [check] }).id, "root");
	const id = `create:${prepared.id}`;
	const request = { name: `F-${prepared.token}`, kickoff: { mode: "autopilot", prompt: "Complete assignment" } };
	store.recordEffect({ id, attemptId: prepared.id, kind: "create", state: "prepared", request }, "root");
	const issued = store.issueAttempt(prepared.id, "root", id, { ...request, nativeToolCallId: "actual-create-call" });
	assert.equal(issued.state, "issued");
	const receipt = { project_session_id: "hooked-worker", accepted: true };
	store.bindAttempt(prepared.id, "hooked-worker", "root", receipt);
	assert.equal(store.recordEffect({ ...issued, state: "settled", result: receipt }, "root").state, "settled");
	assert.equal(store.recordEffect({ ...issued, state: "settled", result: receipt }, "root").state, "settled");
	const commandId = "check-call";
	const commandRequest = { command: "node runner.mjs", checkId: check.id, checkVersion: check.version };
	store.recordEffect({ id: commandId, attemptId: prepared.id, kind: "command", state: "prepared", request: commandRequest }, "root");
	const command = store.recordEffect({ id: commandId, attemptId: prepared.id, kind: "command", state: "issued",
		request: { ...commandRequest, nativeToolCallId: "actual-shell-call" } }, "root");
	fails(() => store.recordEffect({ ...command, request: { ...commandRequest, nativeToolCallId: "other-call" } }, "root"), "effect_identity_conflict");
	const report = outcome(prepared);
	assert.equal(store.recordResult(report, "hooked-worker").promoted, false);
	store.recordEffect({ ...command, state: "settled", result: json({ nativeResult: { actual: "native receipt" }, evidence: report.evidence[0] }) }, "root");
	assert.equal(store.getTask(prepared.taskId).state, "running");
	assert.equal(store.recordResult(report, "hooked-worker").promoted, true);
	assert.equal(store.evidenceForAttempt(prepared.id).length, 1);
	const ambiguous = store.prepareAttempt(task(store, "ambiguous").id, "root");
	const uncertain = store.issueAttempt(ambiguous.id, "root", "unknown-create", {});
	store.recordEffect({ ...uncertain, state: "uncertain", result: { missingIdentity: true } }, "root");
	assert.equal(store.getAttempt(ambiguous.id).state, "uncertain");
	assert.equal(store.getAttempt(ambiguous.id).slot, true);
	fails(() => store.issueAttempt(ambiguous.id, "root", "replacement-create", {}), "already_issued");
	store.bindAttempt(ambiguous.id, "recovered-child", "root");
	assert.equal(store.getAttempt(ambiguous.id).state, "running");
});

test("a caller cannot invent check evidence or prefer old passes over later native failures", (t) => {
	const { store } = fixture(t);
	goal(store);
	const active = start(store, task(store, "checks", { checks: [check] }));
	const forged = outcome(active);
	forged.evidence[0].summary = "Caller invented this";
	assert.equal(store.recordResult(forged, "native:checks").promoted, false);
	const pass = { ...outcome(active).evidence[0], id: "actual-pass" };
	const failure = { ...pass, id: "actual-failure", outcome: /** @type {const} */ ("failed"), summary: "Observed failure" };
	const requests = [{ id: "prepared-first", evidence: pass }, { id: "prepared-second", evidence: failure }];
	for (const operation of requests) {
		store.recordEffect({ id: operation.id, attemptId: active.id, kind: "command", state: "prepared", request: {} }, "root");
		store.recordEffect({ id: operation.id, attemptId: active.id, kind: "command", state: "issued", request: {} }, "root");
	}
	store.recordEffect({ id: requests[1].id, attemptId: active.id, kind: "command", state: "settled", request: {},
		result: json({ evidence: failure, nativeResult: { exitCode: 1 } }) }, "root");
	assert.equal(store.getTask(active.taskId).state, "running");
	store.recordEffect({ id: requests[0].id, attemptId: active.id, kind: "command", state: "settled", request: {},
		result: json({ evidence: pass, nativeResult: { exitCode: 0 } }) }, "root");
	assert.deepEqual(store.evidenceForAttempt(active.id).map((evidence) => evidence.id), [failure.id, pass.id]);
	assert.equal(store.recordResult(outcome(active, { evidence: [failure, pass] }), "native:checks").promoted, true);
	const another = start(store, task(store, "latest", { checks: [check] }));
	const olderPass = { ...outcome(another).evidence[0], id: "older-pass" };
	const latestFailure = { ...olderPass, id: "latest-failure", outcome: /** @type {const} */ ("failed") };
	admit(store, another, [olderPass, latestFailure]);
	assert.equal(store.recordResult(outcome(another, { evidence: [olderPass] }), "native:latest").promoted, false);
	assert.equal(store.getTask(another.taskId).state, "running");
});

test("scope is inherited or narrowed; sibling mutations and delegated root goals fail", (t) => {
	const { store } = fixture(t);
	goal(store);
	const left = start(store, task(store, "left", { scope: { ...scope, mode: "interactive", paths: ["src"], workTypes: ["code"] } }));
	const right = start(store, task(store, "right"));
	const child = task(store, "child", { parentId: left.taskId, scope: { ...scope, mode: "interactive", paths: ["src/lib"], workTypes: ["code"] } }, "native:left");
	const unit = store.createUnit({ goalId: "goal", taskId: left.taskId, name: "Open-ended local specialist unit" }, "native:left");
	assert.equal(unit.owner, "native:left");
	assert.equal(child.owner, "native:left");
	assert.equal(child.scope.mode, "interactive");
	fails(() => task(store, "wide", { parentId: left.taskId, scope }, "native:left"), "scope_widening");
	const inherited = task(store, "inherited-restriction", { parentId: left.taskId,
		scope: { paths: ["src/lib"], restrictions: [] } }, "native:left");
	assert.deepEqual(inherited.scope.restrictions, scope.restrictions);
	assert.equal(inherited.scope.mode, "interactive");
	const narrowed = task(store, "partial-narrowing", { parentId: inherited.id,
		scope: { delegation: false, restrictions: ["no deletion", "no push"] } }, "native:left");
	assert.deepEqual(narrowed.scope.restrictions, ["no push", "no deletion"]);
	assert.deepEqual(narrowed.scope.paths, ["src/lib"]);
	fails(() => task(store, "invalid-restrictions", { parentId: left.taskId,
		scope: { restrictions: null } }, "native:left"), "invalid_field");
	fails(() => store.cancelTask(right.taskId, "native:left"), "forbidden");
	fails(() => store.prepareAttempt(right.taskId, "native:left"), "forbidden");
	fails(() => task(store, "sibling-child", { parentId: right.taskId }, "native:left"), "forbidden");
	fails(() => goal(store, "foreign-goal", "native:left"), "forbidden");
	const leaf = task(store, "leaf", { parentId: left.taskId, scope: { ...child.scope, delegation: false } }, "native:left");
	const leafAttempt = start(store, leaf, "native:left");
	fails(() => task(store, "leaf-child", { parentId: leaf.id }, leafAttempt.nativeId), "delegation_forbidden");
	fails(() => task(store, "foreign-root", {}, "native:left"), "forbidden");
	store.cancelTask(child.id, "root");
	assert.equal(store.getTask(child.id).state, "cancelled");
});

test("nested local coordinators delegate and integrate without consuming waiting slots", (t) => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 2 });
	const parent = start(store, task(store, "parent"));
	const first = task(store, "first", { parentId: parent.taskId }, "native:parent");
	const second = task(store, "second", { parentId: parent.taskId }, "native:parent");
	store.waitTask(parent.taskId, "native:parent", { kind: "children", reason: "Integrate the deliveries" });
	assert.equal(store.getAttempt(parent.id).slot, false);
	const one = start(store, first, "native:parent");
	const two = start(store, second, "native:parent");
	assert.equal(store.snapshot().attempts.filter((attempt) => attempt.slot).length, 2);
	const grandchild = task(store, "grandchild", { parentId: first.id }, "native:first");
	store.waitTask(first.id, "native:first", { kind: "children", reason: "Wait for grandchild" });
	const nested = start(store, grandchild, "native:first");
	assert.equal(store.recordResult(outcome(nested), "native:grandchild").promoted, true);
	const resumed = store.resumeTask(first.id, "native:first");
	assert.equal(resumed.token, one.token);
	assert.equal(store.recordResult(outcome(resumed), "native:parent", "native:first").promoted, true);
	assert.equal(store.recordResult(outcome(two), "native:second").promoted, true);
	const parentResumed = store.resumeTask(parent.taskId, "native:parent");
	assert.equal(parentResumed.id, parent.id);
	assert.equal(store.recordResult(outcome(parentResumed), "native:parent").promoted, true);
});

test("local jobs atomically admit the invoking identity without creation effects and retain ordinary repair accounting", (t) => {
	const { store, repo } = fixture(t);
	goal(store, "goal", "root", { workers: 2, repairs: 1 });
	const first = task(store, "local-one", { checks: [check] });
	const second = task(store, "local-two");
	const third = task(store, "local-three");
	const one = store.startLocalTask(first.id, "root");
	const two = store.startLocalTask(second.id, "root");
	assert.equal(one.nativeId, "root");
	assert.equal(two.nativeId, "root");
	assert.equal(one.creator, "root");
	assert.equal(one.state, "running");
	assert.equal(store.getTask(first.id).owner, "root");
	assert.equal(store.snapshot().effects.length, 0);
	assert.deepEqual(store.startLocalTask(first.id, "root"), one);
	fails(() => store.startLocalTask(third.id, "root"), "capacity_wait");
	assert.equal(store.getTask(third.id).currentAttemptId, undefined);
	admit(store, one);
	assert.equal(store.recordResult(outcome(one), "root").promoted, true);
	const three = store.startLocalTask(third.id, "root");
	assert.equal(store.recordResult(outcome(two, { state: "failed" }), "root").promoted, true);
	store.retryTask(second.id, two.id, "root");
	const repair = store.startLocalTask(second.id, "root");
	assert.notEqual(repair.token, two.token);
	assert.equal(repair.repairOf, two.id);
	assert.equal(repair.nativeId, "root");
	assert.equal(store.getAttempt(three.id).slot, true);
	assert.ok(!store.snapshot().effects.some((effect) => effect.kind === "create"));
	store.cancelTask(third.id, "root");
	assert.ok(!store.snapshot().effects.some((effect) => effect.kind === "stop"));
	store.close();
	const reopened = openWorkStore(repo);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.startLocalTask(second.id, "root"), repair);
	assert.deepEqual(reopened.bindAttempt(repair.id, "root", "root"), repair);
});

test("nested local jobs share parent capacity without contending with another goal's free slots", (t) => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const parent = start(store, task(store, "parent"));
	const localTask = task(store, "local-child", { parentId: parent.taskId }, "native:parent");
	fails(() => store.startLocalTask(localTask.id, "native:parent"), "capacity_wait");
	store.waitTask(parent.taskId, "native:parent", { kind: "children", reason: "Wait for local child" });
	goal(store, "other", "other-owner", { workers: 1 });
	const other = task(store, "other-local", { goalId: "other" }, "other-owner");
	const child = store.startLocalTask(localTask.id, "native:parent");
	assert.equal(store.startLocalTask(other.id, "other-owner").nativeId, "other-owner");
	assert.equal(child.nativeId, parent.nativeId);
	assert.equal(child.creator, "native:parent");
	assert.equal(store.snapshot("goal").effects.filter((effect) => effect.kind === "create").length, 1);
	assert.equal(store.recordUsage(child.id, 1, "local-usage", "native:parent").credits, 1);
	assert.equal(store.recordResult(outcome(child), "native:parent").promoted, true);
	assert.equal(store.resumeTask(parent.taskId, "native:parent").id, parent.id);
});

test("cancelling a local job targets its known commands, not unrelated jobs in the invoking session", (t) => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 2 });
	const one = store.startLocalTask(task(store, "one").id, "root");
	const two = store.startLocalTask(task(store, "two").id, "root");
	const command = { id: "local-command", attemptId: one.id, kind: /** @type {const} */ ("command"),
		state: /** @type {const} */ ("issued"), request: { command: "bounded job", nativeToolCallId: "actual-job" } };
	store.recordEffect(command, "root");
	store.cancelTask(one.taskId, "root");
	assert.equal(store.getAttempt(one.id).slot, true);
	assert.equal(store.getAttempt(two.id).slot, true);
	assert.equal(store.getTask(two.taskId).state, "running");
	const stop = store.snapshot().effects.find((effect) => effect.kind === "stop");
	assert.ok(stop);
	assert.deepEqual(stop.request, { nativeId: "root", reason: "cancelled", effectIds: [command.id] });
	store.recordEffect({ ...command, state: "settled", result: { stopped: true } }, "root");
	assert.equal(store.getAttempt(one.id).slot, false);
	assert.equal(store.getAttempt(two.id).slot, true);
});

test("early outcomes remain history until explicitly retried after trusted binding and evidence", (t) => {
	const { store } = fixture(t);
	goal(store);
	const prepared = store.prepareAttempt(task(store, "early", { checks: [check] }).id, "root");
	const good = outcome(prepared);
	const forged = outcome(prepared, { id: "foreign-outcome" });
	assert.equal(store.recordResult(forged, "foreign-worker").promoted, false);
	assert.equal(store.recordResult(good, "actual-worker").promoted, false);
	assert.equal(store.getTask(prepared.taskId).state, "running");
	store.issueAttempt(prepared.id, "root", "create-early", {});
	admit(store, prepared);
	store.bindAttempt(prepared.id, "actual-worker", "root");
	assert.equal(store.getTask(prepared.taskId).state, "running");
	assert.equal(store.recordResult(good, "actual-worker").promoted, true);
	assert.equal(store.resultsForAttempt(prepared.id).length, 2);
	fails(() => store.bindAttempt(prepared.id, "actual-worker", "foreign-worker"), "forbidden");
});

test("cancelled early results cannot publish; a late bind schedules stop instead of activation", (t) => {
	const { store } = fixture(t);
	goal(store);
	const prepared = store.prepareAttempt(task(store, "cancel-before-bind").id, "root");
	store.issueAttempt(prepared.id, "root", "late-create", {});
	const report = outcome(prepared);
	store.recordResult(report, "late-worker");
	store.cancelTask(prepared.taskId, "root");
	assert.equal(store.getAttempt(prepared.id).slot, true);
	const bound = store.bindAttempt(prepared.id, "late-worker", "root");
	assert.equal(bound.state, "cancelled");
	assert.equal(bound.slot, false);
	assert.deepEqual(store.getTask(prepared.taskId).outputs, []);
	assert.equal(store.recordResult(report, "late-worker").promoted, false);
	assert.equal(store.snapshot().effects.filter((effect) => effect.kind === "stop").length, 1);
	assert.equal(store.snapshot().effects.find((effect) => effect.kind === "stop")?.owner, "root");
	store.bindAttempt(prepared.id, "late-worker", "root");
	assert.equal(store.snapshot().effects.filter((effect) => effect.kind === "stop").length, 1);
	fails(() => store.issueAttempt(prepared.id, "root", "after-cancel", {}), "cancelled");
	fails(() => task(store, "cancelled-child", { parentId: prepared.taskId }, "late-worker"), "cancelled");
});

test("repairs use fresh tokens; stale success/failure cannot publish, repair, or release a newer slot", (t) => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { repairs: 1 });
	const old = start(store, task(store, "repair", { checks: [check] }));
	admit(store, old);
	assert.equal(store.recordResult(outcome(old, { state: "failed" }), "native:repair").promoted, true);
	store.retryTask(old.taskId, old.id, "root");
	fails(() => store.retryTask(old.taskId, old.id, "root"), "stale_attempt");
	const fresh = store.prepareAttempt(old.taskId, "root");
	assert.notEqual(fresh.token, old.token);
	assert.equal(fresh.repairOf, old.id);
	store.bindAttempt(fresh.id, "native:repair", "root");
	admit(store, fresh);
	const claim = store.claim({ attemptId: fresh.id, surface: "integration", resource: "src" }, "native:repair");
	assert.equal(store.recordResult(outcome(old), "native:repair").promoted, false);
	assert.equal(store.recordResult(outcome(old, { state: "failed" }), "native:repair").promoted, false);
	assert.equal(store.getAttempt(fresh.id).slot, true);
	assert.equal(store.snapshot().claims[0].id, claim.id);
	assert.equal(store.bindAttempt(old.id, "native:repair", "root").id, old.id);
	assert.equal(store.getTask(old.taskId).currentAttemptId, fresh.id);
	assert.equal(store.getAttempt(fresh.id).slot, true);
	fails(() => store.bindAttempt(old.id, "different-native", "root"), "binding_conflict");
	assert.equal(store.recordResult(outcome(fresh, { state: "failed" }), "root", "native:repair").promoted, true);
	fails(() => store.retryTask(fresh.taskId, fresh.id, "root"), "repair_limit");
});

test("DAG consumers require the producer's named output at the requested version, not just completion", (t) => {
	const { store } = fixture(t);
	goal(store);
	const producer = task(store, "producer");
	const consumer = task(store, "consumer", { inputs: [{ taskId: producer.id, output: "delivery", version: "v1" }] });
	const wrongName = task(store, "wrong-name", { inputs: [{ taskId: producer.id, output: "not-published" }] });
	const wrongVersion = task(store, "wrong-version", { inputs: [{ taskId: producer.id, output: "delivery", version: "v2" }] });
	const sibling = task(store, "independent");
	assert.deepEqual(store.readyTasks("root").map((unit) => unit.id), [producer.id, sibling.id]);
	fails(() => store.prepareAttempt(consumer.id, "root"), "inputs_unavailable");
	const producing = start(store, producer);
	store.recordResult(outcome(producing), "native:producer");
	assert.ok(store.readyTasks("root").some((unit) => unit.id === consumer.id));
	fails(() => store.prepareAttempt(wrongName.id, "root"), "inputs_unavailable");
	fails(() => store.prepareAttempt(wrongVersion.id, "root"), "inputs_unavailable");
	const consuming = store.prepareAttempt(consumer.id, "root");
	assert.deepEqual(consuming.inputs, [{ taskId: producer.id, output: "delivery", version: "v1" }]);
	assert.ok(store.pendingWakes("root").some((wake) => wake.relatedReasons?.includes(`output:${producer.id}`)));
	fails(() => task(store, "self-loop", { inputs: [{ taskId: "self-loop", output: "x" }] }), "dependency_cycle");
	fails(() => task(store, "missing", { inputs: [{ taskId: "unknown", output: "x" }] }), "not_found");
});

test("assigned check and input versions guard outcomes without invalidating unrelated work", (t) => {
	const { store } = fixture(t);
	goal(store);
	const checked = start(store, task(store, "checked", { checks: [check] }));
	assert.equal(store.recordResult(outcome(checked, { evidence: [] }), "native:checked").promoted, false);
	const report = outcome(checked);
	report.evidence[0].checkVersion = "edited-oracle";
	assert.equal(store.recordResult(report, "native:checked").promoted, false);
	const unrelated = task(store, "unrelated");
	admit(store, checked);
	assert.equal(store.recordResult(outcome(checked), "native:checked").promoted, true);
	assert.equal(store.getTask(unrelated.id).state, "ready");
	const db = new DatabaseSync(store.databasePath);
	const consumer = task(store, "consumer", { inputs: [{ taskId: checked.taskId, output: "delivery" }] });
	const consuming = start(store, consumer);
	const producer = store.getTask(checked.taskId);
	producer.outputs[0].version = "replaced-version";
	db.prepare("UPDATE tasks SET document=? WHERE id=?").run(JSON.stringify(producer), producer.id);
	db.close();
	assert.equal(store.recordResult(outcome(consuming), "native:consumer").promoted, false);
	assert.equal(store.getTask(consumer.id).state, "running");
});

test("assigned check identities ignore prose rewording but pin the actual evaluator version", (t) => {
	const { store } = fixture(t);
	goal(store);
	const reworded = start(store, task(store, "reworded", { checks: [check] }));
	const changed = start(store, task(store, "changed", { checks: [check] }));
	admit(store, reworded);
	admit(store, changed);
	const db = new DatabaseSync(store.databasePath);
	const first = store.getTask(reworded.taskId);
	first.checks[0].requirement = "The same check, described more clearly";
	db.prepare("UPDATE tasks SET document=? WHERE id=?").run(JSON.stringify(first), first.id);
	const second = store.getTask(changed.taskId);
	second.checks[0].version = "new-evaluator";
	db.prepare("UPDATE tasks SET document=? WHERE id=?").run(JSON.stringify(second), second.id);
	db.close();
	assert.equal(store.recordResult(outcome(reworded), "native:reworded").promoted, true);
	assert.equal(store.recordResult(outcome(changed), "native:changed").promoted, false);
});

test("uncontended goals admit every requested unit and resume immediately across restart", (t) => {
	const { store, repo } = fixture(t);
	goal(store, "high", "high-owner");
	goal(store, "low", "low-owner");
	const high1 = task(store, "high-one", { goalId: "high" }, "high-owner");
	const high2 = task(store, "high-two", { goalId: "high" }, "high-owner");
	const low = task(store, "low-one", { goalId: "low" }, "low-owner");
	const first = store.prepareAttempt(high1.id, "high-owner");
	assert.equal(store.prepareAttempt(high2.id, "high-owner").taskId, high2.id);
	assert.deepEqual(store.pendingWakes("low-owner"), []);
	store.close();
	const resumed = openWorkStore(repo);
	t.after(() => resumed.close());
	assert.equal(resumed.prepareAttempt(low.id, "low-owner").taskId, low.id);
	resumed.bindAttempt(first.id, "high-native", "high-owner");
	resumed.waitTask(first.taskId, "high-native", { kind: "input", requestId: "native-question", reason: "User decision" });
	const low2 = task(resumed, "low-two", { goalId: "low" }, "low-owner");
	assert.equal(resumed.resumeTask(first.taskId, "high-native").id, first.id);
	assert.equal(resumed.getTask(low2.id).state, "ready");
});

test("per-goal caps cover descendants and resumed parents; no invented default worker cap", (t) => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const parent = start(store, task(store, "parent"));
	const child = task(store, "child", { parentId: parent.taskId }, "native:parent");
	fails(() => store.prepareAttempt(child.id, "native:parent"), "capacity_wait");
	store.waitTask(parent.taskId, "native:parent", { kind: "children", reason: "Wait" });
	const worker = start(store, child, "native:parent");
	fails(() => store.resumeTask(parent.taskId, "native:parent"), "capacity_wait");
	store.recordResult(outcome(worker), "native:child");
	assert.equal(store.resumeTask(parent.taskId, "native:parent").id, parent.id);
	const uncapped = goal(store, "uncapped", "other-owner");
	for (let i = 0; i < 8; i++) task(store, `free-${i}`, { goalId: uncapped.id }, "other-owner");
	for (const ready of store.readyTasks("other-owner")) store.prepareAttempt(ready.id, "other-owner");
	assert.equal(store.snapshot(uncapped.id).attempts.filter((attempt) => attempt.slot).length, 8);
});

test("concurrent native coordinators cannot over-reserve the shared worker allowance", async (t) => {
	const { store, repo } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	task(store, "left");
	task(store, "right");
	const moduleUrl = new URL("./store.mjs", import.meta.url).href;
	/** @param {string} taskId */
	const reserve = (taskId) => new Promise((resolve, reject) => {
		const code = `import {openWorkStore} from ${JSON.stringify(moduleUrl)};
			const store=openWorkStore(${JSON.stringify(repo)});
			try { store.prepareAttempt(${JSON.stringify(taskId)},"root"); process.stdout.write("admitted"); }
			catch(error) { process.stdout.write(error.code); }
			finally { store.close(); }`;
		const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let errors = "";
		child.stdout.on("data", (data) => { output += String(data); });
		child.stderr.on("data", (data) => { errors += String(data); });
		child.on("error", reject);
		child.on("exit", (status) => status === 0 ? resolve(output) : reject(new Error(errors)));
	});
	const results = await Promise.all([reserve("left"), reserve("right")]);
	assert.deepEqual(results.sort(), ["admitted", "capacity_wait"]);
	assert.equal(store.snapshot().attempts.filter((attempt) => attempt.slot).length, 1);
});

test("logical outcomes and waiting do not settle commands or release exclusive claims", (t) => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const active = start(store, task(store, "command"));
	const claim = store.claim({ attemptId: active.id, surface: "checkout-one", resource: "src" }, "native:command");
	store.recordEffect({ id: "shell-1", attemptId: active.id, kind: "command", state: "issued", request: { command: "build" } }, "native:command");
	store.waitTask(active.taskId, "native:command", { kind: "children", reason: "Still has a running command" });
	assert.equal(store.getAttempt(active.id).slot, true);
	fails(() => store.releaseClaim(claim.id, "native:command"), "effects_outstanding");
	store.resumeTask(active.taskId, "native:command");
	store.recordResult(outcome(active), "native:command");
	assert.equal(store.getAttempt(active.id).slot, true);
	const ready = task(store, "next");
	fails(() => store.prepareAttempt(ready.id, "root"), "capacity_wait");
	store.recordEffect({ id: "shell-1", attemptId: active.id, kind: "command", state: "settled", request: { command: "build" }, result: { exitCode: 0 } }, "root");
	assert.equal(store.getAttempt(active.id).slot, false);
	assert.equal(store.snapshot().claims.length, 0);
	const next = store.prepareAttempt(ready.id, "root");
	assert.equal(next.slot, true);
	store.recordEffect({ id: "shell-1", attemptId: active.id, kind: "command", state: "settled", request: { command: "build" }, result: { exitCode: 0 } }, "root");
	assert.equal(store.getAttempt(next.id).slot, true);
});

test("resource claims conflict only on the same mutable surface and path prefix", (t) => {
	const { store } = fixture(t);
	goal(store);
	const left = start(store, task(store, "left"));
	const right = start(store, task(store, "right"));
	const one = store.claim({ attemptId: left.id, surface: "worktree-left", resource: "src" }, "native:left");
	assert.equal(store.claim({ attemptId: left.id, surface: "worktree-left", resource: "src" }, "native:left").id, one.id);
	store.claim({ attemptId: right.id, surface: "worktree-right", resource: "src/file.mjs" }, "native:right");
	fails(() => store.claim({ attemptId: right.id, surface: "worktree-left", resource: "src/file.mjs" }, "native:right"), "claim_conflict");
	store.claim({ attemptId: right.id, surface: "worktree-left", resource: "src-other" }, "native:right");
	fails(() => store.releaseClaim(one.id, "native:right"), "forbidden");
	fails(() => store.claim({ attemptId: right.id, surface: "worktree-right", resource: "../escaped" }, "native:right"), "invalid_path");
	store.releaseClaim(one.id, "root");
	store.claim({ attemptId: right.id, surface: "worktree-left", resource: "src/file.mjs" }, "native:right");
});

test("subtree cancellation stops bound descendants directly, retains outstanding commands and prevents nested starts", (t) => {
	const { store } = fixture(t);
	goal(store);
	const parent = start(store, task(store, "parent"));
	const child = start(store, task(store, "child", { parentId: parent.taskId }, "native:parent"), "native:parent");
	store.recordEffect({ id: "running", attemptId: child.id, kind: "command", state: "uncertain", request: { pid: 1234 } }, "native:child");
	const claim = store.claim({ attemptId: child.id, surface: "integration", resource: "." }, "native:child");
	const cancelled = store.cancelTask(parent.taskId, "root");
	assert.deepEqual(cancelled.map((unit) => unit.id).sort(), ["child", "parent"]);
	assert.equal(store.getAttempt(parent.id).slot, false);
	assert.equal(store.getAttempt(child.id).slot, true);
	assert.equal(store.snapshot().effects.filter((effect) => effect.kind === "stop").length, 2);
	assert.equal(store.recordResult(outcome(child), "native:child").promoted, false);
	fails(() => store.releaseClaim(claim.id, "root"), "effects_outstanding");
	fails(() => task(store, "late", { parentId: child.taskId }, "native:child"), "cancelled");
	store.recordEffect({ id: "running", attemptId: child.id, kind: "command", state: "settled", request: { pid: 1234 }, result: { stopped: true } }, "root");
	assert.equal(store.getAttempt(child.id).slot, false);
	store.releaseClaim(claim.id, "root");
});

test("wake generation consumption cannot lose an intervening output or reassignment", (t) => {
	const { store } = fixture(t);
	goal(store);
	const parent = start(store, task(store, "parent"));
	const child = task(store, "child", { parentId: parent.taskId }, "native:parent");
	store.reassignTask(child.id, "replacement", "root");
	const first = store.pendingWakes("replacement").find((wake) => wake.reason === `reassignment:${child.id}`);
	assert.ok(first);
	store.reassignTask(child.id, "replacement", "root");
	const second = store.consumeWake(first.id, first.generation, "replacement");
	assert.equal(second.generation, first.generation + 1);
	assert.equal(second.consumed, first.generation);
	assert.ok(store.pendingWakes("replacement").some((wake) => wake.id === first.id));
	store.consumeWake(second.id, second.generation, "replacement");
	assert.ok(!store.pendingWakes("replacement").some((wake) => wake.id === first.id));
	fails(() => store.consumeWake(second.id, second.generation + 1, "replacement"), "wake_generation");
	fails(() => store.consumeWake(second.id, second.generation, "root"), "forbidden");
	fails(() => store.reassignTask(parent.taskId, "self-adopted", "native:parent"), "forbidden");
	const worker = start(store, child, "replacement", "leaf");
	store.reassignTask(parent.taskId, "new-parent", "root");
	store.recordResult(outcome(worker), "new-parent", "leaf");
	assert.ok(store.pendingWakes("new-parent").some((wake) => wake.relatedReasons?.includes(`output:${child.id}`)));
	assert.equal(store.getAttempt(worker.id).creator, "replacement");
});

test("native wake delivery acknowledgments persist without consuming concurrent generations", (t) => {
	const { store, repo } = fixture(t);
	goal(store);
	const parent = start(store, task(store, "parent"));
	const child = task(store, "child", { parentId: parent.taskId }, "native:parent");
	store.reassignTask(child.id, "recipient", "root");
	const initial = store.pendingWakes("recipient").find((wake) => wake.reason === `reassignment:${child.id}`);
	assert.ok(initial);
	const sending = store.claimWakeDelivery(initial.id, initial.generation, parent.id, { session_id: "recipient" }, "native:parent");
	assert.ok(sending);
	assert.equal(store.markWakeSent(initial.id, initial.generation, "native:parent").sent, initial.generation);
	assert.equal(store.getDelivery(sending.id).state, "settled");
	assert.equal(store.getDelivery(sending.id).attemptId, parent.id);
	assert.equal(store.pendingWakes("recipient")[0].inFlight, undefined);
	assert.equal(store.pendingWakes("recipient").filter((wake) => wake.generation > (wake.sent ?? 0)).length, 0);
	store.reassignTask(child.id, "recipient", "root");
	const raced = store.markWakeSent(initial.id, initial.generation, "root");
	assert.equal(raced.generation, initial.generation + 1);
	assert.equal(raced.sent, initial.generation);
	assert.equal(raced.consumed, 0);
	store.close();
	const restarted = openWorkStore(repo);
	t.after(() => restarted.close());
	const outstanding = restarted.pendingWakes("recipient").find((wake) => wake.id === initial.id);
	assert.ok(outstanding);
	assert.equal(outstanding.sent, initial.generation);
	fails(() => restarted.markWakeSent(initial.id, outstanding.generation, "foreign-sibling"), "forbidden");
	restarted.markWakeSent(initial.id, outstanding.generation, "root");
	assert.equal(restarted.pendingWakes("recipient").length, 1);
	restarted.consumeWake(initial.id, outstanding.generation, "recipient");
	assert.equal(restarted.pendingWakes("recipient").length, 0);
});

test("legacy message effects are not accepted or projected as current deliveries", t => {
	const { store } = fixture(t);
	goal(store);
	const worker = start(store, task(store, "worker"));
	const effect = { id: "obsolete-message", attemptId: worker.id, owner: "native:worker",
		kind: "message", state: "issued", request: {} };
	const db = new DatabaseSync(store.databasePath);
	db.prepare("INSERT INTO effects(id,document,attempt_id,owner,state,kind) VALUES(?,?,?,?,?,?)")
		.run(effect.id, JSON.stringify(effect), effect.attemptId, effect.owner, effect.state, effect.kind);
	db.close();
	fails(() => store.getEffect(effect.id), "invalid_field");
	fails(() => store.getDelivery(effect.id), "not_found");
});

test("receipt aliases are indexed for original native writes and conflicts do not prevent reopening", t => {
	const { store, repo } = fixture(t);
	goal(store);
	const worker = start(store, task(store, "worker"));
	const receipt = { id: "original-receipt", nativeId: "native:worker", sourceSessionId: "native:worker",
		aliases: ["initial-alias"], attemptIds: [worker.id], goalId: "goal", credits: 2, debitedCredits: 2, billing: "complete" };
	const db = new DatabaseSync(store.databasePath);
	db.exec("PRAGMA trusted_schema=OFF");
	db.prepare("INSERT INTO native_usage(id,document,native_id,goal_id) VALUES(?,?,?,?)")
		.run(receipt.id, JSON.stringify(receipt), receipt.nativeId, receipt.goalId);
	const originalGoal = store.getGoal("goal");
	db.prepare("UPDATE goals SET document=? WHERE id=?").run(JSON.stringify({ ...originalGoal, credits: 2 }), "goal");
	assert.equal(store.recordUsage(worker.id, 2, receipt.id, "root").credits, 2);
	db.prepare("UPDATE native_usage SET document=? WHERE id=?")
		.run(JSON.stringify({ ...receipt, aliases: ["updated-alias"] }), receipt.id);
	assert.equal(store.recordUsage(worker.id, 2, "updated-alias", "root").credits, 2);
	assert.equal(db.prepare("SELECT count(*) AS n FROM usage_aliases WHERE alias='initial-alias'").get()?.n, 0);
	const lookup = db.prepare("EXPLAIN QUERY PLAN SELECT receipt_id FROM usage_aliases WHERE alias=?").all("updated-alias");
	assert.ok(lookup.some(row => String(row.detail).includes("SEARCH") && String(row.detail).includes("INDEX")));
	db.prepare("INSERT INTO native_usage(id,document,native_id) VALUES(?,?,?)")
		.run("conflicting-receipt", JSON.stringify({ ...receipt, id: "conflicting-receipt", aliases: ["updated-alias"] }), receipt.nativeId);
	db.close();
	store.close();
	const reopened = openWorkStore(repo);
	t.after(() => reopened.close());
	fails(() => reopened.recordUsage(worker.id, 2, "updated-alias", "root"), "usage_identity_conflict");
	assert.equal(reopened.getGoal("goal").credits, 2);
});

test("previous and incomplete store schemas are rejected without migrating or discarding their records", t => {
	const { store, repo } = fixture(t);
	goal(store);
	const worker = start(store, task(store, "worker"));
	store.recordNativeUsage({ id: "receipt-id", nativeId: "native:worker", sourceSessionId: "native:worker",
		aliases: ["alias"], attemptIds: [worker.id], credits: 3, billing: "complete" }, "native:worker");
	const db = new DatabaseSync(store.databasePath);
	const original = db.prepare("SELECT document FROM native_usage WHERE id='receipt-id'").get()?.document;
	store.close();
	db.exec("PRAGMA user_version=0");
	fails(() => openWorkStore(repo), "unsupported_store");
	db.exec("PRAGMA user_version=1");
	fails(() => openWorkStore(repo), "unsupported_store");
	db.exec("PRAGMA user_version=2");
	fails(() => openWorkStore(repo), "unsupported_store");
	assert.equal(db.prepare("SELECT document FROM native_usage WHERE id='receipt-id'").get()?.document, original);
	assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
	db.exec("PRAGMA user_version=3; DROP TRIGGER native_usage_alias_insert; DROP TRIGGER native_usage_alias_update; DROP TABLE usage_aliases");
	fails(() => openWorkStore(repo), "unsupported_store");
	assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name='usage_aliases'").get(), undefined);
	assert.equal(db.prepare("SELECT count(*) AS n FROM native_usage WHERE id='receipt-id'").get()?.n, 1);
	db.close();
});

test("canonical context retains deep unsettled work but not unrelated finished descendants or sibling authority", t => {
	const { store } = fixture(t);
	goal(store);
	const parent = start(store, task(store, "parent"));
	const nested = start(store, task(store, "nested", { parentId: parent.taskId }, "native:parent"), "native:parent");
	const deep = start(store, task(store, "deep", { parentId: nested.taskId }, "native:nested"), "native:nested");
	const finished = start(store, task(store, "finished", { parentId: nested.taskId }, "native:nested"), "native:nested");
	store.recordResult(outcome(finished), "native:finished");
	store.recordEffect({ id: "deep-command", attemptId: deep.id, kind: "command", state: "issued",
		request: { command: "work", shellId: "deep-shell" } }, "native:deep");
	const context = store.contextSnapshot("native:parent", "goal");
	assert.ok(context.tasks.some(task => task.id === deep.taskId));
	assert.ok(context.effects.some(effect => effect.id === "deep-command"));
	assert.ok(!context.tasks.some(task => task.id === finished.taskId));
	fails(() => store.contextSnapshot("native:finished", "goal", deep.taskId), "foreign_task");
	store.reassignTask(deep.taskId, "replacement", "root");
	assert.equal(store.ownsTask(deep.taskId, "native:deep"), false);
	assert.equal(store.taskForCaller(deep.taskId, "native:deep", true).id, deep.taskId);
	fails(() => store.taskForCaller(deep.taskId, "native:deep"), "foreign_task");
	assert.ok(store.contextSnapshot("native:deep", "goal", deep.taskId).effects.some(effect => effect.id === "deep-command"));
});

test("local evolution follows unpinned output edges, retaining pinned deliveries and unrelated work", t => {
	const { store } = fixture(t);
	goal(store);
	const producer = start(store, task(store, "producer"));
	assert.equal(store.recordResult(outcome(producer), "native:producer").promoted, true);
	const consumer = start(store, task(store, "consumer", { inputs: [{ taskId: "producer", output: "delivery" }] }));
	assert.equal(store.recordResult(outcome(consumer), "native:consumer").promoted, true);
	const grandchild = task(store, "dependent", { inputs: [{ taskId: "consumer", output: "delivery" }] });
	const pinned = task(store, "pinned", { inputs: [{ taskId: "producer", output: "delivery", version: "v1" }] });
	const unrelated = start(store, task(store, "unrelated"));
	const changed = store.evolveTask({ taskId: producer.taskId, expectedVersion: 1, checks: [{ ...check, origin: "derived" }] }, "root");
	assert.deepEqual(changed.affected, ["producer", "consumer", grandchild.id]);
	assert.equal(store.getAttempt(producer.id).state, "done");
	assert.equal(store.getAttempt(consumer.id).state, "done");
	assert.equal(store.getTask(unrelated.taskId).currentAttemptId, unrelated.id);
	assert.equal(store.getTask(unrelated.taskId).version, 1);
	assert.equal(store.getTask(pinned.id).version, 1);
	assert.equal(store.outputForInput(pinned.inputs[0])?.reference, "commit:123");
	assert.ok(store.readyTasks("root").some(task => task.id === pinned.id));
	assert.ok(!store.readyTasks("root").some(task => task.id === consumer.taskId));
	assert.equal(store.recordResult(outcome(consumer), "native:consumer").promoted, false);
	fails(() => store.evolveTask({ taskId: producer.taskId, expectedVersion: 1, checks: [] }, "root"), "stale_task");
	fails(() => store.evolveTask({ taskId: producer.taskId, expectedVersion: 2, inputs: [{ taskId: consumer.taskId, output: "delivery" }] }, "root"), "dependency_cycle");
	assert.equal(store.getTask(producer.taskId).version, 2);
	const replacement = store.startLocalTask(producer.taskId, "root");
	admit(store, replacement);
	fails(() => store.recordResult(outcome(replacement, { outputs: [{ name: "delivery", kind: "code", version: "v1", reference: "commit:changed" }] }), "root"), "output_version_conflict");
	assert.equal(store.recordResult(outcome(replacement, { outputs: [{ name: "delivery", kind: "code", version: "v2", reference: "commit:changed" }] }), "root").promoted, true);
	assert.equal(store.outputForInput(pinned.inputs[0])?.version, "v1");
	assert.equal(store.outputForInput({ taskId: producer.taskId, output: "delivery" })?.version, "v2");
});

test("evolution cannot relabel protected checks or abandon substantive effects and claims", t => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const unit = task(store, "unit", { checks: [check] });
	const attempt = store.startLocalTask(unit.id, "root");
	const claim = store.claim({ attemptId: attempt.id, surface: "integration", resource: "." }, "root");
	store.recordEffect({ id: "active-command", attemptId: attempt.id, kind: "command", state: "issued", request: { shellId: "active" } }, "root");
	fails(() => store.evolveTask({ taskId: unit.id, expectedVersion: 1, checks: [] }, "root"), "protected_check");
	fails(() => store.evolveTask({ taskId: unit.id, expectedVersion: 1, checks: [{ ...check, origin: "derived", command: "true" }] }, "root"), "protected_check");
	const changed = store.evolveTask({ taskId: unit.id, expectedVersion: 1, checks: [check, { ...check, id: "derived", origin: "derived" }] }, "root");
	assert.deepEqual(changed.affected, [unit.id]);
	assert.equal(store.getAttempt(attempt.id).state, "cancelled");
	assert.equal(store.getAttempt(attempt.id).slot, true);
	assert.equal(store.getEffect(`stop:${attempt.id}:root`)?.state, "prepared");
	fails(() => store.startLocalTask(unit.id, "root"), "capacity_wait");
	fails(() => store.releaseClaim(claim.id, "root"), "effects_outstanding");
	store.recordEffect({ ...store.getEffect("active-command"), id: "active-command", attemptId: attempt.id, kind: "command", state: "settled", request: { shellId: "active" }, result: { exitCode: 1 } }, "root");
	assert.equal(store.getAttempt(attempt.id).slot, false);
});

test("reassignment retires an unissued dispatch but preserves an issued child's creator and new coordinator", t => {
	const { store } = fixture(t);
	goal(store, "goal", "root", { workers: 1 });
	const unit = task(store, "unissued");
	const original = store.prepareAttempt(unit.id, "root");
	store.recordEffect({ id: `create:${original.id}`, attemptId: original.id, kind: "create", state: "prepared", request: { name: "old" } }, "root");
	store.reassignTask(unit.id, "replacement", "root");
	assert.equal(store.getAttempt(original.id).state, "cancelled");
	assert.equal(store.getAttempt(original.id).slot, false);
	fails(() => store.issueAttempt(original.id, "root", `create:${original.id}`, { name: "old" }), "stale_attempt");
	const fresh = store.prepareAttempt(unit.id, "replacement");
	assert.notEqual(fresh.token, original.token);
	store.issueAttempt(fresh.id, "replacement", `create:${fresh.id}`, { name: "new" });
	store.reassignTask(unit.id, "new-coordinator", "root");
	const bound = store.bindAttempt(fresh.id, "actual-child", "new-coordinator", { id: "actual-child" });
	assert.equal(bound.creator, "replacement");
	assert.equal(store.getTask(unit.id).owner, "new-coordinator");
	assert.equal(store.recordResult(outcome(bound), "new-coordinator", bound.nativeId).promoted, true);
	assert.equal(store.getAttempt(bound.id).slot, false);
});

test("a completed repair does not invite the worker to execute the already-delivered task again", t => {
	const { store } = fixture(t);
	goal(store);
	const parent = start(store, task(store, "parent"));
	const child = task(store, "child", { parentId: parent.taskId }, "native:parent");
	const failed = start(store, child, "native:parent");
	store.recordResult(outcome(failed, { state: "failed" }), "native:child");
	store.retryTask(child.id, failed.id, "native:parent");
	const notification = store.pendingWakes("native:child")[0];
	assert.ok(notification);
	assert.equal(store.wakeHasCurrentRecipient(notification.id), true);
	const fresh = store.startLocalTask(child.id, "native:child");
	store.recordResult(outcome(fresh), "native:child");
	assert.equal(store.wakeHasCurrentRecipient(notification.id), false);
});

test("observed usage is deduplicated across current and stale attempts, shared and never refunded", (t) => {
	let now = new Date("2026-11-14T00:00:00Z");
	const { store } = fixture(t, { clock: () => now });
	goal(store, "goal", "root", { credits: 10, deadline: "2026-11-15T00:00:00Z" });
	const old = start(store, task(store, "metered"));
	assert.equal(store.recordUsage(old.id, 4, "billing-1", "native:metered").credits, 4);
	assert.equal(store.recordUsage(old.id, 4, "billing-1", "root").credits, 4);
	store.recordResult(outcome(old, { state: "failed" }), "native:metered");
	store.retryTask(old.taskId, old.id, "root");
	const fresh = store.prepareAttempt(old.taskId, "root");
	assert.equal(store.recordUsage(old.id, 3, "late-billing", "root").credits, 7);
	assert.equal(store.recordUsage(fresh.id, 4, "billing-2", "root").credits, 11);
	assert.equal(store.recordUsage(old.id, 3, "late-billing", "root").credits, 11);
	fails(() => store.recordUsage(fresh.id, 4, "billing-1", "root"), "usage_identity_conflict");
	fails(() => store.recordUsage(fresh.id, -1, "refund", "root"), "invalid_field");
	fails(() => store.prepareAttempt(task(store, "no-budget").id, "root"), "limit_exhausted");
	goal(store, "deadline", "deadline-owner", { deadline: "2026-11-15T00:00:00Z" });
	const after = task(store, "expired", { goalId: "deadline" }, "deadline-owner");
	now = new Date("2026-11-15T00:00:00Z");
	fails(() => store.prepareAttempt(after.id, "deadline-owner"), "limit_exhausted");
});

test("signals and lessons are deduplicated operational records with relevant retrieval", (t) => {
	const { store } = fixture(t);
	goal(store);
	goal(store, "other", "other");
	const unit = task(store, "one");
	const signal = { goalId: "goal", taskId: unit.id, kind: "regression", summary: "Concrete failure", references: ["test:1"] };
	const first = store.recordSignal(signal, "root");
	assert.equal(store.recordSignal(signal, "root").id, first.id);
	const lesson = { goalId: "goal", workType: "code", summary: "Use the measured fixture", references: ["test:1"] };
	const learned = store.recordLesson(lesson, "root");
	assert.equal(store.recordLesson(lesson, "root").id, learned.id);
	store.recordLesson({ ...lesson, workType: "analysis" }, "root");
	assert.equal(store.lessonsFor("goal", "code").length, 1);
	assert.equal(store.lessonsFor("other", "code").length, 0);
	assert.equal(store.snapshot("other").signals.length, 0);
	assert.equal(store.snapshot("goal").signals.length, 1);
});

test("goal specialists may signal affected siblings and deliver parent wakes without task mutation authority", (t) => {
	const { store } = fixture(t);
	goal(store);
	goal(store, "foreign", "foreign-owner");
	const parent = start(store, task(store, "parent"));
	const worker = start(store, task(store, "leaf", { parentId: parent.taskId }, "native:parent"), "native:parent");
	const specialist = start(store, task(store, "specialist", { workType: "analysis" }));
	const before = store.getTask(worker.taskId);
	const signal = store.recordSignal({ goalId: "goal", taskId: worker.taskId, kind: "review",
		summary: "A scoped observation, not a changed obligation", references: ["observation:one"] }, specialist.nativeId ?? "");
	assert.deepEqual(store.getTask(worker.taskId), before);
	const notification = store.pendingWakes("native:parent").find((wake) => wake.reason === `signal:${signal.id}`);
	assert.ok(notification);
	assert.equal(store.markWakeSent(notification.id, notification.generation, "native:specialist").sent, notification.generation);
	fails(() => store.cancelTask(worker.taskId, "native:specialist"), "forbidden");
	fails(() => store.startLocalTask(worker.taskId, "native:specialist"), "forbidden");
	fails(() => store.reassignTask(worker.taskId, "native:specialist", "native:specialist"), "forbidden");
	fails(() => store.recordSignal({ goalId: "foreign", kind: "foreign", summary: "Not a member", references: [] }, "native:specialist"), "forbidden");
	assert.equal(store.recordResult(outcome(worker), "native:leaf").promoted, true);
	const parentWake = store.pendingWakes("native:parent").find((wake) => wake.relatedReasons?.includes(`output:${worker.taskId}`));
	assert.ok(parentWake);
	assert.equal(store.markWakeSent(parentWake.id, parentWake.generation, "native:leaf").sent, parentWake.generation);
	store.reassignTask(worker.taskId, "replacement", "root");
	assert.ok(store.pendingWakes("native:parent").some((wake) => wake.relatedReasons?.includes(`signal:${signal.id}`)));
	store.reassignTask(parent.taskId, "new-coordinator", "root");
	assert.ok(store.pendingWakes("new-coordinator").some((wake) => wake.relatedReasons?.includes(`signal:${signal.id}`)));
	assert.ok(!store.pendingWakes("native:leaf").some((wake) => wake.relatedReasons?.includes(`signal:${signal.id}`)));
});

test("goal source contract references and exact hashes persist through accounting and reopen", (t) => {
	const { store, repo } = fixture(t);
	const source = { reference: ".foundry/contracts/original.json", sha256: "AB".repeat(32) };
	assert.deepEqual(store.createGoal({ id: "goal", title: "Retain original source", scope, source }, "root").source, source);
	const local = store.startLocalTask(task(store, "local").id, "root");
	assert.deepEqual(store.recordUsage(local.id, 1, "usage", "root").source, source);
	fails(() => store.createGoal({ title: "Bad source", scope, source: { ...source, sha256: "invalid" } }, "root"), "invalid_field");
	store.close();
	const reopened = openWorkStore(repo);
	t.after(() => reopened.close());
	assert.deepEqual(reopened.getGoal("goal").source, source);
	assert.deepEqual(reopened.snapshot("goal").goals[0].source, source);
});

test("filesystem containment rejects symlinked storage, hardlinked database and live replacement", (t) => {
	const { store, repo, root } = fixture(t);
	const storage = path.dirname(store.databasePath);
	store.close();
	const moved = path.join(root, "moved");
	renameSync(storage, moved);
	symlinkSync(moved, storage, "dir");
	fails(() => openWorkStore(repo), "unsafe_storage");
	rmSync(storage);
	renameSync(moved, storage);
	linkSync(store.databasePath, path.join(root, "database-link"));
	fails(() => openWorkStore(repo), "unsafe_storage");
	rmSync(path.join(root, "database-link"));
	const active = openWorkStore(repo);
	t.after(() => active.close());
	renameSync(active.databasePath, path.join(root, "original-database"));
	writeFileSync(active.databasePath, "replaced");
	fails(() => active.snapshot(), "unsafe_storage");
	assert.ok(existsSync(path.join(root, "original-database")));
});

test("JSON values reject non-JSON data and digest object keys stably", () => {
	assert.equal(digest(json({ b: [1, true], a: null })), digest(json({ a: null, b: [1, true] })));
	fails(() => json({ missing: undefined }), "invalid_json");
	fails(() => json(Number.NaN), "invalid_json");
	/** @type {Record<string, unknown>} */
	const cycle = {};
	cycle.self = cycle;
	fails(() => json(cycle), "invalid_json");
});

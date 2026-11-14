import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { createDispatchOperations } from "../../application/dispatch.mjs";
import { errorCode, errorMessage, isRecord, readJsonValue } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { createNativeAdmission, createOfferedDispatchTransport, DispatchNativeError } from "../../native/admission.mjs";
import { createNativeDispatch, dispatchReservation } from "../../native/dispatch.mjs";
import { admissionRecord } from "../../plan/parallel-contracts.mjs";
import { reserveTaskAttempt } from "../../plan/execution.mjs";
import { assignmentDigest } from "../../plan/startup.mjs";
import { createPlanStore } from "../../storage.mjs";
import { createDispatchJournal, initializeDispatchJournal } from "../../storage/dispatch.mjs";
import { assertAdmissionFence, synchronousTransition } from "../../storage/parallel-protocol.mjs";
import { COMMIT, EVALUATOR_FILES, git } from "../git.mjs";
import { assertOfferedToolArguments } from "../parallel/native-contracts.mjs";
import { createParallelFixture } from "../parallel/fixture.mjs";
import { createApproved, evidence, withOperations } from "./fixture.mjs";

/** @typedef {import("../../types/parallel.js").AdmissionRecord} Admission */
/** @typedef {import("../../types/parallel.js").AdmissionPort} AdmissionPort */
/** @typedef {import("../../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../../types/json.js").JsonValue} Json */

/** Actual plan operations/native adapter plus injected admission port; no App sessions.
 * @param {(value: Awaited<ReturnType<typeof setup>>) => Promise<void>} action */
async function scenario(action) {
	await withOperations(async ({ operations, workspacePath }) => {
		const fixture = createParallelFixture({ name: "dispatch", initialize: initializeDispatchJournal });
		try { await action(await setup(operations, workspacePath, fixture)); }
		finally { fixture.dispose(); }
	});
}

/** @param {import("./fixture.mjs").Operations} operations @param {string} workspacePath
 * @param {ReturnType<typeof createParallelFixture>} fixture */
async function setup(operations, workspacePath, fixture) {
	const approved = await createApproved(operations, workspacePath);
	assert.ok(approved.factory);
	const identity = { repositoryId: approved.factory.repositoryId, owner: workspacePath, planId: approved.id, taskId: "T-001", reservationId: "dispatch-001" };
	/** @type {Admission | null} */
	let record = null;
	let sequence = 0;
	const clock = () => new Date(Date.UTC(2030, 0, 1) + ++sequence * 1000).toISOString();
	const storage = fixture.left.storage;
	const journal = createDispatchJournal({ read: operation => storage.transaction(operation) });
	const child = { sessionId: "canonical-child", projectId: "fixture-project", creatorSessionId: "coordinator",
		worktreePath: path.join(workspacePath, "children", "native"), branch: "worker" };
	/** @type {string[]} */
	const trace = [];
	const control = {
		createCount: 0, messageCount: 0, workflowCount: 0, materializeCount: 0,
		acknowledged: true, aliases: [child.sessionId], completeInventory: true, clean: true,
		/** @type {"none" | "creation" | "handoff" | "workflow"} */
		lose: "none",
		/** @type {string | null} */
		deny: null,
		/** @type {(() => void) | null} */
		beforeCreateResult: null,
		/** @type {(() => Promise<void>) | null} */
		beforeAttach: null,
		/** @type {(() => void) | null} */
		beforeFence: null,
		/** @type {Json | null} */
		reconciled: null,
		withInputs: false,
		resolverAvailable: true,
		legacy: false,
	};
	/** @type {AdmissionPort} */
	const admission = {
		read: () => record ? structuredClone(record) : null,
		claim: () => { throw new Error("Dispatch must not claim"); },
		bindReservation: () => { throw new Error("Dispatch must not reserve directly"); },
		withFence(expected, callback) {
			control.beforeFence?.();
			assert.ok(record);
			const current = structuredClone(record);
			assertAdmissionFence(current, expected, { settlement: true });
			const result = storage.transaction(db => synchronousTransition(() => callback({ db, admission: current, fence: expected })), { write: true });
			current.revision++;
			record = admissionRecord(current);
			return result;
		},
		cancel(expected) {
			assert.ok(record);
			assertAdmissionFence(record, expected);
			record = { ...record, phase: "cancelling", epoch: record.epoch + 1, revision: record.revision + 1 };
			trace.push("cancelled");
			return structuredClone(record);
		},
		deliver(expected, receipt) {
			assert.ok(record);
			assertAdmissionFence(record, expected);
			record = admissionRecord({ ...record, phase: "settled", delivery: receipt, revision: record.revision + 1 });
			trace.push("delivery-durable");
			return structuredClone(record);
		},
		settle: () => { throw new Error("Dispatch must not settle"); },
		release: () => { throw new Error("Dispatch must not release"); },
	};
	const cancel = () => {
		assert.ok(record);
		admission.cancel({ admission: identity, revision: record.revision, epoch: record.epoch });
	};
	/** @param {unknown} value */
	const success = value => ({ resultType: "success", textResultForLlm: JSON.stringify(value) });
	const transport = createOfferedDispatchTransport({
		owner: workspacePath, sessionId: "coordinator", context: () => ({ owner: workspacePath, sessionId: "coordinator", inWorkflow: false }),
		offered: new Set(["create_session", "get_session", "list_sessions_and_chats", "send_session_message", "run_dynamic_workflow",
			"foundry_get_status", "foundry_reserve_task", "foundry_attach_task", "foundry_complete_task"]),
		availability: () => "supported",
		executor: { async execute({ name, arguments: args, toolCallId }) {
			assertOfferedToolArguments(name, args);
			trace.push(name);
			/** @type {Record<string, Receipt["kind"]>} */
			const effects = { create_session: "creation", foundry_attach_task: "attachment", send_session_message: "handoff", run_dynamic_workflow: "workflow" };
			if (effects[name]) {
				assert.ok(record?.attempt);
				const started = journal.read(record.attempt).find(receipt => receipt.kind === effects[name]);
				assert.ok(started);
				assert.equal(started.state, "in-flight");
				assert.equal(toolCallId, started.id, "Native correlation must already be durably pinned, not generated after the start");
			}
			if (control.deny === name) return { resultType: "denied", textResultForLlm: "Permission denied" };
			assert.ok(isRecord(args));
			if (name === "create_session") {
				assert.ok(record?.attempt);
				assert.equal(journal.read(record.attempt)[0].state, "in-flight");
				control.createCount++;
				if (reservation?.initialization.recipe) {
					assert.deepEqual(args.kickoff, reservation.initialization.kickoff);
					assert.equal(reservation.initialization.assignmentDigest, assignmentDigest(reservation.delegationPrompt));
				}
				git(workspacePath, "worktree", "add", "--quiet", "-b", child.branch, child.worktreePath, String(args.base_branch));
				control.beforeCreateResult?.();
				if (control.lose === "creation") throw new Error("lost create response after host creation");
				return success(child);
			}
			if (name === "send_session_message") {
				control.messageCount++;
				assert.equal(args.coordinator_only, true);
				if (reservation?.initialization.recipe) {
					assert.ok(typeof args.message === "string");
					assert.ok(args.message.length < 16000);
					assert.ok(!args.message.includes(reservation.delegationPrompt));
					const activation = JSON.parse(args.message.slice("Foundry activate received assignment:\n".length));
					assert.equal(activation.assignmentDigest, reservation.initialization.assignmentDigest);
					assert.deepEqual(activation.attempt, reservation.attempt);
					assert.deepEqual(activation.child, child);
				} else assert.equal(args.message, reservation?.delegationPrompt);
				if (control.lose === "handoff") throw new Error("lost handoff acknowledgement");
				return success({ sessionId: child.sessionId, accepted: true });
			}
			if (name === "run_dynamic_workflow") {
				control.workflowCount++;
				if (control.lose === "workflow") throw new Error("lost launch response");
				return success({ runId: "native-run" });
			}
			if (name === "get_session") return success(child);
			if (name === "list_sessions_and_chats") return success({ complete: true, sessions: [child] });
			try {
				if (name === "foundry_get_status") return success({ ok: true, value: await operations.getStatus(args) });
				if (name === "foundry_reserve_task") return success({ ok: true, value: await operations.reserveTask(args) });
				if (name === "foundry_attach_task") {
					await control.beforeAttach?.();
					return success({ ok: true, value: await operations.attachTask(args) });
				}
				if (name === "foundry_complete_task") return success({ ok: true, value: await operations.completeTask(args) });
				throw new Error(`Unexpected tool ${name}`);
			} catch (error) {
				return { resultType: "failure", textResultForLlm: JSON.stringify({ ok: false, error: { code: errorCode(error), message: errorMessage(error) } }) };
			}
		} },
	});
	const plans = createNativeAdmission({ transport });
	const native = createNativeDispatch({
		transport, decodeCreated: value => value, decodeHandoff: value => value,
		decodeRun: value => isRecord(value) ? value.runId : null,
		observeSetup: async () => ({ sessionId: child.sessionId, message: control.acknowledged ? reservation?.initialization.acknowledgement : "not ready", at: clock(), source: "recorded child assistant turn" }),
		observeChild: async () => ({ child, capturedAt: clock(), source: "fresh exhaustive recorded App inventory + canonical Git check",
			complete: control.completeInventory, aliases: control.aliases, baseBranch: "main", baseCommit: COMMIT, head: COMMIT, clean: control.clean }),
		reconcile: async () => control.reconciled === null ? null : ({ value: control.reconciled, raw: control.reconciled, source: "exact owned transport receipt recovered" }),
	});
	/** @type {ReturnType<typeof dispatchReservation> | null} */
	let reservation = null;
	/** @param {import("../../types/parallel.js").AdmissionIdentity} requested */
	async function reserve(requested) {
		assert.deepEqual(requested, identity);
		if (reservation) return reservation;
		const { plan } = await plans.status(identity.planId);
		// Construct an original old-record fixture, not an upgrade/downgrade path.
		// Input-bearing fresh sealing is exercised through real root composition.
		if (control.legacy || control.withInputs) {
			await createPlanStore({ workspacePath }).mutate(plan.id, plan.revision, current =>
				reserveTaskAttempt(current, identity.taskId, { reservationId: identity.reservationId }));
		}
		const result = await plans.reserve(identity, plan.revision);
		assert.ok(result.value.initialization);
		const attempt = { ...identity, attemptId: result.attempt.id };
		const producers = [
			{ id: "alpha", taskId: "T-002", path: "implementation.mjs", content: EVALUATOR_FILES["implementation.mjs"] },
			{ id: "beta", taskId: "T-003", path: "package.json", content: EVALUATOR_FILES["package.json"] },
		].map(item => ({ ...item, artifact: { repositoryId: identity.repositoryId, commit: COMMIT, path: item.path,
			mode: /** @type {const} */ ("100644"), digest: createHash("sha256").update(item.content).digest("hex") } }));
		const body = { format: /** @type {const} */ ("foundry-reserved-inputs-v1"), consumer: attempt,
			bootstrap: { repositoryId: identity.repositoryId, branch: "main", commit: COMMIT },
			deliveries: producers.map(item => ({ packageId: item.id, attempt: { ...identity, taskId: item.taskId, attemptId: `${item.taskId}-A001`, reservationId: `producer-${item.id}` },
				commit: COMMIT, outputs: [{ id: "output", artifact: item.artifact }] })),
			inputs: producers.map(item => ({ producer: item.id, output: "output", destination: `inputs/${item.path}`, artifact: item.artifact })),
		};
		const inputs = control.withInputs ? { ...body, digest: analysisInputDigest(body) } : null;
		reservation = dispatchReservation({
			attempt, projectId: child.projectId, baseBranch: result.attempt.baseBranch, baseCommit: COMMIT,
			initialization: result.value.initialization,
			delegationPrompt: String(result.value.delegationPrompt) + (inputs ? `\n${stableStringify(inputs)}` : ""),
			inputs, requiredInputs: inputs?.inputs.map(({ producer, output, destination }) => ({ producer, output, destination })) ?? [],
		});
		record = admissionRecord({ format: "foundry-admission-v1", identity, revision: 1, epoch: 0, phase: "reserved",
			attempt, resources: [{ id: "host", kind: "foreground-input", scope: "fixture", mode: "exclusive", capacity: 1, units: 1 }],
			team: null, obligations: [], receipts: [], delivery: null, reservationFailure: null });
		trace.push("reservation-bound");
		return reservation;
	}
	const makeDispatcher = () => createDispatchOperations({
		admission, journal, native, plans, reserve, clock,
		...(control.resolverAvailable ? { inputs: { resolve: () => {
			assert.ok(reservation?.inputs);
			return structuredClone(reservation.inputs);
		} } } : {}),
		ready: async () => { trace.push("ready"); return [identity, identity]; },
	});
	return { operations, identity, child, trace, control, admission, journal, plans, native, reserve, makeDispatcher, cancel,
		/** @param {Receipt["kind"]} kind @param {Partial<Receipt>} change */
		divergeReceipt(kind, change) {
			assert.ok(record?.attempt);
			const receipt = journal.read(record.attempt).find(item => item.kind === kind);
			assert.ok(receipt);
			storage.transaction(db => {
				db.prepare("UPDATE dispatch_effects SET receipt = ? WHERE id = ?").run(stableStringify({ ...receipt, ...change }), receipt.id);
			}, { write: true });
		},
		/** @param {Receipt["kind"]} kind @param {Json} payload */
		substitutePayload(kind, payload) {
			assert.ok(record?.attempt);
			const receipt = journal.read(record.attempt).find(item => item.kind === kind);
			assert.ok(receipt);
			storage.transaction(db => {
				db.prepare("UPDATE dispatch_effects SET payload = ? WHERE id = ?").run(stableStringify(payload), receipt.id);
			}, { write: true });
		},
		/** @param {Receipt["kind"]} kind @param {Json} value */
		substituteOutcome(kind, value) {
			assert.ok(record?.attempt);
			const receipt = journal.read(record.attempt).find(item => item.kind === kind);
			assert.ok(receipt);
			const saved = journal.outcomes(record.attempt, receipt.id).at(-1);
			assert.ok(isRecord(saved));
			storage.transaction(db => {
				db.prepare("UPDATE dispatch_outcomes SET outcome = ? WHERE id = ?").run(stableStringify({ ...saved, value }), receipt.id);
			}, { write: true });
		},
		get reservation() { assert.ok(reservation); return reservation; },
		get record() { assert.ok(record); return structuredClone(record); },
	};
}

test("production sequence reserves and journals before create, corroborates before attach, and never materializes inputs", () => scenario(async s => {
	s.control.withInputs = true;
	const result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state, "handed-off", JSON.stringify(result));
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 1);
	assert.equal(s.control.materializeCount, 0);
	assert.equal(git(s.child.worktreePath, "status", "--porcelain"), "");
	assert.deepEqual(s.trace.filter(name => !["foundry_get_status"].includes(name)), [
		"foundry_reserve_task", "reservation-bound", "create_session", "get_session", "list_sessions_and_chats", "foundry_attach_task", "send_session_message",
	]);
	const receipts = s.journal.read(s.reservation.attempt);
	assert.deepEqual(receipts.map(item => [item.kind, item.state]), [["creation", "succeeded"], ["attachment", "succeeded"], ["handoff", "succeeded"]]);
	const saved = s.journal.payload(s.reservation.attempt, "creation");
	assert.ok(isRecord(saved) && isRecord(saved.reservation));
	assert.deepEqual(saved.reservation.inputs, s.reservation.inputs);
	assert.equal(result.state === "handed-off" && result.executionObserved, false);
}));

test("duplicate concurrent callbacks and reconstructed dispatcher never create or hand off twice", () => scenario(async s => {
	await s.reserve(s.identity);
	const results = await Promise.all([s.makeDispatcher().dispatch(s.identity), s.makeDispatcher().dispatch(s.identity)]);
	assert.ok(results.some(result => result.state === "handed-off"), JSON.stringify(results));
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 1);
}));

test("legacy stored reservations replay only the unchanged setup/full-handoff effects", () => scenario(async s => {
	s.control.legacy = true;
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	const before = structuredClone(s.reservation), receipts = s.journal.read(s.reservation.attempt);
	const payloads = receipts.map(receipt => s.journal.payload(s.reservation.attempt, receipt.kind));
	assert.equal(Object.hasOwn(s.reservation.initialization, "recipe"), false);
	assert.notEqual(s.reservation.initialization.kickoff.prompt, s.reservation.delegationPrompt);
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	assert.deepEqual(s.reservation, before);
	assert.deepEqual(s.journal.read(s.reservation.attempt), receipts);
	assert.deepEqual(receipts.map(receipt => s.journal.payload(s.reservation.attempt, receipt.kind)), payloads);
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 1);
}));

test("fresh activation carries no assignment and changed digest/owner/child/attempt cannot replay its claim", () => scenario(async s => {
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	const payload = s.journal.payload(s.reservation.attempt, "handoff");
	assert.ok(isRecord(payload) && isRecord(payload.activation));
	assert.deepEqual(Object.keys(payload).sort(), ["activation", "child"]);
	assert.equal(Object.hasOwn(payload, "delegationPrompt"), false);
	for (const change of [
		{ assignmentDigest: "f".repeat(64) },
		{ attempt: { ...s.reservation.attempt, owner: "/foreign" } },
		{ attempt: { ...s.reservation.attempt, attemptId: "T-001-A002" } },
		{ child: { ...s.child, sessionId: "foreign-child" } },
	]) {
		s.substitutePayload("handoff", readJsonValue({ ...payload, activation: { ...payload.activation, ...change } }));
		// The receipt's original digest cannot be rebound to a different activation.
		const result = await s.makeDispatcher().dispatch(s.identity);
		assert.equal(result.state === "held" && result.code, "parallel_receipt_identity");
		assert.equal(s.control.messageCount, 1);
	}
}));

test("cancellation before activation retains the original child and forbids its message", () => scenario(async s => {
	let transitions = 0;
	s.control.beforeFence = () => {
		if (++transitions === 8) { s.control.beforeFence = null; s.cancel(); }
	};
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 0);
	assert.equal(s.record.receipts.find(receipt => receipt.kind === "handoff")?.state, "intent");
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.control.messageCount, 0);
}));

test("dispatch and reconstructed replay use the injected canonical reservation and child decoders", () => scenario(async s => {
	/** @type {unknown[]} */
	const reservations = [];
	/** @type {unknown[]} */
	const children = [];
	const decodeReservation = s.native.dispatchReservation, decodeChild = s.native.createdChild;
	s.native.dispatchReservation = value => {
		reservations.push(value);
		return decodeReservation(value);
	};
	s.native.createdChild = value => {
		children.push(value);
		return decodeChild(value);
	};
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	assert.deepEqual(reservations, [s.reservation, s.reservation]);
	assert.deepEqual(children, [s.child]);
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 1);
}));

test("malformed live and persisted reservation descriptors cannot authorize another native effect", async () => {
	for (const persisted of [false, true]) {
		await scenario(async s => {
			s.control.withInputs = true;
			await s.reserve(s.identity);
			if (persisted) {
				assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
				const payload = s.journal.payload(s.reservation.attempt, "creation");
				assert.ok(isRecord(payload) && isRecord(payload.reservation));
				s.substitutePayload("creation", readJsonValue({ ...payload, reservation: { ...payload.reservation, delegationPrompt: "descriptor omitted" } }));
			} else {
				s.reservation.delegationPrompt = "descriptor omitted";
			}
			const trace = [...s.trace], receipts = s.record.receipts;
			const result = await s.makeDispatcher().dispatch(s.identity);
			assert.equal(result.state === "held" && result.code, "dispatch_inputs_changed");
			assert.deepEqual(s.trace, trace);
			assert.deepEqual(s.record.receipts, receipts);
		});
	}
});

test("input metadata without the owned producer resolver cannot create a consumer", () => scenario(async s => {
	s.control.withInputs = true;
	s.control.resolverAvailable = false;
	const result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state === "held" && result.code, "dispatch_input_resolver_unavailable");
	assert.equal(s.control.createCount, 0);
	assert.equal(s.record.receipts.length, 0);
}));

test("lost creation and handoff responses retain holds until exact owned receipts are reconciled", () => scenario(async s => {
	s.control.lose = "creation";
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.record.receipts[0].state, "uncertain");
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.control.createCount, 1);
	s.control.reconciled = readJsonValue(s.child);
	s.control.lose = "handoff";
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.control.messageCount, 1);
	s.control.reconciled = { sessionId: s.child.sessionId, accepted: true };
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 1);
}));

test("setup failure, incomplete inventory, aliases and dirty bootstrap hold without recreating", () => scenario(async s => {
	s.control.acknowledged = false;
	let result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state === "held" && result.code, "dispatch_setup_unconfirmed");
	s.control.acknowledged = true;
	s.control.completeInventory = false;
	result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state === "held" && result.code, "dispatch_inventory_ambiguous");
	s.control.completeInventory = true;
	s.control.aliases.push("ambiguous-child");
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	s.control.aliases = [s.child.sessionId];
	s.control.clean = false;
	result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state === "held" && result.code, "dispatch_bootstrap_drift");
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 0);
	assert.ok(!s.trace.includes("foundry_attach_task"));
}));

test("cancellation during create preserves late child receipt and forbids attachment/handoff", () => scenario(async s => {
	s.control.beforeCreateResult = s.cancel;
	const result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state, "held");
	assert.equal(s.record.phase, "cancelling");
	assert.equal(s.record.receipts[0].sessionId, s.child.sessionId);
	assert.equal(s.record.receipts[0].state, "succeeded");
	assert.ok(!s.trace.includes("foundry_attach_task"));
	assert.equal(s.control.messageCount, 0);
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.control.createCount, 1);
}));

test("permission rejection is durable and never replayed", () => scenario(async s => {
	/** @type {unknown[]} */
	const errors = [];
	const classifyError = s.native.classifyError;
	s.native.classifyError = error => {
		errors.push(error);
		return classifyError(error);
	};
	s.control.deny = "create_session";
	const first = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(first.state === "held" && first.code, "dispatch_permission_rejected");
	const receipt = s.record.receipts[0];
	assert.equal(receipt.state, "definitive-failure");
	assert.equal(errors.length, 1);
	assert.ok(errors[0] instanceof DispatchNativeError);
	const saved = s.journal.outcomes(s.reservation.attempt, receipt.id).at(-1);
	assert.ok(isRecord(saved));
	assert.deepEqual(saved.raw, errors[0].receipt);
	assert.deepEqual(saved.raw, { source: `coordinator/create_session/${receipt.id}`, raw: { resultType: "denied", textResultForLlm: "Permission denied" } });
	s.control.deny = null;
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.control.createCount, 0);
	assert.equal(s.trace.filter(name => name === "create_session").length, 1);
	assert.equal(errors.length, 1);
}));

test("activation denial retains its original claim and never replays or becomes task delivery", () => scenario(async s => {
	s.control.deny = "send_session_message";
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	const receipt = s.record.receipts.find(item => item.kind === "handoff");
	assert.equal(receipt?.state, "definitive-failure");
	const { plan } = await s.plans.status(s.identity.planId);
	const result = await s.makeDispatcher().complete({ identity: s.identity, terminalRunIds: [], request: {
		planId: s.identity.planId, taskId: s.identity.taskId, attemptId: s.reservation.attempt.attemptId,
		expectedRevision: plan.revision, status: "done", resultSummary: "Cannot deliver",
		branch: s.child.branch, commit: COMMIT, evidence: evidence("Not execution proof"),
	} });
	assert.equal(result.state === "held" && result.code, "dispatch_delivery_unconfirmed");
	s.control.deny = null;
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.trace.filter(name => name === "send_session_message").length, 1);
	assert.equal(s.trace.includes("foundry_complete_task"), false);
	assert.equal(s.control.createCount, 1);
}));

test("unknown and lookalike native failures stay uncertain without trusting forged receipts or retrying", async () => {
	const raw = { source: "retained native failure", raw: { resultType: "failure", textResultForLlm: "Outcome unknown" } };
	for (const fault of [
		new DispatchNativeError("dispatch_transport_uncertain", "Outcome unknown", "uncertain", raw),
		new DispatchNativeError("dispatch_capability_unavailable", "Route changed before invocation", "not-started", raw),
		Object.assign(new Error("Lookalike denial"), { code: "dispatch_permission_rejected", disposition: "definitive-failure", receipt: raw }),
		new Error("Unknown failure"),
	]) {
		await scenario(async s => {
			let calls = 0;
			s.native.create = async () => {
				calls++;
				assert.equal(s.record.receipts[0].state, "in-flight");
				throw fault;
			};
			assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
			const receipt = s.record.receipts[0];
			assert.equal(receipt.state, "uncertain");
			const saved = s.journal.outcomes(s.reservation.attempt, receipt.id).at(-1);
			assert.ok(isRecord(saved));
			assert.deepEqual(saved.raw, fault instanceof DispatchNativeError ? raw : null);
			assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
			assert.equal(calls, 1);
			assert.equal(s.control.createCount, 0);
			assert.equal(s.control.messageCount, 0);
		});
	}
});

test("matching native attachment after a revision conflict is reused, not retried", () => scenario(async s => {
	s.control.beforeAttach = async () => {
		s.control.beforeAttach = null;
		const { plan } = await s.plans.status(s.identity.planId);
		await s.operations.attachTask({ planId: s.identity.planId, taskId: s.identity.taskId, attemptId: s.reservation.attempt.attemptId,
			expectedRevision: plan.revision, sessionId: s.child.sessionId, branch: s.child.branch,
			bootstrap: { worktreePath: s.child.worktreePath, baseCommit: COMMIT } });
		const error = Object.assign(new Error("response raced another callback"), { code: "revision_conflict" });
		throw error;
	};
	const result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state, "handed-off", JSON.stringify(result));
	assert.equal(s.trace.filter(item => item === "foundry_attach_task").length, 1);
	assert.equal(s.control.messageCount, 1);
}));

test("cancel fence between preparation and start prevents the first native call", () => scenario(async s => {
	await s.reserve(s.identity);
	let calls = 0;
	s.control.beforeFence = () => {
		if (++calls === 2) {
			s.control.beforeFence = null;
			s.cancel();
		}
	};
	const result = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(result.state, "held");
	assert.equal(s.control.createCount, 0);
	assert.equal(s.record.receipts[0].state, "intent");
}));

test("resumed unstarted attachment never executes a renamed branch under the old payload digest", () => scenario(async s => {
	let calls = 0;
	s.control.beforeFence = () => {
		if (++calls === 5) {
			s.control.beforeFence = null;
			throw new Error("restart after attachment intent");
		}
	};
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	assert.equal(s.record.receipts.find(item => item.kind === "attachment")?.state, "intent");
	s.child.branch = "app-renamed-worker";
	const resumed = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(resumed.state === "held" && resumed.code, "dispatch_attachment_changed");
	assert.equal(s.trace.filter(item => item === "foundry_attach_task").length, 0);
	assert.equal(s.control.messageCount, 0);
}));

test("recovered success cannot bypass admission/journal agreement", () => scenario(async s => {
	s.control.lose = "handoff";
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "held");
	s.divergeReceipt("handoff", { state: "succeeded", sessionId: s.child.sessionId });
	const resumed = await s.makeDispatcher().dispatch(s.identity);
	assert.equal(resumed.state === "held" && resumed.code, "dispatch_journal_mismatch");
	assert.equal(s.record.receipts.find(item => item.kind === "handoff")?.state, "uncertain");
	assert.equal(s.control.messageCount, 1);
}));

test("successful replay revalidates the saved result and exact returned run identity", () => scenario(async s => {
	await s.reserve(s.identity);
	const spec = { name: "prepared", args: { input: "exact" } };
	assert.equal((await s.makeDispatcher().launch(s.reservation.attempt, spec)).state, "launched");
	s.substituteOutcome("workflow", { runId: "different-native-run" });
	const resumed = await s.makeDispatcher().launch(s.reservation.attempt, spec);
	assert.equal(resumed.state === "held" && resumed.code, "dispatch_receipt_mismatch");
	assert.equal(s.control.workflowCount, 1);
}));

test("replay rejects substituted saved creation results and attachment children without another invocation", () => scenario(async s => {
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	const payload = s.journal.payload(s.reservation.attempt, "attachment");
	assert.ok(isRecord(payload) && isRecord(payload.child));
	/** @type {[Record<string, Json>, string][]} */
	const creationChanges = [
		[{ sessionId: "substituted-child" }, "dispatch_receipt_mismatch"],
		[{ projectId: "substituted-project" }, "dispatch_child_mismatch"],
		[{ worktreePath: "relative/worktree" }, "dispatch_child_invalid"],
	];
	for (const [change, code] of creationChanges) {
		s.substituteOutcome("creation", readJsonValue({ ...s.child, ...change }));
		const result = await s.makeDispatcher().dispatch(s.identity);
		assert.equal(result.state === "held" && result.code, code);
	}
	s.substituteOutcome("creation", readJsonValue(s.child));
	/** @type {[Record<string, Json>, string][]} */
	const attachmentChanges = [
		[{ sessionId: "substituted-child" }, "dispatch_child_mismatch"],
		[{ projectId: "substituted-project" }, "dispatch_child_mismatch"],
		[{ creatorSessionId: "substituted-creator" }, "dispatch_child_mismatch"],
		[{ worktreePath: `${s.child.worktreePath}/substituted` }, "dispatch_child_mismatch"],
		[{ worktreePath: "relative/worktree" }, "dispatch_child_invalid"],
		[{ extra: true }, "factory_input_invalid"],
	];
	for (const [change, code] of attachmentChanges) {
		s.substitutePayload("attachment", readJsonValue({ ...payload, child: { ...payload.child, ...change } }));
		const result = await s.makeDispatcher().dispatch(s.identity);
		assert.equal(result.state === "held" && result.code, code);
	}
	assert.equal(s.control.createCount, 1);
	assert.equal(s.control.messageCount, 1);
	assert.equal(s.trace.filter(name => name === "foundry_attach_task").length, 1);
}));

test("workflow exact prepared launch, uncertainty and restart share one durable invocation slot", () => scenario(async s => {
	await s.reserve(s.identity);
	const spec = { name: "prepared", args: { immutable: ["inputs"] }, limits: { maxTotalSubagents: 2, maxAiCredits: 1 } };
	s.control.lose = "workflow";
	assert.equal((await s.makeDispatcher().launch(s.reservation.attempt, spec)).state, "held");
	assert.equal((await s.makeDispatcher().launch(s.reservation.attempt, spec)).state, "held");
	assert.equal(s.control.workflowCount, 1);
	s.control.reconciled = { runId: "native-run" };
	assert.equal((await s.makeDispatcher().launch(s.reservation.attempt, spec)).state, "launched");
	const changed = await s.makeDispatcher().launch(s.reservation.attempt, { ...spec, limits: { maxAiCredits: 9 } });
	assert.equal(changed.state === "held" && changed.code, "parallel_receipt_identity");
	assert.deepEqual(s.journal.payload(s.reservation.attempt, "workflow"), spec);
}));

for (const legacy of [false, true]) test(`${legacy ? "legacy full handoff" : "fresh short activation"} delivery and admission receipt precede any newly ready work`, () => scenario(async s => {
	s.control.legacy = legacy;
	assert.equal((await s.makeDispatcher().dispatch(s.identity)).state, "handed-off");
	const { plan } = await s.plans.status(s.identity.planId);
	const completion = { identity: s.identity, terminalRunIds: [], request: {
		planId: s.identity.planId, taskId: s.identity.taskId, attemptId: s.reservation.attempt.attemptId,
		expectedRevision: plan.revision, status: /** @type {const} */ ("done"), resultSummary: "Fixture completed",
		branch: s.child.branch, commit: COMMIT, evidence: evidence("Fixture delivery"),
	} };
	await s.makeDispatcher().runReady({ limit: 1, completions: [completion] });
	assert.equal(s.record.delivery?.commit, COMMIT);
	assert.ok(s.trace.indexOf("foundry_complete_task") < s.trace.indexOf("delivery-durable"));
	assert.ok(s.trace.indexOf("delivery-durable") < s.trace.indexOf("ready"));
	const repeated = await s.makeDispatcher().complete(completion);
	assert.equal(repeated.state, "delivered", JSON.stringify(repeated));
}));

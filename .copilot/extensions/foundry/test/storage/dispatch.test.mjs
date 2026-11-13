import assert from "node:assert/strict";
import test from "node:test";
import { parseJson } from "../../data.mjs";
import { analysisInputDigest, stableStringify } from "../../digest.mjs";
import { admissionRecord } from "../../plan/parallel-contracts.mjs";
import { createDispatchJournal, initializeDispatchJournal, readDispatchReceipts } from "../../storage/dispatch.mjs";
import { synchronousTransition } from "../../storage/parallel-protocol.mjs";
import { assertNoEffectsAfterFence, createEffectProbe, createParallelFixture } from "../parallel/fixture.mjs";

/** @typedef {import("node:sqlite").DatabaseSync} Database */
/** @typedef {import("../../types/parallel.js").AdmissionRecord} Admission */
/** @typedef {import("../../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../../types/parallel.js").Fence} Fence */
/** @typedef {import("../../types/parallel.js").FencedTransaction} Transaction */
/** @typedef {import("../../types/json.js").JsonValue} Json */

const at = "2026-11-13T05:00:00.000Z";
const later = "2026-11-13T05:01:00.000Z";

/** @returns {Admission} */
function initialAdmission() {
	const identity = {
		repositoryId: "a".repeat(64), owner: "dispatch-test-owner", planId: "dispatch-journal",
		taskId: "T-004", reservationId: "reserved-dispatch",
	};
	return {
		format: "foundry-admission-v1", identity, revision: 2, epoch: 0, phase: "reserved",
		attempt: { ...identity, attemptId: "T-004-A001" },
		resources: [{ id: "native-input", kind: "foreground-input", scope: "dispatch-host", mode: "exclusive", capacity: 1, units: 1 }],
		team: { id: "dispatch-team", capacity: 2, units: 1 },
		obligations: [], receipts: [], delivery: null, reservationFailure: null,
	};
}

function preparedPayload() {
	return {
		bootstrap: { branch: "reserved-base", commit: "b".repeat(40) },
		inputs: [
			{ producer: "alpha", output: "source", destination: "inputs/alpha.mjs", commit: "c".repeat(40), digest: "d".repeat(64) },
			{ producer: "beta", output: "data", destination: "inputs/beta.json", commit: "e".repeat(40), digest: "f".repeat(64) },
		],
		kickoff: { mode: "interactive", prompt: "Setup only; retain both pinned producer inputs." },
	};
}

/** @param {Admission} admission @returns {Fence} */
const fenceOf = (admission) => ({ admission: admission.identity, revision: admission.revision, epoch: admission.epoch });

/** @param {Admission} admission */
function authority(admission) {
	const { receipts, ...unchanged } = admission;
	return unchanged;
}

/** @param {Json} payload @param {Partial<Receipt>} [changes] @returns {Receipt} */
function intent(payload, changes = {}) {
	const attempt = initialAdmission().attempt;
	assert.ok(attempt);
	return {
		id: "create-child", attempt, kind: "creation", epoch: 0, payloadDigest: analysisInputDigest(payload),
		state: "intent", sessionId: null, runId: null, source: "dispatch-test", at, ...changes,
	};
}

/** @param {Receipt} receipt @returns {Receipt} */
const succeeded = (receipt) => ({
	...receipt, state: "succeeded", at: later,
	sessionId: receipt.kind === "workflow" ? null : "native-child",
	runId: receipt.kind === "workflow" ? "native-run" : null,
});

/** @param {Database} db */
const journalOn = (db) => createDispatchJournal({ read: operation => operation(db) });

/** The harness supplies only the admission-owned transaction and persisted record.
 * It does not implement dispatch policy, allocate claims, or invoke native services.
 * @param {import("node:test").TestContext} t */
function harness(t) {
	const fixture = createParallelFixture({
		name: "dispatch-journal",
		initialize(db) {
			initializeDispatchJournal(db);
			db.exec("CREATE TABLE IF NOT EXISTS dispatch_test_admission (id INTEGER PRIMARY KEY, document TEXT NOT NULL)");
		},
	});
	t.after(fixture.dispose);
	fixture.left.db.prepare("INSERT INTO dispatch_test_admission VALUES (1, ?)").run(stableStringify(initialAdmission()));
	const [left, right] = fixture.adapters(({ db }) => {
		function admission() {
			const row = db.prepare("SELECT document FROM dispatch_test_admission WHERE id = 1").get();
			assert.ok(row);
			const current = admissionRecord(parseJson(String(row.document)));
			if (current.attempt) current.receipts = readDispatchReceipts(db, current.attempt);
			return current;
		}
		/** @template T @param {(tx: Transaction) => T} operation @param {Fence} [expected] @returns {T} */
		function write(operation, expected) {
			db.exec("BEGIN IMMEDIATE");
			try {
				const current = admission();
				const result = synchronousTransition(() => operation({ db, admission: current, fence: expected ?? fenceOf(current) }));
				db.exec("COMMIT");
				return result;
			} catch (error) {
				if (db.isTransaction) db.exec("ROLLBACK");
				throw error;
			}
		}
		return { db, journal: journalOn(db), admission, write };
	});
	return { left, right };
}

test("intent, prepared producer inputs and start commit before the simulated native boundary", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload), probe = createEffectProbe();
	assert.deepEqual(right.journal.read(receipt.attempt), []);
	assert.equal(right.journal.payload(receipt.attempt, receipt.kind), null);
	assert.deepEqual(right.journal.outcomes(receipt.attempt, receipt.id), []);

	left.write(tx => {
		assert.deepEqual(left.journal.intent(tx, receipt), receipt);
		assert.deepEqual(tx.admission.receipts, [receipt]);
		assert.deepEqual(readDispatchReceipts(left.db, receipt.attempt), [receipt]);
		assert.deepEqual(right.journal.read(receipt.attempt), []);
		assert.throws(() => right.write(() => {}), (error) =>
			error instanceof Error && "errcode" in error && error.errcode === 5);
		assert.equal(right.db.isTransaction, false);
	});
	assert.deepEqual(right.journal.read(receipt.attempt), [receipt]);
	right.write(tx => {
		assert.deepEqual(right.journal.prepare(tx, receipt, payload), receipt);
		assert.deepEqual(right.journal.payload(receipt.attempt, receipt.kind), payload);
		assert.equal(left.journal.payload(receipt.attempt, receipt.kind), null);
	});
	assert.deepEqual(left.journal.payload(receipt.attempt, receipt.kind), payload);
	const started = left.write(tx => {
		const result = left.journal.start(tx, receipt.id);
		assert.deepEqual(tx.admission.receipts, [result]);
		assert.deepEqual(right.journal.read(receipt.attempt), [receipt]);
		assert.deepEqual(probe.observations, []);
		return result;
	});
	assert.equal(left.db.isTransaction, false);
	assert.equal(right.db.isTransaction, false);
	assert.equal(started.state, "in-flight");
	assert.deepEqual(readDispatchReceipts(right.db, receipt.attempt), [started]);
	assert.deepEqual(right.journal.payload(receipt.attempt, receipt.kind), payload);
	probe.nativeStart(started);
	assertNoEffectsAfterFence(probe.observations);
	assert.equal(probe.observations.length, 1);
});

test("duplicate starts cannot grant a second invocation, including after uncertainty and success", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload);
	left.write(tx => left.journal.prepare(tx, receipt, payload));
	const started = left.write(tx => {
		const result = left.journal.start(tx, receipt.id);
		assert.throws(() => left.journal.start(tx, receipt.id), { code: "dispatch_already_started" });
		return result;
	});
	/** @type {Receipt} */
	const uncertain = { ...started, state: "uncertain", at: later };
	for (const current of [started, uncertain, succeeded(started)]) {
		if (current !== started) left.write(tx => left.journal.recordOutcome(tx, current));
		assert.throws(() => right.write(tx => right.journal.start(tx, receipt.id)), { code: "dispatch_already_started" });
		assert.deepEqual(right.write(tx => right.journal.intent(tx, receipt)), current);
		assert.deepEqual(right.write(tx => right.journal.prepare(tx, receipt, payload)), current);
		assert.deepEqual(left.journal.read(receipt.attempt), [current]);
	}
});

test("same-kind preparation rejects changed identity or payload without replacing pinned inputs", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload);
	left.write(tx => left.journal.prepare(tx, receipt, payload));
	const reordered = { kickoff: payload.kickoff, inputs: payload.inputs, bootstrap: payload.bootstrap };
	assert.deepEqual(right.write(tx => right.journal.prepare(tx, receipt, reordered)), receipt);
	const substituted = preparedPayload();
	substituted.inputs[1].commit = "1".repeat(40);
	/** @type {{receipt: Receipt, payload: Json, code: string}[]} */
	const conflicts = [
		{ receipt: { ...receipt, id: "replacement-create" }, payload, code: "parallel_receipt_identity" },
		{ receipt, payload: substituted, code: "parallel_receipt_identity" },
		{ receipt: { ...receipt, payloadDigest: analysisInputDigest(substituted) }, payload: substituted, code: "parallel_receipt_identity" },
		{ receipt: { ...receipt, epoch: 1 }, payload, code: "dispatch_intent_invalid" },
		{ receipt: { ...receipt, attempt: { ...receipt.attempt, attemptId: "T-004-A002" } }, payload, code: "parallel_foreign_owner" },
		{ receipt: { ...receipt, attempt: { ...receipt.attempt, owner: "foreign-owner" } }, payload, code: "parallel_foreign_owner" },
	];
	for (const conflict of conflicts) {
		assert.throws(() => right.write(tx => right.journal.prepare(tx, conflict.receipt, conflict.payload)), { code: conflict.code });
		assert.deepEqual(left.journal.read(receipt.attempt), [receipt]);
		assert.deepEqual(left.journal.payload(receipt.attempt, receipt.kind), payload);
	}
	const foreign = { ...receipt.attempt, attemptId: "T-004-A002" };
	assert.deepEqual(right.journal.read(foreign), []);
	assert.equal(right.journal.payload(foreign, receipt.kind), null);
	assert.deepEqual(right.journal.outcomes(foreign, receipt.id), []);
});

test("outcomes cannot bypass start, change effect identity, or replace a known native identity", (t) => {
	const { left, right } = harness(t);
	const receipt = intent(preparedPayload());
	left.write(tx => left.journal.intent(tx, receipt));
	assert.throws(() => right.write(tx => right.journal.recordOutcome(tx, succeeded(receipt))), { code: "parallel_effect_transition" });
	const started = left.write(tx => left.journal.start(tx, receipt.id));
	/** @type {{change: Partial<Receipt>, code: string}[]} */
	const invalid = [
		{ change: { state: "intent", sessionId: null }, code: "dispatch_outcome_invalid" },
		{ change: { state: "in-flight", sessionId: null }, code: "dispatch_outcome_invalid" },
		{ change: { id: "missing-intent" }, code: "dispatch_intent_missing" },
		{ change: { kind: "attachment" }, code: "parallel_receipt_identity" },
		{ change: { payloadDigest: "1".repeat(64) }, code: "parallel_receipt_identity" },
		{ change: { epoch: 1 }, code: "parallel_receipt_identity" },
		{ change: { attempt: { ...receipt.attempt, attemptId: "T-004-A002" } }, code: "parallel_foreign_owner" },
		{ change: { at: "2026-11-13T04:59:00.000Z" }, code: "parallel_effect_transition" },
	];
	for (const { change, code } of invalid) {
		assert.throws(() => right.write(tx => right.journal.recordOutcome(tx, { ...succeeded(started), ...change })), { code });
		assert.deepEqual(left.journal.read(receipt.attempt), [started]);
	}
	/** @type {Receipt} */
	const uncertain = { ...started, state: "uncertain", sessionId: "native-child", at: later };
	right.write(tx => right.journal.recordOutcome(tx, uncertain));
	assert.throws(() => left.write(tx => left.journal.recordOutcome(tx, { ...succeeded(uncertain), sessionId: "different-child" })), { code: "parallel_receipt_identity" });
	assert.deepEqual(right.journal.read(receipt.attempt), [uncertain]);
	assert.deepEqual(left.write(tx => left.journal.recordOutcome(tx, succeeded(uncertain))), succeeded(uncertain));
});

test("a committed cancellation rejects stale and fresh starts but retains late outcomes under its new fence", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), creation = intent(payload);
	const workflow = intent(payload, { id: "run-workflow", kind: "workflow" });
	const probe = createEffectProbe(), oldFence = fenceOf(left.admission());
	const started = left.write(tx => {
		left.journal.prepare(tx, creation, payload);
		left.journal.prepare(tx, workflow, payload);
		return left.journal.start(tx, creation.id);
	});
	probe.nativeStart(started);
	const before = left.admission();
	right.write(tx => {
		tx.admission.phase = "cancelling";
		tx.admission.revision += 1;
		tx.admission.epoch += 1;
		tx.admission.obligations = [{
			attempt: creation.attempt, sessionId: null, runIds: [], pendingEffectIds: [creation.id, workflow.id],
			disposition: "unresolved", inventory: null, terminatedRunIds: [],
		}];
		tx.db.prepare("UPDATE dispatch_test_admission SET document = ? WHERE id = 1").run(stableStringify(tx.admission));
	});
	const cancelled = left.admission();
	probe.fence(cancelled);
	const attachment = intent(payload, { id: "attach-child", kind: "attachment", epoch: cancelled.epoch });
	assert.throws(() => left.write(tx => left.journal.start(tx, workflow.id), oldFence), { code: "revision_conflict" });
	assert.throws(() => left.write(tx => left.journal.recordOutcome(tx, succeeded(started)), oldFence), { code: "revision_conflict" });
	assert.throws(() => left.write(tx => left.journal.start(tx, workflow.id)), { code: "parallel_fenced" });
	assert.throws(() => left.write(tx => left.journal.intent(tx, attachment)), { code: "parallel_fenced" });
	assert.throws(() => left.write(tx => left.journal.prepare(tx, attachment, payload)), { code: "parallel_fenced" });
	const lateResult = { session_id: "native-child", acknowledgedAfterCancellation: true };
	left.write(tx => left.journal.recordResult(tx, succeeded(started), lateResult));
	/** @type {Receipt} */
	const neverStarted = { ...workflow, state: "cancelled-before-start", at: later };
	right.write(tx => right.journal.recordOutcome(tx, neverStarted));
	const after = right.admission();
	assert.deepEqual(after.receipts, [succeeded(started), neverStarted]);
	assert.deepEqual(right.journal.outcomes(creation.attempt, creation.id), [lateResult]);
	assert.deepEqual(authority(after), authority(cancelled), "The journal must not settle obligations or release claims");
	assert.deepEqual(after.resources, before.resources);
	assert.deepEqual(after.team, before.team);
	assertNoEffectsAfterFence(probe.observations);
});

test("fresh journal construction recovers exact prepared payload, receipt and deduplicated ordered results", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload);
	const started = left.write(tx => {
		left.journal.prepare(tx, receipt, payload);
		return left.journal.start(tx, receipt.id);
	});
	/** @type {Receipt} */
	const uncertain = { ...started, state: "uncertain", at: later };
	const lostResponse = { transport: "response-lost", evidence: { complete: false, ids: [] } };
	left.write(tx => left.journal.recordResult(tx, uncertain, lostResponse));
	const restarted = journalOn(right.db);
	assert.deepEqual(restarted.read(receipt.attempt), [uncertain]);
	assert.deepEqual(restarted.payload(receipt.attempt, receipt.kind), payload);
	assert.deepEqual(restarted.outcomes(receipt.attempt, receipt.id), [lostResponse]);
	right.write(tx => restarted.recordResult(tx, uncertain, { evidence: lostResponse.evidence, transport: lostResponse.transport }));
	const completed = succeeded(uncertain);
	const result = { session_id: completed.sessionId, evidence: { complete: true, source: "authoritative-inventory" } };
	right.write(tx => restarted.recordResult(tx, completed, result));
	left.write(tx => left.journal.recordResult(tx, completed, structuredClone(result)));
	left.db.close();
	const recovered = journalOn(right.db);
	assert.deepEqual(recovered.read(receipt.attempt), [completed]);
	assert.deepEqual(recovered.payload(receipt.attempt, receipt.kind), payload);
	assert.deepEqual(recovered.outcomes(receipt.attempt, receipt.id), [lostResponse, result]);
	initializeDispatchJournal(right.db);
	assert.deepEqual(readDispatchReceipts(right.db, receipt.attempt), [completed]);
	assert.deepEqual(recovered.outcomes(receipt.attempt, receipt.id), [lostResponse, result]);
});

test("all journal writes require an active admission writer transaction", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload);
	left.write(tx => left.journal.prepare(tx, receipt, payload));
	const current = right.admission(), tx = { db: right.db, admission: current, fence: fenceOf(current) };
	const operations = [
		() => right.journal.intent(tx, receipt),
		() => right.journal.prepare(tx, receipt, payload),
		() => right.journal.start(tx, receipt.id),
		() => right.journal.recordOutcome(tx, succeeded(receipt)),
		() => right.journal.recordResult(tx, succeeded(receipt), { session_id: "native-child" }),
	];
	for (const operation of operations) {
		assert.throws(operation, { code: "dispatch_transaction_required" });
		assert.equal(right.db.isTransaction, false);
		assert.deepEqual(left.journal.read(receipt.attempt), [receipt]);
		assert.deepEqual(left.journal.payload(receipt.attempt, receipt.kind), payload);
		assert.deepEqual(left.journal.outcomes(receipt.attempt, receipt.id), []);
	}
});

test("divergent admission receipts reject writes without replacing either snapshot; ordering alone is harmless", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), creation = intent(payload);
	const workflow = intent(payload, { id: "run-workflow", kind: "workflow" });
	const attachment = intent(payload, { id: "attach-child", kind: "attachment" });
	const startedWorkflow = left.write(tx => {
		left.journal.prepare(tx, creation, payload);
		left.journal.prepare(tx, workflow, payload);
		return left.journal.start(tx, workflow.id);
	});
	const persisted = [creation, startedWorkflow];
	/** @type {Receipt[][]} */
	const divergent = [
		[creation],
		[{ ...creation, state: "in-flight" }, startedWorkflow],
		[...persisted, attachment],
	];
	/** @type {((tx: Transaction) => unknown)[]} */
	const operations = [
		tx => right.journal.intent(tx, attachment),
		tx => right.journal.prepare(tx, attachment, payload),
		tx => right.journal.start(tx, creation.id),
		tx => right.journal.recordOutcome(tx, succeeded(startedWorkflow)),
		tx => right.journal.recordResult(tx, succeeded(startedWorkflow), { run_id: "native-run" }),
	];
	for (const snapshot of divergent) {
		for (const operation of operations) {
			right.write(tx => {
				tx.admission.receipts = structuredClone(snapshot);
				const before = structuredClone(tx.admission);
				assert.throws(() => operation(tx), { code: "dispatch_journal_mismatch" });
				assert.deepEqual(tx.admission, before, "Rejection must not silently hydrate the divergent admission");
				assert.deepEqual(readDispatchReceipts(right.db, creation.attempt), persisted);
				assert.equal(right.journal.payload(creation.attempt, attachment.kind), null);
				assert.deepEqual(right.journal.outcomes(workflow.attempt, workflow.id), []);
			});
			assert.deepEqual(left.journal.read(creation.attempt), persisted);
		}
	}
	const startedCreation = right.write(tx => {
		tx.admission.receipts.reverse();
		return right.journal.start(tx, creation.id);
	});
	assert.equal(startedCreation.state, "in-flight");
	assert.deepEqual(left.journal.read(creation.attempt), [startedCreation, startedWorkflow]);
});

test("rolled-back preparation leaves no intent or payload and another connection can retry", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload), fault = new Error("after preparation");
	assert.throws(() => left.write(tx => {
		left.journal.prepare(tx, receipt, payload);
		left.journal.start(tx, receipt.id);
		assert.equal(left.journal.read(receipt.attempt)[0].state, "in-flight");
		assert.deepEqual(left.journal.payload(receipt.attempt, receipt.kind), payload);
		assert.deepEqual(right.journal.read(receipt.attempt), []);
		assert.equal(right.journal.payload(receipt.attempt, receipt.kind), null);
		throw fault;
	}), error => error === fault);
	for (const connection of [left, right]) {
		assert.deepEqual(connection.journal.read(receipt.attempt), []);
		assert.equal(connection.journal.payload(receipt.attempt, receipt.kind), null);
		assert.deepEqual(connection.journal.outcomes(receipt.attempt, receipt.id), []);
	}
	assert.deepEqual(right.write(tx => right.journal.prepare(tx, receipt, payload)), receipt);
	assert.deepEqual(left.journal.read(receipt.attempt), [receipt]);
});

test("a rolled-back start retains the prepared intent for a competing connection", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload), fault = new Error("after start");
	left.write(tx => left.journal.prepare(tx, receipt, payload));
	assert.throws(() => left.write(tx => {
		left.journal.start(tx, receipt.id);
		assert.deepEqual(right.journal.read(receipt.attempt), [receipt]);
		throw fault;
	}), error => error === fault);
	assert.deepEqual(left.journal.read(receipt.attempt), [receipt]);
	assert.deepEqual(right.journal.payload(receipt.attempt, receipt.kind), payload);
	const started = right.write(tx => right.journal.start(tx, receipt.id));
	assert.equal(started.state, "in-flight");
	assert.deepEqual(left.journal.read(receipt.attempt), [started]);
});

test("result persistence failure rolls back the receipt transition and permits an exact retry", (t) => {
	const { left, right } = harness(t);
	const payload = preparedPayload(), receipt = intent(payload);
	const started = left.write(tx => {
		left.journal.prepare(tx, receipt, payload);
		return left.journal.start(tx, receipt.id);
	});
	left.db.exec("CREATE TRIGGER dispatch_test_result_failure BEFORE INSERT ON dispatch_outcomes BEGIN SELECT RAISE(ABORT, 'injected result failure'); END");
	const completed = succeeded(started), result = { session_id: "native-child" };
	assert.throws(() => left.write(tx => left.journal.recordResult(tx, completed, result)), /injected result failure/);
	assert.equal(left.db.isTransaction, false);
	assert.deepEqual(right.journal.read(receipt.attempt), [started]);
	assert.deepEqual(right.journal.outcomes(receipt.attempt, receipt.id), []);
	assert.deepEqual(right.journal.payload(receipt.attempt, receipt.kind), payload);
	right.db.exec("DROP TRIGGER dispatch_test_result_failure");
	assert.deepEqual(right.write(tx => right.journal.recordResult(tx, completed, result)), completed);
	assert.deepEqual(left.journal.read(receipt.attempt), [completed]);
	assert.deepEqual(left.journal.outcomes(receipt.attempt, receipt.id), [result]);
});

test("journal initialization and every effect kind preserve admission claims, reservation and authority", (t) => {
	const { left, right } = harness(t);
	const before = left.admission();
	const persisted = left.db.prepare("SELECT document FROM dispatch_test_admission WHERE id = 1").get();
	/** @type {Receipt["kind"][]} */
	const kinds = ["creation", "attachment", "handoff", "workflow"];
	/** @type {Receipt[]} */
	const completed = [];
	for (const kind of kinds) {
		const payload = { kind, inputs: preparedPayload().inputs };
		const receipt = intent(payload, { kind, id: `effect-${kind}` });
		left.write(tx => {
			left.journal.intent(tx, receipt);
			left.journal.prepare(tx, receipt, payload);
			const started = left.journal.start(tx, receipt.id);
			const outcome = succeeded(started);
			left.journal.recordOutcome(tx, outcome);
			left.journal.recordResult(tx, outcome, { sessionId: outcome.sessionId, runId: outcome.runId });
			completed.push(outcome);
			assert.deepEqual(tx.admission.receipts, completed);
			assert.deepEqual(authority(tx.admission), authority(before));
		});
	}
	initializeDispatchJournal(right.db);
	assert.deepEqual(right.db.prepare("SELECT document FROM dispatch_test_admission WHERE id = 1").get(), persisted);
	assert.deepEqual(authority(right.admission()), authority(before));
	assert.ok(before.attempt);
	assert.deepEqual(readDispatchReceipts(right.db, before.attempt), completed);
	assert.deepEqual(right.journal.read(before.attempt), completed);
});

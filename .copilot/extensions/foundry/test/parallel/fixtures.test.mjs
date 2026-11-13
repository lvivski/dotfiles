import assert from "node:assert/strict";
import test from "node:test";
import { parseJson } from "../../data.mjs";
import { admissionRecord } from "../../plan/parallel-contracts.mjs";
import { assertAdmissionFence } from "../../storage/parallel-protocol.mjs";
import {
	assertExclusiveClaims, assertNoEffectsAfterFence, assertSqliteWriterIsolation,
	assertUncertainEffectsRetained, createEffectProbe, createFaultSchedule, createParallelFixture,
} from "./fixture.mjs";

/** @typedef {import("../../types/parallel.js").AdmissionRecord} AdmissionRecord */
/** @typedef {import("../../types/parallel.js").EffectReceipt} EffectReceipt */

/** @param {string} [taskId] @returns {AdmissionRecord} */
function reserved(taskId = "T-001") {
	const identity = { repositoryId: "a".repeat(64), owner: "fixture-owner", planId: "fixture-plan", taskId, reservationId: `reservation-${taskId}` };
	return {
		format: "foundry-admission-v1", identity, revision: 1, epoch: 0, phase: "reserved",
		attempt: { ...identity, attemptId: `${taskId}-A001` },
		resources: [{ id: "shared-output", kind: "shared-write", scope: "fixture-output", mode: "exclusive", capacity: 1, units: 1 }],
		team: { id: "fixture-team", capacity: 2, units: 1 }, obligations: [], receipts: [], delivery: null, reservationFailure: null,
	};
}

/** @param {AdmissionRecord} record @param {"creation" | "handoff"} kind @returns {EffectReceipt} */
function receipt(record, kind) {
	assert.ok(record.attempt);
	return {
		id: `${kind}-effect`, attempt: record.attempt, kind, epoch: record.epoch,
		payloadDigest: "b".repeat(64), state: "in-flight", sessionId: null, runId: null,
		source: "test-only-native-observation", at: "2026-11-12T00:00:00.000Z",
	};
}

/** Test-only supplied snapshot, not an implementation of cancellation or recovery.
 * @param {AdmissionRecord} before @returns {AdmissionRecord} */
function cancellationSnapshot(before) {
	assert.ok(before.attempt);
	return {
		...structuredClone(before), revision: before.revision + 1, epoch: before.epoch + 1, phase: "cancelling",
		obligations: [{
			attempt: before.attempt, sessionId: before.receipts.find(item => item.sessionId)?.sessionId ?? null,
			runIds: [], pendingEffectIds: before.receipts.filter(item => item.state === "in-flight" || item.state === "uncertain").map(item => item.id),
			disposition: "unresolved", inventory: null, terminatedRunIds: [],
		}],
	};
}

/**
 * Test-only snapshot adapter. It persists caller-supplied documents, never allocates claims,
 * starts native work, or decides cancellation/recovery. The fixture accepts real ports instead.
 * @param {import("./fixture.mjs").FixtureConnection} connection
 */
function snapshotAdapter(connection) {
	const { db } = connection;
	db.exec("CREATE TABLE IF NOT EXISTS fixture_snapshots (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL)");
	const key = (/** @type {import("../../types/parallel.js").AdmissionIdentity} */ identity) =>
		JSON.stringify([identity.repositoryId, identity.owner, identity.planId, identity.taskId, identity.reservationId]);
	/** @type {Pick<import("../../types/parallel.js").AdmissionPort, "read" | "withFence">} */
	const admission = {
		read(identity) {
			const row = db.prepare("SELECT document FROM fixture_snapshots WHERE id = ?").get(key(identity));
			if (!row) return null;
			assert.ok(typeof row.document === "string");
			return admissionRecord(parseJson(row.document));
		},
		withFence(fence, operation) {
			db.exec("BEGIN IMMEDIATE");
			try {
				const current = admission.read(fence.admission);
				assert.ok(current);
				assertAdmissionFence(current, fence);
				const result = operation({ db, admission: current, fence });
				assert.ok(!result || (typeof result !== "object" && typeof result !== "function") || !("then" in result));
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return {
		admission,
		/** @param {AdmissionRecord} document */
		publish(document) {
			db.prepare("INSERT INTO fixture_snapshots VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, document = excluded.document")
				.run(key(document.identity), document.revision, JSON.stringify(document));
		},
	};
}

test("isolated scenarios use two connections to one database, with real writer overlap, rollback and stale CAS", (t) => {
	const fixture = createParallelFixture({ name: "writer-overlap" });
	t.after(fixture.dispose);
	const unrelated = createParallelFixture({ name: "writer-overlap" });
	t.after(unrelated.dispose);
	assert.notEqual(fixture.databasePath, unrelated.databasePath);
	assert.notEqual(fixture.left.db, fixture.right.db);
	const [left, right] = fixture.adapters(snapshotAdapter);
	const [other] = unrelated.adapters(snapshotAdapter);
	const document = reserved();
	left.publish(document);
	assert.deepEqual(right.admission.read(document.identity), document);
	assert.equal(other.admission.read(document.identity), null);
	assertSqliteWriterIsolation(fixture);
	assertSqliteWriterIsolation(unrelated);
	const fence = { admission: document.identity, revision: document.revision, epoch: document.epoch };
	assert.throws(() => left.admission.withFence(fence, () => {
		left.publish({ ...document, revision: 2 });
		throw new Error("test-only rollback fault");
	}), /test-only rollback fault/);
	assert.deepEqual(right.admission.read(document.identity), document);
	left.publish({ ...document, revision: 2 });
	let reached = false;
	assert.throws(() => right.admission.withFence(fence, () => { reached = true; }), { code: "revision_conflict" });
	assert.equal(reached, false);
	assert.equal(right.admission.read(document.identity)?.revision, 2);
});

test("independent claim oracle catches competing exclusive holders, including renamed labels and unreleased settlement", () => {
	const first = reserved(), second = reserved("T-002");
	assert.throws(() => assertExclusiveClaims([first, second]), /Duplicate exclusive claim/);
	second.resources[0].id = "different-label-for-same-output";
	assert.throws(() => assertExclusiveClaims([first, second]), /Duplicate exclusive claim/);
	assert.throws(() => assertExclusiveClaims([{ ...first, phase: "settled" }, second]), /Duplicate exclusive claim/);
	assertExclusiveClaims([{ ...first, phase: "released" }, second]);
	assertExclusiveClaims([first, { ...second, identity: { ...second.identity, repositoryId: "c".repeat(64) } }]);
});

/** @type {("creation" | "handoff")[]} */
const effectKinds = ["creation", "handoff"];
for (const kind of effectKinds) {
	test(`explicit cancellation schedule catches ${kind} after a committed fence`, (t) => {
		const fixture = createParallelFixture({ name: `${kind}-fenced` });
		t.after(fixture.dispose);
		const [left, right] = fixture.adapters(snapshotAdapter);
		const before = reserved();
		left.publish(before);
		const probe = createEffectProbe();
		const schedule = createFaultSchedule([{
			checkpoint: "before-native-start",
			action() {
				right.publish(cancellationSnapshot(before));
				const committed = right.admission.read(before.identity);
				assert.ok(committed);
				probe.fence(committed);
			},
		}]);
		schedule.checkpoint("before-native-start");
		const fence = { admission: before.identity, revision: before.revision, epoch: before.epoch };
		assert.throws(() => left.admission.withFence(fence, () => probe.nativeStart(receipt(before, kind))), { code: "revision_conflict" });
		const cancelled = left.admission.read(before.identity);
		assert.ok(cancelled);
		const freshFence = { admission: cancelled.identity, revision: cancelled.revision, epoch: cancelled.epoch };
		assert.throws(() => left.admission.withFence(freshFence, () => probe.nativeStart(receipt(before, kind))), { code: "parallel_fenced" });
		assertNoEffectsAfterFence(probe.observations);
		schedule.assertComplete();
		// An adapter bypassing the fence must fail the independent oracle.
		probe.nativeStart(receipt(before, kind));
		assert.throws(() => assertNoEffectsAfterFence(probe.observations), /started after cancellation fence/);
	});

	test(`lost ${kind} response retains durable uncertainty and claims across cancellation`, (t) => {
		const fixture = createParallelFixture({ name: `${kind}-uncertain` });
		t.after(fixture.dispose);
		const [left, right] = fixture.adapters(snapshotAdapter);
		const before = reserved();
		const started = receipt(before, kind);
		before.receipts = [started];
		if (kind === "handoff") before.receipts.unshift({ ...receipt(before, "creation"), state: "succeeded", sessionId: "created-session" });
		left.publish(before);
		const probe = createEffectProbe();
		const lostResponse = new Error(`test-only ${kind} response lost`);
		const schedule = createFaultSchedule([
			{ checkpoint: "native-invoked", action: () => probe.nativeStart(started) },
			{
				checkpoint: "cancel",
				action() {
					const current = right.admission.read(before.identity);
					assert.ok(current);
					right.publish(cancellationSnapshot(current));
					const cancelled = right.admission.read(before.identity);
					assert.ok(cancelled);
					probe.fence(cancelled);
				},
			},
			{ checkpoint: "response-lost", fault: lostResponse },
		]);
		schedule.checkpoint("native-invoked");
		schedule.checkpoint("cancel");
		const inFlight = left.admission.read(before.identity);
		assert.ok(inFlight);
		assertUncertainEffectsRetained(before, inFlight);
		assert.throws(() => schedule.checkpoint("response-lost"), error => error === lostResponse);
		const uncertain = structuredClone(before);
		for (const item of uncertain.receipts) {
			if (item.id === started.id) item.state = "uncertain";
		}
		left.publish({ ...inFlight, revision: inFlight.revision + 1, receipts: uncertain.receipts });
		const retained = right.admission.read(before.identity);
		assert.ok(retained);
		assertUncertainEffectsRetained(uncertain, retained);
		assertNoEffectsAfterFence(probe.observations);
		schedule.assertComplete();
		assert.throws(() => assertUncertainEffectsRetained(uncertain, { ...retained, resources: [] }), /lost resource/);
		assert.throws(() => assertUncertainEffectsRetained(uncertain, { ...retained, obligations: [] }), /lost obligation/);
		assert.throws(() => assertUncertainEffectsRetained(uncertain, { ...retained, receipts: [] }), /lost unresolved receipt/);
		assert.throws(() => assertUncertainEffectsRetained(uncertain, { ...retained, phase: "released" }), /keep the admission cancelling/);
		const dropped = structuredClone(retained);
		dropped.obligations[0].pendingEffectIds = [];
		assert.throws(() => assertUncertainEffectsRetained(uncertain, dropped), /lost pending effect/);
		if (kind === "handoff") {
			const lostSession = structuredClone(retained);
			lostSession.obligations[0].sessionId = null;
			assert.throws(() => assertUncertainEffectsRetained(uncertain, lostSession), /lost the known native session/);
		}
	});
}

test("fault checkpoints reject omissions and reordering and consume thrown faults exactly once", () => {
	const schedule = createFaultSchedule([{ checkpoint: "intent" }, { checkpoint: "outcome", fault: new Error("response lost") }]);
	assert.throws(() => schedule.checkpoint("outcome"), /Out-of-order/);
	assert.deepEqual(schedule.visited, []);
	assert.throws(() => schedule.assertComplete(), /unconsumed/);
	schedule.checkpoint("intent");
	assert.throws(() => schedule.checkpoint("outcome"), /response lost/);
	schedule.assertComplete();
	assert.throws(() => schedule.checkpoint("outcome"), /Unexpected checkpoint/);
});

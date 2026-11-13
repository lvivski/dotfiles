import assert from "node:assert/strict";
import test from "node:test";
import { createAdmissionStore, admissionFence } from "../../storage/admission.mjs";
import { createParallelFixture, createFaultSchedule, createEffectProbe, assertExclusiveClaims, assertNoEffectsAfterFence, assertUncertainEffectsRetained } from "../parallel/fixture.mjs";

const REPO = "a".repeat(64), OWNER = "/fixture/owner", NOW = "2026-11-13T00:00:00.000Z";
/** @param {string} [taskId] @param {string} [owner] */
const identity = (taskId = "T-001", owner = OWNER) => ({ repositoryId: REPO, owner, planId: "admission-test", taskId, reservationId: `reserve-${taskId}` });
/** @param {string} [scope] @returns {import("../../types/parallel.js").ResourceClaim} */
const resource = (scope = "/fixture/output") => ({ id: "output", kind: "shared-write", scope, mode: "exclusive", capacity: 1, units: 1 });
/** @param {ReturnType<typeof createParallelFixture>} fixture @param {string} [owner] */
const storeFor = (fixture, owner = OWNER) => createAdmissionStore({
	workspacePath: fixture.workspacePath, repositoryId: REPO, owner, directoryParts: ["files", "foundry"], busyTimeoutMs: 1, clock: () => NOW,
});
/** @param {ReturnType<typeof createAdmissionStore>} store @param {string} [taskId] */
function reserved(store, taskId = "T-001") {
	const held = store.claim({ identity: identity(taskId), expectedRevision: 0, resources: [resource()], team: { id: "engineers", capacity: 2, units: 1 } });
	return store.bindReservation(admissionFence(held), { ...held.identity, attemptId: `${taskId}-A001` });
}
/** @param {ReturnType<typeof createAdmissionStore>} store */
const read = (store) => {
	const record = store.read(identity());
	assert.ok(record);
	return record;
};
/** @param {import("../../types/parallel.js").AdmissionRecord} record @returns {import("../../types/parallel.js").EffectReceipt} */
function intent(record) {
	assert.ok(record.attempt);
	return { id: "create-child", attempt: record.attempt, kind: "creation", epoch: record.epoch, payloadDigest: "b".repeat(64),
		state: "intent", sessionId: null, runId: null, source: "fixture native invocation", at: NOW };
}
/** @param {ReturnType<typeof createAdmissionStore>} store @param {import("../../types/parallel.js").EffectReceipt["state"]} state
 * @param {Partial<import("../../types/parallel.js").EffectReceipt>} [extra] */
function outcome(store, state, extra = {}) {
	store.withFence(admissionFence(read(store)), ({ admission }) => {
		admission.receipts[0] = { ...admission.receipts[0], state, ...extra };
	});
}

test("PF-ADM-03 separate connections serialize exclusive claims, survive restart and bind exact owners", () => {
	const fixture = createParallelFixture({ name: "claim-race" });
	try {
		const left = storeFor(fixture), right = storeFor(fixture, "/fixture/other");
		const request = { identity: identity(), expectedRevision: 0, resources: [resource()], team: null };
		const held = left.claim(request);
		assert.deepEqual(left.claim(request), held);
		const other = { ...request, identity: identity("T-002", "/fixture/other"), resources: [{ ...resource("/fixture/./OUTPUT"), id: "different-label" }] };
		assert.throws(() => right.claim(other), { code: "parallel_capacity_held" });
		assert.throws(() => right.cancel(admissionFence(held)), { code: "parallel_foreign_owner" });
		assert.throws(() => left.claim({ ...request, resources: [] }), { code: "parallel_claim_mismatch" });
		assert.throws(() => left.claim({ ...request, identity: { ...identity("T-002"), reservationId: request.identity.reservationId } }), { code: "parallel_identity_mismatch" });
		assert.throws(() => left.bindReservation(admissionFence(held), { ...identity("T-002"), attemptId: "T-002-A001" }), { code: "parallel_identity_mismatch" });
		const reopened = storeFor(fixture);
		assert.deepEqual(reopened.read(identity()), held);
		assert.throws(() => reopened.release(admissionFence(held)), { code: "parallel_unsafe_release" });
		const failed = reopened.failReservation(admissionFence(held), { source: "definitive reservation rejection, no request in flight", at: NOW });
		assert.throws(() => right.claim(other), { code: "parallel_capacity_held" }, "Settled but unreleased is still occupied");
		const released = reopened.release(admissionFence(failed));
		assert.deepEqual(reopened.release(admissionFence(failed)), released);
		assert.throws(() => reopened.claim(request), { code: "parallel_fenced" });
		right.claim(other);
		assertExclusiveClaims(right.list());
	} finally { fixture.dispose(); }
});

test("PF-ADM-04 writer interleavings, rollback, stale revisions and reservation response loss remain fenced", () => {
	const fixture = createParallelFixture({ name: "fenced-interleaving" });
	try {
		const left = storeFor(fixture), right = storeFor(fixture);
		const active = reserved(left);
		const schedule = createFaultSchedule([
			{ checkpoint: "writer-held", action() {
				assert.throws(() => right.cancel(admissionFence(active)), { code: "storage_busy" });
				assert.equal(right.read(identity())?.revision, active.revision);
			} },
			{ checkpoint: "before-commit", fault: new Error("injected crash") },
		]);
		assert.throws(() => left.withFence(admissionFence(active), ({ admission }) => {
			admission.receipts.push(intent(admission));
			schedule.checkpoint("writer-held");
			schedule.checkpoint("before-commit");
		}), /injected crash/);
		schedule.assertComplete();
		assert.deepEqual(read(left), active);
		left.withFence(admissionFence(active), ({ admission }) => admission.receipts.push(intent(admission)));
		assert.throws(() => right.cancel(admissionFence(active)), { code: "revision_conflict" });
		const latest = read(right);
		right.cancel(admissionFence(latest));
		assert.throws(() => left.withFence(admissionFence(latest), () => {}), { code: "revision_conflict" });
		const unbound = left.claim({ identity: identity("T-002"), expectedRevision: 0, resources: [resource("/separate")], team: null });
		const cancelled = left.cancel(admissionFence(unbound));
		assert.throws(() => left.release(admissionFence(cancelled)), { code: "parallel_unsafe_release" });
		const late = left.bindReservation(admissionFence(cancelled), { ...cancelled.identity, attemptId: "T-002-A001" });
		assert.equal(late.phase, "cancelling", "Late exact reservation must not reopen execution");
		assert.throws(() => left.withFence(admissionFence(late), ({ admission }) => admission.receipts.push(intent(admission))), { code: "parallel_fenced" });
		assertExclusiveClaims(left.list());
	} finally { fixture.dispose(); }
});

test("PF-ADM-03/04 cancellation retains uncertain creation, late identities and all native run obligations", () => {
	const fixture = createParallelFixture({ name: "uncertain-native-effect" });
	try {
		const store = storeFor(fixture), probe = createEffectProbe();
		const active = reserved(store);
		store.withFence(admissionFence(active), ({ admission }) => admission.receipts.push(intent(admission)));
		outcome(store, "in-flight");
		probe.nativeStart(read(store).receipts[0]);
		outcome(store, "uncertain");
		const before = read(store);
		const cancelled = store.cancel(admissionFence(before));
		probe.fence(cancelled);
		assertUncertainEffectsRetained(before, cancelled);
		assertNoEffectsAfterFence(probe.observations);
		assert.throws(() => store.release(admissionFence(cancelled)), { code: "parallel_unsafe_release" });
		assert.throws(() => store.settle(admissionFence(cancelled), [{
			...cancelled.obligations[0], disposition: "no-session-created", pendingEffectIds: [],
			inventory: { complete: true, source: "timeout or absent snapshot", capturedAt: "2099-01-01T00:00:00.000Z" },
		}]), { code: "parallel_unsafe_release" });
		outcome(store, "succeeded", { sessionId: "late-child" });
		const late = read(store);
		assert.equal(late.obligations[0].sessionId, "late-child");
		assert.deepEqual(late.obligations[0].pendingEffectIds, []);
		const settlement = {
			...late.obligations[0], disposition: /** @type {const} */ ("session-terminated"),
			inventory: { complete: true, source: "complete terminal inventory", capturedAt: "2026-11-13T00:00:01.000Z" },
		};
		assert.throws(() => store.settle(admissionFence(late), [{ ...settlement, sessionId: "foreign-child" }]), { code: "parallel_unsafe_release" });
		assert.throws(() => store.settle(admissionFence(late), [{ ...settlement, inventory: { ...settlement.inventory, capturedAt: NOW } }]), { code: "parallel_unsafe_release" });
		const settled = store.settle(admissionFence(late), [settlement]);
		assert.equal(store.release(admissionFence(settled)).phase, "released");
	} finally { fixture.dispose(); }
});

test("PF-ADM-04 journal callbacks cannot allocate/release, erase history or escape synchronous transactions", () => {
	const fixture = createParallelFixture({ name: "journal-authority" });
	try {
		const store = storeFor(fixture), active = reserved(store);
		assert.throws(() => store.withFence(admissionFence(active), ({ admission }) => { admission.phase = "released"; }), { code: "parallel_transition_authority" });
		assert.throws(() => store.withFence(admissionFence(active), ({ db }) => {
			db.prepare("DELETE FROM parallel_admissions").run();
		}), { code: "database_error" });
		assert.throws(() => store.withFence(admissionFence(active), async () => {}), { code: "parallel_async_transaction" });
		assert.deepEqual(read(store), active);
		store.withFence(admissionFence(active), ({ admission }) => admission.receipts.push(intent(admission)));
		assert.throws(() => store.withFence(admissionFence(read(store)), ({ admission }) => { admission.receipts = []; }), { code: "parallel_receipt_identity" });
		const stopped = store.cancel(admissionFence(read(store)));
		assert.equal(stopped.receipts[0].state, "intent", "Cancellation cannot desynchronize the journal's receipt rows");
		assert.throws(() => store.withFence(admissionFence(stopped), ({ admission }) => { admission.receipts[0].state = "in-flight"; }), { code: "parallel_fenced" });
		outcome(store, "cancelled-before-start");
		assert.equal(read(store).receipts[0].state, "cancelled-before-start");
		assert.equal(read(store).phase, "cancelling");
	} finally { fixture.dispose(); }
});

test("PF-ADM-03 successful delivery cannot hide uncertain work or unaccounted workflow runs", () => {
	const fixture = createParallelFixture({ name: "delivery-release" });
	try {
		const store = storeFor(fixture), active = reserved(store);
		assert.ok(active.attempt);
		const delivery = { attempt: active.attempt, sessionId: "child", commit: "c".repeat(40), planRevision: 10, source: "completeTask receipt", terminalRunIds: [] };
		store.withFence(admissionFence(active), ({ admission }) => admission.receipts.push({ ...intent(admission), kind: "workflow" }));
		outcome(store, "in-flight");
		assert.throws(() => store.deliver(admissionFence(read(store)), delivery), { code: "parallel_unsafe_release" });
		outcome(store, "succeeded", { runId: "owned-workflow" });
		assert.throws(() => store.deliver(admissionFence(read(store)), delivery), { code: "parallel_unsafe_release" });
		assert.throws(() => store.deliver(admissionFence(read(store)), { ...delivery, terminalRunIds: ["owned-workflow", "foreign-workflow"] }), { code: "parallel_foreign_run" });
		const settled = store.deliver(admissionFence(read(store)), { ...delivery, terminalRunIds: ["owned-workflow"] });
		assert.throws(() => store.release({ ...admissionFence(settled), epoch: 5 }), { code: "revision_conflict" });
		assert.equal(store.release(admissionFence(settled)).phase, "released");
	} finally { fixture.dispose(); }
});

test("PF-ADM-03/05 multi-resource acquisition is all-or-nothing and shared capacity cannot be inflated", () => {
	const fixture = createParallelFixture({ name: "multi-resource-capacity" });
	try {
		const left = storeFor(fixture), right = storeFor(fixture, "/fixture/other");
		/** @type {import("../../types/parallel.js").ResourceClaim} */
		const shared = { id: "compiler-pool", kind: "worktree-build", scope: "/fixture/compiler-pool", mode: "shared", capacity: 2, units: 1 };
		const claim = { identity: identity(), expectedRevision: 0, resources: [shared, resource()], team: { id: "team", capacity: 2, units: 1 } };
		left.claim(claim);
		assert.throws(() => right.claim({
			...claim, identity: identity("T-002", "/fixture/other"), resources: [{ ...shared, capacity: 3 }],
		}), { code: "parallel_capacity_held" });
		const request = {
			...claim, identity: identity("T-002", "/fixture/other"),
			resources: [resource("/unused-output"), resource("/fixture/output")].map((resource, index) => ({ ...resource, id: `output-${index}` })),
		};
		assert.throws(() => right.claim(request), { code: "parallel_capacity_held" });
		assert.equal(right.read(request.identity), null, "Conflict in a later resource cannot leak an earlier acquisition");
		right.claim({ ...request, resources: [shared] });
		assert.throws(() => left.claim({
			identity: identity("T-003"), expectedRevision: 0, resources: [shared], team: null,
		}), { code: "parallel_capacity_held" });
		assert.throws(() => left.claim({
			identity: identity("T-004"), expectedRevision: 0, resources: [], team: { id: "team", capacity: 3, units: 1 },
		}), { code: "parallel_capacity_held" });
		assertExclusiveClaims(left.list());
	} finally { fixture.dispose(); }
});

test("PF-ADM-04 native outcomes committed after cancellation require a newer complete settlement inventory", () => {
	const fixture = createParallelFixture({ name: "late-workflow-cancel" });
	try {
		const store = storeFor(fixture), active = reserved(store);
		store.withFence(admissionFence(active), ({ admission }) => admission.receipts.push({ ...intent(admission), kind: "workflow" }));
		outcome(store, "in-flight");
		store.cancel(admissionFence(read(store)));
		outcome(store, "succeeded", { runId: "late-run", at: "2026-11-13T00:00:02.000Z" });
		const held = read(store);
		const obligation = held.obligations[0];
		assert.deepEqual(obligation.runIds, ["late-run"]);
		const terminal = {
			...obligation, disposition: /** @type {const} */ ("no-session-created"), terminatedRunIds: ["late-run"],
			inventory: { complete: true, source: "owned workflow terminal receipt", capturedAt: "2026-11-13T00:00:01.000Z" },
		};
		assert.throws(() => store.settle(admissionFence(held), [terminal]), { code: "parallel_unsafe_release" });
		assert.throws(() => store.settle(admissionFence(held), [{ ...terminal, terminatedRunIds: ["foreign-run"] }]), { code: "parallel_foreign_run" });
		const settled = store.settle(admissionFence(held), [{ ...terminal, inventory: { ...terminal.inventory, capturedAt: "2026-11-13T00:00:03.000Z" } }]);
		assert.equal(store.release(admissionFence(settled)).phase, "released");
		assert.equal(store.list().filter(record => record.phase !== "released").length, 0);
	} finally { fixture.dispose(); }
});

test("PF-ADM-03 clock rollback does not make an older inventory authoritative for release", () => {
	const fixture = createParallelFixture({ name: "clock-rollback" });
	try {
		let now = NOW;
		const store = createAdmissionStore({
			workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER, clock: () => now,
		});

		test("PF-ADM-03 inventory-only ownership survives restart, journal refresh and later omission", () => {
			const fixture = createParallelFixture({ name: "durable-positive-observations" });
			try {
				const store = storeFor(fixture), cancelled = store.cancel(admissionFence(reserved(store)));
				assert.ok(cancelled.attempt);
				const observed = {
					attempt: cancelled.attempt, sessionIds: ["inventory-child"], runIds: ["inventory-run"],
					source: "complete exact-attempt native inventory", capturedAt: "2026-11-13T00:00:01.000Z",
				};
				const retained = store.retainObservation(admissionFence(cancelled), observed);
				assert.equal(retained.revision, cancelled.revision + 1);
				assert.deepEqual(store.retainObservation(admissionFence(retained), observed), retained);
				assert.throws(() => store.retainObservation(admissionFence(cancelled), observed), { code: "revision_conflict" });
				const reopened = storeFor(fixture);
				assert.deepEqual(reopened.readObservations(identity()), [observed]);
				assert.equal(read(reopened).obligations[0].sessionId, "inventory-child");
				assert.deepEqual(read(reopened).obligations[0].runIds, ["inventory-run"]);
				reopened.withFence(admissionFence(read(reopened)), () => {});
				const omitted = reopened.retainObservation(admissionFence(read(reopened)), {
					...observed, sessionIds: [], runIds: [], source: "later omission", capturedAt: "2026-11-13T00:00:02.000Z",
				});
				assert.equal(omitted.obligations[0].sessionId, "inventory-child");
				assert.deepEqual(omitted.obligations[0].runIds, ["inventory-run"]);
				assert.throws(() => reopened.settle(admissionFence(omitted), [{
					...omitted.obligations[0], sessionId: null, runIds: [], disposition: "no-session-created",
					inventory: { complete: true, source: "omitted identities are not termination", capturedAt: "2026-11-13T00:00:03.000Z" },
				}]), { code: "parallel_unsafe_release" });
				const terminal = {
					...omitted.obligations[0], disposition: /** @type {const} */ ("session-terminated"), terminatedRunIds: ["inventory-run"],
					inventory: { complete: true, source: "positive session and run terminal evidence", capturedAt: observed.capturedAt },
				};
				assert.throws(() => reopened.settle(admissionFence(omitted), [terminal]), { code: "parallel_unsafe_release" });
				const settled = reopened.settle(admissionFence(omitted), [{
					...terminal, inventory: { ...terminal.inventory, capturedAt: "2026-11-13T00:00:03.000Z" },
				}]);
				assert.equal(reopened.release(admissionFence(settled)).phase, "released");
				assert.equal(reopened.readObservations(identity()).length, 2, "Release preserves observation history");
			} finally { fixture.dispose(); }
		});

		test("PF-ADM-03/04 multiple positively observed children remain in durable quarantine", () => {
			const fixture = createParallelFixture({ name: "multiple-owned-children" });
			try {
				const store = storeFor(fixture), cancelled = store.cancel(admissionFence(reserved(store)));
				assert.ok(cancelled.attempt);
				const observed = {
					attempt: cancelled.attempt, sessionIds: ["child-one", "child-two"], runIds: [],
					source: "two exact-attempt children in native inventory", capturedAt: "2026-11-13T00:00:01.000Z",
				};
				assert.throws(() => store.retainObservation(admissionFence(cancelled), {
					...observed, attempt: { ...identity("T-002"), attemptId: "T-002-A001" },
				}), { code: "parallel_identity_mismatch" });
				assert.throws(() => storeFor(fixture, "/foreign").retainObservation(admissionFence(cancelled), observed), { code: "parallel_foreign_owner" });
				store.retainObservation(admissionFence(cancelled), observed);
				const reopened = storeFor(fixture);
				assert.deepEqual(reopened.readObservations(identity())[0].sessionIds, ["child-one", "child-two"]);
				const held = read(reopened);
				assert.throws(() => reopened.withFence(admissionFence(held), ({ db }) => {
					db.prepare("DELETE FROM parallel_admission_observations").run();
				}), { code: "database_error" });
				assert.throws(() => reopened.settle(admissionFence(held), [{
					...held.obligations[0], disposition: "session-terminated",
					inventory: { complete: true, source: "one terminal child cannot settle both", capturedAt: "2026-11-13T00:00:03.000Z" },
				}]), { code: "parallel_observation_quarantine" });
				assert.throws(() => reopened.release(admissionFence(held)), { code: "parallel_observation_quarantine" });
				assert.throws(() => reopened.claim({
					identity: identity("T-002"), expectedRevision: 0, resources: [resource()], team: null,
				}), { code: "parallel_capacity_held" });
				assert.equal(read(reopened).phase, "cancelling");
			} finally { fixture.dispose(); }
		});

		test("PF-ADM-07 admission v1 migration preserves existing claims while adding observation retention", () => {
			const fixture = createParallelFixture({ name: "admission-v1-migration" });
			try {
				const initial = storeFor(fixture), active = reserved(initial);
				// Reconstruct the prior schema using the same serialized v1 admission record.
				fixture.left.db.exec("DROP TABLE parallel_admission_observations; PRAGMA user_version = 1;");
				const migrated = storeFor(fixture);
				assert.deepEqual(migrated.read(identity()), active);
				assert.deepEqual(migrated.readObservations(identity()), []);
				assert.equal(fixture.right.db.prepare("PRAGMA user_version").get()?.user_version, 2);
				assert.throws(() => migrated.release(admissionFence(active)), { code: "parallel_unsafe_release" });
			} finally { fixture.dispose(); }
		});

		test("PF-ADM-03 captures exceeding the frozen run bound are retained atomically, not truncated or paginated", () => {
			const fixture = createParallelFixture({ name: "observed-run-overflow" });
			try {
				const store = storeFor(fixture), cancelled = store.cancel(admissionFence(reserved(store)));
				assert.ok(cancelled.attempt);
				const observed = {
					attempt: cancelled.attempt, sessionIds: [], runIds: Array.from({ length: 129 }, (_, index) => `run-${index}`),
					source: "one complete exact-attempt capture", capturedAt: "2026-11-13T00:00:01.000Z",
				};
				const overflow = store.retainObservation(admissionFence(cancelled), observed);
				const reopened = storeFor(fixture);
				assert.equal(overflow.revision, cancelled.revision + 1);
				assert.equal(reopened.readObservations(identity()).length, 1);
				assert.equal(new Set(reopened.readObservations(identity()).flatMap(item => item.runIds)).size, 129);
				assert.throws(() => reopened.settle(admissionFence(overflow), [{
					...overflow.obligations[0], disposition: "no-session-created", terminatedRunIds: overflow.obligations[0].runIds,
					inventory: { complete: true, source: "bounded snapshot is not all owned runs", capturedAt: "2026-11-13T00:00:02.000Z" },
				}]), { code: "parallel_observation_quarantine" });
				assert.equal(read(reopened).phase, "cancelling");
			} finally { fixture.dispose(); }
		});
		const active = reserved(store);
		now = "2026-11-12T23:59:00.000Z";
		const cancelled = store.cancel(admissionFence(active));
		const obligation = {
			...cancelled.obligations[0], disposition: /** @type {const} */ ("no-session-created"),
			inventory: { complete: true, source: "older inventory", capturedAt: "2026-11-12T23:59:30.000Z" },
		};
		assert.throws(() => store.settle(admissionFence(cancelled), [obligation]), { code: "parallel_unsafe_release" });
		assert.equal(read(store).phase, "cancelling");
	} finally { fixture.dispose(); }
});

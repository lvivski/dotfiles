import assert from "node:assert/strict";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createAdmissionStore, admissionFence } from "../../storage/admission.mjs";
import { createArtifactDatabase } from "../../storage/database.mjs";
import { stableStringify } from "../../digest.mjs";
import { fail } from "../../factory/fields.mjs";
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
				fixture.left.db.exec("DROP TABLE parallel_admission_observations; DROP TABLE parallel_plan_cancellations; PRAGMA user_version = 1;");
				const migrated = storeFor(fixture);
				assert.deepEqual(migrated.read(identity()), active);
				assert.deepEqual(migrated.readObservations(identity()), []);
				assert.equal(fixture.right.db.prepare("PRAGMA user_version").get()?.user_version, 3);
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

const PLAN = { repositoryId: REPO, owner: OWNER, planId: "admission-test" };
/** @param {Partial<import("../../types/parallel.js").AdmissionIdentity>} [overrides] */
const request = (overrides = {}) => ({ identity: { ...identity(), ...overrides }, expectedRevision: 0, resources: [], team: null });
/** @param {ReturnType<typeof createAdmissionStore>} store @param {import("../../types/parallel.js").AdmissionRecord} held */
function releaseUnbound(store, held) {
	const settled = store.failReservation(admissionFence(held), { source: "definitive failed reservation response", at: NOW });
	return store.release(admissionFence(settled));
}
/** Raw strings deliberately preserve noncanonical JSON, timestamps and observation IDs.
 * @param {import("node:sqlite").DatabaseSync} db */
function stored(db) {
	const schema = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
	return {
		version: db.prepare("PRAGMA user_version").get(), application: db.prepare("PRAGMA application_id").get(), schema,
		admissions: db.prepare("SELECT * FROM parallel_admissions ORDER BY identity").all(),
		observations: schema.some(row => row.name === "parallel_admission_observations")
			? db.prepare("SELECT * FROM parallel_admission_observations ORDER BY id").all() : [],
		cancellations: schema.some(row => row.name === "parallel_plan_cancellations")
			? db.prepare("SELECT * FROM parallel_plan_cancellations ORDER BY identity").all() : [],
	};
}

test("CF-03/05/06/11 empty and released censuses keep an exact durable plan fence across process restart", () => {
	const fixture = createParallelFixture({ name: "plan-fence-empty-release" });
	try {
		const store = storeFor(fixture);
		assert.deepEqual(store.readCancellation(PLAN), { identity: PLAN, fence: null, admissions: [] });
		const empty = store.cancelPlan(PLAN);
		assert.deepEqual(empty, { identity: PLAN, fence: { identity: PLAN, cancelledAt: NOW }, admissions: [] });
		assert.deepEqual(store.cancelPlan(PLAN), empty);
		assert.equal(fixture.left.db.prepare("SELECT count(*) AS n FROM parallel_plan_cancellations").get()?.n, 1);
		assert.throws(() => store.claim(request()), { code: "parallel_fenced" });
		assert.equal(store.read(identity()), null);
		for (const foreign of [{ ...PLAN, owner: "/other" }, { ...PLAN, repositoryId: "b".repeat(64) }]) {
			assert.throws(() => store.cancelPlan(foreign), { code: "parallel_foreign_owner" });
			assert.throws(() => store.readCancellation(foreign), { code: "parallel_foreign_owner" });
		}
		assert.throws(() => store.cancelPlan({ ...PLAN, planId: "../invalid" }), { code: "parallel_identity_invalid" });
		const otherPlan = { ...PLAN, planId: "other-plan" };
		const other = store.claim(request({ planId: otherPlan.planId }));
		assert.deepEqual(store.claim(request({ planId: otherPlan.planId })), other);
		const stopped = store.cancelPlan(otherPlan).admissions[0].admission;
		assert.equal(stopped.epoch, 1);
		assert.throws(() => store.claim(request({ planId: otherPlan.planId })), { code: "parallel_fenced" });
		releaseUnbound(store, stopped);
		const retained = store.readCancellation(otherPlan);
		assert.equal(retained.admissions[0].admission.phase, "released");
		const beforeRetry = stored(fixture.left.db);
		assert.deepEqual(store.cancelPlan(otherPlan), retained);
		assert.deepEqual(stored(fixture.left.db), beforeRetry);
		for (const reopened of [store, storeFor(fixture)]) {
			assert.throws(() => reopened.claim(request({ planId: otherPlan.planId, reservationId: "after-release" })), { code: "parallel_fenced" });
			assert.deepEqual(reopened.readCancellation(otherPlan), retained);
		}
		fixture.left.db.close();
		fixture.right.db.close();
		assert.deepEqual(restartedRead(fixture.workspacePath, otherPlan), retained);
	} finally { fixture.dispose(); }
});

test("CF-04/12 competing initialized writers serialize both claim/fence orders and roll back partial cancellation", () => {
	const fixture = createParallelFixture({ name: "plan-fence-ordering" });
	try {
		const observer = storeFor(fixture);
		assert.equal(observer.readCancellation(PLAN).fence, null);
		/** @type {string[]} */
		const order = [];
		const claiming = createAdmissionStore({
			workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER, directoryParts: ["files", "foundry"], busyTimeoutMs: 1,
			clock() {
				order.push("claim-holds-writer");
				assert.throws(() => observer.cancelPlan(PLAN), { code: "storage_busy" });
				return NOW;
			},
		});
		const first = claiming.claim(request());
		order.push("claim-committed");
		const second = observer.claim(request({ taskId: "T-002", reservationId: "second" }));
		let ticks = 0, interrupt = true;
		const cancelling = createAdmissionStore({
			workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER, directoryParts: ["files", "foundry"], busyTimeoutMs: 1,
			clock() {
				if (++ticks === 2) {
					order.push("fence-holds-writer");
					assert.equal(observer.readCancellation(PLAN).fence, null, "Another reader cannot see the uncommitted fence");
					assert.throws(() => observer.claim(request({ taskId: "T-003", reservationId: "third" })), { code: "storage_busy" });
				}
				if (interrupt && ticks === 3) throw new Error("after fence and first admission update");
				return NOW;
			},
		});
		const prior = stored(fixture.left.db);
		assert.throws(() => cancelling.cancelPlan(PLAN), /after fence and first admission update/);
		assert.deepEqual(stored(fixture.left.db), prior, "Fence and earlier row update roll back together");
		ticks = 0;
		interrupt = false;
		const cancelled = cancelling.cancelPlan(PLAN);
		order.push("fence-committed");
		assert.deepEqual(cancelled.admissions.map(item => [item.admission.identity, item.admission.revision, item.admission.epoch]),
			[first, second].map(item => [item.identity, item.revision + 1, item.epoch + 1]));
		for (const payload of [request(), request({ taskId: "T-003", reservationId: "third" })]) {
			assert.throws(() => claiming.claim(payload), { code: "parallel_fenced" });
		}
		assert.deepEqual(order, ["claim-holds-writer", "claim-committed", "fence-holds-writer", "fence-holds-writer", "fence-committed"]);
		assert.equal(observer.list().length, 2);
		assert.deepEqual(observer.cancelPlan(PLAN), cancelled);
	} finally { fixture.dispose(); }
});

test("CF-09/10/11 plan fencing preserves late responses, ownership quarantine and foreign capacity", () => {
	const fixture = createParallelFixture({ name: "plan-fence-preservation" });
	try {
		const store = storeFor(fixture), other = storeFor(fixture, "/foreign");
		const active = reserved(store);
		assert.ok(active.attempt);
		const attempt = active.attempt;
		store.withFence(admissionFence(active), ({ admission }) => admission.receipts.push(intent(admission)));
		outcome(store, "in-flight");
		outcome(store, "uncertain");
		const pending = read(store);
		const unbound = store.claim(request({ taskId: "T-002", reservationId: "unbound" }));
		const otherHeld = other.claim(request({ owner: "/foreign" }));
		const otherBound = other.bindReservation(admissionFence(otherHeld), { ...otherHeld.identity, attemptId: "T-001-A001" });
		const otherStopped = other.cancel(admissionFence(otherBound));
		assert.ok(otherStopped.attempt);
		other.retainObservation(admissionFence(otherStopped), {
			attempt: otherStopped.attempt, sessionIds: ["foreign-child"], runIds: ["foreign-run"], source: "foreign positive ownership", capturedAt: NOW,
		});
		const anotherPlan = store.claim(request({ planId: "foreign-plan" }));
		const anotherRepository = createAdmissionStore({
			workspacePath: fixture.workspacePath, repositoryId: "b".repeat(64), owner: OWNER, directoryParts: ["files", "foundry"], clock: () => NOW,
		});
		const otherRepo = anotherRepository.claim(request({ repositoryId: "b".repeat(64) }));
		const foreignRows = stored(fixture.left.db).admissions.filter(row => row.identity !== stableStringify(pending.identity) && row.identity !== stableStringify(unbound.identity));
		const foreignObservations = stored(fixture.left.db).observations;
		const snapshot = store.cancelPlan(PLAN);
		assert.equal(snapshot.admissions.length, 2);
		assertUncertainEffectsRetained(pending, read(store));
		assert.deepEqual(stored(fixture.left.db).admissions.filter(row => foreignRows.some(foreign => foreign.identity === row.identity)), foreignRows);
		assert.deepEqual(stored(fixture.left.db).observations, foreignObservations);
		assert.equal(store.readCancellation({ ...PLAN, planId: anotherPlan.identity.planId }).fence, null);
		assert.equal(anotherRepository.readCancellation({ ...PLAN, repositoryId: otherRepo.identity.repositoryId }).fence, null);
		assert.throws(() => store.withFence(admissionFence(pending), () => {}), { code: "revision_conflict" });
		assert.throws(() => store.bindReservation(admissionFence(unbound), { ...unbound.identity, attemptId: "T-002-A001" }), { code: "revision_conflict" });
		const currentUnbound = store.read(unbound.identity);
		assert.ok(currentUnbound);
		const late = store.bindReservation(admissionFence(currentUnbound), { ...unbound.identity, attemptId: "T-002-A001" });
		assert.equal(late.phase, "cancelling");
		assert.throws(() => store.release(admissionFence(late)), { code: "parallel_unsafe_release" });
		assert.throws(() => store.failReservation(admissionFence(late), { source: "not an unbound failure", at: NOW }), { code: "parallel_fenced" });
		assert.throws(() => store.deliver(admissionFence(read(store)), {
			attempt, sessionId: "late-child", commit: "c".repeat(40), planRevision: 10, source: "late completion", terminalRunIds: [],
		}), { code: "parallel_fenced" });
		assert.throws(() => other.claim({ ...request({ owner: "/foreign", taskId: "T-003", reservationId: "competing" }), resources: [resource()] }), { code: "parallel_capacity_held" });
		const held = read(store);
		assert.throws(() => store.withFence(admissionFence(held), ({ admission }) => {
			admission.receipts.push({ ...intent(admission), id: "forbidden-after-plan-fence" });
		}), { code: "parallel_fenced" });
		assert.throws(() => store.settle(admissionFence(held), [{
			...held.obligations[0], pendingEffectIds: [], disposition: "no-session-created",
			inventory: { complete: true, source: "missing or idle is not termination", capturedAt: "2099-01-01T00:00:00.000Z" },
		}]), { code: "parallel_unsafe_release" });
		outcome(store, "succeeded", { sessionId: "late-child" });
		const observation = { attempt, sessionIds: ["additional-child", "late-child"], runIds: ["observed-run"], source: "whole positive capture after revision race", capturedAt: NOW };
		assert.throws(() => store.retainObservation(admissionFence(held), observation), { code: "revision_conflict" });
		const retained = store.retainObservation(admissionFence(read(store)), observation);
		assert.throws(() => store.settle(admissionFence(held), [{
			...held.obligations[0], pendingEffectIds: [], disposition: "no-session-created",
			inventory: { complete: true, source: "terminal decision predates positive ownership", capturedAt: "2099-01-01T00:00:00.000Z" },
		}]), { code: "revision_conflict" });
		assert.throws(() => store.release(admissionFence(held)), { code: "revision_conflict" });
		store.withFence(admissionFence(retained), () => {});
		assert.throws(() => store.withFence(admissionFence(read(store)), ({ db }) => {
			db.exec("DELETE FROM parallel_plan_cancellations");
		}), { code: "database_error" });
		const reopened = storeFor(fixture);
		assert.deepEqual(reopened.readObservations(identity()), [observation]);
		assert.deepEqual(reopened.readCancellation(PLAN).admissions.find(item => item.admission.identity.taskId === "T-001")?.observations, [observation]);
		assert.throws(() => reopened.release(admissionFence(read(reopened))), { code: "parallel_observation_quarantine" });
		assert.throws(() => reopened.settle(admissionFence(read(reopened)), [{
			...read(reopened).obligations[0], disposition: "session-terminated", terminatedRunIds: ["observed-run"],
			inventory: { complete: true, source: "one child cannot settle two", capturedAt: "2099-01-01T00:00:00.000Z" },
		}]), { code: "parallel_observation_quarantine" });
		assert.deepEqual(reopened.cancelPlan(PLAN), reopened.readCancellation(PLAN));
		other.claim(request({ owner: "/foreign", taskId: "T-004", reservationId: "unrelated" }));
		assertExclusiveClaims(reopened.list());
	} finally { fixture.dispose(); }
});

// Exact initializer bodies from the immutable admission modules named below.
// Keep their bytes and closed-over schema constants unchanged, not just VERSION.
const TABLE = "parallel_admissions", APPLICATION = 0x464e4144;
const OBSERVATIONS = "parallel_admission_observations";
const OBSERVATION_SCHEMA = `CREATE TABLE ${OBSERVATIONS} (
	id INTEGER PRIMARY KEY, identity TEXT NOT NULL, document TEXT NOT NULL,
	UNIQUE(identity, document)
) STRICT;`;
const legacyInitializers = [
	(() => {
		const VERSION = 1;
		/** @param {import("node:sqlite").DatabaseSync} db */
		return function initialize(db) {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	const application = db.prepare("PRAGMA application_id").get()?.application_id;
	if (version === VERSION && application === APPLICATION) return;
	if (version !== 0 || application !== 0 || db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
		fail("parallel_database_version", "Unknown admission database owner or version");
	}
	db.exec(`CREATE TABLE ${TABLE} (
		identity TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
		document TEXT NOT NULL, updated_at TEXT NOT NULL
	) STRICT; PRAGMA application_id = ${APPLICATION}; PRAGMA user_version = ${VERSION};`);
};
	})(),
	(() => {
		const VERSION = 2;
		/** @param {import("node:sqlite").DatabaseSync} db */
		return function initialize(db) {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	const application = db.prepare("PRAGMA application_id").get()?.application_id;
	if (version === VERSION && application === APPLICATION) return;
	if (version === 1 && application === APPLICATION) {
		db.exec(`${OBSERVATION_SCHEMA} PRAGMA user_version = ${VERSION};`);
		return;
	}
	if (version !== 0 || application !== 0 || db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
		fail("parallel_database_version", "Unknown admission database owner or version");
	}
	db.exec(`CREATE TABLE ${TABLE} (
		identity TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL,
		document TEXT NOT NULL, updated_at TEXT NOT NULL
	) STRICT; ${OBSERVATION_SCHEMA} PRAGMA application_id = ${APPLICATION}; PRAGMA user_version = ${VERSION};`);
};
	})(),
];
const legacyProvenance = [
	{ commit: "c97674b0121f32e148d976beedf0461f1662a12b", blob: "b7edc188846045dce9e1269dc195451dfa116903", sha256: "44ae6695591db4d6a0128b76b449d1a655a4542b2a95207113b4f4c91a1cac63" },
	{ commit: "5cf91c8ecc4e36aaf5bf28f1f20ed53f7a9d1526", blob: "6674c1ba667812f569b8402477cae977d748b76d", sha256: "26a9e7f5194504f2a03e99755ce0317648fcb63670565f5c02dd152572c02f38" },
];

for (const version of [1, 2]) {
	for (const populated of [false, true]) {
		test(`CF-07/08/10 v${version} ${populated ? "populated" : "empty"} migration preserves bytes and fences unchanged pre-upgrade writers`, t => {
			const fixture = createParallelFixture({ name: `legacy-v${version}-${populated}` });
			try {
				const initialize = legacyInitializers[version - 1], provenance = legacyProvenance[version - 1];
				assert.equal(createHash("sha256").update(initialize.toString()).digest("hex"), provenance.sha256);
				t.diagnostic(JSON.stringify({ version, ...provenance, source: ".copilot/extensions/foundry/storage/admission.mjs#initialize" }));
				const writer = createArtifactDatabase({ workspacePath: fixture.workspacePath, initialize, schemaVersion: version });
				writer.transaction(() => {});
				if (populated) {
					writer.transaction(db => {
						const admission = {
							format: "foundry-admission-v1", identity: identity(), revision: 1, epoch: 0, phase: "claim-held",
							attempt: null, resources: [resource()], team: null, obligations: [], receipts: [], delivery: null, reservationFailure: null,
						};
						db.prepare("INSERT INTO parallel_admissions VALUES (?, ?, ?, ?)").run(stableStringify(admission.identity), 1, JSON.stringify(admission, null, 2), NOW);
						const attempt = { ...identity("T-002"), attemptId: "T-002-A001" };
						const cancelled = { ...admission, identity: identity("T-002"), revision: 4, epoch: 1, phase: "cancelling",
							attempt, resources: [],
							receipts: [{ id: "legacy-create", attempt, kind: "creation", epoch: 0, payloadDigest: "b".repeat(64),
								state: "uncertain", sessionId: null, runId: null, source: "legacy in-flight response lost", at: NOW }],
							obligations: [{ attempt, sessionId: null, runIds: [], pendingEffectIds: ["legacy-create"], disposition: "unresolved", inventory: null, terminatedRunIds: [] }],
						};
						db.prepare("INSERT INTO parallel_admissions VALUES (?, ?, ?, ?)").run(stableStringify(cancelled.identity), 4, JSON.stringify(cancelled, null, 2), NOW);
						const foreign = { ...admission, identity: identity("T-003", "/foreign"), resources: [] };
						db.prepare("INSERT INTO parallel_admissions VALUES (?, ?, ?, ?)").run(stableStringify(foreign.identity), 1, JSON.stringify(foreign, null, 2), NOW);
						if (version === 2) {
							db.prepare("INSERT INTO parallel_admission_observations VALUES (?, ?, ?)").run(17, stableStringify(cancelled.identity), JSON.stringify({
								attempt: cancelled.attempt, sessionIds: ["retained-child"], runIds: ["retained-run"], source: "legacy observation", capturedAt: NOW,
							}, null, 2));
						}
					}, { write: true });
				}
				const before = stored(fixture.left.db);
				const failedMigration = createAdmissionStore({
					workspacePath: fixture.workspacePath, repositoryId: REPO, owner: OWNER, directoryParts: ["files", "foundry"],
					clock() { throw new Error("migration transaction interrupted after schema writes"); },
				});
				assert.throws(() => failedMigration.cancelPlan(PLAN), /migration transaction interrupted/);
				assert.deepEqual(stored(fixture.left.db), before, "DDL, user_version and values roll back atomically");
				const upgraded = storeFor(fixture);
				upgraded.readCancellation(PLAN);
				const after = stored(fixture.left.db);
				assert.equal(after.version?.user_version, 3);
				assert.deepEqual(after.application, before.application);
				assert.deepEqual(after.admissions, before.admissions);
				assert.deepEqual(after.observations, before.observations);
				let enteredClaim = false;
				const oldClaim = () => writer.transaction(db => {
					enteredClaim = true;
					db.prepare("INSERT INTO parallel_admissions VALUES (?, ?, ?, ?)").run("forbidden-legacy-claim", 1, "{}", NOW);
				}, { write: true });
				assert.throws(oldClaim, { code: "parallel_database_version" });
				assert.equal(enteredClaim, false, "Actual unchanged initializer rejects before old writer can mutate");
				assert.deepEqual(stored(fixture.left.db), after);
				const stopped = upgraded.cancelPlan(PLAN);
				for (const { admission } of stopped.admissions) {
					if (!admission.attempt) releaseUnbound(upgraded, admission);
					else {
						const retained = upgraded.readObservations(admission.identity);
						assert.equal(admission.receipts[0].state, "uncertain");
						assert.deepEqual(admission.obligations[0].pendingEffectIds, ["legacy-create"]);
						const refreshed = version === 2 ? upgraded.retainObservation(admissionFence(admission), retained[0]) : admission;
						if (version === 2) assert.equal(refreshed.obligations[0].sessionId, "retained-child");
						assert.throws(() => upgraded.release(admissionFence(refreshed)), { code: "parallel_unsafe_release" });
						assert.throws(() => upgraded.settle(admissionFence(refreshed), [{
							...refreshed.obligations[0], sessionId: null, runIds: [], pendingEffectIds: [], disposition: "no-session-created",
							inventory: { complete: true, source: "omission cannot erase legacy ownership", capturedAt: "2099-01-01T00:00:00.000Z" },
						}]), { code: "parallel_unsafe_release" });
					}
					assert.deepEqual(stored(fixture.left.db).admissions.filter(row => String(row.identity).includes("/foreign")),
						before.admissions.filter(row => String(row.identity).includes("/foreign")));
				}
				assert.throws(oldClaim, { code: "parallel_database_version" });
				assert.equal(enteredClaim, false);
				assert.deepEqual(storeFor(fixture).readCancellation(PLAN), upgraded.readCancellation(PLAN));
				assert.throws(() => upgraded.claim(request({ reservationId: "late-new-writer" })), { code: "parallel_fenced" });
			} finally { fixture.dispose(); }
		});
	}
}

test("CF-07 unknown schema or application rejects without partial migration", () => {
	for (const pragma of ["user_version = 99", "application_id = 123"]) {
		const fixture = createParallelFixture({ name: "unknown-admission-version" });
		try {
			const store = storeFor(fixture);
			reserved(store);
			fixture.left.db.exec(`PRAGMA ${pragma}`);
			const before = stored(fixture.left.db);
			assert.throws(() => store.cancelPlan(PLAN), { code: "parallel_database_version" });
			assert.throws(() => store.claim(request({ reservationId: "unknown-version" })), { code: "parallel_database_version" });
			assert.deepEqual(stored(fixture.left.db), before);
		} finally { fixture.dispose(); }
	}
});

/** @param {string} workspacePath @param {typeof PLAN} plan */
function restartedRead(workspacePath, plan) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { createAdmissionStore } from ${JSON.stringify(new URL("../../storage/admission.mjs", import.meta.url).href)};
		const plan = ${JSON.stringify(plan)};
		const store = createAdmissionStore({ workspacePath: ${JSON.stringify(workspacePath)}, ...plan, directoryParts: ["files", "foundry"] });
		assert.throws(() => store.claim({ identity: { ...plan, taskId: "T-099", reservationId: "restart-late-claim" }, expectedRevision: 0, resources: [], team: null }), { code: "parallel_fenced" });
		console.log(JSON.stringify(store.readCancellation(plan)));
	`], { encoding: "utf8", env: process.env });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

/** Stop an actual isolated writer at a deterministic transaction/acknowledgement boundary.
 * @param {string} workspacePath @param {"before" | "after"} stage */
async function crashWriter(workspacePath, stage) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", `
		import { writeSync } from "node:fs";
		import { createAdmissionStore } from ${JSON.stringify(new URL("../../storage/admission.mjs", import.meta.url).href)};
		function checkpoint() {
			writeSync(1, "checkpoint\\n");
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		}
		let ticks = 0;
		const store = createAdmissionStore({
			workspacePath: ${JSON.stringify(workspacePath)}, repositoryId: ${JSON.stringify(REPO)}, owner: ${JSON.stringify(OWNER)},
			directoryParts: ["files", "foundry"],
			clock() { if (${JSON.stringify(stage)} === "before" && ++ticks === 3) checkpoint(); return ${JSON.stringify(NOW)}; }
		});
		store.cancelPlan(${JSON.stringify(PLAN)});
		checkpoint();
	`], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	const closed = once(child, "close");
	const lines = createInterface({ input: child.stdout });
	let stderr = "";
	child.stderr.on("data", chunk => { stderr += String(chunk); });
	let timeout;
	try {
		const result = await Promise.race([
			once(lines, "line"),
			closed.then(() => { throw new Error(`Writer exited before checkpoint: ${stderr}`); }),
			new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Writer checkpoint timeout")), 10_000); }),
		]);
		assert.deepEqual(result, ["checkpoint"]);
		assert.ok(child.pid);
		assert.equal(child.kill("SIGKILL"), true);
		assert.deepEqual(await closed, [null, "SIGKILL"]);
		return { stage, pid: child.pid, signal: "SIGKILL" };
	} finally {
		clearTimeout(timeout);
		lines.close();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await closed;
	}
}

for (const stage of /** @type {const} */ (["before", "after"])) {
	test(`CF-03/06/13 actual writer termination ${stage} commit preserves rollback or durable cancellation`, async t => {
		const fixture = createParallelFixture({ name: `plan-fence-crash-${stage}` });
		try {
			const store = storeFor(fixture);
			store.claim(request());
			store.claim(request({ taskId: "T-002", reservationId: "second" }));
			const before = stored(fixture.left.db);
			fixture.left.db.close();
			fixture.right.db.close();
			t.diagnostic(JSON.stringify(await crashWriter(fixture.workspacePath, stage)));
			const reopened = storeFor(fixture);
			const recovered = reopened.readCancellation(PLAN);
			if (stage === "before") {
				assert.equal(recovered.fence, null);
				assert.deepEqual(recovered.admissions.map(item => item.admission), before.admissions.map(row => JSON.parse(String(row.document))));
			} else {
				assert.deepEqual(recovered.fence, { identity: PLAN, cancelledAt: NOW });
				assert.ok(recovered.admissions.every(item => item.admission.phase === "cancelling" && item.admission.epoch === 1));
				assert.deepEqual(reopened.cancelPlan(PLAN), recovered, "Lost acknowledgement is an idempotent retry, not a new epoch");
			}
			const cancelled = reopened.cancelPlan(PLAN);
			for (const { admission } of cancelled.admissions) releaseUnbound(reopened, admission);
			const retained = reopened.readCancellation(PLAN);
			assert.ok(retained.admissions.every(item => item.admission.phase === "released"));
			assert.deepEqual(restartedRead(fixture.workspacePath, PLAN), retained);
		} finally { fixture.dispose(); }
	});
}

test("CF-10/13 process death after cancellation commit retains uncertain effects and positive ownership", async t => {
	const fixture = createParallelFixture({ name: "plan-fence-crash-uncertain" });
	try {
		const store = storeFor(fixture), active = reserved(store);
		store.withFence(admissionFence(active), ({ admission }) => admission.receipts.push(intent(admission)));
		outcome(store, "in-flight");
		outcome(store, "uncertain");
		const cancelled = store.cancel(admissionFence(read(store)));
		assert.ok(cancelled.attempt);
		store.retainObservation(admissionFence(cancelled), {
			attempt: cancelled.attempt, sessionIds: ["owned-child"], runIds: ["owned-run"], source: "positive ownership before process death", capturedAt: NOW,
		});
		const before = read(store);
		fixture.left.db.close();
		fixture.right.db.close();
		t.diagnostic(JSON.stringify(await crashWriter(fixture.workspacePath, "after")));
		const recovered = restartedRead(fixture.workspacePath, PLAN);
		assert.deepEqual(recovered.admissions[0].admission, before);
		assert.equal(recovered.admissions[0].observations.length, 1);
		const reopened = storeFor(fixture);
		assert.throws(() => reopened.release(admissionFence(before)), { code: "parallel_unsafe_release" });
		assertUncertainEffectsRetained(before, read(reopened));
		assert.deepEqual(reopened.cancelPlan(PLAN), recovered);
	} finally { fixture.dispose(); }
});

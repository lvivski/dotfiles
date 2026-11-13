import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRecoveryOperations } from "../../application/recovery.mjs";
import { parseJson } from "../../data.mjs";
import { stableStringify } from "../../digest.mjs";
import { normalizeRecoveryObservation } from "../../inventory.mjs";
import { admissionRecord } from "../../plan/parallel-contracts.mjs";
import { assertAdmissionFence, assertEffectTransition } from "../../storage/parallel-protocol.mjs";
import { createParallelFixture } from "../parallel/fixture.mjs";

/** @typedef {import("../../types/parallel.js").AdmissionRecord} Admission */
/** @typedef {import("../../types/parallel.js").EffectReceipt} Receipt */
/** @typedef {import("../../types/parallel.js").Fence} Fence */
const at = "2026-11-13T06:00:00.000Z";
const identity = { repositoryId: "a".repeat(64), owner: "recovery-owner", planId: "recovery-plan", taskId: "T-001", reservationId: "reserve-once" };
const attempt = { ...identity, attemptId: "T-001-A001" };
const conflict = () => Object.assign(new Error("concurrent revision"), { code: "revision_conflict" });
/** @param {Receipt["state"]} state @param {Receipt["kind"]} [kind] @returns {Receipt} */
const receipt = (state, kind = "creation") => ({
	id: `${kind}-once`, attempt, kind, epoch: 0, payloadDigest: "b".repeat(64), state,
	sessionId: state === "succeeded" && kind !== "workflow" ? "owned-child" : null,
	runId: state === "succeeded" && kind === "workflow" ? "owned-run" : null, source: "synthetic native receipt", at,
});
/** @param {Receipt[]} [receipts] @returns {Admission} */
const initial = (receipts = []) => ({
	format: "foundry-admission-v1", identity, revision: 1, epoch: 0, phase: "reserved", attempt,
	resources: [{ id: "shared-write", kind: "shared-write", scope: "shared-output", mode: "exclusive", capacity: 1, units: 1 }],
	team: null, obligations: [], receipts, delivery: null, reservationFailure: null,
});

/** Test-only durable port adapter, not production admission/dispatch evidence.
 * @param {import("node:test").TestContext} t @param {Admission} [seed] */
function setup(t, seed = initial()) {
	const fixture = createParallelFixture({ name: "recovery" });
	t.after(() => fixture.dispose());
	const db = fixture.left.db;
	db.exec("CREATE TABLE recovery_adapter (id INTEGER PRIMARY KEY, document TEXT NOT NULL)");
	db.exec("CREATE TABLE recovery_observations (document TEXT NOT NULL UNIQUE)");
	db.prepare("INSERT INTO recovery_adapter VALUES (1, ?)").run(JSON.stringify(admissionRecord(seed)));
	const userFile = path.join(fixture.workspacePath, "user-data.txt");
	writeFileSync(userFile, "preserve user data\n");
	const read = () => {
		const document = db.prepare("SELECT document FROM recovery_adapter WHERE id = 1").get()?.document;
		assert.equal(typeof document, "string");
		return admissionRecord(parseJson(String(document)));
	};
	/** @param {Admission} record */
	const write = record => db.prepare("UPDATE recovery_adapter SET document = ? WHERE id = 1").run(JSON.stringify(admissionRecord(record)));
	const observed = () => db.prepare("SELECT document FROM recovery_observations ORDER BY rowid").all()
		.map(row => normalizeRecoveryObservation(parseJson(String(row.document))));
	/** @type {(point: string) => void} */
	let hook = () => {};
	let ticks = Date.parse(at) + 1_000;
	const clock = () => new Date(ticks++).toISOString();
	const calls = { cancel: 0, settle: 0, release: 0, outcome: 0, observe: 0 };
	/** @template T @param {Fence} fence @param {(record: Admission) => T} operation @param {string} point @returns {T} */
	function mutate(fence, operation, point) {
		db.exec("BEGIN IMMEDIATE");
		let result;
		try {
			const current = read();
			if (current.revision !== fence.revision || current.epoch !== fence.epoch) throw conflict();
			assert.deepEqual(current.identity, fence.admission);
			result = operation(current);
			current.revision++;
			write(current);
			hook(`${point}:before-commit`);
			db.exec("COMMIT");
		} catch (error) {
			if (db.isTransaction) db.exec("ROLLBACK");
			throw error;
		}
		hook(`${point}:after-commit`);
		return result;
	}
	/** @type {import("../../types/parallel.js").AdmissionPort} */
	const admission = {
		read: requested => stableStringify(requested) === stableStringify(seed.identity) ? read() : null,
		claim() { throw new Error("Recovery must not allocate a claim"); },
		bindReservation() { throw new Error("Recovery must not reserve another attempt"); },
		withFence(fence, operation) {
			return mutate(fence, record => {
				assertAdmissionFence(record, fence, { settlement: true });
				return operation({ db, admission: record, fence });
			}, "outcome");
		},
		cancel(fence) {
			calls.cancel++;
			mutate(fence, record => { record.phase = "cancelling"; record.epoch++; }, "cancel");
			return read();
		},
		settle(fence, obligations) {
			calls.settle++;
			mutate(fence, record => {
				assert.equal(record.phase, "cancelling");
				const sessionIds = new Set(observed().flatMap(item => item.sessionIds));
				assert.ok(sessionIds.size <= 1, "Ambiguous observed sessions must stay quarantined");
				for (const id of sessionIds) assert.ok(obligations.some(item => item.sessionId === id));
				for (const id of observed().flatMap(item => item.runIds)) assert.ok(obligations.some(item => item.terminatedRunIds.includes(id)));
				record.obligations = structuredClone(obligations);
				record.phase = "settled";
			}, "settle");
			return read();
		},
		deliver(fence, delivery) {
			mutate(fence, record => { record.delivery = delivery; record.phase = "settled"; }, "deliver");
			return read();
		},
		release(fence) {
			calls.release++;
			mutate(fence, record => { assert.equal(record.phase, "settled"); record.phase = "released"; }, "release");
			return read();
		},
	};
	/** @type {import("../../application/recovery.mjs").RecoveryObservationPort} */
	const observations = {
		readObservations(requested) {
			assert.deepEqual(requested, seed.identity);
			return observed();
		},
		retainObservation(fence, value) {
			const observation = normalizeRecoveryObservation(value);
			assert.deepEqual(observation.attempt, seed.attempt);
			mutate(fence, record => {
				assert.equal(record.phase, "cancelling");
				db.prepare("INSERT OR IGNORE INTO recovery_observations VALUES (?)").run(stableStringify(observation));
			}, "observation");
			return read();
		},
	};
	/** @type {import("../../types/parallel.js").DispatchJournalPort} */
	const journal = {
		read: () => read().receipts,
		intent() { throw new Error("Recovery cannot create intent"); },
		start() { throw new Error("Recovery cannot start effects"); },
		recordOutcome(tx, outcome) {
			const before = tx.admission.receipts.find(item => item.id === outcome.id);
			assert.ok(before);
			assertEffectTransition(before, outcome);
			tx.admission.receipts = tx.admission.receipts.map(item => item.id === outcome.id ? structuredClone(outcome) : item);
			calls.outcome++;
			return outcome;
		},
	};
	/** @type {import("../../inventory.mjs").RecoveryInventory} */
	const inventory = { complete: true, capturedAt: clock(), source: "synthetic exhaustive native inventory", sessions: [], runs: [] };
	/** @type {(() => void) | null} */
	let onObserve = null;
	let fresh = true;
	const makeRecovery = () => createRecoveryOperations({
		admission, journal, observations, ...identity, clock,
		async observe() {
			calls.observe++;
			onObserve?.();
			return { ...structuredClone(inventory), capturedAt: fresh ? clock() : inventory.capturedAt };
		},
	});
	return {
		read, write, admission, journal, observations, calls, inventory, clock, makeRecovery, recovery: makeRecovery(),
		setHook(/** @type {(point: string) => void} */ value) { hook = value; },
		setObservation(/** @type {() => void} */ value) { onObserve = value; },
		stale() { fresh = false; },
		assertUserData() { assert.equal(readFileSync(userFile, "utf8"), "preserve user data\n"); },
	};
}

for (const state of /** @type {const} */ (["intent", "in-flight", "uncertain"])) {
	test(`creation ${state} remains fenced until supported outcome`, async t => {
		const f = setup(t, initial([receipt(state)]));
		f.recovery.cancel(identity);
		let result = await f.recovery.reconcile(identity);
		if (state === "intent") {
			assert.equal(result.state, "released");
			assert.equal(result.record.receipts[0].state, "cancelled-before-start");
		} else {
			assert.equal(result.state, "held");
			assert.equal(f.calls.release, 0);
			const outcome = { ...receipt("succeeded"), at: f.clock() };
			f.recovery.recordOutcome(identity, outcome);
			assert.equal(f.recovery.recordOutcome(identity, structuredClone(outcome)).revision, f.read().revision);
			result = await f.recovery.reconcile(identity);
			assert.equal(result.state, "held", "Absence is not termination");
			f.inventory.sessions.push({ id: "owned-child", status: "cancelled", attempt });
			result = await f.makeRecovery().reconcile(identity);
			assert.equal(result.state, "released");
			assert.equal(result.record.receipts[0].sessionId, "owned-child");
		}
		assert.equal(f.calls.release, 1);
		assert.equal((await f.recovery.reconcile(identity)).state, "released");
		assert.equal(f.calls.release, 1);
		f.assertUserData();
	});
}

test("setup-only, attached and handoff windows require exact terminal child and every run", async t => {
	const f = setup(t, initial([receipt("succeeded"), receipt("intent", "attachment"), receipt("uncertain", "handoff"), receipt("succeeded", "workflow")]));
	f.inventory.sessions = [{ id: "owned-child", status: "idle", attempt }];
	f.inventory.runs = [{ id: "owned-run", status: "paused", attempt }];
	f.recovery.cancel(identity);
	const held = await f.recovery.reconcile(identity);
	assert.equal(held.state, "held");
	assert.ok(held.holds.some(reason => reason.includes("handoff-once")));
	assert.ok(held.holds.some(reason => reason.includes("idle")));
	assert.ok(held.holds.some(reason => reason.includes("paused")));
	f.inventory.sessions[0].status = "completed";
	f.inventory.runs[0].status = "cancelled";
	assert.equal((await f.recovery.reconcile(identity)).state, "held", "Terminal inventory cannot resolve uncertain handoff");
	f.recovery.recordOutcome(identity, { ...receipt("definitive-failure", "handoff"), at: f.clock() });
	assert.equal((await f.recovery.reconcile(identity)).state, "released");
	assert.equal(f.read().receipts.find(item => item.kind === "attachment")?.state, "cancelled-before-start");
	f.assertUserData();
});

test("partial, stale, foreign and ambiguous inventories never release resources", async t => {
	const f = setup(t, initial([receipt("succeeded")]));
	f.recovery.cancel(identity);
	f.inventory.complete = false;
	f.inventory.sessions = [{ id: "owned-child", status: "completed", attempt }];
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	f.inventory.complete = true;
	f.inventory.sessions[0].attempt = { ...attempt, owner: "unrelated-owner" };
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	f.inventory.sessions = [
		{ id: "owned-child", status: "completed", attempt },
		{ id: "duplicate-child", status: "completed", attempt },
	];
	assert.ok((await f.recovery.reconcile(identity)).holds.some(item => item.startsWith("ambiguous-native-sessions")));
	f.inventory.sessions.pop();
	f.stale();
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	assert.equal(f.calls.release, 0);
	assert.deepEqual(f.read().resources, initial().resources);
});

test("foreign admission and imported records cannot confer cancellation authority", async t => {
	const f = setup(t);
	const before = f.read();
	assert.throws(() => f.recovery.cancel({ ...identity, owner: "foreign" }), { code: "parallel_foreign_owner" });
	assert.throws(() => f.recovery.cancel({ ...identity, repositoryId: "c".repeat(64) }), { code: "parallel_foreign_owner" });
	// @ts-expect-error Imported historical data is not an admission identity.
	assert.throws(() => f.recovery.cancel({ format: "foundry-parallel-history-v1", authority: "history-only", admissions: [before] }));
	assert.deepEqual(f.read(), before);
	assert.equal(f.calls.cancel, 0);
});

test("unbound reservation gaps and journal mismatch remain actionable holds", async t => {
	const f = setup(t, { ...initial(), attempt: null, phase: "claim-held" });
	f.recovery.cancel(identity);
	assert.deepEqual((await f.recovery.reconcile(identity)).holds, ["reservation-outcome-unresolved"]);
	assert.equal(f.calls.release, 0);
	const g = setup(t, initial([receipt("uncertain")]));
	g.recovery.cancel(identity);
	g.journal.read = () => [];
	assert.deepEqual((await g.recovery.reconcile(identity)).holds, ["dispatch-journal-admission-mismatch"]);
	assert.equal(g.calls.release, 0);
});

test("observation racing a late outcome is discarded rather than releasing stale ownership", async t => {
	const f = setup(t, initial([receipt("uncertain")]));
	f.recovery.cancel(identity);
	f.setObservation(() => f.recovery.recordOutcome(identity, { ...receipt("succeeded"), at: f.clock() }));
	const result = await f.recovery.reconcile(identity);
	assert.deepEqual(result.holds, ["revision-changed-during-observation"]);
	assert.equal(f.calls.release, 0);
	assert.equal(result.record.receipts[0].sessionId, "owned-child");
});

test("committed revision conflicts accept matching postconditions without replay", async t => {
	const f = setup(t);
	f.setHook(point => {
		if (point.endsWith(":after-commit")) throw conflict();
	});
	assert.equal(f.recovery.cancel(identity).phase, "cancelling");
	assert.equal((await f.recovery.reconcile(identity)).state, "released");
	assert.equal(f.calls.cancel, 1);
	assert.equal(f.calls.settle, 1);
	assert.equal(f.calls.release, 1);
});

for (const point of ["outcome:before-commit", "settle:after-commit", "release:after-commit"]) {
	test(`restart preserves evidence and resources after interrupted persistence at ${point}`, async t => {
		const f = setup(t, initial([receipt("intent")]));
		f.recovery.cancel(identity);
		f.setHook(observed => { if (observed === point) throw new Error(`injected ${point}`); });
		await assert.rejects(f.recovery.reconcile(identity), new RegExp(point));
		if (point === "outcome:before-commit") {
			assert.equal(f.read().receipts[0].state, "intent");
			assert.equal(f.read().phase, "cancelling");
		} else {
			assert.equal(f.read().receipts[0].state, "cancelled-before-start");
		}
		f.setHook(() => {});
		assert.equal((await f.makeRecovery().reconcile(identity)).state, "released");
		f.assertUserData();
	});
}

test("completion wins before cancellation without losing exact delivery evidence", async t => {
	const f = setup(t, initial([receipt("succeeded")]));
	const before = f.read();
	f.admission.deliver({ admission: identity, revision: before.revision, epoch: before.epoch }, {
		attempt, sessionId: "owned-child", commit: "d".repeat(40), planRevision: 7, source: "durable task completion", terminalRunIds: [],
	});
	const delivered = f.read().delivery;
	assert.equal(f.recovery.cancel(identity).phase, "settled");
	assert.equal((await f.recovery.reconcile(identity)).state, "released");
	assert.deepEqual(f.read().delivery, delivered);
	assert.equal(f.calls.cancel, 0);
});

test("changed cancellation postcondition and native observation failures propagate without release", async t => {
	const f = setup(t);
	f.admission.cancel = () => { throw conflict(); };
	assert.throws(() => f.recovery.cancel(identity), { code: "revision_conflict" });
	assert.equal(f.read().phase, "reserved");
	assert.equal(f.calls.release, 0);
	const g = setup(t);
	g.recovery.cancel(identity);
	g.setObservation(() => { throw new Error("native control failed"); });
	await assert.rejects(g.recovery.reconcile(identity), /native control failed/);
	assert.equal(g.read().phase, "cancelling");
	assert.equal(g.calls.release, 0);
});

test("plan reconciliation enumerates all admissions, rejects partial/foreign selections and notices new ownership", async t => {
	const oldAttempt = { ...attempt, reservationId: "older-reservation", attemptId: "T-001-A002" };
	const { attemptId: ignored, ...otherIdentity } = oldAttempt;
	const f = setup(t), g = setup(t, {
		...initial(), identity: otherIdentity, attempt: oldAttempt,
		resources: [{ ...initial().resources[0], scope: "other-worktree" }],
	});
	/** @param {import("../../types/parallel.js").AdmissionIdentity} id */
	const port = id => id.reservationId === identity.reservationId ? f.admission : g.admission;
	/** @type {import("../../types/parallel.js").AdmissionPort} */
	const combined = {
		read: id => port(id).read(id),
		claim: input => port(input.identity).claim(input),
		bindReservation: (fence, value) => port(fence.admission).bindReservation(fence, value),
		withFence: (fence, operation) => port(fence.admission).withFence(fence, operation),
		cancel: fence => port(fence.admission).cancel(fence),
		deliver: (fence, value) => port(fence.admission).deliver(fence, value),
		settle: (fence, value) => port(fence.admission).settle(fence, value),
		release: fence => port(fence.admission).release(fence),
	};
	const selection = { complete: false, identities: [identity, otherIdentity] };
	const recovery = createRecoveryOperations({
		admission: combined, journal: { ...f.journal, read: id => port(id).read({
			repositoryId: id.repositoryId, owner: id.owner, planId: id.planId, taskId: id.taskId, reservationId: id.reservationId,
		})?.receipts ?? [] },
		observations: {
			readObservations: id => (id.reservationId === identity.reservationId ? f.observations : g.observations).readObservations(id),
			retainObservation: (fence, value) => (fence.admission.reservationId === identity.reservationId ? f.observations : g.observations).retainObservation(fence, value),
		},
		...identity, clock: f.clock,
		listAdmissions: () => structuredClone(selection),
		observe: async () => ({ ...f.inventory, capturedAt: f.clock() }),
	});
	assert.deepEqual((await recovery.reconcilePlan(identity.planId)).holds, ["admission-inventory-incomplete"]);
	assert.equal(f.calls.cancel + g.calls.cancel, 0);
	selection.complete = true;
	selection.identities.push({ ...identity, owner: "foreign-owner" });
	await assert.rejects(recovery.reconcilePlan(identity.planId), { code: "parallel_foreign_owner" });
	assert.equal(f.calls.cancel + g.calls.cancel, 0);
	selection.identities.pop();
	const result = await recovery.reconcilePlan(identity.planId);
	assert.equal(result.state, "released");
	assert.equal(result.results.length, 2);
	assert.equal(f.calls.release, 1);
	assert.equal(g.calls.release, 1);
	f.assertUserData(); g.assertUserData();

	let reads = 0;
	const changing = createRecoveryOperations({
		admission: f.admission, journal: f.journal, observations: f.observations, ...identity, clock: f.clock,
		observe: async () => f.inventory,
		listAdmissions: () => ({ complete: true, identities: ++reads === 1 ? [identity] : [identity, otherIdentity] }),
	});
	assert.deepEqual((await changing.reconcilePlan(identity.planId)).holds, ["admission-inventory-changed"]);
});

test("inventory-only owned runs survive restart and disappearing inventory rows", async t => {
	const f = setup(t);
	f.recovery.cancel(identity);
	f.inventory.runs.push({ id: "discovered-owned-run", status: "running", attempt });
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	f.inventory.runs = [];
	const restarted = await f.makeRecovery().reconcile(identity);
	assert.equal(restarted.state, "held", "Observed ownership cannot vanish with a missing native row");
	assert.equal(f.calls.release, 0);
	f.inventory.runs.push({ id: "discovered-owned-run", status: "cancelled", attempt });
	assert.equal((await f.makeRecovery().reconcile(identity)).state, "released");
});

test("positive ownership survives a concurrent outcome while stale termination evidence is discarded", async t => {
	const f = setup(t, initial([receipt("uncertain", "handoff")]));
	f.recovery.cancel(identity);
	f.inventory.runs = [{ id: "discovered-during-race", status: "running", attempt }];
	f.setObservation(() => f.recovery.recordOutcome(identity, { ...receipt("definitive-failure", "handoff"), at: f.clock() }));
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	f.setObservation(() => {});
	assert.deepEqual(f.observations.readObservations(identity)[0].runIds, ["discovered-during-race"]);
	f.inventory.runs = [];
	assert.equal((await f.makeRecovery().reconcile(identity)).state, "held");
	assert.equal(f.calls.release, 0);
	f.inventory.runs = [{ id: "discovered-during-race", status: "cancelled", attempt }];
	assert.equal((await f.makeRecovery().reconcile(identity)).state, "released");
});

test("multiple inventory-only children remain durably quarantined even after all rows disappear", async t => {
	const f = setup(t);
	f.recovery.cancel(identity);
	f.inventory.sessions = ["first-untracked-child", "second-untracked-child"].map(id => ({ id, status: "running", attempt }));
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	f.inventory.sessions = [];
	let result = await f.makeRecovery().reconcile(identity);
	assert.ok(result.holds.some(reason => reason.startsWith("ambiguous-native-sessions:")));
	f.inventory.sessions = ["first-untracked-child", "second-untracked-child"].map(id => ({ id, status: "cancelled", attempt }));
	result = await f.makeRecovery().reconcile(identity);
	assert.equal(result.state, "held", "The scalar obligation cannot silently discard either child even when both are terminal");
	assert.equal(f.calls.release, 0);
	assert.deepEqual(f.observations.readObservations(identity)[0].sessionIds, ["first-untracked-child", "second-untracked-child"]);
	f.assertUserData();
});

test("one capture beyond the scalar run bound is atomically retained and quarantined", async t => {
	const f = setup(t);
	f.recovery.cancel(identity);
	const before = f.read().revision;
	f.inventory.runs = Array.from({ length: 129 }, (_, index) => ({ id: `run-${index}`, status: "running", attempt }));
	assert.equal((await f.recovery.reconcile(identity)).state, "held");
	assert.equal(f.read().revision, before + 1);
	assert.equal(f.observations.readObservations(identity).length, 1);
	f.inventory.runs = [];
	const result = await f.makeRecovery().reconcile(identity);
	assert.ok(result.holds.includes("native-observation-quarantine:run-count:129"));
	assert.equal(new Set(f.observations.readObservations(identity).flatMap(item => item.runIds)).size, 129);
	assert.equal(f.calls.release, 0);
});

for (const point of ["observation:before-commit", "observation:after-commit"]) {
	test(`native observation retention is atomic across ${point}`, async t => {
		const f = setup(t);
		f.recovery.cancel(identity);
		f.inventory.runs = [{ id: "observed-run", status: "running", attempt }];
		f.setHook(observed => { if (observed === point) throw new Error(`injected ${point}`); });
		await assert.rejects(f.recovery.reconcile(identity), new RegExp(point));
		assert.equal(f.observations.readObservations(identity).length, point.endsWith("before-commit") ? 0 : 1);
		f.setHook(() => {});
		assert.equal((await f.makeRecovery().reconcile(identity)).state, "held");
		f.inventory.runs = [];
		assert.equal((await f.makeRecovery().reconcile(identity)).state, "held");
		assert.equal(f.calls.release, 0);
	});
}

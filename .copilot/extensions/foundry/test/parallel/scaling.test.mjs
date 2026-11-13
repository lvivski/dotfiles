import assert from "node:assert/strict";
import { test } from "node:test";
import { generateWorkload, createRecoveryAdapter, createWorkloadAdapter, recoveryFence, assertWorkloadTrace, runWorkload } from "./workload.mjs";

test("logical workloads reproduce their DAG, contention, fault schedule and completion priorities", () => {
	for (const size of /** @type {const} */ ([32, 128])) {
		const workload = generateWorkload({ size, seed: 62 });
		assert.deepEqual(workload, generateWorkload({ size, seed: 62 }));
		assert.notDeepEqual(workload, generateWorkload({ size, seed: 63 }));
		assert.equal(workload.packages.filter(pkg => pkg.dependencies.length === 0).length, 8);
		assert.ok(workload.packages.slice(8).every(pkg => pkg.dependencies.length >= 2));
		const seen = new Set();
		for (const pkg of workload.packages) {
			assert.ok(pkg.dependencies.every(dependency => seen.has(dependency)), "Only preceding packages may be dependencies");
			assert.equal(new Set(pkg.dependencies).size, pkg.dependencies.length);
			seen.add(pkg.id);
		}
		assert.equal(seen.size, size);
		assert.equal(new Set(workload.packages.map(pkg => pkg.scenario)).size, 14);
	}
});

for (const size of /** @type {const} */ ([32, 128])) {
	test(`adapter-based simulation: production recovery settles ${size} logical packages across deterministic faults`, async () => {
		const workload = generateWorkload({ size, seed: 6206 + size });
		const adapter = createWorkloadAdapter(workload);
		try {
			const report = await runWorkload(workload, adapter);
			assert.equal(report.label, "adapter-based-simulation");
			assert.equal(report.assertions.admitted, size);
			assert.equal(report.assertions.completed, size);
			assert.ok(report.holds > 0);
			assert.ok(report.restarts > 0);
			assert.ok(report.reconciliations > size);
			const completed = report.snapshot.events.filter(event => event.kind === "completed").map(event => event.packageId);
			assert.notDeepEqual(completed, workload.packages.map(pkg => pkg.id), "Completion order must vary from declaration order");
			const calls = adapter.fixture.calls;
			assert.equal(calls.filter(call => call.operation === "release").length, size, "Production recovery must call the release authority");
			assert.equal(calls.filter(call => call.operation === "settle").length, size);
			assert.ok(calls.filter(call => ["cancel", "settle", "release"].includes(call.operation))
				.every(call => call.identity.owner === workload.owner), "Foreign admissions must never be mutated");
			if (size === 32) {
				const replay = createWorkloadAdapter(workload);
				try {
					assert.deepEqual(await runWorkload(workload, replay), report, "The complete fault/restart trace must replay deterministically");
				} finally {
					replay.dispose();
				}
			}
		} finally {
			adapter.dispose();
		}
	});
}

test("production recovery retains reservation gaps and multi-session quarantine without implicit cancellation", async () => {
	const workload = generateWorkload();
	const fixture = createRecoveryAdapter();
	const identity = { repositoryId: workload.repositoryId, owner: workload.owner,
		planId: "reservation-gap", taskId: "T-001", reservationId: "unbound-reservation" };
	try {
		const claim = fixture.admission.claim({ identity, expectedRevision: 0, resources: workload.packages[0].resources, team: null });
		assert.equal((await fixture.recovery.reconcile(identity)).state, "held");
		assert.deepEqual(fixture.admission.read(identity), claim);
		fixture.recovery.cancel(identity);
		const cancelling = fixture.admission.read(identity);
		for (let restart = 0; restart < 2; restart++) {
			fixture.restart();
			const result = await fixture.recovery.reconcile(identity);
			assert.equal(result.state, "held");
			assert.ok(result.holds.includes("reservation-outcome-unresolved"));
			assert.deepEqual(fixture.admission.read(identity), cancelling);
		}
		const reservedIdentity = { ...identity, taskId: "T-002", reservationId: "bound-reservation" };
		const reservedClaim = fixture.admission.claim({ identity: reservedIdentity, expectedRevision: 0, resources: [], team: null });
		const reserved = fixture.admission.bindReservation(recoveryFence(reservedClaim), { ...reservedIdentity, attemptId: "T-002-A001" });
		assert.equal((await fixture.recovery.reconcile(reservedIdentity)).state, "held");
		assert.deepEqual(fixture.admission.read(reservedIdentity), reserved);

		const quarantinedIdentity = { ...identity, taskId: "T-003", reservationId: "quarantined-reservation" };
		const quarantinedClaim = fixture.admission.claim({ identity: quarantinedIdentity, expectedRevision: 0, resources: [], team: null });
		const bound = fixture.admission.bindReservation(recoveryFence(quarantinedClaim), { ...quarantinedIdentity, attemptId: "T-003-A001" });
		assert.ok(bound.attempt);
		const attempt = bound.attempt;
		const cancelled = fixture.recovery.cancel(quarantinedIdentity);
		const observation = { attempt, sessionIds: ["observed-first", "observed-second"], runIds: ["observed-run"],
			source: "synthetic-authoritative-inventory", capturedAt: fixture.clock() };
		const retained = fixture.observations.retainObservation(recoveryFence(cancelled), observation);
		assert.deepEqual(fixture.observations.readObservations(quarantinedIdentity), [observation]);
		assert.deepEqual(fixture.observations.retainObservation(recoveryFence(retained), observation), retained,
			"An identical callback must not change the admission revision");
		assert.deepEqual(fixture.observations.readObservations(quarantinedIdentity), [observation],
			"Duplicate callbacks must not append duplicate rows");
		fixture.setObserver(async () => ({
			complete: true, source: "synthetic-authoritative-inventory", capturedAt: fixture.clock(),
			sessions: observation.sessionIds.map(id => ({ id, status: "completed", attempt })),
			runs: [{ id: "observed-run", status: "completed", attempt }],
		}));
		assert.equal((await fixture.recovery.reconcile(quarantinedIdentity)).state, "held",
			"Even two terminal sessions cannot fit the scalar settlement disposition");
		fixture.restart();
		assert.deepEqual(fixture.observations.readObservations(quarantinedIdentity), [observation]);
		fixture.setObserver(async () => ({
			complete: true, source: "synthetic-authoritative-inventory", capturedAt: fixture.clock(),
			sessions: [{ id: "observed-first", status: "completed", attempt }],
			runs: [{ id: "observed-run", status: "completed", attempt }],
		}));
		const held = await fixture.recovery.reconcile(quarantinedIdentity);
		assert.equal(held.state, "held", "Omitting a previously observed second session cannot clear quarantine");
		assert.equal(held.record.phase, "cancelling");
		assert.deepEqual(held.record.receipts, [], "Inventory identities must never become invented effect receipts");
		assert.throws(() => fixture.admission.settle(recoveryFence(held.record), [{
			attempt, sessionId: "observed-first", runIds: ["observed-run"], pendingEffectIds: [],
			disposition: "session-terminated", terminatedRunIds: ["observed-run"],
			inventory: { complete: true, source: "synthetic-authoritative-inventory", capturedAt: fixture.clock() },
		}]), /Multiple observed sessions/);
		assert.throws(() => fixture.admission.release(recoveryFence(held.record)), /Multiple observed sessions/);
		assert.equal(fixture.calls.filter(call => call.operation === "release").length, 0);
	} finally {
		fixture.dispose();
	}
});

test("independent trace oracle rejects duplicate admission, unmet predecessors and physical-scope overlap", () => {
	const workload = generateWorkload();
	const [a, b] = [workload.packages[0], workload.packages[4]];
	/** @param {typeof a} pkg */
	const admitted = pkg => ({
		kind: /** @type {const} */ ("admitted"), packageId: pkg.id, resources: pkg.resources,
		identity: { repositoryId: workload.repositoryId, owner: workload.owner, planId: "oracle",
			taskId: `T-${String(pkg.index + 1).padStart(3, "0")}`, reservationId: pkg.id },
	});
	const base = { records: [], observations: [], foreign: null };
	assert.throws(() => assertWorkloadTrace(workload, { ...base, events: [admitted(a), admitted(a)] }, false), /Duplicate admission/);
	assert.throws(() => assertWorkloadTrace(workload, { ...base, events: [admitted(workload.packages[8])] }, false), /Unmet dependency/);
	assert.throws(() => assertWorkloadTrace(workload, { ...base, events: [admitted(a), admitted(b)] }, false), /Exclusive overlap/);
	assert.throws(() => assertWorkloadTrace(workload, { ...base, events: [
		admitted(a), { kind: "fenced", packageId: a.id }, { kind: "started", packageId: a.id },
	] }, false), /after cancellation/);
});

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSquadAuthority, createSquadService } from "../../application/squads.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { createFactoryService } from "../../factory.mjs";
import { validateSquads } from "../../factory/squads.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt, retryTask } from "../../plan/execution.mjs";
import { approvalScope } from "../../plan/schemas/approval.mjs";
import { admissionFence, createAdmissionStore } from "../../storage/admission.mjs";
import { createPlanStore } from "../../storage.mjs";
import { charter, historicalIdentity, operatingFixture } from "../factory/operating.mjs";

/** Native inputs here are deterministic fixtures, not a supported App host.
 * The owner, canonical factory and admission writers are production SQLite.
 * @param {import("node:test").TestContext} t */
async function fixture(t) {
	const f = await operatingFixture(t, { rules: { charters: validateSquads } });
	const initial = f.authority().binding;
	assert.ok(initial);
	const live = { binding: initial, available: true };
	const ownership = /** @satisfies {import("../../types/operating.js").OperatingNativePort} */ ({
		assertAuthority(plan, authority) {
			assert.ok(live.available, "fixture ownership unresolved");
			assert.equal(plan.factory?.owner, f.owner);
			assert.deepEqual(authority.binding, live.binding, "fixture exact current App ownership");
		},
	});
	f.ports.native = createSquadAuthority({ ownership, coordinatorSessionId: "fixture-coordinator" });
	const open = () => createFactoryService({ repositoryPath: f.repo, storageRoot: f.storageRoot, operating: f.ports });
	const service = createSquadService({ operating: open().operating });
	return { ...f, live, ownership, service, open, reopen: () => createSquadService({ operating: open().operating }) };
}
/** @param {Awaited<ReturnType<typeof fixture>>} f */
async function grant(f) {
	const plan = f.store.readCurrent(f.planId);
	return f.store.createApprovalDelegation({
		id: "fixture-grant", scope: approvalScope(plan, "fixture-coordinator", "plan"),
		grant: { method: "native-ui-elicitation", grantedBy: "fixture", at: new Date().toISOString(), toolCallId: "fixture-form",
			statement: "Synthetic fixture instruction, not a real user grant", planId: plan.id, planRevision: plan.revision },
		revocation: null,
	});
}
/** @param {Awaited<ReturnType<typeof fixture>>} f */
const revoke = f => f.store.revokeApprovalDelegation("fixture-grant", f.owner, "fixture-coordinator",
	{ at: new Date().toISOString(), actor: "fixture", reason: "Deterministic precommit revocation", toolCallId: "fixture-revoke" });
/** @param {string} id @param {import("../../types/operating.js").OperatingCategory} [category]
 * @returns {import("../../types/operating.js").OperatingDecision} */
function decision(id, category = "observation") {
	return { version: 1, kind: "decision", id, revision: 1, previous: null, source: historicalIdentity, context: [],
		charter: { id: "squad", revision: 1 }, goal: null, category, status: category === "observation" ? "observation" : "historical",
		rationale: "Bounded fixture decision with original actor/source", governing: [] };
}

test("SG-SQUAD-02 exact App identity and action-time ownership, not identical labels or caller IDs, authorize writes", async t => {
	const f = await fixture(t);
	const batch = f.batch("initial", [charter()]);
	const before = f.store.readCurrent(f.planId);
	const canonical = f.factory.exportFactory();
	for (const key of ["projectId", "sessionId", "owner", "planId", "taskId", "attemptId", "observationDigest"]) {
		const authority = f.authority();
		assert.ok(authority.binding);
		Object.assign(authority.binding, { [key]: key === "observationDigest" ? "f".repeat(64) : "foreign" });
		assert.throws(() => f.service.commit(batch, authority), key);
		assert.deepEqual(f.store.readCurrent(f.planId), before);
		assert.equal(f.factory.exportFactory(), canonical);
	}
	f.live.available = false;
	assert.throws(() => f.service.commit(batch, f.authority()), /ownership unresolved/);
	f.live.available = true;
	f.service.commit(batch, f.authority());
	assert.equal(f.reopen().history({ id: "squad", revision: 1 }).binding.state, "unresolved");
	assert.equal(f.store.readCurrent(f.planId).operating?.local[0].binding?.sessionId, "fixture-worker");
	assert.deepEqual(f.admission.read(f.fence.admission)?.receipts, []);
});

test("SG-SQUAD-03 missing fenced native capability and asynchronous observations hold without intent", async t => {
	const f = await fixture(t);
	const batch = f.batch("initial", [charter()]);
	f.ports.native = createSquadAuthority({ coordinatorSessionId: "fixture-coordinator" });
	assert.throws(() => f.reopen().commit(batch, f.authority()), { code: "squad_ownership_unavailable" });
	f.ports.native = createSquadAuthority({ coordinatorSessionId: "fixture-coordinator",
		ownership: { assertAuthority: async () => {} } });
	assert.throws(() => f.reopen().commit(batch, f.authority()), { code: "squad_ownership_unavailable" });
	assert.equal(f.store.readCurrent(f.planId).operating, undefined);
	assert.equal(f.open().snapshot().operating, undefined);
});

test("SG-SQUAD-03 charters and plan grants cannot create approval receipts or broaden authority categories", async t => {
	const f = await fixture(t);
	const delegation = await grant(f);
	const record = { ...charter(), decisions: /** @type {import("../../types/operating.js").OperatingCategory[]} */ (
		["observation", "proposal", "plan", "completion", "technical-retry", "evaluator-renewal", "contract", "replacement", "human", "external", "resource"]) };
	f.service.commit(f.batch("initial", [record]), f.authority());
	const before = f.store.readCurrent(f.planId);
	const canonical = f.factory.exportFactory();
	for (const category of record.decisions.filter(category => !["observation", "proposal"].includes(category))) {
		const entry = decision(`decision-${category}`, category);
		assert.throws(() => f.service.commit(f.batch(`batch-${category}`, [entry]), { ...f.authority(), delegationId: delegation.id }));
		assert.deepEqual(f.store.readCurrent(f.planId), before);
		assert.equal(f.factory.exportFactory(), canonical);
	}
	const proposal = { ...decision("contract-proposal", "contract"), status: /** @type {const} */ ("proposal") };
	f.service.commit(f.batch("non-governing-proposal", [proposal]), f.authority());
	assert.deepEqual(f.factory.snapshot().contracts, []);
	assert.deepEqual(await f.store.getApprovalDelegation(delegation.id), delegation);
	const forged = { ...decision("human-report", "human"), source: { ...historicalIdentity, kind: /** @type {const} */ ("human") } };
	const raw = { version: /** @type {const} */ (1), id: "human-forgery", snapshot: f.factory.operating.snapshot().token, records: [forged], source: forged.source };
	assert.throws(() => f.service.commit(raw, f.authority()), { code: "squad_actor_mismatch" });
});

test("SG-SQUAD-03 supplied delegations require exact current capability scope even for ordinary records", async t => {
	const f = await fixture(t);
	const original = await grant(f);
	const batch = f.batch("initial", [charter()]);
	const before = f.store.readCurrent(f.planId);
	for (const changed of [
		{ unitId: "foreign-unit" }, { unitRevision: original.scope.unitRevision + 1 },
		{ repositoryPath: `${f.repo}/other` }, { coordinatorSessionId: "foreign-coordinator" },
		{ contractDigest: "f".repeat(64) },
	]) {
		const db = new DatabaseSync(f.store.databasePath);
		try {
			// Simulate retained foreign scope in the actual authority store, not a caller-supplied grant.
			db.prepare("UPDATE approval_delegations SET document=? WHERE id=?")
				.run(JSON.stringify({ ...original, scope: { ...original.scope, ...changed } }), original.id);
			assert.throws(() => f.service.commit(batch, { ...f.authority(), delegationId: original.id }), { code: "squad_delegation_out_of_scope" });
			assert.deepEqual(f.store.readCurrent(f.planId), before);
		} finally {
			db.prepare("UPDATE approval_delegations SET document=? WHERE id=?").run(JSON.stringify(original), original.id);
			db.close();
		}
	}
	f.service.commit(batch, { ...f.authority(), delegationId: original.id });
	assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 1);
});

test("SG-SQUAD-03/07 a validated baseline receipt may be recorded but does not execute or transfer its approval", async t => {
	const f = await fixture(t);
	const delegation = await grant(f);
	const before = f.store.readCurrent(f.planId);
	assert.ok(before.factory);
	const receipt = {
		delegation, planId: before.id, planRevision: before.revision, blueprintDigest: before.factory.blueprintDigest,
		sessionId: "fixture-coordinator", toolCallId: "fixture-approval", review: "Synthetic baseline receipt checked by production plan validation",
	};
	// This is an explicitly synthetic native approval fixture, not user consent.
	await f.store.update(f.planId, before.revision, { ...before,
		gates: { ...before.gates, planApprovedBy: "agent-session:fixture-coordinator", delegatedApproval: receipt } });
	f.service.commit(f.batch("initial", [{ ...charter(), decisions: ["observation", "proposal", "plan"] }]), f.authority());
	const source = { ...historicalIdentity, source: analysisInputDigest(receipt) };
	const entry = { ...decision("retained-approval", "plan"), source };
	const batch = { ...f.batch("historical-approval", [entry]), source };
	const authority = { ...f.authority(), delegationId: delegation.id };
	const authorized = f.store.readCurrent(f.planId);
	f.service.commit(batch, authority);
	assert.deepEqual(f.store.readCurrent(f.planId).gates, authorized.gates);
	assert.deepEqual(f.reopen().history({ id: "squad", revision: 1 }).decisions, [entry]);
	assert.deepEqual(await f.store.getApprovalDelegation(delegation.id), delegation);
	const siblingGrant = await f.store.createApprovalDelegation({ ...delegation, id: "same-scope-different-grant",
		grant: { ...delegation.grant, planRevision: f.store.readCurrent(f.planId).revision } });
	const another = { ...entry, id: "mismatched-receipt" };
	assert.throws(() => f.service.commit({ ...f.batch("not-the-receipt-grant", [another]), source },
		{ ...f.authority(), delegationId: siblingGrant.id }), { code: "squad_decision_receipt_missing" });
});

test("SG-SQUAD-09 revocation between validation and owner commit rolls back; stale replay after reopen is also denied", async t => {
	const f = await fixture(t);
	const delegation = await grant(f);
	const batch = f.service.prepare(f.batch("initial", [charter()]));
	const authority = { ...f.authority(), delegationId: delegation.id };
	let pending = Promise.resolve();
	const trace = ["validated"];
	const original = f.ports.admission;
	f.ports.admission = {
		...original,
		withFence(fence, operation) {
			pending = revoke(f).then(() => {});
			trace.push("revoked-before-owner-commit");
			return original.withFence(fence, operation);
		},
	};
	const before = f.store.readCurrent(f.planId);
	assert.throws(() => f.reopen().commit(batch, authority), { code: "operating_delegation_unavailable" });
	await pending;
	f.ports.admission = original;
	assert.deepEqual(trace, ["validated", "revoked-before-owner-commit"]);
	assert.deepEqual(createPlanStore({ workspacePath: f.owner }).readCurrent(f.planId), before);
	assert.equal(f.open().snapshot().operating, undefined);
	assert.throws(() => f.reopen().commit(batch, authority), { code: "operating_delegation_unavailable" });
	assert.deepEqual(f.admission.read(f.fence.admission)?.receipts, []);
});

test("SG-SQUAD-09 changed owner plan and native attachment after validation cannot reach the linearizing commit", async t => {
	for (const change of ["owner", "attachment"]) await t.test(change, async t => {
		const f = await fixture(t);
		const batch = f.service.prepare(f.batch("initial", [charter()]));
		const authority = f.authority();
		const before = f.store.readCurrent(f.planId);
		let pending = Promise.resolve();
		const original = f.ports.admission;
		f.ports.admission = {
			...original,
			withFence(fence, operation) {
				if (change === "owner") {
					pending = f.store.update(f.planId, before.revision, { ...before, title: "Owner revision changed after validation" }).then(() => {});
				} else {
					f.live.binding = { ...f.live.binding, observationDigest: analysisInputDigest("replacement-native-attachment") };
				}
				return original.withFence(fence, operation);
			},
		};
		assert.throws(() => f.reopen().commit(batch, authority));
		await pending;
		f.ports.admission = original;
		assert.equal(f.store.readCurrent(f.planId).operating, undefined);
		assert.equal(f.open().snapshot().operating, undefined);
		assert.throws(() => f.reopen().commit(batch, authority));
		const current = f.authority();
		current.binding = f.live.binding;
		f.reopen().commit(batch, current);
		assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 1, "Fresh valid control commits normally");
	});
});

test("SG-SQUAD-09 owner transaction failure differs from committed outbox interruption and exact historical recovery", async t => {
	const f = await fixture(t);
	const delegation = await grant(f);
	const batch = f.batch("interrupted", [charter()]);
	const authority = { ...f.authority(), delegationId: delegation.id };
	let db = new DatabaseSync(f.store.databasePath);
	db.exec("CREATE TRIGGER reject_squad BEFORE UPDATE ON plans BEGIN SELECT RAISE(ABORT, 'fixture owner interruption'); END");
	db.close();
	assert.throws(() => f.service.commit(batch, authority));
	assert.equal(f.store.readCurrent(f.planId).operating, undefined);
	assert.equal(f.open().snapshot().operating, undefined);
	db = new DatabaseSync(f.store.databasePath);
	db.exec("DROP TRIGGER reject_squad");
	db.close();
	db = new DatabaseSync(f.factory.databasePath);
	db.exec("CREATE TRIGGER reject_squad BEFORE INSERT ON factory_events BEGIN SELECT RAISE(ABORT, 'fixture postcommit interruption'); END");
	db.close();
	assert.throws(() => f.service.commit(batch, authority), { code: "operating_publication_pending" });
	const committed = f.store.readCurrent(f.planId);
	const publication = committed.operating?.publications[0];
	assert.ok(publication);
	assert.equal(f.open().snapshot().operating, undefined);
	await revoke(f);
	f.live.available = false;
	f.admission.cancel(f.fence);
	db = new DatabaseSync(f.factory.databasePath);
	db.exec("DROP TRIGGER reject_squad");
	db.close();
	const reopened = f.reopen();
	assert.deepEqual(reopened.reconcile(f.planId, publication.digest), publication);
	assert.deepEqual(reopened.reconcile(f.planId, publication.digest), publication);
	assert.equal(reopened.history({ id: "squad", revision: 1 }).binding.state, "unresolved");
	assert.deepEqual(f.store.readCurrent(f.planId), committed, "Replay cannot establish another binding or authority");
	assert.equal(f.open().snapshot().operating?.length, 1);
	assert.throws(() => reopened.commit(f.batch("new-after-revocation", [decision("new")]), f.authority()));
	assert.throws(() => reopened.reconcile(f.planId, "f".repeat(64)), { code: "operating_authorization_missing" });
	assert.ok((await f.store.getApprovalDelegation(delegation.id))?.revocation);
});

test("SG-SQUAD-04 worker replacement uses a new existing admission and retains old attribution and context", async t => {
	const f = await fixture(t);
	const authority = f.authority();
	authority.references = [{ id: "continuity", kind: "context", ref: "private:fixture-context", digest: analysisInputDigest("safe-reference") }];
	f.service.commit(f.batch("initial", [charter(), decision("original-lesson")]), authority);
	const oldPlan = f.store.readCurrent(f.planId);
	const cancelled = f.admission.cancel(f.fence);
	assert.ok(cancelled.attempt);
	const observed = f.admission.retainObservation(admissionFence(cancelled), {
		attempt: cancelled.attempt, sessionIds: ["fixture-worker"], runIds: [],
		source: "synthetic native identity retained before replacement", capturedAt: new Date().toISOString(),
	});
	assert.throws(() => f.admission.release(admissionFence(observed)), { code: "parallel_unsafe_release" });
	const settled = f.admission.settle(admissionFence(observed), observed.obligations.map(obligation => ({
		...obligation, disposition: /** @type {const} */ ("session-terminated"),
		inventory: { complete: true, source: "fixture terminal inventory, not live App", capturedAt: "2099-01-01T00:00:00.000Z" },
	})));
	f.admission.release(admissionFence(settled));
	let plan = completeTaskAttempt(oldPlan, "T-001", "T-001-A001", "failed", { error: "Fixture worker stopped",
		sessionTerminatedAt: new Date().toISOString() });
	plan = retryTask(plan, "T-001");
	plan = reserveTaskAttempt(plan, "T-001", { reservationId: "replacement-reservation" });
	plan = attachTaskAttempt(plan, "T-001", "T-001-A002", { sessionId: "replacement-worker", branch: "fixture/replacement" });
	plan = await f.store.update(f.planId, oldPlan.revision, plan);
	const identity = { ...f.fence.admission, reservationId: "replacement-reservation" };
	const claimed = f.admission.claim({ identity, expectedRevision: 0, resources: [], team: null });
	const reserved = f.admission.bindReservation(admissionFence(claimed), { ...identity, attemptId: "T-001-A002" });
	f.live.binding = { ...f.live.binding, sessionId: "replacement-worker", attemptId: "T-001-A002", observationDigest: analysisInputDigest("replacement-observation") };
	const source = { ...historicalIdentity, identity: analysisInputDigest("replacement-worker") };
	const entry = { ...decision("replacement-lesson"), source };
	const batch = f.batch("replacement", [entry]);
	batch.source = source;
	const replacement = { ...f.authority(), expectedPlanRevision: plan.revision, attemptId: "T-001-A002",
		fence: admissionFence(reserved), binding: f.live.binding };
	assert.throws(() => f.reopen().commit(batch, { ...replacement, fence: f.fence }), "Old reservation cannot transfer");
	f.reopen().commit(batch, replacement);
	const history = f.reopen().history({ id: "squad", revision: 1 });
	assert.deepEqual(history.decisions.map(record => record.source.identity), [historicalIdentity.identity, source.identity]);
	const stored = createPlanStore({ workspacePath: f.owner }).readCurrent(f.planId);
	assert.equal(stored.operating?.local[0].binding?.sessionId, "fixture-worker");
	assert.equal(stored.operating?.local[1].binding?.sessionId, "replacement-worker");
	assert.deepEqual(stored.operating?.local[0].references, authority.references);
	assert.deepEqual(stored.tasks[0].attempts[0].id, oldPlan.tasks[0].attempts[0].id);
	assert.equal(await f.store.getApprovalDelegation("transferred-grant"), null);
});

test("SG-SQUAD-06 competing squads consume only canonical claims and released or uncertain claims cannot authorize work", async t => {
	const f = await fixture(t);
	const resource = { id: "shared-output", kind: /** @type {const} */ ("shared-write"), scope: `${f.root}/output`,
		mode: /** @type {const} */ ("exclusive"), capacity: 1, units: 1 };
	const identity = { ...f.fence.admission, taskId: "T-003", reservationId: "shared-reservation" };
	const first = f.admission.claim({ identity, expectedRevision: 0, resources: [resource], team: null });
	const rivalOwner = `${f.root}/rival`;
	const rival = createAdmissionStore({ workspacePath: f.root, directoryParts: ["admission"],
		repositoryId: identity.repositoryId, owner: rivalOwner });
	assert.throws(() => rival.claim({ identity: { ...identity, owner: rivalOwner, reservationId: "rival-reservation" },
		expectedRevision: 0, resources: [{ ...resource, id: "different-squad-same-resource" }], team: null }), { code: "parallel_capacity_held" });
	f.service.commit(f.batch("assigned", [charter()]), f.authority());
	const batch = f.batch("done-label-is-not-authority", [decision("claimed-done")]);
	f.live.available = false;
	assert.throws(() => f.reopen().commit(batch, f.authority()), /ownership unresolved/);
	f.live.available = true;
	const cancelled = f.admission.cancel(f.fence);
	assert.throws(() => f.reopen().commit(batch, { ...f.authority(), fence: admissionFence(cancelled) }));
	assert.throws(() => f.reopen().commit(batch, { ...f.authority(), fence: admissionFence(first) }));
	assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 1);
	assert.equal(f.admission.read(identity)?.phase, "claim-held");
});

import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPlanStore } from "../../storage.mjs";
import { approvalScope } from "../../plan/schemas/approval.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { charter, goal, historicalIdentity, operatingFixture } from "../factory/operating.mjs";

/** @param {Awaited<ReturnType<typeof operatingFixture>>} f */
async function grant(f) {
	f.native.coordinatorSessionId = "fixture-coordinator";
	const plan = f.store.readCurrent(f.planId);
	return f.store.createApprovalDelegation({
		id: "fixture-grant", scope: approvalScope(plan, "fixture-coordinator", "plan"),
		grant: { method: "native-ui-elicitation", grantedBy: "fixture", at: new Date().toISOString(), toolCallId: "fixture-form",
			statement: "Synthetic fixture instruction; not a live user grant", planId: plan.id, planRevision: plan.revision },
		revocation: null,
	});
}

test("owner writer rejects stale plan revisions, foreign bindings and native denial without outbox or authority", async t => {
	const f = await operatingFixture(t);
	const batch = f.batch("first", [charter()]);
	const authority = f.authority();
	await f.store.update(f.planId, authority.expectedPlanRevision, { ...f.store.readCurrent(f.planId), title: "Concurrent revision" });
	const before = f.store.readCurrent(f.planId);
	const factoryBefore = f.factory.exportFactory();
	assert.throws(() => f.factory.operating.commit(batch, authority), { code: "revision_conflict" });
	assert.throws(() => f.factory.operating.commit(batch, { ...f.authority(), binding: null }), { code: "operating_binding_required" });
	const foreign = f.authority();
	assert.ok(foreign.binding);
	foreign.binding.sessionId = "foreign-worker";
	assert.throws(() => f.factory.operating.commit(batch, foreign), { code: "operating_authority_changed" });
	f.observation.allowed = false;
	assert.throws(() => f.factory.operating.commit(batch, f.authority()), /fixture native denial/);
	assert.deepEqual(f.store.readCurrent(f.planId), before);
	assert.equal(f.factory.exportFactory(), factoryBefore);
	assert.deepEqual(f.admission.read(f.fence.admission)?.receipts, []);
});

test("canonical cancellation fence blocks prepared operating writes after restart", async t => {
	const f = await operatingFixture(t);
	const batch = f.batch("cancelled", [charter()]);
	f.admission.cancel(f.fence);
	assert.throws(() => f.open().operating.commit(batch, f.authority()));
	assert.equal(f.store.readCurrent(f.planId).operating, undefined);
	assert.equal(f.factory.snapshot().operating, undefined);
});

test("owner writer rereads an actual revoked delegation instead of trusting prepared authority", async t => {
	const f = await operatingFixture(t);
	const delegation = await grant(f);
	const batch = f.batch("revoked", [charter()]);
	const authority = { ...f.authority(), delegationId: delegation.id };
	await f.store.revokeApprovalDelegation(delegation.id, f.owner, "fixture-coordinator",
		{ at: new Date().toISOString(), actor: "fixture", reason: "Revoked after preparation", toolCallId: "fixture-revoke" });
	assert.throws(() => f.open().operating.commit(batch, authority), { code: "operating_delegation_unavailable" });
	assert.equal(f.store.readCurrent(f.planId).operating, undefined);
	assert.equal(f.open().snapshot().operating, undefined);
	assert.ok((await f.store.getApprovalDelegation(delegation.id))?.revocation);
});

test("failed owner transaction rolls back every record and publication intent", async t => {
	const f = await operatingFixture(t);
	const before = f.store.readCurrent(f.planId);
	const db = new DatabaseSync(f.store.databasePath);
	db.exec("CREATE TRIGGER reject_operating BEFORE UPDATE ON plans BEGIN SELECT RAISE(ABORT, 'injected owner interruption'); END");
	db.close();
	assert.throws(() => f.factory.operating.commit(f.batch("rollback", [charter(), goal("goal")]), f.authority()), /SQLite|database|injected/);
	assert.deepEqual(createPlanStore({ workspacePath: f.owner }).readCurrent(f.planId), before);
	assert.equal(f.open().snapshot().operating, undefined);
});

test("post-authorization interruption replays only the exact committed batch, even after native revocation", async t => {
	const f = await operatingFixture(t);
	const delegation = await grant(f);
	const batch = f.batch("interrupted", [charter(), goal("goal")]);
	const db = new DatabaseSync(f.factory.databasePath);
	db.exec("CREATE TRIGGER reject_operating BEFORE INSERT ON factory_events BEGIN SELECT RAISE(ABORT, 'injected publication interruption'); END");
	db.close();
	assert.throws(() => f.factory.operating.commit(batch, { ...f.authority(), delegationId: delegation.id }),
		{ code: "operating_publication_pending" });
	const committed = f.store.readCurrent(f.planId);
	assert.equal(committed.operating?.publications.length, 1);
	assert.equal(f.factory.snapshot().operating, undefined);
	const publication = committed.operating?.publications[0];
	assert.ok(publication);
	const repair = new DatabaseSync(f.factory.databasePath);
	repair.exec("DROP TRIGGER reject_operating");
	repair.close();
	f.observation.allowed = false;
	await f.store.revokeApprovalDelegation(delegation.id, f.owner, "fixture-coordinator",
		{ at: new Date().toISOString(), actor: "fixture", reason: "Revoked after authorization committed", toolCallId: "fixture-revoke" });
	f.admission.cancel(f.fence);
	const recovered = f.open();
	assert.deepEqual(recovered.operating.reconcile(f.planId, publication.digest), publication);
	assert.deepEqual(recovered.operating.reconcile(f.planId, publication.digest), publication);
	assert.equal(recovered.snapshot().operating?.length, 1);
	assert.deepEqual(f.store.readCurrent(f.planId), committed);
	assert.ok((await f.store.getApprovalDelegation(delegation.id))?.revocation);
	assert.throws(() => recovered.operating.commit(f.batch("new-operation", [charter("squad", 2)]), f.authority()));
	assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 1);
});

test("pending outbox cannot rebase onto a concurrently changed effective snapshot", async t => {
	const f = await operatingFixture(t);
	const db = new DatabaseSync(f.factory.databasePath);
	db.exec("CREATE TRIGGER reject_operating BEFORE INSERT ON factory_events BEGIN SELECT RAISE(ABORT, 'interruption'); END");
	db.close();
	assert.throws(() => f.factory.operating.commit(f.batch("pending", [charter()]), f.authority()), { code: "operating_publication_pending" });
	const publication = f.store.readCurrent(f.planId).operating?.publications[0];
	assert.ok(publication);
	const repair = new DatabaseSync(f.factory.databasePath);
	repair.exec("DROP TRIGGER reject_operating");
	repair.close();
	f.factory.appendKnowledge({ expectedRevision: f.factory.snapshot().revision, id: "competing", unitId: "unit", kind: "observation",
		statement: "A distinct concurrent factory record", source: { kind: "discovery", ref: "fixture:competing", actor: "fixture", at: new Date().toISOString() } });
	assert.throws(() => f.open().operating.reconcile(f.planId, publication.digest), { code: "revision_conflict" });
	assert.equal(f.factory.snapshot().operating, undefined);
	assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 1);
});

test("plan import retains immutable attribution but strips even forged local authority and private bindings", async t => {
	const f = await operatingFixture(t);
	const publication = f.factory.operating.commit(f.batch("record", [charter()]), f.authority());
	const source = f.store.readCurrent(f.planId);
	assert.equal(source.operating?.local.length, 1);
	assert.throws(() => f.store.operating.commit(publication, f.authority(), f.native, { kind: "operating-validated-commit" }),
		{ code: "operating_validation_required" });
	const importedRoot = path.join(f.root, "imported-owner");
	await mkdir(importedRoot);
	const imported = createPlanStore({ workspacePath: importedRoot });
	await imported.importPlan(source, { expectedRevision: 0 });
	assert.deepEqual(imported.readCurrent(f.planId).operating?.publications, source.operating?.publications);
	assert.deepEqual(imported.readCurrent(f.planId).operating?.local, []);
	assert.throws(() => imported.operating.require(f.planId, publication.digest), { code: "operating_authorization_missing" });
	assert.equal(await imported.getApprovalDelegation("invented"), null);
	assert.throws(() => imported.requireTechnicalAuthorization(f.planId, "invented", publication.digest), { code: "technical_authorization_missing" });
	await assert.rejects(imported.update(f.planId, source.revision, source), { code: "operating_history_immutable" });
	assert.deepEqual(f.store.readCurrent(f.planId), source);
});

test("direct canonical writes cannot bypass charter ownership, actor identity or category-specific receipts", async t => {
	const f = await operatingFixture(t, { rules: {} });
	const delegation = await grant(f);
	const initial = { ...charter(), decisions: /** @type {import("../../types/operating.js").OperatingCategory[]} */ (["observation", "proposal", "plan", "completion", "human", "external"]) };
	f.factory.operating.commit(f.batch("initial", [initial, goal("owned")]), f.authority());
	const other = f.authority();
	assert.ok(other.binding);
	other.binding.charter = { id: "other", revision: 1 };
	f.factory.operating.commit(f.batch("other", [charter("other")]), other);
	const before = f.store.readCurrent(f.planId);
	const canonical = f.factory.exportFactory();
	const transferred = { ...goal("owned", 2), charter: { id: "other", revision: 1 } };
	other.expectedPlanRevision = before.revision;
	assert.throws(() => f.factory.operating.commit(f.batch("takeover", [transferred]), other), { code: "operating_owner_mismatch" });
	assert.throws(() => f.factory.operating.commit(f.batch("foreign-charter", [charter("third")]), f.authority()), { code: "operating_owner_mismatch" });
	const source = { ...historicalIdentity, identity: analysisInputDigest("forged-worker") };
	const forgedActor = { ...goal("owned", 2), source };
	const actorBatch = { ...f.batch("forged-actor", [forgedActor]), source };
	assert.throws(() => f.factory.operating.commit(actorBatch, f.authority()), { code: "squad_actor_mismatch" });
	for (const category of /** @type {const} */ (["plan", "completion", "external"])) {
		const decision = {
			version: /** @type {const} */ (1), kind: /** @type {const} */ ("decision"), id: `forged-${category}`, revision: 1,
			previous: null, source: historicalIdentity, context: [], charter: { id: "squad", revision: 1 }, goal: null,
			category, status: /** @type {const} */ ("historical"), rationale: "A charter or a category label is not an approval", governing: [],
		};
		assert.throws(() => f.factory.operating.commit(f.batch(`forged-${category}`, [decision]),
			{ ...f.authority(), delegationId: delegation.id }));
	}
	assert.deepEqual(f.store.readCurrent(f.planId), before);
	assert.equal(f.factory.exportFactory(), canonical);
	assert.deepEqual(f.admission.read(f.fence.admission)?.receipts, []);
	assert.deepEqual(await f.store.getApprovalDelegation(delegation.id), delegation);
	f.factory.goals.commit(f.batch("valid-owner", [goal("owned", 2)]), f.authority());
	assert.equal(f.store.readCurrent(f.planId).operating?.publications.length, 3);
});

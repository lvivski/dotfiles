import assert from "node:assert/strict";
import {
	readdir, readFile, writeFile
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createPlanStore } from "../../storage.mjs";
import { finalizePlanCancellation, requestPlanCancellation } from "../../plan/cancellation.mjs";
import { attachTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { approvePlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { PLAN_STATUS } from "../../plan/values.mjs";
import { makePlan, rejectsCode, UPDATED_AT, withDatabase, withWorkspace } from "./fixture.mjs";

test("session storage adds delegation rows to schema 1 without changing plans or activation", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const activation = await store.activate(plan.id, plan.revision);
		withDatabase(store, (db) => db.exec("DROP TABLE approval_delegations; DROP TABLE technical_authorizations; PRAGMA user_version = 1"));
		const restarted = createPlanStore({ workspacePath: workspace });
		assert.equal(await restarted.getApprovalDelegation("not-granted"), null);
		assert.deepEqual(await restarted.read(plan.id), plan);
		assert.deepEqual(await restarted.getActivation(), activation);
		assert.equal(withDatabase(store, (db) => db.prepare("PRAGMA user_version").get()?.user_version), 3);
		withDatabase(store, (db) => db.exec("PRAGMA user_version = 99"));
		await rejectsCode(restarted.getApprovalDelegation("not-granted"), "database_version_unsupported");
	})
));

test("schema 2 upgrade preserves revoked historical grants without inventing technical authorization", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const activation = await store.activate(plan.id, plan.revision);
		const historical = {
			id: "historical-grant",
			scope: { owner: workspace, coordinatorSessionId: "owner", repositoryId: "a".repeat(64),
				repositoryPath: workspace, unitId: "unit", unitRevision: 1, contractDigest: null },
			grant: { method: "native-ui-elicitation", grantedBy: "human", at: UPDATED_AT,
				toolCallId: "original-form", statement: "Initial plan approval only", planId: plan.id, planRevision: 1 },
			revocation: { at: UPDATED_AT, actor: "human", reason: "Retain the original revocation", toolCallId: "revoke" },
		};
		withDatabase(store, db => {
			db.prepare("INSERT INTO approval_delegations VALUES (?, ?)").run(historical.id, JSON.stringify(historical));
			db.exec("DROP TABLE technical_authorizations; PRAGMA user_version = 2");
		});
		const restarted = createPlanStore({ workspacePath: workspace });
		assert.deepEqual(await restarted.getApprovalDelegation(historical.id), historical);
		assert.deepEqual(await restarted.read(plan.id), plan);
		assert.deepEqual(await restarted.getActivation(), activation);
		assert.throws(() => restarted.requireTechnicalAuthorization(plan.id, "invented-decision", "b".repeat(64)),
			{ code: "technical_authorization_missing" });
		assert.equal(withDatabase(store, db => db.prepare("SELECT count(*) AS count FROM technical_authorizations").get()?.count), 0);
	})
));

test("activation is revision-checked, durable, replaceable, and session-local", () => (
	withWorkspace(async ({ workspace, store }) => {
		const first = await store.create(makePlan(workspace, "first-plan"), 0);
		const second = await store.create(makePlan(workspace, "second-plan"), 0);
		assert.equal(await store.getActivation(), null);
		assert.deepEqual(await store.deactivate(), { deactivated: false, planId: null, repaired: false });
		const initial = await store.activate(first.id, 1);
		await rejectsCode(store.activate(second.id, 2), "revision_conflict");
		assert.deepEqual(await store.getActivation(), initial);
		const marker = await store.activate(second.id, 1);
		assert.deepEqual(marker, { planId: second.id, activatedAt: UPDATED_AT });
		const restarted = createPlanStore({ workspacePath: workspace });
		assert.deepEqual(await restarted.getActivation(), marker);
		const updated = await store.update(second.id, 1, { ...second, title: "Latest activated revision" });
		assert.deepEqual(await restarted.getActive(), { ...marker, plan: updated });
		await withWorkspace(async ({ store: unrelated }) => assert.equal(await unrelated.getActivation(), null));
		assert.deepEqual(await restarted.deactivate(), { deactivated: true, planId: second.id, repaired: false });
		assert.equal(await store.getActive(), null);
	})
));

test("getActivation reads only metadata even when the activated plan is corrupt", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const marker = await store.activate(plan.id, 1);
		withDatabase(store, (db) => db.prepare("UPDATE plans SET document = ? WHERE id = ?").run("{", plan.id));
		assert.deepEqual(await store.getActivation(), marker);
		await rejectsCode(store.getActive(), "artifact_invalid");
		assert.deepEqual(await store.deactivate(), { deactivated: true, planId: plan.id, repaired: false });
	})
));

test("invalid activation metadata is explicitly repaired on deactivation", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		for (const invalid of [
			{ id: plan.id, at: "not a date", code: "activation_invalid" },
			{ id: plan.id, at: "2026-08-05T16:00:00Z", code: "activation_invalid" },
			{ id: "../escape", at: UPDATED_AT, code: "invalid_plan_id" },
		]) {
			withDatabase(store, (db) => db.prepare(
				"INSERT INTO activation (singleton, plan_id, activated_at) VALUES (1, ?, ?)",
			).run(invalid.id, invalid.at));
			await rejectsCode(store.getActivation(), invalid.code);
			await rejectsCode(store.getActive(), invalid.code);
			assert.deepEqual(await store.deactivate(), { deactivated: true, planId: null, repaired: true });
			assert.equal(await store.getActivation(), null);
		}
	})
));

test("quarantine preserves invalid JSON and attribution transactionally while releasing the ID", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		const request = { reason: "Preserve corrupt source", requestedBy: "tester" };
		await rejectsCode(store.quarantineInvalidPlan(plan.id, request), "artifact_valid");
		await rejectsCode(store.quarantineInvalidPlan(plan.id, { ...request, reason: " " }), "invalid_quarantine_request");
		const broken = "{ not JSON\n";
		withDatabase(store, (db) => db.prepare("UPDATE plans SET document = ? WHERE id = ?").run(broken, plan.id));
		const result = await store.quarantineInvalidPlan(plan.id, request);
		assert.deepEqual(Object.keys(result).sort(), ["planId", "quarantineId", "quarantinedAt", "reason", "requestedBy"]);
		assert.equal(result.quarantinedAt, UPDATED_AT);
		const row = withDatabase(store, (db) => db.prepare("SELECT * FROM quarantine WHERE id = ?").get(result.quarantineId));
		assert.ok(row);
		assert.equal(row.document, broken);
		assert.equal(row.plan_id, plan.id);
		assert.equal(row.revision, 1);
		assert.equal(row.reason, request.reason);
		assert.equal(row.requested_by, request.requestedBy);
		await rejectsCode(store.read(plan.id), "plan_not_found");
		assert.deepEqual(await store.list(), { plans: [], invalid: [], truncated: false });
		assert.deepEqual(await store.create(plan, 0), plan);
		assert.equal(withDatabase(store, (db) => db.prepare("SELECT count(*) AS count FROM quarantine").get()?.count), 1);
		assert.deepEqual(await readdir(store.directory), ["foundry.sqlite"]);
	})
));

test("quarantine rolls back both records if removal fails after preservation", () => (
	withWorkspace(async ({ workspace, store }) => {
		const plan = await store.create(makePlan(workspace), 0);
		withDatabase(store, (db) => {
			db.prepare("UPDATE plans SET document = ? WHERE id = ?").run("{", plan.id);
			db.exec("CREATE TRIGGER reject_delete BEFORE DELETE ON plans BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
		});
		await rejectsCode(store.quarantineInvalidPlan(plan.id, { reason: "Test rollback", requestedBy: "tester" }), "database_error");
		withDatabase(store, (db) => {
			assert.equal(db.prepare("SELECT document FROM plans WHERE id = ?").get(plan.id)?.document, "{");
			assert.equal(db.prepare("SELECT count(*) AS count FROM quarantine").get()?.count, 0);
			db.exec("DROP TRIGGER reject_delete");
		});
		await store.quarantineInvalidPlan(plan.id, { reason: "Retry", requestedBy: "tester" });
		assert.equal((await store.list()).invalid.length, 0);
	})
));

test("cancellation restart retains a late child and rolls back interrupted finalization without touching foreign data", () => (
	withWorkspace(async ({ workspace, store }) => {
		const userFile = path.join(workspace, "user-data.txt");
		await writeFile(userFile, "preserve exactly\n");
		const foreign = await store.create(makePlan(workspace, "unrelated-plan"), 0);
		let plan = await store.create(makePlan(workspace), 0);
		const approved = approvePlan(transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, { at: UPDATED_AT }), "tester", { at: UPDATED_AT });
		plan = await store.update(plan.id, plan.revision, reserveTaskAttempt(approved, "T-001", { reservationId: "durable-create", at: UPDATED_AT }));
		plan = await store.update(plan.id, plan.revision, requestPlanCancellation(plan, {
			requestId: "durable-cancel", reason: "Stop owned attempt", requestedBy: "tester", at: UPDATED_AT,
		}));
		const restarted = createPlanStore({ workspacePath: workspace });
		assert.deepEqual(await restarted.read(plan.id), plan);
		plan = await restarted.update(plan.id, plan.revision, attachTaskAttempt(plan, "T-001", "T-001-A001", {
			sessionId: "late-child", branch: "work/late-child", at: UPDATED_AT,
		}));
		assert.throws(() => finalizePlanCancellation(plan, [
			{ attemptId: "T-001-A001", disposition: "no-session-created" },
		], { finalizedBy: "tester", at: UPDATED_AT }), { code: "invalid_cancellation_disposition" });
		const candidate = finalizePlanCancellation(plan, [
			{ attemptId: "T-001-A001", disposition: "session-terminated", sessionId: "late-child" },
		], { finalizedBy: "tester", at: UPDATED_AT });
		withDatabase(store, db => db.exec("CREATE TRIGGER reject_cancel BEFORE UPDATE ON plans WHEN json_extract(NEW.document, '$.status') = 'cancelled' BEGIN SELECT RAISE(ABORT, 'injected cancellation persistence interruption'); END"));
		await rejectsCode(restarted.update(plan.id, plan.revision, candidate), "database_error");
		assert.deepEqual(await restarted.read(plan.id), plan);
		assert.deepEqual(await restarted.read(foreign.id), foreign);
		assert.equal(await readFile(userFile, "utf8"), "preserve exactly\n");
		withDatabase(store, db => db.exec("DROP TRIGGER reject_cancel"));
		const finalized = await restarted.update(plan.id, plan.revision, candidate);
		assert.equal(finalized.status, PLAN_STATUS.CANCELLED);
		await rejectsCode(store.update(plan.id, plan.revision, candidate), "revision_conflict");
		assert.equal((await store.read(plan.id)).cancellation?.acknowledgements[0].sessionId, "late-child");
		assert.deepEqual(await store.read(foreign.id), foreign);
		assert.equal(await readFile(userFile, "utf8"), "preserve exactly\n");
	})
));

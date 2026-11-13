import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { errorCode, parseJson, readRecord } from "../../data.mjs";
import { LIMITS, PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { approvalScope } from "../../plan/schemas/approval.mjs";
import { createPlanStore } from "../../storage.mjs";
import { must } from "../assertions.mjs";
import { analysisStub, createApproved, createInput, evidence, runTask, withOperations } from "./fixture.mjs";
import { COMMIT } from "../git.mjs";

const nativeOwner = { sessionId: "coordinator-session", toolCallId: "approve-call" };
const review = "Reviewed the named revision against the pinned capability, constraints, task scopes, delivery and independent verification; no added authority.";
const userAuthority = {
	instruction: "Delegate initial named execution-plan approval within this capability to the owning coordinator.",
	grantedBy: "requesting-user",
	source: { kind: "direct-user", sessionId: nativeOwner.sessionId, messageRef: "user-message:explicit-delegation@revision:1" },
};

/** @param {(fixture: import("./fixture.mjs").OperationsFixture & {
 * calls: string[], session: {sessionId: string, workspacePath: string},
 * }) => Promise<void>} operation */
async function withDelegation(operation) {
	const session = { sessionId: nativeOwner.sessionId, workspacePath: "" };
	/** @type {string[]} */
	const calls = [];
	const options = {
		getSession: () => session,
		getUi: () => ({ elicitation: async () => {
			calls.push("Unexpected delegation confirmation");
			throw new Error("Explicit user instruction must not require another consent form");
		} }),
	};
	return withOperations(async (fixture) => {
		session.workspacePath = fixture.workspacePath;
		await operation({ ...fixture, calls, session });
	}, options);
}

/** @param {import("./fixture.mjs").Operations} operations @param {import("../../types/plan.js").FoundryPlan} plan */
const grantApproval = (operations, plan) => operations.planApprovalDelegation({
	action: "grant", id: "routine-execution", planId: plan.id, expectedRevision: plan.revision,
	authority: userAuthority,
}, { invocation: { ...nativeOwner, toolCallId: "grant-call" } });

test("explicit direct user instruction grants and approves with truthful agent attribution and no extra form", () => (
	withDelegation(async ({ operations, workspacePath, calls }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		const grant = must(await grantApproval(operations, plan));
		assert.equal(grant.grant.method, "user-instruction-attestation");
		assert.equal(grant.grant.grantedBy, userAuthority.grantedBy);
		assert.equal(grant.grant.statement, userAuthority.instruction);
		if (grant.grant.method !== "user-instruction-attestation") assert.fail("Wrong grant provenance");
		assert.equal(grant.grant.attestedBy, `agent-session:${nativeOwner.sessionId}`);
		assert.deepEqual(grant.grant.source, userAuthority.source);
		assert.equal(grant.scope.contractDigest, null);
		assert.deepEqual(await grantApproval(operations, plan), grant);
		assert.equal(calls.length, 0);
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		const submittedRevision = plan.revision;
		const request = { planId: plan.id, expectedRevision: plan.revision, delegationId: grant.id, review };
		plan = await operations.approve(request, { invocation: nativeOwner });
		assert.equal(plan.status, PLAN_STATUS.APPROVED);
		assert.equal(plan.gates.planApprovedBy, `agent-session:${nativeOwner.sessionId}`);
		assert.equal(plan.gates.completionApprovedAt, null);
		assert.deepEqual(plan.gates.delegatedApproval, {
			delegation: grant, planId: plan.id, planRevision: submittedRevision,
			blueprintDigest: plan.factory?.blueprintDigest,
			sessionId: nativeOwner.sessionId, toolCallId: nativeOwner.toolCallId, review,
		});
		assert.equal(plan.activity.at(-1)?.event, "plan-approved:delegated");
		for (const changed of [
			{ planId: "different-plan" }, { planRevision: plan.revision + 1 },
			{ blueprintDigest: "f".repeat(64) }, { sessionId: "other-coordinator" },
		]) {
			assert.throws(() => validatePlan({
				...plan, gates: { ...plan.gates, delegatedApproval: { ...plan.gates.delegatedApproval, ...changed } },
			}), { code: "invalid_delegated_approval" });
		}
		assert.equal(calls.length, 0);
		assert.throws(() => validatePlan({
			...plan, gates: { ...plan.gates, delegatedApproval: {
				...plan.gates.delegatedApproval, delegation: {
					...grant, grant: { ...grant.grant, attestedBy: "agent-session:forged-owner" },
				},
			} },
		}), { code: "invalid_approval_grant" });
		await assert.rejects(operations.approve(request, { invocation: nativeOwner }), { code: "revision_conflict" });
		await assert.rejects(operations.approve({ ...request, expectedRevision: plan.revision }, { invocation: nativeOwner }), { code: "delegation_submitted_plan_required" });
		const reopened = createPlanStore({ workspacePath });
		assert.deepEqual((await reopened.read(plan.id)).gates, plan.gates);
		assert.deepEqual(await reopened.getApprovalDelegation(grant.id), grant);
		assert.deepEqual(readRecord(parseJson(await operations.exportPlan({ planId: plan.id }))).gates, plan.gates);
		const nextDraft = await operations.createPlan({ ...createInput(workspacePath), id: "another-named-plan" });
		const next = await operations.submitPlan({ planId: nextDraft.id, expectedRevision: nextDraft.revision });
		assert.equal((await operations.approve({ ...request, planId: next.id, expectedRevision: next.revision }, { invocation: nativeOwner })).status, PLAN_STATUS.APPROVED);
		assert.equal(calls.length, 0);
		await operations.planApprovalDelegation({ action: "revoke", id: grant.id, reason: "Stop future decisions" }, { invocation: nativeOwner });
		assert.deepEqual((await reopened.read(plan.id)).gates, plan.gates);
		await withOperations(async ({ operations: restored }) => {
			await restored.importPlan({ source: await operations.exportPlan({ planId: plan.id }), expectedRevision: 0 });
			assert.equal(await restored.storeFor().getApprovalDelegation(grant.id), null);
		});
	})
));

test("delegated approval rejects missing native provenance, subagents, missing grants and other approval kinds", () => (
	withDelegation(async ({ operations, workspacePath, calls, session }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		const grantRequest = { action: "grant", id: "routine-execution", planId: plan.id, expectedRevision: plan.revision };
		await assert.rejects(operations.planApprovalDelegation({ ...grantRequest, invocation: nativeOwner, userSaid: "approved" }), { code: "delegation_identity_required" });
		for (const invocation of [{ ...nativeOwner, sessionId: "foreign" }, { ...nativeOwner, agentId: "child-agent" }]) {
			await assert.rejects(operations.planApprovalDelegation(grantRequest, { invocation }), { code: "delegation_identity_required" });
		}
		assert.equal(calls.length, 0);
		await grantApproval(operations, plan);
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		const request = { planId: plan.id, expectedRevision: plan.revision, delegationId: "routine-execution", review };
		await assert.rejects(operations.approve({ ...request, delegationId: "unrecorded" }, { invocation: nativeOwner }), { code: "delegation_unavailable" });
		await assert.rejects(operations.approve({ ...request, invocation: nativeOwner }), { code: "delegation_identity_required" });
		await assert.rejects(operations.approve(request, { invocation: { ...nativeOwner, agentId: "worker" } }), { code: "delegation_identity_required" });
		await assert.rejects(operations.approve({ ...request, approvalType: "retry" }, { invocation: nativeOwner }), { code: "delegation_approval_type" });
		await assert.rejects(operations.approve({ ...request, approvalType: "completion" }, { invocation: nativeOwner }), { code: "delegation_out_of_scope" });
		await assert.rejects(operations.approve({ ...request, approvedBy: "human" }, { invocation: nativeOwner }), { code: "delegation_approval_type" });
		await assert.rejects(operations.approve({ ...request, review: "" }, { invocation: nativeOwner }), { code: "empty_string" });
		session.sessionId = "different-coordinator";
		await assert.rejects(operations.approve(request, { invocation: { ...nativeOwner, sessionId: session.sessionId } }), { code: "delegation_foreign" });
		session.sessionId = nativeOwner.sessionId;
		session.workspacePath = `${workspacePath}/sibling`;
		await assert.rejects(operations.approve(request, { invocation: nativeOwner }), { code: "delegation_identity_required" });
		assert.equal((await operations.getPlan({ planId: plan.id })).status, PLAN_STATUS.AWAITING_APPROVAL);
	})
));

test("foreign or out-of-scope stored grants cannot authorize a plan and revocation survives replay", () => (
	withDelegation(async ({ operations, workspacePath, calls }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		const grant = must(await grantApproval(operations, plan));
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		const request = { planId: plan.id, expectedRevision: plan.revision, delegationId: grant.id, review };
		/** @param {import("../../types/plan.js").ApprovalDelegation} value */
		const replaceStored = (value) => {
			const db = new DatabaseSync(operations.storeFor().databasePath);
			try { db.prepare("UPDATE approval_delegations SET document = ? WHERE id = ?").run(JSON.stringify(value), grant.id); }
			finally { db.close(); }
		};
		for (const scope of [
			{ ...grant.scope, repositoryId: "foreign-repository" },
			{ ...grant.scope, repositoryPath: `${workspacePath}/other` },
			{ ...grant.scope, unitId: "other-capability" },
			{ ...grant.scope, unitRevision: grant.scope.unitRevision + 1 },
			{ ...grant.scope, contractDigest: "a".repeat(64) },
		]) {
			replaceStored({ ...grant, scope });
			await assert.rejects(operations.approve(request, { invocation: nativeOwner }), { code: "delegation_out_of_scope" });
		}
		replaceStored(grant);
		const revocation = must(await operations.planApprovalDelegation({
			action: "revoke", id: grant.id, reason: "User withdrew routine approval delegation",
		}, { invocation: nativeOwner }));
		assert.equal(revocation.revocation?.actor, `agent-session:${nativeOwner.sessionId}`);
		assert.deepEqual(await operations.planApprovalDelegation({
			action: "revoke", id: grant.id, reason: "Replay must retain original attribution",
		}, { invocation: { ...nativeOwner, toolCallId: "later-revoke" } }), revocation);
		await assert.rejects(operations.approve(request, { invocation: nativeOwner }), { code: "delegation_unavailable" });
		await assert.rejects(grantApproval(operations, plan), { code: "delegation_conflict" });
		assert.equal(calls.length, 0);
		assert.equal((await operations.getPlan({ planId: plan.id })).revision, plan.revision);
		const manual = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvedBy: "explicit-human" });
		assert.equal(manual.gates.planApprovedBy, "explicit-human");
		assert.equal(manual.gates.delegatedApproval, undefined);
	})
));

test("missing, invalid or stale instruction authority cannot grant delegation or trigger a form", () => (
	withDelegation(async ({ operations, workspacePath, calls }) => {
		const plan = await operations.createPlan(createInput(workspacePath));
		const request = { action: "grant", id: "routine-execution", planId: plan.id, expectedRevision: plan.revision };
		await assert.rejects(operations.planApprovalDelegation(request, { invocation: nativeOwner }), { code: "delegation_instruction_required" });
		for (const authority of [
			{ ...userAuthority, instruction: "" },
			{ ...userAuthority, instruction: "x".repeat(16001) },
			{ ...userAuthority, source: { ...userAuthority.source, kind: "generated-plan" } },
			{ ...userAuthority, source: { ...userAuthority.source, kind: "child-report" } },
			{ ...userAuthority, source: { ...userAuthority.source, sessionId: "foreign-direct" } },
			{ ...userAuthority, source: { ...userAuthority.source, kind: "relayed-user" } },
			{ ...userAuthority, source: { ...userAuthority.source, messageRef: "" } },
			{ ...userAuthority, attestedBy: "human-click" },
		]) {
			await assert.rejects(operations.planApprovalDelegation({ ...request, authority }, { invocation: nativeOwner }));
			assert.equal(await operations.storeFor().getApprovalDelegation("routine-execution"), null);
		}
		await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		await assert.rejects(grantApproval(operations, plan), { code: "revision_conflict" });
		assert.equal(await operations.storeFor().getApprovalDelegation("routine-execution"), null);
		assert.equal(calls.length, 0);
	})
));

test("relayed explicit instruction retains original source separately from the native recording owner", () => (
	withDelegation(async ({ operations, workspacePath, calls }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		const authority = {
			...userAuthority,
			source: { kind: "relayed-user", sessionId: "oversight-session", messageRef: "original-user-message@revision:6", relayedBySessionId: "oversight-session" },
		};
		const grant = must(await operations.planApprovalDelegation({
			action: "grant", id: "relayed-delegation", planId: plan.id, expectedRevision: plan.revision, authority,
		}, { invocation: nativeOwner }));
		if (grant.grant.method !== "user-instruction-attestation") assert.fail("Wrong grant provenance");
		assert.deepEqual(grant.grant.source, authority.source);
		assert.equal(grant.grant.attestedBy, `agent-session:${nativeOwner.sessionId}`);
		assert.equal(grant.grant.toolCallId, nativeOwner.toolCallId);
		assert.equal(grant.scope.coordinatorSessionId, nativeOwner.sessionId);
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		const approved = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, delegationId: grant.id, review }, { invocation: nativeOwner });
		assert.equal(approved.gates.planApprovedBy, `agent-session:${nativeOwner.sessionId}`);
		assert.deepEqual(approved.gates.delegatedApproval?.delegation, grant);
		assert.equal(calls.length, 0);
	})
));

test("historical native UI grants remain readable, reusable and immutable without regranting", () => (
	withDelegation(async ({ operations, workspacePath, calls }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		const historicalScope = approvalScope(plan, nativeOwner.sessionId);
		delete historicalScope.approvalType;
		const historical = await operations.storeFor().createApprovalDelegation({
			id: "routine-execution", scope: historicalScope, revocation: null,
			grant: {
				method: "native-ui-elicitation", grantedBy: "previous-form-user", at: plan.createdAt,
				statement: "Historical native scope confirmation, retained exactly.", toolCallId: "historical-grant-call",
				planId: plan.id, planRevision: plan.revision,
			},
		});
		assert.deepEqual(await operations.planApprovalDelegation({ action: "inspect", id: historical.id }, { invocation: nativeOwner }), historical);
		assert.deepEqual(await grantApproval(operations, plan), historical);
		await assert.rejects(operations.approve({
			planId: plan.id, expectedRevision: plan.revision, approvalType: "completion",
			delegationId: historical.id, review,
		}, { invocation: nativeOwner }), { code: "delegation_out_of_scope" });
		await assert.rejects(operations.planApprovalDelegation({
			action: "grant", id: historical.id, approvalType: "completion",
			planId: plan.id, expectedRevision: plan.revision, authority: userAuthority,
		}, { invocation: nativeOwner }), { code: "delegation_conflict" });
		await assert.rejects(operations.storeFor().createApprovalDelegation({
			...historical, id: "forged-form-completion", scope: { ...historical.scope, approvalType: "completion" },
		}), { code: "invalid_approval_grant" });
		assert.deepEqual(await operations.storeFor().getApprovalDelegation(historical.id), historical);
		plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
		const approved = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, delegationId: historical.id, review }, { invocation: nativeOwner });
		validatePlan(approved);
		assert.deepEqual(approved.gates.delegatedApproval?.delegation, historical);
		assert.equal(calls.length, 0);
	})
));

test("activity stays bounded and records resulting revisions", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await operations.createPlan(createInput(workspacePath));
		plan.activity = Array.from({ length: LIMITS.activity }, (_, index) => ({
			event: `event-${index}`,
			at: plan.updatedAt,
			revision: 1,
		}));
		const store = createPlanStore({ workspacePath });
		plan = await store.update(plan.id, plan.revision, plan);

		const submitted = await operations.submitPlan({
			planId: plan.id,
			expectedRevision: plan.revision,
		});
		assert.equal(submitted.activity.length, LIMITS.activity);
		assert.equal(submitted.activity.at(-1)?.event, "plan-submitted");
		assert.equal(submitted.activity.at(-1)?.revision, submitted.revision);
		assert.equal(submitted.activity[0].event, "event-1");
	})
));

test("explicit JSON interchange restores a plan without activating or launching work", () => (
	withOperations(async ({ operations, workspacePath, notifications }) => {
		const original = await operations.createPlan(createInput(workspacePath));
		const exported = parseJson(await operations.exportPlan({ planId: original.id }));
		assert.deepEqual(exported, original);
		const restored = await operations.importPlan({
			source: JSON.stringify({ ...exported, id: "restored-plan" }), expectedRevision: 0,
		});
		assert.equal(restored.id, "restored-plan");
		assert.equal(restored.status, PLAN_STATUS.DRAFT);
		assert.equal(await operations.getActivation(), null);
		assert.equal(notifications.length, 2);
		await assert.rejects(operations.importPlan({
			source: JSON.stringify(restored), expectedRevision: 0,
		}), { code: "plan_exists" });
	})
));

test("operations drive reservation, App attachment, verification, and approval", () => (
	withOperations(async ({ operations, notifications, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		let next = await operations.nextTasks({ planId: plan.id });
		assert.deepEqual(next.dispatchableTaskIds, ["T-001"]);
		assert.equal(next.tasks[0].launch.baseBranch, "main");
		assert.equal(Object.hasOwn(next.tasks[0], "delegationPrompt"), false);

		const first = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "reserve-foundation",
		});
		plan = first.plan;
		assert.equal(first.attemptId, "T-001-A001");
		assert.match(first.delegationPrompt, /attempt T-001-A001/);
		assert.equal(plan.activity.at(-1)?.revision, plan.revision);
		assert.equal(
			plan.activity.at(-1)?.event,
			"task-reserved:T-001:T-001-A001",
		);
		const replay = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision - 1,
			reservationId: "reserve-foundation",
		});
		assert.equal(replay.plan.revision, plan.revision);
		assert.equal(replay.attemptId, first.attemptId);

		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision,
			sessionId: "session-foundation",
			branch: "work/foundation",
		});
		const attachedRevision = plan.revision;
		const attachedReplay = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision - 1,
			sessionId: "session-foundation",
			branch: "work/foundation",
		});
		assert.equal(attachedReplay.revision, attachedRevision);

		plan = await operations.completeTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: first.attemptId,
			expectedRevision: plan.revision,
			status: TASK_STATUS.DONE,
			resultSummary: "Foundation complete",
			evidence: evidence("foundation tests passed"),
			branch: "work/foundation",
			commit: COMMIT,
			prUrl: "https://github.com/example/repo/pull/1",
		});
		assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
		assert.deepEqual((await operations.getStatus({ planId: plan.id })).projection.scheduling.readyTaskIds, ["T-002"]);

		next = await operations.nextTasks({ planId: plan.id });
		assert.equal(next.tasks[0].launch.baseBranch, "work/foundation");
		const second = await runTask(operations, plan, "T-002", {
			reservationId: "reserve-integration",
			sessionId: "session-integration",
			branch: "work/integration",
			commit: COMMIT,
		});
		plan = second.plan;
		({ plan } = await runTask(operations, plan, "T-003", {
			reservationId: "reserve-verifier",
			sessionId: "session-verifier",
			branch: "work/verifier",
			commit: COMMIT,
		}));

		const verificationLaunch = await operations.prepareVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			reservationId: "reserve-verification-success",
		});
		assert.equal(verificationLaunch.workflow, "verify");
		plan = verificationLaunch.plan;
		plan = await operations.finishVerification({
			planId: plan.id,
			expectedRevision: plan.revision,
			runId: "workflow-run-1",
		});
		assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
		plan = await operations.approve({
			planId: plan.id,
			expectedRevision: plan.revision,
			approvedBy: "octocat",
			approvalType: "completion",
		});
		assert.equal(plan.status, PLAN_STATUS.COMPLETED);
		assert.equal(plan.activity.at(-1)?.revision, plan.revision);
		assert.equal(notifications.at(-1)?.revision, plan.revision);
	}, {
		analysis: analysisStub({
			discoverVerificationRun: async () => ({
				state: "found",
				run: { runId: "workflow-run-1", status: "completed" },
				duplicates: [],
			}),
		}),
	})
));

test("status projection distinguishes unknown from complete-inventory absence", () => (
	withOperations(async ({ operations, workspacePath }) => {
		let plan = await createApproved(operations, workspacePath);
		const reserved = await operations.reserveTask({
			planId: plan.id,
			taskId: "T-001",
			expectedRevision: plan.revision,
			reservationId: "reserve-projection",
		});
		plan = await operations.attachTask({
			planId: plan.id,
			taskId: "T-001",
			attemptId: reserved.attemptId,
			expectedRevision: reserved.plan.revision,
			sessionId: "session-projection",
		});
		const unknown = await operations.getStatus({ planId: plan.id });
		assert.equal(unknown.projection.activeAttempts[0].sessionState, "unknown");
		const absent = await operations.getStatus({
			planId: plan.id,
			sessionInventory: {
				complete: true,
				capturedAt: "2099-01-01T00:00:00.000Z",
				sessions: [],
			},
		});
		assert.equal(absent.projection.activeAttempts[0].sessionState, "absent");
		assert.equal(absent.projection.nextAction.kind, "inspect-missing-session");
	})
));

test("plan guardrails require explicit session-local activation", () => (
	withOperations(async ({ operations, workspacePath }) => {
		const plan = await operations.createPlan(createInput(workspacePath));
		assert.equal(await operations.getActive(), null);
		const marker = await operations.activate({
			planId: plan.id,
			expectedRevision: plan.revision,
		});
		assert.equal(marker.planId, plan.id);
		const persistedMarker = must(await operations.getActivation());
		assert.deepEqual(Object.keys(persistedMarker).sort(), ["activatedAt", "planId"]);
		assert.equal((await operations.getActive())?.plan.id, plan.id);
		assert.deepEqual(await operations.deactivate(), {
			deactivated: true,
			planId: plan.id,
			repaired: false,
		});
		assert.equal(await operations.getActive(), null);

		/** @param {string} planId @param {string} activatedAt */
		const corruptActivation = (planId, activatedAt) => {
			const database = new DatabaseSync(operations.storeFor().databasePath);
			try {
				database.exec("PRAGMA foreign_keys = OFF");
				database.prepare("INSERT OR REPLACE INTO activation(singleton, plan_id, activated_at) VALUES (1, ?, ?)").run(planId, activatedAt);
			} finally {
				database.close();
			}
		};
		corruptActivation(plan.id, "invalid-time");
		await assert.rejects(
			operations.getActive(),
			(/** @type {unknown} */ error) => errorCode(error) === "activation_invalid",
		);
		assert.deepEqual(await operations.deactivate(), {
			deactivated: true,
			planId: null,
			repaired: true,
		});
		assert.equal(await operations.getActive(), null);

		corruptActivation("../invalid", persistedMarker.activatedAt);
		await assert.rejects(
			operations.getActive(),
			(/** @type {unknown} */ error) => errorCode(error) === "invalid_plan_id",
		);
		assert.equal((await operations.deactivate()).repaired, true);

	})
));

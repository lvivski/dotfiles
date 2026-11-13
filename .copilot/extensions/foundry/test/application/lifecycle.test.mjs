import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode, parseJson, readRecord } from "../../data.mjs";
import { analysisInputDigest } from "../../digest.mjs";
import { assertTechnicalLineage } from "../../factory/technical.mjs";
import { LIMITS, PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { approvalScope } from "../../plan/schemas/approval.mjs";
import { createPlanStore } from "../../storage.mjs";
import { must } from "../assertions.mjs";
import { analysisStub, completeImplementation, createApproved, createInput, evidence, runTask, technicalAuthority, technicalFixture, technicalOwner, withOperations } from "./fixture.mjs";
import { COMMIT } from "../git.mjs";

const nativeOwner = { sessionId: "coordinator-session", toolCallId: "approve-call" };
const review = "Reviewed the named revision against the pinned capability, constraints, task scopes, delivery and independent verification; no added authority.";
const userAuthority = {
	instruction: "Delegate initial named execution-plan approval within this capability to the owning coordinator.",
	grantedBy: "requesting-user",
	source: { kind: "direct-user", sessionId: nativeOwner.sessionId, messageRef: "user-message:explicit-delegation@revision:1" },
};

/** @param {(fixture: import("./fixture.mjs").OperationsFixture & {
 * failed: import("../../types/plan.js").FoundryPlan, calls: string[],
 * session: {sessionId: string, workspacePath: string},
 * }) => Promise<void>} operation */
async function withFailedTechnicalDiscovery(operation) {
	const session = { sessionId: technicalOwner.sessionId, workspacePath: "" };
	/** @type {string[]} */
	const calls = [];
	const analysis = analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "original-failed-run", status: "completed" } }),
		verificationResult: {
			passed: false, summary: "Cancellation precedence failed without changing the boundary",
			evidence: ["T-003-A001-E001", "T-003-A001-E002", "T-003-A001-E003", "T-003-A001-E004"],
			missingEvidence: ["cancel-late-denial assertion failed"], correctionTaskIds: ["T-001"],
			conceptualReview: { proposals: ["Retain the original executable failure"], gaps: ["Cancellation expectation remains obsolete"] },
		},
	});
	const options = {
		analysis, getSession: () => session,
		getUi: () => ({ elicitation: async () => { calls.push("elicitation"); throw new Error("No second confirmation"); } }),
	};
	return withOperations(async (f) => {
		session.workspacePath = f.workspacePath;
		let plan = await createApproved(f.operations, f.workspacePath);
		const reserved = await f.operations.reserveTask({
			planId: plan.id, expectedRevision: plan.revision, taskId: "T-001", reservationId: "original-failed-attempt",
		});
		plan = await f.operations.attachTask({
			planId: plan.id, expectedRevision: reserved.plan.revision, taskId: "T-001", attemptId: reserved.attemptId,
			sessionId: "original-failed-child", branch: "work/original-failure",
		});
		await delay(2);
		plan = await f.operations.completeTask({
			planId: plan.id, expectedRevision: plan.revision, taskId: "T-001", attemptId: reserved.attemptId,
			status: "failed", error: "Original cancelled late-denial expectation failed",
			evidence: [{ type: "test", summary: "Retain the original failed attempt", source: "fixture:old-consumer", outcome: "failed" }],
			sessionInventory: { complete: true, capturedAt: new Date().toISOString(), sessions: [{ id: "original-failed-child", status: "archived" }] },
		});
		plan = await f.operations.retry({ planId: plan.id, expectedRevision: plan.revision, taskId: "T-001" });
		for (const taskId of ["T-001", "T-002", "T-003"]) ({ plan } = await runTask(f.operations, plan, taskId));
		({ plan } = await f.operations.prepareVerification({
			planId: plan.id, expectedRevision: plan.revision, reservationId: "original-failed-reservation",
		}));
		const failed = await f.operations.finishVerification({
			planId: plan.id, expectedRevision: plan.revision, runId: "original-failed-run",
		});
		assert.equal(failed.status, "failed");
		await operation({ ...f, failed, calls, session });
	}, options);
}

/** @param {import("../../types/plan.js").FoundryPlan} plan */
const technicalGrantRequest = (plan) => ({
	action: "grant", id: "discovery-corrections", planId: plan.id, expectedRevision: plan.revision, approvalType: "technical",
	technical: { kinds: ["retry"], agreement: null }, authority: technicalAuthority,
});
/** @param {import("../../types/plan.js").FoundryPlan} plan */
const technicalRetryRequest = (plan) => ({
	planId: plan.id, expectedRevision: plan.revision, approvalType: "retry", delegationId: "discovery-corrections",
	review: "Correct the original failure without changing the accepted boundary, DAG, criteria or source scopes.",
	technical: { id: "discovery-correction-1", failures: ["original-failed-run/cancel-late-denial"] },
});

test("TA-01/03/06: explicit technical retry retains complete failed verification and attempts while dispatching only the next correction wave", () => (
	withFailedTechnicalDiscovery(async ({ operations, failed, calls, workspacePath }) => {
		const grantRequest = technicalGrantRequest(failed);
		const grant = must(await operations.planApprovalDelegation(grantRequest, { invocation: technicalOwner }));
		assert.equal(grant.scope.approvalType, "technical");
		assert.equal(grant.grant.method, "user-instruction-attestation");
		assert.equal(grant.grant.planRevision, failed.revision);
		assert.deepEqual(await operations.planApprovalDelegation(grantRequest, { invocation: technicalOwner }), grant);
		assert.deepEqual(await operations.planApprovalDelegation({ action: "inspect", id: grant.id }, { invocation: technicalOwner }), grant);
		const request = technicalRetryRequest(failed);
		const retried = await operations.approve(request, { invocation: technicalOwner });
		assert.equal(retried.status, "running");
		assert.equal(retried.verification.status, "not-started");
		assert.deepEqual(retried.tasks.map(({ status, ...task }) => task), failed.tasks.map(({ status, ...task }) => task));
		assert.deepEqual(retried.gates, failed.gates);
		const decision = must(retried.technicalDecisions?.[0]);
		assert.equal(decision.kind, "retry");
		assert.equal(decision.reason, request.review);
		assert.deepEqual(decision.failures, request.technical.failures);
		assert.equal(decision.planRevision, failed.revision);
		assert.equal(decision.sessionId, technicalOwner.sessionId);
		assert.equal(decision.toolCallId, technicalOwner.toolCallId);
		assert.deepEqual(decision.verification, failed.verification, "Retain evidence, missing evidence, corrections, timestamps, review and native run identity");
		assert.deepEqual(decision.oldScope, ["src/foundation.mjs", "src/integration.mjs"]);
		assert.deepEqual(decision.newScope, decision.oldScope);
		assert.equal(decision.renewal, null);
		assert.equal(failed.tasks[0].attempts[0].status, "failed");
		assert.equal(failed.tasks[0].attempts[0].evidence[0].outcome, "failed");
		await assert.rejects(operations.storeFor().update(retried.id, retried.revision, {
			...retried, technicalDecisions: [],
		}), { code: "technical_history_immutable" });
		const changed = structuredClone(retried);
		const changedReceipt = must(changed.technicalDecisions?.[0]);
		changedReceipt.reason = "Rewrite the original authorization";
		const { digest, ...payload } = changedReceipt;
		changedReceipt.digest = analysisInputDigest(payload);
		await assert.rejects(operations.storeFor().update(retried.id, retried.revision, changed), { code: "technical_history_immutable" });
		assert.deepEqual((await createPlanStore({ workspacePath }).read(failed.id)).technicalDecisions, retried.technicalDecisions);
		assert.deepEqual((await operations.nextTasks({ planId: failed.id })).dispatchableTaskIds, ["T-001"]);
		const next = await operations.reserveTask({
			planId: failed.id, expectedRevision: retried.revision, taskId: "T-001", reservationId: "correction-wave-2",
		});
		assert.equal(next.attemptId, "T-001-A003");
		assert.deepEqual(next.plan.tasks[0].attempts[0], failed.tasks[0].attempts[0]);
		assert.deepEqual(next.plan.tasks[1].attempts, failed.tasks[1].attempts);
		assert.deepEqual(next.plan.tasks[2].attempts, failed.tasks[2].attempts);
		let corrected = await operations.attachTask({
			planId: next.plan.id, expectedRevision: next.plan.revision, taskId: "T-001", attemptId: next.attemptId,
			sessionId: "correction-foundation", branch: "work/correction-foundation",
		});
		corrected = await operations.completeTask({
			planId: corrected.id, expectedRevision: corrected.revision, taskId: "T-001", attemptId: next.attemptId,
			status: "done", resultSummary: "Corrected within the unchanged scope", evidence: evidence("correction passed"),
			branch: "work/correction-foundation", commit: COMMIT,
		});
		for (const taskId of ["T-002", "T-003"]) ({ plan: corrected } = await runTask(operations, corrected, taskId, {
			sessionId: `correction-${taskId}`, branch: `work/correction-${taskId.toLowerCase()}`,
		}));
		const secondVerification = await operations.prepareVerification({
			planId: corrected.id, expectedRevision: corrected.revision, reservationId: "verification-correction-2",
		});
		assert.equal(secondVerification.plan.verification.reservationId, "verification-correction-2");
		assert.deepEqual(secondVerification.plan.technicalDecisions?.[0].verification, failed.verification);
		assert.equal(calls.length, 0);
	})
));

test("TA-02/04/05: retry authority cannot come from historical grants, caller identity, stale revisions or broadening a grant ID", () => (
	withFailedTechnicalDiscovery(async ({ operations, failed, calls, session }) => {
		const grantRequest = technicalGrantRequest(failed);
		for (const authority of [undefined, { ...technicalAuthority, instruction: "" }, { ...technicalAuthority, source: undefined },
			{ ...technicalAuthority, source: { ...technicalAuthority.source, kind: "child-report" } }]) {
			await assert.rejects(operations.planApprovalDelegation({ ...grantRequest, authority }, { invocation: technicalOwner }));
			assert.equal(await operations.storeFor().getApprovalDelegation(grantRequest.id), null);
		}
		for (const approvalType of ["plan", "completion"]) {
			const { technical: _technical, ...oldRequest } = grantRequest;
			const old = must(await operations.planApprovalDelegation({
				...oldRequest, id: approvalType === "plan" ? "parallel-foundry-plan-approval" : "parallel-foundry-technical-closure", approvalType,
			}, { invocation: technicalOwner }));
			await assert.rejects(operations.approve({ ...technicalRetryRequest(failed), delegationId: old.id }, { invocation: technicalOwner }));
			await assert.rejects(operations.planApprovalDelegation({ ...grantRequest, id: old.id }, { invocation: technicalOwner }), { code: "delegation_conflict" });
		}
		const grant = must(await operations.planApprovalDelegation(grantRequest, { invocation: technicalOwner }));
		const request = technicalRetryRequest(failed);
		const db = new DatabaseSync(operations.storeFor().databasePath);
		try {
			for (const scope of [
				{ ...grant.scope, repositoryId: "foreign-repository" },
				{ ...grant.scope, repositoryPath: `${grant.scope.repositoryPath}/foreign` },
				{ ...grant.scope, unitId: "foreign-capability" },
				{ ...grant.scope, unitRevision: grant.scope.unitRevision + 1 },
			]) {
				db.prepare("UPDATE approval_delegations SET document = ? WHERE id = ?").run(JSON.stringify({ ...grant, scope }), grant.id);
				await assert.rejects(operations.approve(request, { invocation: technicalOwner }), { code: "delegation_out_of_scope" });
				assert.deepEqual(await operations.getPlan({ planId: failed.id }), failed);
			}
		} finally {
			db.prepare("UPDATE approval_delegations SET document = ? WHERE id = ?").run(JSON.stringify(grant), grant.id);
			db.close();
		}
		for (const invocation of [undefined, { ...technicalOwner, agentId: "subagent" }, { ...technicalOwner, sessionId: "foreign" }]) {
			await assert.rejects(operations.approve(request, { invocation }));
		}
		for (const changed of [{ approvedBy: "forged-human" }, { invocation: technicalOwner },
			{ expectedRevision: failed.revision - 1 }, { delegationId: "missing" },
			{ technical: { ...request.technical, failures: [] } }]) {
			await assert.rejects(operations.approve({ ...request, ...changed }, { invocation: technicalOwner }));
		}
		session.sessionId = "foreign-owner";
		await assert.rejects(operations.approve(request, { invocation: { ...technicalOwner, sessionId: session.sessionId } }));
		session.sessionId = technicalOwner.sessionId;
		await operations.planApprovalDelegation({ action: "revoke", id: grantRequest.id, reason: "Withdraw before commit" }, { invocation: technicalOwner });
		await assert.rejects(operations.approve(request, { invocation: technicalOwner }));
		await assert.rejects(operations.planApprovalDelegation(grantRequest, { invocation: technicalOwner }), { code: "delegation_conflict" });
		assert.deepEqual(await operations.getPlan({ planId: failed.id }), failed);
		assert.equal(calls.length, 0);
	})
));

test("TA-19: revocation before retry commit blocks; after commit it preserves historical receipt across restart and export", () => (
	withFailedTechnicalDiscovery(async ({ operations, failed, workspacePath, calls }) => {
		await operations.planApprovalDelegation(technicalGrantRequest(failed), { invocation: technicalOwner });
		const request = technicalRetryRequest(failed);
		const aborted = new AbortController();
		aborted.abort(new Error("Stopped before owner authorization commit"));
		await assert.rejects(operations.approve(request, { invocation: technicalOwner, signal: aborted.signal }), /Stopped before/);
		assert.deepEqual(await operations.getPlan({ planId: failed.id }), failed);
		const retried = await operations.approve(request, { invocation: technicalOwner });
		const frozen = structuredClone(retried.technicalDecisions);
		await operations.planApprovalDelegation({ action: "revoke", id: request.delegationId, reason: "Withdraw after owner commit" }, { invocation: technicalOwner });
		assert.deepEqual((await createPlanStore({ workspacePath }).read(failed.id)).technicalDecisions, frozen);
		await assert.rejects(operations.approve({ ...request, expectedRevision: retried.revision }, { invocation: technicalOwner }));
		await withOperations(async ({ operations: imported }) => {
			const restored = await imported.importPlan({ source: await operations.exportPlan({ planId: failed.id }), expectedRevision: 0 });
			assert.deepEqual(restored.technicalDecisions, frozen);
			assert.equal(await imported.storeFor().getApprovalDelegation(request.delegationId), null);
			assert.equal(await imported.getActivation(), null);
		});
		assert.equal(calls.length, 0);
	})
));

test("technical retry supports failed discovery pinned to an accepted contract without converting it into candidate authority", async (t) => {
	const f = await technicalFixture(t);
	const operations = f.reopen({ analysis: analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "accepted-discovery-failure", status: "completed" } }),
		verificationResult: {
			passed: false, summary: "The original accepted-contract discovery check failed.",
			evidence: ["T-003-A001-E001", "T-003-A001-E002", "T-003-A001-E003", "T-003-A001-E004"],
			missingEvidence: ["cancel-late-denial"], correctionTaskIds: ["T-001"],
		},
	}) });
	let plan = await operations.submitPlan({ planId: f.plan.id, expectedRevision: f.plan.revision });
	plan = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvedBy: "fixture-user" });
	for (const taskId of ["T-001", "T-002", "T-003"]) {
		({ plan } = await runTask(operations, plan, taskId, { commit: f.before.bundle.commit }));
	}
	({ plan } = await operations.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "accepted-discovery-verification" }));
	plan = await operations.finishVerification({ planId: plan.id, expectedRevision: plan.revision, runId: "accepted-discovery-failure" });
	assert.equal(plan.factory?.candidateId, null);
	assert.equal(plan.factory?.contractDigest, f.contract.digest);
	const before = f.factory.snapshot();
	await operations.planApprovalDelegation(technicalGrantRequest(plan), { invocation: technicalOwner });
	const retried = await operations.approve({
		...technicalRetryRequest(plan), technical: { id: "accepted-discovery-correction", failures: ["accepted-discovery-failure/cancel-late-denial"] },
	}, { invocation: technicalOwner });
	assert.equal(retried.status, "running");
	assert.deepEqual(retried.technicalDecisions?.[0].verification, plan.verification);
	assert.deepEqual(retried.factory, plan.factory);
	assert.deepEqual(f.factory.snapshot(), before);
	assert.equal(f.factory.snapshot().candidates.length, 0);
	assert.deepEqual((await operations.nextTasks({ planId: plan.id })).dispatchableTaskIds, ["T-001"]);
	assert.equal(f.ui.calls, 0);
});

test("TA-04: one recorded grant is reusable only across its conserved evaluator-contract successor lineage", async t => {
	const f = await technicalFixture(t);
	const grant = must(await f.grant());
	await f.operations.factoryAction(await f.request(), { invocation: technicalOwner });
	const contract = must(f.factory.snapshot().contracts.at(-1));
	let plan = await f.operations.createPlan({ ...createInput(f.repositoryPath), id: "successor-discovery" });
	const operations = f.reopen({ analysis: analysisStub({
		discoverVerificationRun: async () => ({ state: "found", run: { runId: "successor-failure", status: "completed" } }),
		verificationResult: {
			passed: false, summary: "A subsequent bounded discovery correction is needed.",
			evidence: ["T-003-A001-E001", "T-003-A001-E002", "T-003-A001-E003", "T-003-A001-E004"],
			missingEvidence: ["Retained successor failure"], correctionTaskIds: ["T-001"],
		},
	}) });
	plan = await operations.submitPlan({ planId: plan.id, expectedRevision: plan.revision });
	plan = await operations.approve({ planId: plan.id, expectedRevision: plan.revision, approvedBy: "fixture-user" });
	for (const taskId of ["T-001", "T-002", "T-003"]) ({ plan } = await runTask(operations, plan, taskId, { commit: f.after.bundle.commit }));
	({ plan } = await operations.prepareVerification({ planId: plan.id, expectedRevision: plan.revision, reservationId: "successor-verification" }));
	plan = await operations.finishVerification({ planId: plan.id, expectedRevision: plan.revision, runId: "successor-failure" });
	const retried = await operations.approve({
		...technicalRetryRequest(plan), delegationId: grant.id,
		technical: { id: "successor-retry", failures: ["successor-failure"] },
	}, { invocation: technicalOwner });
	assert.equal(retried.status, "running");
	assert.equal(retried.technicalDecisions?.[0].contractDigest, contract.digest);
	assert.equal(retried.technicalDecisions?.[0].delegation.scope.contractDigest, f.contract.digest);
	assert.deepEqual(await operations.storeFor().getApprovalDelegation(grant.id), grant);
	const manual = f.mutate("acceptContract", {
		unitId: contract.unitId, unitRevision: contract.unitRevision, obligations: contract.obligations,
		evaluations: contract.evaluations, rationale: contract.rationale,
		actor: "fixture-user", reason: "A separately accepted contract is not an implicit technical successor.",
		resolutions: [{ knowledge: { id: "cancellation", revision: 1 }, reason: "Retain the original agreement" }],
	}).contract;
	assert.throws(() => assertTechnicalLineage(f.factory.snapshot(), grant.scope, manual.digest), { code: "technical_lineage_invalid" });
	assert.equal(f.ui.calls, 0);
});

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
		await assert.rejects(operations.planApprovalDelegation({
			action: "grant", id: historical.id, approvalType: "technical",
			planId: plan.id, expectedRevision: plan.revision, authority: userAuthority,
			technical: { kinds: ["retry"], agreement: null },
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

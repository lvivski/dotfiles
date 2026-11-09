import assert from "node:assert/strict";
import test from "node:test";
import { finalizePlanCancellation, requestPlanCancellation } from "../../plan/cancellation.mjs";
import { retryFailedPlan, transitionPlan } from "../../plan/lifecycle.mjs";
import { getReadyTasks } from "../../plan/queries.mjs";
import { PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { bindVerificationRun, completeVerification, reserveVerification } from "../../plan/verification.mjs";
import { approved, CANCELLED_AT, COMPLETED_AT, completeTask, required, task, throwsCode } from "./fixture.mjs";

test("failed verification reopens attributed tasks and all descendants", () => {
	let plan = approved();
	({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-002"));
	({ plan } = completeTask(plan, "T-997"));
	const firstAttempts = plan.tasks.map((entry) => entry.attempts[0].id);
	plan = reserveVerification(plan, {
		reservationId: "reserve-verification-failed",
		inputDigest: "b".repeat(64),
		at: COMPLETED_AT,
	});
	plan = completeVerification(plan, {
		passed: false,
		summary: "Foundation evidence is insufficient",
		evidence: ["T-001-A001-E001"],
		missingEvidence: ["No evidence mapped for T-001-C001"],
		correctionTaskIds: ["T-001"],
	}, {
		runId: "verification-failed",
		at: CANCELLED_AT,
	});
	assert.equal(plan.status, PLAN_STATUS.FAILED);
	const cancelling = requestPlanCancellation(plan, {
		requestId: "cancel-failed-verification",
		reason: "Stop corrections",
		requestedBy: "octocat",
		at: CANCELLED_AT,
	});
	assert.equal(cancelling.status, PLAN_STATUS.CANCELLING);
	assert.equal(cancelling.verification.status, "failed");
	assert.equal(finalizePlanCancellation(cancelling, [], {
		finalizedBy: "octocat", at: CANCELLED_AT,
	}).status, PLAN_STATUS.CANCELLED);
	plan = retryFailedPlan(plan, "octocat", { at: CANCELLED_AT });
	assert.equal(plan.status, PLAN_STATUS.RUNNING);
	assert.equal(plan.tasks[0].status, TASK_STATUS.PLANNED);
	assert.deepEqual(getReadyTasks(plan).map((task) => task.id), ["T-001"]);
	assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
	assert.deepEqual(plan.tasks.map((entry) => entry.attempts[0].id), firstAttempts);
	assert.equal(plan.verification.status, "not-started");
	assert.equal(required(plan.activity.at(-1)).actor, "octocat");
	assert.equal(required(plan.activity.at(-1)).verificationRunId, "verification-failed");
});

test("verification binding is durable, idempotent, and cannot be replaced by completion or cancellation", () => {
	let plan = approved({ tasks: [task("T-001")] });
	({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-997"));
	plan = reserveVerification(plan, {
		reservationId: "bind-verification", inputDigest: "d".repeat(64), at: COMPLETED_AT,
	});
	const bound = bindVerificationRun(plan, "owned-run");
	assert.equal(plan.verification.runId, null);
	assert.equal(bound.verification.status, "reserved");
	assert.equal(bound.verification.runId, "owned-run");
	assert.deepEqual(bindVerificationRun(bound, "owned-run"), bound);
	throwsCode(() => bindVerificationRun(bound, "different-run"), "verification_run_mismatch");
	throwsCode(() => completeVerification(bound, {
		passed: true, summary: "Passed", evidence: ["T-001-A001-E001"],
		missingEvidence: [], correctionTaskIds: [],
	}, { runId: "different-run" }), "verification_run_mismatch");
	const options = { requestId: "cancel-bound", reason: "Stop", requestedBy: "octocat", at: CANCELLED_AT };
	throwsCode(() => requestPlanCancellation(bound, { ...options, verificationRunId: "different-run" }), "verification_run_mismatch");
	assert.equal(requestPlanCancellation(bound, options).cancellation?.verificationRunId, "owned-run");
});

test("passed verification still requires explicit completion approval", () => {
	let plan = approved({ tasks: [task("T-001")] });
	({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-997"));
	plan = reserveVerification(plan, {
		reservationId: "reserve-verification-passed",
		inputDigest: "c".repeat(64),
		at: COMPLETED_AT,
	});
	plan = completeVerification(plan, {
		passed: true,
		summary: "Verified",
		evidence: ["T-001-A001-E001"],
		missingEvidence: [],
		correctionTaskIds: [],
	}, {
		runId: "verification-passed",
		at: CANCELLED_AT,
	});
	assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
	plan = transitionPlan(plan, PLAN_STATUS.COMPLETED, {
		actor: "octocat",
		at: CANCELLED_AT,
	});
	assert.equal(plan.status, PLAN_STATUS.COMPLETED);
});

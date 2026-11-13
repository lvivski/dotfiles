import assert from "node:assert/strict";
import test from "node:test";
import { finalizePlanCancellation, requestPlanCancellation } from "../../plan/cancellation.mjs";
import { attachTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { ATTEMPT_STATUS, PLAN_STATUS } from "../../plan/values.mjs";
import { reserveVerification } from "../../plan/verification.mjs";
import { approved, CANCELLED_AT, COMPLETED_AT, completeTask, RESERVED_AT, task, throwsCode } from "./fixture.mjs";

test("cancellation snapshots attempts and cannot finalize an in-flight create as absent", () => {
	let plan = approved({ tasks: [task("T-001")] });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "reserve-before-cancel",
		at: RESERVED_AT,
	});
	const attemptId = plan.tasks[0].attempts[0].id;
	plan = requestPlanCancellation(plan, {
		requestId: "cancel-request-1",
		reason: "User stopped work",
		requestedBy: "octocat",
		at: COMPLETED_AT,
	});
	assert.equal(plan.status, PLAN_STATUS.CANCELLING);
	assert.deepEqual(plan.cancellation?.requiredAttemptIds, [attemptId]);
	assert.equal(plan.tasks[0].attempts[0].status, ATTEMPT_STATUS.CANCEL_REQUESTED);

	plan = attachTaskAttempt(plan, "T-001", attemptId, {
		sessionId: "late-session",
		branch: "work/late",
		at: CANCELLED_AT,
	});
	throwsCode(
		() => finalizePlanCancellation(plan, [{
			attemptId,
			disposition: "no-session-created",
		}], {
			finalizedBy: "octocat",
			verificationTerminated: true,
			at: CANCELLED_AT,
		}),
		"invalid_cancellation_disposition",
	);
	plan = finalizePlanCancellation(plan, [{
		attemptId,
		disposition: "session-terminated",
		sessionId: "late-session",
	}], {
		finalizedBy: "octocat",
		verificationTerminated: true,
		at: CANCELLED_AT,
	});
	assert.equal(plan.status, PLAN_STATUS.CANCELLED);
	assert.equal(plan.tasks[0].attempts[0].status, ATTEMPT_STATUS.CANCELLED);
	assert.equal(plan.cancellation?.acknowledgements[0].sessionId, "late-session");
});

test("verification cancellation requires observed Workflow termination", () => {
	let plan = approved({ tasks: [task("T-001")] });
	({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-997"));
	plan = reserveVerification(plan, {
		reservationId: "reserve-verification-cancel",
		inputDigest: "a".repeat(64),
		at: COMPLETED_AT,
	});
	plan = requestPlanCancellation(plan, {
		requestId: "cancel-verification",
		reason: "Stop verification",
		requestedBy: "octocat",
		verificationRunId: "verification-run",
		at: CANCELLED_AT,
	});
	throwsCode(
		() => finalizePlanCancellation(plan, [], {
			finalizedBy: "octocat",
			verificationTerminated: false,
			verificationDisposition: "run-terminated",
			at: CANCELLED_AT,
		}),
		"cancellation_incomplete",
	);
	plan = finalizePlanCancellation(plan, [], {
		finalizedBy: "octocat",
		verificationTerminated: true,
		verificationDisposition: "run-terminated",
		at: CANCELLED_AT,
	});
	assert.equal(plan.verification.status, "failed");
	assert.equal(plan.cancellation?.verificationTerminatedAt, CANCELLED_AT);
});

test("parallel cancellation snapshots every reserved/running attempt and preserves completed delivery", () => {
	let plan = approved({ tasks: [task("T-001"), task("T-002"), task("T-003")] });
	({ plan } = completeTask(plan, "T-001"));
	const delivered = structuredClone(plan.tasks[0]);
	for (const id of ["T-002", "T-003"]) {
		plan = reserveTaskAttempt(plan, id, { reservationId: `reserve-${id}`, at: COMPLETED_AT });
	}
	plan = attachTaskAttempt(plan, "T-002", "T-002-A001", { sessionId: "owned-two", branch: "work/two", at: COMPLETED_AT });
	plan = requestPlanCancellation(plan, { requestId: "cancel-parallel", reason: "Stop all owned work", requestedBy: "octocat", at: CANCELLED_AT });
	assert.deepEqual(plan.cancellation?.requiredAttemptIds, ["T-002-A001", "T-003-A001"]);
	throwsCode(() => finalizePlanCancellation(plan, [{
		attemptId: "T-002-A001", disposition: "session-terminated", sessionId: "owned-two",
	}], { finalizedBy: "octocat", at: CANCELLED_AT }), "cancellation_incomplete");
	const finalized = finalizePlanCancellation(plan, [
		{ attemptId: "T-002-A001", disposition: "session-terminated", sessionId: "owned-two" },
		{ attemptId: "T-003-A001", disposition: "no-session-created" },
	], { finalizedBy: "octocat", at: CANCELLED_AT });
	assert.deepEqual(finalized.tasks[0], delivered);
	assert.equal(finalized.cancellation?.acknowledgements.length, 2);
});

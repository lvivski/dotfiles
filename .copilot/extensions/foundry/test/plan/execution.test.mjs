import assert from "node:assert/strict";
import test from "node:test";
import { taskCompletionRequirements } from "../../plan/delivery.mjs";
import { attachTaskAttempt, completeTaskAttempt, reserveTaskAttempt, retryTask } from "../../plan/execution.mjs";
import { getReadyTasks, taskLaunchGuidance } from "../../plan/queries.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { ATTEMPT_STATUS, EVIDENCE_TYPE, PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { reserveVerification } from "../../plan/verification.mjs";
import { approved, CANCELLED_AT, claimedEvidence, COMPLETED_AT, completeTask, required, RESERVED_AT, STARTED_AT, task, throwsCode } from "./fixture.mjs";

test("completed attempts use the shared delivery requirements and keep field validation", () => {
	for (const requirement of /** @type {const} */ (["branch", "commit", "pr"])) {
		const first = { ...task("T-001"), deliveryRequirement: requirement };
		let plan = approved({ tasks: [first, task("T-002", ["T-001"])] });
		plan = reserveTaskAttempt(plan, first.id, {
			reservationId: `delivery-${requirement}`,
			at: RESERVED_AT,
		});
		plan = attachTaskAttempt(plan, first.id, "T-001-A001", {
			sessionId: "delivery-session",
			branch: "work/delivery",
			at: STARTED_AT,
		});
		const current = plan.tasks[0];
		const attempt = current.attempts[0];
		const payload = {
			resultSummary: "Delivered",
			evidence: claimedEvidence(),
			at: COMPLETED_AT,
		};
		const missing = taskCompletionRequirements(current, { ...attempt, ...payload });
		assert.deepEqual(missing.missing, []);
		assert.deepEqual(
			missing.missingDelivery,
			requirement === "branch" ? [] : requirement === "commit"
				? ["full commit"] : ["full commit", "prUrl"],
		);
		if (requirement !== "branch") {
			throwsCode(
				() => completeTaskAttempt(plan, first.id, attempt.id, ATTEMPT_STATUS.DONE, payload),
				"delivery_requirement_unsatisfied",
			);
		}
		const delivery = {
			...payload,
			commit: requirement === "branch" ? null : "a".repeat(64),
			prUrl: requirement === "pr" ? "https://github.com/test/repo/pull/1" : null,
		};
		const completed = completeTaskAttempt(plan, first.id, attempt.id, ATTEMPT_STATUS.DONE, delivery);
		assert.equal(completed.tasks[0].attempts[0].branch, "work/delivery");
		assert.equal(attempt.status, ATTEMPT_STATUS.RUNNING);
		throwsCode(
			() => completeTaskAttempt(plan, first.id, attempt.id, ATTEMPT_STATUS.DONE, {
				...delivery,
				branch: "work/other",
			}),
			"branch_mismatch",
		);
		throwsCode(
			() => completeTaskAttempt(plan, first.id, attempt.id, ATTEMPT_STATUS.DONE, {
				...delivery,
				prUrl: "ftp://example.com/pull/1",
			}),
			"invalid_url",
		);
	}
});

test("reservation closes the create-session race and completion retains provenance", () => {
	let plan = approved({ tasks: [task("T-001")] });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "reserve-t001-first",
		at: RESERVED_AT,
	});
	const taskRecord = plan.tasks[0];
	const attempt = taskRecord.attempts[0];
	assert.equal(plan.status, PLAN_STATUS.RUNNING);
	assert.equal(taskRecord.status, TASK_STATUS.RUNNING);
	assert.equal(attempt.id, "T-001-A001");
	assert.equal(attempt.status, ATTEMPT_STATUS.RESERVED);
	assert.equal(attempt.baseBranch, "main");
	assert.equal(attempt.sessionId, null);

	plan = attachTaskAttempt(plan, "T-001", attempt.id, {
		sessionId: "session-1",
		branch: "work/t-001",
		at: STARTED_AT,
	});
	const attached = plan.tasks[0].attempts[0];
	assert.equal(attached.status, ATTEMPT_STATUS.RUNNING);
	assert.equal(attached.sessionId, "session-1");

	const idempotent = attachTaskAttempt(plan, "T-001", attempt.id, {
		sessionId: "session-1",
		branch: "work/t-001",
		at: COMPLETED_AT,
	});
	assert.deepEqual(idempotent, plan);
	throwsCode(
		() => attachTaskAttempt(plan, "T-001", attempt.id, {
			sessionId: "session-1",
			at: COMPLETED_AT,
		}),
		"attempt_already_attached",
	);
	throwsCode(
		() => attachTaskAttempt(plan, "T-001", attempt.id, {
			sessionId: "replacement-session",
			at: COMPLETED_AT,
		}),
		"attempt_already_attached",
	);

	plan = completeTaskAttempt(plan, "T-001", attempt.id, ATTEMPT_STATUS.DONE, {
		resultSummary: "Implemented",
		evidence: claimedEvidence(),
		branch: "work/t-001",
		commit: "b".repeat(40),
		at: COMPLETED_AT,
	});
	const completed = plan.tasks[0].attempts[0];
	assert.equal(plan.tasks[0].status, TASK_STATUS.DONE);
	assert.equal(completed.evidence[0].id, "T-001-A001-E001");
	assert.equal(completed.evidence[0].producer, "session-1");
	assert.equal(completed.evidence[0].trust, "claimed");
	const forged = structuredClone(plan);
	forged.tasks[0].attempts[0].evidence[0].producer = "forged-session";
	throwsCode(() => validatePlan(forged), "invalid_evidence_producer");
});

test("reservation IDs are unique across the complete plan", () => {
	let plan = approved({
		tasks: [task("T-001"), task("T-002")],
	});
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "reserve-unique-one",
		at: RESERVED_AT,
	});
	plan = reserveTaskAttempt(plan, "T-002", {
		reservationId: "reserve-unique-two",
		at: RESERVED_AT,
	});
	const forged = structuredClone(plan);
	forged.tasks[1].attempts[0].reservationId = "reserve-unique-one";
	throwsCode(() => validatePlan(forged), "duplicate_request_id");

	let completed = approved({ tasks: [task("T-001")] });
	completed = reserveTaskAttempt(completed, "T-001", {
		reservationId: "shared-task-verification-reservation",
		at: RESERVED_AT,
	});
	completed = attachTaskAttempt(completed, "T-001", "T-001-A001", {
		sessionId: "shared-reservation-session",
		branch: "work/shared-reservation",
		at: STARTED_AT,
	});
	completed = completeTaskAttempt(
		completed,
		"T-001",
		"T-001-A001",
		ATTEMPT_STATUS.DONE,
		{
			resultSummary: "Done",
			evidence: claimedEvidence(),
			branch: "work/shared-reservation",
			commit: "d".repeat(40),
			at: COMPLETED_AT,
		},
	);
	({ plan: completed } = completeTask(completed, "T-997", {
		commit: "d".repeat(40),
	}));
	throwsCode(
		() => reserveVerification(completed, {
			reservationId: "shared-task-verification-reservation",
			inputDigest: "d".repeat(64),
			at: CANCELLED_AT,
		}),
		"duplicate_request_id",
	);
});

test("retries retain attempts and dependency waits wake automatically", () => {
	let plan = approved();
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "reserve-first-failure",
		at: RESERVED_AT,
	});
	const firstAttempt = plan.tasks[0].attempts[0];
	plan = completeTaskAttempt(plan, "T-001", firstAttempt.id, ATTEMPT_STATUS.FAILED, {
		error: "create_session failed",
		at: COMPLETED_AT,
	});
	assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
	assert.equal(plan.tasks[0].attempts.length, 1);

	plan = retryTask(plan, "T-001", { at: COMPLETED_AT });
	plan = reserveTaskAttempt(plan, "T-001", {
		reservationId: "reserve-second-success",
		at: RESERVED_AT,
	});
	const second = required(required(plan.tasks[0]).attempts.at(-1));
	assert.equal(second.id, "T-001-A002");
	plan = attachTaskAttempt(plan, "T-001", second.id, {
		sessionId: "session-2",
		branch: "work/t-001-retry",
		at: STARTED_AT,
	});
	plan = completeTaskAttempt(plan, "T-001", second.id, ATTEMPT_STATUS.DONE, {
		resultSummary: "Fixed",
		evidence: claimedEvidence(),
		branch: "work/t-001-retry",
		commit: "c".repeat(40),
		at: COMPLETED_AT,
	});
	assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
	assert.deepEqual(getReadyTasks(plan).map((task) => task.id), ["T-002"]);
	assert.equal(plan.tasks[0].attempts[0].status, ATTEMPT_STATUS.FAILED);
	assert.equal(plan.tasks[0].attempts[1].status, ATTEMPT_STATUS.DONE);
});

test("dependency delivery chooses a deterministic base and requires integration evidence", () => {
	let plan = approved({
		tasks: [
			task("T-001"),
			task("T-002"),
			task("T-003", ["T-001", "T-002"]),
		],
	});
	({ plan } = completeTask(plan, "T-001", { branch: "work/one" }));
	({ plan } = completeTask(plan, "T-002", { branch: "work/two" }));
	const guidance = taskLaunchGuidance(plan, "T-003");
	assert.equal(guidance.baseBranch, "work/one");
	assert.deepEqual(guidance.integrationRequired.map((entry) => entry.taskId), ["T-002"]);

	plan = reserveTaskAttempt(plan, "T-003", {
		reservationId: "reserve-integration",
		at: RESERVED_AT,
	});
	const attempt = plan.tasks[2].attempts[0];
	plan = attachTaskAttempt(plan, "T-003", attempt.id, {
		sessionId: "session-integration",
		branch: "work/integration",
		at: STARTED_AT,
	});
	throwsCode(
		() => completeTaskAttempt(plan, "T-003", attempt.id, ATTEMPT_STATUS.DONE, {
			resultSummary: "Integrated",
			evidence: claimedEvidence(),
			branch: "work/integration",
			commit: "f".repeat(40),
			at: COMPLETED_AT,
		}),
		"invalid_attempt_state",
	);
	plan = completeTaskAttempt(plan, "T-003", attempt.id, ATTEMPT_STATUS.DONE, {
		resultSummary: "Integrated",
		evidence: [
			...claimedEvidence(),
			{
				type: EVIDENCE_TYPE.INTEGRATION,
				summary: "Merged dependency branch and ran integration tests",
				source: "git merge work/two && node --test",
				outcome: "passed",
			},
		],
		branch: "work/integration",
		commit: "f".repeat(40),
		at: COMPLETED_AT,
	});
	assert.equal(plan.tasks[2].status, TASK_STATUS.DONE);
});

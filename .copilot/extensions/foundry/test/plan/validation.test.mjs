import assert from "node:assert/strict";
import test from "node:test";
import { completeTaskAttempt, reserveTaskAttempt } from "../../plan/execution.mjs";
import { assertPlanId } from "../../plan/fields.mjs";
import { verificationCheckIds } from "../../plan/graph.mjs";
import { validatePlan } from "../../plan/validation.mjs";
import { ATTEMPT_STATUS, EVIDENCE_TYPE, PLAN_ID_PATTERN, PLAN_STATUS, TASK_STATUS } from "../../plan/values.mjs";
import { approved, COMPLETED_AT, completeTask, CREATED_AT, draft, RESERVED_AT, task, throwsCode } from "./fixture.mjs";

test("plan ID pattern is reusable without weakening domain validation", () => {
	const pattern = new RegExp(PLAN_ID_PATTERN);
	for (const value of ["plan", "plan-2", "a".repeat(64)]) {
		assert.equal(pattern.test(value), true);
		assert.equal(assertPlanId(value), value);
	}
	for (const value of ["Plan", "-plan", "plan-", "a".repeat(65)]) {
		assert.equal(pattern.test(value), false);
		assert.throws(() => assertPlanId(value), /lowercase slug/);
	}
});

test("createDraftPlan produces the strict initial schema", () => {
	const plan = draft();
	assert.equal(plan.status, PLAN_STATUS.DRAFT);
	assert.equal(plan.cancellation, null);
	assert.deepEqual(plan.tasks[0].attempts, []);
	assert.deepEqual(plan.activity[0], {
		event: "plan-created",
		at: CREATED_AT,
		revision: 1,
	});
	assert.equal(validatePlan(plan), plan);
});

test("the current plan format requires revisioned activity records", () => {
	const unknown = {
		...structuredClone(draft()),
		unsupported: true,
	};
	throwsCode(() => validatePlan(unknown), "unknown_field");

	const missingEvent = structuredClone(draft());
	// @ts-expect-error Persisted activity without its discriminator must be rejected.
	missingEvent.activity[0] = {
		at: CREATED_AT,
		revision: 1,
	};
	throwsCode(() => validatePlan(missingEvent), "invalid_string");

	const decreasing = structuredClone(draft());
	decreasing.activity.push({
		...decreasing.activity[0],
		event: "plan-regressed",
		revision: 0,
	});
	throwsCode(() => validatePlan(decreasing), "invalid_activity_revision");
});

test("the verifier is the unique sink and canonicalizes checkId evidence", () => {
	const invalid = structuredClone(draft());
	invalid.tasks.push({ ...invalid.tasks[2], id: "T-996" });
	throwsCode(() => validatePlan(invalid), "invalid_task_topology");

	let plan = approved();
	({ plan } = completeTask(plan, "T-001"));
	({ plan } = completeTask(plan, "T-002"));
	const checks = verificationCheckIds(plan.tasks);
	const evidence = checks.map((checkId) => ({
		checkId,
		type: checkId === "final-integration"
			? EVIDENCE_TYPE.INTEGRATION
			: EVIDENCE_TYPE.TEST,
		summary: `${checkId} checked`,
		source: "node --test",
		outcome: "passed",
	})).reverse();
	({ plan } = completeTask(plan, "T-997", { evidence }));
	assert.deepEqual(
		plan.tasks[2].attempts[0].evidence.map((entry) => entry.checkId),
		checks,
	);

	let blocked = approved();
	({ plan: blocked } = completeTask(blocked, "T-001"));
	({ plan: blocked } = completeTask(blocked, "T-002"));
	blocked = reserveTaskAttempt(blocked, "T-997", {
		reservationId: "blocked-verifier",
		at: RESERVED_AT,
	});
	blocked = completeTaskAttempt(
		blocked,
		"T-997",
		"T-997-A001",
		ATTEMPT_STATUS.BLOCKED,
		{ error: "create_session failed", evidence: [], at: COMPLETED_AT },
	);
	assert.equal(blocked.tasks[2].status, TASK_STATUS.BLOCKED);
});

test("plan validation rejects malformed timestamps and dependency graphs", async (context) => {
	const cases = [
		{
			name: "malformed plan id",
			code: "invalid_plan_id",
			build: () => draft({ id: "../escape" }),
		},
		{
			name: "duplicate task id",
			code: "duplicate_task_id",
			build: () => draft({ tasks: [task("T-001"), task("T-001")] }),
		},
		{
			name: "unknown dependency",
			code: "unknown_dependency",
			build: () => draft({ tasks: [task("T-001", ["T-996"])] }),
		},
		{
			name: "dependency cycle",
			code: "dependency_cycle",
			build: () => draft({
				tasks: [task("T-001", ["T-002"]), task("T-002", ["T-001"])],
			}),
		},
	];
	for (const current of cases) {
		await context.test(current.name, () => throwsCode(current.build, current.code));
	}
	const invalidDate = draft();
	invalidDate.updatedAt = "2026-02-30T16:00:00.000Z";
	throwsCode(() => validatePlan(invalidDate), "invalid_timestamp");
});

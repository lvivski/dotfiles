// Domain behavior is intentionally testable without the Copilot SDK.
import assert from "node:assert/strict";
import test from "node:test";

import {
    PLAN_STATUS,
    TASK_STATUS,
    approvePlan,
    completeVerification,
    createDraftPlan,
    getReadyTasks,
    reconcileTaskReadiness,
    retryTask,
    summarizePlan,
    transitionPlan,
    transitionTask,
    validatePlan,
} from "./domain.mjs";

const CREATED_AT = "2026-08-05T16:00:00.000Z";
const APPROVED_AT = "2026-08-05T16:01:00.000Z";
const STARTED_AT = "2026-08-05T16:02:00.000Z";
const COMPLETED_AT = "2026-08-05T16:03:00.000Z";

function task(id, dependsOn = []) {
    return {
        id,
        title: `Task ${id}`,
        description: `Implement ${id}`,
        dependsOn,
        acceptanceCriteria: [`${id} is observable`],
        expectedFiles: [`src/${id.toLowerCase()}.mjs`],
    };
}

function draft(options = {}) {
    return createDraftPlan({
        id: options.id ?? "sample-plan",
        title: options.title ?? "Sample plan",
        objective: options.objective ?? "Deliver a dependency-aware change",
        constraints: options.constraints ?? ["Keep the change scoped"],
        repository: {
            workingDirectory: "/tmp/sample-repository",
            baseBranch: "main",
        },
        planning: options.planning ?? null,
        tasks: options.tasks ?? [
            task("T-002"),
            task("T-001"),
            task("T-003", ["T-001"]),
        ],
    }, { now: CREATED_AT });
}

function throwsCode(operation, code) {
    assert.throws(operation, (error) => {
        assert.equal(error.code, code);
        return true;
    });
}

test("createDraftPlan produces a valid schema-versioned draft", () => {
    const plan = draft();

    assert.equal(plan.schemaVersion, 1);
    assert.equal(plan.revision, 1);
    assert.equal(plan.status, PLAN_STATUS.DRAFT);
    assert.equal(plan.planning, null);
    assert.equal(plan.tasks[0].status, TASK_STATUS.PLANNED);
    assert.deepEqual(plan.gates, {
        planApprovedAt: null,
        planApprovedBy: null,
        completionApprovedAt: null,
        completionApprovedBy: null,
    });
    assert.equal(validatePlan(plan), plan);
});

test("plan summaries expose planning provenance without changing existing fields", () => {
    const omittedPlanningPlan = draft();
    const explicitNullPlan = draft({ planning: null });
    const withoutPlanning = summarizePlan(omittedPlanningPlan);
    assert.equal(omittedPlanningPlan.planning, null);
    assert.equal(explicitNullPlan.planning, null);
    assert.equal(withoutPlanning.planningRunId, omittedPlanningPlan.planning);
    assert.equal(summarizePlan(explicitNullPlan).planningRunId, explicitNullPlan.planning);
    assert.equal(withoutPlanning.id, "sample-plan");
    assert.equal(withoutPlanning.status, PLAN_STATUS.DRAFT);
    assert.equal(withoutPlanning.tasksTotal, 3);

    const planning = {
        backend: "conveyor",
        runId: "planning-run-1",
        inputDigest: "a".repeat(64),
    };
    const withPlanning = summarizePlan(draft({ planning }));
    assert.equal(withPlanning.planningRunId, planning.runId);
    assert.deepEqual(
        Object.keys(withPlanning),
        [
            "id",
            "title",
            "objective",
            "status",
            "revision",
            "tasksTotal",
            "tasksDone",
            "tasksByStatus",
            "planningRunId",
            "verificationStatus",
            "updatedAt",
        ],
    );
});

test("timestamps must be canonical UTC values with valid calendar dates", () => {
    const invalidDate = draft();
    invalidDate.updatedAt = "2026-02-30T16:00:00.000Z";
    throwsCode(() => validatePlan(invalidDate), "invalid_timestamp");

    const localTime = draft();
    localTime.updatedAt = "2026-08-05T16:00:00.000";
    throwsCode(() => validatePlan(localTime), "invalid_timestamp");
});

test("plan validation rejects malformed identifiers and dependency graphs", async (context) => {
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
            build: () => draft({ tasks: [task("T-001", ["T-999"])] }),
        },
        {
            name: "dependency cycle",
            code: "dependency_cycle",
            build: () => draft({
                tasks: [
                    task("T-001", ["T-002"]),
                    task("T-002", ["T-001"]),
                ],
            }),
        },
        {
            name: "empty acceptance criteria",
            code: "array_too_short",
            build: () => {
                const invalidTask = task("T-001");
                invalidTask.acceptanceCriteria = [];
                return draft({ tasks: [invalidTask] });
            },
        },
    ];

    for (const current of cases) {
        await context.test(current.name, () => {
            throwsCode(current.build, current.code);
        });
    }
});

test("approval records the gate and resolves ready tasks deterministically", () => {
    const submitted = transitionPlan(draft(), PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    const approved = approvePlan(submitted, "octocat", { at: APPROVED_AT });

    assert.equal(approved.status, PLAN_STATUS.APPROVED);
    assert.equal(approved.gates.planApprovedAt, APPROVED_AT);
    assert.equal(approved.gates.planApprovedBy, "octocat");
    assert.deepEqual(
        getReadyTasks(approved).map((current) => current.id),
        ["T-001", "T-002"],
    );
    assert.equal(
        approved.tasks.find((current) => current.id === "T-003").status,
        TASK_STATUS.PLANNED,
    );
});

test("task completion unlocks dependents without inferring dependencies", () => {
    const submitted = transitionPlan(draft(), PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    let plan = approvePlan(submitted, "octocat", { at: APPROVED_AT });
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, { at: STARTED_AT });
    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-1",
        branch: "work/t-001",
        at: STARTED_AT,
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.DONE, {
        resultSummary: "Implemented T-001",
        evidence: ["node --test passed"],
        prUrl: "https://github.com/example/repo/pull/1",
        at: COMPLETED_AT,
    });
    plan = reconcileTaskReadiness(plan, { at: COMPLETED_AT });

    assert.deepEqual(
        getReadyTasks(plan).map((current) => current.id),
        ["T-002", "T-003"],
    );
});

test("failed dependencies block dependents until both work and retry are explicit", () => {
    const initial = draft({
        tasks: [
            task("T-001"),
            task("T-002", ["T-001"]),
        ],
    });
    const submitted = transitionPlan(initial, PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    let plan = approvePlan(submitted, "octocat", { at: APPROVED_AT });
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, { at: STARTED_AT });
    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-1",
        at: STARTED_AT,
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.FAILED, {
        error: "Tests failed",
        evidence: ["node --test failed"],
        at: COMPLETED_AT,
    });
    plan = reconcileTaskReadiness(plan, { at: COMPLETED_AT });

    assert.equal(
        plan.tasks.find((current) => current.id === "T-002").status,
        TASK_STATUS.BLOCKED,
    );
    throwsCode(
        () => transitionTask(plan, "T-002", TASK_STATUS.READY, { at: COMPLETED_AT }),
        "explicit_retry_required",
    );
    throwsCode(
        () => retryTask(plan, "T-002", { at: COMPLETED_AT }),
        "dependency_unmet",
    );

    plan = retryTask(plan, "T-001", { at: COMPLETED_AT });
    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-2",
        at: STARTED_AT,
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.DONE, {
        resultSummary: "Fixed and completed",
        evidence: ["node --test passed"],
        at: COMPLETED_AT,
    });
    plan = retryTask(plan, "T-002", { at: COMPLETED_AT });

    assert.equal(
        plan.tasks.find((current) => current.id === "T-002").status,
        TASK_STATUS.READY,
    );
});

test("invalid plan and task transitions fail instead of being coerced", () => {
    const plan = draft();
    throwsCode(
        () => transitionTask(plan, "T-001", TASK_STATUS.READY, { at: APPROVED_AT }),
        "plan_not_approved",
    );
    throwsCode(
        () => transitionPlan(plan, PLAN_STATUS.APPROVED, {
            actor: "octocat",
            at: APPROVED_AT,
        }),
        "invalid_plan_transition",
    );

    const submitted = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    const approved = approvePlan(submitted, "octocat", { at: APPROVED_AT });
    throwsCode(
        () => transitionTask(approved, "T-001", TASK_STATUS.RUNNING, {
            sessionId: "session-1",
            at: STARTED_AT,
        }),
        "plan_not_running",
    );
    throwsCode(
        () => transitionTask(approved, "T-001", TASK_STATUS.DONE, {
            resultSummary: "Skipped running",
            evidence: ["none"],
            at: COMPLETED_AT,
        }),
        "invalid_task_transition",
    );
    throwsCode(
        () => transitionPlan(approved, PLAN_STATUS.VERIFYING, {
            at: COMPLETED_AT,
        }),
        "invalid_plan_transition",
    );
});

test("failed and cancelled dependencies both block downstream tasks", () => {
    for (const terminalStatus of [TASK_STATUS.FAILED, TASK_STATUS.CANCELLED]) {
        const initial = draft({
            tasks: [
                task("T-001"),
                task("T-002", ["T-001"]),
            ],
        });
        const submitted = transitionPlan(initial, PLAN_STATUS.AWAITING_APPROVAL, {
            at: CREATED_AT,
        });
        let plan = approvePlan(submitted, "octocat", { at: APPROVED_AT });
        plan = transitionPlan(plan, PLAN_STATUS.RUNNING, { at: STARTED_AT });
        if (terminalStatus === TASK_STATUS.FAILED) {
            plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
                sessionId: "session-1",
                at: STARTED_AT,
            });
            plan = transitionTask(plan, "T-001", TASK_STATUS.FAILED, {
                error: "Implementation failed",
                at: COMPLETED_AT,
            });
        } else {
            plan = transitionTask(plan, "T-001", TASK_STATUS.CANCELLED, {
                error: "Cancelled by the user",
                at: COMPLETED_AT,
            });
        }
        plan = reconcileTaskReadiness(plan, { at: COMPLETED_AT });
        const dependent = plan.tasks.find((current) => current.id === "T-002");
        assert.equal(dependent.status, TASK_STATUS.BLOCKED);
        assert.match(dependent.error, /T-001/);
    }
});

test("validation rejects a running task whose dependency is not done", () => {
    const initial = draft({
        tasks: [
            task("T-001"),
            task("T-002", ["T-001"]),
        ],
    });
    const submitted = transitionPlan(initial, PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    let plan = approvePlan(submitted, "octocat", { at: APPROVED_AT });
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, { at: STARTED_AT });
    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-1",
        at: STARTED_AT,
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.FAILED, {
        error: "Implementation failed",
        at: COMPLETED_AT,
    });

    const invalid = structuredClone(plan);
    const dependent = invalid.tasks.find((current) => current.id === "T-002");
    dependent.status = TASK_STATUS.RUNNING;
    dependent.sessionId = "session-2";
    dependent.startedAt = STARTED_AT;
    throwsCode(() => validatePlan(invalid), "dependency_unmet");
});

test("completion requires all work done and explicit completion approval", () => {
    const initial = draft({ tasks: [task("T-001")] });
    const submitted = transitionPlan(initial, PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    let plan = approvePlan(submitted, "octocat", { at: APPROVED_AT });
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, { at: STARTED_AT });
    throwsCode(
        () => transitionPlan(plan, PLAN_STATUS.VERIFYING, { at: STARTED_AT }),
        "implementation_incomplete",
    );

    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-1",
        at: STARTED_AT,
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.DONE, {
        resultSummary: "Implemented",
        evidence: ["node --test passed"],
        at: COMPLETED_AT,
    });
    plan = transitionPlan(plan, PLAN_STATUS.VERIFYING, {
        at: COMPLETED_AT,
        backend: "conveyor",
        runId: "verify-run-1",
        inputDigest: "a".repeat(64),
    });
    plan = completeVerification(plan, {
        passed: true,
        summary: "All acceptance criteria verified",
        evidence: ["node --test passed"],
        missingEvidence: [],
    }, { at: COMPLETED_AT, runId: "verify-run-1" });
    assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
    throwsCode(
        () => transitionPlan(plan, PLAN_STATUS.COMPLETED, { at: COMPLETED_AT }),
        "invalid_string",
    );
    plan = transitionPlan(plan, PLAN_STATUS.COMPLETED, {
        actor: "octocat",
        at: COMPLETED_AT,
    });

    assert.equal(plan.status, PLAN_STATUS.COMPLETED);
    assert.equal(plan.gates.completionApprovedBy, "octocat");
});

test("failed verification records missing evidence and requires explicit plan retry", () => {
    const initial = draft({ tasks: [task("T-001")] });
    const submitted = transitionPlan(initial, PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    let plan = approvePlan(submitted, "octocat", { at: APPROVED_AT });
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, { at: STARTED_AT });
    plan = transitionTask(plan, "T-001", TASK_STATUS.RUNNING, {
        sessionId: "session-1",
        at: STARTED_AT,
    });
    plan = transitionTask(plan, "T-001", TASK_STATUS.DONE, {
        resultSummary: "Implemented",
        evidence: ["unit tests passed"],
        at: COMPLETED_AT,
    });
    plan = transitionPlan(plan, PLAN_STATUS.VERIFYING, {
        at: COMPLETED_AT,
        backend: "conveyor",
        runId: "verify-run-failed",
        inputDigest: "b".repeat(64),
    });
    plan = completeVerification(plan, {
        passed: false,
        summary: "Integration evidence is missing",
        evidence: ["unit tests passed"],
        missingEvidence: ["End-to-end smoke test"],
    }, { at: COMPLETED_AT, runId: "verify-run-failed" });
    assert.equal(plan.status, PLAN_STATUS.FAILED);
    assert.equal(plan.verification.status, "failed");

    throwsCode(
        () => transitionPlan(plan, PLAN_STATUS.APPROVED, {
            actor: "octocat",
            at: COMPLETED_AT,
        }),
        "explicit_retry_required",
    );
    plan = transitionPlan(plan, PLAN_STATUS.RUNNING, {
        actor: "octocat",
        retry: true,
        at: COMPLETED_AT,
    });
    assert.equal(plan.verification.status, "not-started");
    plan = transitionPlan(plan, PLAN_STATUS.VERIFYING, {
        at: COMPLETED_AT,
        backend: "conveyor",
        runId: "verify-run-retry",
        inputDigest: "c".repeat(64),
    });
    assert.equal(plan.verification.status, "running");
});

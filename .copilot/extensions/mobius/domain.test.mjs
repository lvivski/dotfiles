// Domain behavior is intentionally testable without the Copilot SDK.
import assert from "node:assert/strict";
import test from "node:test";

import {
    ACTOR_SOURCE,
    DELIVERY_AVAILABILITY,
    EVIDENCE_KIND,
    MAX_GENERATION,
    OBSERVATION_KIND,
    OBSERVATION_SOURCE,
    PLAN_STATUS,
    TASK_STATUS,
    actorProvenance,
    appendPlanGeneration,
    approvePlan,
    completeVerification,
    createDraftPlan,
    getReadyTasks,
    reconcileTaskReadiness,
    retryTask,
    summarizePlan,
    transitionPlan,
    transitionTask,
    upgradePlanToV2,
    validateActorProvenance,
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

function asLegacy(plan) {
    plan = structuredClone(plan);
    plan.schemaVersion = 1;
    delete plan.generation;
    delete plan.evidenceRecords;
    delete plan.observations;
    delete plan.integrationRefs;
    for (const currentTask of plan.tasks) {
        delete currentTask.reservation;
        delete currentTask.deliveries;
    }
    for (const key of ["planApprovedBy", "completionApprovedBy"]) {
        if (plan.gates[key] !== null) {
            plan.gates[key] = plan.gates[key].label;
        }
    }
    return plan;
}

function legacyDraft(options = {}) {
    return asLegacy(draft(options));
}

function throwsCode(operation, code) {
    assert.throws(operation, (error) => {
        assert.equal(error.code, code);
        return true;
    });
}

test("createDraftPlan produces a valid schema-versioned draft", () => {
    const plan = draft();

    assert.equal(plan.schemaVersion, 2);
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
    assert.deepEqual(plan.generation, {
        current: 1,
        history: [{
            number: 1,
            createdAt: CREATED_AT,
            createdBy: null,
            planningRunId: null,
            feedback: null,
            diffDigest: null,
        }],
    });
    assert.equal(plan.tasks[0].reservation, null);
    assert.deepEqual(plan.tasks[0].deliveries, []);
    assert.equal(validatePlan(plan), plan);
});

test("schema-v1 plans remain strictly readable and upgrade with deterministic defaults", () => {
    const legacy = legacyDraft();
    assert.equal(validatePlan(legacy), legacy);
    throwsCode(
        () => transitionPlan(legacy, PLAN_STATUS.AWAITING_APPROVAL, { at: CREATED_AT }),
        "upgrade_required",
    );

    const upgraded = upgradePlanToV2(legacy);
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(upgraded.revision, legacy.revision);
    assert.deepEqual(upgraded.generation, {
        current: 1,
        history: [{
            number: 1,
            createdAt: CREATED_AT,
            createdBy: null,
            planningRunId: null,
            feedback: null,
            diffDigest: null,
        }],
    });
    assert.ok(upgraded.tasks.every((currentTask) => (
        currentTask.reservation === null && currentTask.deliveries.length === 0
    )));
    assert.deepEqual(upgraded.evidenceRecords, []);
    assert.deepEqual(upgraded.observations, []);
    assert.deepEqual(upgraded.integrationRefs, []);
    throwsCode(() => upgradePlanToV2(upgraded), "already_upgraded");

    const submitted = transitionPlan(draft(), PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    const approvedLegacy = asLegacy(approvePlan(submitted, "octocat", {
        at: APPROVED_AT,
    }));
    assert.equal(validatePlan(approvedLegacy), approvedLegacy);
    assert.deepEqual(upgradePlanToV2(approvedLegacy).gates.planApprovedBy, {
        label: "octocat",
        source: ACTOR_SOURCE.LEGACY,
        externalId: null,
        verified: false,
    });
});

test("v2 validates bounded future reservation, delivery, evidence, observation, and integration records", () => {
    const caller = actorProvenance("octocat", ACTOR_SOURCE.CALLER, "display-only");
    let plan = transitionPlan(draft({ tasks: [task("T-001")] }), PLAN_STATUS.AWAITING_APPROVAL, {
        at: CREATED_AT,
    });
    plan = approvePlan(plan, caller, { at: APPROVED_AT });
    plan.tasks[0].reservation = {
        reservationId: "reservation-1",
        generation: 1,
        reservedBy: caller,
        reservedAt: STARTED_AT,
        expiresAt: COMPLETED_AT,
        scopeOverride: null,
    };
    plan.tasks[0].deliveries.push({
        repository: "example/repo",
        availability: DELIVERY_AVAILABILITY.BRANCH,
        ref: "work/t-001",
        commitSha: null,
        prUrl: "https://github.com/example/repo/pull/1",
        observedBySessionId: "session-1",
        observedAt: COMPLETED_AT,
    });
    plan.evidenceRecords.push({
        evidenceId: `ev-${"a".repeat(24)}`,
        kind: EVIDENCE_KIND.TEST_RESULT,
        binding: { taskId: "T-001", criterion: 0 },
        payload: { command: "node --test", passed: true },
        digest: "b".repeat(64),
        recordedBy: caller,
        recordedAt: COMPLETED_AT,
    });
    plan.observations.push({
        observationId: "observation-1",
        source: OBSERVATION_SOURCE.CHILD,
        kind: OBSERVATION_KIND.SESSION,
        taskId: "T-001",
        externalId: "session-1",
        value: { status: "idle" },
        observedBy: caller,
        observedAt: COMPLETED_AT,
    });
    plan.integrationRefs.push({
        integrationId: "integration-1",
        generation: 1,
        taskIds: ["T-001"],
        repository: "example/repo",
        ref: "integration/t-001",
        commitSha: "c".repeat(40),
        prUrl: null,
        observedBySessionId: "session-integration",
        observedAt: COMPLETED_AT,
    });

    assert.equal(validatePlan(plan), plan);
});

test("unverified actor sources cannot claim verified identity", () => {
    for (const source of [
        ACTOR_SOURCE.CALLER,
        ACTOR_SOURCE.CANVAS,
        ACTOR_SOURCE.LEGACY,
    ]) {
        throwsCode(() => validateActorProvenance({
            label: "actor",
            source,
            externalId: null,
            verified: true,
        }), "actor_verified_invalid");
    }
});

test("generation metadata stops at 16 without mutating the capped plan", () => {
    let plan = draft({ tasks: [task("T-001")] });
    while (plan.generation.current < MAX_GENERATION) {
        plan = appendPlanGeneration(plan, {
            createdBy: null,
            planningRunId: null,
            feedback: null,
            diffDigest: null,
        }, { at: CREATED_AT });
    }
    const before = structuredClone(plan);
    throwsCode(() => appendPlanGeneration(plan, {
        createdBy: null,
        planningRunId: null,
        feedback: null,
        diffDigest: null,
    }, { at: CREATED_AT }), "generation_limit");
    assert.deepEqual(plan, before);
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
    assert.deepEqual(
        approved.gates.planApprovedBy,
        actorProvenance("octocat", ACTOR_SOURCE.CALLER),
    );
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
        "invalid_object",
    );
    plan = transitionPlan(plan, PLAN_STATUS.COMPLETED, {
        actor: "octocat",
        at: COMPLETED_AT,
    });

    assert.equal(plan.status, PLAN_STATUS.COMPLETED);
    assert.deepEqual(
        plan.gates.completionApprovedBy,
        actorProvenance("octocat", ACTOR_SOURCE.CALLER),
    );
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

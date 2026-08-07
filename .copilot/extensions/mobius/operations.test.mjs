import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    EVIDENCE_TYPE,
    PLAN_STATUS,
    TASK_STATUS,
    VERIFICATION_STATUS,
} from "./domain.mjs";
import { createMobiusOperations } from "./operations.mjs";

async function withOperations(operation, options = {}) {
    const workspacePath = await mkdtemp(path.join(os.tmpdir(), "mobius-operations-"));
    const notifications = [];
    const operations = createMobiusOperations({
        getWorkspacePath: () => workspacePath,
        notify: (event) => notifications.push(event),
        analysis: options.analysis ?? analysisStub(),
        ...options,
    });
    try {
        return await operation({ operations, notifications, workspacePath });
    } finally {
        await rm(workspacePath, { recursive: true, force: true });
    }
}

function planBlueprint() {
    return {
        title: "Operation plan",
        objective: "Exercise the complete Mobius coordinator lifecycle",
        constraints: ["Keep task scopes separate"],
        tasks: [
            {
                id: "T-001",
                title: "Foundation",
                description: "Create the foundation",
                dependsOn: [],
                acceptanceCriteria: ["Foundation is present"],
                expectedFiles: ["src/foundation.mjs"],
            },
            {
                id: "T-002",
                title: "Integration",
                description: "Integrate the foundation",
                dependsOn: ["T-001"],
                acceptanceCriteria: ["Integration is complete"],
                expectedFiles: ["src/integration.mjs"],
            },
        ],
    };
}

function createInput(workspacePath) {
    return {
        expectedRevision: 0,
        id: "operation-plan",
        runId: "planning-run-1",
        repository: {
            workingDirectory: workspacePath,
            baseBranch: "main",
        },
    };
}

function analysisStub(options = {}) {
    const blueprint = options.plan ?? planBlueprint();
    const verificationResult = options.verificationResult ?? {
        passed: true,
        summary: "All acceptance criteria covered",
        evidence: ["T-001-A001-E001", "T-002-A001-E001"],
        missingEvidence: [],
        correctionTaskIds: [],
    };
    return {
        preparePlanning: async () => ({
            backend: "conveyor",
            workflow: "mobius-plan",
            inputDigest: "a".repeat(64),
            launchSpec: { scriptPath: "/pinned/plan.mjs" },
        }),
        importPlanning: async (runId) => ({
            runId,
            inputDigest: "a".repeat(64),
            plan: structuredClone(blueprint),
        }),
        prepareVerification: async () => ({
            backend: "conveyor",
            workflow: "mobius-verify",
            inputDigest: "b".repeat(64),
            launchSpec: { scriptPath: "/pinned/verify.mjs" },
        }),
        inspectVerification: async (runId, _plan, inspectOptions = {}) => ({
            run: {
                runId,
                status: inspectOptions.requireComplete ? "complete" : "running",
                resultAvailable: inspectOptions.requireComplete,
            },
            inputDigest: "b".repeat(64),
            ...(inspectOptions.requireComplete ? { result: verificationResult } : {}),
        }),
        verificationRunCanBeReplaced: async () => true,
        verificationRunIsTerminal: options.verificationRunIsTerminal
            ?? (async () => true),
    };
}

function evidence(summary) {
    return [{
        type: EVIDENCE_TYPE.TEST,
        summary,
        source: "node --test",
        outcome: "passed",
    }];
}

async function createApproved(operations, workspacePath) {
    let plan = await operations.createPlan(createInput(workspacePath));
    plan = await operations.submitPlan({
        planId: plan.id,
        expectedRevision: plan.revision,
    });
    return operations.approve({
        planId: plan.id,
        expectedRevision: plan.revision,
        approvedBy: "octocat",
        approvalType: "plan",
    });
}

async function runTask(operations, plan, taskId, options = {}) {
    const reserved = await operations.reserveTask({
        planId: plan.id,
        taskId,
        expectedRevision: plan.revision,
        reservationId: options.reservationId ?? `reserve-${taskId}-${plan.revision}`,
        scopeOverride: options.scopeOverride,
    });
    plan = reserved.plan;
    plan = await operations.attachTask({
        planId: plan.id,
        taskId,
        attemptId: reserved.attemptId,
        expectedRevision: plan.revision,
        sessionId: options.sessionId ?? `session-${taskId}`,
        branch: options.branch ?? `work/${taskId.toLowerCase()}`,
    });
    plan = await operations.completeTask({
        planId: plan.id,
        taskId,
        attemptId: reserved.attemptId,
        expectedRevision: plan.revision,
        status: TASK_STATUS.DONE,
        resultSummary: `${taskId} complete`,
        evidence: options.evidence ?? evidence(`${taskId} tests passed`),
        branch: options.branch ?? `work/${taskId.toLowerCase()}`,
        commit: options.commit ?? "a".repeat(40),
        prUrl: options.prUrl,
    });
    return { plan, reserved };
}

test("operations drive reservation, App attachment, verification, and approval", () => (
    withOperations(async ({ operations, notifications, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        let next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, ["T-001"]);
        assert.equal(next.tasks[0].launch.baseBranch, "main");
        assert.equal(next.tasks[0].delegationPrompt, undefined);

        const first = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-foundation",
        });
        plan = first.plan;
        assert.equal(first.attemptId, "T-001-A001");
        assert.match(first.delegationPrompt, /attempt T-001-A001/);
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
            commit: "b".repeat(40),
            prUrl: "https://github.com/example/repo/pull/1",
        });
        assert.equal(plan.tasks[1].status, TASK_STATUS.READY);

        next = await operations.nextTasks({ planId: plan.id });
        assert.equal(next.tasks[0].launch.baseBranch, "work/foundation");
        const second = await runTask(operations, plan, "T-002", {
            reservationId: "reserve-integration",
            sessionId: "session-integration",
            branch: "work/integration",
            commit: "c".repeat(40),
        });
        plan = second.plan;

        const verificationLaunch = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-verification-success",
        });
        assert.equal(verificationLaunch.workflow, "mobius-verify");
        plan = verificationLaunch.plan;
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-verification-success",
            runId: "conveyor-run-1",
        });
        assert.equal(plan.verification.status, VERIFICATION_STATUS.RUNNING);
        plan = await operations.finishVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "conveyor-run-1",
        });
        assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "completion",
        });
        assert.equal(plan.status, PLAN_STATUS.COMPLETED);
        assert.equal(notifications.at(-1).revision, plan.revision);
    })
));

test("scope overlap needs an auditable override and running scopes stay occupied", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        const first = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-overlap-one",
        });
        plan = first.plan;
        const next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, []);
        assert.deepEqual(next.heldTaskIds, ["T-002"]);
        await assert.rejects(
            operations.reserveTask({
                planId: plan.id,
                taskId: "T-002",
                expectedRevision: plan.revision,
                reservationId: "reserve-overlap-two",
            }),
            (/** @type {any} */ error) => error.code === "scope_overlap_requires_approval",
        );
        const override = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-002",
            expectedRevision: plan.revision,
            reservationId: "reserve-overlap-two",
            scopeOverride: {
                approvedBy: "octocat",
                reason: "Tasks use disjoint generated sections",
            },
        });
        assert.equal(
            override.plan.tasks[1].attempts[0].scopeOverride.approvedBy,
            "octocat",
        );
    }, {
        analysis: analysisStub({
            plan: {
                ...planBlueprint(),
                tasks: planBlueprint().tasks.map((task) => ({
                    ...task,
                    dependsOn: [],
                    expectedFiles: ["src/**"],
                })),
            },
        }),
    })
));

test("cancellation request is idempotent and finalization needs exact dispositions", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        const reserved = await operations.reserveTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            reservationId: "reserve-cancelled-task",
        });
        plan = reserved.plan;
        plan = await operations.attachTask({
            planId: plan.id,
            taskId: "T-001",
            attemptId: reserved.attemptId,
            expectedRevision: plan.revision,
            sessionId: "session-to-stop",
            branch: "work/cancelled",
        });
        const beforeCancelRevision = plan.revision;
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            requestId: "cancel-request-id",
            target: "plan",
            reason: "User stopped the plan",
            requestedBy: "octocat",
        });
        const replay = await operations.cancel({
            planId: plan.id,
            expectedRevision: beforeCancelRevision,
            requestId: "cancel-request-id",
            target: "plan",
            reason: "User stopped the plan",
            requestedBy: "octocat",
        });
        assert.equal(replay.revision, plan.revision);
        await assert.rejects(
            operations.finalizeCancellation({
                planId: plan.id,
                expectedRevision: plan.revision,
                dispositions: [],
                finalizedBy: "octocat",
            }),
            (/** @type {any} */ error) => error.code === "cancellation_incomplete",
        );
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [{
                attemptId: reserved.attemptId,
                disposition: "session-terminated",
                sessionId: "session-to-stop",
            }],
            finalizedBy: "octocat",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
    })
));

test("Conveyor cancellation must be observed terminal before finalization", () => {
    let terminal = false;
    return withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-active-verification",
        });
        plan = verification.plan;
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-active-verification",
            runId: "active-verification",
        });
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            requestId: "cancel-verification",
            target: "plan",
            reason: "Stop",
            requestedBy: "octocat",
        });
        await assert.rejects(
            operations.finalizeCancellation({
                planId: plan.id,
                expectedRevision: plan.revision,
                dispositions: [],
                verificationDisposition: "run-terminated",
                finalizedBy: "octocat",
            }),
            (/** @type {any} */ error) => error.code === "verification_not_terminated",
        );
        terminal = true;
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [],
            verificationDisposition: "run-terminated",
            finalizedBy: "octocat",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
    }, {
        analysis: analysisStub({
            verificationRunIsTerminal: async () => terminal,
        }),
    });
});

test("cancellation resolves a verification launch reserved before Conveyor starts", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-cancelled-launch",
        });
        plan = verification.plan;
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            requestId: "cancel-before-conveyor",
            target: "plan",
            reason: "Do not launch verification",
            requestedBy: "octocat",
        });
        assert.equal(
            (await operations.getStatus({ planId: plan.id })).projection.nextAction.kind,
            "resolve-verification-launch",
        );
        await assert.rejects(
            operations.finalizeCancellation({
                planId: plan.id,
                expectedRevision: plan.revision,
                dispositions: [],
                finalizedBy: "octocat",
            }),
            (/** @type {any} */ error) => error.code === "cancellation_incomplete",
        );
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [],
            verificationDisposition: "no-run-created",
            finalizedBy: "octocat",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
        assert.equal(plan.cancellation.verificationDisposition, "no-run-created");
    })
));

test("a verification run created during cancellation can still attach to its reservation", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-late-verification",
        });
        plan = verification.plan;
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            requestId: "cancel-late-verification",
            target: "plan",
            reason: "Stop after launch settles",
            requestedBy: "octocat",
        });
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-late-verification",
            runId: "late-verification-run",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLING);
        assert.equal(plan.cancellation.verificationRunId, "late-verification-run");
        plan = await operations.finalizeCancellation({
            planId: plan.id,
            expectedRevision: plan.revision,
            dispositions: [],
            verificationDisposition: "run-terminated",
            finalizedBy: "octocat",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
    })
));

test("failed verification retry opens a fresh correction wave", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await createApproved(operations, workspacePath);
        ({ plan } = await runTask(operations, plan, "T-001"));
        ({ plan } = await runTask(operations, plan, "T-002"));
        const verification = await operations.prepareVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-failed-verification",
        });
        plan = verification.plan;
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            reservationId: "reserve-failed-verification",
            runId: "failed-verification",
        });
        plan = await operations.finishVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "failed-verification",
        });
        assert.equal(plan.status, PLAN_STATUS.FAILED);
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "retry",
            retryStatus: PLAN_STATUS.RUNNING,
        });
        assert.equal(plan.tasks[0].status, TASK_STATUS.READY);
        assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);
        assert.equal(plan.tasks[0].attempts.length, 1);
    }, {
        analysis: analysisStub({
            verificationResult: {
                passed: false,
                summary: "Foundation evidence missing",
                evidence: ["T-001-A001-E001"],
                missingEvidence: ["No evidence mapped for T-001-C001"],
                correctionTaskIds: ["T-001"],
            },
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
        assert.equal((await operations.getActive()).plan.id, plan.id);
        await operations.deactivate();
        assert.equal(await operations.getActive(), null);
    })
));

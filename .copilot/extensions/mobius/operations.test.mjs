import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PLAN_STATUS, TASK_STATUS, VERIFICATION_STATUS } from "./domain.mjs";
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

function analysisStub(blueprint = planBlueprint()) {
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
        inspectVerification: async (runId, _plan, options = {}) => ({
            run: {
                runId,
                status: options.requireComplete ? "complete" : "running",
                resultAvailable: options.requireComplete,
            },
            inputDigest: "b".repeat(64),
            ...(options.requireComplete
                ? {
                    result: {
                        passed: true,
                        summary: "All acceptance criteria covered",
                        evidence: ["integration tests passed"],
                        missingEvidence: [],
                    },
                }
                : {}),
        }),
        verificationRunCanBeReplaced: async () => true,
    };
}

test("operations drive a plan through approval, child sessions, verification, and completion", () => (
    withOperations(async ({ operations, notifications, workspacePath }) => {
        const planningLaunch = await operations.preparePlan({
            objective: "Exercise lifecycle",
            repositoryContext: "Node repository",
        });
        assert.equal(planningLaunch.workflow, "mobius-plan");
        let plan = await operations.createPlan(createInput(workspacePath));
        assert.equal(plan.status, PLAN_STATUS.DRAFT);
        assert.equal(plan.revision, 1);
        assert.equal(plan.planning.runId, "planning-run-1");

        plan = await operations.submitPlan({
            planId: plan.id,
            expectedRevision: plan.revision,
        });
        assert.equal(plan.status, PLAN_STATUS.AWAITING_APPROVAL);

        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "plan",
        });
        assert.equal(plan.status, PLAN_STATUS.APPROVED);
        assert.equal(plan.tasks[0].status, TASK_STATUS.READY);
        assert.equal(plan.tasks[1].status, TASK_STATUS.PLANNED);

        let next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, ["T-001"]);
        assert.match(next.tasks[0].delegationPrompt, /Mobius plan operation-plan/);

        plan = await operations.startTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            sessionId: "session-foundation",
            branch: "work/foundation",
        });
        assert.equal(plan.status, PLAN_STATUS.RUNNING);

        plan = await operations.completeTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            status: TASK_STATUS.DONE,
            resultSummary: "Foundation complete",
            evidence: ["foundation tests passed"],
            branch: "work/foundation",
            prUrl: "https://github.com/example/repo/pull/1",
        });
        assert.equal(plan.tasks[1].status, TASK_STATUS.READY);

        next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, ["T-002"]);
        assert.match(next.tasks[0].delegationPrompt, /"taskId":"T-001"/);
        assert.match(next.tasks[0].delegationPrompt, /"summary":"Foundation complete"/);
        assert.match(next.tasks[0].delegationPrompt, /UNTRUSTED-DEPENDENCY-SUMMARIES/);

        plan = await operations.startTask({
            planId: plan.id,
            taskId: "T-002",
            expectedRevision: plan.revision,
            sessionId: "session-integration",
        });
        plan = await operations.completeTask({
            planId: plan.id,
            taskId: "T-002",
            expectedRevision: plan.revision,
            status: TASK_STATUS.DONE,
            resultSummary: "Integration complete",
            evidence: ["integration tests passed"],
        });

        const verificationLaunch = await operations.prepareVerification({
            planId: plan.id,
        });
        assert.equal(verificationLaunch.workflow, "mobius-verify");
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "conveyor-run-failed",
        });
        assert.equal(plan.status, PLAN_STATUS.VERIFYING);
        assert.equal(plan.verification.status, VERIFICATION_STATUS.RUNNING);

        const replacementLaunch = await operations.prepareVerification({
            planId: plan.id,
        });
        assert.equal(replacementLaunch.workflow, "mobius-verify");
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "conveyor-run-1",
        });
        assert.equal(plan.verification.runId, "conveyor-run-1");

        plan = await operations.finishVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "conveyor-run-1",
        });
        assert.equal(plan.status, PLAN_STATUS.AWAITING_COMPLETION_APPROVAL);
        assert.equal(plan.verification.status, VERIFICATION_STATUS.PASSED);

        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "completion",
        });
        assert.equal(plan.status, PLAN_STATUS.COMPLETED);
        assert.equal(plan.gates.completionApprovedBy, "octocat");
        assert.equal(notifications.at(-1).revision, plan.revision);
    })
));

test("verification completion is bound to the attached Conveyor run", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await operations.createPlan(createInput(workspacePath));
        plan = await operations.submitPlan({
            planId: plan.id,
            expectedRevision: plan.revision,
        });
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "plan",
        });
        plan = await operations.startTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            sessionId: "session-1",
        });
        plan = await operations.completeTask({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            status: TASK_STATUS.DONE,
            resultSummary: "Done",
            evidence: ["evidence"],
        });
        plan = await operations.startTask({
            planId: plan.id,
            taskId: "T-002",
            expectedRevision: plan.revision,
            sessionId: "session-2",
        });
        plan = await operations.completeTask({
            planId: plan.id,
            taskId: "T-002",
            expectedRevision: plan.revision,
            status: TASK_STATUS.DONE,
            resultSummary: "Done",
            evidence: ["evidence"],
        });
        plan = await operations.beginVerification({
            planId: plan.id,
            expectedRevision: plan.revision,
            runId: "bound-run",
        });
        await assert.rejects(
            operations.finishVerification({
                planId: plan.id,
                expectedRevision: plan.revision,
                runId: "run-mismatch",
            }),
            (error) => error.code === "verification_run_mismatch",
        );
    })
));

test("nextTasks reports overlapping scopes and holds later tasks", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await operations.createPlan(createInput(workspacePath));
        plan = await operations.submitPlan({
            planId: plan.id,
            expectedRevision: plan.revision,
        });
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "plan",
        });

        const next = await operations.nextTasks({ planId: plan.id });
        assert.deepEqual(next.dispatchableTaskIds, ["T-001"]);
        assert.deepEqual(next.heldTaskIds, ["T-002"]);
        assert.deepEqual(next.scopeConflicts[0].taskIds, ["T-001", "T-002"]);
    }, {
        analysis: analysisStub({
            ...planBlueprint(),
            tasks: planBlueprint().tasks.map((task, index) => index === 1
                ? { ...task, dependsOn: [], expectedFiles: ["src/**"] }
                : task),
        }),
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

        const deactivated = await operations.deactivate();
        assert.deepEqual(deactivated, {
            deactivated: true,
            planId: plan.id,
        });
        assert.equal(await operations.getActive(), null);
    })
));

test("whole-plan cancellation is atomic before approval", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await operations.createPlan(createInput(workspacePath));
        plan = await operations.submitPlan({
            planId: plan.id,
            expectedRevision: plan.revision,
        });
        plan = await operations.cancel({
            planId: plan.id,
            expectedRevision: plan.revision,
            target: "plan",
            reason: "User withdrew the objective",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
        assert.ok(plan.tasks.every((task) => task.status === TASK_STATUS.CANCELLED));
    })
));

test("cancelling one required task cancels the v1 plan instead of stranding it", () => (
    withOperations(async ({ operations, workspacePath }) => {
        let plan = await operations.createPlan(createInput(workspacePath));
        plan = await operations.submitPlan({
            planId: plan.id,
            expectedRevision: plan.revision,
        });
        plan = await operations.approve({
            planId: plan.id,
            expectedRevision: plan.revision,
            approvedBy: "octocat",
            approvalType: "plan",
        });
        plan = await operations.cancel({
            planId: plan.id,
            taskId: "T-001",
            expectedRevision: plan.revision,
            target: "task",
            reason: "Required task removed",
        });
        assert.equal(plan.status, PLAN_STATUS.CANCELLED);
        assert.ok(plan.tasks.every((task) => task.status === TASK_STATUS.CANCELLED));
    })
));

import {
    PLAN_STATUS,
    TASK_STATUS,
    approvePlan,
    assertPlanMutable,
    cancelPlan,
    completeVerification,
    createDraftPlan,
    getReadyTasks,
    reconcileTaskReadiness,
    retryTask,
    transitionPlan,
    transitionTask,
} from "./domain.mjs";
import {
    importPlanningConveyor,
    inspectVerificationConveyor,
    preparePlanningConveyor,
    prepareVerificationConveyor,
    verificationRunCanBeReplaced,
} from "./conveyor.mjs";
import { buildDelegationPrompt, findScopeConflicts, selectNonOverlappingTasks } from "./prompts.mjs";
import { MobiusStorageError, createPlanStore } from "./storage.mjs";

function revisionConflict(planId, expectedRevision, latestRevision) {
    return new MobiusStorageError("revision_conflict", `Plan ${planId} has changed`, {
        details: { planId, expectedRevision, latestRevision },
    });
}

export function createMobiusOperations(options) {
    if (!options || typeof options.getWorkspacePath !== "function") {
        throw new TypeError("createMobiusOperations requires getWorkspacePath");
    }
    const stores = new Map();
    const notify = typeof options.notify === "function" ? options.notify : () => {};
    const analysis = options.analysis ?? {
        importPlanning: importPlanningConveyor,
        inspectVerification: inspectVerificationConveyor,
        preparePlanning: preparePlanningConveyor,
        prepareVerification: prepareVerificationConveyor,
        verificationRunCanBeReplaced,
    };

    const workspace = () => {
        const workspacePath = options.getWorkspacePath();
        if (typeof workspacePath !== "string" || workspacePath.length === 0) {
            throw new MobiusStorageError(
                "workspace_unavailable",
                "Mobius requires a Copilot session workspace",
            );
        }
        return workspacePath;
    };

    const storeFor = (workspacePath = workspace()) => {
        let store = stores.get(workspacePath);
        if (!store) {
            store = createPlanStore({ workspacePath });
            stores.set(workspacePath, store);
        }
        return store;
    };

    const readForMutation = async (planId, expectedRevision) => {
        const plan = await storeFor().read(planId);
        assertPlanMutable(plan);
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        return plan;
    };

    const persist = async (planId, expectedRevision, candidate, event) => {
        const workspacePath = workspace();
        const recorded = structuredClone(candidate);
        recorded.telemetry ??= [];
        recorded.telemetry.push({
            event,
            at: new Date().toISOString(),
        });
        recorded.telemetry = recorded.telemetry.slice(-64);
        const updated = await storeFor(workspacePath).update(
            planId,
            expectedRevision,
            recorded,
        );
        notify({ workspacePath, planId, revision: updated.revision });
        return updated;
    };

    const preparePlan = (input) => analysis.preparePlanning(input);

    const createPlan = async ({
        expectedRevision,
        id,
        repository,
        runId,
    }) => {
        const imported = await analysis.importPlanning(runId);
        const plan = createDraftPlan({
            id,
            repository,
            planning: {
                backend: "conveyor",
                runId,
                inputDigest: imported.inputDigest,
            },
            ...imported.plan,
        });
        const workspacePath = workspace();
        const created = await storeFor(workspacePath).create(plan, expectedRevision);
        notify({ workspacePath, planId: created.id, revision: created.revision });
        return created;
    };

    const upgradePlan = async ({ planId, expectedRevision }) => {
        const workspacePath = workspace();
        const upgraded = await storeFor(workspacePath).upgrade(planId, expectedRevision);
        notify({ workspacePath, planId, revision: upgraded.revision });
        return upgraded;
    };

    const submitPlan = async ({ planId, expectedRevision }) => {
        const plan = await readForMutation(planId, expectedRevision);
        const candidate = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL);
        return persist(planId, expectedRevision, candidate, "plan-submitted");
    };

    const approve = async ({
        planId,
        expectedRevision,
        approvedBy,
        approvalType = "plan",
        retryStatus = PLAN_STATUS.RUNNING,
    }) => {
        const plan = await readForMutation(planId, expectedRevision);
        let candidate;
        if (approvalType === "plan") {
            candidate = approvePlan(plan, approvedBy);
        } else if (approvalType === "completion") {
            candidate = transitionPlan(plan, PLAN_STATUS.COMPLETED, {
                actor: approvedBy,
            });
        } else if (approvalType === "retry") {
            if (retryStatus !== PLAN_STATUS.RUNNING) {
                const error = new Error("Failed Mobius plans retry directly to running");
                error.code = "invalid_retry_status";
                throw error;
            }
            candidate = transitionPlan(plan, retryStatus, {
                actor: approvedBy,
                retry: true,
            });
            if (candidate.status === PLAN_STATUS.APPROVED) {
                candidate = reconcileTaskReadiness(candidate);
            }
        } else {
            throw new TypeError(`Unknown approvalType ${approvalType}`);
        }
        return persist(planId, expectedRevision, candidate, `plan-approved:${approvalType}`);
    };

    const nextTasks = async ({ planId }) => {
        const plan = await storeFor().read(planId);
        const ready = getReadyTasks(plan);
        const selection = selectNonOverlappingTasks(ready);
        return {
            planId,
            revision: plan.revision,
            status: plan.status,
            tasks: ready.map((task) => ({
                ...task,
                delegationPrompt: buildDelegationPrompt(plan, task),
            })),
            scopeConflicts: findScopeConflicts(ready),
            ...selection,
        };
    };

    const startTask = async ({
        planId,
        taskId,
        expectedRevision,
        sessionId,
        branch,
    }) => {
        let candidate = await readForMutation(planId, expectedRevision);
        if (candidate.status === PLAN_STATUS.APPROVED) {
            candidate = transitionPlan(candidate, PLAN_STATUS.RUNNING);
        }
        candidate = transitionTask(candidate, taskId, TASK_STATUS.RUNNING, {
            sessionId,
            branch: branch ?? null,
        });
        return persist(planId, expectedRevision, candidate, `task-started:${taskId}`);
    };

    const completeTask = async ({
        planId,
        taskId,
        expectedRevision,
        status,
        resultSummary,
        evidence,
        error,
        branch,
        prUrl,
    }) => {
        let candidate = await readForMutation(planId, expectedRevision);
        candidate = transitionTask(candidate, taskId, status, {
            resultSummary,
            evidence,
            error,
            branch,
            prUrl,
        });
        if (candidate.status === PLAN_STATUS.RUNNING) {
            candidate = reconcileTaskReadiness(candidate);
        }
        return persist(planId, expectedRevision, candidate, `task-${status}:${taskId}`);
    };

    const retry = async ({ planId, taskId, expectedRevision }) => {
        const plan = await readForMutation(planId, expectedRevision);
        const candidate = retryTask(plan, taskId);
        return persist(planId, expectedRevision, candidate, `task-retried:${taskId}`);
    };

    const prepareVerification = async ({ planId }) => {
        const plan = await storeFor().read(planId);
        if (plan.status === PLAN_STATUS.VERIFYING) {
            const replaceable = await analysis.verificationRunCanBeReplaced(
                plan.verification.runId,
                plan,
            );
            if (!replaceable) {
                const error = new Error(
                    `Verification run ${plan.verification.runId} is still active or has an importable result`,
                );
                error.code = "verification_run_not_replaceable";
                throw error;
            }
        } else if (plan.status !== PLAN_STATUS.RUNNING) {
            const error = new Error(
                `Verification can only be prepared from running or verifying, not ${plan.status}`,
            );
            error.code = "invalid_plan_transition";
            throw error;
        }
        return analysis.prepareVerification(plan);
    };

    const beginVerification = async ({ planId, expectedRevision, runId }) => {
        const plan = await readForMutation(planId, expectedRevision);
        if (plan.status === PLAN_STATUS.VERIFYING) {
            const replaceable = await analysis.verificationRunCanBeReplaced(
                plan.verification.runId,
                plan,
            );
            if (!replaceable) {
                const error = new Error(
                    `Verification run ${plan.verification.runId} cannot be replaced`,
                );
                error.code = "verification_run_not_replaceable";
                throw error;
            }
        }
        const inspected = await analysis.inspectVerification(runId, plan);
        const candidate = transitionPlan(plan, PLAN_STATUS.VERIFYING, {
            backend: "conveyor",
            runId,
            inputDigest: inspected.inputDigest,
        });
        return persist(
            planId,
            expectedRevision,
            candidate,
            plan.status === PLAN_STATUS.VERIFYING
                ? "verification-rebound"
                : "verification-started",
        );
    };

    const finishVerification = async ({
        planId,
        expectedRevision,
        runId,
    }) => {
        const plan = await readForMutation(planId, expectedRevision);
        if (plan.verification.runId !== runId) {
            const error = new Error(
                `Verification run ${runId} is not bound to plan ${planId}`,
            );
            error.code = "verification_run_mismatch";
            throw error;
        }
        const inspected = await analysis.inspectVerification(
            runId,
            plan,
            { requireComplete: true },
        );
        const result = inspected.result;
        const candidate = completeVerification(plan, result, { runId });
        return persist(
            planId,
            expectedRevision,
            candidate,
            result.passed ? "verification-passed" : "verification-failed",
        );
    };

    const cancel = async ({
        planId,
        expectedRevision,
        target,
        taskId,
        reason,
    }) => {
        let candidate = await readForMutation(planId, expectedRevision);
        if (target === "task") {
            const task = candidate.tasks.find((item) => item.id === taskId);
            if (!task) {
                const error = new Error(`Task ${taskId} does not exist`);
                error.code = "task_not_found";
                throw error;
            }
            if (task.status === TASK_STATUS.DONE || task.status === TASK_STATUS.CANCELLED) {
                const error = new Error(`Task ${taskId} cannot be cancelled from ${task.status}`);
                error.code = "invalid_task_transition";
                throw error;
            }
            candidate = cancelPlan(candidate, `Required task ${taskId} was cancelled: ${reason}`);
        } else if (target === "plan") {
            candidate = cancelPlan(candidate, reason);
        } else {
            throw new TypeError(`Unknown cancel target ${target}`);
        }
        return persist(
            planId,
            expectedRevision,
            candidate,
            target === "task" ? `task-cancelled:${taskId}` : "plan-cancelled",
        );
    };

    const activate = async ({ planId, expectedRevision }) => {
        const workspacePath = workspace();
        const marker = await storeFor(workspacePath).activate(planId, expectedRevision);
        notify({ workspacePath, planId, revision: expectedRevision });
        return marker;
    };

    return Object.freeze({
        preparePlan,
        createPlan,
        upgradePlan,
        getPlan: ({ planId }) => storeFor().read(planId),
        listPlans: ({ limit }) => storeFor().list({ limit }),
        submitPlan,
        approve,
        nextTasks,
        startTask,
        completeTask,
        retry,
        prepareVerification,
        beginVerification,
        finishVerification,
        cancel,
        activate,
        deactivate: () => storeFor().deactivate(),
        getActive: () => storeFor().getActive(),
        recoverStorage: (options) => storeFor().recoverStaleLocks(options),
        storeFor,
    });
}

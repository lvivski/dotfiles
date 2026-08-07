/**
 * Application service boundary joining domain transitions, storage, prompts,
 * projections, and trusted Conveyor imports.
 *
 * @module mobius/operations
 */
import {
    ATTEMPT_STATUS,
    PLAN_STATUS,
    TASK_STATUS,
    VERIFICATION_STATUS,
    approvePlan,
    activeTaskAttempt,
    attachTaskAttempt,
    bindVerificationRun,
    completeTaskAttempt,
    completeVerification,
    createDraftPlan,
    finalizePlanCancellation,
    getReadyTasks,
    reconcileTaskReadiness,
    requestPlanCancellation,
    reserveTaskAttempt,
    reserveVerification,
    retryFailedPlan,
    retryTask,
    taskLaunchGuidance,
    transitionPlan,
} from "./domain.mjs";
import {
    importPlanningConveyor,
    inspectVerificationConveyor,
    preparePlanningConveyor,
    prepareVerificationConveyor,
    verificationRunCanBeReplaced,
    verificationRunIsTerminal,
} from "./conveyor.mjs";
import { buildDelegationPrompt, findScopeConflicts, selectNonOverlappingTasks } from "./prompts.mjs";
import { projectPlan } from "./projection.mjs";
import { MobiusStorageError, createPlanStore } from "./storage.mjs";

/**
 * @typedef {object} MobiusOperationsOptions
 * @property {() => string | undefined} getWorkspacePath
 * @property {(event: {workspacePath: string, planId: string, revision: number}) => void} [notify]
 * @property {any} [analysis] Injectable Conveyor adapter used by tests.
 */

/**
 * @typedef {object} MobiusOperations
 * @property {(input: any) => Promise<any>} preparePlan
 * @property {(input: any) => Promise<any>} createPlan
 * @property {(input: any) => Promise<any>} getPlan
 * @property {(input: any) => Promise<any>} getStatus
 * @property {(input: any) => Promise<any>} listPlans
 * @property {(input: any) => Promise<any>} submitPlan
 * @property {(input: any) => Promise<any>} approve
 * @property {(input: any) => Promise<any>} nextTasks
 * @property {(input: any) => Promise<any>} reserveTask
 * @property {(input: any) => Promise<any>} attachTask
 * @property {(input: any) => Promise<any>} completeTask
 * @property {(input: any) => Promise<any>} retry
 * @property {(input: any) => Promise<any>} prepareVerification
 * @property {(input: any) => Promise<any>} beginVerification
 * @property {(input: any) => Promise<any>} finishVerification
 * @property {(input: any) => Promise<any>} cancel
 * @property {(input: any) => Promise<any>} finalizeCancellation
 * @property {(input: any) => Promise<any>} activate
 * @property {() => Promise<any>} deactivate
 * @property {() => Promise<any>} getActive
 * @property {(options?: any) => Promise<any>} recoverStorage
 * @property {(workspacePath?: string) => any} storeFor
 */

/** Typed operation-layer error for failures outside pure domain transitions. */
class MobiusOperationError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {unknown} [details]
     */
    constructor(code, message, details = null) {
        super(message);
        this.name = "MobiusOperationError";
        this.code = code;
        this.details = details;
    }
}

/**
 * Creates the standard stale-revision storage error.
 *
 * @param {string} planId
 * @param {number} expectedRevision
 * @param {number} latestRevision
 * @returns {MobiusStorageError}
 */
function revisionConflict(planId, expectedRevision, latestRevision) {
    return new MobiusStorageError("revision_conflict", `Plan ${planId} has changed`, {
        details: { planId, expectedRevision, latestRevision },
    });
}

/**
 * Finds one attempt by task and attempt identity.
 *
 * @param {any} plan
 * @param {string} taskId
 * @param {string} attemptId
 * @returns {any}
 */
function findAttempt(plan, taskId, attemptId) {
    return plan.tasks.find((task) => task.id === taskId)
        ?.attempts.find((attempt) => attempt.id === attemptId) ?? null;
}

/**
 * Finds the task attempt that owns an idempotent reservation ID.
 *
 * @param {any} plan
 * @param {string} reservationId
 * @returns {any}
 */
function findReservation(plan, reservationId) {
    for (const task of plan.tasks) {
        const attempt = task.attempts.find(
            (candidate) => candidate.reservationId === reservationId,
        );
        if (attempt) return { task, attempt };
    }
    return null;
}

/**
 * Creates the complete Mobius application service for one Copilot session.
 *
 * Stores are cached per session workspace while every mutation remains
 * revision-checked and atomically persisted.
 *
 * @param {MobiusOperationsOptions} options
 * @returns {Readonly<MobiusOperations>}
 */
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
        verificationRunIsTerminal,
    };

    /**
     * Resolves the current session workspace or fails closed.
     *
     * @returns {string}
     */
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

    /**
     * Returns the cached plan store for a session workspace.
     *
     * @param {string} [workspacePath]
     * @returns {ReturnType<typeof createPlanStore>}
     */
    const storeFor = (workspacePath = workspace()) => {
        let store = stores.get(workspacePath);
        if (!store) {
            store = createPlanStore({ workspacePath });
            stores.set(workspacePath, store);
        }
        return store;
    };

    /**
     * Reads a plan and enforces its expected revision before a mutation.
     *
     * @param {string} planId
     * @param {number} expectedRevision
     * @returns {Promise<any>}
     */
    const readForMutation = async (planId, expectedRevision) => {
        const plan = await storeFor().read(planId);
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        return plan;
    };

    /**
     * Adds bounded telemetry, atomically persists, and notifies canvases.
     *
     * @param {string} planId
     * @param {number} expectedRevision
     * @param {any} candidate
     * @param {string} event
     * @returns {Promise<any>}
     */
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

    /**
     * Builds the pinned planning launch specification.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const preparePlan = (input) => analysis.preparePlanning(input);

    /**
     * Reads the authoritative plan and derives recovery guidance.
     *
     * @param {{planId: string, sessionInventory?: any}} input
     * @returns {Promise<{plan: object, projection: object}>}
     */
    const getStatus = async ({ planId, sessionInventory }) => {
        const plan = await storeFor().read(planId);
        return {
            plan,
            projection: projectPlan(plan, { sessionInventory }),
        };
    };

    /**
     * Imports a completed planning run as a new draft artifact.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
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

    /**
     * Moves a draft into explicit approval review.
     *
     * @param {{planId: string, expectedRevision: number}} input
     * @returns {Promise<any>}
     */
    const submitPlan = async ({ planId, expectedRevision }) => {
        const plan = await readForMutation(planId, expectedRevision);
        const candidate = transitionPlan(plan, PLAN_STATUS.AWAITING_APPROVAL);
        return persist(planId, expectedRevision, candidate, "plan-submitted");
    };

    /**
     * Records initial approval, correction retry, or completion approval.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
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
                throw new MobiusOperationError(
                    "invalid_retry_status",
                    "Failed Mobius plans retry directly to running",
                );
            }
            candidate = retryFailedPlan(plan, approvedBy);
        } else {
            throw new TypeError(`Unknown approvalType ${approvalType}`);
        }
        return persist(planId, expectedRevision, candidate, `plan-approved:${approvalType}`);
    };

    /**
     * Lists dependency-ready tasks, delivery guidance, and scope holds.
     *
     * @param {{planId: string}} input
     * @returns {Promise<any>}
     */
    const nextTasks = async ({ planId }) => {
        const plan = await storeFor().read(planId);
        const ready = getReadyTasks(plan);
        const running = plan.tasks.filter(
            (task) => task.status === TASK_STATUS.RUNNING,
        );
        const selection = selectNonOverlappingTasks(ready, running);
        return {
            planId,
            revision: plan.revision,
            status: plan.status,
            tasks: ready.map((task) => ({
                ...task,
                launch: taskLaunchGuidance(plan, task.id),
            })),
            scopeConflicts: findScopeConflicts([...ready, ...running]),
            ...selection,
        };
    };

    /**
     * Persists an idempotent attempt reservation before `create_session`.
     *
     * @param {any} input
     * @returns {Promise<any>} Reserved plan, attempt identity, and launch prompt.
     */
    const reserveTask = async ({
        planId,
        taskId,
        expectedRevision,
        reservationId,
        scopeOverride,
    }) => {
        const plan = await storeFor().read(planId);
        const existing = findReservation(plan, reservationId);
        if (existing) {
            if (existing.task.id !== taskId) {
                throw new MobiusOperationError(
                    "duplicate_request_id",
                    `Reservation ${reservationId} belongs to ${existing.task.id}`,
                );
            }
            if (![
                ATTEMPT_STATUS.RESERVED,
                ATTEMPT_STATUS.RUNNING,
                ATTEMPT_STATUS.CANCEL_REQUESTED,
            ].includes(existing.attempt.status)) {
                throw new MobiusOperationError(
                    "duplicate_request_id",
                    `Reservation ${reservationId} is already terminal`,
                );
            }
            return {
                plan,
                taskId,
                attemptId: existing.attempt.id,
                baseBranch: existing.attempt.baseBranch,
                integrationRequired: existing.attempt.integrationRequired,
                delegationPrompt: buildDelegationPrompt(plan, existing.task, existing.attempt),
            };
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        const task = plan.tasks.find((item) => item.id === taskId);
        if (!task) {
            throw new MobiusOperationError(
                "task_not_found",
                `Task ${taskId} does not exist`,
            );
        }
        const running = plan.tasks.filter((item) => item.status === TASK_STATUS.RUNNING);
        const selection = selectNonOverlappingTasks([task], running);
        if (selection.heldTaskIds.includes(taskId) && !scopeOverride) {
            throw new MobiusOperationError(
                "scope_overlap_requires_approval",
                `Task ${taskId} overlaps an active task scope`,
                {
                    taskId,
                    occupiedTaskIds: selection.occupiedTaskIds,
                    conflicts: findScopeConflicts([task, ...running]),
                },
            );
        }
        const candidate = reserveTaskAttempt(plan, taskId, {
            reservationId,
            scopeOverride: scopeOverride ?? null,
        });
        const candidateTask = candidate.tasks.find((item) => item.id === taskId);
        const candidateAttempt = candidateTask ? activeTaskAttempt(candidateTask) : null;
        if (!candidateTask || !candidateAttempt) {
            throw new MobiusOperationError(
                "reservation_invariant_failed",
                `Task ${taskId} has no active attempt after reservation`,
            );
        }
        const updated = await persist(
            planId,
            expectedRevision,
            candidate,
            `task-reserved:${taskId}:${candidateAttempt.id}`,
        );
        const updatedTask = updated.tasks.find((item) => item.id === taskId);
        const attempt = updatedTask ? activeTaskAttempt(updatedTask) : null;
        if (!updatedTask || !attempt) {
            throw new MobiusOperationError(
                "reservation_invariant_failed",
                `Task ${taskId} has no active persisted attempt`,
            );
        }
        return {
            plan: updated,
            taskId,
            attemptId: attempt.id,
            baseBranch: attempt.baseBranch,
            integrationRequired: attempt.integrationRequired,
            delegationPrompt: buildDelegationPrompt(updated, updatedTask, attempt),
        };
    };

    /**
     * Attaches an App child session to its reserved attempt.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const attachTask = async ({
        planId,
        taskId,
        attemptId,
        expectedRevision,
        sessionId,
        branch,
    }) => {
        const plan = await storeFor().read(planId);
        const current = findAttempt(plan, taskId, attemptId);
        if (current?.sessionId === sessionId
            && current.branch === (branch ?? null)) {
            return plan;
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        const candidate = attachTaskAttempt(plan, taskId, attemptId, {
            sessionId,
            branch: branch ?? null,
        });
        return persist(planId, expectedRevision, candidate, `task-attached:${taskId}:${attemptId}`);
    };

    /**
     * Records the terminal result of the currently active task attempt.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const completeTask = async ({
        planId,
        taskId,
        attemptId,
        expectedRevision,
        status,
        resultSummary,
        evidence,
        error,
        branch,
        commit,
        prUrl,
    }) => {
        const plan = await readForMutation(planId, expectedRevision);
        let candidate = completeTaskAttempt(plan, taskId, attemptId, status, {
            resultSummary,
            evidence,
            error,
            branch,
            commit,
            prUrl,
        });
        if (candidate.status === PLAN_STATUS.RUNNING) {
            candidate = reconcileTaskReadiness(candidate);
        }
        return persist(planId, expectedRevision, candidate, `task-${status}:${taskId}:${attemptId}`);
    };

    /**
     * Makes failed or blocked work ready for a fresh attempt.
     *
     * @param {{planId: string, taskId: string, expectedRevision: number}} input
     * @returns {Promise<any>}
     */
    const retry = async ({ planId, taskId, expectedRevision }) => {
        const plan = await readForMutation(planId, expectedRevision);
        const candidate = retryTask(plan, taskId);
        return persist(planId, expectedRevision, candidate, `task-retried:${taskId}`);
    };

    /**
     * Persists a verification launch reservation before returning a run spec.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const prepareVerification = async ({
        planId,
        expectedRevision,
        reservationId,
    }) => {
        const plan = await storeFor().read(planId);
        if (plan.verification.reservationId === reservationId
            && plan.verification.status === VERIFICATION_STATUS.RESERVED) {
            const prepared = await analysis.prepareVerification(plan);
            if (prepared.inputDigest !== plan.verification.inputDigest) {
                throw new MobiusOperationError(
                    "verification_input_mismatch",
                    "Reserved verification input changed",
                );
            }
            return { plan, reservationId, ...prepared };
        }
        if (plan.verification.reservationId === reservationId) {
            throw new MobiusOperationError(
                "duplicate_request_id",
                `Verification reservation ${reservationId} is already bound or terminal`,
            );
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        if (plan.status === PLAN_STATUS.VERIFYING) {
            const replaceable = await analysis.verificationRunCanBeReplaced(
                plan.verification.runId,
                plan,
            );
            if (!replaceable) {
                throw new MobiusOperationError(
                    "verification_run_not_replaceable",
                    `Verification run ${plan.verification.runId} is still active or has an importable result`,
                );
            }
        } else if (plan.status !== PLAN_STATUS.RUNNING) {
            throw new MobiusOperationError(
                "invalid_plan_transition",
                `Verification can only be prepared from running or verifying, not ${plan.status}`,
            );
        }
        const prepared = await analysis.prepareVerification(plan);
        const candidate = reserveVerification(plan, {
            reservationId,
            inputDigest: prepared.inputDigest,
        });
        const updated = await persist(
            planId,
            expectedRevision,
            candidate,
            plan.status === PLAN_STATUS.VERIFYING
                ? "verification-reserved:replacement"
                : "verification-reserved",
        );
        return { plan: updated, reservationId, ...prepared };
    };

    /**
     * Binds a persisted Conveyor run to its verification reservation.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const beginVerification = async ({
        planId,
        expectedRevision,
        reservationId,
        runId,
    }) => {
        const plan = await storeFor().read(planId);
        if (plan.verification.reservationId === reservationId
            && plan.verification.runId === runId
            && plan.verification.status === VERIFICATION_STATUS.RUNNING) {
            return plan;
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        const inspected = await analysis.inspectVerification(runId, plan);
        const candidate = bindVerificationRun(plan, {
            reservationId,
            runId,
            inputDigest: inspected.inputDigest,
        });
        return persist(
            planId,
            expectedRevision,
            candidate,
            plan.status === PLAN_STATUS.CANCELLING
                ? "verification-attached:during-cancellation"
                : "verification-started",
        );
    };

    /**
     * Imports the exact persisted result of the bound verification run.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const finishVerification = async ({
        planId,
        expectedRevision,
        runId,
    }) => {
        const plan = await readForMutation(planId, expectedRevision);
        if (plan.verification.runId !== runId) {
            throw new MobiusOperationError(
                "verification_run_mismatch",
                `Verification run ${runId} is not bound to plan ${planId}`,
            );
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

    /**
     * Requests cancellation and snapshots active external work.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const cancel = async ({
        planId,
        expectedRevision,
        requestId,
        target,
        taskId,
        reason,
        requestedBy,
    }) => {
        const plan = await storeFor().read(planId);
        if (plan.cancellation && plan.cancellation.requestId === requestId) {
            const expectedReason = target === "task"
                ? `Required task ${taskId} was cancelled: ${reason}`
                : reason;
            if (plan.cancellation.target === target
                && plan.cancellation.taskId === (target === "task" ? taskId : null)
                && plan.cancellation.reason === expectedReason
                && plan.cancellation.requestedBy === requestedBy) {
                return plan;
            }
            throw new MobiusOperationError(
                "duplicate_request_id",
                `Cancellation request ${requestId} already exists with different input`,
            );
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
        const candidate = requestPlanCancellation(plan, {
            requestId,
            target,
            taskId,
            reason: target === "task"
                ? `Required task ${taskId} was cancelled: ${reason}`
                : reason,
            requestedBy,
        });
        return persist(
            planId,
            expectedRevision,
            candidate,
            target === "task" ? `task-cancellation-requested:${taskId}` : "plan-cancellation-requested",
        );
    };

    /**
     * Finalizes cancellation after every external action has a disposition.
     *
     * @param {any} input
     * @returns {Promise<any>}
     */
    const finalizeCancellation = async ({
        planId,
        expectedRevision,
        dispositions,
        verificationDisposition,
        finalizedBy,
    }) => {
        const plan = await readForMutation(planId, expectedRevision);
        let verificationTerminated = true;
        if (plan.cancellation?.verificationRunId) {
            verificationTerminated = await analysis.verificationRunIsTerminal(
                plan.cancellation.verificationRunId,
            );
            if (!verificationTerminated) {
                throw new MobiusOperationError(
                    "verification_not_terminated",
                    `Verification run ${plan.cancellation.verificationRunId} is still active or unobservable`,
                    { runId: plan.cancellation.verificationRunId },
                );
            }
        }
        const candidate = finalizePlanCancellation(plan, dispositions, {
            finalizedBy,
            verificationTerminated,
            verificationDisposition,
        });
        return persist(planId, expectedRevision, candidate, "plan-cancellation-finalized");
    };

    /**
     * Activates coordinator context and guardrails for one plan revision.
     *
     * @param {{planId: string, expectedRevision: number}} input
     * @returns {Promise<any>}
     */
    const activate = async ({ planId, expectedRevision }) => {
        const workspacePath = workspace();
        const marker = await storeFor(workspacePath).activate(planId, expectedRevision);
        notify({ workspacePath, planId, revision: expectedRevision });
        return marker;
    };

    return Object.freeze({
        preparePlan,
        createPlan,
        /** Reads one validated plan. */
        getPlan: ({ planId }) => storeFor().read(planId),
        getStatus,
        /** Lists bounded validated plan summaries. */
        listPlans: ({ limit }) => storeFor().list({ limit }),
        submitPlan,
        approve,
        nextTasks,
        reserveTask,
        attachTask,
        completeTask,
        retry,
        prepareVerification,
        beginVerification,
        finishVerification,
        cancel,
        finalizeCancellation,
        activate,
        /** Removes the session-local activation marker. */
        deactivate: () => storeFor().deactivate(),
        /** Reads the activated plan, or `null` when inactive. */
        getActive: () => storeFor().getActive(),
        /** Reclaims storage locks whose recorded owners are conclusively gone. */
        recoverStorage: (options) => storeFor().recoverStaleLocks(options),
        storeFor,
    });
}

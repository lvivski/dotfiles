/**
 * Application service boundary joining domain transitions, storage, prompts,
 * projections, and trusted native Factory results.
 *
 * @module foundry/operations
 */
import {
    ATTEMPT_STATUS,
	DELIVERY_REQUIREMENT,
	EVIDENCE_OUTCOME,
	EVIDENCE_TYPE,
    LIMITS,
    PLAN_STATUS,
    TASK_STATUS,
    VERIFICATION_STATUS,
    approvePlan,
    activeTaskAttempt,
    attachTaskAttempt,
	bindCancellationVerificationRun,
    completeTaskAttempt,
    completeVerification,
    createDraftPlan,
	effectiveDeliveryRequirement,
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
	buildDelegationPrompt,
	findScopeConflicts,
	selectNonOverlappingTasks,
} from "./prompts.mjs";
import { projectPlan } from "./projection.mjs";
import {
    isTerminatedSessionState,
    normalizeInventory,
    sessionState,
} from "./inventory.mjs";
import { FoundryStorageError, createPlanStore } from "./storage.mjs";

/**
 * @typedef {object} FoundryOperationsOptions
 * @property {() => string | undefined} getWorkspacePath
 * @property {(event: {workspacePath: string, planId: string, revision: number}) => void} [notify]
 * @property {any} analysis Native Factory adapter.
 */

/**
 * @typedef {object} FoundryOperations
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
 * @property {(input: any) => Promise<any>} finishVerification
 * @property {(input: any) => Promise<any>} cancel
 * @property {(input: any) => Promise<any>} cancelVerificationRun
 * @property {(input: any) => Promise<any>} finalizeCancellation
 * @property {(input: any) => Promise<any>} activate
 * @property {() => Promise<any>} deactivate
 * @property {() => Promise<any>} getActive
 * @property {(options?: any) => Promise<any>} recoverStorage
 * @property {(workspacePath?: string) => any} storeFor
 */

/** Typed operation-layer error for failures outside pure domain transitions. */
class FoundryOperationError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     * @param {unknown} [details]
     */
    constructor(code, message, details = null) {
        super(message);
        this.name = "FoundryOperationError";
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
 * @returns {FoundryStorageError}
 */
function revisionConflict(planId, expectedRevision, latestRevision) {
    return new FoundryStorageError("revision_conflict", `Plan ${planId} has changed`, {
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
 * Surfaces actionable requirements before constructing a completed attempt.
 *
 * @param {any} plan
 * @param {string} taskId
 * @param {any} attempt
 * @param {{resultSummary?: unknown, evidence?: unknown, branch?: unknown, commit?: unknown, prUrl?: unknown}} input
 * @returns {void}
 */
function validateDonePayload(plan, taskId, attempt, input) {
	const task = plan.tasks.find((candidate) => candidate.id === taskId);
	if (!task || !attempt) return;
	const requirement = effectiveDeliveryRequirement(task);
	const missing = [];
	if (attempt.sessionId === null) missing.push("attached session");
	if (typeof input.resultSummary !== "string" || !input.resultSummary.trim()) {
		missing.push("resultSummary");
	}
	if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
		missing.push("evidence");
	}
	if (typeof input.branch !== "string" || !input.branch.trim()) {
		missing.push("branch");
	}
	if (requirement === DELIVERY_REQUIREMENT.COMMIT
		|| requirement === DELIVERY_REQUIREMENT.PR) {
		if (typeof input.commit !== "string"
			|| !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)) {
			missing.push("full commit");
		}
	}
	if (requirement === DELIVERY_REQUIREMENT.PR
		&& (typeof input.prUrl !== "string" || !/^https?:\/\//.test(input.prUrl))) {
		missing.push("prUrl");
	}
	if (attempt.integrationRequired.length > 0
		&& (!Array.isArray(input.evidence)
			|| !input.evidence.some((entry) => (
				entry?.type === EVIDENCE_TYPE.INTEGRATION
				&& entry?.outcome === EVIDENCE_OUTCOME.PASSED
			)))) {
		missing.push("passed integration evidence");
	}
	if (missing.length > 0) {
		throw new FoundryOperationError(
			"task_completion_incomplete",
			`Task ${taskId} cannot complete without ${missing.join(", ")}`,
			{ taskId, attemptId: attempt.id, requirement, missing },
		);
	}
}

/** Find one attempt by its globally unique attempt ID. */
function findAttemptById(plan, attemptId) {
    for (const task of plan.tasks) {
		const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
		if (attempt) return attempt;
    }
	return null;
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
 * Creates the complete Foundry application service for one Copilot session.
 *
 * Stores are cached per session workspace while every mutation remains
 * revision-checked and atomically persisted.
 *
 * @param {FoundryOperationsOptions} options
 * @returns {Readonly<FoundryOperations>}
 */
export function createFoundryOperations(options) {
    if (!options || typeof options.getWorkspacePath !== "function") {
        throw new TypeError("createFoundryOperations requires getWorkspacePath");
    }
    if (!options.analysis) {
		throw new TypeError("createFoundryOperations requires analysis");
    }
    const stores = new Map();
    const notify = typeof options.notify === "function" ? options.notify : () => {};
    const analysis = options.analysis;

    /** Discover a native run launched for the plan's active verification reservation. */
    const discoverReservedVerification = async (plan) => {
		if (plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
			return { state: "absent" };
		}
		return analysis.discoverVerificationRun(
			plan.verification.reservationId,
			plan.verification.reservedAt,
		);
    };

    /**
     * Resolves the current session workspace or fails closed.
     *
     * @returns {string}
     */
    const workspace = () => {
        const workspacePath = options.getWorkspacePath();
        if (typeof workspacePath !== "string" || workspacePath.length === 0) {
            throw new FoundryStorageError(
                "workspace_unavailable",
                "Foundry requires a Copilot session workspace",
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
		recorded.telemetry = recorded.telemetry.slice(-LIMITS.telemetry);
        const updated = await storeFor(workspacePath).update(
            planId,
            expectedRevision,
            recorded,
        );
        notify({ workspacePath, planId, revision: updated.revision });
        return updated;
    };

    /**
     * Builds the native planning Factory launch specification.
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
                throw new FoundryOperationError(
                    "invalid_retry_status",
                    "Failed Foundry plans retry directly to running",
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
                throw new FoundryOperationError(
                    "duplicate_request_id",
                    `Reservation ${reservationId} belongs to ${existing.task.id}`,
                );
            }
            if (![
                ATTEMPT_STATUS.RESERVED,
                ATTEMPT_STATUS.RUNNING,
                ATTEMPT_STATUS.CANCEL_REQUESTED,
            ].includes(existing.attempt.status)) {
                throw new FoundryOperationError(
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
            throw new FoundryOperationError(
                "task_not_found",
                `Task ${taskId} does not exist`,
            );
        }
        const running = plan.tasks.filter((item) => item.status === TASK_STATUS.RUNNING);
        const selection = selectNonOverlappingTasks([task], running);
        if (selection.heldTaskIds.includes(taskId) && !scopeOverride) {
            throw new FoundryOperationError(
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
            throw new FoundryOperationError(
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
            throw new FoundryOperationError(
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
		sessionInventory,
    }) => {
        const plan = await readForMutation(planId, expectedRevision);
		const current = findAttempt(plan, taskId, attemptId);
		if (status === TASK_STATUS.DONE) {
			validateDonePayload(plan, taskId, current, {
				resultSummary,
				evidence,
				branch,
				commit,
				prUrl,
			});
		}
		let sessionTerminatedAt;
		if ([TASK_STATUS.FAILED, TASK_STATUS.BLOCKED].includes(status)
			&& current
			&& current.sessionId !== null) {
			const inventory = normalizeInventory(sessionInventory);
			const observedAt = current?.startedAt ?? current?.reservedAt;
			if (!inventory.complete
				|| inventory.capturedAt === null
				|| !observedAt
				|| Date.parse(inventory.capturedAt) <= Date.parse(observedAt)
				|| !isTerminatedSessionState(sessionState(current, inventory))) {
				throw new FoundryOperationError(
					"task_session_not_terminated",
					"Attached task failure requires a complete current terminal session inventory",
					{ taskId, attemptId, sessionId: current?.sessionId ?? null },
				);
			}
			sessionTerminatedAt = inventory.capturedAt;
		}
        let candidate = completeTaskAttempt(plan, taskId, attemptId, status, {
            resultSummary,
            evidence,
            error,
            branch,
            commit,
            prUrl,
			sessionTerminatedAt,
			at: sessionTerminatedAt,
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
		replacementReason,
		requestedBy,
    }) => {
        const plan = await storeFor().read(planId);
		if (plan.status !== PLAN_STATUS.RUNNING) {
			throw new FoundryOperationError(
				"invalid_plan_transition",
				`Verification can only be prepared from running, not ${plan.status}`,
			);
		}
        if (plan.verification.reservationId === reservationId
            && plan.verification.status === VERIFICATION_STATUS.RESERVED) {
			const prepared = await analysis.prepareVerification(plan, reservationId);
            if (prepared.inputDigest !== plan.verification.inputDigest) {
                throw new FoundryOperationError(
                    "verification_input_mismatch",
                    "Reserved verification input changed",
                );
            }
			const discovery = await analysis.discoverVerificationRun(
				reservationId,
				plan.verification.reservedAt,
			);
			if (discovery.state === "inconclusive") {
				throw new FoundryOperationError(
					"verification_launch_indeterminate",
					"Verification launch is not yet observable; retry preparation",
					{ discovery },
				);
			}
			return discovery.state === "found"
				? {
					plan,
					reservationId,
					...prepared,
					runId: discovery.run.runId,
					launchSpec: null,
				}
				: { plan, reservationId, ...prepared };
        }
        if (plan.verification.reservationId === reservationId) {
            throw new FoundryOperationError(
                "duplicate_request_id",
                `Verification reservation ${reservationId} is already bound or terminal`,
            );
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
		/** @type {null | {
		 *   supersededReservationId: string,
		 *   supersededRunId: string | null,
		 *   reason: string,
		 *   requestedBy: string
		 * }} */
		let replacement = null;
		if (plan.verification.status === VERIFICATION_STATUS.RESERVED) {
			if (
				typeof replacementReason !== "string"
				|| !replacementReason.trim()
				|| replacementReason.length > LIMITS.error
				|| typeof requestedBy !== "string"
				|| !requestedBy.trim()
				|| requestedBy.length > LIMITS.actor
			) {
				throw new FoundryOperationError(
					"verification_replacement_requires_approval",
					"Replacing a verification reservation requires reason and actor",
				);
			}
			const discovery = await discoverReservedVerification(plan);
			if (
				discovery.state === "inconclusive"
				&& Array.isArray(discovery.candidates)
				&& discovery.candidates.length > 1
			) {
				throw new FoundryOperationError(
					"verification_duplicate_runs",
					"Multiple Factory runs carry the same verification reservation",
					{ discovery },
				);
			}
			if (discovery.state === "found") {
				const assessment = await analysis.assessVerificationRun(
					discovery.run.runId,
					plan,
				);
				if (assessment.state === "active") {
					throw new FoundryOperationError(
						"verification_already_reserved",
						`Verification run ${discovery.run.runId} is still active`,
					);
				}
				if (assessment.state === "importable") {
					throw new FoundryOperationError(
						"verification_result_available",
						`Verification run ${discovery.run.runId} must be imported`,
					);
				}
			}
			replacement = {
				supersededReservationId: plan.verification.reservationId,
				supersededRunId:
					discovery.state === "found" ? discovery.run.runId : null,
				reason: replacementReason.trim(),
				requestedBy: requestedBy.trim(),
			};
		}
		const prepared = await analysis.prepareVerification(plan, reservationId);
        const candidate = reserveVerification(plan, {
            reservationId,
            inputDigest: prepared.inputDigest,
			replacement,
        });
        const updated = await persist(
            planId,
            expectedRevision,
            candidate,
			plan.verification.status === VERIFICATION_STATUS.RESERVED
				? "verification-replaced"
				: "verification-reserved",
        );
        return { plan: updated, reservationId, ...prepared };
    };

    /**
     * Imports the exact terminal result for the active verification reservation.
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
		if (plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
            throw new FoundryOperationError(
				"verification_not_reserved",
				`Plan ${planId} has no active verification reservation`,
            );
        }
		const discovery = await discoverReservedVerification(plan);
		if (discovery.state !== "found") {
			throw new FoundryOperationError(
				"verification_launch_indeterminate",
				"Verification reservation does not resolve to exactly one Factory run",
				{ discovery },
			);
		}
		if (discovery.run.runId !== runId) {
			throw new FoundryOperationError(
				"verification_run_mismatch",
				`Verification run ${runId} is not authoritative for this reservation`,
				{ expectedRunId: discovery.run.runId, runId },
			);
		}
		const inspected = await analysis.importVerification(runId, plan);
        const result = inspected.result;
		const candidate = completeVerification(plan, result, {
			runId,
			at: Number.isFinite(inspected.detail.completedAt)
				? inspected.detail.completedAt
				: undefined,
		});
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
        reason,
        requestedBy,
    }) => {
        const plan = await storeFor().read(planId);
        if (plan.cancellation && plan.cancellation.requestId === requestId) {
			if (plan.cancellation.reason === reason
                && plan.cancellation.requestedBy === requestedBy) {
                return plan;
            }
            throw new FoundryOperationError(
                "duplicate_request_id",
                `Cancellation request ${requestId} already exists with different input`,
            );
        }
        if (plan.revision !== expectedRevision) {
            throw revisionConflict(planId, expectedRevision, plan.revision);
        }
		const discovery = await discoverReservedVerification(plan);
        const candidate = requestPlanCancellation(plan, {
            requestId,
			reason,
            requestedBy,
			verificationRunId:
				discovery.state === "found" ? discovery.run.runId : undefined,
        });
        return persist(
            planId,
            expectedRevision,
            candidate,
			"plan-cancellation-requested",
        );
    };

	/**
	 * Cancels only the verification Factory run owned by an active cancellation.
	 *
	 * @param {any} input
	 * @returns {Promise<any>}
	 */
	const cancelVerificationRun = async ({
		planId,
		expectedRevision,
		requestId,
	}) => {
		let plan = await readForMutation(planId, expectedRevision);
		if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
			throw new FoundryOperationError(
				"invalid_plan_transition",
				`Verification cancellation cannot run while the plan is ${plan.status}`,
			);
		}
		if (plan.cancellation.requestId !== requestId) {
			throw new FoundryOperationError(
				"cancellation_request_mismatch",
				`Cancellation request ${requestId} is not active for plan ${planId}`,
				{
					expectedRequestId: plan.cancellation.requestId,
					requestId,
				},
			);
		}
		if (plan.cancellation.verificationReservationId === null) {
			return {
				planId,
				revision: plan.revision,
				requestId,
				state: "not-required",
				runId: null,
				status: null,
				alreadyTerminal: true,
				verificationDisposition: null,
			};
		}
		let runId = plan.cancellation.verificationRunId;
		if (runId === null) {
			const discovery = await discoverReservedVerification(plan);
			if (discovery.state === "inconclusive") {
				throw new FoundryOperationError(
					"verification_launch_indeterminate",
					"Verification launch cannot be resolved for cancellation",
					{ discovery },
				);
			}
			if (discovery.state === "absent") {
				return {
					planId,
					revision: plan.revision,
					requestId,
					state: "absent",
					runId: null,
					status: null,
					alreadyTerminal: true,
					verificationDisposition: "no-run-created",
				};
			}
			runId = discovery.run.runId;
			const bound = bindCancellationVerificationRun(plan, runId);
			plan = await persist(
				planId,
				expectedRevision,
				bound,
				"verification-cancellation-bound",
			);
		}
		const outcome = await analysis.cancelVerificationRun(runId);
		return {
			planId,
			revision: plan.revision,
			requestId,
			state: "terminated",
			runId,
			status: outcome.status,
			alreadyTerminal: outcome.alreadyTerminal,
			verificationDisposition: "run-terminated",
		};
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
		finalizationOverride,
		sessionInventory,
		finalizedBy,
    }) => {
		const plan = await readForMutation(planId, expectedRevision);
		if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
			throw new FoundryOperationError(
				"invalid_plan_transition",
				`Cancellation cannot be finalized from ${plan.status}`,
			);
		}
		if (!Array.isArray(dispositions)) {
			throw new FoundryOperationError(
				"invalid_cancellation_dispositions",
				"Cancellation dispositions must be an array",
			);
		}
		const inventory = normalizeInventory(sessionInventory);
		if (!inventory.complete
			|| inventory.capturedAt === null
			|| Date.parse(inventory.capturedAt)
				<= Date.parse(plan.cancellation.requestedAt)) {
			throw new FoundryOperationError(
				"cancellation_inventory_incomplete",
				"Cancellation finalization requires a complete, current session inventory",
			);
		}
		for (const disposition of dispositions) {
			if (disposition.disposition !== "session-terminated") continue;
			const attempt = findAttemptById(plan, disposition.attemptId);
			const observedAt = attempt?.startedAt ?? attempt?.reservedAt;
			if (!observedAt
				|| Date.parse(inventory.capturedAt) <= Date.parse(observedAt)) {
				throw new FoundryOperationError(
					"cancellation_inventory_stale",
					`Session inventory predates attempt ${disposition.attemptId}`,
				);
			}
			const state = attempt ? sessionState(attempt, inventory) : "unknown";
			if (!isTerminatedSessionState(state) && !finalizationOverride) {
				throw new FoundryOperationError(
					"cancellation_session_not_terminated",
					`Session ${disposition.sessionId || "(unknown)"} remains ${state}`,
					{ attemptId: disposition.attemptId, state },
				);
			}
		}
		const discovery =
			plan.cancellation?.verificationReservationId
				&& !plan.cancellation.verificationRunId
				? await discoverReservedVerification(plan)
				: { state: "absent" };
		if (discovery.state === "inconclusive" && !finalizationOverride) {
			throw new FoundryOperationError(
				"verification_launch_indeterminate",
				"Verification launch cannot be resolved for cancellation",
				{ discovery },
			);
		}
		const verificationRunId =
			plan.cancellation?.verificationRunId
			?? (discovery.state === "found" ? discovery.run.runId : null);
        let verificationTerminated = true;
		if (verificationRunId) {
            verificationTerminated = await analysis.verificationRunIsTerminal(
				verificationRunId,
            );
			if (!verificationTerminated && !finalizationOverride) {
                throw new FoundryOperationError(
                    "verification_not_terminated",
					`Verification run ${verificationRunId} is still active or unobservable`,
					{ runId: verificationRunId },
                );
            }
        }
        const candidate = finalizePlanCancellation(plan, dispositions, {
            finalizedBy,
            verificationTerminated,
            verificationDisposition,
			verificationRunId,
			finalizationOverride,
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
        finishVerification,
        cancel,
		cancelVerificationRun,
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

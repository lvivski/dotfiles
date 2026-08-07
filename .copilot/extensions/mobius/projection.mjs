/**
 * Pure, non-persisted operational projection for a validated Mobius plan.
 *
 * @module mobius/projection
 */
import {
    ATTEMPT_STATUS,
    PLAN_STATUS,
    TASK_STATUS,
    VERIFICATION_STATUS,
    activeTaskAttempt,
    validatePlan,
} from "./domain.mjs";

/**
 * @typedef {object} HostSessionInventory
 * @property {boolean} complete Whether the inventory covers every visible App session.
 * @property {string} capturedAt Canonical UTC capture timestamp.
 * @property {Array<{id: string, status: string}>} sessions Session observations.
 */

/**
 * @typedef {object} NormalizedSessionInventory
 * @property {boolean} supplied
 * @property {boolean} complete
 * @property {string | null} capturedAt
 * @property {Map<string, string>} sessions
 */

/** App session states that imply result collection rather than continued work. */
const TERMINAL_SESSION_STATUSES = new Set([
    "completed",
    "failed",
    "cancelled",
    "archived",
]);

/** Typed validation error for host session inventories. */
class MobiusProjectionError extends TypeError {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "MobiusProjectionError";
        this.code = "invalid_session_inventory";
    }
}

/**
 * Validates and indexes an optional host session inventory.
 *
 * @param {HostSessionInventory | null | undefined} inventory
 * @returns {NormalizedSessionInventory}
 * @throws {TypeError} When the supplied inventory is incomplete or malformed.
 */
function normalizeInventory(inventory) {
    if (inventory === undefined || inventory === null) {
        return {
            supplied: false,
            complete: false,
            capturedAt: null,
            sessions: new Map(),
        };
    }
    if (typeof inventory !== "object"
        || Array.isArray(inventory)
        || typeof inventory.complete !== "boolean"
        || !Array.isArray(inventory.sessions)) {
        throw new MobiusProjectionError("sessionInventory must contain complete and sessions");
    }
    /** @type {string | null} */
    let capturedAt = null;
    try {
        capturedAt = typeof inventory.capturedAt === "string"
            ? new Date(inventory.capturedAt).toISOString()
            : null;
    } catch {
        capturedAt = null;
    }
    if (capturedAt !== inventory.capturedAt) {
        throw new MobiusProjectionError(
            "sessionInventory.capturedAt must be a canonical timestamp",
        );
    }
    const sessions = new Map();
    for (const entry of inventory.sessions) {
        if (!entry
            || typeof entry !== "object"
            || Array.isArray(entry)
            || typeof entry.id !== "string"
            || !entry.id.trim()
            || typeof entry.status !== "string"
            || !entry.status.trim()
            || sessions.has(entry.id)) {
            throw new MobiusProjectionError(
                "sessionInventory contains an invalid or duplicate session",
            );
        }
        sessions.set(entry.id, entry.status);
    }
    return {
        supplied: true,
        complete: inventory.complete,
        capturedAt: inventory.capturedAt,
        sessions,
    };
}

/**
 * Resolves the best-known App session state for an attempt.
 *
 * @param {import("./domain.mjs").MobiusAttempt} attempt
 * @param {NormalizedSessionInventory} inventory
 * @returns {string}
 */
function sessionState(attempt, inventory) {
    if (attempt.sessionId === null) return "unattached";
    if (!inventory.supplied) return "unknown";
    const status = inventory.sessions.get(attempt.sessionId);
    if (status !== undefined) return status;
    const attemptObservedAt = attempt.startedAt ?? attempt.reservedAt;
    return inventory.complete
        && inventory.capturedAt !== null
        && Date.parse(inventory.capturedAt) > Date.parse(attemptObservedAt)
        ? "absent"
        : "unknown";
}

/**
 * Creates a normalized recovery action record.
 *
 * @param {string} kind
 * @param {Record<string, unknown>} [details]
 * @returns {{kind: string} & Record<string, unknown>}
 */
function action(kind, details = {}) {
    return { kind, ...details };
}

/**
 * Derives progress, liveness, and next-action guidance from authoritative state.
 *
 * The projection is intentionally not persisted and treats missing sessions as
 * absent only when a complete, causally newer host inventory is supplied.
 *
 * @param {import("./domain.mjs").MobiusPlan} plan Validated Mobius plan.
 * @param {{sessionInventory?: HostSessionInventory}} [options]
 * @returns {any} Deterministic operational projection.
 */
export function projectPlan(plan, options = {}) {
    validatePlan(plan);
    const inventory = normalizeInventory(options.sessionInventory);
    const byId = new Map(plan.tasks.map((task) => [task.id, task]));
    const byStatus = Object.fromEntries(
        Object.values(TASK_STATUS).map((status) => [status, 0]),
    );
    for (const task of plan.tasks) byStatus[task.status] += 1;
    /** @type {any[]} */
    const activeAttempts = [];
    for (const task of plan.tasks) {
        const attempt = activeTaskAttempt(task);
        if (!attempt) continue;
        activeAttempts.push({
            taskId: task.id,
            attemptId: attempt.id,
            status: attempt.status,
            sessionId: attempt.sessionId,
            sessionState: sessionState(attempt, inventory),
            baseBranch: attempt.baseBranch,
            integrationRequired: attempt.integrationRequired,
            reservedAt: attempt.reservedAt,
            startedAt: attempt.startedAt,
        });
    }
    activeAttempts.sort((left, right) => left.taskId.localeCompare(right.taskId));
    const dependencyWaits = plan.tasks
        .filter((task) => task.status === TASK_STATUS.PLANNED)
        .map((task) => ({
            taskId: task.id,
            dependencies: task.dependsOn
                .filter((dependencyId) => byId.get(dependencyId)?.status !== TASK_STATUS.DONE)
                .map((dependencyId) => ({
                    taskId: dependencyId,
                    status: byId.get(dependencyId)?.status ?? "missing",
                })),
        }))
        .filter((entry) => entry.dependencies.length > 0)
        .sort((left, right) => left.taskId.localeCompare(right.taskId));
    /** @type {any[]} */
    const actions = [];

    if (plan.status === PLAN_STATUS.CANCELLING) {
        const acknowledged = new Set(
            plan.cancellation.acknowledgements.map((entry) => entry.attemptId),
        );
        for (const attemptId of plan.cancellation.requiredAttemptIds) {
            if (acknowledged.has(attemptId)) continue;
            const task = plan.tasks.find(
                (candidate) => candidate.attempts.some((attempt) => attempt.id === attemptId),
            );
            if (!task) continue;
            const attempt = task.attempts.find((candidate) => candidate.id === attemptId);
            if (!attempt) continue;
            actions.push(attempt.sessionId === null
                ? action("resolve-session-creation", { taskId: task.id, attemptId })
                : action("terminate-session", {
                    taskId: task.id,
                    attemptId,
                    sessionId: attempt.sessionId,
                    sessionState: sessionState(attempt, inventory),
                }));
        }
        if (plan.cancellation.verificationReservationId !== null
            && plan.cancellation.verificationRunId === null) {
            actions.push(action("resolve-verification-launch", {
                reservationId: plan.cancellation.verificationReservationId,
            }));
        } else if (plan.cancellation.verificationRunId !== null
            && plan.cancellation.verificationTerminatedAt === null) {
            actions.push(action("cancel-conveyor", {
                runId: plan.cancellation.verificationRunId,
            }));
        }
        actions.push(action("finalize-cancellation", {
            requiredAttemptIds: plan.cancellation.requiredAttemptIds,
            verificationRunId: plan.cancellation.verificationRunId,
        }));
    } else {
        for (const entry of activeAttempts) {
            if (entry.status === ATTEMPT_STATUS.RESERVED) {
                actions.push(action("create-or-attach-session", {
                    taskId: entry.taskId,
                    attemptId: entry.attemptId,
                    baseBranch: entry.baseBranch,
                }));
            } else if (entry.sessionState === "absent") {
                actions.push(action("inspect-missing-session", {
                    taskId: entry.taskId,
                    attemptId: entry.attemptId,
                    sessionId: entry.sessionId,
                }));
            } else if (entry.sessionState === "idle"
                || TERMINAL_SESSION_STATUSES.has(entry.sessionState)) {
                actions.push(action("record-task-result", {
                    taskId: entry.taskId,
                    attemptId: entry.attemptId,
                    sessionId: entry.sessionId,
                }));
            } else {
                actions.push(action("wait-for-session", {
                    taskId: entry.taskId,
                    attemptId: entry.attemptId,
                    sessionId: entry.sessionId,
                    sessionState: entry.sessionState,
                }));
            }
        }
        for (const task of plan.tasks
            .filter((candidate) => candidate.status === TASK_STATUS.BLOCKED
                || candidate.status === TASK_STATUS.FAILED)
            .sort((left, right) => left.id.localeCompare(right.id))) {
            actions.push(action("retry-task", { taskId: task.id }));
        }
        for (const task of plan.tasks
            .filter((candidate) => candidate.status === TASK_STATUS.READY)
            .sort((left, right) => left.id.localeCompare(right.id))) {
            actions.push(action("reserve-task", { taskId: task.id }));
        }
        if (plan.status === PLAN_STATUS.DRAFT) {
            actions.push(action("submit-plan"));
        } else if (plan.status === PLAN_STATUS.AWAITING_APPROVAL) {
            actions.push(action("approve-plan"));
        } else if (plan.status === PLAN_STATUS.AWAITING_COMPLETION_APPROVAL) {
            actions.push(action("approve-completion"));
        } else if (plan.status === PLAN_STATUS.VERIFYING) {
            actions.push(action("inspect-verification", {
                runId: plan.verification.runId,
            }));
        } else if (plan.status === PLAN_STATUS.FAILED
            && plan.verification.status === VERIFICATION_STATUS.FAILED) {
            actions.push(action("approve-correction", {
                taskIds: plan.verification.correctionTaskIds,
            }));
        } else if (plan.status === PLAN_STATUS.RUNNING
            && plan.verification.status === VERIFICATION_STATUS.RESERVED) {
            actions.push(action("launch-verification", {
                reservationId: plan.verification.reservationId,
            }));
        } else if (plan.status === PLAN_STATUS.RUNNING
            && plan.tasks.every((task) => task.status === TASK_STATUS.DONE)) {
            actions.push(action("prepare-verification"));
        }
    }

    const total = plan.tasks.length;
    const done = byStatus[TASK_STATUS.DONE];
    return {
        planId: plan.id,
        revision: plan.revision,
        status: plan.status,
        progress: {
            total,
            done,
            percent: total === 0 ? 0 : Math.round((done / total) * 100),
            byStatus,
            attempts: plan.tasks.reduce((sum, task) => sum + task.attempts.length, 0),
        },
        activeAttempts,
        dependencyWaits,
        sessionInventory: {
            supplied: inventory.supplied,
            complete: inventory.complete,
            capturedAt: inventory.capturedAt,
        },
        actions,
        nextAction: actions[0] ?? action("none"),
    };
}

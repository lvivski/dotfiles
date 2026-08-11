/**
 * Pure Foundry plan, task, attempt, verification, and cancellation semantics.
 *
 * This module has no SDK or storage dependencies. Every persisted document and
 * mutation result must pass {@link validatePlan}.
 *
 * @module foundry/domain
 */
import path from "node:path";

/** Persisted Foundry v1 plan schema identifier. */
export const SCHEMA_VERSION = 1;

/** Immutable plan lifecycle status values. */
export const PLAN_STATUS = Object.freeze({
    DRAFT: "draft",
    AWAITING_APPROVAL: "awaiting-approval",
    APPROVED: "approved",
    RUNNING: "running",
    AWAITING_COMPLETION_APPROVAL: "awaiting-completion-approval",
    CANCELLING: "cancelling",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    FAILED: "failed",
});

/** Immutable task lifecycle status values. */
export const TASK_STATUS = Object.freeze({
    PLANNED: "planned",
    READY: "ready",
    RUNNING: "running",
    DONE: "done",
    BLOCKED: "blocked",
    FAILED: "failed",
    CANCELLED: "cancelled",
});

/** Immutable task-attempt lifecycle status values. */
export const ATTEMPT_STATUS = Object.freeze({
    RESERVED: "reserved",
    RUNNING: "running",
    DONE: "done",
    BLOCKED: "blocked",
    FAILED: "failed",
    CANCEL_REQUESTED: "cancel-requested",
    CANCELLED: "cancelled",
});

/** Supported caller evidence categories. */
export const EVIDENCE_TYPE = Object.freeze({
    COMMAND: "command",
    TEST: "test",
    INTEGRATION: "integration",
    COMMIT: "commit",
    PR: "pr",
    SESSION: "session",
    ARTIFACT: "artifact",
    MANUAL: "manual",
});

/** Supported evidence outcomes. */
export const EVIDENCE_OUTCOME = Object.freeze({
    PASSED: "passed",
    FAILED: "failed",
    INFORMATIONAL: "informational",
});

/** Immutable verification lifecycle status values. */
export const VERIFICATION_STATUS = Object.freeze({
    NOT_STARTED: "not-started",
    RESERVED: "reserved",
    PASSED: "passed",
    FAILED: "failed",
});

/** Minimum delivery metadata required before an implementation task can complete. */
export const DELIVERY_REQUIREMENT = Object.freeze({
	BRANCH: "branch",
	COMMIT: "commit",
	PR: "pr",
});

/** Central field and collection bounds for plan artifacts and tool schemas. */
export const LIMITS = Object.freeze({
    planId: 64,
    planTitle: 160,
    objective: 8_000,
    constraints: 32,
    constraint: 1_000,
    tasks: 64,
    taskTitle: 160,
    taskDescription: 12_000,
    dependencies: 64,
    acceptanceCriteria: 32,
    acceptanceCriterion: 2_000,
    expectedFiles: 128,
    expectedFile: 512,
    attempts: 64,
    attemptId: 10,
    requestId: 128,
    sessionId: 256,
    branch: 512,
    commit: 128,
    prUrl: 2_048,
    resultSummary: 8_000,
    evidence: 64,
	verificationEvidence: 64,
    evidenceItem: 2_000,
    evidenceSource: 2_048,
    producer: 256,
    error: 4_000,
    repositoryPath: 4_096,
    baseBranch: 512,
    actor: 256,
    verificationRunId: 256,
	missingEvidence: 128,
    missingEvidenceItem: 2_000,
    telemetry: 64,
    telemetryEvent: 96,
});

/**
 * @typedef {object} FoundryEvidence
 * @property {string} id Canonical attempt-local evidence ID.
 * @property {string} type Evidence category.
 * @property {string} summary Human-readable claim.
 * @property {string | null} source Command, URL, file, or other source reference.
 * @property {string} outcome Passed, failed, or informational.
 * @property {string} producer Attached session ID or coordinator.
 * @property {string | null} checkId Stable verifier check identity.
 * @property {"claimed"|"independent-claim"} trust Explicit trust classification.
 */

/**
 * @typedef {object} FoundryAttempt
 * @property {string} id Canonical task-attempt ID.
 * @property {string} reservationId Idempotent external-side-effect reservation.
 * @property {string} status Attempt lifecycle status.
 * @property {string} baseBranch Exact App child-session base ref.
 * @property {object[]} integrationRequired Additional dependency deliveries.
 * @property {object | null} scopeOverride Auditable overlap approval.
 * @property {string | null} sessionId Attached App session ID.
 * @property {string | null} branch Work branch reported by the child.
 * @property {string | null} commit Commit reported by the child.
 * @property {string | null} prUrl Pull-request URL reported by the child.
 * @property {string | null} resultSummary Terminal child summary.
 * @property {FoundryEvidence[]} evidence Claimed structured evidence.
 * @property {string | null} error Terminal error or cancellation reason.
 * @property {string} reservedAt
 * @property {string | null} startedAt
 * @property {string | null} sessionTerminatedAt
 * @property {string | null} cancelRequestedAt
 * @property {string | null} completedAt
 */

/**
 * @typedef {object} FoundryTask
 * @property {string} id
 * @property {string} title
 * @property {"implement"|"verify"} kind
 * @property {string} description
 * @property {string[]} dependsOn
 * @property {string} status
 * @property {string[]} acceptanceCriteria
 * @property {string[]} expectedFiles
 * @property {"branch"|"commit"|"pr"} deliveryRequirement
 * @property {FoundryAttempt[]} attempts
 */

/**
 * @typedef {object} FoundryPlan
 * @property {number} schemaVersion
 * @property {number} revision
 * @property {string} id
 * @property {string} title
 * @property {string} objective
 * @property {string[]} constraints
 * @property {string} status
 * @property {{workingDirectory: string, baseBranch: string}} repository
 * @property {any} planning
 * @property {FoundryTask[]} tasks
 * @property {any} gates
 * @property {any} verification
 * @property {any} cancellation
 * @property {object[]} telemetry
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** Strict persisted plan ID syntax. */
const PLAN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** Strict task ID syntax. */
const TASK_ID_PATTERN = /^T-\d{3}$/;
/** Strict task-attempt ID syntax. */
const ATTEMPT_ID_PATTERN = /^T-\d{3}-A\d{3}$/;
/** Strict evidence ID syntax. */
const EVIDENCE_ID_PATTERN = /^T-\d{3}-A\d{3}-E\d{3}$/;
/** Stable idempotency request ID syntax. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TASK_KINDS = new Set(["implement", "verify"]);
/** @type {Set<string>} */
const PLAN_STATUS_VALUES = new Set(Object.values(PLAN_STATUS));
/** @type {Set<string>} */
const TASK_STATUS_VALUES = new Set(Object.values(TASK_STATUS));
/** @type {Set<string>} */
const ATTEMPT_STATUS_VALUES = new Set(Object.values(ATTEMPT_STATUS));
/** @type {Set<string>} */
const EVIDENCE_TYPE_VALUES = new Set(Object.values(EVIDENCE_TYPE));
/** @type {Set<string>} */
const EVIDENCE_OUTCOME_VALUES = new Set(Object.values(EVIDENCE_OUTCOME));
/** @type {Set<string>} */
const VERIFICATION_STATUS_VALUES = new Set(Object.values(VERIFICATION_STATUS));
/** @type {Set<string>} */
const DELIVERY_REQUIREMENT_VALUES = new Set(Object.values(DELIVERY_REQUIREMENT));
/** Attempt states that hold task execution ownership. */
/** @type {Set<string>} */
const ACTIVE_ATTEMPT_STATUSES = new Set([
    ATTEMPT_STATUS.RESERVED,
    ATTEMPT_STATUS.RUNNING,
    ATTEMPT_STATUS.CANCEL_REQUESTED,
]);
/** Attempt outcomes accepted by terminal completion. @type {Set<string>} */
const TERMINAL_ATTEMPT_RESULTS = new Set([
    ATTEMPT_STATUS.DONE,
    ATTEMPT_STATUS.FAILED,
    ATTEMPT_STATUS.BLOCKED,
]);

const PLAN_KEYS = new Set([
    "schemaVersion",
    "revision",
    "id",
    "title",
    "objective",
    "constraints",
    "status",
    "repository",
    "planning",
    "tasks",
    "gates",
    "verification",
    "cancellation",
    "telemetry",
    "createdAt",
    "updatedAt",
]);

const REPOSITORY_KEYS = new Set(["workingDirectory", "baseBranch"]);
const PLANNING_KEYS = new Set(["runId", "inputDigest"]);
const GATE_KEYS = new Set([
    "planApprovedAt",
    "planApprovedBy",
    "completionApprovedAt",
    "completionApprovedBy",
]);
const VERIFICATION_KEYS = new Set([
    "status",
    "reservationId",
    "runId",
    "inputDigest",
    "summary",
    "evidence",
    "missingEvidence",
    "correctionTaskIds",
    "replacement",
    "reservedAt",
    "completedAt",
]);
const VERIFICATION_REPLACEMENT_KEYS = new Set([
    "supersededReservationId",
    "supersededRunId",
    "reason",
    "requestedBy",
    "at",
]);
const TELEMETRY_KEYS = new Set(["event", "at"]);
const TASK_KEYS = new Set([
    "id",
    "title",
    "kind",
    "description",
    "dependsOn",
    "status",
    "acceptanceCriteria",
    "expectedFiles",
	"deliveryRequirement",
    "attempts",
]);
const ATTEMPT_KEYS = new Set([
    "id",
    "reservationId",
    "status",
    "baseBranch",
    "integrationRequired",
    "scopeOverride",
    "sessionId",
    "branch",
    "commit",
    "prUrl",
    "resultSummary",
    "evidence",
    "error",
    "reservedAt",
    "startedAt",
	"sessionTerminatedAt",
    "cancelRequestedAt",
    "completedAt",
]);
const INTEGRATION_KEYS = new Set([
    "taskId",
    "attemptId",
    "branch",
    "commit",
    "prUrl",
]);
const SCOPE_OVERRIDE_KEYS = new Set(["approvedBy", "reason"]);
const EVIDENCE_KEYS = new Set([
    "id",
    "type",
    "summary",
    "source",
    "outcome",
    "producer",
	"checkId",
    "trust",
]);
const EVIDENCE_INPUT_KEYS = new Set([
    "type",
    "summary",
    "source",
    "outcome",
	"checkId",
]);
const CANCELLATION_KEYS = new Set([
    "requestId",
    "reason",
    "requestedBy",
    "requestedAt",
    "requiredAttemptIds",
    "verificationReservationId",
    "verificationRunId",
    "acknowledgements",
    "verificationDisposition",
    "finalizationOverride",
    "verificationTerminatedAt",
    "finalizedBy",
    "finalizedAt",
]);
const CANCELLATION_ACK_KEYS = new Set([
    "attemptId",
    "disposition",
    "sessionId",
    "acknowledgedBy",
    "acknowledgedAt",
]);
const CANCELLATION_OVERRIDE_KEYS = new Set(["reason", "attestedBy"]);
const DRAFT_INPUT_KEYS = new Set([
    "id",
    "title",
    "objective",
    "constraints",
    "repository",
    "planning",
    "tasks",
]);
const DRAFT_TASK_KEYS = new Set([
    "id",
    "title",
    "kind",
    "description",
    "dependsOn",
    "acceptanceCriteria",
    "expectedFiles",
	"deliveryRequirement",
]);

/**
 * Allowed top-level plan transitions excluding specialized workflows.
 *
 * @type {Readonly<Record<string, Set<string>>>}
 */
const PLAN_TRANSITIONS = Object.freeze({
    [PLAN_STATUS.DRAFT]: new Set([
        PLAN_STATUS.AWAITING_APPROVAL,
        PLAN_STATUS.CANCELLING,
    ]),
    [PLAN_STATUS.AWAITING_APPROVAL]: new Set([
        PLAN_STATUS.APPROVED,
        PLAN_STATUS.CANCELLING,
    ]),
    [PLAN_STATUS.APPROVED]: new Set([
        PLAN_STATUS.RUNNING,
        PLAN_STATUS.FAILED,
        PLAN_STATUS.CANCELLING,
    ]),
    [PLAN_STATUS.RUNNING]: new Set([
        PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
        PLAN_STATUS.FAILED,
        PLAN_STATUS.CANCELLING,
    ]),
    [PLAN_STATUS.AWAITING_COMPLETION_APPROVAL]: new Set([
        PLAN_STATUS.COMPLETED,
        PLAN_STATUS.CANCELLING,
    ]),
    [PLAN_STATUS.FAILED]: new Set([PLAN_STATUS.CANCELLING]),
    [PLAN_STATUS.CANCELLING]: new Set([PLAN_STATUS.CANCELLED]),
    [PLAN_STATUS.COMPLETED]: new Set(),
    [PLAN_STATUS.CANCELLED]: new Set(),
});

/** Typed error raised by domain validation and transition guards. */
export class FoundryDomainError extends Error {
    /**
     * @param {string} code Stable machine-readable error code.
     * @param {string} message Human-readable failure summary.
     * @param {{path?: string | null, details?: unknown}} [options]
     */
    constructor(code, message, options = {}) {
        super(message);
        this.name = "FoundryDomainError";
        this.code = code;
        this.path = options.path ?? null;
        this.details = options.details ?? null;
    }

    /**
     * Serializes stable public validation fields.
     *
     * @returns {{code: string, message: string, path: string | null, details: unknown}}
     */
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            path: this.path,
            details: this.details,
        };
    }
}

/**
 * Throws a typed domain error.
 *
 * @param {string} code
 * @param {string} message
 * @param {{path?: string | null, details?: unknown}} [options]
 * @returns {never}
 */
function fail(code, message, options) {
    throw new FoundryDomainError(code, message, options);
}

/**
 * Tests for a plain JSON-like object.
 *
 * @param {any} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/**
 * Requires a plain object.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @returns {void}
 */
function assertPlainObject(value, fieldPath) {
    if (!isPlainObject(value)) {
        fail("invalid_object", `${fieldPath} must be an object`, { path: fieldPath });
    }
}

/**
 * Rejects fields not declared by the current schema.
 *
 * @param {any} value
 * @param {Set<string>} keys
 * @param {string} fieldPath
 * @returns {void}
 */
function assertKnownKeys(value, keys, fieldPath) {
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
            fail("unknown_field", `${fieldPath}.${key} is not supported by schema version ${SCHEMA_VERSION}`, {
                path: `${fieldPath}.${key}`,
            });
        }
    }
}

/**
 * Requires a bounded string without NUL bytes.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @param {number} maximum
 * @param {{allowEmpty?: boolean}} [options]
 * @returns {void}
 */
function assertString(value, fieldPath, maximum, options = {}) {
    if (typeof value !== "string") {
        fail("invalid_string", `${fieldPath} must be a string`, { path: fieldPath });
    }
    if (!options.allowEmpty && value.trim().length === 0) {
        fail("empty_string", `${fieldPath} must not be empty`, { path: fieldPath });
    }
    if (value.length > maximum) {
        fail("field_too_long", `${fieldPath} exceeds the ${maximum}-character limit`, {
            path: fieldPath,
            details: { maximum, actual: value.length },
        });
    }
    if (value.includes("\0")) {
        fail("invalid_string", `${fieldPath} must not contain NUL characters`, { path: fieldPath });
    }
}

/**
 * Requires either `null` or a bounded string.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @param {number} maximum
 * @returns {void}
 */
function assertNullableString(value, fieldPath, maximum) {
    if (value === null) {
        return;
    }
    assertString(value, fieldPath, maximum);
}

/**
 * Requires a bounded array of bounded non-empty strings.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @param {{minimum?: number, maximum: number, itemMaximum: number}} options
 * @returns {void}
 */
function assertStringArray(value, fieldPath, options) {
    if (!Array.isArray(value)) {
        fail("invalid_array", `${fieldPath} must be an array`, { path: fieldPath });
    }
    if (value.length < (options.minimum ?? 0)) {
        fail("array_too_short", `${fieldPath} must contain at least ${options.minimum} item(s)`, {
            path: fieldPath,
            details: { minimum: options.minimum, actual: value.length },
        });
    }
    if (value.length > options.maximum) {
        fail("array_too_long", `${fieldPath} exceeds the ${options.maximum}-item limit`, {
            path: fieldPath,
            details: { maximum: options.maximum, actual: value.length },
        });
    }
    value.forEach((item, index) => {
        assertString(item, `${fieldPath}[${index}]`, options.itemMaximum);
    });
}

/**
 * Requires canonical millisecond-precision UTC ISO-8601.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @param {{nullable?: boolean}} [options]
 * @returns {void}
 */
function assertTimestamp(value, fieldPath, options = {}) {
    if (options.nullable && value === null) {
        return;
    }
    const canonicalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
    /** @type {string | null} */
    let canonical = null;
    if (typeof value === "string" && canonicalPattern.test(value)) {
        try {
            canonical = new Date(value).toISOString();
        } catch {
            canonical = null;
        }
    }
    if (canonical !== value) {
        fail("invalid_timestamp", `${fieldPath} must be a canonical UTC ISO-8601 timestamp`, {
            path: fieldPath,
        });
    }
}

/**
 * Requires an actor and timestamp to be both present or both absent.
 *
 * @param {any} at
 * @param {any} by
 * @param {string} prefix
 * @returns {void}
 */
function assertTimestampPair(at, by, prefix) {
    if ((at === null) !== (by === null)) {
        fail("invalid_gate", `${prefix} timestamp and actor must either both be set or both be null`, {
            path: prefix,
        });
    }
    assertTimestamp(at, `${prefix}At`, { nullable: true });
    assertNullableString(by, `${prefix}By`, LIMITS.actor);
}

/**
 * Requires `null` or an HTTP(S) URL.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @returns {void}
 */
function assertHttpUrl(value, fieldPath) {
    if (value === null) {
        return;
    }
    assertString(value, fieldPath, LIMITS.prUrl);
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        fail("invalid_url", `${fieldPath} must be a valid URL`, { path: fieldPath });
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        fail("invalid_url", `${fieldPath} must use http or https`, { path: fieldPath });
    }
}

/**
 * Creates an owned structured clone.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
    return structuredClone(value);
}

/**
 * Resolves an optional test clock to canonical UTC.
 *
 * @param {Date|string|number|(() => Date|string|number)|undefined} now
 * @returns {string}
 */
function nowIso(now) {
    const value = typeof now === "function" ? now() : now;
    const date = value === undefined ? new Date() : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        fail("invalid_timestamp", "The supplied clock did not produce a valid timestamp");
    }
    return date.toISOString();
}

/**
 * Indexes tasks by stable task ID.
 *
 * @template {{id: string}} T
 * @param {T[]} tasks
 * @returns {Map<string, T>}
 */
function taskMap(tasks) {
    return new Map(tasks.map((task) => [task.id, task]));
}

/**
 * Requires a bounded actor identity.
 *
 * @param {any} actor
 * @param {string} fieldPath
 * @returns {void}
 */
function requireActor(actor, fieldPath) {
    assertString(actor, fieldPath, LIMITS.actor);
}

/**
 * Validates a stable plan slug.
 *
 * @param {any} id
 * @param {string} [fieldPath]
 * @returns {string}
 */
export function assertPlanId(id, fieldPath = "id") {
    if (typeof id !== "string" || id.length > LIMITS.planId || !PLAN_ID_PATTERN.test(id)) {
        fail(
            "invalid_plan_id",
            `${fieldPath} must be a lowercase slug of 1-${LIMITS.planId} letters, digits, or hyphens`,
            { path: fieldPath },
        );
    }
    return id;
}

/**
 * Validates task identity, dependency references, and graph acyclicity.
 *
 * @param {any[]} tasks
 * @returns {true}
 */
export function validateDependencyGraph(tasks) {
    if (!Array.isArray(tasks)) {
        fail("invalid_array", "tasks must be an array", { path: "tasks" });
    }

    const byId = new Map();
    for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        if (!isPlainObject(task) || typeof task.id !== "string") {
            fail("invalid_task", `tasks[${index}] must have an id`, { path: `tasks[${index}].id` });
        }
        if (byId.has(task.id)) {
            fail("duplicate_task_id", `Task id ${task.id} appears more than once`, {
                path: `tasks[${index}].id`,
                details: { id: task.id },
            });
        }
        byId.set(task.id, task);
    }

    for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        const seen = new Set();
        for (let dependencyIndex = 0; dependencyIndex < task.dependsOn.length; dependencyIndex += 1) {
            const dependencyId = task.dependsOn[dependencyIndex];
            const dependencyPath = `tasks[${index}].dependsOn[${dependencyIndex}]`;
            if (dependencyId === task.id) {
                fail("self_dependency", `Task ${task.id} cannot depend on itself`, {
                    path: dependencyPath,
                    details: { id: task.id },
                });
            }
            if (seen.has(dependencyId)) {
                fail("duplicate_dependency", `Task ${task.id} repeats dependency ${dependencyId}`, {
                    path: dependencyPath,
                    details: { id: task.id, dependencyId },
                });
            }
            if (!byId.has(dependencyId)) {
                fail("unknown_dependency", `Task ${task.id} depends on unknown task ${dependencyId}`, {
                    path: dependencyPath,
                    details: { id: task.id, dependencyId },
                });
            }
            seen.add(dependencyId);
        }
    }

    const state = new Map();
    /** @type {string[]} */
    const stack = [];
    /**
     * Performs depth-first cycle detection from one task ID.
     *
     * @param {string} id
     * @returns {void}
     */
    const visit = (id) => {
        if (state.get(id) === "done") {
            return;
        }
        if (state.get(id) === "visiting") {
            const start = stack.indexOf(id);
            const cycle = [...stack.slice(start), id];
            fail("dependency_cycle", `Dependency cycle detected: ${cycle.join(" -> ")}`, {
                path: "tasks",
                details: { cycle },
            });
        }
        state.set(id, "visiting");
        stack.push(id);
        for (const dependencyId of byId.get(id).dependsOn) {
            visit(dependencyId);
        }
        stack.pop();
        state.set(id, "done");
    };

    for (const id of byId.keys()) {
        visit(id);
    }
    return true;
}

/**
 * Validates the implementation DAG and its unique final verifier task.
 *
 * @template {{
 *   id: string,
 *   kind: "implement"|"verify",
 *   dependsOn: string[],
 *   acceptanceCriteria: string[],
 *   deliveryRequirement: "branch"|"commit"|"pr"
 * }} T
 * @param {T[]} tasks
 * @returns {{verifyTask: T, targetTask: T}}
 */
export function validateTaskTopology(tasks) {
	const implementTasks = tasks.filter((task) => task.kind === "implement");
	const verifyTasks = tasks.filter((task) => task.kind === "verify");
	if (implementTasks.length === 0 || verifyTasks.length !== 1) {
		fail(
			"invalid_task_topology",
			"Plans require implementation tasks and exactly one verifier task",
			{ path: "tasks" },
		);
	}
	const verifyTask = verifyTasks[0];
	const dependedOn = new Set(tasks.flatMap((task) => task.dependsOn));
	const sinks = tasks.filter((task) => !dependedOn.has(task.id));
	if (sinks.length !== 1 || sinks[0].id !== verifyTask.id) {
		fail("invalid_task_topology", "The verifier task must be the only sink", {
			path: "tasks",
			details: { sinkTaskIds: sinks.map((task) => task.id) },
		});
	}
	if (verifyTask.dependsOn.length !== 1) {
		fail("invalid_task_topology", "The verifier must depend on one final implementation task", {
			path: `tasks[${tasks.indexOf(verifyTask)}].dependsOn`,
		});
	}
	const byId = taskMap(tasks);
	const targetTask = byId.get(verifyTask.dependsOn[0]);
	if (!targetTask || targetTask.kind !== "implement") {
		fail("invalid_task_topology", "The verifier dependency must be an implementation task", {
			path: `tasks[${tasks.indexOf(verifyTask)}].dependsOn`,
		});
	}
	const reachable = new Set();
	/** Walks dependencies into the final implementation closure. */
	const visit = (taskId) => {
		if (reachable.has(taskId)) return;
		reachable.add(taskId);
		const task = byId.get(taskId);
		if (!task) {
			fail("unknown_dependency", `Task ${taskId} is missing from the dependency graph`, {
				path: "tasks",
			});
		}
		for (const dependencyId of task.dependsOn) visit(dependencyId);
	};
	visit(targetTask.id);
	const missing = implementTasks
		.map((task) => task.id)
		.filter((taskId) => !reachable.has(taskId));
	if (missing.length > 0) {
		fail("invalid_task_topology", "Every implementation task must converge before verification", {
			path: "tasks",
			details: { unreachableTaskIds: missing },
		});
	}
	const targetDelivery = effectiveDeliveryRequirement(targetTask);
	if (targetDelivery !== DELIVERY_REQUIREMENT.COMMIT
		&& targetDelivery !== DELIVERY_REQUIREMENT.PR) {
		fail(
			"invalid_task_topology",
			"The final implementation task must require commit or pr delivery",
			{ path: `tasks[${tasks.indexOf(targetTask)}].deliveryRequirement` },
		);
	}
	const criterionCount = implementTasks.reduce(
		(total, task) => total + task.acceptanceCriteria.length,
		0,
	);
	if (criterionCount > LIMITS.evidence - 2) {
		fail(
			"too_many_verification_checks",
			`Implementation criteria must not exceed ${LIMITS.evidence - 2}`,
			{ path: "tasks", details: { criterionCount } },
		);
	}
	return { verifyTask, targetTask };
}

/**
 * Derives the next canonical attempt ID for a task-local index.
 *
 * @param {string} taskId
 * @param {number} index
 * @returns {string}
 */
function expectedAttemptId(taskId, index) {
    return `${taskId}-A${String(index + 1).padStart(3, "0")}`;
}

/**
 * Derives the canonical evidence ID for an attempt-local index.
 *
 * @param {string} attemptId
 * @param {number} index
 * @returns {string}
 */
function expectedEvidenceId(attemptId, index) {
    return `${attemptId}-E${String(index + 1).padStart(3, "0")}`;
}

/** Returns the canonical verifier check IDs in stable order. */
export function verificationCheckIds(tasks) {
	return [
		...tasks
			.filter((task) => task.kind === "implement")
			.sort((left, right) => left.id.localeCompare(right.id))
			.flatMap((task) => task.acceptanceCriteria.map(
				(_criterion, index) => `${task.id}-C${String(index + 1).padStart(3, "0")}`,
			)),
		"final-integration",
		"workspace-integrity",
	];
}

/**
 * Requires a stable idempotency request ID.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @returns {void}
 */
function assertRequestId(value, fieldPath) {
    if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
        fail("invalid_request_id", `${fieldPath} must be a stable request identifier`, {
            path: fieldPath,
        });
    }
}

/**
 * Requires `null` or a lowercase Git object ID.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @returns {void}
 */
function assertCommit(value, fieldPath) {
    if (value === null) return;
    if (typeof value !== "string"
		|| !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
		fail("invalid_commit", `${fieldPath} must be a full lowercase Git object ID`, {
            path: fieldPath,
        });
    }
}

/**
 * Validates and returns a task's minimum delivery requirement.
 *
 * @param {FoundryTask | any} task
 * @param {string} [fieldPath]
 * @returns {"branch"|"commit"|"pr"}
 */
export function effectiveDeliveryRequirement(task, fieldPath = "deliveryRequirement") {
	const requirement = task.deliveryRequirement;
	if (!DELIVERY_REQUIREMENT_VALUES.has(requirement)) {
		fail(
			"invalid_delivery_requirement",
			`${fieldPath} must be branch, commit, or pr`,
			{ path: fieldPath, details: { value: requirement } },
		);
	}
	return requirement;
}

/**
 * Requires one successful attempt to satisfy its task's delivery contract.
 *
 * Commit and PR delivery must carry a full SHA-1 or SHA-256 object ID; PR
 * delivery also needs a URL.
 *
 * @param {FoundryTask} task
 * @param {FoundryTask} task
 * @param {FoundryAttempt} attempt
 * @param {string} fieldPath
 * @returns {void}
 */
function assertAttemptDelivery(task, attempt, fieldPath) {
	const requirement = effectiveDeliveryRequirement(
		task,
		`${fieldPath}.deliveryRequirement`,
	);
	const fullCommit = typeof attempt.commit === "string"
		&& /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(attempt.commit);
	const satisfied = attempt.branch !== null
		&& (requirement === DELIVERY_REQUIREMENT.BRANCH
			|| (fullCommit
				&& (requirement !== DELIVERY_REQUIREMENT.PR || attempt.prUrl !== null)));
	if (!satisfied) {
		fail(
			"delivery_requirement_unsatisfied",
			`Attempt ${attempt.id} does not satisfy ${requirement} delivery`,
			{
				path: fieldPath,
				details: {
					requirement,
					branch: attempt.branch,
					commit: attempt.commit,
					prUrl: attempt.prUrl,
				},
			},
		);
	}
}

/**
 * Validates a dependency delivery that must be integrated by a later attempt.
 *
 * @param {any} entry
 * @param {string} fieldPath
 * @returns {void}
 */
function validateIntegrationEntry(entry, fieldPath) {
    assertPlainObject(entry, fieldPath);
    assertKnownKeys(entry, INTEGRATION_KEYS, fieldPath);
    if (typeof entry.taskId !== "string" || !TASK_ID_PATTERN.test(entry.taskId)) {
        fail("invalid_task_id", `${fieldPath}.taskId must use the T-001 format`, {
            path: `${fieldPath}.taskId`,
        });
    }
    if (typeof entry.attemptId !== "string"
        || !ATTEMPT_ID_PATTERN.test(entry.attemptId)
        || !entry.attemptId.startsWith(`${entry.taskId}-`)) {
        fail("invalid_attempt_id", `${fieldPath}.attemptId must belong to ${entry.taskId}`, {
            path: `${fieldPath}.attemptId`,
        });
    }
    assertNullableString(entry.branch, `${fieldPath}.branch`, LIMITS.branch);
    assertCommit(entry.commit, `${fieldPath}.commit`);
    assertHttpUrl(entry.prUrl, `${fieldPath}.prUrl`);
    if (entry.branch === null && entry.commit === null && entry.prUrl === null) {
        fail("invalid_integration_entry", `${fieldPath} must identify delivered work`, {
            path: fieldPath,
        });
    }
}

/**
 * Validates an auditable file-scope overlap approval.
 *
 * @param {any} value
 * @param {string} fieldPath
 * @returns {void}
 */
function validateScopeOverride(value, fieldPath) {
    if (value === null) return;
    assertPlainObject(value, fieldPath);
    assertKnownKeys(value, SCOPE_OVERRIDE_KEYS, fieldPath);
    assertString(value.approvedBy, `${fieldPath}.approvedBy`, LIMITS.actor);
    assertString(value.reason, `${fieldPath}.reason`, LIMITS.error);
}

/**
 * Validates canonical evidence identity and attempt-bound provenance.
 *
 * @param {any} entry
 * @param {FoundryAttempt} attempt
 * @param {number} index
 * @param {string} fieldPath
 * @returns {void}
 */
function validateEvidence(entry, task, attempt, index, fieldPath) {
    assertPlainObject(entry, fieldPath);
    assertKnownKeys(entry, EVIDENCE_KEYS, fieldPath);
    const expectedId = expectedEvidenceId(attempt.id, index);
    if (entry.id !== expectedId || !EVIDENCE_ID_PATTERN.test(entry.id)) {
        fail("invalid_evidence_id", `${fieldPath}.id must be ${expectedId}`, {
            path: `${fieldPath}.id`,
        });
    }
    if (!EVIDENCE_TYPE_VALUES.has(entry.type)) {
        fail("invalid_evidence_type", `${fieldPath}.type is not supported`, {
            path: `${fieldPath}.type`,
        });
    }
    assertString(entry.summary, `${fieldPath}.summary`, LIMITS.evidenceItem);
    assertNullableString(entry.source, `${fieldPath}.source`, LIMITS.evidenceSource);
    if (!EVIDENCE_OUTCOME_VALUES.has(entry.outcome)) {
        fail("invalid_evidence_outcome", `${fieldPath}.outcome is not supported`, {
            path: `${fieldPath}.outcome`,
        });
    }
    if ([EVIDENCE_TYPE.COMMAND, EVIDENCE_TYPE.TEST, EVIDENCE_TYPE.INTEGRATION].includes(entry.type)
        && entry.outcome === EVIDENCE_OUTCOME.INFORMATIONAL) {
        fail("invalid_evidence_outcome", `${fieldPath}.outcome must record pass or failure`, {
            path: `${fieldPath}.outcome`,
        });
    }
    assertString(entry.producer, `${fieldPath}.producer`, LIMITS.producer);
    if (entry.producer !== (attempt.sessionId ?? "coordinator")) {
        fail("invalid_evidence_producer", `${fieldPath}.producer does not match its attempt`, {
            path: `${fieldPath}.producer`,
        });
    }
	const expectedTrust = task.kind === "verify" ? "independent-claim" : "claimed";
	if (entry.trust !== expectedTrust) {
		fail("invalid_evidence_trust", `${fieldPath}.trust must be ${expectedTrust}`, {
            path: `${fieldPath}.trust`,
        });
    }
	if (task.kind === "verify") {
		assertString(entry.checkId, `${fieldPath}.checkId`, 32);
	} else if (entry.checkId !== null) {
		fail("invalid_evidence_check", `${fieldPath}.checkId must be null`, {
			path: `${fieldPath}.checkId`,
		});
	}
}

/**
 * Returns the sole nonterminal attempt for a task.
 *
 * @param {FoundryTask} task
 * @returns {FoundryAttempt | null}
 */
export function activeTaskAttempt(task) {
    return task.attempts.find((attempt) => ACTIVE_ATTEMPT_STATUSES.has(attempt.status)) ?? null;
}

/**
 * Returns the most recent successful attempt without mutating history.
 *
 * @param {FoundryTask} task
 * @returns {FoundryAttempt | null}
 */
export function latestSuccessfulAttempt(task) {
    return [...task.attempts].reverse().find(
        (attempt) => attempt.status === ATTEMPT_STATUS.DONE,
    ) ?? null;
}

/**
 * Validates one attempt and all status-dependent field invariants.
 *
 * @param {any} attempt
 * @param {FoundryTask} task
 * @param {number} index
 * @param {string} fieldPath
 * @returns {void}
 */
function validateAttempt(attempt, task, index, fieldPath) {
    assertPlainObject(attempt, fieldPath);
    assertKnownKeys(attempt, ATTEMPT_KEYS, fieldPath);
	const expectedId = expectedAttemptId(task.id, index);
    if (attempt.id !== expectedId || !ATTEMPT_ID_PATTERN.test(attempt.id)) {
        fail("invalid_attempt_id", `${fieldPath}.id must be ${expectedId}`, {
            path: `${fieldPath}.id`,
        });
    }
    assertRequestId(attempt.reservationId, `${fieldPath}.reservationId`);
    if (!ATTEMPT_STATUS_VALUES.has(attempt.status)) {
        fail("invalid_attempt_status", `${fieldPath}.status is not supported`, {
            path: `${fieldPath}.status`,
        });
    }
    assertString(attempt.baseBranch, `${fieldPath}.baseBranch`, LIMITS.baseBranch);
    if (!Array.isArray(attempt.integrationRequired)
        || attempt.integrationRequired.length > LIMITS.dependencies) {
        fail("invalid_integration_entries", `${fieldPath}.integrationRequired is invalid`, {
            path: `${fieldPath}.integrationRequired`,
        });
    }
    attempt.integrationRequired.forEach((entry, integrationIndex) => {
        validateIntegrationEntry(
            entry,
            `${fieldPath}.integrationRequired[${integrationIndex}]`,
        );
    });
    validateScopeOverride(attempt.scopeOverride, `${fieldPath}.scopeOverride`);
    assertNullableString(attempt.sessionId, `${fieldPath}.sessionId`, LIMITS.sessionId);
    assertNullableString(attempt.branch, `${fieldPath}.branch`, LIMITS.branch);
    assertCommit(attempt.commit, `${fieldPath}.commit`);
    assertHttpUrl(attempt.prUrl, `${fieldPath}.prUrl`);
    assertNullableString(attempt.resultSummary, `${fieldPath}.resultSummary`, LIMITS.resultSummary);
    if (!Array.isArray(attempt.evidence) || attempt.evidence.length > LIMITS.evidence) {
        fail("invalid_evidence", `${fieldPath}.evidence is invalid`, {
            path: `${fieldPath}.evidence`,
        });
    }
    attempt.evidence.forEach((entry, evidenceIndex) => {
		validateEvidence(entry, task, attempt, evidenceIndex, `${fieldPath}.evidence[${evidenceIndex}]`);
    });
    assertNullableString(attempt.error, `${fieldPath}.error`, LIMITS.error);
    assertTimestamp(attempt.reservedAt, `${fieldPath}.reservedAt`);
    assertTimestamp(attempt.startedAt, `${fieldPath}.startedAt`, { nullable: true });
	assertTimestamp(
		attempt.sessionTerminatedAt,
		`${fieldPath}.sessionTerminatedAt`,
		{ nullable: true },
	);
    assertTimestamp(attempt.cancelRequestedAt, `${fieldPath}.cancelRequestedAt`, { nullable: true });
    assertTimestamp(attempt.completedAt, `${fieldPath}.completedAt`, { nullable: true });
    if (attempt.startedAt !== null
        && Date.parse(attempt.startedAt) < Date.parse(attempt.reservedAt)) {
        fail("invalid_attempt_timestamps", `${fieldPath}.startedAt precedes reservedAt`, {
            path: `${fieldPath}.startedAt`,
        });
    }
    if (attempt.completedAt !== null
        && Date.parse(attempt.completedAt) < Date.parse(attempt.reservedAt)) {
        fail("invalid_attempt_timestamps", `${fieldPath}.completedAt precedes reservedAt`, {
            path: `${fieldPath}.completedAt`,
        });
    }

    if (attempt.status === ATTEMPT_STATUS.RESERVED) {
        if (attempt.sessionId !== null
            || attempt.branch !== null
            || attempt.commit !== null
            || attempt.prUrl !== null
            || attempt.resultSummary !== null
            || attempt.evidence.length > 0
            || attempt.error !== null
            || attempt.startedAt !== null
			|| attempt.sessionTerminatedAt !== null
            || attempt.cancelRequestedAt !== null
            || attempt.completedAt !== null) {
            fail("invalid_attempt_state", `${fieldPath} contains data before attachment`, {
                path: fieldPath,
            });
        }
    } else if (attempt.status === ATTEMPT_STATUS.RUNNING) {
        if (attempt.sessionId === null
            || attempt.startedAt === null
            || attempt.resultSummary !== null
            || attempt.evidence.length > 0
            || attempt.error !== null
			|| attempt.sessionTerminatedAt !== null
            || attempt.cancelRequestedAt !== null
            || attempt.completedAt !== null) {
            fail("invalid_attempt_state", `${fieldPath} is not a valid running attempt`, {
                path: fieldPath,
            });
        }
    } else if (attempt.status === ATTEMPT_STATUS.DONE) {
        const integrationEvidence = attempt.evidence.some(
            (entry) => entry.type === EVIDENCE_TYPE.INTEGRATION
                && entry.outcome === EVIDENCE_OUTCOME.PASSED,
        );
        if (attempt.sessionId === null
            || attempt.startedAt === null
            || attempt.branch === null
            || attempt.resultSummary === null
            || attempt.evidence.length === 0
            || attempt.error !== null
			|| attempt.sessionTerminatedAt !== null
            || attempt.cancelRequestedAt !== null
            || attempt.completedAt === null
            || (attempt.integrationRequired.length > 0 && !integrationEvidence)) {
            fail("invalid_attempt_state", `${fieldPath} is not a valid completed attempt`, {
                path: fieldPath,
            });
        }
    } else if (attempt.status === ATTEMPT_STATUS.BLOCKED
        || attempt.status === ATTEMPT_STATUS.FAILED) {
        if (attempt.error === null
            || attempt.completedAt === null
            || attempt.cancelRequestedAt !== null
			|| (attempt.sessionId === null && attempt.sessionTerminatedAt !== null)
			|| (attempt.sessionId !== null
				&& (attempt.startedAt === null || attempt.sessionTerminatedAt === null))) {
            fail("invalid_attempt_state", `${fieldPath} is not a valid terminal attempt`, {
                path: fieldPath,
            });
        }
    } else if (attempt.status === ATTEMPT_STATUS.CANCEL_REQUESTED) {
        if (attempt.cancelRequestedAt === null
            || attempt.completedAt !== null
            || attempt.error === null
			|| attempt.sessionTerminatedAt !== null
            || (attempt.sessionId !== null && attempt.startedAt === null)) {
            fail("invalid_attempt_state", `${fieldPath} is not awaiting cancellation`, {
                path: fieldPath,
            });
        }
    } else if (attempt.status === ATTEMPT_STATUS.CANCELLED
        && (attempt.cancelRequestedAt === null
            || attempt.completedAt === null
            || attempt.error === null
			|| (attempt.sessionId === null && attempt.sessionTerminatedAt !== null)
			|| (attempt.sessionId !== null
				&& (attempt.startedAt === null || attempt.sessionTerminatedAt === null)))) {
        fail("invalid_attempt_state", `${fieldPath} is not a valid cancelled attempt`, {
            path: fieldPath,
        });
    }
}

/**
 * Validates one task and its append-only attempt history.
 *
 * @param {any} task
 * @param {number} index
 * @returns {void}
 */
function validateTask(task, index, tasks) {
    const fieldPath = `tasks[${index}]`;
    assertPlainObject(task, fieldPath);
    assertKnownKeys(task, TASK_KEYS, fieldPath);
    if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id)) {
        fail("invalid_task_id", `${fieldPath}.id must use the T-001 format`, {
            path: `${fieldPath}.id`,
        });
    }
    assertString(task.title, `${fieldPath}.title`, LIMITS.taskTitle);
    if (!TASK_KINDS.has(task.kind)) {
		fail("invalid_task_kind", `${fieldPath}.kind must be implement or verify`, {
            path: `${fieldPath}.kind`,
        });
    }
    assertString(task.description, `${fieldPath}.description`, LIMITS.taskDescription);
    assertStringArray(task.dependsOn, `${fieldPath}.dependsOn`, {
        maximum: LIMITS.dependencies,
        itemMaximum: 5,
    });
    if (!TASK_STATUS_VALUES.has(task.status)) {
        fail("invalid_task_status", `${fieldPath}.status is not supported`, {
            path: `${fieldPath}.status`,
            details: { value: task.status },
        });
    }
    assertStringArray(task.acceptanceCriteria, `${fieldPath}.acceptanceCriteria`, {
		minimum: task.kind === "verify" ? 0 : 1,
        maximum: LIMITS.acceptanceCriteria,
        itemMaximum: LIMITS.acceptanceCriterion,
    });
    assertStringArray(task.expectedFiles, `${fieldPath}.expectedFiles`, {
        maximum: LIMITS.expectedFiles,
        itemMaximum: LIMITS.expectedFile,
    });
	effectiveDeliveryRequirement(task, `${fieldPath}.deliveryRequirement`);
	if (task.kind === "verify"
		&& (task.acceptanceCriteria.length !== 0
			|| task.expectedFiles.length !== 0
			|| task.deliveryRequirement !== DELIVERY_REQUIREMENT.COMMIT)) {
		fail(
			"invalid_verifier_task",
			"Verifier tasks require no authored criteria/files and commit delivery",
			{ path: fieldPath },
		);
	}
    if (!Array.isArray(task.attempts) || task.attempts.length > LIMITS.attempts) {
        fail("invalid_attempts", `${fieldPath}.attempts is invalid`, {
            path: `${fieldPath}.attempts`,
        });
    }
	const expectedChecks = task.kind === "verify"
		? verificationCheckIds(tasks)
		: [];
    task.attempts.forEach((attempt, attemptIndex) => {
		validateAttempt(attempt, task, attemptIndex, `${fieldPath}.attempts[${attemptIndex}]`);
		const actualChecks = attempt.evidence.map((entry) => entry.checkId);
		if (task.kind === "verify"
			&& (new Set(actualChecks).size !== actualChecks.length
				|| actualChecks.some((checkId) => !expectedChecks.includes(checkId)))) {
			fail(
				"invalid_verifier_report",
				`${fieldPath}.attempts[${attemptIndex}] contains invalid check IDs`,
				{ path: `${fieldPath}.attempts[${attemptIndex}].evidence` },
			);
		}
		if (attempt.status === ATTEMPT_STATUS.DONE) {
			assertAttemptDelivery(
				task,
				attempt,
				`${fieldPath}.attempts[${attemptIndex}]`,
			);
			if (task.kind === "verify") {
				if (actualChecks.length !== expectedChecks.length
					|| actualChecks.some((checkId, checkIndex) => (
						checkId !== expectedChecks[checkIndex]
					))
					|| attempt.prUrl !== null) {
					fail(
						"invalid_verifier_report",
						`${fieldPath}.attempts[${attemptIndex}] lacks the canonical verifier report`,
						{ path: `${fieldPath}.attempts[${attemptIndex}]` },
					);
				}
			}
		}
    });
    const active = task.attempts.filter((attempt) => [
        ATTEMPT_STATUS.RESERVED,
        ATTEMPT_STATUS.RUNNING,
        ATTEMPT_STATUS.CANCEL_REQUESTED,
    ].includes(attempt.status));
    if (active.length > 1) {
        fail("multiple_active_attempts", `${fieldPath} has more than one active attempt`, {
            path: `${fieldPath}.attempts`,
        });
    }
    if (task.status === TASK_STATUS.RUNNING && active.length !== 1) {
        fail("invalid_task_state", `${fieldPath} requires one active attempt while running`, {
            path: fieldPath,
        });
    }
    if (task.status !== TASK_STATUS.RUNNING && active.length !== 0) {
        fail("invalid_task_state", `${fieldPath} cannot retain an active attempt in ${task.status}`, {
            path: fieldPath,
        });
    }
    const latest = task.attempts.at(-1);
    if (task.status === TASK_STATUS.DONE && latest?.status !== ATTEMPT_STATUS.DONE) {
        fail("invalid_task_state", `${fieldPath} must end in a successful attempt`, {
            path: fieldPath,
        });
    }
    if (task.status === TASK_STATUS.BLOCKED && latest?.status !== ATTEMPT_STATUS.BLOCKED) {
        fail("invalid_task_state", `${fieldPath} must end in a blocked attempt`, {
            path: fieldPath,
        });
    }
    if (task.status === TASK_STATUS.FAILED && latest?.status !== ATTEMPT_STATUS.FAILED) {
        fail("invalid_task_state", `${fieldPath} must end in a failed attempt`, {
            path: fieldPath,
        });
    }
}

/**
 * Validates verification reservation, run binding, and terminal result fields.
 *
 * @param {any} verification
 * @returns {void}
 */
function validateVerification(verification) {
    assertPlainObject(verification, "verification");
    assertKnownKeys(verification, VERIFICATION_KEYS, "verification");
    if (!VERIFICATION_STATUS_VALUES.has(verification.status)) {
        fail("invalid_verification_status", "verification.status is not supported", {
            path: "verification.status",
            details: { value: verification.status },
        });
    }
    assertNullableString(
        verification.reservationId,
        "verification.reservationId",
        LIMITS.requestId,
    );
    if (verification.reservationId !== null) {
        assertRequestId(verification.reservationId, "verification.reservationId");
    }
    assertNullableString(
        verification.runId,
        "verification.runId",
        LIMITS.verificationRunId,
    );
    assertNullableString(
        verification.inputDigest,
        "verification.inputDigest",
        64,
    );
    assertNullableString(
        verification.summary,
        "verification.summary",
        LIMITS.resultSummary,
    );
    assertStringArray(verification.evidence, "verification.evidence", {
		maximum: LIMITS.verificationEvidence,
        itemMaximum: LIMITS.evidenceItem,
    });
    assertStringArray(verification.missingEvidence, "verification.missingEvidence", {
        maximum: LIMITS.missingEvidence,
        itemMaximum: LIMITS.missingEvidenceItem,
    });
    assertStringArray(verification.correctionTaskIds, "verification.correctionTaskIds", {
        maximum: LIMITS.tasks,
        itemMaximum: 5,
    });
    if (verification.replacement !== null) {
		assertPlainObject(verification.replacement, "verification.replacement");
		assertKnownKeys(
			verification.replacement,
			VERIFICATION_REPLACEMENT_KEYS,
			"verification.replacement",
		);
		assertRequestId(
			verification.replacement.supersededReservationId,
			"verification.replacement.supersededReservationId",
		);
		assertNullableString(
			verification.replacement.supersededRunId,
			"verification.replacement.supersededRunId",
			LIMITS.verificationRunId,
		);
		assertString(
			verification.replacement.reason,
			"verification.replacement.reason",
			LIMITS.error,
		);
		assertString(
			verification.replacement.requestedBy,
			"verification.replacement.requestedBy",
			LIMITS.actor,
		);
		assertTimestamp(verification.replacement.at, "verification.replacement.at");
    }
    assertTimestamp(verification.reservedAt, "verification.reservedAt", { nullable: true });
    assertTimestamp(verification.completedAt, "verification.completedAt", { nullable: true });
    if (verification.reservedAt !== null
		&& verification.completedAt !== null
		&& Date.parse(verification.completedAt) < Date.parse(verification.reservedAt)) {
		fail("invalid_verification_timestamps", "verification.completedAt precedes reservedAt", {
			path: "verification.completedAt",
        });
    }

    if (verification.status === VERIFICATION_STATUS.NOT_STARTED) {
        if (verification.reservationId !== null
            || verification.runId !== null
            || verification.inputDigest !== null
            || verification.summary !== null
            || verification.evidence.length > 0
            || verification.missingEvidence.length > 0
            || verification.correctionTaskIds.length > 0
			|| verification.replacement !== null
            || verification.reservedAt !== null
            || verification.completedAt !== null) {
            fail("invalid_verification_state", "Unstarted verification cannot contain run data", {
                path: "verification",
            });
        }
    } else if (verification.status === VERIFICATION_STATUS.RESERVED) {
        if (verification.reservationId === null
            || verification.runId !== null
            || !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
            || verification.reservedAt === null
            || verification.summary !== null
            || verification.evidence.length > 0
            || verification.missingEvidence.length > 0
            || verification.correctionTaskIds.length > 0
            || verification.completedAt !== null) {
            fail("invalid_verification_state", "Reserved verification contains invalid run data", {
                path: "verification",
            });
        }
    } else if (verification.status === VERIFICATION_STATUS.PASSED) {
		if (verification.reservationId === null
            || verification.runId === null
            || !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
            || verification.reservedAt === null
            || verification.completedAt === null
            || verification.summary === null
            || verification.evidence.length === 0
            || verification.missingEvidence.length > 0) {
            fail(
                "invalid_verification_state",
                "Passed verification requires timestamps, summary, evidence, and no missing evidence",
                { path: "verification" },
            );
        }
        if (verification.correctionTaskIds.length > 0) {
            fail("invalid_verification_state", "Passed verification cannot request corrections", {
                path: "verification.correctionTaskIds",
            });
        }
    } else if (verification.status === VERIFICATION_STATUS.FAILED) {
		if (verification.reservationId === null
            || verification.runId === null
            || !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
            || verification.reservedAt === null
            || verification.completedAt === null
            || verification.summary === null
            || verification.missingEvidence.length === 0
            || verification.correctionTaskIds.length === 0) {
            fail(
                "invalid_verification_state",
                "Failed verification requires timestamps, summary, and missing evidence",
                { path: "verification" },
            );
        }
    }
}

/**
 * Creates the canonical unstarted verification state.
 *
 * @returns {object}
 */
function emptyVerification() {
    return {
        status: VERIFICATION_STATUS.NOT_STARTED,
        reservationId: null,
        runId: null,
        inputDigest: null,
        summary: null,
        evidence: [],
        missingEvidence: [],
        correctionTaskIds: [],
		replacement: null,
        reservedAt: null,
        completedAt: null,
    };
}

/**
 * Validates cancellation snapshots, acknowledgements, and final disposition.
 *
 * @param {any} cancellation
 * @param {string} planStatus
 * @param {FoundryTask[]} tasks
 * @returns {void}
 */
function validateCancellation(cancellation, planStatus, tasks) {
    if (cancellation === null) {
        if (planStatus === PLAN_STATUS.CANCELLING || planStatus === PLAN_STATUS.CANCELLED) {
            fail("missing_cancellation", `Plan status ${planStatus} requires cancellation metadata`, {
                path: "cancellation",
            });
        }
        return;
    }
    assertPlainObject(cancellation, "cancellation");
    assertKnownKeys(cancellation, CANCELLATION_KEYS, "cancellation");
    assertRequestId(cancellation.requestId, "cancellation.requestId");
    assertString(cancellation.reason, "cancellation.reason", LIMITS.error);
    assertString(cancellation.requestedBy, "cancellation.requestedBy", LIMITS.actor);
    assertTimestamp(cancellation.requestedAt, "cancellation.requestedAt");
    assertStringArray(cancellation.requiredAttemptIds, "cancellation.requiredAttemptIds", {
		maximum: LIMITS.tasks,
        itemMaximum: LIMITS.attemptId,
    });
	/** @type {Map<string, any>} */
    const attemptsById = new Map(tasks.flatMap(
        (task) => task.attempts.map((attempt) => [attempt.id, attempt]),
    ));
    const knownAttemptIds = new Set(attemptsById.keys());
    if (new Set(cancellation.requiredAttemptIds).size !== cancellation.requiredAttemptIds.length
        || cancellation.requiredAttemptIds.some((id) => !knownAttemptIds.has(id))) {
        fail("invalid_cancellation_attempts", "Cancellation attempt snapshot is invalid", {
            path: "cancellation.requiredAttemptIds",
        });
    }
    assertNullableString(
        cancellation.verificationReservationId,
        "cancellation.verificationReservationId",
        LIMITS.requestId,
    );
    if (cancellation.verificationReservationId !== null) {
        assertRequestId(
            cancellation.verificationReservationId,
            "cancellation.verificationReservationId",
        );
    }
    assertNullableString(
        cancellation.verificationRunId,
        "cancellation.verificationRunId",
        LIMITS.verificationRunId,
    );
    if (cancellation.finalizationOverride !== null) {
		assertPlainObject(cancellation.finalizationOverride, "cancellation.finalizationOverride");
		assertKnownKeys(
			cancellation.finalizationOverride,
			CANCELLATION_OVERRIDE_KEYS,
			"cancellation.finalizationOverride",
		);
		assertString(
			cancellation.finalizationOverride.reason,
			"cancellation.finalizationOverride.reason",
			LIMITS.error,
		);
		assertString(
			cancellation.finalizationOverride.attestedBy,
			"cancellation.finalizationOverride.attestedBy",
			LIMITS.actor,
		);
    }
    if (!Array.isArray(cancellation.acknowledgements)
		|| cancellation.acknowledgements.length > LIMITS.tasks + 1) {
        fail("invalid_cancellation_acknowledgements", "Cancellation acknowledgements are invalid", {
            path: "cancellation.acknowledgements",
        });
    }
    cancellation.acknowledgements.forEach((entry, index) => {
        const fieldPath = `cancellation.acknowledgements[${index}]`;
        assertPlainObject(entry, fieldPath);
        assertKnownKeys(entry, CANCELLATION_ACK_KEYS, fieldPath);
        if (!cancellation.requiredAttemptIds.includes(entry.attemptId)) {
            fail("invalid_cancellation_acknowledgement", `${fieldPath}.attemptId was not snapshotted`, {
                path: `${fieldPath}.attemptId`,
            });
        }
        if (!["session-terminated", "no-session-created"].includes(entry.disposition)) {
            fail("invalid_cancellation_acknowledgement", `${fieldPath}.disposition is invalid`, {
                path: `${fieldPath}.disposition`,
            });
        }
        if (entry.disposition === "session-terminated") {
            assertString(entry.sessionId, `${fieldPath}.sessionId`, LIMITS.sessionId);
        } else if (entry.sessionId !== null) {
            fail("invalid_cancellation_acknowledgement", `${fieldPath}.sessionId must be null`, {
                path: `${fieldPath}.sessionId`,
            });
        }
        assertString(entry.acknowledgedBy, `${fieldPath}.acknowledgedBy`, LIMITS.actor);
        assertTimestamp(entry.acknowledgedAt, `${fieldPath}.acknowledgedAt`);
    });
    if (new Set(cancellation.acknowledgements.map((entry) => entry.attemptId)).size
        !== cancellation.acknowledgements.length) {
        fail("duplicate_cancellation_acknowledgement", "An attempt can be acknowledged only once", {
            path: "cancellation.acknowledgements",
        });
    }
    for (const entry of cancellation.acknowledgements) {
        const attempt = attemptsById.get(entry.attemptId);
        if (!attempt) {
            fail("invalid_cancellation_acknowledgement", `${entry.attemptId} is unknown`, {
                path: "cancellation.acknowledgements",
            });
        }
        if (entry.disposition === "session-terminated"
            && entry.sessionId !== attempt.sessionId) {
            fail("invalid_cancellation_acknowledgement", `${entry.attemptId} session does not match`, {
                path: "cancellation.acknowledgements",
            });
        }
        if (entry.disposition === "no-session-created" && attempt.sessionId !== null) {
            fail("invalid_cancellation_acknowledgement", `${entry.attemptId} has an attached session`, {
                path: "cancellation.acknowledgements",
            });
        }
        if (Date.parse(entry.acknowledgedAt) < Date.parse(cancellation.requestedAt)) {
            fail("invalid_cancellation_acknowledgement", `${entry.attemptId} was acknowledged before cancellation`, {
                path: "cancellation.acknowledgements",
            });
        }
    }
    assertTimestamp(
        cancellation.verificationTerminatedAt,
        "cancellation.verificationTerminatedAt",
        { nullable: true },
    );
    if (cancellation.verificationDisposition !== null
        && !["run-terminated", "no-run-created"].includes(
            cancellation.verificationDisposition,
        )) {
        fail("invalid_cancellation_verification", "Verification disposition is invalid", {
            path: "cancellation.verificationDisposition",
        });
    }
    assertNullableString(cancellation.finalizedBy, "cancellation.finalizedBy", LIMITS.actor);
    assertTimestamp(cancellation.finalizedAt, "cancellation.finalizedAt", { nullable: true });
    if (cancellation.verificationRunId === null
        && cancellation.verificationTerminatedAt !== null) {
        fail(
            "invalid_cancellation_verification",
            "Verification termination time must match a snapshotted run",
            { path: "cancellation.verificationTerminatedAt" },
        );
    }
    if (cancellation.verificationRunId !== null
        && cancellation.verificationReservationId === null) {
        fail("invalid_cancellation_verification", "Verification run lacks its reservation", {
            path: "cancellation.verificationReservationId",
        });
    }
    if (cancellation.verificationReservationId === null
        && cancellation.verificationDisposition !== null) {
        fail("invalid_cancellation_verification", "Verification disposition lacks a reservation", {
            path: "cancellation.verificationDisposition",
        });
    }
    if ((cancellation.finalizedAt === null) !== (cancellation.finalizedBy === null)) {
        fail("invalid_cancellation_finalization", "Cancellation finalization actor and time must match", {
            path: "cancellation.finalizedAt",
        });
    }
    if (planStatus === PLAN_STATUS.CANCELLING) {
        if (cancellation.finalizedAt !== null) {
            fail("invalid_cancellation_finalization", "Cancelling plan cannot be finalized", {
                path: "cancellation.finalizedAt",
            });
        }
        if (cancellation.verificationDisposition !== null
			|| cancellation.finalizationOverride !== null
            || cancellation.verificationTerminatedAt !== null) {
            fail("invalid_cancellation_verification", "Cancelling plan cannot contain a final verification disposition", {
                path: "cancellation.verificationDisposition",
            });
        }
        if (cancellation.requiredAttemptIds.some(
            (id) => attemptsById.get(id)?.status !== ATTEMPT_STATUS.CANCEL_REQUESTED,
        )) {
            fail("invalid_cancellation_attempts", "Snapshotted attempts must await cancellation", {
                path: "cancellation.requiredAttemptIds",
            });
        }
    } else if (planStatus === PLAN_STATUS.CANCELLED) {
        if (cancellation.finalizedAt === null
            || cancellation.acknowledgements.length !== cancellation.requiredAttemptIds.length
            || (cancellation.verificationReservationId !== null
                && cancellation.verificationDisposition === null)
            || (cancellation.verificationRunId !== null
                && (cancellation.verificationTerminatedAt === null
                    || cancellation.verificationDisposition !== "run-terminated"))
            || (cancellation.verificationReservationId !== null
                && cancellation.verificationRunId === null
                && cancellation.verificationDisposition !== "no-run-created")) {
            fail("invalid_cancellation_finalization", "Cancelled plan lacks termination acknowledgements", {
                path: "cancellation",
            });
        }
        if (cancellation.requiredAttemptIds.some(
            (id) => attemptsById.get(id)?.status !== ATTEMPT_STATUS.CANCELLED,
        )) {
            fail("invalid_cancellation_attempts", "Finalized attempts must be cancelled", {
                path: "cancellation.requiredAttemptIds",
            });
        }
    } else {
        fail("unexpected_cancellation", `Plan status ${planStatus} cannot carry cancellation metadata`, {
            path: "cancellation",
        });
    }
}

/**
 * Validates optional persisted planning-run provenance.
 *
 * @param {any} planning
 * @returns {void}
 */
function validatePlanning(planning) {
    if (planning === null) {
        return;
    }
    assertPlainObject(planning, "planning");
    assertKnownKeys(planning, PLANNING_KEYS, "planning");
    assertString(planning.runId, "planning.runId", LIMITS.verificationRunId);
    if (typeof planning.inputDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(planning.inputDigest)) {
        fail("invalid_planning_digest", "planning.inputDigest must be a SHA-256 digest", {
            path: "planning.inputDigest",
        });
    }
}

/**
 * Validates the complete authoritative plan document and cross-object invariants.
 *
 * @param {any} plan
 * @returns {FoundryPlan}
 */
export function validatePlan(plan) {
    assertPlainObject(plan, "plan");
    assertKnownKeys(plan, PLAN_KEYS, "plan");

    if (plan.schemaVersion !== SCHEMA_VERSION) {
        fail("unsupported_schema_version", `schemaVersion must be ${SCHEMA_VERSION}`, {
            path: "schemaVersion",
            details: { value: plan.schemaVersion },
        });
    }
    if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
        fail("invalid_revision", "revision must be a positive safe integer", { path: "revision" });
    }
    assertPlanId(plan.id);
    assertString(plan.title, "title", LIMITS.planTitle);
    assertString(plan.objective, "objective", LIMITS.objective);
    assertStringArray(plan.constraints, "constraints", {
        maximum: LIMITS.constraints,
        itemMaximum: LIMITS.constraint,
    });
    if (!PLAN_STATUS_VALUES.has(plan.status)) {
        fail("invalid_plan_status", "status is not supported", {
            path: "status",
            details: { value: plan.status },
        });
    }

    assertPlainObject(plan.repository, "repository");
    assertKnownKeys(plan.repository, REPOSITORY_KEYS, "repository");
    assertString(plan.repository.workingDirectory, "repository.workingDirectory", LIMITS.repositoryPath);
    if (!path.isAbsolute(plan.repository.workingDirectory)) {
        fail("invalid_repository_path", "repository.workingDirectory must be absolute", {
            path: "repository.workingDirectory",
        });
    }
    assertString(plan.repository.baseBranch, "repository.baseBranch", LIMITS.baseBranch);
    validatePlanning(plan.planning);

    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        fail("invalid_tasks", "tasks must contain at least one task", { path: "tasks" });
    }
    if (plan.tasks.length > LIMITS.tasks) {
        fail("array_too_long", `tasks exceeds the ${LIMITS.tasks}-item limit`, {
            path: "tasks",
            details: { maximum: LIMITS.tasks, actual: plan.tasks.length },
        });
    }
    plan.tasks.forEach(validateTask);
    validateDependencyGraph(plan.tasks);
	validateTaskTopology(plan.tasks);
    const sessionIds = new Set();
    const reservationIds = new Set();
    for (const task of plan.tasks) {
        for (const attempt of task.attempts) {
            if (reservationIds.has(attempt.reservationId)) {
                fail("duplicate_request_id", `Reservation ${attempt.reservationId} is duplicated`, {
                    path: "tasks",
                    details: { reservationId: attempt.reservationId },
                });
            }
            reservationIds.add(attempt.reservationId);
            if (attempt.sessionId === null) continue;
            if (sessionIds.has(attempt.sessionId)) {
                fail("duplicate_session_id", `Session ${attempt.sessionId} is attached more than once`, {
                    path: "tasks",
                    details: { sessionId: attempt.sessionId },
                });
            }
            sessionIds.add(attempt.sessionId);
        }
    }
	/** @type {FoundryTask[]} */
	const tasks = plan.tasks;
    const byId = taskMap(tasks);
    for (let index = 0; index < tasks.length; index += 1) {
		const task = tasks[index];
        if (task.status === TASK_STATUS.READY
            || task.status === TASK_STATUS.RUNNING
            || task.status === TASK_STATUS.DONE) {
            const unmet = task.dependsOn.filter(
                (id) => byId.get(id)?.status !== TASK_STATUS.DONE,
            );
            if (unmet.length > 0) {
                fail("dependency_unmet", `Task ${task.id} advanced before its dependencies were done`, {
                    path: `tasks[${index}].status`,
                    details: { unmet },
                });
            }
        }
    }

    if ((plan.status === PLAN_STATUS.DRAFT || plan.status === PLAN_STATUS.AWAITING_APPROVAL)
        && plan.tasks.some((task) => task.status !== TASK_STATUS.PLANNED)) {
        fail("plan_not_approved", `Tasks cannot advance while the plan is ${plan.status}`, {
            path: "tasks",
        });
    }
    if (plan.tasks.some((task) => task.status === TASK_STATUS.READY)
        && plan.status !== PLAN_STATUS.APPROVED
        && plan.status !== PLAN_STATUS.RUNNING
        && plan.status !== PLAN_STATUS.CANCELLING) {
        fail("plan_not_approved", `Ready tasks are not valid while the plan is ${plan.status}`, {
            path: "tasks",
        });
    }
    if (plan.tasks.some((task) => task.status === TASK_STATUS.RUNNING)
        && plan.status !== PLAN_STATUS.RUNNING
        && plan.status !== PLAN_STATUS.CANCELLING) {
        fail("plan_not_running", `Running tasks are not valid while the plan is ${plan.status}`, {
            path: "tasks",
        });
    }

    assertPlainObject(plan.gates, "gates");
    assertKnownKeys(plan.gates, GATE_KEYS, "gates");
    assertTimestampPair(plan.gates.planApprovedAt, plan.gates.planApprovedBy, "gates.planApproved");
    assertTimestampPair(
        plan.gates.completionApprovedAt,
        plan.gates.completionApprovedBy,
        "gates.completionApproved",
    );

    const approvalRequired = new Set([
        PLAN_STATUS.APPROVED,
        PLAN_STATUS.RUNNING,
        PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
        PLAN_STATUS.COMPLETED,
        PLAN_STATUS.FAILED,
    ]);
    if (approvalRequired.has(plan.status) && plan.gates.planApprovedAt === null) {
        fail("missing_plan_approval", `Plan status ${plan.status} requires recorded plan approval`, {
            path: "gates.planApprovedAt",
        });
    }
    if ((plan.status === PLAN_STATUS.DRAFT || plan.status === PLAN_STATUS.AWAITING_APPROVAL)
        && plan.gates.planApprovedAt !== null) {
        fail("premature_plan_approval", `Plan status ${plan.status} cannot carry plan approval`, {
            path: "gates.planApprovedAt",
        });
    }
    if (plan.status === PLAN_STATUS.COMPLETED && plan.gates.completionApprovedAt === null) {
        fail("missing_completion_approval", "A completed plan requires explicit completion approval", {
            path: "gates.completionApprovedAt",
        });
    }
    if (plan.status !== PLAN_STATUS.COMPLETED && plan.gates.completionApprovedAt !== null) {
        fail("premature_completion_approval", "Completion approval is only valid on a completed plan", {
            path: "gates.completionApprovedAt",
        });
    }

    const verificationStates = new Set([
        PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
        PLAN_STATUS.COMPLETED,
    ]);
    if (verificationStates.has(plan.status)
        && plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
        fail("implementation_incomplete", `Plan status ${plan.status} requires every task to be done`, {
            path: "tasks",
        });
    }

    validateVerification(plan.verification);
    if (plan.verification.reservationId !== null
        && reservationIds.has(plan.verification.reservationId)) {
        fail(
            "duplicate_request_id",
            `Reservation ${plan.verification.reservationId} is duplicated`,
            {
                path: "verification.reservationId",
                details: { reservationId: plan.verification.reservationId },
            },
        );
    }
    const canonicalEvidence = new Map(plan.tasks.flatMap(
        (task) => task.attempts.flatMap(
            (attempt) => attempt.evidence.map((entry) => [entry.id, entry]),
        ),
    ));
    if (plan.verification.evidence.some(
        (id) => canonicalEvidence.get(id)?.outcome !== EVIDENCE_OUTCOME.PASSED,
    )) {
        fail("invalid_verification_evidence", "Verification references unknown evidence", {
            path: "verification.evidence",
        });
    }
    const correctionIds = new Set(plan.verification.correctionTaskIds);
    if (correctionIds.size !== plan.verification.correctionTaskIds.length
        || plan.verification.correctionTaskIds.some((id) => !byId.has(id))) {
        fail("invalid_correction_tasks", "Verification correctionTaskIds must identify unique plan tasks", {
            path: "verification.correctionTaskIds",
        });
    }
    const preVerificationStates = new Set([
        PLAN_STATUS.DRAFT,
        PLAN_STATUS.AWAITING_APPROVAL,
        PLAN_STATUS.APPROVED,
    ]);
    if (preVerificationStates.has(plan.status)
        && plan.verification.status !== VERIFICATION_STATUS.NOT_STARTED) {
        fail("invalid_verification_state", `Verification cannot be ${plan.verification.status} while the plan is ${plan.status}`, {
            path: "verification.status",
        });
    }
    if (plan.status === PLAN_STATUS.RUNNING
        && plan.verification.status !== VERIFICATION_STATUS.NOT_STARTED
        && plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
        fail("invalid_verification_state", `Verification cannot be ${plan.verification.status} while the plan is running`, {
            path: "verification.status",
        });
    }
    if (plan.verification.status === VERIFICATION_STATUS.RESERVED
        && plan.status !== PLAN_STATUS.RUNNING
        && plan.status !== PLAN_STATUS.CANCELLING) {
        fail("invalid_verification_state", "Reserved verification requires running or cancelling plan status", {
            path: "verification.status",
        });
    }
    if (plan.verification.status === VERIFICATION_STATUS.RESERVED
        && plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
        fail("implementation_incomplete", "Reserved verification requires every task to be done", {
            path: "tasks",
        });
    }
    if ((plan.status === PLAN_STATUS.AWAITING_COMPLETION_APPROVAL
        || plan.status === PLAN_STATUS.COMPLETED)
        && plan.verification.status !== VERIFICATION_STATUS.PASSED) {
        fail("verification_not_passed", `Plan status ${plan.status} requires passed verification`, {
            path: "verification.status",
        });
    }
    if (plan.verification.status === VERIFICATION_STATUS.FAILED
        && plan.status !== PLAN_STATUS.FAILED
        && plan.status !== PLAN_STATUS.CANCELLED) {
		fail("invalid_verification_state", "Failed verification requires a failed or cancelled plan", {
            path: "verification.status",
        });
    }
	validateCancellation(plan.cancellation, plan.status, plan.tasks);
    if (plan.status === PLAN_STATUS.CANCELLING
        && plan.cancellation.verificationReservationId !== null
        && plan.cancellation.verificationReservationId !== plan.verification.reservationId) {
        fail("invalid_cancellation_verification", "Cancellation reservation does not match verification", {
            path: "cancellation.verificationReservationId",
        });
    }
    if (plan.status === PLAN_STATUS.CANCELLING
        && plan.tasks.some((task) => {
            const active = activeTaskAttempt(task);
            return active !== null && active.status !== ATTEMPT_STATUS.CANCEL_REQUESTED;
        })) {
        fail("invalid_cancellation_state", "Every active task must have cancellation requested", {
            path: "tasks",
        });
    }
    if (plan.status === PLAN_STATUS.CANCELLED
        && plan.tasks.some((task) => task.status !== TASK_STATUS.DONE
            && task.status !== TASK_STATUS.CANCELLED)) {
        fail("invalid_cancellation_state", "Cancelled plans can retain only done or cancelled tasks", {
            path: "tasks",
        });
    }

    if (plan.telemetry !== undefined
        && (!Array.isArray(plan.telemetry) || plan.telemetry.length > LIMITS.telemetry)) {
        fail("invalid_telemetry", `telemetry must contain at most ${LIMITS.telemetry} events`, {
            path: "telemetry",
        });
    }
    (plan.telemetry ?? []).forEach((event, index) => {
        const fieldPath = `telemetry[${index}]`;
        assertPlainObject(event, fieldPath);
        assertKnownKeys(event, TELEMETRY_KEYS, fieldPath);
        assertString(event.event, `${fieldPath}.event`, LIMITS.telemetryEvent);
        assertTimestamp(event.at, `${fieldPath}.at`);
    });

    assertTimestamp(plan.createdAt, "createdAt");
    assertTimestamp(plan.updatedAt, "updatedAt");
    if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
        fail("invalid_plan_timestamps", "updatedAt precedes createdAt", { path: "updatedAt" });
    }
    return plan;
}

/**
 * Creates a revision-one draft from a validated planning blueprint.
 *
 * @param {any} input
 * @param {{now?: Date|string|number|(() => Date|string|number)}} [options]
 * @returns {FoundryPlan}
 */
export function createDraftPlan(input, options = {}) {
    assertPlainObject(input, "input");
    assertKnownKeys(input, DRAFT_INPUT_KEYS, "input");
    if (!Array.isArray(input.tasks)) {
        fail("invalid_tasks", "input.tasks must be an array", { path: "input.tasks" });
    }

    const timestamp = nowIso(options.now);
    const plan = {
        schemaVersion: SCHEMA_VERSION,
        revision: 1,
        id: input.id,
        title: input.title,
        objective: input.objective,
        constraints: clone(input.constraints ?? []),
        status: PLAN_STATUS.DRAFT,
        repository: clone(input.repository),
        planning: clone(input.planning ?? null),
        tasks: input.tasks.map((task, index) => {
            assertPlainObject(task, `input.tasks[${index}]`);
            assertKnownKeys(task, DRAFT_TASK_KEYS, `input.tasks[${index}]`);
            return {
                id: task.id,
                title: task.title,
				kind: task.kind,
                description: task.description,
                dependsOn: clone(task.dependsOn ?? []),
                status: TASK_STATUS.PLANNED,
                acceptanceCriteria: clone(task.acceptanceCriteria ?? []),
                expectedFiles: clone(task.expectedFiles ?? []),
				deliveryRequirement: task.deliveryRequirement,
                attempts: [],
            };
        }),
        gates: {
            planApprovedAt: null,
            planApprovedBy: null,
            completionApprovedAt: null,
            completionApprovedBy: null,
        },
        verification: emptyVerification(),
        cancellation: null,
        telemetry: [{
            event: "plan-created",
            at: timestamp,
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    validatePlan(plan);
    return plan;
}

/**
 * Applies a non-specialized top-level plan transition.
 *
 * Cancellation, verification reservation, and correction retry use dedicated
 * functions because they update multiple coupled sub-states.
 *
 * @param {FoundryPlan} plan
 * @param {string} nextStatus
 * @param {{actor?: string, at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function transitionPlan(plan, nextStatus, options = {}) {
    validatePlan(plan);
    if (!PLAN_STATUS_VALUES.has(nextStatus)) {
        fail("invalid_plan_status", `Unknown target plan status ${String(nextStatus)}`, {
            path: "status",
        });
    }
    if (nextStatus === PLAN_STATUS.CANCELLING || nextStatus === PLAN_STATUS.CANCELLED) {
        fail("specialized_transition_required", "Cancellation must use the cancellation workflow", {
            path: "status",
        });
    }
    const allowed = PLAN_TRANSITIONS[plan.status];
    if (!allowed.has(nextStatus)) {
        fail("invalid_plan_transition", `Cannot move plan from ${plan.status} to ${nextStatus}`, {
            path: "status",
            details: { from: plan.status, to: nextStatus },
        });
    }
    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    candidate.status = nextStatus;
    candidate.updatedAt = timestamp;

    if (nextStatus === PLAN_STATUS.APPROVED) {
        requireActor(options.actor, "actor");
        candidate.gates.planApprovedAt = timestamp;
        candidate.gates.planApprovedBy = options.actor;
    }
    if (nextStatus === PLAN_STATUS.COMPLETED) {
        requireActor(options.actor, "actor");
        candidate.gates.completionApprovedAt = timestamp;
        candidate.gates.completionApprovedBy = options.actor;
    }

    validatePlan(candidate);
    return candidate;
}

/**
 * Persists a verification launch reservation before the Factory is invoked.
 *
 * @param {FoundryPlan} plan
 * @param {any} [options]
 * @returns {FoundryPlan}
 */
export function reserveVerification(plan, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.RUNNING) {
        fail("invalid_plan_transition", `Verification cannot be reserved from ${plan.status}`, {
            path: "status",
        });
    }
    if (plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
        fail("implementation_incomplete", "Verification cannot be reserved until every task is done", {
            path: "tasks",
        });
    }
    assertRequestId(options.reservationId, "reservationId");
    if (typeof options.inputDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(options.inputDigest)) {
        fail("invalid_verification_digest", "inputDigest must be a SHA-256 digest", {
            path: "inputDigest",
        });
    }
    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    candidate.status = PLAN_STATUS.RUNNING;
    candidate.verification = {
        status: VERIFICATION_STATUS.RESERVED,
        reservationId: options.reservationId,
        runId: null,
        inputDigest: options.inputDigest,
        summary: null,
        evidence: [],
        missingEvidence: [],
        correctionTaskIds: [],
		replacement: options.replacement
			? {
				supersededReservationId: options.replacement.supersededReservationId,
				supersededRunId: options.replacement.supersededRunId ?? null,
				reason: options.replacement.reason,
				requestedBy: options.replacement.requestedBy,
				at: timestamp,
			}
			: null,
        reservedAt: timestamp,
        completedAt: null,
    };
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Records an imported, evidence-validated verification result.
 *
 * @param {FoundryPlan} plan
 * @param {{passed: boolean, summary: string, evidence: string[], missingEvidence: string[], correctionTaskIds: string[]}} result
 * @param {any} [options]
 * @returns {FoundryPlan}
 */
export function completeVerification(plan, result, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.RUNNING
		|| plan.verification.status !== VERIFICATION_STATUS.RESERVED) {
		fail("verification_not_reserved", "Verification can only complete from a reservation", {
            path: "verification.status",
        });
    }
    assertString(options.runId, "runId", LIMITS.verificationRunId);
    assertPlainObject(result, "result");
    assertString(result.summary, "result.summary", LIMITS.resultSummary);
    assertStringArray(result.evidence, "result.evidence", {
		maximum: LIMITS.verificationEvidence,
        itemMaximum: LIMITS.evidenceItem,
    });
    assertStringArray(result.missingEvidence, "result.missingEvidence", {
        maximum: LIMITS.missingEvidence,
        itemMaximum: LIMITS.missingEvidenceItem,
    });
    assertStringArray(result.correctionTaskIds, "result.correctionTaskIds", {
        maximum: LIMITS.tasks,
        itemMaximum: 5,
    });
    if (typeof result.passed !== "boolean") {
        fail("invalid_verification_result", "result.passed must be a boolean", {
            path: "result.passed",
        });
    }
    if (result.passed && (result.evidence.length === 0 || result.missingEvidence.length > 0)) {
        fail("invalid_verification_result", "Passed verification requires evidence and no missing evidence", {
            path: "result",
        });
    }
    if (result.passed && result.correctionTaskIds.length > 0) {
        fail("invalid_verification_result", "Passed verification cannot request corrections", {
            path: "result.correctionTaskIds",
        });
    }
    const taskIds = new Set(plan.tasks.map((task) => task.id));
    if (new Set(result.correctionTaskIds).size !== result.correctionTaskIds.length
        || result.correctionTaskIds.some((id) => !taskIds.has(id))) {
        fail("invalid_verification_result", "Correction task IDs must identify unique plan tasks", {
            path: "result.correctionTaskIds",
        });
    }
    if (!result.passed
        && (result.missingEvidence.length === 0 || result.correctionTaskIds.length === 0)) {
        fail("invalid_verification_result", "Failed verification requires missing evidence", {
            path: "result.missingEvidence",
        });
    }

    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    candidate.verification = {
        status: result.passed ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
        reservationId: candidate.verification.reservationId,
        runId: options.runId,
        inputDigest: candidate.verification.inputDigest,
        summary: result.summary,
        evidence: clone(result.evidence),
        missingEvidence: clone(result.missingEvidence),
        correctionTaskIds: clone(result.correctionTaskIds),
		replacement: candidate.verification.replacement,
        reservedAt: candidate.verification.reservedAt,
        completedAt: timestamp,
    };
    candidate.status = result.passed
		? PLAN_STATUS.AWAITING_COMPLETION_APPROVAL
		: PLAN_STATUS.FAILED;
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Recomputes planned-versus-ready task state from completed dependencies.
 *
 * @param {FoundryPlan} plan
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function reconcileTaskReadiness(plan, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_approved", `Cannot resolve ready tasks while the plan is ${plan.status}`, {
            path: "status",
        });
    }
    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    const byId = taskMap(candidate.tasks);
    let changed = false;

    for (const task of candidate.tasks) {
        if (task.status !== TASK_STATUS.PLANNED && task.status !== TASK_STATUS.READY) {
            continue;
        }
        const dependencies = task.dependsOn.map((id) => {
            const dependency = byId.get(id);
            if (!dependency) {
                fail("unknown_dependency", `Task ${task.id} depends on unknown task ${id}`, {
                    path: "dependsOn",
                });
            }
            return dependency;
        });
        const ready = dependencies.every((dependency) => dependency.status === TASK_STATUS.DONE);
        if (task.status === TASK_STATUS.PLANNED && ready) {
            task.status = TASK_STATUS.READY;
            changed = true;
        }
    }

    if (changed) {
        candidate.updatedAt = timestamp;
    }
    validatePlan(candidate);
    return candidate;
}

/**
 * Records initial plan approval and resolves dependency-ready tasks.
 *
 * @param {FoundryPlan} plan
 * @param {string} actor
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function approvePlan(plan, actor, options = {}) {
    const approved = transitionPlan(plan, PLAN_STATUS.APPROVED, {
        actor,
        at: options.at,
    });
    return reconcileTaskReadiness(approved, { at: options.at });
}

/**
 * Finds a task or throws a typed domain error.
 *
 * @param {FoundryPlan} candidate
 * @param {string} taskId
 * @returns {FoundryTask}
 */
function findTask(candidate, taskId) {
    const task = candidate.tasks.find((item) => item.id === taskId);
    if (!task) {
        fail("task_not_found", `Task ${taskId} does not exist`, {
            path: "taskId",
            details: { taskId },
        });
    }
    return task;
}

/**
 * Finds an attempt within its owning task or fails closed.
 *
 * @param {FoundryTask} task
 * @param {string} attemptId
 * @returns {FoundryAttempt}
 */
function findAttempt(task, attemptId) {
    const attempt = task.attempts.find((item) => item.id === attemptId);
    if (!attempt) {
        fail("attempt_not_found", `Attempt ${attemptId} does not exist on ${task.id}`, {
            path: "attemptId",
            details: { taskId: task.id, attemptId },
        });
    }
    return attempt;
}

/**
 * Requires every declared dependency to be successfully done.
 *
 * @param {FoundryPlan} plan
 * @param {FoundryTask} task
 * @returns {void}
 */
function assertTaskDependenciesDone(plan, task) {
    const byId = taskMap(plan.tasks);
    const unmet = task.dependsOn.filter(
        (id) => byId.get(id)?.status !== TASK_STATUS.DONE,
    );
    if (unmet.length > 0) {
        fail("dependency_unmet", `Task ${task.id} has unfinished dependencies`, {
            path: "taskId",
            details: { unmet },
        });
    }
}

/**
 * Derives the deterministic App base branch and additional integration work.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @returns {any}
 */
export function taskLaunchGuidance(plan, taskId) {
    validatePlan(plan);
    const task = findTask(plan, taskId);
    assertTaskDependenciesDone(plan, task);
    const byId = taskMap(plan.tasks);
    const dependencies = task.dependsOn
        .map((id) => {
            const dependency = byId.get(id);
            if (!dependency) {
                fail("unknown_dependency", `Task ${task.id} depends on unknown task ${id}`, {
                    path: "dependsOn",
                });
            }
            const attempt = latestSuccessfulAttempt(dependency);
            if (!attempt) {
                fail("dependency_delivery_missing", `Task ${id} has no successful delivery`, {
                    path: "taskId",
                    details: { taskId, dependencyId: id },
                });
            }
            return {
                taskId: id,
                attemptId: attempt.id,
                branch: attempt.branch,
                commit: attempt.commit,
                prUrl: attempt.prUrl,
            };
        })
        .sort((left, right) => left.taskId.localeCompare(right.taskId));
    const baseDelivery = dependencies.find((dependency) => dependency.branch !== null) ?? null;
    const baseBranch = baseDelivery?.branch ?? plan.repository.baseBranch;
    const integrationRequired = dependencies.filter(
        (dependency) => dependency.branch !== baseBranch,
    );
    return {
        baseBranch,
        dependencies: clone(dependencies),
        integrationRequired: clone(integrationRequired),
    };
}

/**
 * Appends a durable task attempt before the external `create_session` call.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {any} [options]
 * @returns {FoundryPlan}
 */
export function reserveTaskAttempt(plan, taskId, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_running", `Task ${taskId} cannot be reserved while the plan is ${plan.status}`, {
            path: "status",
        });
    }
    assertRequestId(options.reservationId, "reservationId");
    validateScopeOverride(options.scopeOverride ?? null, "scopeOverride");
    const candidate = clone(plan);
    const task = findTask(candidate, taskId);
    if (task.status !== TASK_STATUS.READY) {
        fail("invalid_task_transition", `Cannot reserve task ${task.id} from ${task.status}`, {
            path: "taskId",
            details: { taskId, status: task.status },
        });
    }
    if (task.attempts.length >= LIMITS.attempts) {
        fail("attempt_limit_reached", `Task ${task.id} reached the attempt limit`, {
            path: "taskId",
            details: { maximum: LIMITS.attempts },
        });
    }
    if (candidate.tasks.some((item) => item.attempts.some(
        (attempt) => attempt.reservationId === options.reservationId,
    ))) {
        fail("duplicate_request_id", `Reservation ${options.reservationId} already exists`, {
            path: "reservationId",
        });
    }
    const guidance = taskLaunchGuidance(plan, taskId);
    const timestamp = nowIso(options.at);
    task.attempts.push({
        id: expectedAttemptId(task.id, task.attempts.length),
        reservationId: options.reservationId,
        status: ATTEMPT_STATUS.RESERVED,
        baseBranch: guidance.baseBranch,
        integrationRequired: guidance.integrationRequired,
        scopeOverride: clone(options.scopeOverride ?? null),
        sessionId: null,
        branch: null,
        commit: null,
        prUrl: null,
        resultSummary: null,
        evidence: [],
        error: null,
        reservedAt: timestamp,
        startedAt: null,
		sessionTerminatedAt: null,
        cancelRequestedAt: null,
        completedAt: null,
    });
    task.status = TASK_STATUS.RUNNING;
    if (candidate.status === PLAN_STATUS.APPROVED) {
        candidate.status = PLAN_STATUS.RUNNING;
    }
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Attaches one App child-session identity to a reserved attempt.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {string} attemptId
 * @param {any} [options]
 * @returns {FoundryPlan}
 */
export function attachTaskAttempt(plan, taskId, attemptId, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.RUNNING && plan.status !== PLAN_STATUS.CANCELLING) {
        fail("plan_not_running", `Attempt ${attemptId} cannot attach while the plan is ${plan.status}`, {
            path: "status",
        });
    }
    assertString(options.sessionId, "sessionId", LIMITS.sessionId);
    if (options.branch !== undefined && options.branch !== null) {
        assertString(options.branch, "branch", LIMITS.branch);
    }
    const candidate = clone(plan);
    const task = findTask(candidate, taskId);
    const attempt = findAttempt(task, attemptId);
    if (attempt.sessionId !== null) {
        if (attempt.sessionId === options.sessionId
            && attempt.branch === (options.branch ?? null)) {
            return candidate;
        }
        fail("attempt_already_attached", `Attempt ${attemptId} is already attached`, {
            path: "attemptId",
        });
    }
    if (attempt.status !== ATTEMPT_STATUS.RESERVED
        && attempt.status !== ATTEMPT_STATUS.CANCEL_REQUESTED) {
        fail("invalid_attempt_transition", `Attempt ${attemptId} cannot attach from ${attempt.status}`, {
            path: "attemptId",
        });
    }
    if (plan.status === PLAN_STATUS.CANCELLING
        && !plan.cancellation.requiredAttemptIds.includes(attemptId)) {
        fail("invalid_cancellation_attempt", `Attempt ${attemptId} was not active when cancellation began`, {
            path: "attemptId",
        });
    }
    const duplicate = candidate.tasks.some((item) => item.attempts.some(
        (other) => other.id !== attemptId && other.sessionId === options.sessionId,
    ));
    if (duplicate) {
        fail("duplicate_session_id", `Session ${options.sessionId} is already attached`, {
            path: "sessionId",
        });
    }
    const timestamp = nowIso(options.at);
    attempt.sessionId = options.sessionId;
    attempt.branch = options.branch ?? null;
    attempt.startedAt = timestamp;
    if (attempt.status === ATTEMPT_STATUS.RESERVED) {
        attempt.status = ATTEMPT_STATUS.RUNNING;
    }
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Assigns canonical IDs, check identities, and task-kind provenance.
 *
 * @param {any} value
 * @param {FoundryPlan} plan
 * @param {FoundryTask} task
 * @param {FoundryAttempt} attempt
 * @param {string} status
 * @param {string} [fieldPath]
 * @returns {FoundryEvidence[]}
 */
function normalizeEvidence(value, plan, task, attempt, status, fieldPath = "evidence") {
    if (!Array.isArray(value) || value.length > LIMITS.evidence) {
        fail("invalid_evidence", `${fieldPath} must contain at most ${LIMITS.evidence} entries`, {
            path: fieldPath,
        });
    }
    const producer = attempt.sessionId ?? "coordinator";
	const parsed = value.map((entry, index) => {
        const entryPath = `${fieldPath}[${index}]`;
        assertPlainObject(entry, entryPath);
        assertKnownKeys(entry, EVIDENCE_INPUT_KEYS, entryPath);
        if (!EVIDENCE_TYPE_VALUES.has(entry.type)) {
            fail("invalid_evidence_type", `${entryPath}.type is not supported`, {
                path: `${entryPath}.type`,
            });
        }
        assertString(entry.summary, `${entryPath}.summary`, LIMITS.evidenceItem);
        const source = entry.source ?? null;
        assertNullableString(source, `${entryPath}.source`, LIMITS.evidenceSource);
        const outcome = entry.outcome ?? EVIDENCE_OUTCOME.INFORMATIONAL;
        if (!EVIDENCE_OUTCOME_VALUES.has(outcome)) {
            fail("invalid_evidence_outcome", `${entryPath}.outcome is not supported`, {
                path: `${entryPath}.outcome`,
            });
        }
        if ([EVIDENCE_TYPE.COMMAND, EVIDENCE_TYPE.TEST, EVIDENCE_TYPE.INTEGRATION].includes(entry.type)
            && outcome === EVIDENCE_OUTCOME.INFORMATIONAL) {
            fail("invalid_evidence_outcome", `${entryPath}.outcome must record pass or failure`, {
                path: `${entryPath}.outcome`,
            });
        }
		/** @type {"claimed"|"independent-claim"} */
		const trust = task.kind === "verify" ? "independent-claim" : "claimed";
        return {
            type: entry.type,
            summary: entry.summary,
            source,
            outcome,
            producer,
			checkId: entry.checkId ?? null,
			trust,
        };
    });
	if (task.kind !== "verify") {
		if (parsed.some((entry) => entry.checkId !== null)) {
			fail("invalid_evidence_check", "Implementation evidence cannot set checkId", {
				path: fieldPath,
			});
		}
		return parsed.map((entry, index) => ({
			id: expectedEvidenceId(attempt.id, index),
			...entry,
		}));
	}
	const expectedChecks = verificationCheckIds(plan.tasks);
	const byCheck = new Map();
	for (const entry of parsed) {
		if (typeof entry.checkId !== "string"
			|| !expectedChecks.includes(entry.checkId)
			|| byCheck.has(entry.checkId)) {
			fail("invalid_evidence_check", "Verifier evidence has an unknown or duplicate checkId", {
				path: fieldPath,
				details: { checkId: entry.checkId },
			});
		}
		byCheck.set(entry.checkId, entry);
	}
	if (status === ATTEMPT_STATUS.DONE && byCheck.size !== expectedChecks.length) {
		fail("invalid_evidence_check", "Verifier evidence must cover every canonical check", {
			path: fieldPath,
			details: {
				missingCheckIds: expectedChecks.filter((checkId) => !byCheck.has(checkId)),
			},
		});
	}
	return expectedChecks
		.filter((checkId) => byCheck.has(checkId))
		.map((checkId, index) => ({
			id: expectedEvidenceId(attempt.id, index),
			...byCheck.get(checkId),
		}));
}

/**
 * Records the terminal outcome of the currently active attempt.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {string} attemptId
 * @param {string} status
 * @param {any} [options]
 * @returns {FoundryPlan}
 */
export function completeTaskAttempt(plan, taskId, attemptId, status, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_running", `Attempt ${attemptId} cannot complete while the plan is ${plan.status}`, {
            path: "status",
        });
    }
    if (!TERMINAL_ATTEMPT_RESULTS.has(status)) {
        fail("invalid_attempt_status", `Attempt result ${status} is not supported`, {
            path: "status",
        });
    }
    const candidate = clone(plan);
    const task = findTask(candidate, taskId);
    const attempt = findAttempt(task, attemptId);
    if (task.status !== TASK_STATUS.RUNNING || activeTaskAttempt(task)?.id !== attemptId) {
        fail("stale_attempt", `Attempt ${attemptId} is not active for ${taskId}`, {
            path: "attemptId",
        });
    }
    if (attempt.status !== ATTEMPT_STATUS.RESERVED
        && attempt.status !== ATTEMPT_STATUS.RUNNING) {
        fail("invalid_attempt_transition", `Attempt ${attemptId} cannot finish from ${attempt.status}`, {
            path: "attemptId",
        });
    }
    if (status === ATTEMPT_STATUS.DONE && attempt.status !== ATTEMPT_STATUS.RUNNING) {
        fail("attempt_not_attached", `Attempt ${attemptId} must attach a session before success`, {
            path: "attemptId",
        });
    }
    if (options.branch !== undefined && options.branch !== null) {
        assertString(options.branch, "branch", LIMITS.branch);
        if (attempt.branch !== null && attempt.branch !== options.branch) {
            fail("branch_mismatch", `Attempt ${attemptId} is attached to ${attempt.branch}`, {
                path: "branch",
            });
        }
        attempt.branch ??= options.branch;
    }
    assertCommit(options.commit ?? null, "commit");
    assertHttpUrl(options.prUrl ?? null, "prUrl");
	if (options.sessionTerminatedAt !== undefined
		&& options.sessionTerminatedAt !== null) {
		assertTimestamp(options.sessionTerminatedAt, "sessionTerminatedAt");
	}
    const timestamp = nowIso(options.at);
    attempt.status = status;
    attempt.commit = options.commit ?? null;
    attempt.prUrl = options.prUrl ?? null;
    attempt.resultSummary = options.resultSummary ?? null;
	attempt.evidence = normalizeEvidence(
		options.evidence ?? [],
		candidate,
		task,
		attempt,
		status,
	);
    attempt.error = options.error ?? null;
	attempt.sessionTerminatedAt = options.sessionTerminatedAt ?? null;
    attempt.completedAt = timestamp;
    task.status = status;
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Returns failed or blocked work to ready without deleting attempt history.
 *
 * @param {FoundryPlan} plan
 * @param {string} taskId
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function retryTask(plan, taskId, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_running", `Task ${taskId} cannot retry while the plan is ${plan.status}`, {
            path: "status",
        });
    }
    const candidate = clone(plan);
    const task = findTask(candidate, taskId);
    if (task.status !== TASK_STATUS.BLOCKED && task.status !== TASK_STATUS.FAILED) {
        fail("invalid_task_transition", `Task ${taskId} cannot retry from ${task.status}`, {
            path: "taskId",
        });
    }
    assertTaskDependenciesDone(candidate, task);
    task.status = TASK_STATUS.READY;
    candidate.updatedAt = nowIso(options.at);
    validatePlan(candidate);
    return candidate;
}

/**
 * Requests cancellation and snapshots active external work without claiming it stopped.
 *
 * @param {FoundryPlan} plan
 * @param {any} options
 * @returns {FoundryPlan}
 */
export function requestPlanCancellation(plan, options = {}) {
    validatePlan(plan);
    if (!PLAN_TRANSITIONS[plan.status]?.has(PLAN_STATUS.CANCELLING)) {
        fail("invalid_plan_transition", `Cannot cancel a plan in ${plan.status}`, {
            path: "status",
        });
    }
    assertRequestId(options.requestId, "requestId");
    assertString(options.reason, "reason", LIMITS.error);
    requireActor(options.requestedBy, "requestedBy");
    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    const requiredAttemptIds = [];
    for (const task of candidate.tasks) {
        const attempt = activeTaskAttempt(task);
        if (!attempt) continue;
        requiredAttemptIds.push(attempt.id);
        attempt.status = ATTEMPT_STATUS.CANCEL_REQUESTED;
        attempt.cancelRequestedAt = timestamp;
        attempt.error = options.reason;
    }
    const verificationReserved =
		candidate.verification.status === VERIFICATION_STATUS.RESERVED;
    if (options.verificationRunId != null) {
		assertString(
			options.verificationRunId,
			"verificationRunId",
			LIMITS.verificationRunId,
		);
		if (!verificationReserved) {
			fail(
				"invalid_cancellation_verification",
				"A verification run requires an active reservation",
				{ path: "verificationRunId" },
			);
		}
    }
    candidate.status = PLAN_STATUS.CANCELLING;
    candidate.cancellation = {
        requestId: options.requestId,
        reason: options.reason,
        requestedBy: options.requestedBy,
        requestedAt: timestamp,
        requiredAttemptIds,
		verificationReservationId: verificationReserved
            ? candidate.verification.reservationId
            : null,
		verificationRunId: verificationReserved
			? options.verificationRunId ?? null
            : null,
        acknowledgements: [],
        verificationDisposition: null,
		finalizationOverride: null,
        verificationTerminatedAt: null,
        finalizedBy: null,
        finalizedAt: null,
    };
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Durably binds the verification run discovered after cancellation began.
 *
 * @param {FoundryPlan} plan
 * @param {string} runId
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function bindCancellationVerificationRun(plan, runId, options = {}) {
	validatePlan(plan);
	if (plan.status !== PLAN_STATUS.CANCELLING || plan.cancellation === null) {
		fail(
			"invalid_plan_transition",
			`Cannot bind a cancellation run while the plan is ${plan.status}`,
			{ path: "status" },
		);
	}
	if (plan.cancellation.verificationReservationId === null) {
		fail(
			"invalid_cancellation_verification",
			"Cancellation has no verification reservation to bind",
			{ path: "cancellation.verificationReservationId" },
		);
	}
	assertString(runId, "runId", LIMITS.verificationRunId);
	if (plan.cancellation.verificationRunId !== null) {
		if (plan.cancellation.verificationRunId === runId) return clone(plan);
		fail(
			"invalid_cancellation_verification",
			"Cancellation is already bound to another verification run",
			{ path: "cancellation.verificationRunId" },
		);
	}
	const candidate = clone(plan);
	candidate.cancellation.verificationRunId = runId;
	candidate.updatedAt = nowIso(options.at);
	validatePlan(candidate);
	return candidate;
}

/**
 * Finalizes cancellation after exact task and verification dispositions exist.
 *
 * @param {FoundryPlan} plan
 * @param {any[]} dispositions
 * @param {any} options
 * @returns {FoundryPlan}
 */
export function finalizePlanCancellation(plan, dispositions, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.CANCELLING) {
        fail("invalid_plan_transition", `Cannot finalize cancellation from ${plan.status}`, {
            path: "status",
        });
    }
    requireActor(options.finalizedBy, "finalizedBy");
    if (!Array.isArray(dispositions)) {
        fail("invalid_cancellation_dispositions", "dispositions must be an array", {
            path: "dispositions",
        });
    }
    const byAttemptId = new Map();
    for (let index = 0; index < dispositions.length; index += 1) {
        const entry = dispositions[index];
        const fieldPath = `dispositions[${index}]`;
        assertPlainObject(entry, fieldPath);
        assertKnownKeys(entry, new Set(["attemptId", "disposition", "sessionId"]), fieldPath);
        if (byAttemptId.has(entry.attemptId)) {
            fail("duplicate_cancellation_disposition", `Attempt ${entry.attemptId} is repeated`, {
                path: `${fieldPath}.attemptId`,
            });
        }
        byAttemptId.set(entry.attemptId, entry);
    }
    const required = plan.cancellation.requiredAttemptIds;
    if (byAttemptId.size !== required.length
        || required.some((attemptId) => !byAttemptId.has(attemptId))) {
        fail("cancellation_incomplete", "Every active attempt needs one termination disposition", {
            path: "dispositions",
            details: { requiredAttemptIds: required },
        });
    }
    const verificationRunId =
		options.verificationRunId ?? plan.cancellation.verificationRunId;
    if (plan.cancellation.verificationRunId !== null
		&& verificationRunId !== plan.cancellation.verificationRunId) {
		fail("invalid_cancellation_verification", "Verification run identity changed", {
			path: "verificationRunId",
		});
    }
    if (plan.cancellation.verificationReservationId === null) {
		if (verificationRunId !== null) {
			fail("invalid_cancellation_verification", "No verification launch was reserved", {
				path: "verificationRunId",
			});
		}
        if (options.verificationDisposition !== undefined
            && options.verificationDisposition !== null) {
            fail("invalid_cancellation_verification", "No verification launch was reserved", {
                path: "verificationDisposition",
            });
        }
    } else if (verificationRunId === null) {
        if (options.verificationDisposition !== "no-run-created") {
            fail("cancellation_incomplete", "The reserved verification launch needs a no-run-created disposition", {
                path: "verificationDisposition",
            });
        }
    } else if (options.verificationDisposition !== "run-terminated"
		|| (options.verificationTerminated !== true && !options.finalizationOverride)) {
		fail("cancellation_incomplete", "The bound Factory run is not confirmed terminal", {
            path: "verificationDisposition",
			details: { runId: verificationRunId },
        });
    }
    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    candidate.cancellation.verificationRunId = verificationRunId;
    const acknowledgements = [];
    for (const attemptId of required) {
        const task = candidate.tasks.find(
            (item) => item.attempts.some((attempt) => attempt.id === attemptId),
        );
		if (!task) {
            fail("cancellation_incomplete", `Attempt ${attemptId} has no owning task`, {
                path: "dispositions",
            });
        }
		const attempt = findAttempt(task, attemptId);
        const disposition = byAttemptId.get(attemptId);
        if (!disposition) {
            fail("cancellation_incomplete", `Attempt ${attemptId} has no disposition`, {
                path: "dispositions",
            });
        }
        if (attempt.sessionId === null) {
            if (disposition.disposition !== "no-session-created"
                || (disposition.sessionId ?? null) !== null) {
                fail("invalid_cancellation_disposition", `${attemptId} has no attached session`, {
                    path: "dispositions",
                });
            }
        } else if (disposition.disposition !== "session-terminated"
            || disposition.sessionId !== attempt.sessionId) {
            fail("invalid_cancellation_disposition", `${attemptId} requires termination of ${attempt.sessionId}`, {
                path: "dispositions",
            });
        }
        attempt.status = ATTEMPT_STATUS.CANCELLED;
        attempt.completedAt = timestamp;
		attempt.sessionTerminatedAt = attempt.sessionId === null ? null : timestamp;
        attempt.error = candidate.cancellation.reason;
		task.status = TASK_STATUS.CANCELLED;
        acknowledgements.push({
            attemptId,
            disposition: disposition.disposition,
            sessionId: attempt.sessionId,
            acknowledgedBy: options.finalizedBy,
            acknowledgedAt: timestamp,
        });
    }
    for (const task of candidate.tasks) {
        if (task.status !== TASK_STATUS.DONE) {
            task.status = TASK_STATUS.CANCELLED;
        }
    }
    if (candidate.cancellation.verificationRunId !== null) {
        candidate.verification = {
            ...candidate.verification,
            status: VERIFICATION_STATUS.FAILED,
			runId: candidate.cancellation.verificationRunId,
            summary: "Verification was cancelled with the plan",
            evidence: [],
            missingEvidence: ["Verification did not complete"],
            correctionTaskIds: candidate.tasks.map((task) => task.id),
            completedAt: timestamp,
        };
    } else if (candidate.cancellation.verificationReservationId !== null) {
        candidate.verification = emptyVerification();
    }
    candidate.cancellation.acknowledgements = acknowledgements;
    candidate.cancellation.verificationDisposition =
        candidate.cancellation.verificationReservationId === null
            ? null
            : options.verificationDisposition;
    candidate.cancellation.finalizationOverride =
		options.finalizationOverride ?? null;
    candidate.cancellation.verificationTerminatedAt =
        candidate.cancellation.verificationRunId === null ? null : timestamp;
    candidate.cancellation.finalizedBy = options.finalizedBy;
    candidate.cancellation.finalizedAt = timestamp;
    candidate.status = PLAN_STATUS.CANCELLED;
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

/**
 * Computes the selected correction tasks and every transitive descendant.
 *
 * @param {FoundryTask[]} tasks
 * @param {string[]} taskIds
 * @returns {Set<string>}
 */
function correctionClosure(tasks, taskIds) {
    const selected = new Set(taskIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const task of tasks) {
            if (!selected.has(task.id)
                && task.dependsOn.some((dependencyId) => selected.has(dependencyId))) {
                selected.add(task.id);
                changed = true;
            }
        }
    }
    return selected;
}

/**
 * Starts a correction wave after failed verification while retaining attempts.
 *
 * @param {FoundryPlan} plan
 * @param {string} actor
 * @param {{at?: Date|string|number}} [options]
 * @returns {FoundryPlan}
 */
export function retryFailedPlan(plan, actor, options = {}) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.FAILED
        || plan.verification.status !== VERIFICATION_STATUS.FAILED) {
        fail("invalid_plan_transition", `Plan ${plan.id} has no failed verification to correct`, {
            path: "status",
        });
    }
    requireActor(actor, "actor");
    const candidate = clone(plan);
    const reopened = correctionClosure(candidate.tasks, candidate.verification.correctionTaskIds);
    for (const task of candidate.tasks) {
        if (reopened.has(task.id)) {
            task.status = TASK_STATUS.PLANNED;
        }
    }
    candidate.status = PLAN_STATUS.RUNNING;
    candidate.verification = emptyVerification();
    candidate.updatedAt = nowIso(options.at);
    return reconcileTaskReadiness(candidate, { at: candidate.updatedAt });
}

/**
 * Returns dependency-ready tasks in stable ID order.
 *
 * @param {FoundryPlan} plan
 * @returns {FoundryTask[]}
 */
export function getReadyTasks(plan) {
    validatePlan(plan);
    if (plan.status !== PLAN_STATUS.APPROVED && plan.status !== PLAN_STATUS.RUNNING) {
        return [];
    }
    return plan.tasks
		.filter((task) => task.status === TASK_STATUS.READY)
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map(clone);
}

/**
 * Builds a bounded plan-list summary with progress and provenance.
 *
 * @param {FoundryPlan} plan
 * @returns {any}
 */
export function summarizePlan(plan) {
    validatePlan(plan);
    const byStatus = Object.fromEntries(Object.values(TASK_STATUS).map((status) => [status, 0]));
    for (const task of plan.tasks) {
        byStatus[task.status] += 1;
    }
    return {
        id: plan.id,
        title: plan.title,
        objective: plan.objective,
        status: plan.status,
        revision: plan.revision,
        tasksTotal: plan.tasks.length,
        tasksDone: byStatus[TASK_STATUS.DONE],
        tasksByStatus: byStatus,
        attemptsTotal: plan.tasks.reduce((sum, task) => sum + task.attempts.length, 0),
        planningRunId: plan.planning?.runId ?? null,
        verificationStatus: plan.verification.status,
        updatedAt: plan.updatedAt,
    };
}

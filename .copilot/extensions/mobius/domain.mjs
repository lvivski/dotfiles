// Pure plan semantics; no SDK or storage dependencies.
import path from "node:path";

export const LEGACY_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION = 2;
export const MAX_GENERATION = 16;

export const ACTOR_SOURCE = Object.freeze({
    CALLER: "caller",
    CANVAS: "canvas",
    LEGACY: "legacy",
});

export const DELIVERY_AVAILABILITY = Object.freeze({
    MERGED_TO_BASE: "merged-to-base",
    BRANCH: "branch",
});

export const EVIDENCE_KIND = Object.freeze({
    COMMAND_RESULT: "command-result",
    TEST_RESULT: "test-result",
    COMMIT: "commit",
    PULL_REQUEST: "pull-request",
    CI_RUN: "ci-run",
    ARTIFACT: "artifact",
});

export const OBSERVATION_SOURCE = Object.freeze({
    CHILD: "child",
    EXTERNAL: "external",
});

export const OBSERVATION_KIND = Object.freeze({
    SESSION: "session",
    PULL_REQUEST: "pull-request",
    CI_RUN: "ci-run",
});

export const PLAN_STATUS = Object.freeze({
    DRAFT: "draft",
    AWAITING_APPROVAL: "awaiting-approval",
    APPROVED: "approved",
    RUNNING: "running",
    VERIFYING: "verifying",
    AWAITING_COMPLETION_APPROVAL: "awaiting-completion-approval",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    FAILED: "failed",
});

export const TASK_STATUS = Object.freeze({
    PLANNED: "planned",
    READY: "ready",
    RUNNING: "running",
    DONE: "done",
    BLOCKED: "blocked",
    FAILED: "failed",
    CANCELLED: "cancelled",
});

export const VERIFICATION_STATUS = Object.freeze({
    NOT_STARTED: "not-started",
    RUNNING: "running",
    PASSED: "passed",
    FAILED: "failed",
});

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
    sessionId: 256,
    branch: 512,
    prUrl: 2_048,
    resultSummary: 8_000,
    evidence: 64,
    evidenceItem: 2_000,
    error: 4_000,
    repositoryPath: 4_096,
    baseBranch: 512,
    actor: 256,
    verificationRunId: 256,
    missingEvidence: 64,
    missingEvidenceItem: 2_000,
    telemetry: 64,
    telemetryEvent: 96,
    deliveries: 16,
    evidenceRecords: 256,
    observations: 256,
    integrationRefs: 64,
    recordId: 256,
    externalId: 256,
    deliveryRepository: 512,
    deliveryRef: 512,
    generationFeedback: 4_000,
    canonicalValueBytes: 65_536,
});

const PLAN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const TASK_ID_PATTERN = /^T-\d{3}$/;
const TASK_KINDS = new Set(["implement"]);
const PLAN_STATUS_VALUES = new Set(Object.values(PLAN_STATUS));
const TASK_STATUS_VALUES = new Set(Object.values(TASK_STATUS));
const VERIFICATION_STATUS_VALUES = new Set(Object.values(VERIFICATION_STATUS));
const ACTOR_SOURCE_VALUES = new Set(Object.values(ACTOR_SOURCE));
const DELIVERY_AVAILABILITY_VALUES = new Set(Object.values(DELIVERY_AVAILABILITY));
const EVIDENCE_KIND_VALUES = new Set(Object.values(EVIDENCE_KIND));
const OBSERVATION_SOURCE_VALUES = new Set(Object.values(OBSERVATION_SOURCE));
const OBSERVATION_KIND_VALUES = new Set(Object.values(OBSERVATION_KIND));

const PLAN_KEYS_V1 = new Set([
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
    "telemetry",
    "createdAt",
    "updatedAt",
]);
const PLAN_KEYS_V2 = new Set([
    ...PLAN_KEYS_V1,
    "generation",
    "evidenceRecords",
    "observations",
    "integrationRefs",
]);

const REPOSITORY_KEYS = new Set(["workingDirectory", "baseBranch"]);
const PLANNING_KEYS = new Set(["backend", "runId", "inputDigest"]);
const GATE_KEYS = new Set([
    "planApprovedAt",
    "planApprovedBy",
    "completionApprovedAt",
    "completionApprovedBy",
]);
const VERIFICATION_KEYS = new Set([
    "status",
    "backend",
    "runId",
    "inputDigest",
    "summary",
    "evidence",
    "missingEvidence",
    "startedAt",
    "completedAt",
]);
const TELEMETRY_KEYS = new Set(["event", "at"]);
const TASK_KEYS_V1 = new Set([
    "id",
    "title",
    "kind",
    "description",
    "dependsOn",
    "status",
    "acceptanceCriteria",
    "expectedFiles",
    "sessionId",
    "branch",
    "prUrl",
    "resultSummary",
    "evidence",
    "error",
    "startedAt",
    "completedAt",
]);
const TASK_KEYS_V2 = new Set([
    ...TASK_KEYS_V1,
    "reservation",
    "deliveries",
]);
const ACTOR_KEYS = new Set(["label", "source", "externalId", "verified"]);
const RESERVATION_KEYS = new Set([
    "reservationId",
    "generation",
    "reservedBy",
    "reservedAt",
    "expiresAt",
    "scopeOverride",
]);
const SCOPE_OVERRIDE_KEYS = new Set(["reason", "actor"]);
const DELIVERY_KEYS = new Set([
    "repository",
    "availability",
    "ref",
    "commitSha",
    "prUrl",
    "observedBySessionId",
    "observedAt",
]);
const EVIDENCE_RECORD_KEYS = new Set([
    "evidenceId",
    "kind",
    "binding",
    "payload",
    "digest",
    "recordedBy",
    "recordedAt",
]);
const OBSERVATION_KEYS = new Set([
    "observationId",
    "source",
    "kind",
    "taskId",
    "externalId",
    "value",
    "observedBy",
    "observedAt",
]);
const INTEGRATION_REF_KEYS = new Set([
    "integrationId",
    "generation",
    "taskIds",
    "repository",
    "ref",
    "commitSha",
    "prUrl",
    "observedBySessionId",
    "observedAt",
]);
const GENERATION_KEYS = new Set(["current", "history"]);
const GENERATION_RECORD_KEYS = new Set([
    "number",
    "createdAt",
    "createdBy",
    "planningRunId",
    "feedback",
    "diffDigest",
]);
const GENERATION_INPUT_KEYS = new Set([
    "createdBy",
    "planningRunId",
    "feedback",
    "diffDigest",
]);
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
]);

const PLAN_TRANSITIONS = Object.freeze({
    [PLAN_STATUS.DRAFT]: new Set([
        PLAN_STATUS.AWAITING_APPROVAL,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.AWAITING_APPROVAL]: new Set([
        PLAN_STATUS.APPROVED,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.APPROVED]: new Set([
        PLAN_STATUS.RUNNING,
        PLAN_STATUS.FAILED,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.RUNNING]: new Set([
        PLAN_STATUS.VERIFYING,
        PLAN_STATUS.FAILED,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.VERIFYING]: new Set([
        PLAN_STATUS.VERIFYING,
        PLAN_STATUS.AWAITING_COMPLETION_APPROVAL,
        PLAN_STATUS.FAILED,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.AWAITING_COMPLETION_APPROVAL]: new Set([
        PLAN_STATUS.COMPLETED,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.FAILED]: new Set([
        PLAN_STATUS.APPROVED,
        PLAN_STATUS.RUNNING,
        PLAN_STATUS.CANCELLED,
    ]),
    [PLAN_STATUS.COMPLETED]: new Set(),
    [PLAN_STATUS.CANCELLED]: new Set(),
});

const TASK_TRANSITIONS = Object.freeze({
    [TASK_STATUS.PLANNED]: new Set([
        TASK_STATUS.READY,
        TASK_STATUS.BLOCKED,
        TASK_STATUS.CANCELLED,
    ]),
    [TASK_STATUS.READY]: new Set([
        TASK_STATUS.RUNNING,
        TASK_STATUS.BLOCKED,
        TASK_STATUS.CANCELLED,
    ]),
    [TASK_STATUS.RUNNING]: new Set([
        TASK_STATUS.DONE,
        TASK_STATUS.BLOCKED,
        TASK_STATUS.FAILED,
        TASK_STATUS.CANCELLED,
    ]),
    [TASK_STATUS.BLOCKED]: new Set([
        TASK_STATUS.READY,
        TASK_STATUS.CANCELLED,
    ]),
    [TASK_STATUS.FAILED]: new Set([
        TASK_STATUS.READY,
        TASK_STATUS.CANCELLED,
    ]),
    [TASK_STATUS.DONE]: new Set(),
    [TASK_STATUS.CANCELLED]: new Set(),
});

export class MobiusDomainError extends Error {
    constructor(code, message, options = {}) {
        super(message);
        this.name = "MobiusDomainError";
        this.code = code;
        this.path = options.path ?? null;
        this.details = options.details ?? null;
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            path: this.path,
            details: this.details,
        };
    }
}

function fail(code, message, options) {
    throw new MobiusDomainError(code, message, options);
}

function isPlainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, fieldPath) {
    if (!isPlainObject(value)) {
        fail("invalid_object", `${fieldPath} must be an object`, { path: fieldPath });
    }
}

function assertKnownKeys(value, keys, fieldPath, schemaVersion = SCHEMA_VERSION) {
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
            fail("unknown_field", `${fieldPath}.${key} is not supported by schema version ${schemaVersion}`, {
                path: `${fieldPath}.${key}`,
            });
        }
    }
}

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

function assertNullableString(value, fieldPath, maximum) {
    if (value === null) {
        return;
    }
    assertString(value, fieldPath, maximum);
}

function assertNullableDigest(value, fieldPath) {
    if (value === null) {
        return;
    }
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        fail("invalid_digest", `${fieldPath} must be a lowercase SHA-256 digest or null`, {
            path: fieldPath,
        });
    }
}

function assertPositiveInteger(value, fieldPath, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        fail("invalid_integer", `${fieldPath} must be an integer from 1 through ${maximum}`, {
            path: fieldPath,
            details: { maximum, value },
        });
    }
}

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

function assertTimestamp(value, fieldPath, options = {}) {
    if (options.nullable && value === null) {
        return;
    }
    const canonicalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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

function assertTimestampPair(at, by, prefix) {
    if ((at === null) !== (by === null)) {
        fail("invalid_gate", `${prefix} timestamp and actor must either both be set or both be null`, {
            path: prefix,
        });
    }
    assertTimestamp(at, `${prefix}At`, { nullable: true });
    assertNullableString(by, `${prefix}By`, LIMITS.actor);
}

function assertActorTimestampPair(at, actor, prefix) {
    if ((at === null) !== (actor === null)) {
        fail("invalid_gate", `${prefix} timestamp and actor must either both be set or both be null`, {
            path: prefix,
        });
    }
    assertTimestamp(at, `${prefix}At`, { nullable: true });
    if (actor !== null) {
        validateActorProvenance(actor, `${prefix}By`);
    }
}

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

function canonicalValueViolation(value, fieldPath, ancestors) {
    if (value === null) {
        return null;
    }
    const valueType = typeof value;
    if (valueType === "boolean" || valueType === "string") {
        return null;
    }
    if (valueType === "number") {
        return Number.isFinite(value)
            ? null
            : { path: fieldPath, reason: "numbers must be finite" };
    }
    if (valueType !== "object") {
        return { path: fieldPath, reason: `${valueType} values are not canonical JSON values` };
    }
    if (ancestors.has(value)) {
        return { path: fieldPath, reason: "cycles are not canonical JSON values" };
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const ownKeys = Reflect.ownKeys(value);
            for (const key of ownKeys) {
                if (key === "length") {
                    continue;
                }
                if (typeof key !== "string"
                    || !/^(?:0|[1-9]\d*)$/.test(key)
                    || Number(key) >= value.length) {
                    return {
                        path: fieldPath,
                        reason: "arrays may contain only indexed canonical values",
                    };
                }
            }
            for (let index = 0; index < value.length; index += 1) {
                const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
                if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
                    return {
                        path: `${fieldPath}[${index}]`,
                        reason: "array items must be enumerable data properties",
                    };
                }
                const violation = canonicalValueViolation(
                    descriptor.value,
                    `${fieldPath}[${index}]`,
                    ancestors,
                );
                if (violation) {
                    return violation;
                }
            }
            return null;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            return { path: fieldPath, reason: "objects must have Object.prototype or null" };
        }
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== "string") {
                return { path: fieldPath, reason: "symbol object keys are not canonical" };
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
                return {
                    path: `${fieldPath}.${key}`,
                    reason: "object properties must be enumerable data properties",
                };
            }
            const violation = canonicalValueViolation(
                descriptor.value,
                `${fieldPath}.${key}`,
                ancestors,
            );
            if (violation) {
                return violation;
            }
        }
        return null;
    } finally {
        ancestors.delete(value);
    }
}

export function assertCanonicalValue(value, fieldPath = "value") {
    const violation = canonicalValueViolation(value, fieldPath, new WeakSet());
    if (violation) {
        fail("invalid_evidence", `${violation.path} ${violation.reason}`, {
            path: violation.path,
            details: { reason: violation.reason },
        });
    }
    return value;
}

function assertBoundedCanonicalValue(value, fieldPath) {
    assertCanonicalValue(value, fieldPath);
    const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (byteLength > LIMITS.canonicalValueBytes) {
        fail(
            "invalid_evidence",
            `${fieldPath} exceeds the ${LIMITS.canonicalValueBytes}-byte canonical value limit`,
            {
                path: fieldPath,
                details: {
                    maximum: LIMITS.canonicalValueBytes,
                    actual: byteLength,
                },
            },
        );
    }
}

function clone(value) {
    return structuredClone(value);
}

function nowIso(now) {
    const value = typeof now === "function" ? now() : now;
    const date = value === undefined ? new Date() : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        fail("invalid_timestamp", "The supplied clock did not produce a valid timestamp");
    }
    return date.toISOString();
}

function taskMap(tasks) {
    return new Map(tasks.map((task) => [task.id, task]));
}

export function validateActorProvenance(actor, fieldPath = "actor") {
    assertPlainObject(actor, fieldPath);
    assertKnownKeys(actor, ACTOR_KEYS, fieldPath);
    assertString(actor.label, `${fieldPath}.label`, LIMITS.actor);
    if (!ACTOR_SOURCE_VALUES.has(actor.source)) {
        fail("invalid_actor_source", `${fieldPath}.source is not supported`, {
            path: `${fieldPath}.source`,
            details: { value: actor.source },
        });
    }
    assertNullableString(actor.externalId, `${fieldPath}.externalId`, LIMITS.externalId);
    if (typeof actor.verified !== "boolean") {
        fail("invalid_actor", `${fieldPath}.verified must be a boolean`, {
            path: `${fieldPath}.verified`,
        });
    }
    if (actor.verified === true) {
        fail(
            "actor_verified_invalid",
            `${fieldPath}.source ${actor.source} cannot claim a verified identity`,
            { path: `${fieldPath}.verified`, details: { source: actor.source } },
        );
    }
    return actor;
}

export function actorProvenance(label, source = ACTOR_SOURCE.CALLER, externalId = null) {
    const actor = {
        label,
        source,
        externalId,
        verified: false,
    };
    validateActorProvenance(actor);
    return actor;
}

function normalizeActor(actor, source = ACTOR_SOURCE.CALLER) {
    if (typeof actor === "string") {
        return actorProvenance(actor, source);
    }
    validateActorProvenance(actor);
    return clone(actor);
}

function assertTaskId(value, fieldPath, options = {}) {
    if (options.nullable && value === null) {
        return;
    }
    if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) {
        fail("invalid_task_id", `${fieldPath} must use the T-001 format`, {
            path: fieldPath,
        });
    }
}

function assertCommitSha(value, fieldPath) {
    if (value === null) {
        return;
    }
    if (typeof value !== "string"
        || (!/^[a-f0-9]{40}$/.test(value) && !/^[a-f0-9]{64}$/.test(value))) {
        fail("invalid_commit_sha", `${fieldPath} must be a 40- or 64-character lowercase hex SHA`, {
            path: fieldPath,
        });
    }
}

export function validateTaskReservation(
    reservation,
    fieldPath = "reservation",
    currentGeneration = MAX_GENERATION,
) {
    assertPlainObject(reservation, fieldPath);
    assertKnownKeys(reservation, RESERVATION_KEYS, fieldPath);
    assertString(
        reservation.reservationId,
        `${fieldPath}.reservationId`,
        LIMITS.recordId,
    );
    assertPositiveInteger(
        reservation.generation,
        `${fieldPath}.generation`,
        currentGeneration,
    );
    validateActorProvenance(reservation.reservedBy, `${fieldPath}.reservedBy`);
    assertTimestamp(reservation.reservedAt, `${fieldPath}.reservedAt`);
    assertTimestamp(reservation.expiresAt, `${fieldPath}.expiresAt`);
    if (Date.parse(reservation.expiresAt) <= Date.parse(reservation.reservedAt)) {
        fail("invalid_reservation", `${fieldPath}.expiresAt must follow reservedAt`, {
            path: `${fieldPath}.expiresAt`,
        });
    }
    if (reservation.scopeOverride !== null) {
        assertPlainObject(reservation.scopeOverride, `${fieldPath}.scopeOverride`);
        assertKnownKeys(
            reservation.scopeOverride,
            SCOPE_OVERRIDE_KEYS,
            `${fieldPath}.scopeOverride`,
        );
        assertString(
            reservation.scopeOverride.reason,
            `${fieldPath}.scopeOverride.reason`,
            LIMITS.error,
        );
        validateActorProvenance(
            reservation.scopeOverride.actor,
            `${fieldPath}.scopeOverride.actor`,
        );
    }
    return reservation;
}

export function validateDeliveryProvenance(delivery, fieldPath = "delivery") {
    assertPlainObject(delivery, fieldPath);
    assertKnownKeys(delivery, DELIVERY_KEYS, fieldPath);
    assertString(
        delivery.repository,
        `${fieldPath}.repository`,
        LIMITS.deliveryRepository,
    );
    if (!DELIVERY_AVAILABILITY_VALUES.has(delivery.availability)) {
        fail("delivery_provenance_invalid", `${fieldPath}.availability is not supported`, {
            path: `${fieldPath}.availability`,
            details: { value: delivery.availability },
        });
    }
    assertString(delivery.ref, `${fieldPath}.ref`, LIMITS.deliveryRef);
    assertCommitSha(delivery.commitSha, `${fieldPath}.commitSha`);
    assertHttpUrl(delivery.prUrl, `${fieldPath}.prUrl`);
    assertString(
        delivery.observedBySessionId,
        `${fieldPath}.observedBySessionId`,
        LIMITS.sessionId,
    );
    assertTimestamp(delivery.observedAt, `${fieldPath}.observedAt`);
    return delivery;
}

export function validateEvidenceRecord(record, fieldPath = "evidence") {
    assertPlainObject(record, fieldPath);
    assertKnownKeys(record, EVIDENCE_RECORD_KEYS, fieldPath);
    if (typeof record.evidenceId !== "string"
        || !/^ev-[a-f0-9]{24}$/.test(record.evidenceId)) {
        fail("invalid_evidence", `${fieldPath}.evidenceId must use ev- plus 24 lowercase hex characters`, {
            path: `${fieldPath}.evidenceId`,
        });
    }
    if (!EVIDENCE_KIND_VALUES.has(record.kind)) {
        fail("invalid_evidence", `${fieldPath}.kind is not supported`, {
            path: `${fieldPath}.kind`,
            details: { value: record.kind },
        });
    }
    assertPlainObject(record.binding, `${fieldPath}.binding`);
    assertBoundedCanonicalValue(record.binding, `${fieldPath}.binding`);
    assertBoundedCanonicalValue(record.payload, `${fieldPath}.payload`);
    if (typeof record.digest !== "string" || !/^[a-f0-9]{64}$/.test(record.digest)) {
        fail("invalid_evidence", `${fieldPath}.digest must be a lowercase SHA-256 digest`, {
            path: `${fieldPath}.digest`,
        });
    }
    validateActorProvenance(record.recordedBy, `${fieldPath}.recordedBy`);
    assertTimestamp(record.recordedAt, `${fieldPath}.recordedAt`);
    return record;
}

export function validateObservation(observation, fieldPath = "observation") {
    assertPlainObject(observation, fieldPath);
    assertKnownKeys(observation, OBSERVATION_KEYS, fieldPath);
    assertString(
        observation.observationId,
        `${fieldPath}.observationId`,
        LIMITS.recordId,
    );
    if (!OBSERVATION_SOURCE_VALUES.has(observation.source)) {
        fail("invalid_observation", `${fieldPath}.source is not supported`, {
            path: `${fieldPath}.source`,
            details: { value: observation.source },
        });
    }
    if (!OBSERVATION_KIND_VALUES.has(observation.kind)) {
        fail("invalid_observation", `${fieldPath}.kind is not supported`, {
            path: `${fieldPath}.kind`,
            details: { value: observation.kind },
        });
    }
    assertTaskId(observation.taskId, `${fieldPath}.taskId`, { nullable: true });
    assertString(
        observation.externalId,
        `${fieldPath}.externalId`,
        LIMITS.externalId,
    );
    assertBoundedCanonicalValue(observation.value, `${fieldPath}.value`);
    validateActorProvenance(observation.observedBy, `${fieldPath}.observedBy`);
    assertTimestamp(observation.observedAt, `${fieldPath}.observedAt`);
    return observation;
}

export function validateIntegrationRef(
    integration,
    fieldPath = "integrationRef",
    currentGeneration = MAX_GENERATION,
) {
    assertPlainObject(integration, fieldPath);
    assertKnownKeys(integration, INTEGRATION_REF_KEYS, fieldPath);
    assertString(
        integration.integrationId,
        `${fieldPath}.integrationId`,
        LIMITS.recordId,
    );
    assertPositiveInteger(
        integration.generation,
        `${fieldPath}.generation`,
        currentGeneration,
    );
    assertStringArray(integration.taskIds, `${fieldPath}.taskIds`, {
        minimum: 1,
        maximum: LIMITS.tasks,
        itemMaximum: 5,
    });
    const uniqueTaskIds = new Set();
    integration.taskIds.forEach((taskId, index) => {
        assertTaskId(taskId, `${fieldPath}.taskIds[${index}]`);
        if (uniqueTaskIds.has(taskId)) {
            fail("duplicate_task_id", `${fieldPath}.taskIds repeats ${taskId}`, {
                path: `${fieldPath}.taskIds[${index}]`,
            });
        }
        uniqueTaskIds.add(taskId);
    });
    assertString(
        integration.repository,
        `${fieldPath}.repository`,
        LIMITS.deliveryRepository,
    );
    assertString(integration.ref, `${fieldPath}.ref`, LIMITS.deliveryRef);
    assertCommitSha(integration.commitSha, `${fieldPath}.commitSha`);
    assertHttpUrl(integration.prUrl, `${fieldPath}.prUrl`);
    assertString(
        integration.observedBySessionId,
        `${fieldPath}.observedBySessionId`,
        LIMITS.sessionId,
    );
    assertTimestamp(integration.observedAt, `${fieldPath}.observedAt`);
    return integration;
}

export function validateGenerationMetadata(generation, fieldPath = "generation") {
    assertPlainObject(generation, fieldPath);
    assertKnownKeys(generation, GENERATION_KEYS, fieldPath);
    assertPositiveInteger(generation.current, `${fieldPath}.current`, MAX_GENERATION);
    if (!Array.isArray(generation.history)
        || generation.history.length !== generation.current
        || generation.history.length > MAX_GENERATION) {
        fail(
            "invalid_generation",
            `${fieldPath}.history must contain one sequential record per generation`,
            {
                path: `${fieldPath}.history`,
                details: {
                    current: generation.current,
                    actual: Array.isArray(generation.history)
                        ? generation.history.length
                        : null,
                },
            },
        );
    }
    let previousCreatedAt = null;
    generation.history.forEach((record, index) => {
        const recordPath = `${fieldPath}.history[${index}]`;
        assertPlainObject(record, recordPath);
        assertKnownKeys(record, GENERATION_RECORD_KEYS, recordPath);
        if (record.number !== index + 1) {
            fail("invalid_generation", `${recordPath}.number must be ${index + 1}`, {
                path: `${recordPath}.number`,
            });
        }
        assertTimestamp(record.createdAt, `${recordPath}.createdAt`);
        if (previousCreatedAt !== null
            && Date.parse(record.createdAt) < Date.parse(previousCreatedAt)) {
            fail("invalid_generation", `${recordPath}.createdAt precedes the prior generation`, {
                path: `${recordPath}.createdAt`,
            });
        }
        previousCreatedAt = record.createdAt;
        if (record.createdBy !== null) {
            validateActorProvenance(record.createdBy, `${recordPath}.createdBy`);
        }
        assertNullableString(
            record.planningRunId,
            `${recordPath}.planningRunId`,
            LIMITS.verificationRunId,
        );
        assertNullableString(
            record.feedback,
            `${recordPath}.feedback`,
            LIMITS.generationFeedback,
        );
        assertNullableDigest(record.diffDigest, `${recordPath}.diffDigest`);
    });
    return generation;
}

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
    const stack = [];
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

function validateTask(task, index, options = {}) {
    const fieldPath = `tasks[${index}]`;
    const schemaVersion = options.schemaVersion ?? SCHEMA_VERSION;
    assertPlainObject(task, fieldPath);
    assertKnownKeys(
        task,
        schemaVersion === LEGACY_SCHEMA_VERSION ? TASK_KEYS_V1 : TASK_KEYS_V2,
        fieldPath,
        schemaVersion,
    );

    if (typeof task.id !== "string" || !TASK_ID_PATTERN.test(task.id)) {
        fail("invalid_task_id", `${fieldPath}.id must use the T-001 format`, {
            path: `${fieldPath}.id`,
        });
    }
    assertString(task.title, `${fieldPath}.title`, LIMITS.taskTitle);
    if (!TASK_KINDS.has(task.kind)) {
        fail("invalid_task_kind", `${fieldPath}.kind must be "implement" in schema version ${schemaVersion}`, {
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
        minimum: 1,
        maximum: LIMITS.acceptanceCriteria,
        itemMaximum: LIMITS.acceptanceCriterion,
    });
    assertStringArray(task.expectedFiles, `${fieldPath}.expectedFiles`, {
        maximum: LIMITS.expectedFiles,
        itemMaximum: LIMITS.expectedFile,
    });
    assertNullableString(task.sessionId, `${fieldPath}.sessionId`, LIMITS.sessionId);
    assertNullableString(task.branch, `${fieldPath}.branch`, LIMITS.branch);
    assertHttpUrl(task.prUrl, `${fieldPath}.prUrl`);
    assertNullableString(task.resultSummary, `${fieldPath}.resultSummary`, LIMITS.resultSummary);
    assertStringArray(task.evidence, `${fieldPath}.evidence`, {
        maximum: LIMITS.evidence,
        itemMaximum: LIMITS.evidenceItem,
    });
    assertNullableString(task.error, `${fieldPath}.error`, LIMITS.error);
    assertTimestamp(task.startedAt, `${fieldPath}.startedAt`, { nullable: true });
    assertTimestamp(task.completedAt, `${fieldPath}.completedAt`, { nullable: true });

    if (schemaVersion === SCHEMA_VERSION) {
        if (task.reservation !== null) {
            validateTaskReservation(
                task.reservation,
                `${fieldPath}.reservation`,
                options.currentGeneration,
            );
            if (task.status !== TASK_STATUS.READY && task.status !== TASK_STATUS.RUNNING) {
                fail(
                    "invalid_task_state",
                    `${fieldPath}.reservation is only valid while ready or running`,
                    { path: `${fieldPath}.reservation` },
                );
            }
        }
        if (!Array.isArray(task.deliveries) || task.deliveries.length > LIMITS.deliveries) {
            fail(
                "invalid_delivery",
                `${fieldPath}.deliveries must contain at most ${LIMITS.deliveries} records`,
                { path: `${fieldPath}.deliveries` },
            );
        }
        task.deliveries.forEach((delivery, deliveryIndex) => {
            validateDeliveryProvenance(
                delivery,
                `${fieldPath}.deliveries[${deliveryIndex}]`,
            );
        });
    }

    if (task.startedAt !== null && task.completedAt !== null
        && Date.parse(task.completedAt) < Date.parse(task.startedAt)) {
        fail("invalid_task_timestamps", `${fieldPath}.completedAt precedes startedAt`, {
            path: `${fieldPath}.completedAt`,
        });
    }

    if (task.status === TASK_STATUS.PLANNED || task.status === TASK_STATUS.READY) {
        const executionFields = [
            task.sessionId,
            task.branch,
            task.prUrl,
            task.resultSummary,
            task.error,
            task.startedAt,
            task.completedAt,
        ];
        if (executionFields.some((value) => value !== null) || task.evidence.length > 0) {
            fail("invalid_task_state", `${fieldPath} has execution data before it is running`, {
                path: fieldPath,
            });
        }
    }

    if (task.status === TASK_STATUS.RUNNING) {
        if (task.sessionId === null || task.startedAt === null) {
            fail("invalid_task_state", `${fieldPath} requires sessionId and startedAt while running`, {
                path: fieldPath,
            });
        }
        if (task.completedAt !== null || task.error !== null) {
            fail("invalid_task_state", `${fieldPath} cannot be completed or errored while running`, {
                path: fieldPath,
            });
        }
    }

    if (task.status === TASK_STATUS.DONE) {
        if (task.sessionId === null || task.startedAt === null || task.completedAt === null
            || task.resultSummary === null || task.evidence.length === 0 || task.error !== null) {
            fail(
                "invalid_task_state",
                `${fieldPath} requires session, timestamps, result summary, and evidence when done`,
                { path: fieldPath },
            );
        }
    }

    if (task.status === TASK_STATUS.BLOCKED && task.error === null) {
        fail("invalid_task_state", `${fieldPath} requires an error describing why it is blocked`, {
            path: fieldPath,
        });
    }

    if (task.status === TASK_STATUS.FAILED
        && (task.sessionId === null || task.startedAt === null || task.completedAt === null || task.error === null)) {
        fail("invalid_task_state", `${fieldPath} requires session, timestamps, and an error when failed`, {
            path: fieldPath,
        });
    }

    if (task.status === TASK_STATUS.CANCELLED
        && (task.completedAt === null || task.error === null)) {
        fail("invalid_task_state", `${fieldPath} requires completedAt and a cancellation reason`, {
            path: fieldPath,
        });
    }
}

function validateVerification(verification) {
    assertPlainObject(verification, "verification");
    assertKnownKeys(verification, VERIFICATION_KEYS, "verification");
    if (!VERIFICATION_STATUS_VALUES.has(verification.status)) {
        fail("invalid_verification_status", "verification.status is not supported", {
            path: "verification.status",
            details: { value: verification.status },
        });
    }
    assertNullableString(verification.backend, "verification.backend", 32);
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
        maximum: LIMITS.evidence,
        itemMaximum: LIMITS.evidenceItem,
    });
    assertStringArray(verification.missingEvidence, "verification.missingEvidence", {
        maximum: LIMITS.missingEvidence,
        itemMaximum: LIMITS.missingEvidenceItem,
    });
    assertTimestamp(verification.startedAt, "verification.startedAt", { nullable: true });
    assertTimestamp(verification.completedAt, "verification.completedAt", { nullable: true });
    if (verification.startedAt !== null && verification.completedAt !== null
        && Date.parse(verification.completedAt) < Date.parse(verification.startedAt)) {
        fail("invalid_verification_timestamps", "verification.completedAt precedes startedAt", {
            path: "verification.completedAt",
        });
    }

    if (verification.status === VERIFICATION_STATUS.NOT_STARTED) {
        if (verification.runId !== null
            || verification.backend !== null
            || verification.inputDigest !== null
            || verification.summary !== null
            || verification.evidence.length > 0
            || verification.missingEvidence.length > 0
            || verification.startedAt !== null
            || verification.completedAt !== null) {
            fail("invalid_verification_state", "Unstarted verification cannot contain run data", {
                path: "verification",
            });
        }
    } else if (verification.status === VERIFICATION_STATUS.RUNNING) {
        if (verification.backend !== "conveyor"
            || verification.runId === null
            || !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
            || verification.startedAt === null
            || verification.summary !== null
            || verification.completedAt !== null) {
            fail("invalid_verification_state", "Running verification requires startedAt and no result", {
                path: "verification",
            });
        }
    } else if (verification.status === VERIFICATION_STATUS.PASSED) {
        if (verification.backend !== "conveyor"
            || verification.runId === null
            || !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
            || verification.startedAt === null
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
    } else if (verification.status === VERIFICATION_STATUS.FAILED) {
        if (verification.backend !== "conveyor"
            || verification.runId === null
            || !/^[a-f0-9]{64}$/.test(verification.inputDigest ?? "")
            || verification.startedAt === null
            || verification.completedAt === null
            || verification.summary === null
            || verification.missingEvidence.length === 0) {
            fail(
                "invalid_verification_state",
                "Failed verification requires timestamps, summary, and missing evidence",
                { path: "verification" },
            );
        }
    }
}

function emptyVerification() {
    return {
        status: VERIFICATION_STATUS.NOT_STARTED,
        backend: null,
        runId: null,
        inputDigest: null,
        summary: null,
        evidence: [],
        missingEvidence: [],
        startedAt: null,
        completedAt: null,
    };
}

function validatePlanning(planning) {
    if (planning === null) {
        return;
    }
    assertPlainObject(planning, "planning");
    assertKnownKeys(planning, PLANNING_KEYS, "planning");
    if (planning.backend !== "conveyor") {
        fail("invalid_planning_backend", "planning.backend must be conveyor", {
            path: "planning.backend",
        });
    }
    assertString(planning.runId, "planning.runId", LIMITS.verificationRunId);
    if (typeof planning.inputDigest !== "string"
        || !/^[a-f0-9]{64}$/.test(planning.inputDigest)) {
        fail("invalid_planning_digest", "planning.inputDigest must be a SHA-256 digest", {
            path: "planning.inputDigest",
        });
    }
}

export function validatePlan(plan) {
    assertPlainObject(plan, "plan");
    const schemaVersion = plan.schemaVersion;
    if (schemaVersion !== LEGACY_SCHEMA_VERSION && schemaVersion !== SCHEMA_VERSION) {
        fail(
            "unsupported_schema_version",
            `schemaVersion must be ${LEGACY_SCHEMA_VERSION} or ${SCHEMA_VERSION}`,
            {
                path: "schemaVersion",
                details: { value: schemaVersion },
            },
        );
    }
    assertKnownKeys(
        plan,
        schemaVersion === LEGACY_SCHEMA_VERSION ? PLAN_KEYS_V1 : PLAN_KEYS_V2,
        "plan",
        schemaVersion,
    );

    if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) {
        fail("invalid_revision", "revision must be a positive safe integer", {
            path: "revision",
        });
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
    if (schemaVersion === SCHEMA_VERSION) {
        validateGenerationMetadata(plan.generation);
    }

    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        fail("invalid_tasks", "tasks must contain at least one task", { path: "tasks" });
    }
    if (plan.tasks.length > LIMITS.tasks) {
        fail("array_too_long", `tasks exceeds the ${LIMITS.tasks}-item limit`, {
            path: "tasks",
            details: { maximum: LIMITS.tasks, actual: plan.tasks.length },
        });
    }
    plan.tasks.forEach((task, index) => validateTask(task, index, {
        schemaVersion,
        currentGeneration: schemaVersion === SCHEMA_VERSION
            ? plan.generation.current
            : null,
    }));
    validateDependencyGraph(plan.tasks);

    const byId = taskMap(plan.tasks);
    for (let index = 0; index < plan.tasks.length; index += 1) {
        const task = plan.tasks[index];
        if (task.status === TASK_STATUS.READY
            || task.status === TASK_STATUS.RUNNING
            || task.status === TASK_STATUS.DONE) {
            const unmet = task.dependsOn.filter((id) => byId.get(id).status !== TASK_STATUS.DONE);
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
        && plan.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_approved", `Ready tasks are not valid while the plan is ${plan.status}`, {
            path: "tasks",
        });
    }
    if (plan.tasks.some((task) => task.status === TASK_STATUS.RUNNING)
        && plan.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_running", `Running tasks are not valid while the plan is ${plan.status}`, {
            path: "tasks",
        });
    }

    assertPlainObject(plan.gates, "gates");
    assertKnownKeys(plan.gates, GATE_KEYS, "gates");
    if (schemaVersion === LEGACY_SCHEMA_VERSION) {
        assertTimestampPair(
            plan.gates.planApprovedAt,
            plan.gates.planApprovedBy,
            "gates.planApproved",
        );
        assertTimestampPair(
            plan.gates.completionApprovedAt,
            plan.gates.completionApprovedBy,
            "gates.completionApproved",
        );
    } else {
        assertActorTimestampPair(
            plan.gates.planApprovedAt,
            plan.gates.planApprovedBy,
            "gates.planApproved",
        );
        assertActorTimestampPair(
            plan.gates.completionApprovedAt,
            plan.gates.completionApprovedBy,
            "gates.completionApproved",
        );
    }

    const approvalRequired = new Set([
        PLAN_STATUS.APPROVED,
        PLAN_STATUS.RUNNING,
        PLAN_STATUS.VERIFYING,
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
        PLAN_STATUS.VERIFYING,
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
    const preVerificationStates = new Set([
        PLAN_STATUS.DRAFT,
        PLAN_STATUS.AWAITING_APPROVAL,
        PLAN_STATUS.APPROVED,
        PLAN_STATUS.RUNNING,
    ]);
    if (preVerificationStates.has(plan.status)
        && plan.verification.status !== VERIFICATION_STATUS.NOT_STARTED) {
        fail("invalid_verification_state", `Verification cannot be ${plan.verification.status} while the plan is ${plan.status}`, {
            path: "verification.status",
        });
    }
    if (plan.verification.status === VERIFICATION_STATUS.RUNNING
        && plan.status !== PLAN_STATUS.VERIFYING) {
        fail("invalid_verification_state", "Running verification requires plan status verifying", {
            path: "verification.status",
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
        && plan.status !== PLAN_STATUS.VERIFYING
        && plan.status !== PLAN_STATUS.FAILED
        && plan.status !== PLAN_STATUS.CANCELLED) {
        fail("invalid_verification_state", "Failed verification requires a verifying or failed plan", {
            path: "verification.status",
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

    if (schemaVersion === SCHEMA_VERSION) {
        if (!Array.isArray(plan.evidenceRecords)
            || plan.evidenceRecords.length > LIMITS.evidenceRecords) {
            fail(
                "invalid_evidence",
                `evidenceRecords must contain at most ${LIMITS.evidenceRecords} records`,
                { path: "evidenceRecords" },
            );
        }
        const evidenceIds = new Set();
        plan.evidenceRecords.forEach((record, index) => {
            validateEvidenceRecord(record, `evidenceRecords[${index}]`);
            if (evidenceIds.has(record.evidenceId)) {
                fail("invalid_evidence", `evidenceRecords repeats ${record.evidenceId}`, {
                    path: `evidenceRecords[${index}].evidenceId`,
                });
            }
            evidenceIds.add(record.evidenceId);
        });

        if (!Array.isArray(plan.observations)
            || plan.observations.length > LIMITS.observations) {
            fail(
                "invalid_observation",
                `observations must contain at most ${LIMITS.observations} records`,
                { path: "observations" },
            );
        }
        const observationIds = new Set();
        plan.observations.forEach((observation, index) => {
            validateObservation(observation, `observations[${index}]`);
            if (observation.taskId !== null && !byId.has(observation.taskId)) {
                fail(
                    "unknown_task",
                    `observations[${index}].taskId refers to unknown task ${observation.taskId}`,
                    { path: `observations[${index}].taskId` },
                );
            }
            if (observationIds.has(observation.observationId)) {
                fail(
                    "invalid_observation",
                    `observations repeats ${observation.observationId}`,
                    { path: `observations[${index}].observationId` },
                );
            }
            observationIds.add(observation.observationId);
        });

        if (!Array.isArray(plan.integrationRefs)
            || plan.integrationRefs.length > LIMITS.integrationRefs) {
            fail(
                "invalid_integration_ref",
                `integrationRefs must contain at most ${LIMITS.integrationRefs} records`,
                { path: "integrationRefs" },
            );
        }
        const integrationIds = new Set();
        plan.integrationRefs.forEach((integration, index) => {
            validateIntegrationRef(
                integration,
                `integrationRefs[${index}]`,
                plan.generation.current,
            );
            for (const taskId of integration.taskIds) {
                if (!byId.has(taskId)) {
                    fail(
                        "unknown_task",
                        `integrationRefs[${index}] refers to unknown task ${taskId}`,
                        { path: `integrationRefs[${index}].taskIds` },
                    );
                }
            }
            if (integrationIds.has(integration.integrationId)) {
                fail(
                    "invalid_integration_ref",
                    `integrationRefs repeats ${integration.integrationId}`,
                    { path: `integrationRefs[${index}].integrationId` },
                );
            }
            integrationIds.add(integration.integrationId);
        });
    }

    assertTimestamp(plan.createdAt, "createdAt");
    assertTimestamp(plan.updatedAt, "updatedAt");
    if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
        fail("invalid_plan_timestamps", "updatedAt precedes createdAt", { path: "updatedAt" });
    }
    if (schemaVersion === SCHEMA_VERSION
        && Date.parse(plan.generation.history[0].createdAt) < Date.parse(plan.createdAt)) {
        fail("invalid_generation", "The first generation cannot precede plan creation", {
            path: "generation.history[0].createdAt",
        });
    }
    return plan;
}

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
                kind: task.kind ?? "implement",
                description: task.description,
                dependsOn: clone(task.dependsOn ?? []),
                status: TASK_STATUS.PLANNED,
                acceptanceCriteria: clone(task.acceptanceCriteria ?? []),
                expectedFiles: clone(task.expectedFiles ?? []),
                sessionId: null,
                branch: null,
                prUrl: null,
                resultSummary: null,
                evidence: [],
                error: null,
                startedAt: null,
                completedAt: null,
                reservation: null,
                deliveries: [],
            };
        }),
        gates: {
            planApprovedAt: null,
            planApprovedBy: null,
            completionApprovedAt: null,
            completionApprovedBy: null,
        },
        verification: emptyVerification(),
        generation: {
            current: 1,
            history: [{
                number: 1,
                createdAt: timestamp,
                createdBy: null,
                planningRunId: input.planning?.runId ?? null,
                feedback: null,
                diffDigest: null,
            }],
        },
        evidenceRecords: [],
        observations: [],
        integrationRefs: [],
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

export function assertPlanMutable(plan) {
    validatePlan(plan);
    if (plan.schemaVersion === LEGACY_SCHEMA_VERSION) {
        fail(
            "upgrade_required",
            `Plan ${plan.id} must be upgraded to schema version ${SCHEMA_VERSION} before mutation`,
            { path: "schemaVersion", details: { id: plan.id, schemaVersion: plan.schemaVersion } },
        );
    }
    return plan;
}

export function upgradePlanToV2(plan) {
    validatePlan(plan);
    if (plan.schemaVersion === SCHEMA_VERSION) {
        fail("already_upgraded", `Plan ${plan.id} already uses schema version ${SCHEMA_VERSION}`, {
            path: "schemaVersion",
            details: { id: plan.id, schemaVersion: plan.schemaVersion },
        });
    }

    const upgraded = clone(plan);
    upgraded.schemaVersion = SCHEMA_VERSION;
    upgraded.tasks = upgraded.tasks.map((task) => ({
        ...task,
        reservation: null,
        deliveries: [],
    }));
    for (const key of ["planApprovedBy", "completionApprovedBy"]) {
        if (upgraded.gates[key] !== null) {
            upgraded.gates[key] = actorProvenance(
                upgraded.gates[key],
                ACTOR_SOURCE.LEGACY,
            );
        }
    }
    upgraded.generation = {
        current: 1,
        history: [{
            number: 1,
            createdAt: upgraded.createdAt,
            createdBy: null,
            planningRunId: upgraded.planning?.runId ?? null,
            feedback: null,
            diffDigest: null,
        }],
    };
    upgraded.evidenceRecords = [];
    upgraded.observations = [];
    upgraded.integrationRefs = [];
    validatePlan(upgraded);
    return upgraded;
}

export function appendPlanGeneration(plan, input, options = {}) {
    assertPlanMutable(plan);
    if (plan.generation.current >= MAX_GENERATION) {
        fail(
            "generation_limit",
            `Plan ${plan.id} already has the maximum ${MAX_GENERATION} generations`,
            {
                path: "generation.current",
                details: { maximum: MAX_GENERATION, current: plan.generation.current },
            },
        );
    }
    assertPlainObject(input, "generation");
    assertKnownKeys(input, GENERATION_INPUT_KEYS, "generation");
    if (input.createdBy !== null) {
        validateActorProvenance(input.createdBy, "generation.createdBy");
    }
    assertNullableString(
        input.planningRunId,
        "generation.planningRunId",
        LIMITS.verificationRunId,
    );
    assertNullableString(
        input.feedback,
        "generation.feedback",
        LIMITS.generationFeedback,
    );
    assertNullableDigest(input.diffDigest, "generation.diffDigest");

    const candidate = clone(plan);
    const timestamp = nowIso(options.at);
    const number = plan.generation.current + 1;
    candidate.generation.current = number;
    candidate.generation.history.push({
        number,
        createdAt: timestamp,
        createdBy: clone(input.createdBy),
        planningRunId: input.planningRunId,
        feedback: input.feedback,
        diffDigest: input.diffDigest,
    });
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

export function transitionPlan(plan, nextStatus, options = {}) {
    assertPlanMutable(plan);
    if (!PLAN_STATUS_VALUES.has(nextStatus)) {
        fail("invalid_plan_status", `Unknown target plan status ${String(nextStatus)}`, {
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
    if (plan.status === PLAN_STATUS.FAILED
        && (nextStatus === PLAN_STATUS.APPROVED || nextStatus === PLAN_STATUS.RUNNING)
        && options.retry !== true) {
        fail("explicit_retry_required", "Retrying a failed plan requires retry: true", {
            path: "status",
        });
    }
    if (nextStatus === PLAN_STATUS.VERIFYING
        && plan.tasks.some((task) => task.status !== TASK_STATUS.DONE)) {
        fail("implementation_incomplete", "Verification cannot begin until every task is done", {
            path: "tasks",
        });
    }

    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    candidate.status = nextStatus;
    candidate.updatedAt = timestamp;

    if (plan.status === PLAN_STATUS.FAILED
        && (nextStatus === PLAN_STATUS.APPROVED || nextStatus === PLAN_STATUS.RUNNING)) {
        candidate.verification = emptyVerification();
    }
    if (nextStatus === PLAN_STATUS.VERIFYING) {
        assertString(options.runId, "runId", LIMITS.verificationRunId);
        if (options.backend !== "conveyor") {
            fail("invalid_verification_backend", "Verification backend must be conveyor", {
                path: "backend",
            });
        }
        if (typeof options.inputDigest !== "string"
            || !/^[a-f0-9]{64}$/.test(options.inputDigest)) {
            fail("invalid_verification_digest", "Verification inputDigest must be a SHA-256 digest", {
                path: "inputDigest",
            });
        }
        candidate.verification = {
            status: VERIFICATION_STATUS.RUNNING,
            backend: "conveyor",
            runId: options.runId,
            inputDigest: options.inputDigest,
            summary: null,
            evidence: [],
            missingEvidence: [],
            startedAt: timestamp,
            completedAt: null,
        };
    }
    if (nextStatus === PLAN_STATUS.CANCELLED
        && candidate.verification.status === VERIFICATION_STATUS.RUNNING) {
        candidate.verification = {
            ...candidate.verification,
            status: VERIFICATION_STATUS.FAILED,
            summary: "Verification was cancelled with the plan",
            missingEvidence: ["Verification did not complete"],
            completedAt: timestamp,
        };
    }
    if (nextStatus === PLAN_STATUS.APPROVED) {
        const actor = normalizeActor(options.actor);
        candidate.gates.planApprovedAt = timestamp;
        candidate.gates.planApprovedBy = actor;
    }
    if (nextStatus === PLAN_STATUS.COMPLETED) {
        const actor = normalizeActor(options.actor);
        candidate.gates.completionApprovedAt = timestamp;
        candidate.gates.completionApprovedBy = actor;
    }

    validatePlan(candidate);
    return candidate;
}

export function completeVerification(plan, result, options = {}) {
    assertPlanMutable(plan);
    if (plan.status !== PLAN_STATUS.VERIFYING
        || plan.verification.status !== VERIFICATION_STATUS.RUNNING) {
        fail("verification_not_running", "Verification can only complete from a running verification", {
            path: "verification.status",
        });
    }
    assertString(options.runId, "runId", LIMITS.verificationRunId);
    if (plan.verification.runId !== null && plan.verification.runId !== options.runId) {
        fail("verification_run_mismatch", "Verification completion runId does not match the active run", {
            path: "runId",
            details: {
                expectedRunId: plan.verification.runId,
                actualRunId: options.runId,
            },
        });
    }
    assertPlainObject(result, "result");
    assertString(result.summary, "result.summary", LIMITS.resultSummary);
    assertStringArray(result.evidence, "result.evidence", {
        maximum: LIMITS.evidence,
        itemMaximum: LIMITS.evidenceItem,
    });
    assertStringArray(result.missingEvidence, "result.missingEvidence", {
        maximum: LIMITS.missingEvidence,
        itemMaximum: LIMITS.missingEvidenceItem,
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
    if (!result.passed && result.missingEvidence.length === 0) {
        fail("invalid_verification_result", "Failed verification requires missing evidence", {
            path: "result.missingEvidence",
        });
    }

    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    candidate.verification = {
        status: result.passed ? VERIFICATION_STATUS.PASSED : VERIFICATION_STATUS.FAILED,
        backend: candidate.verification.backend,
        runId: options.runId,
        inputDigest: candidate.verification.inputDigest,
        summary: result.summary,
        evidence: clone(result.evidence),
        missingEvidence: clone(result.missingEvidence),
        startedAt: candidate.verification.startedAt,
        completedAt: timestamp,
    };
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return transitionPlan(
        candidate,
        result.passed
            ? PLAN_STATUS.AWAITING_COMPLETION_APPROVAL
            : PLAN_STATUS.FAILED,
        { at: timestamp },
    );
}

export function cancelPlan(plan, reason, options = {}) {
    assertPlanMutable(plan);
    if (!PLAN_TRANSITIONS[plan.status].has(PLAN_STATUS.CANCELLED)) {
        fail("invalid_plan_transition", `Cannot cancel a plan in ${plan.status} state`, {
            path: "status",
            details: { from: plan.status, to: PLAN_STATUS.CANCELLED },
        });
    }
    assertString(reason, "reason", LIMITS.error);
    const timestamp = nowIso(options.at);
    const candidate = clone(plan);
    for (const task of candidate.tasks) {
        if (task.status === TASK_STATUS.DONE || task.status === TASK_STATUS.CANCELLED) {
            continue;
        }
        task.status = TASK_STATUS.CANCELLED;
        task.error = reason;
        task.completedAt = timestamp;
        task.reservation = null;
    }
    if (candidate.verification.status === VERIFICATION_STATUS.RUNNING) {
        candidate.verification = {
            ...candidate.verification,
            status: VERIFICATION_STATUS.FAILED,
            summary: "Verification was cancelled with the plan",
            missingEvidence: ["Verification did not complete"],
            completedAt: timestamp,
        };
    }
    candidate.status = PLAN_STATUS.CANCELLED;
    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

export function reconcileTaskReadiness(plan, options = {}) {
    assertPlanMutable(plan);
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
        const dependencies = task.dependsOn.map((id) => byId.get(id));
        const failed = dependencies.filter(
            (dependency) => dependency.status === TASK_STATUS.FAILED
                || dependency.status === TASK_STATUS.CANCELLED,
        );
        if (failed.length > 0) {
            task.status = TASK_STATUS.BLOCKED;
            task.error = `Blocked by failed or cancelled dependencies: ${failed.map((item) => item.id).join(", ")}`;
            task.reservation = null;
            changed = true;
            continue;
        }
        if (task.status === TASK_STATUS.PLANNED
            && dependencies.every((dependency) => dependency.status === TASK_STATUS.DONE)) {
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

export function approvePlan(plan, actor, options = {}) {
    const approved = transitionPlan(plan, PLAN_STATUS.APPROVED, {
        actor,
        at: options.at,
    });
    return reconcileTaskReadiness(approved, { at: options.at });
}

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

function assertTaskDependenciesDone(plan, task) {
    const byId = taskMap(plan.tasks);
    const unmet = task.dependsOn.filter((id) => byId.get(id).status !== TASK_STATUS.DONE);
    if (unmet.length > 0) {
        fail("dependency_unmet", `Task ${task.id} has unfinished dependencies`, {
            path: "taskId",
            details: { unmet },
        });
    }
}

export function transitionTask(plan, taskId, nextStatus, options = {}) {
    assertPlanMutable(plan);
    if (!TASK_STATUS_VALUES.has(nextStatus)) {
        fail("invalid_task_status", `Unknown target task status ${String(nextStatus)}`, {
            path: "status",
        });
    }

    const candidate = clone(plan);
    const task = findTask(candidate, taskId);
    if (!TASK_TRANSITIONS[task.status].has(nextStatus)) {
        fail("invalid_task_transition", `Cannot move task ${task.id} from ${task.status} to ${nextStatus}`, {
            path: "status",
            details: { taskId, from: task.status, to: nextStatus },
        });
    }
    if ((task.status === TASK_STATUS.BLOCKED || task.status === TASK_STATUS.FAILED)
        && nextStatus === TASK_STATUS.READY
        && options.retry !== true) {
        fail("explicit_retry_required", `Retrying task ${task.id} requires retry: true`, {
            path: "status",
        });
    }
    if ((task.status === TASK_STATUS.PLANNED || task.status === TASK_STATUS.READY)
        && nextStatus === TASK_STATUS.BLOCKED
        && options.cause !== "dependency") {
        fail("invalid_task_transition", "Pre-start tasks can only be blocked by a dependency result", {
            path: "status",
        });
    }
    if (nextStatus === TASK_STATUS.READY
        && candidate.status !== PLAN_STATUS.APPROVED
        && candidate.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_approved", `Task ${task.id} cannot become ready while the plan is ${candidate.status}`, {
            path: "status",
        });
    }
    if (nextStatus === TASK_STATUS.RUNNING && candidate.status !== PLAN_STATUS.RUNNING) {
        fail("plan_not_running", `Task ${task.id} cannot start while the plan is ${candidate.status}`, {
            path: "status",
        });
    }

    const timestamp = nowIso(options.at);
    if (nextStatus === TASK_STATUS.READY) {
        assertTaskDependenciesDone(candidate, task);
        Object.assign(task, {
            status: TASK_STATUS.READY,
            sessionId: null,
            branch: null,
            prUrl: null,
            resultSummary: null,
            evidence: [],
            error: null,
            startedAt: null,
            completedAt: null,
            reservation: null,
        });
    } else if (nextStatus === TASK_STATUS.RUNNING) {
        assertString(options.sessionId, "sessionId", LIMITS.sessionId);
        task.status = TASK_STATUS.RUNNING;
        task.sessionId = options.sessionId;
        task.branch = options.branch ?? null;
        task.startedAt = timestamp;
    } else if (nextStatus === TASK_STATUS.DONE) {
        assertString(options.resultSummary, "resultSummary", LIMITS.resultSummary);
        assertStringArray(options.evidence, "evidence", {
            minimum: 1,
            maximum: LIMITS.evidence,
            itemMaximum: LIMITS.evidenceItem,
        });
        task.status = TASK_STATUS.DONE;
        task.resultSummary = options.resultSummary;
        task.evidence = clone(options.evidence);
        task.branch = options.branch ?? task.branch;
        task.prUrl = options.prUrl ?? task.prUrl;
        task.error = null;
        task.completedAt = timestamp;
        task.reservation = null;
    } else if (nextStatus === TASK_STATUS.FAILED) {
        assertString(options.error, "error", LIMITS.error);
        task.status = TASK_STATUS.FAILED;
        task.error = options.error;
        task.resultSummary = options.resultSummary ?? null;
        task.evidence = clone(options.evidence ?? []);
        task.branch = options.branch ?? task.branch;
        task.prUrl = options.prUrl ?? task.prUrl;
        task.completedAt = timestamp;
        task.reservation = null;
    } else if (nextStatus === TASK_STATUS.BLOCKED) {
        assertString(options.error, "error", LIMITS.error);
        task.status = TASK_STATUS.BLOCKED;
        task.error = options.error;
        task.reservation = null;
    } else if (nextStatus === TASK_STATUS.CANCELLED) {
        assertString(options.error, "error", LIMITS.error);
        task.status = TASK_STATUS.CANCELLED;
        task.error = options.error;
        task.completedAt = timestamp;
        task.reservation = null;
    }

    candidate.updatedAt = timestamp;
    validatePlan(candidate);
    return candidate;
}

export function retryTask(plan, taskId, options = {}) {
    return transitionTask(plan, taskId, TASK_STATUS.READY, {
        retry: true,
        at: options.at,
    });
}

export function getReadyTasks(plan) {
    validatePlan(plan);
    const byId = taskMap(plan.tasks);
    return plan.tasks
        .filter((task) => task.status === TASK_STATUS.READY
            && task.dependsOn.every((id) => byId.get(id).status === TASK_STATUS.DONE))
        .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
        .map(clone);
}

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
        planningRunId: plan.planning?.runId ?? null,
        verificationStatus: plan.verification.status,
        updatedAt: plan.updatedAt,
    };
}

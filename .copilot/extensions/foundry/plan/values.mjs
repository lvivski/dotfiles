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

/** Persisted identifier namespace sizes, not prose or execution budgets. */
export const LIMITS = Object.freeze({
	planId: 64,
	tasks: 999,
	attempts: 999,
	attemptId: 10,
	requestId: 128,
	evidence: 999,
});

/** Strict persisted plan ID syntax shared by domain and provider schemas. */
export const PLAN_ID_PATTERN = "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$";

/** Compiled strict persisted plan ID syntax. */
export const PLAN_ID_REGEX = new RegExp(PLAN_ID_PATTERN);

/** Strict task ID syntax. */
export const TASK_ID_PATTERN = /^T-\d{3}$/;

/** Strict task-attempt ID syntax. */
export const ATTEMPT_ID_PATTERN = /^T-\d{3}-A\d{3}$/;

/** Strict evidence ID syntax. */
export const EVIDENCE_ID_PATTERN = /^T-\d{3}-A\d{3}-E\d{3}$/;

/** Stable idempotency request ID syntax. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const TASK_KINDS = /** @type {const} */ (["implement", "verify"]);

export const PLAN_STATUS_VALUES = Object.values(PLAN_STATUS);

/** @type {Set<string>} */
export const TASK_STATUS_VALUES = new Set(Object.values(TASK_STATUS).filter((status) => status !== TASK_STATUS.READY));

export const ATTEMPT_STATUS_VALUES = Object.values(ATTEMPT_STATUS);

export const EVIDENCE_TYPE_VALUES = Object.values(EVIDENCE_TYPE);

export const EVIDENCE_OUTCOME_VALUES = Object.values(EVIDENCE_OUTCOME);

export const VERIFICATION_STATUS_VALUES = Object.values(VERIFICATION_STATUS);

export const DELIVERY_REQUIREMENT_VALUES = Object.values(DELIVERY_REQUIREMENT);

/** Attempt states that hold task execution ownership. */
/** @type {Set<string>} */
export const ACTIVE_ATTEMPT_STATUSES = new Set([
	ATTEMPT_STATUS.RESERVED,
	ATTEMPT_STATUS.RUNNING,
	ATTEMPT_STATUS.CANCEL_REQUESTED,
]);

/** Attempt outcomes accepted by terminal completion. */
export const TERMINAL_ATTEMPT_RESULTS = [
	ATTEMPT_STATUS.DONE,
	ATTEMPT_STATUS.FAILED,
	ATTEMPT_STATUS.BLOCKED,
];

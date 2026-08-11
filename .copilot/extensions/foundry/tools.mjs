/**
 * Agent-facing Foundry tool declarations and JSON Schemas.
 *
 * @module foundry/tools
 */
import {
    EVIDENCE_OUTCOME,
    EVIDENCE_TYPE,
    LIMITS,
    PLAN_STATUS,
    TASK_STATUS,
} from "./domain.mjs";

/**
 * @typedef {object} ToolResult
 * @property {string} textResultForLlm
 * @property {"success"|"failure"|"rejected"|"denied"} resultType
 * @property {{extension: string, outcome: string}} toolTelemetry
 */

/** @typedef {Record<string, any>} JsonSchema */

/**
 * Wraps a value in the structured SDK tool-result contract.
 *
 * @param {unknown} value
 * @param {"success"|"failure"|"rejected"|"denied"} [resultType]
 * @returns {ToolResult}
 */
function result(value, resultType = "success") {
    return {
        textResultForLlm: JSON.stringify(value),
        resultType,
        toolTelemetry: {
            extension: "foundry",
            outcome: resultType,
        },
    };
}

/**
 * Converts an arbitrary thrown value into the stable Foundry error envelope.
 *
 * @param {any} error
 * @returns {{ok: false, error: {code: string, message: string, path: unknown, details: unknown}}}
 */
function errorPayload(error) {
    return {
        ok: false,
        error: {
            code: error?.code ?? "foundry_internal_error",
            message: error?.message ?? String(error),
            path: error?.path ?? null,
            details: error?.details ?? null,
        },
    };
}

/**
 * Adapts an operation to the SDK tool handler contract.
 *
 * @param {(args: any, invocation: any) => unknown | Promise<unknown>} operation
 * @returns {(args: any, invocation: any) => Promise<ToolResult>}
 */
function handler(operation) {
    return async (args, invocation) => {
        try {
            const value = await operation(args, invocation);
            return result({ ok: true, value });
        } catch (error) {
            return result(errorPayload(error), "failure");
        }
    };
}

/** JSON Schema for stable plan IDs. */
const PLAN_ID = {
    type: "string",
    pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
    maxLength: LIMITS.planId,
};
/** JSON Schema for task IDs. */
const TASK_ID = {
    type: "string",
    pattern: "^T-\\d{3}$",
};
/** JSON Schema for task-attempt IDs. */
const ATTEMPT_ID = {
    type: "string",
    pattern: "^T-\\d{3}-A\\d{3}$",
    maxLength: LIMITS.attemptId,
};
/** JSON Schema for idempotency and cancellation request IDs. */
const REQUEST_ID = {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    maxLength: LIMITS.requestId,
};
/** JSON Schema for optimistic-concurrency revisions. */
const REVISION = {
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
/**
 * Creates a bounded non-empty string schema.
 *
 * @param {number} maximum
 * @returns {JsonSchema}
 */
const NON_EMPTY = (maximum) => ({
    type: "string",
    minLength: 1,
    maxLength: maximum,
});
/**
 * Creates a bounded array-of-strings schema.
 *
 * @param {number} maximum
 * @param {number} itemMaximum
 * @param {number} [minimum]
 * @returns {JsonSchema}
 */
const STRING_LIST = (maximum, itemMaximum, minimum = 0) => ({
    type: "array",
    minItems: minimum,
    maxItems: maximum,
    items: NON_EMPTY(itemMaximum),
});
/**
 * Creates a closed object schema.
 *
 * @param {string[]} required
 * @param {Record<string, unknown>} properties
 * @returns {JsonSchema}
 */
function objectSchema(required, properties) {
    return {
        type: "object",
        additionalProperties: false,
        required,
        properties,
    };
}

/** JSON Schema for caller-supplied claimed evidence. */
const EVIDENCE_INPUT = objectSchema(
    ["type", "summary", "outcome"],
    {
        type: { type: "string", enum: Object.values(EVIDENCE_TYPE) },
        summary: NON_EMPTY(LIMITS.evidenceItem),
        source: NON_EMPTY(LIMITS.evidenceSource),
        outcome: { type: "string", enum: Object.values(EVIDENCE_OUTCOME) },
		checkId: NON_EMPTY(32),
    },
);

/** JSON Schema for an explicitly complete or partial App session inventory. */
const SESSION_INVENTORY = objectSchema(
    ["complete", "capturedAt", "sessions"],
    {
        complete: { type: "boolean" },
        capturedAt: NON_EMPTY(64),
        sessions: {
            type: "array",
            maxItems: 1_000,
            items: objectSchema(
                ["id", "status"],
                {
                    id: NON_EMPTY(LIMITS.sessionId),
                    status: NON_EMPTY(64),
                },
            ),
        },
    },
);

/**
 * Builds the complete globally unique Foundry tool catalog.
 *
 * @param {any} operations
 * @returns {any[]} SDK tool declarations.
 */
export function buildFoundryTools(operations) {
    return [
        {
            name: "foundry_prepare_plan",
            skipPermission: true,
			description: "Validate planning input and return the exact native plan Factory launchSpec. Run it once with run_factory, then import the completed run.",
            parameters: objectSchema(
                ["objective", "repositoryContext"],
                {
                    objective: NON_EMPTY(LIMITS.objective),
                    constraints: STRING_LIST(LIMITS.constraints, LIMITS.constraint),
                    repositoryContext: NON_EMPTY(16_000),
                    maxTasks: {
                        type: "integer",
                        minimum: 1,
                        maximum: 12,
                        default: 6,
                    },
                },
            ),
            handler: handler((args) => operations.preparePlan(args)),
        },
        {
            name: "foundry_create_plan",
			description: "Import a completed native plan Factory run as a new draft. The caller supplies the stable plan ID and repository; creating requires expectedRevision: 0.",
            parameters: objectSchema(
                ["expectedRevision", "id", "runId", "repository"],
                {
                    expectedRevision: { const: 0 },
                    id: PLAN_ID,
                    runId: NON_EMPTY(LIMITS.verificationRunId),
                    repository: objectSchema(
                        ["workingDirectory", "baseBranch"],
                        {
                            workingDirectory: NON_EMPTY(LIMITS.repositoryPath),
                            baseBranch: NON_EMPTY(LIMITS.baseBranch),
                        },
                    ),
                },
            ),
            handler: handler((args) => operations.createPlan(args)),
        },
        {
            name: "foundry_get_plan",
            skipPermission: true,
            description: "Read one validated Foundry plan by stable plan ID.",
            parameters: objectSchema(["planId"], { planId: PLAN_ID }),
            handler: handler((args) => operations.getPlan(args)),
        },
        {
            name: "foundry_get_status",
            skipPermission: true,
            description: "Return the validated plan plus a derived recovery projection. Session absence is reported only when the caller supplies a complete host session inventory.",
            parameters: objectSchema(
                ["planId"],
                {
                    planId: PLAN_ID,
                    sessionInventory: SESSION_INVENTORY,
                },
            ),
            handler: handler((args) => operations.getStatus(args)),
        },
        {
            name: "foundry_list_plans",
            skipPermission: true,
            description: "List bounded Foundry plan summaries for the current Copilot session.",
            parameters: objectSchema([], {
                limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            }),
            handler: handler((args) => operations.listPlans(args)),
        },
        {
            name: "foundry_submit_plan",
            description: "Submit a draft Foundry plan for explicit user approval.",
            parameters: objectSchema(
                ["planId", "expectedRevision"],
                { planId: PLAN_ID, expectedRevision: REVISION },
            ),
            handler: handler((args) => operations.submitPlan(args)),
        },
        {
            name: "foundry_approve_plan",
            description: "Record explicit plan approval, completion approval, or an explicit failed-plan retry. Initial approval computes dependency-ready tasks.",
            parameters: objectSchema(
                ["planId", "expectedRevision", "approvedBy", "approvalType"],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    approvedBy: NON_EMPTY(LIMITS.actor),
                    approvalType: {
                        type: "string",
                        enum: ["plan", "completion", "retry"],
                    },
                    retryStatus: {
                        const: PLAN_STATUS.RUNNING,
                        default: PLAN_STATUS.RUNNING,
                    },
                },
            ),
            handler: handler((args) => operations.approve(args)),
        },
        {
            name: "foundry_next_tasks",
            skipPermission: true,
            description: "Return dependency-ready tasks, deterministic delivery guidance, and scope holds. Reserve a dispatchable task before creating its App child session.",
            parameters: objectSchema(["planId"], { planId: PLAN_ID }),
            handler: handler((args) => operations.nextTasks(args)),
        },
        {
            name: "foundry_reserve_task",
            description: "Atomically reserve one ready task before create_session. Returns the attempt ID, exact base branch, integration requirements, and delegation prompt. Reusing reservationId returns the same reservation.",
            parameters: objectSchema(
                ["planId", "taskId", "expectedRevision", "reservationId"],
                {
                    planId: PLAN_ID,
                    taskId: TASK_ID,
                    expectedRevision: REVISION,
                    reservationId: REQUEST_ID,
                    scopeOverride: objectSchema(
                        ["approvedBy", "reason"],
                        {
                            approvedBy: NON_EMPTY(LIMITS.actor),
                            reason: NON_EMPTY(LIMITS.error),
                        },
                    ),
                },
            ),
            handler: handler((args) => operations.reserveTask(args)),
        },
        {
            name: "foundry_attach_task",
            description: "Attach the App-created child session to an existing reserved attempt. Identical attachment is idempotent; replacement is rejected.",
            parameters: objectSchema(
                ["planId", "taskId", "attemptId", "expectedRevision", "sessionId"],
                {
                    planId: PLAN_ID,
                    taskId: TASK_ID,
                    attemptId: ATTEMPT_ID,
                    expectedRevision: REVISION,
                    sessionId: NON_EMPTY(LIMITS.sessionId),
                    branch: NON_EMPTY(LIMITS.branch),
                },
            ),
            handler: handler((args) => operations.attachTask(args)),
        },
        {
            name: "foundry_complete_task",
			description: "Record the active attempt's done, failed, or blocked result. Verifier evidence is canonicalized by checkId; attached failures require terminal session inventory.",
            parameters: objectSchema(
                ["planId", "taskId", "attemptId", "expectedRevision", "status"],
                {
                    planId: PLAN_ID,
                    taskId: TASK_ID,
                    attemptId: ATTEMPT_ID,
                    expectedRevision: REVISION,
                    status: {
                        type: "string",
                        enum: [TASK_STATUS.DONE, TASK_STATUS.FAILED, TASK_STATUS.BLOCKED],
                    },
                    resultSummary: NON_EMPTY(LIMITS.resultSummary),
                    evidence: {
                        type: "array",
                        maxItems: LIMITS.evidence,
                        items: EVIDENCE_INPUT,
                    },
                    error: NON_EMPTY(LIMITS.error),
                    branch: NON_EMPTY(LIMITS.branch),
                    commit: {
                        type: "string",
						pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
                        maxLength: LIMITS.commit,
                    },
                    prUrl: NON_EMPTY(LIMITS.prUrl),
					sessionInventory: SESSION_INVENTORY,
                },
            ),
            handler: handler((args) => operations.completeTask(args)),
        },
        {
            name: "foundry_retry_task",
            description: "Explicitly move an eligible failed or blocked task back to ready after its dependencies are done.",
            parameters: objectSchema(
                ["planId", "taskId", "expectedRevision"],
                {
                    planId: PLAN_ID,
                    taskId: TASK_ID,
                    expectedRevision: REVISION,
                },
            ),
            handler: handler((args) => operations.retry(args)),
        },
        {
            name: "foundry_prepare_verification",
			description: "Persist a verification launch reservation before returning the exact native verify Factory launchSpec. Inconclusive discovery never relaunches; replacing a terminal non-importable run requires a new reservation plus replacementReason and requestedBy.",
            parameters: objectSchema(
                ["planId", "expectedRevision", "reservationId"],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    reservationId: REQUEST_ID,
					replacementReason: NON_EMPTY(LIMITS.error),
					requestedBy: NON_EMPTY(LIMITS.actor),
                },
            ),
            handler: handler((args) => operations.prepareVerification(args)),
        },
        {
            name: "foundry_complete_verification",
			description: "Import the exact terminal verify Factory result for the active reservation. No caller-supplied verdict is accepted.",
            parameters: objectSchema(
                ["planId", "expectedRevision", "runId"],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    runId: NON_EMPTY(LIMITS.verificationRunId),
                },
            ),
            handler: handler((args) => operations.finishVerification(args)),
        },
        {
            name: "foundry_cancel",
			description: "Request plan cancellation and snapshot active task attempts plus any Factory run discovered for the verification reservation. This does not claim external work has stopped.",
            parameters: objectSchema(
                [
                    "planId",
                    "expectedRevision",
                    "requestId",
                    "reason",
                    "requestedBy",
                ],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    requestId: REQUEST_ID,
                    reason: NON_EMPTY(LIMITS.error),
                    requestedBy: NON_EMPTY(LIMITS.actor),
                },
            ),
            handler: handler((args) => operations.cancel(args)),
        },
		{
			name: "foundry_cancel_verification_run",
			description: "Durably bind and cancel only the authoritative verification Factory run owned by the active cancellation request. Returns the new revision and exact disposition required for finalization; never accepts a caller-supplied run ID.",
			parameters: objectSchema(
				["planId", "expectedRevision", "requestId"],
				{
					planId: PLAN_ID,
					expectedRevision: REVISION,
					requestId: REQUEST_ID,
				},
			),
			handler: handler((args) => operations.cancelVerificationRun(args)),
		},
		{
            name: "foundry_finalize_cancellation",
			description: "Finalize cancellation using a complete causal session inventory and terminal Factory evidence. Inconclusive evidence requires an attributed finalizationOverride.",
            parameters: objectSchema(
				[
					"planId",
					"expectedRevision",
					"dispositions",
					"finalizedBy",
					"sessionInventory",
				],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    finalizedBy: NON_EMPTY(LIMITS.actor),
                    verificationDisposition: {
                        type: "string",
                        enum: ["run-terminated", "no-run-created"],
                    },
					finalizationOverride: objectSchema(
						["reason", "attestedBy"],
						{
							reason: NON_EMPTY(LIMITS.error),
							attestedBy: NON_EMPTY(LIMITS.actor),
						},
					),
					sessionInventory: SESSION_INVENTORY,
                    dispositions: {
                        type: "array",
						maxItems: LIMITS.tasks,
                        items: objectSchema(
                            ["attemptId", "disposition"],
                            {
								attemptId: ATTEMPT_ID,
                                disposition: {
                                    type: "string",
                                    enum: ["session-terminated", "no-session-created"],
                                },
                                sessionId: NON_EMPTY(LIMITS.sessionId),
                            },
                        ),
                    },
                },
            ),
            handler: handler((args) => operations.finalizeCancellation(args)),
        },
        {
            name: "foundry_activate_plan",
            description: "Explicitly activate one Foundry plan's coordinator context and conservative guardrail hooks for this Copilot session.",
            parameters: objectSchema(
                ["planId", "expectedRevision"],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                },
            ),
            handler: handler((args) => operations.activate(args)),
        },
        {
            name: "foundry_deactivate_plan",
            description: "Deactivate Foundry coordinator context and guardrail hooks for this Copilot session.",
            parameters: objectSchema([], {}),
            handler: handler(() => operations.deactivate()),
        },
    ];
}

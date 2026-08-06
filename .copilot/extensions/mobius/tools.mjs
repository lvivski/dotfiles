import { LIMITS, PLAN_STATUS, TASK_STATUS } from "./domain.mjs";

function result(value, resultType = "success") {
    return {
        textResultForLlm: JSON.stringify(value),
        resultType,
        toolTelemetry: {
            extension: "mobius",
            outcome: resultType,
        },
    };
}

function errorPayload(error) {
    return {
        ok: false,
        error: {
            code: error?.code ?? "mobius_internal_error",
            message: error?.message ?? String(error),
            path: error?.path ?? null,
            details: error?.details ?? null,
        },
    };
}

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

const PLAN_ID = {
    type: "string",
    pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$",
    maxLength: LIMITS.planId,
};
const TASK_ID = {
    type: "string",
    pattern: "^T-\\d{3}$",
};
const REVISION = {
    type: "integer",
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
};
const NON_EMPTY = (maximum) => ({
    type: "string",
    minLength: 1,
    maxLength: maximum,
});
const STRING_LIST = (maximum, itemMaximum, minimum = 0) => ({
    type: "array",
    minItems: minimum,
    maxItems: maximum,
    items: NON_EMPTY(itemMaximum),
});
function objectSchema(required, properties) {
    return {
        type: "object",
        additionalProperties: false,
        required,
        properties,
    };
}

export function buildMobiusTools(operations) {
    return [
        {
            name: "mobius_prepare_plan",
            skipPermission: true,
            description: "Validate planning input and return the exact restricted Conveyor launchSpec. Preview that spec with the Conveyor run tool, then launch the immutable preview plan before importing its run.",
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
            name: "mobius_create_plan",
            description: "Import a completed, pinned, restricted mobius-plan Conveyor run as a new draft. The caller supplies the stable plan ID and repository; creating requires expectedRevision: 0.",
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
            name: "mobius_get_plan",
            skipPermission: true,
            description: "Read one validated Mobius plan by stable plan ID.",
            parameters: objectSchema(["planId"], { planId: PLAN_ID }),
            handler: handler((args) => operations.getPlan(args)),
        },
        {
            name: "mobius_list_plans",
            skipPermission: true,
            description: "List bounded Mobius plan summaries for the current Copilot session.",
            parameters: objectSchema([], {
                limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            }),
            handler: handler((args) => operations.listPlans(args)),
        },
        {
            name: "mobius_submit_plan",
            description: "Submit a draft Mobius plan for explicit user approval.",
            parameters: objectSchema(
                ["planId", "expectedRevision"],
                { planId: PLAN_ID, expectedRevision: REVISION },
            ),
            handler: handler((args) => operations.submitPlan(args)),
        },
        {
            name: "mobius_approve_plan",
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
            name: "mobius_next_tasks",
            skipPermission: true,
            description: "Return every dependency-ready task in deterministic ID order, complete child-session prompts, and file-scope overlap warnings. Launch only dispatchableTaskIds unless the user explicitly accepts overlap risk.",
            parameters: objectSchema(["planId"], { planId: PLAN_ID }),
            handler: handler((args) => operations.nextTasks(args)),
        },
        {
            name: "mobius_start_task",
            description: "Record the App-created child session ID and optional branch for one ready Mobius task.",
            parameters: objectSchema(
                ["planId", "taskId", "expectedRevision", "sessionId"],
                {
                    planId: PLAN_ID,
                    taskId: TASK_ID,
                    expectedRevision: REVISION,
                    sessionId: NON_EMPTY(LIMITS.sessionId),
                    branch: NON_EMPTY(LIMITS.branch),
                },
            ),
            handler: handler((args) => operations.startTask(args)),
        },
        {
            name: "mobius_complete_task",
            description: "Record a child task's done, failed, or blocked result with evidence, branch, and optional pull request URL.",
            parameters: objectSchema(
                ["planId", "taskId", "expectedRevision", "status"],
                {
                    planId: PLAN_ID,
                    taskId: TASK_ID,
                    expectedRevision: REVISION,
                    status: {
                        type: "string",
                        enum: [TASK_STATUS.DONE, TASK_STATUS.FAILED, TASK_STATUS.BLOCKED],
                    },
                    resultSummary: NON_EMPTY(LIMITS.resultSummary),
                    evidence: STRING_LIST(LIMITS.evidence, LIMITS.evidenceItem),
                    error: NON_EMPTY(LIMITS.error),
                    branch: NON_EMPTY(LIMITS.branch),
                    prUrl: NON_EMPTY(LIMITS.prUrl),
                },
            ),
            handler: handler((args) => operations.completeTask(args)),
        },
        {
            name: "mobius_retry_task",
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
            name: "mobius_prepare_verification",
            skipPermission: true,
            description: "Return the exact restricted Conveyor launchSpec for verifying a Mobius plan whose implementation tasks are done. Preview and launch it before binding the returned run ID.",
            parameters: objectSchema(["planId"], { planId: PLAN_ID }),
            handler: handler((args) => operations.prepareVerification(args)),
        },
        {
            name: "mobius_begin_verification",
            description: "Bind a running or completed pinned mobius-verify Conveyor run to the plan. Rebinding is allowed only after the prior run terminated without an importable result.",
            parameters: objectSchema(
                ["planId", "expectedRevision", "runId"],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    runId: NON_EMPTY(LIMITS.verificationRunId),
                },
            ),
            handler: handler((args) => operations.beginVerification(args)),
        },
        {
            name: "mobius_complete_verification",
            description: "Import the exact persisted result of the bound completed mobius-verify Conveyor run. No caller-supplied verdict is accepted.",
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
            name: "mobius_cancel",
            description: "Cancel a Mobius task or entire plan with an explicit reason. Every v1 task is required, so cancelling one task cancels the entire plan.",
            parameters: objectSchema(
                ["planId", "expectedRevision", "target", "reason"],
                {
                    planId: PLAN_ID,
                    expectedRevision: REVISION,
                    target: { type: "string", enum: ["plan", "task"] },
                    taskId: TASK_ID,
                    reason: NON_EMPTY(LIMITS.error),
                },
            ),
            handler: handler((args) => operations.cancel(args)),
        },
        {
            name: "mobius_activate_plan",
            description: "Explicitly activate one Mobius plan's coordinator context and conservative guardrail hooks for this Copilot session.",
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
            name: "mobius_deactivate_plan",
            description: "Deactivate Mobius coordinator context and guardrail hooks for this Copilot session.",
            parameters: objectSchema([], {}),
            handler: handler(() => operations.deactivate()),
        },
    ];
}

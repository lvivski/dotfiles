import assert from "node:assert/strict";
import test from "node:test";

import { buildMobiusTools } from "./tools.mjs";

function operationsStub() {
    return new Proxy({}, {
        get: (_target, name) => async (input) => ({ operation: String(name), input }),
    });
}

test("Mobius registers the complete globally unique tool surface", () => {
    const tools = buildMobiusTools(operationsStub());
    assert.deepEqual(tools.map((tool) => tool.name), [
        "mobius_prepare_plan",
        "mobius_create_plan",
        "mobius_get_plan",
        "mobius_get_status",
        "mobius_list_plans",
        "mobius_submit_plan",
        "mobius_approve_plan",
        "mobius_next_tasks",
        "mobius_reserve_task",
        "mobius_attach_task",
        "mobius_complete_task",
        "mobius_retry_task",
        "mobius_prepare_verification",
        "mobius_complete_verification",
        "mobius_cancel",
		"mobius_cancel_verification_run",
        "mobius_finalize_cancellation",
        "mobius_activate_plan",
        "mobius_deactivate_plan",
    ]);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    const approve = tools.find((tool) => tool.name === "mobius_approve_plan");
    assert.equal(approve.parameters.properties.retryStatus.const, "running");
    const create = tools.find((tool) => tool.name === "mobius_create_plan");
    assert.deepEqual(create.parameters.required, [
        "expectedRevision",
        "id",
        "runId",
        "repository",
    ]);
    const completeVerification = tools.find(
        (tool) => tool.name === "mobius_complete_verification",
    );
    assert.deepEqual(completeVerification.parameters.required, [
        "planId",
        "expectedRevision",
        "runId",
    ]);
    const prepareVerification = tools.find(
        (tool) => tool.name === "mobius_prepare_verification",
    );
    assert.deepEqual(prepareVerification.parameters.required, [
        "planId",
        "expectedRevision",
        "reservationId",
    ]);
    assert.equal(prepareVerification.skipPermission, undefined);
    const reserve = tools.find((tool) => tool.name === "mobius_reserve_task");
    assert.deepEqual(reserve.parameters.required, [
        "planId",
        "taskId",
        "expectedRevision",
        "reservationId",
    ]);
    const completeTask = tools.find((tool) => tool.name === "mobius_complete_task");
    assert.equal(
        completeTask.parameters.properties.evidence.items.properties.trust,
        undefined,
    );
	assert.ok(completeTask.parameters.properties.evidence.items.properties.checkId);
	assert.ok(completeTask.parameters.properties.sessionInventory);
    const cancel = tools.find((tool) => tool.name === "mobius_cancel");
    assert.ok(cancel.parameters.required.includes("requestedBy"));
    assert.ok(cancel.parameters.required.includes("requestId"));
	const cancelVerification = tools.find(
		(tool) => tool.name === "mobius_cancel_verification_run",
	);
	assert.deepEqual(cancelVerification.parameters.required, [
		"planId",
		"expectedRevision",
		"requestId",
	]);
	const finalize = tools.find((tool) => tool.name === "mobius_finalize_cancellation");
	assert.ok(finalize.parameters.required.includes("sessionInventory"));
});

test("tool handlers return structured success and failure envelopes", async () => {
    const successTools = buildMobiusTools(operationsStub());
    const success = await successTools.find((tool) => tool.name === "mobius_get_plan")
        .handler({ planId: "sample-plan" }, {
            sessionId: "session",
            toolCallId: "call",
            toolName: "mobius_get_plan",
        });
    assert.equal(success.resultType, "success");
    assert.equal(JSON.parse(success.textResultForLlm).ok, true);

    const failureTools = buildMobiusTools(new Proxy({}, {
        get: () => async () => {
            /** @type {Error & {code?: string, details?: any}} */
            const error = new Error("stale revision");
            error.code = "revision_conflict";
            error.details = { latestRevision: 3 };
            throw error;
        },
    }));
    const failure = await failureTools.find((tool) => tool.name === "mobius_submit_plan")
        .handler({ planId: "sample-plan", expectedRevision: 2 }, {
            sessionId: "session",
            toolCallId: "call",
            toolName: "mobius_submit_plan",
        });
    assert.equal(failure.resultType, "failure");
    assert.deepEqual(JSON.parse(failure.textResultForLlm), {
        ok: false,
        error: {
            code: "revision_conflict",
            message: "stale revision",
            path: null,
            details: { latestRevision: 3 },
        },
    });
});

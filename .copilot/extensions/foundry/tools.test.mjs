import assert from "node:assert/strict";
import test from "node:test";

import { buildFoundryTools } from "./tools.mjs";

function operationsStub() {
    return new Proxy({}, {
        get: (_target, name) => async (input) => ({ operation: String(name), input }),
    });
}

test("Foundry registers the complete globally unique tool surface", () => {
    const tools = buildFoundryTools(operationsStub());
    assert.deepEqual(tools.map((tool) => tool.name), [
        "foundry_prepare_plan",
        "foundry_create_plan",
        "foundry_get_plan",
        "foundry_get_status",
        "foundry_list_plans",
		"foundry_quarantine_plan",
        "foundry_submit_plan",
        "foundry_approve_plan",
        "foundry_next_tasks",
        "foundry_reserve_task",
        "foundry_attach_task",
        "foundry_complete_task",
        "foundry_retry_task",
        "foundry_prepare_verification",
        "foundry_complete_verification",
        "foundry_cancel",
		"foundry_cancel_verification_run",
        "foundry_finalize_cancellation",
        "foundry_activate_plan",
        "foundry_deactivate_plan",
    ]);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
    const approve = tools.find((tool) => tool.name === "foundry_approve_plan");
    assert.equal(approve.parameters.properties.retryStatus.const, "running");
    const create = tools.find((tool) => tool.name === "foundry_create_plan");
    assert.deepEqual(create.parameters.required, [
        "expectedRevision",
        "id",
        "runId",
        "repository",
    ]);
    const completeVerification = tools.find(
        (tool) => tool.name === "foundry_complete_verification",
    );
    assert.deepEqual(completeVerification.parameters.required, [
        "planId",
        "expectedRevision",
        "runId",
    ]);
    const prepareVerification = tools.find(
        (tool) => tool.name === "foundry_prepare_verification",
    );
    assert.deepEqual(prepareVerification.parameters.required, [
        "planId",
        "expectedRevision",
        "reservationId",
    ]);
    assert.equal(prepareVerification.skipPermission, undefined);
    const reserve = tools.find((tool) => tool.name === "foundry_reserve_task");
    assert.deepEqual(reserve.parameters.required, [
        "planId",
        "taskId",
        "expectedRevision",
        "reservationId",
    ]);
    const completeTask = tools.find((tool) => tool.name === "foundry_complete_task");
    assert.equal(
        completeTask.parameters.properties.evidence.items.properties.trust,
        undefined,
    );
	assert.ok(completeTask.parameters.properties.evidence.items.properties.checkId);
	assert.ok(completeTask.parameters.properties.sessionInventory);
    const cancel = tools.find((tool) => tool.name === "foundry_cancel");
    assert.ok(cancel.parameters.required.includes("requestedBy"));
    assert.ok(cancel.parameters.required.includes("requestId"));
	const quarantine = tools.find((tool) => tool.name === "foundry_quarantine_plan");
	assert.equal(quarantine.skipPermission, undefined);
	assert.deepEqual(quarantine.parameters.required, [
		"planId",
		"reason",
		"requestedBy",
	]);
	const cancelVerification = tools.find(
		(tool) => tool.name === "foundry_cancel_verification_run",
	);
	assert.deepEqual(cancelVerification.parameters.required, [
		"planId",
		"expectedRevision",
		"requestId",
	]);
	const finalize = tools.find((tool) => tool.name === "foundry_finalize_cancellation");
	assert.ok(finalize.parameters.required.includes("sessionInventory"));
});

test("tool handlers return structured success and failure envelopes", async () => {
    const successTools = buildFoundryTools(operationsStub());
    const success = await successTools.find((tool) => tool.name === "foundry_get_plan")
        .handler({ planId: "sample-plan" }, {
            sessionId: "session",
            toolCallId: "call",
            toolName: "foundry_get_plan",
        });
    assert.equal(success.resultType, "success");
    assert.equal(JSON.parse(success.textResultForLlm).ok, true);

    const failureTools = buildFoundryTools(new Proxy({}, {
        get: () => async () => {
            /** @type {Error & {code?: string, details?: any}} */
            const error = new Error("stale revision");
            error.code = "revision_conflict";
            error.details = { latestRevision: 3 };
            throw error;
        },
    }));
    const failure = await failureTools.find((tool) => tool.name === "foundry_submit_plan")
        .handler({ planId: "sample-plan", expectedRevision: 2 }, {
            sessionId: "session",
            toolCallId: "call",
            toolName: "foundry_submit_plan",
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

import assert from "node:assert/strict";
import test from "node:test";

import { buildFoundryTools } from "./tools.mjs";

function operationsStub() {
    return new Proxy({}, {
        get: (_target, name) => async (input) => ({ operation: String(name), input }),
    });
}

/** @param {ReturnType<typeof buildFoundryTools>} tools @param {string} name */
function toolNamed(tools, name) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `Missing tool ${name}`);
    return tool;
}

test("Foundry registers the complete globally unique tool surface", () => {
    const tools = buildFoundryTools(operationsStub());
    assert.deepEqual(tools.map((tool) => tool.name), [
        "foundry_prepare_plan",
        "foundry_create_plan",
		"foundry_control_workflow",
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
	const control = toolNamed(tools, "foundry_control_workflow");
	assert.equal(control.skipPermission, undefined);
	assert.deepEqual(control.parameters.required, ["runId", "action"]);
	assert.deepEqual(control.parameters.properties.action.enum, ["pause", "resume"]);
	assert.ok(control.parameters.properties.planId);
	assert.ok(control.parameters.properties.expectedRevision);
    const approve = toolNamed(tools, "foundry_approve_plan");
    assert.equal(approve.parameters.properties.retryStatus.const, "running");
    const create = toolNamed(tools, "foundry_create_plan");
    assert.deepEqual(create.parameters.required, [
        "expectedRevision",
        "id",
        "runId",
        "repository",
    ]);
    const completeVerification = toolNamed(tools, "foundry_complete_verification");
    assert.deepEqual(completeVerification.parameters.required, [
        "planId",
        "expectedRevision",
        "runId",
    ]);
    const prepareVerification = toolNamed(tools, "foundry_prepare_verification");
    assert.deepEqual(prepareVerification.parameters.required, [
        "planId",
        "expectedRevision",
        "reservationId",
    ]);
    assert.equal(prepareVerification.skipPermission, undefined);
    const reserve = toolNamed(tools, "foundry_reserve_task");
    assert.deepEqual(reserve.parameters.required, [
        "planId",
        "taskId",
        "expectedRevision",
        "reservationId",
    ]);
    const completeTask = toolNamed(tools, "foundry_complete_task");
    assert.equal(
        completeTask.parameters.properties.evidence.items.properties.trust,
        undefined,
    );
	assert.ok(completeTask.parameters.properties.evidence.items.properties.checkId);
	assert.ok(completeTask.parameters.properties.sessionInventory);
    const cancel = toolNamed(tools, "foundry_cancel");
    assert.ok(cancel.parameters.required.includes("requestedBy"));
    assert.ok(cancel.parameters.required.includes("requestId"));
	const quarantine = toolNamed(tools, "foundry_quarantine_plan");
	assert.equal(quarantine.skipPermission, undefined);
	assert.deepEqual(quarantine.parameters.required, [
		"planId",
		"reason",
		"requestedBy",
	]);
	const cancelVerification = toolNamed(tools, "foundry_cancel_verification_run");
	assert.deepEqual(cancelVerification.parameters.required, [
		"planId",
		"expectedRevision",
		"requestId",
	]);
	const finalize = toolNamed(tools, "foundry_finalize_cancellation");
	assert.ok(finalize.parameters.required.includes("sessionInventory"));
});

test("waiting tools forward host cancellation signals outside model arguments", async () => {
	const controller = new AbortController();
	const tools = buildFoundryTools(new Proxy({}, {
		get: () => async (_input, options) => {
			assert.equal(options.signal, controller.signal);
			options.signal.throwIfAborted();
			return null;
		},
	}));
	for (const name of ["foundry_create_plan", "foundry_complete_verification", "foundry_control_workflow"]) {
		const tool = toolNamed(tools, name);
		const invocation = {
			sessionId: "session", toolCallId: "call", toolName: name, arguments: {}, signal: controller.signal,
		};
		const success = await tool.handler({}, invocation);
		assert.equal(success.resultType, "success");
		assert.equal(tool.parameters.properties.signal, undefined);
	}
	controller.abort();
	const failure = await toolNamed(tools, "foundry_create_plan").handler({}, {
		sessionId: "session", toolCallId: "call", toolName: "foundry_create_plan", arguments: {}, signal: controller.signal,
	});
	assert.equal(failure.resultType, "failure");
	assert.equal(JSON.parse(failure.textResultForLlm).error.code, "foundry_operation_aborted");
});

test("tool handlers return structured success and failure envelopes", async () => {
    const successTools = buildFoundryTools(operationsStub());
    const successArgs = { planId: "sample-plan" };
    const success = await toolNamed(successTools, "foundry_get_plan")
		.handler(successArgs, {
            sessionId: "session",
            toolCallId: "call",
            toolName: "foundry_get_plan",
			arguments: successArgs,
        });
    assert.equal(success.resultType, "success");
    assert.deepEqual(success.toolTelemetry, { foundry: { outcome: "success" } });
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
    const failureArgs = { planId: "sample-plan", expectedRevision: 2 };
    const failure = await toolNamed(failureTools, "foundry_submit_plan")
		.handler(failureArgs, {
            sessionId: "session",
            toolCallId: "call",
            toolName: "foundry_submit_plan",
			arguments: failureArgs,
        });
    assert.equal(failure.resultType, "failure");
    assert.deepEqual(failure.toolTelemetry, { foundry: { outcome: "failure" } });
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

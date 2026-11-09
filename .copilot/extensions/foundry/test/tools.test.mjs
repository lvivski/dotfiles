import assert from "node:assert/strict";
import test from "node:test";

import { parseJson, readRecord } from "../data.mjs";
import { createFoundryOperations } from "../operations.mjs";
import { buildFoundryTools } from "../tools.mjs";
import { must } from "./assertions.mjs";
import { analysisFixture } from "./native/fixture.mjs";

/** @param {(name: string, input: unknown, options?: {signal?: AbortSignal}) => unknown} [call]
 * @returns {import("../tools.mjs").ToolOperations} */
function operationsStub(call = (operation, input) => ({ operation, input })) {
	/** @type {import("../tools.mjs").ToolOperations} */
	const target = { ...createFoundryOperations({ getWorkspacePath: () => undefined, analysis: analysisFixture() }) };
	return new Proxy(target, {
		get: (_target, name) => async (/** @type {unknown} */ input, /** @type {{signal?: AbortSignal}} */ options) => call(String(name), input, options),
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
		"foundry_get_factory",
		"foundry_define_unit",
		"foundry_record_knowledge",
		"foundry_accept_contract",
		"foundry_prepare_candidate",
		"foundry_record_delivery",
		"foundry_record_evaluation",
		"foundry_decide_candidate",
		"foundry_record_signal",
		"foundry_retire_artifact",
		"foundry_compact_factory",
		"foundry_export_factory",
		"foundry_export_factory_page",
		"foundry_import_factory_page",
		"foundry_abandon_factory_import",
		"foundry_import_factory",
		"foundry_capture_analysis",
		"foundry_create_evaluation_plan",
		"foundry_record_human_judgment",
		"foundry_create_factory_plan",
		"foundry_sync_factory",
		"foundry_prepare_plan",
		"foundry_create_plan",
		"foundry_control_workflow",
		"foundry_get_status",
		"foundry_list_plans",
		"foundry_export_plan",
		"foundry_import_plan",
		"foundry_quarantine_plan",
		"foundry_submit_plan",
		"foundry_approve_plan",
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
	for (const tool of tools) {
		assert.equal(tool.namespace.name, "foundry");
		assert.match(tool.namespace.description, /task reservations/);
		assert.equal("defer" in tool, false);
	}
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
		must(must(completeTask.parameters.properties.evidence.items).properties).trust,
		undefined,
	);
	assert.ok(must(must(completeTask.parameters.properties.evidence.items).properties).checkId);
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
	const imported = toolNamed(tools, "foundry_import_plan");
	assert.equal(imported.skipPermission, undefined);
	assert.deepEqual(imported.parameters.required, ["source", "expectedRevision"]);
	assert.equal(imported.parameters.properties.expectedRevision.const, 0);
	assert.equal(toolNamed(tools, "foundry_export_plan").skipPermission, true);
});

test("waiting tools forward host cancellation signals outside model arguments", async () => {
	const controller = new AbortController();
	const tools = buildFoundryTools(operationsStub(async (_name, _input, options) => {
		assert.equal(options?.signal, controller.signal);
		controller.signal.throwIfAborted();
		return null;
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
	assert.equal(readRecord(readRecord(parseJson(failure.textResultForLlm)).error).code, "foundry_operation_aborted");
});

test("tool handlers return structured success and failure envelopes", async () => {
	const successTools = buildFoundryTools(operationsStub());
	const successArgs = { planId: "sample-plan" };
	const success = await toolNamed(successTools, "foundry_get_status")
		.handler(successArgs, {
			sessionId: "session",
			toolCallId: "call",
			toolName: "foundry_get_status",
			arguments: successArgs,
		});
	assert.equal(success.resultType, "success");
	assert.deepEqual(success.toolTelemetry, { foundry: { outcome: "success" } });
	assert.equal(readRecord(parseJson(success.textResultForLlm)).ok, true);

	const failureTools = buildFoundryTools(operationsStub(async () => {
		/** @type {Error & {code?: string, details?: unknown}} */
		const error = new Error("stale revision");
		error.code = "revision_conflict";
		error.details = { latestRevision: 3 };
		throw error;
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
	assert.deepEqual(parseJson(failure.textResultForLlm), {
		ok: false,
		error: {
			code: "revision_conflict",
			message: "stale revision",
			path: null,
			details: { latestRevision: 3 },
		},
	});
});

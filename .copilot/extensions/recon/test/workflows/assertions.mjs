import assert from "node:assert/strict";
import { isList, isRecord } from "../../data.mjs";

/** @typedef {NonNullable<Parameters<import("@github/copilot-sdk").WorkflowContext["agent"]>[1]>} AgentOptions */
/** @typedef {AgentOptions & {label: string}} NamedAgentOptions */

/** @param {AgentOptions} options @returns {asserts options is NamedAgentOptions} */
export function assertLabeled(options) {
	assert.equal(typeof options.label, "string", "Recon workflow agents must have stable diagnostic labels");
}

/** @param {unknown} schema @returns {asserts schema is import("../../types/json.js").JsonSchema} */
export function assertClosedOutputSchema(schema) {
	assert.ok(isRecord(schema));
	assert.equal(typeof schema.type, "string");
	assert.ok(["object", "array", "string", "integer", "number", "boolean"].includes(String(schema.type)));
	if (schema.enum) {
		assert.ok(isList(schema.enum));
		assert.ok(schema.enum.every((value) => typeof value === schema.type));
	}
	if (schema.type === "object") {
		assert.equal(schema.additionalProperties, false);
		assert.ok(isRecord(schema.properties));
		assert.ok(isList(schema.required));
		assert.ok(Object.keys(schema.properties).length > 0);
		assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
		Object.values(schema.properties).forEach(assertClosedOutputSchema);
	} else if (schema.type === "array") {
		assertClosedOutputSchema(schema.items);
	}
}

/** @param {ReturnType<typeof import("./runtime.mjs").createWorkflowContext>} workflow */
export function assertOutputSchemas(workflow) {
	const structured = workflow.calls.filter((call) => call.options.schema);
	assert.ok(structured.length > 0);
	for (const { options } of structured) assertClosedOutputSchema(options.schema);
}

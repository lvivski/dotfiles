import { errorCode, errorMessage, property } from "../data.mjs";

/** @typedef {import("@github/copilot-sdk").ToolResultObject} ToolResult */

/**
 * Wraps a value in the structured SDK tool-result contract.
 *
 * @param {unknown} value
 * @param {ToolResult["resultType"]} [resultType]
 * @returns {ToolResult}
 */
function result(value, resultType = "success") {
	return {
		textResultForLlm: JSON.stringify(value),
		resultType,
		toolTelemetry: {
			foundry: { outcome: resultType },
		},
	};
}

/**
 * Converts an arbitrary thrown value into the stable Foundry error envelope.
 *
 * @param {unknown} error
 * @returns {{ok: false, error: {code: string, message: string, path: unknown, details: unknown}}}
 */
function errorPayload(error) {
	return {
		ok: false,
		error: {
			code: property(error, "name") === "AbortError" ? "foundry_operation_aborted" : errorCode(error) ?? "foundry_internal_error",
			message: errorMessage(error),
			path: property(error, "path") ?? null,
			details: property(error, "details") ?? null,
		},
	};
}

/**
 * Adapts an operation to the SDK tool handler contract.
 *
 * @param {import("@github/copilot-sdk").ToolHandler} operation
 * @returns {(args: unknown, invocation: import("@github/copilot-sdk").ToolInvocation) => Promise<ToolResult>}
 */
export function handler(operation) {
	return async (args, invocation) => {
		try {
			const value = await operation(args, invocation);
			return result({ ok: true, value });
		} catch (error) {
			return result(errorPayload(error), "failure");
		}
	};
}

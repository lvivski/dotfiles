import assert from "node:assert/strict";
import { isList, readRecord } from "../data.mjs";

/** @template T @param {T | null | undefined} value @param {string} [message] @returns {T} */
export function must(value, message = "Required fixture value is missing") {
	assert.ok(value !== undefined && value !== null, message);
	return value;
}

/** @template {object} T @param {T} value @returns {Exclude<T, import("../types/workflow.js").PendingWorkflow>} */
export function completed(value) {
	assert.ok(!("state" in value), "Expected a completed fixture import, not a pending workflow");
	return /** @type {Exclude<T, import("../types/workflow.js").PendingWorkflow>} */ (value);
}

/** @template {{state: string}} T @param {T | null | undefined} value @returns {Extract<T, {state: "available"}>} */
export function available(value) {
	assert.ok(isAvailable(value), "Expected available fixture state");
	return value;
}

/** @template {{state: string}} T @param {T | null | undefined} value @returns {value is Extract<T, {state: "available"}>} */
function isAvailable(value) {
	return value?.state === "available";
}

/** @param {Response} response @returns {Promise<unknown>} */
export async function jsonResponse(response) {
	return response.json();
}

/** Assert intermediate wire containers before inspecting a possibly absent leaf.
 * @param {unknown} value @param {Array<string | number>} keys @returns {unknown} */
export function jsonField(value, ...keys) {
	let current = value;
	for (const key of keys) {
		if (typeof key === "number") {
			assert.ok(isList(current) && Object.hasOwn(current, key), "Expected an existing JSON array entry");
			current = current[key];
		} else current = readRecord(current)[key];
	}
	return current;
}

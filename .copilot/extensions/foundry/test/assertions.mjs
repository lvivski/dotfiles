import assert from "node:assert/strict";

/** @template T @param {T | null | undefined} value @param {string} [message] @returns {T} */
export function must(value, message = "Required fixture value is missing") {
	assert.ok(value !== undefined && value !== null, message);
	return value;
}

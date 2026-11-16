import { createHash } from "node:crypto";
import { isList, property } from "./data.mjs";
import { fail } from "./errors.mjs";

/**
 * Recursively sorts object keys for deterministic JSON serialization.
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
function sortKeysDeep(value, seen = new WeakSet()) {
	if (isList(value)) {
		if (seen.has(value)) fail("invalid_analysis_input", "Cannot digest a circular value");
		seen.add(value);
		const output = value.map((item) => sortKeysDeep(item, seen));
		seen.delete(value);
		return output;
	}
	if (value && typeof value === "object") {
		if (seen.has(value)) {
			fail("invalid_analysis_input", "Cannot digest a circular value");
		}
		seen.add(value);
		/** @type {Record<string, unknown>} */
		const output = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			output[key] = sortKeysDeep(property(value, key), seen);
		}
		seen.delete(value);
		return output;
	}
	return value;
}

/**
 * Serializes JSON-like data with recursively sorted object keys.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
	const serialized = JSON.stringify(sortKeysDeep(value === undefined ? null : value));
	if (typeof serialized !== "string") fail("invalid_analysis_input", "Cannot digest a non-JSON value");
	return serialized;
}

/**
 * Computes the canonical SHA-256 digest for analysis input.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function analysisInputDigest(value) {
	return createHash("sha256")
		.update(stableStringify(value))
		.digest("hex");
}

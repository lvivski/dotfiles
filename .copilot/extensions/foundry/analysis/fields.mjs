import { fail } from "../errors.mjs";
import { isList, isRecord } from "../data.mjs";

/**
 * Requires a plain JSON-like object.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {Record<string, unknown>}
 */
export function plainObject(value, field) {
	if (!isRecord(value)) {
		fail("invalid_analysis_input", `${field} must be an object`);
	}
	return value;
}

/**
 * Validates nonempty text, preserving the complete original value.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maximum]
 * @returns {string}
 */
export function text(value, field, maximum) {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")
		|| (maximum !== undefined && value.length > maximum)) {
		fail(
			"invalid_analysis_input",
			`${field} must be nonempty text without NUL${maximum === undefined ? "" : ` of at most ${maximum} characters`}`,
		);
	}
	return value;
}

/**
 * Validates a complete array of nonempty strings.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} [maximum]
 * @param {number} [itemMaximum]
 * @param {number} [minimum]
 * @returns {string[]}
 */
export function stringList(value, field, maximum, itemMaximum, minimum = 0) {
	if (!isList(value) || value.length < minimum || (maximum !== undefined && value.length > maximum)) {
		fail(
			"invalid_analysis_input",
			`${field} must contain at least ${minimum} strings${maximum === undefined ? "" : `, at most ${maximum}`}`,
		);
	}
	return value.map((item, index) => text(
		item,
		`${field}[${index}]`,
		itemMaximum,
	));
}

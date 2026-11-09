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
 * Validates a bounded non-empty text field.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} maximum
 * @returns {string}
 */
export function text(value, field, maximum) {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
		fail(
			"invalid_analysis_input",
			`${field} must be a non-empty string of at most ${maximum} characters`,
		);
	}
	return value;
}

/**
 * Validates a bounded array of non-empty strings.
 *
 * @param {unknown} value
 * @param {string} field
 * @param {number} maximum
 * @param {number} itemMaximum
 * @param {number} [minimum]
 * @returns {string[]}
 */
export function stringList(value, field, maximum, itemMaximum, minimum = 0) {
	if (!isList(value) || value.length < minimum || value.length > maximum) {
		fail(
			"invalid_analysis_input",
			`${field} must contain ${minimum}-${maximum} strings`,
		);
	}
	return value.map((item, index) => text(
		item,
		`${field}[${index}]`,
		itemMaximum,
	));
}

import { isList, isOneOf } from "../data.mjs";

/** @typedef {import("../types/factory.js").KnowledgeRef} KnowledgeRef */

const ID = /^[a-z0-9][a-z0-9._-]{0,95}$/;

const DIGEST = /^[a-f0-9]{64}$/;

export const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class FoundryFactoryError extends Error {
	/** @param {string} code @param {string} message @param {unknown} [details] */
	constructor(code, message, details = null) {
		super(message);
		this.name = "FoundryFactoryError";
		this.code = code;
		this.details = details;
	}
}

/** @param {string} code @param {string} message @param {unknown} [details] @returns {never} */
export function fail(code, message, details = null) {
	throw new FoundryFactoryError(code, message, details);
}

/** @param {unknown} value @param {string} field @param {number} [max] */
export function text(value, field, max = 8000) {
	if (typeof value !== "string" || !value.trim() || value.length > max) {
		fail("factory_input_invalid", `${field} must be nonempty text of at most ${max} characters`);
	}
	return value;
}

/** @param {unknown} value @param {readonly string[]} keys @param {string} field @returns {asserts value is Record<string, unknown>} */
export function object(value, keys, field) {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| ![Object.prototype, null].includes(Object.getPrototypeOf(value))
		|| Object.keys(value).some((key) => !keys.includes(key))) {
		fail("factory_input_invalid", `${field} must be an object containing only ${keys.join(", ")}`);
	}
}

/** @template {string} T @param {unknown} value @param {readonly T[]} values @param {string} field @returns {T} */
export function enumeration(value, values, field) {
	if (!isOneOf(value, values)) fail("factory_input_invalid", `${field} must be one of ${values.join(", ")}`);
	return value;
}

/** @param {unknown} value @param {string} [field] */
export function identifier(value, field = "id") {
	if (typeof value !== "string" || !ID.test(value)) fail("factory_input_invalid", `${field} must be a stable lowercase identifier`);
	return value;
}

/** @param {unknown} value @param {string} field @param {number} [min] @param {number} [max] */
export function integer(value, field, min = 1, max = Number.MAX_SAFE_INTEGER) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail("factory_input_invalid", `${field} must be an integer from ${min} to ${max}`);
	return value;
}

/** @param {unknown} value @param {string} field @param {number} [max] @param {number} [min] @returns {unknown[]} */
export function list(value, field, max = 32, min = 0) {
	if (!isList(value) || value.length > max || value.length < min) fail("factory_input_invalid", `${field} must contain ${min}-${max} items`);
	return value;
}

/** @param {unknown} value @param {string} field @param {number} [max] @param {number} [min] */
export function strings(value, field, max = 32, min = 0) {
	const items = list(value, field, max, min).map((item) => text(item, field, 2048));
	if (new Set(items).size !== items.length) fail("factory_input_invalid", `${field} contains duplicates`);
	return items;
}

/** @param {unknown} value @param {string} field */
export function timestamp(value, field) {
	if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
		|| new Date(value).toISOString() !== value) fail("factory_input_invalid", `${field} must be an ISO timestamp`);
	return value;
}

/** @param {unknown} value @param {string} field */
export function digest(value, field) {
	if (typeof value !== "string" || !DIGEST.test(value)) fail("factory_input_invalid", `${field} must be a SHA-256 digest`);
	return value;
}

/** @param {unknown} value @returns {KnowledgeRef} */
export function reference(value) {
	object(value, ["id", "revision"], "knowledge reference");
	return { id: identifier(value.id), revision: integer(value.revision, "knowledge revision") };
}

/** @param {Record<string, unknown>} input @param {string} at */
export function actorReason(input, at) {
	return { actor: text(input.actor, "actor", 256), reason: text(input.reason, "reason"), at };
}

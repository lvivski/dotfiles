/** Narrow wire/JSON values without giving unchecked input an application type. */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is unknown[]} */
export function isList(value) {
	return Array.isArray(value);
}

/** @template {string} T @param {unknown} value @param {readonly T[]} values @returns {value is T} */
export function isOneOf(value, values) {
	return values.some((candidate) => candidate === value);
}

/** JSON.parse's standard-library return type is deliberately not propagated. @param {string} source @returns {unknown} */
export function parseJson(source) {
	return JSON.parse(source);
}

/** @param {unknown} error @returns {string | undefined} */
export function errorCode(error) {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** @param {unknown} error @returns {string} */
export function errorMessage(error) {
	return isRecord(error) && typeof error.message === "string" ? error.message : String(error);
}

/** @param {unknown} value @param {string} key @returns {unknown} */
export function property(value, key) {
	return isRecord(value) ? value[key] : undefined;
}

/** @template T @typedef {(value: unknown) => T} Decoder */
/** @template {Record<string, Decoder<unknown>>} T
 * @typedef {{[K in keyof T as undefined extends ReturnType<T[K]> ? never : K]: ReturnType<T[K]>}
 * & {[K in keyof T as undefined extends ReturnType<T[K]> ? K : never]?: ReturnType<T[K]>}} Decoded */

/** @param {unknown} value */
export function readRecord(value) {
	if (!isRecord(value)) throw new TypeError("Expected an object");
	return value;
}
/** @param {unknown} value */
export function readString(value) {
	if (typeof value !== "string") throw new TypeError("Expected a string");
	return value;
}
/** @param {unknown} value */
export function readNumber(value) {
	if (typeof value !== "number") throw new TypeError("Expected a number");
	return value;
}
/** @param {unknown} value */
export function readBoolean(value) {
	if (typeof value !== "boolean") throw new TypeError("Expected a boolean");
	return value;
}
/** @template T @param {Decoder<T>} decode @returns {Decoder<T[]>} */
export const arrayOf = (decode) => (value) => {
	if (!isList(value)) throw new TypeError("Expected an array");
	return value.map(decode);
};
/** @template T @param {Decoder<T>} decode @returns {Decoder<T | undefined>} */
export const optional = (decode) => (value) => value === undefined ? undefined : decode(value);
/** @template T @param {Decoder<T>} decode @returns {Decoder<T | null>} */
export const nullable = (decode) => (value) => value === null ? null : decode(value);
/** @template {Record<string, Decoder<unknown>>} T @param {T} fields @param {unknown} value @returns {Decoded<T>} */
export function decodeRecord(fields, value) {
	const input = readRecord(value);
	const parsed = Object.fromEntries(Object.entries(fields).map(([key, decode]) => [key, decode(input[key])]));
	// Each output key was produced by its matching decoder, not asserted from untrusted input.
	return /** @type {Decoded<T>} */ (parsed);
}
/** @template {Record<string, Decoder<unknown>>} T @param {T} fields @returns {Decoder<Decoded<T>>} */
export const recordOf = (fields) => (value) => decodeRecord(fields, value);

/** @param {unknown} value @param {Set<object>} [ancestors] @returns {import("./types/json.js").JsonValue} */
export function readJsonValue(value, ancestors = new Set()) {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Expected finite, acyclic JSON data");
	ancestors.add(value);
	try {
		if (isList(value)) {
			/** @type {import("./types/json.js").JsonValue[]} */
			const entries = [];
			for (let index = 0; index < value.length; index++) {
				if (!Object.hasOwn(value, index)) throw new TypeError("Expected explicit JSON array entries");
				entries.push(readJsonValue(value[index], ancestors));
			}
			return entries;
		}
		if (!isRecord(value)) throw new TypeError("Expected JSON object data");
		if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError("Expected a plain JSON object");
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, readJsonValue(entry, ancestors)]));
	} finally {
		ancestors.delete(value);
	}
}

import { isList } from "../data.mjs";
import { COMMIT_PATTERN, LIMITS, PLAN_ID_REGEX, REQUEST_ID_PATTERN } from "./values.mjs";

/** Typed error raised by domain validation and transition guards. */
export class FoundryDomainError extends Error {
	/**
	 * @param {string} code Stable machine-readable error code.
	 * @param {string} message Human-readable failure summary.
	 * @param {{path?: string | null, details?: unknown}} [options]
	 */
	constructor(code, message, options = {}) {
		super(message);
		this.name = "FoundryDomainError";
		this.code = code;
		this.path = options.path ?? null;
		this.details = options.details ?? null;
	}

	/**
	 * Serializes stable public validation fields.
	 *
	 * @returns {{code: string, message: string, path: string | null, details: unknown}}
	 */
	toJSON() {
		return {
			code: this.code,
			message: this.message,
			path: this.path,
			details: this.details,
		};
	}
}

/**
 * Throws a typed domain error.
 *
 * @param {string} code
 * @param {string} message
 * @param {{path?: string | null, details?: unknown}} [options]
 * @returns {never}
 */
export function fail(code, message, options) {
	throw new FoundryDomainError(code, message, options);
}

/**
 * Tests for a plain JSON-like object.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Requires a plain object.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @returns {asserts value is Record<string, unknown>}
 */
export function assertPlainObject(value, fieldPath) {
	if (!isPlainObject(value)) {
		fail("invalid_object", `${fieldPath} must be an object`, { path: fieldPath });
	}
}

/**
 * Rejects fields not declared by the current schema.
 *
 * @param {object} value
 * @param {Set<string>} keys
 * @param {string} fieldPath
 * @returns {void}
 */
export function assertKnownKeys(value, keys, fieldPath) {
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) {
			fail("unknown_field", `${fieldPath}.${key} is not supported by the current plan format`, {
				path: `${fieldPath}.${key}`,
			});
		}
	}
}

/**
 * Requires a bounded string without NUL bytes.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @param {number} maximum
 * @param {{allowEmpty?: boolean}} [options]
 * @returns {asserts value is string}
 */
export function assertString(value, fieldPath, maximum, options = {}) {
	if (typeof value !== "string") {
		fail("invalid_string", `${fieldPath} must be a string`, { path: fieldPath });
	}
	if (!options.allowEmpty && value.trim().length === 0) {
		fail("empty_string", `${fieldPath} must not be empty`, { path: fieldPath });
	}
	if (value.length > maximum) {
		fail("field_too_long", `${fieldPath} exceeds the ${maximum}-character limit`, {
			path: fieldPath,
			details: { maximum, actual: value.length },
		});
	}
	if (value.includes("\0")) {
		fail("invalid_string", `${fieldPath} must not contain NUL characters`, { path: fieldPath });
	}
}

/**
 * Requires either `null` or a bounded string.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @param {number} maximum
 * @returns {asserts value is string | null}
 */
export function assertNullableString(value, fieldPath, maximum) {
	if (value === null) {
		return;
	}
	assertString(value, fieldPath, maximum);
}

/**
 * Requires a bounded array of bounded non-empty strings.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @param {{minimum?: number, maximum: number, itemMaximum: number}} options
 * @returns {asserts value is string[]}
 */
export function assertStringArray(value, fieldPath, options) {
	if (!isList(value)) {
		fail("invalid_array", `${fieldPath} must be an array`, { path: fieldPath });
	}
	if (value.length < (options.minimum ?? 0)) {
		fail("array_too_short", `${fieldPath} must contain at least ${options.minimum} item(s)`, {
			path: fieldPath,
			details: { minimum: options.minimum, actual: value.length },
		});
	}
	if (value.length > options.maximum) {
		fail("array_too_long", `${fieldPath} exceeds the ${options.maximum}-item limit`, {
			path: fieldPath,
			details: { maximum: options.maximum, actual: value.length },
		});
	}
	value.forEach((item, index) => {
		assertString(item, `${fieldPath}[${index}]`, options.itemMaximum);
	});
}

/**
 * @overload
 * @param {unknown} value
 * @param {string} fieldPath
 * @param {{nullable: true}} options
 * @returns {asserts value is string | null}
 */
/**
 * @overload
 * @param {unknown} value
 * @param {string} fieldPath
 * @param {{nullable?: false}} [options]
 * @returns {asserts value is string}
 */
/**
 * Requires canonical millisecond-precision UTC ISO-8601.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @param {{nullable?: boolean}} [options]
 * @returns {void}
 */
export function assertTimestamp(value, fieldPath, options = {}) {
	if (options.nullable && value === null) {
		return;
	}
	const canonicalPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
	/** @type {string | null} */
	let canonical = null;
	if (typeof value === "string" && canonicalPattern.test(value)) {
		try {
			canonical = new Date(value).toISOString();
		} catch {
			canonical = null;
		}
	}
	if (canonical !== value) {
		fail("invalid_timestamp", `${fieldPath} must be a canonical UTC ISO-8601 timestamp`, {
			path: fieldPath,
		});
	}
}

/**
 * Requires an actor and timestamp to be both present or both absent.
 *
 * @param {unknown} at
 * @param {unknown} by
 * @param {string} prefix
 * @returns {void}
 */
export function assertTimestampPair(at, by, prefix) {
	if ((at === null) !== (by === null)) {
		fail("invalid_gate", `${prefix} timestamp and actor must either both be set or both be null`, {
			path: prefix,
		});
	}
	assertTimestamp(at, `${prefix}At`, { nullable: true });
	assertNullableString(by, `${prefix}By`, LIMITS.actor);
}

/**
 * Requires `null` or an HTTP(S) URL.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @returns {asserts value is string | null}
 */
export function assertHttpUrl(value, fieldPath) {
	if (value === null) {
		return;
	}
	assertString(value, fieldPath, LIMITS.prUrl);
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		fail("invalid_url", `${fieldPath} must be a valid URL`, { path: fieldPath });
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		fail("invalid_url", `${fieldPath} must use http or https`, { path: fieldPath });
	}
}

/**
 * Creates an owned structured clone.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
	return structuredClone(value);
}

/**
 * Resolves an optional test clock to canonical UTC.
 *
 * @param {Date|string|number|(() => Date|string|number)|undefined} now
 * @returns {string}
 */
export function nowIso(now) {
	const value = typeof now === "function" ? now() : now;
	const date = value === undefined ? new Date() : new Date(value);
	if (!Number.isFinite(date.getTime())) {
		fail("invalid_timestamp", "The supplied clock did not produce a valid timestamp");
	}
	return date.toISOString();
}

/**
 * Requires a bounded actor identity.
 *
 * @param {unknown} actor
 * @param {string} fieldPath
 * @returns {asserts actor is string}
 */
export function requireActor(actor, fieldPath) {
	assertString(actor, fieldPath, LIMITS.actor);
}

/**
 * Validates a stable plan slug.
 *
 * @param {unknown} id
 * @param {string} [fieldPath]
 * @returns {string}
 */
export function assertPlanId(id, fieldPath = "id") {
	if (typeof id !== "string" || id.length > LIMITS.planId || !PLAN_ID_REGEX.test(id)) {
		fail(
			"invalid_plan_id",
			`${fieldPath} must be a lowercase slug of 1-${LIMITS.planId} letters, digits, or hyphens`,
			{ path: fieldPath },
		);
	}
	return id;
}

/**
 * Requires a stable idempotency request ID.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @returns {asserts value is string}
 */
export function assertRequestId(value, fieldPath) {
	if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) {
		fail("invalid_request_id", `${fieldPath} must be a stable request identifier`, {
			path: fieldPath,
		});
	}
}

/**
 * Requires `null` or a lowercase Git object ID.
 *
 * @param {unknown} value
 * @param {string} fieldPath
 * @returns {asserts value is string | null}
 */
export function assertCommit(value, fieldPath) {
	if (value === null) return;
	if (typeof value !== "string"
		|| !COMMIT_PATTERN.test(value)) {
		fail("invalid_commit", `${fieldPath} must be a full lowercase Git object ID`, {
			path: fieldPath,
		});
	}
}

/** @param {unknown} review @returns {asserts review is import("../types/plan.js").ConceptualReview | undefined} */
export function validateConceptualReview(review) {
	if (review === undefined) return;
	assertPlainObject(review, "conceptualReview");
	assertKnownKeys(review, new Set(["proposals", "gaps"]), "conceptualReview");
	assertStringArray(review.proposals, "conceptualReview.proposals", { maximum: 3, itemMaximum: 2000 });
	assertStringArray(review.gaps, "conceptualReview.gaps", { maximum: 4, itemMaximum: 2000 });
}

/** @module schema — strict JSON and native Factory metadata validation. */

export const FACTORY_LIMIT_KEYS = [
	"maxConcurrentSubagents",
	"maxTotalSubagents",
	"timeoutSeconds",
	"maxAiCredits",
];

/** Normalize a partial native Factory limits object. @param {unknown} value */
export function normalizeLimits(value) {
	if (value == null) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("limits must be an object");
	}
	const input = /** @type {Record<string, unknown>} */ (value);
	for (const key of Object.keys(input)) {
		if (!FACTORY_LIMIT_KEYS.includes(key)) throw new TypeError(`unknown Factory limit '${key}'`);
	}
	/** @type {Record<string, number>} */
	const limits = {};
	for (const key of FACTORY_LIMIT_KEYS) {
		const raw = input[key];
		if (raw == null) continue;
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
			throw new TypeError(`${key} must be a positive finite number`);
		}
		if (key !== "timeoutSeconds" && key !== "maxAiCredits" && !Number.isInteger(raw)) {
			throw new TypeError(`${key} must be a positive integer`);
		}
		limits[key] = raw;
	}
	return limits;
}

/**
 * Validate and normalize a strict JSON value. `undefined` is accepted only at the root when allowed.
 * @param {unknown} value
 * @param {{ allowUndefined?: boolean, label?: string }} [options]
 */
export function assertJson(value, options = {}) {
	const label = options.label || "value";
	const ancestors = new Set();
	const visit = (current, path, root) => {
		if (current === undefined) {
			if (root && options.allowUndefined) return;
			throw new TypeError(`${label} contains undefined at ${path}`);
		}
		if (current === null || typeof current === "string" || typeof current === "boolean") return;
		if (typeof current === "number") {
			if (!Number.isFinite(current)) throw new TypeError(`${label} contains a non-finite number at ${path}`);
			return;
		}
		if (typeof current !== "object") throw new TypeError(`${label} contains a non-JSON value at ${path}`);
		if (ancestors.has(current)) throw new TypeError(`${label} contains a cycle at ${path}`);
		ancestors.add(current);
		try {
			if (Array.isArray(current)) {
				for (let index = 0; index < current.length; index++) {
					visit(current[index], `${path}[${index}]`, false);
				}
				return;
			}
			const prototype = Object.getPrototypeOf(current);
			const crossRealmPlain =
				prototype !== null &&
				Object.getPrototypeOf(prototype) === null &&
				typeof prototype.constructor === "function" &&
				prototype.constructor.name === "Object";
			if (prototype !== Object.prototype && prototype !== null && !crossRealmPlain) {
				throw new TypeError(`${label} contains a non-plain object at ${path}`);
			}
			for (const key of Reflect.ownKeys(current)) {
				if (typeof key === "symbol") throw new TypeError(`${label} contains symbol properties at ${path}`);
				const descriptor = Object.getOwnPropertyDescriptor(current, key);
				if (!descriptor?.enumerable || !("value" in descriptor)) {
					throw new TypeError(`${label} contains an accessor or non-enumerable property at ${path}.${key}`);
				}
				visit(descriptor.value, `${path}.${key}`, false);
			}
		} finally {
			ancestors.delete(current);
		}
	};
	visit(value, "$", true);
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

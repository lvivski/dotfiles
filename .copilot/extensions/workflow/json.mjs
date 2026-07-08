/**
 * @module json
 *
 * Deterministic JSON helpers shared by the host-effect cache key (`effects`/`runtime`) and byte-stable
 * manifest writes (`hostio`). Pure Node built-ins only.
 */

/** Recursively sort object keys (arrays kept in order) for stable serialization. @param {any} v @returns {any} */
export function sortKeysDeep(v) {
	if (Array.isArray(v)) return v.map(sortKeysDeep);
	if (v && typeof v === "object") {
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
		return out;
	}
	return v;
}

/** Deterministic JSON with sorted keys; `undefined` serializes as `"null"`. @param {unknown} v @returns {string} */
export function stableStringify(v) {
	return JSON.stringify(sortKeysDeep(v === undefined ? null : v));
}

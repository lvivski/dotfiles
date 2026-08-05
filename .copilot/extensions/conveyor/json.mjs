/**
 * @module json
 *
 * Deterministic JSON helper for the host-effect cache key (`runtime` canonicalizes effect input via
 * `stableStringify`). Pure Node built-ins only.
 */

/** Recursively sort object keys (arrays kept in order) for stable serialization. Throws on a cyclic
 * structure instead of recursing forever. @param {any} v @param {WeakSet<object>} [seen] @returns {any} */
export function sortKeysDeep(v, seen = new WeakSet()) {
	if (Array.isArray(v)) return v.map((x) => sortKeysDeep(x, seen));
	if (v && typeof v === "object") {
		if (seen.has(v)) throw new TypeError("cannot canonicalize a circular structure");
		seen.add(v);
		/** @type {Record<string, unknown>} */
		const out = {};
		for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k], seen);
		seen.delete(v); // allow the same object in sibling positions (diamond), block true cycles
		return out;
	}
	return v;
}

/** Deterministic JSON with sorted keys; `undefined` serializes as `"null"`. @param {unknown} v @returns {string} */
export function stableStringify(v) {
	return JSON.stringify(sortKeysDeep(v === undefined ? null : v));
}

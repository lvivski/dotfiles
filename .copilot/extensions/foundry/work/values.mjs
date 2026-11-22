import { createHash } from "node:crypto";
export class FoundryError extends Error {
	/** @param {string} code @param {string} message */
	constructor(code, message) { super(message); this.code = code; }
}

/** @param {string} code @param {string} message @returns {never} */
export function fail(code, message) { throw new FoundryError(code, message); }

/** @param {unknown} value @returns {Record<string,unknown>} */
export function record(value) {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("invalid_record", "Expected an object");
	return /** @type {Record<string,unknown>} */ (value);
}

/** @param {unknown} value @param {string} label */
export function text(value, label) {
	if (typeof value !== "string" || !value.trim() || value.includes("\0"))
		fail("invalid_field", `Expected ${label}`);
	return value;
}

/** @param {unknown} value @param {string} label */
export function name(value, label) {
	const id = text(value, label);
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id) || Object.hasOwn(Object.prototype, id))
		fail("invalid_name", `Invalid ${label}: ${id}`);
	return id;
}

/** @param {string|undefined} key */
export const referenceRepo = key => key?.startsWith("reference:") ? name(key.slice(10), "reference checkout") : undefined;
/** @param {unknown} value */
export function waitTarget(value) {
	const target = text(value, "wait target");
	return referenceRepo(target) ? target : name(target, "producer charter");
}

/** @param {unknown} value @param {string} label */
export function names(value, label) {
	if (!Array.isArray(value))
		fail("invalid_field", `Expected a list of ${label}`);
	const ids = value.map(v => name(v, label));
	if (new Set(ids).size !== ids.length)
		fail("duplicate_name", `Duplicate ${label}`);
	return ids;
}

/** @param {Record<string,unknown>} value @param {string[]} keys */
export function fields(value, keys) {
	for (const key of Object.keys(value))
		if (!keys.includes(key))
			fail("unsupported_field", `Unsupported field: ${key}`);
}

/** @param {unknown} value @param {number} min @param {string} label */
export function integer(value, min, label) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min)
		fail("invalid_limit", `Invalid ${label}`);
	return value;
}

/** @param {unknown} value */
export function relative(value) {
	const s = text(value, "repository-relative path");
	if (/[\\:\x00-\x1f\x7f]/.test(s) || s.split("/").some(part => !part || part === "." || part === ".." ||
		/^\.git[ .]*$/i.test(part) || /[ .]$/.test(part)))
		fail("invalid_path", `Invalid repository path: ${s}`);
	return s;
}

/** @param {unknown} value @returns {{directory:string,revision?:string}} */
export function assignmentDirectory(value) {
	const s = text(value, "assignment directory"), colon = s.indexOf(":");
	if (colon < 0) return { directory: relative(s) };
	const revision = s.slice(0, colon);
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
		fail("invalid_baseline", "A pinned directory needs a full local commit ID before ':'");
	return { directory: relative(s.slice(colon + 1)), revision };
}

/** @param {string} root @param {string} p */
export const contains = (root, p) => p === root || p.startsWith(`${root}/`);

/** @param {unknown} value @returns {string} */
export function stable(value) {
	if (Array.isArray(value))
		return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
	return JSON.stringify(value);
}

/** @param {unknown} value */
export const digest = value => createHash("sha256").update(stable(value)).digest("hex");

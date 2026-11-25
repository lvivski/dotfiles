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

/** A persisted wall clock without an offset is not portable authority.
 * @param {string} value */
export function deadlineAt(value) {
	const match=/^(\d{4}-\d\d-\d\d)T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.exec(value);
	if (!match) return;
	const date=new Date(`${match[1]}T00:00:00Z`), time=Date.parse(value);
	if (Number.isFinite(time) && Number.isFinite(date.getTime()) && date.toISOString().startsWith(match[1])) return time;
}

/** @param {unknown} value */
export function relative(value) {
	const s = text(value, "repository-relative path");
	if (/[\\:\x00-\x1f\x7f]/.test(s) || s.split("/").some(part => !part || part === "." || part === ".." ||
		/^\.git[ .]*$/i.test(part) || /[ .]$/.test(part)))
		fail("invalid_path", `Invalid repository path: ${s}`);
	return s;
}

/** @param {unknown} value */
function pinnedDirectory(value) {
	const s = text(value, "assignment directory"), colon = s.indexOf(":");
	if (colon < 0) return { directory: relative(s) };
	const revision = s.slice(0, colon);
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision))
		fail("invalid_baseline", "A pinned directory needs a full local commit ID before ':'");
	return { directory: relative(s.slice(colon + 1)), revision };
}

/** @template T @param {T|T[]} value @returns {T[]} */
export const members = value => Array.isArray(value) ? value : [value];

/** @param {import("./model.js").Scope} scope @returns {scope is import("./model.js").FileScope} */
export const mixed = scope => typeof scope === "object" && !Array.isArray(scope);
/** @param {import("./model.js").Scope} scope */
export const ownership = scope => mixed(scope) ? { directories: [scope.primary], files: scope.files } : { directories: members(scope), files: [] };
/** Git pathspecs and overlap checks need both kinds. Never use the flattened list for recursive grants.
 * @param {import("./model.js").Scope} scope */
export const roots = scope => mixed(scope) ? [scope.primary, ...scope.files] : members(scope);
/** @param {import("./model.js").Scope} scope */
export const scopeLabel = scope => mixed(scope) ? `${scope.primary}/ plus exact files ${JSON.stringify(scope.files)}` : members(scope).join(", ");

/** @param {NonNullable<import("./model.js").Review["iteration"]>} i @returns {import("./model.js").Scope} */
export const comparisonScope = i => i.files ? {primary:i.directory,files:i.files} : i.directory;

/** @param {string[]} directories */
export function disjoint(directories) {
	const roots = directories.map(dir => `${dir.normalize("NFC").toLowerCase()}/`).sort();
	for (const [i, dir] of roots.entries()) {
		if (dir.startsWith(".foundry/")) fail("contract_scope", "Implementation cannot own .foundry");
		if (i && dir.startsWith(roots[i - 1])) fail("overlapping_ownership", "Writable directories must be disjoint");
	}
}

/** @param {unknown} value @returns {{directory:import("./model.js").Scope,revision?:string}} */
export function assignmentDirectory(value) {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const scope=record(value);
		fields(scope,["primary","files"]);
		const primary=relative(scope.primary);
		if (!Array.isArray(scope.files) || !scope.files.length) fail("invalid_field","Name at least one exact integration file");
		const files=scope.files.map(relative).sort();
		disjoint([primary,...files]);
		return {directory:{primary,files}};
	}
	if (!Array.isArray(value)) return pinnedDirectory(value);
	if (!value.length) fail("invalid_field", "An assignment needs at least one directory");
	const pins = value.map(pinnedDirectory), revision = pins[0].revision;
	if (pins.some(p => p.revision !== revision)) fail("invalid_baseline", "All directories in an assignment must use the same revision");
	const dirs = pins.map(p => p.directory).sort();
	disjoint(dirs);
	return { directory: dirs.length === 1 ? dirs[0] : dirs, ...(revision ? {revision} : {}) };
}

/** @param {import("./model.js").Scope|undefined} a @param {import("./model.js").Scope|undefined} b */
export const sameScope = (a,b) => a === b || !!a && !!b && typeof a === "object" && typeof b === "object" && stable(a) === stable(b);

/** @param {string} root @param {string} p */
export const contains = (root, p) => p === root || p.startsWith(`${root}/`);

/** @param {import("./model.js").Scope} scope @param {string} file */
export const covers = (scope,file) => mixed(scope) ? contains(scope.primary,file) || scope.files.includes(file) : members(scope).some(dir => contains(dir,file));

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

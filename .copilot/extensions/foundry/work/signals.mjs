import { FoundryError, fail, fields, integer, name, record, relative } from "./values.mjs";

/** @typedef {import("./model.js").BlockerSignal} Signal */
/** @param {unknown} input @returns {Signal} */
export function signal(input) {
	const v = record(input), id = name(v.id, "blocker ID"), directory = relative(v.directory);
	fields(v, ["id", "directory", v.passed === true ? "passed" : "blocked"]);
	if (v.passed === true) return { id, directory, passed: true };
	const blocked = integer(v.blocked, 1, "unrun dependent count");
	if (!Number.isSafeInteger(blocked + 1)) fail("invalid_limit", "Affected count exceeds safe integer range");
	return { id, directory, blocked };
}

/** @param {unknown} values @returns {values is Signal[]} */
export function validSignals(values) {
	try {
		return Array.isArray(values) && values.length > 0 && new Set(values.map(v => signal(v).id)).size === values.length;
	} catch (e) { if (!(e instanceof FoundryError)) throw e; return false; }
}

/** @param {Buffer} stdout @param {number} exit */
export function signals(stdout, exit) {
	const lines = [...stdout.toString().matchAll(/^FOUNDRY_BLOCKERS=([^\r\n]*)\r?$/gm)];
	if (!lines.length) return;
	if (lines.length === 1) {
		let data;
		try { data = JSON.parse(lines[0][1]); } catch (e) { if (!(e instanceof SyntaxError)) throw e; }
		if (validSignals(data) && (exit === 1 || data.every(s => "passed" in s))) return data;
	}
	throw new FoundryError("invalid_blockers", "Expected one unambiguous FOUNDRY_BLOCKERS list consistent with the goal exit");
}

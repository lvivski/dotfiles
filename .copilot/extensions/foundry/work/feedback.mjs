import { isUtf8 } from "node:buffer";
import { checkReceipt } from "./evidence.mjs";
import { changedFiles } from "./product.mjs";
import { FoundryError } from "./values.mjs";

const maxFeedback = 8192, maxDelta = 32768, prefix = Buffer.from("FOUNDRY_GOAL_FEEDBACK=");

/** Keep the JSON spelling so a valid number or deeply nested value isn't changed by reserialization.
 * @param {unknown} value @returns {value is string} */
export function validFeedback(value) {
	if (typeof value !== "string" || Buffer.byteLength(value) > maxFeedback || /[\r\n]/.test(value)) return false;
	try { JSON.parse(value); return true; } catch { return false; }
}

/** @param {Buffer} stdout */
export function feedback(stdout) {
	/** @type {string|undefined} */ let record;
	for (let start = 0; start < stdout.length;) {
		const lf = stdout.indexOf(10, start), end = lf < 0 ? stdout.length : lf;
		if (stdout.subarray(start, start + prefix.length).equals(prefix)) {
			const bytes = stdout.subarray(start + prefix.length, stdout[end - 1] === 13 ? end - 1 : end);
			if (record !== undefined || bytes.length > maxFeedback || !isUtf8(bytes)) return;
			record = bytes.toString();
			if (!validFeedback(record)) return;
		}
		start = end + 1;
	}
	return record;
}

/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} current */
export function priorGoal(run, current) {
	for (let i = run.effects.indexOf(current) - 1; i >= 0; i--) {
		const e = run.effects[i];
		if (e.kind !== "goal") continue;
		if (e.check !== current.check || e.evaluatorRevision !== current.evaluatorRevision) return;
		const r = checkReceipt(e);
		if (!r || r.exit !== 0 && r.exit !== 1) continue;
		if (r.feedback !== undefined) return { base: r.commit, previous: r.feedback };
		return; // Never combine the latest candidate with an older summary.
	}
}

/** @param {string} cwd @param {string} head @param {NonNullable<ReturnType<typeof priorGoal>>} prior */
export function goalDelta(cwd, head, { base, previous }) {
	let paths;
	try { paths = changedFiles(cwd, base, head, [], maxDelta); }
	catch (error) {
		// Git errors (including output overflow) mean unavailable, not an empty diff.
		if (error instanceof FoundryError || error instanceof Error && "status" in error) return;
		throw error;
	}
	if (paths.length > 256) return;
	const wire = `{"version":1,"base":${JSON.stringify(base)},"head":${JSON.stringify(head)},"paths":${JSON.stringify(paths)},"previous":${previous}}`;
	if (Buffer.byteLength(wire) <= maxDelta) return wire;
}

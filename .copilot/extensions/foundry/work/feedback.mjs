import { isUtf8 } from "node:buffer";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkReceipt, sameEvaluation } from "./evidence.mjs";
import { changedFiles, git, retain } from "./product.mjs";
import { FoundryError } from "./values.mjs";

const prefix = Buffer.from("FOUNDRY_GOAL_FEEDBACK=");

/** Keep the JSON spelling so a valid number or deeply nested value isn't changed by reserialization.
 * @param {unknown} value @returns {value is string} */
export function validFeedback(value) {
	if (typeof value !== "string") return false;
	try { JSON.parse(value); return true; } catch { return false; }
}

/** @param {Buffer} stdout @param {Buffer} [file] */
export function feedback(stdout, file) {
	/** @type {string|undefined} */ let record;
	for (let start = 0; start < stdout.length;) {
		const lf = stdout.indexOf(10, start), end = lf < 0 ? stdout.length : lf;
		if (stdout.subarray(start, start + prefix.length).equals(prefix)) {
			const bytes = stdout.subarray(start + prefix.length, stdout[end - 1] === 13 ? end - 1 : end);
			if (file?.length || record !== undefined || !isUtf8(bytes)) return;
			record = bytes.toString();
			if (!validFeedback(record)) return;
		}
		start = end + 1;
	}
	if (!file?.length) return record;
	if (isUtf8(file)) {
		const json = file.toString();
		if (validFeedback(json)) return json;
	}
}

/** @typedef {{base:string, previous:string} | {base:string, file:NonNullable<import("./model.js").Receipt["feedbackFile"]>}} Prior */
/** @param {import("./model.js").Run} run @param {import("./model.js").Effect} current @returns {Prior|undefined} */
export function priorGoal(run, current) {
	for (let i = run.effects.indexOf(current) - 1; i >= 0; i--) {
		const e = run.effects[i];
		if (e.kind !== "goal") continue;
		if (e.check !== current.check || !sameEvaluation(e,current)) return;
		const r = checkReceipt(e);
		if (!r || r.exit !== 0 && r.exit !== 1) continue;
		if (r.feedbackFile) return { base: r.commit, file: r.feedbackFile };
		if (r.feedback !== undefined) return { base: r.commit, previous: r.feedback };
		return; // Never combine the latest candidate with an older summary.
	}
}

/** @param {string} cwd @param {string} head @param {Prior} prior */
export function goalDelta(cwd, head, prior) {
	const { base } = prior;
	let paths, previous;
	try {
		previous = "file" in prior ? git(cwd, ["cat-file", "blob", prior.file.blob]).toString() : prior.previous;
		paths = changedFiles(cwd, base, head, [], Infinity);
	}
	catch (error) {
		// Unavailable objects or paths are not an empty diff.
		if (error instanceof FoundryError || error instanceof Error && "status" in error) return;
		throw error;
	}
	return `{"version":1,"base":${JSON.stringify(base)},"head":${JSON.stringify(head)},"paths":${JSON.stringify(paths)},"previous":${previous}}`;
}

/** @param {string} cwd @param {string} head @param {Prior|undefined} prior @param {NodeJS.ProcessEnv} env */
export function goalFiles(cwd, head, prior, env) {
	const dir = mkdtempSync(path.join(tmpdir(), "foundry-feedback-")), output = path.join(dir, "feedback.json");
	/** @type {number|undefined} */ let fd;
	const close = () => {
		try { if (fd !== undefined) closeSync(fd); } finally { rmSync(dir, { recursive: true, force: true }); }
	};
	try {
		fd = openSync(output, "wx+", 0o600);
		env.FOUNDRY_GOAL_FEEDBACK_FILE = output;
		const delta = prior && goalDelta(cwd, head, prior);
		if (delta !== undefined) {
			const input = path.join(dir, "delta.json");
			writeFileSync(input, delta, { flag: "wx", mode: 0o400 });
			env.FOUNDRY_GOAL_DELTA_FILE = input;
			// Preserve the old inline wire for stdout-based evaluators. The complete file is always available.
			if (prior && ("previous" in prior || prior.file.legacy) && Buffer.byteLength(delta) <= 32768)
				env.FOUNDRY_GOAL_DELTA = delta;
		}
		const original = fd;
		/** @param {Buffer} stdout */
		function collect(stdout) {
			// Read the descriptor we created, not a path the evaluator could replace with a link or FIFO.
			if (fstatSync(original).nlink !== 1) throw new FoundryError("invalid_feedback", "The runner-owned output file was replaced or linked");
			const bytes = readFileSync(original), json = feedback(stdout, bytes);
			if (json !== undefined) return { json, legacy: !bytes.length };
			if (bytes.length || stdout.includes(prefix)) throw new FoundryError("invalid_feedback", "Expected one UTF-8 JSON value from the file or one stdout marker, not both");
		}
		return { close, collect };
	} catch (error) { close(); throw error; }
}

/** @param {string} cwd @param {{json:string,legacy:boolean}} value */
export function retainFeedback(cwd, { json, legacy }) {
	const oid = git(cwd, ["hash-object", "-w", "--stdin"], json).toString().trim();
	return { blob: retain(cwd, oid), ...(legacy ? { legacy: true } : {}) };
}

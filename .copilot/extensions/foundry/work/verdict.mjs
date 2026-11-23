import { FoundryError } from "./values.mjs";

/** @typedef {{kind:"component"} | {kind:"product",outputs:string[]} | {kind:"goal",squads:string[]}} Evaluation */
/** @typedef {Pick<import("./model.js").Receipt,"exit"|"output"|"failure"|"repair"|"squad">} Fields */
/** @typedef {{status:number|null,signal:string|null,error?:Error,stdout:Buffer|null,stderr:Buffer|null}} ProcessResult */

/** @param {Evaluation} check @param {ProcessResult} result @returns {{fields:Fields, feedback?:Buffer}} */
export function interpret(check, result) {
	const { stdout, stderr, error, signal } = result;
	const exit = error || signal ? null : result.status;
	/** @type {Fields} */
	const fields = { exit, output: [stdout, stderr, error?.message, signal].filter(Boolean).join("\n") };
	switch (check.kind) {
	case "component":
		if (exit === null) fields.failure = "incomplete";
		break;
	case "product":
		if (exit !== null && exit !== 0) {
			const repairs = [...String(stdout ?? "").matchAll(/^FOUNDRY_REPAIR=([A-Za-z0-9._-]+)$/gm)];
			if (repairs.length === 1 && check.outputs.includes(repairs[0][1])) fields.repair = repairs[0][1];
		}
		break;
	case "goal":
		if (exit === 1) {
			const hints = [...String(stdout ?? "").matchAll(/^FOUNDRY_SQUAD=([^\r\n]*)$/gm)];
			if (hints.length === 1 && check.squads.includes(hints[0][1])) fields.squad = hints[0][1];
		}
		if (stdout && (exit === 0 || exit === 1)) return { fields, feedback: stdout };
	}
	return { fields };
}

/** Only a completed component followed by an export verifier error attests mutation.
 * @param {Evaluation} check @param {number|null} exit @param {unknown} error @returns {Fields} */
export function interrupted(check, exit, error) {
	/** @type {Fields} */ const fields = { exit: null, output: error instanceof Error ? error.message : String(error) };
	if (check.kind === "component") fields.failure = exit !== null && error instanceof FoundryError &&
		["product_changed", "unsupported_tree", "invalid_path"].includes(error.code) ? "changed-export" : "incomplete";
	return fields;
}

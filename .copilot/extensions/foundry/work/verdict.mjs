import { isUtf8 } from "node:buffer";
import { FoundryError } from "./values.mjs";
import { signals } from "./signals.mjs";

/** @typedef {{kind:"component"} | {kind:"product",outputs:string[]} | {kind:"goal",squads:string[]}} Evaluation */
/** @typedef {Pick<import("./model.js").Receipt,"exit"|"output"|"failure"|"repair"|"squad"|"blockers">} Fields */
/** @typedef {{status:number|null,signal:string|null,error?:Error,stdout:Buffer|null,stderr:Buffer|null}} ProcessResult */

/** A process exit alone cannot identify which assertion ran. No stdout diagnostic from a product is a control.
 * @param {Buffer|null} stdout @param {number|null} exit */
export function controlObservation(stdout,exit){
	if(!stdout || !isUtf8(stdout) || !(exit===0 || exit===1))return;
	let v;try{v=JSON.parse(stdout.toString());}catch(error){if(error instanceof SyntaxError)return;throw error;}
	if(v && typeof v==="object" && Object.keys(v).length===2 && typeof v.assertion==="string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(v.assertion) && v.matched===(exit===0))
		return {assertion:v.assertion,matched:exit===0};
}

/** @param {Evaluation} check @param {ProcessResult} result @returns {{fields:Fields, feedback?:Buffer}} */
export function interpret(check, result) {
	const { stdout, stderr, error, signal } = result;
	const exit = error || signal ? null : result.status;
	/** @type {Fields} */
	const fields = { exit, output: [stdout, stderr, error?.message, signal].filter(part => part?.length).join("\n") };
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
		if (stdout && (exit === 0 || exit === 1 || exit === 2)) {
			try {
				const list = signals(stdout, exit);
				if (list) fields.blockers = list;
			} catch (e) {
				if (!(e instanceof FoundryError)) throw e;
				fields.output += `\nFoundry blocker attribution unavailable: ${e.message}`;
			}
			if (exit !== 2) return { fields, feedback: stdout };
		}
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

import { latestEvidence } from "./values.mjs";

/** @typedef {import("./model.js").Check} Check */
/** @typedef {import("./model.js").Evidence} Evidence */
/** @typedef {import("./model.js").Finding} Finding */

/**
 * Evidence is admitted from actual native results before this decision runs.
 * Review prose does not create a new acceptance obligation.
 *
 * @param {Check[]} checks
 * @param {Evidence[]} evidence in canonical admission order
 * @param {Finding[]} [findings]
 * @returns {{passed:boolean,missing:string[],failed:string[],advisory:Finding[]}}
 */
export function evaluate(checks, evidence, findings = []) {
	const latest = latestEvidence(evidence);
	const missing = checks.filter(check => {
		const item = latest.get(JSON.stringify([check.id, check.version]));
		return !item || item.outcome === "pending";
	}).map(check => check.id);
	const failed = checks.filter(check => latest.get(JSON.stringify([check.id, check.version]))?.outcome === "failed")
		.map(check => check.id);
	return {
		passed: missing.length === 0 && failed.length === 0,
		missing,
		failed,
		advisory: findings,
	};
}

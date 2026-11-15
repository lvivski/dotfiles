/** @typedef {import("./model.js").Check} Check */
/** @typedef {import("./model.js").Evidence} Evidence */
/** @typedef {import("./model.js").Finding} Finding */

/**
 * Evidence is admitted from actual native results before this decision runs.
 * Review prose does not create a new acceptance obligation.
 *
 * @param {Check[]} checks
 * @param {Evidence[]} evidence chronologically ordered admitted observations
 * @param {Finding[]} [findings]
 */
export function evaluate(checks, evidence, findings = []) {
	const latest = new Map(evidence.map(item => [`${item.checkId}:${item.checkVersion}`, item]));
	const missing = checks.filter(check => {
		const item = latest.get(`${check.id}:${check.version}`);
		return !item || item.outcome === "pending";
	}).map(check => check.id);
	const failed = checks.filter(check => latest.get(`${check.id}:${check.version}`)?.outcome === "failed")
		.map(check => check.id);
	const indexed = new Map(evidence.map(item => [item.id, item]));
	const blocking = findings.filter(finding => {
		if (!finding.expected?.trim() || !finding.observed?.trim()) return false;
		if (!finding.obligation && !checks.some(check => check.id === finding.checkId)) return false;
		return finding.evidenceIds.some(id => {
			const item = indexed.get(id);
			const assigned = checks.find(check => check.id === item?.checkId);
			if (assigned && assigned.version !== item?.checkVersion) return false;
			if (item && latest.get(`${item.checkId}:${item.checkVersion}`)?.id !== item.id) return false;
			return item?.outcome === "failed"
				&& (finding.checkId === undefined || item.checkId === finding.checkId);
		});
	});
	return {
		passed: missing.length === 0 && failed.length === 0 && blocking.length === 0,
		missing,
		failed,
		blocking,
		advisory: findings.filter(finding => !blocking.includes(finding)),
	};
}

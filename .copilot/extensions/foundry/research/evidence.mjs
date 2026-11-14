import { isList } from "../data.mjs";

/**
 * @typedef {{url: string, evidence: string}} Source
 * @typedef {{id: string, claim: string, status: string, reasons: string,
 *   sources: Source[], history: string[]}} Finding
 * @typedef {{index: number, angle: string, draft: string | null, feedback: string,
 *   findings: Finding[], limitations: string[], failures: string[],
 *   correction: string | null, correctionAttempted: boolean, corrections?: string[]}} ResearchRow
 */

export const STATUSES = ["supported", "incorrect", "inaccessible", "insufficient"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
export function text(value) {
	return typeof value === "string" && value.trim() && !value.includes("\0") ? value : "";
}

/** @param {unknown} value @returns {Source[] | null} */
function readSources(value) {
	if (!isList(value)) return null;
	const sources = [];
	for (const item of value) {
		if (!isRecord(item) || !text(item.url) || !text(item.evidence)) return null;
		let url;
		try {
			url = new URL(text(item.url));
		} catch (error) {
			if (error instanceof TypeError) return null;
			throw error;
		}
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
			return null;
		}
		sources.push({ url: url.href, evidence: text(item.evidence) });
	}
	return sources;
}

/** @param {unknown} value @param {string} id @param {string} [fallbackClaim] @returns {Finding} */
export function readFinding(value, id, fallbackClaim = "Unspecified claim") {
	const record = isRecord(value) ? value : {};
	const claim = text(record.claim);
	const reasons = text(record.reasons);
	const status = text(record.status);
	const sources = readSources(record.sources);
	const malformed = !claim || !reasons || !STATUSES.includes(status) || sources === null;
	const unsupportedPass = status === "supported" && !sources?.length;
	return {
		id,
		claim: claim || fallbackClaim,
		status: malformed || unsupportedPass ? "insufficient" : status,
		reasons: malformed
			? `Malformed finding or source evidence; not accepted. ${reasons}`.trim()
			: unsupportedPass
				? `Supported verdict lacked source evidence; not accepted. ${reasons}`
				: reasons,
		sources: sources ?? [],
		history: [],
	};
}

/** @param {unknown} value @param {ResearchRow} row @param {string} stage */
export function readReview(value, row, stage) {
	if (!isRecord(value) || !isList(value.findings)) {
		row.failures.push(`${stage} returned no usable review; earlier verified findings are retained.`);
		return null;
	}
	if (!isList(value.limitations) || !value.limitations.every((item) => text(item))) {
		row.limitations.push(`${stage} supplied incomplete limitation notes; its findings are assessed individually.`);
	}
	if (isList(value.limitations)) {
		row.limitations.push(...value.limitations.map((item) => text(item)).filter(Boolean));
	}
	return value.findings;
}

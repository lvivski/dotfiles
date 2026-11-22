import { fail, fields, record, text } from "./values.mjs";

/** @satisfies {import("@github/copilot-sdk").CustomAgentConfig} */
export const researchAgent = {
	name: "foundry-research", description: "Answer one Foundry planning question using source and public documentation.",
	tools: ["glob", "rg", "view", "web_search", "web_fetch"], infer: true,
	prompt: "Use only permitted sources. Never send private source, identifiers or credentials to external services. Attribute findings; missing evidence is unknown, not a product gap.",
};

const string = { type: "string" };
export const researchSchema = {
	type: "object", additionalProperties: false, required: ["status", "reason", "findings"],
	properties: { status: { type: "string", enum: ["answered", "unknown"] }, reason: string,
		findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "source", "finding"],
			properties: { kind: string, source: string, finding: string } } } },
};

/** @param {unknown} v @param {number} limit @param {string} label */
function bounded(v, limit, label) {
	const s = text(v, label);
	if (s.length > limit) fail("invalid_research", `${label} exceeds ${limit} characters`);
	return s;
}

/** @param {unknown} v @returns {import("./model.js").Finding[]} */
export function findings(v) {
	if (!Array.isArray(v) || v.length > 12) fail("invalid_research", "Expected up to 12 cited research findings");
	return v.map(value => {
		const f = record(value);
		fields(f, ["kind", "source", "finding"]);
		return { kind: bounded(f.kind, 32, "source kind"), source: bounded(f.source, 512, "source locator"), finding: bounded(f.finding, 1024, "finding") };
	});
}

/** Only the bound research review uses this wire format. Its sources remain
 * attributed observations, not charter file citations or evaluator receipts.
 * @param {unknown} raw @param {string} charter @returns {import("./model.js").Observation} */
export function researchResult(raw, charter) {
	if (raw === null) return { outcome: "needs-decision", reason: "The research agent returned no evidence. The question remains unresolved.",
		evidence: [charter], grains: [], findings: [] };
	const result = record(raw);
	fields(result, ["status", "reason", "findings"]);
	const cited = findings(result.findings);
	if (result.status !== "unknown" && !(result.status === "answered" && cited.length))
		fail("invalid_research", "An answered investigation requires cited findings; otherwise report unknown");
	return { outcome: result.status === "answered" ? "researched" : "needs-decision",
		reason: bounded(result.reason, 2048, "research reason"), evidence: [charter], grains: [], findings: cited };
}

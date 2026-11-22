import { fail, fields, record, text } from "./values.mjs";

/** @satisfies {import("@github/copilot-sdk").CustomAgentConfig} */
export const researchAgent = {
	name: "foundry-research", description: "Answer one Foundry planning question using source and public documentation.",
	tools: ["glob", "rg", "view", "web_search", "web_fetch"], infer: true,
	prompt: "Use only permitted sources. Never send private source, identifiers or credentials to external services. Attribute findings; missing evidence is unknown, not a product gap.",
};

const string = { type: "string" };
const maxFindings = 12, maxText = 24 * 1024;
export const researchBudget = `Up to ${maxFindings} findings and ${maxText} UTF-16 code units of text across the reason and all citations combined.`;
export const researchSchema = {
	type: "object", description: researchBudget, additionalProperties: false, required: ["status", "reason", "findings"],
	properties: { status: { type: "string", enum: ["answered", "unknown"] }, reason: string,
		findings: { type: "array", maxItems: maxFindings, items: { type: "object", additionalProperties: false, required: ["kind", "source", "finding"],
			properties: { kind: string, source: string, finding: string } } } },
};

/** @param {unknown} v @returns {import("./model.js").Finding[]} */
function findings(v) {
	if (!Array.isArray(v) || v.length > maxFindings) fail("invalid_research", `Expected up to ${maxFindings} cited research findings`);
	return v.map(value => {
		const f = record(value);
		fields(f, ["kind", "source", "finding"]);
		return { kind: text(f.kind, "source kind"), source: text(f.source, "source locator"), finding: text(f.finding, "finding") };
	});
}

/** Only the bound research review uses this wire format. Its sources remain
 * attributed observations, not charter file citations or evaluator receipts.
 * @param {unknown} raw @param {string} charter @returns {import("./model.js").Observation} */
export function researchResult(raw, charter) {
	if (raw === null) return { outcome: "unresolved", reason: "The research agent returned no evidence. The question remains unresolved.",
		evidence: [charter], grains: [], findings: [] };
	const result = record(raw);
	fields(result, ["status", "reason", "findings"]);
	const cited = findings(result.findings), reason = text(result.reason, "research reason");
	if (cited.reduce((n, f) => n + f.kind.length + f.source.length + f.finding.length, reason.length) > maxText)
		fail("invalid_research", `Research report exceeds its text budget. ${researchBudget}`);
	if (result.status !== "unknown" && !(result.status === "answered" && cited.length))
		fail("invalid_research", "An answered investigation requires cited findings; otherwise report unknown");
	return { outcome: result.status === "answered" ? "researched" : "unresolved",
		reason, evidence: [charter], grains: [], findings: cited };
}

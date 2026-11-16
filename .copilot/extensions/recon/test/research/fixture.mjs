/** @typedef {AgentOptions & {label: string}} NamedAgentOptions */
/** @typedef {NonNullable<Parameters<import("@github/copilot-sdk").WorkflowContext["agent"]>[1]>} AgentOptions */

export function researchFinding(status = "supported", overrides = {}) {
	return {
		claim: "An independently sourced claim",
		status,
		reasons: status === "supported" ? "Source directly supports the claim" : "Evidence needs correction",
		sources: [{ url: "https://example.test/source", evidence: "Relevant source passage" }],
		...overrides,
	};
}

/** @param {string} _prompt @param {NamedAgentOptions} options */
export function mixedResearchResponse(_prompt, options) {
	if (options.label.startsWith("verify-findings:")) {
		return {
			findings: [
				researchFinding("supported", { claim: "KEEP_VERIFIED" }),
				researchFinding("incorrect", { claim: "WRONG_DETAIL", reasons: "Edition mismatch" }),
			],
			limitations: [],
		};
	}
	if (options.label.startsWith("correct-findings:")) return "Corrected candidate for 1.2 with evidence";
	if (options.label.startsWith("reverify-findings:")) {
		return {
			findings: [researchFinding("supported", { id: "1.2", claim: "CORRECTED_DETAIL" })],
			limitations: [],
		};
	}
	return undefined;
}

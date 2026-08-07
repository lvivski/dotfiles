export const meta = {
	name: "minimal-review",
	description: "Review items, verify findings, and synthesize a report.",
	limits: { maxConcurrentSubagents: 4, maxTotalSubagents: 20, maxAiCredits: 20 },
};

const items = context.args || ["item one", "item two"];
const VERDICT = {
	type: "object",
	properties: { passed: { type: "boolean" }, reason: { type: "string" } },
	required: ["passed", "reason"],
};

phase("Review");
const rows = await pipeline(
	items,
	(item, _original, index) =>
		agent(`Review this item and report concrete findings: ${item}`, {
			label: `review:${index}`,
		}),
	async (finding, item, index) => {
		if (finding === null) return null;
		const verdict = await agent(
			`Is this finding specific, supported, and actionable?\n\nItem: ${item}\n\nFinding: ${finding}`,
			{ label: `verify:${index}`, schema: VERDICT },
		);
		return verdict?.passed ? finding : null;
	},
);

phase("Report");
const report = await agent(
	`Deduplicate and summarize these verified findings:\n\n${rows.filter(Boolean).join("\n\n")}`,
	{ label: "report" },
);
return report;

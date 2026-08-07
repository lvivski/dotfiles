export const meta = {
	name: "pipeline-review",
	description: "Review files, independently verify findings, and group survivors by severity.",
	limits: { maxConcurrentSubagents: 4, maxTotalSubagents: 30, maxAiCredits: 30 },
};

const files = context.args || ["README.md"];
const VERDICT = {
	type: "object",
	properties: { passed: { type: "boolean" }, reason: { type: "string" } },
	required: ["passed", "reason"],
};

phase("Review");
const rows = await pipeline(
	files,
	(path, _original, index) =>
		agent(`Review ${path} for real, reproducible bugs. Say NO ISSUES if none.`, {
			label: `review:${index}`,
		}),
	async (review, path, index) => {
		if (review === null || review.trim().toUpperCase() === "NO ISSUES") return null;
		const verdict = await agent(
			`Independently open ${path} and verify this claimed bug:\n\n${review}`,
			{ label: `verify:${index}`, schema: VERDICT },
		);
		return verdict?.passed ? { path, review } : null;
	},
);
const solid = rows.filter(Boolean);
if (!solid.length) return "No verified issues found.";

phase("Report");
return agent(
	`Group these verified findings by severity:\n\n${solid.map((row) => `${row.path}:\n${row.review}`).join("\n\n")}`,
	{ label: "report" },
);

export const meta = {
	name: "deep-research",
	description: "Research independent angles, verify source support, and synthesize a cited answer.",
	limits: { maxConcurrentSubagents: 5, maxTotalSubagents: 20, maxAiCredits: 100 },
};

const question = String(context.args || "").trim();
if (!question) throw new Error("question is required");

phase("Plan");
const planned = await agent(`Break this question into four independent angles:\n\n${question}`, {
	label: "plan",
	schema: { type: "array", items: { type: "string" } },
});
if (planned === null) return "Planning failed.";

const VERDICT = {
	type: "object",
	properties: { passed: { type: "boolean" }, reason: { type: "string" } },
	required: ["passed", "reason"],
};
phase("Research");
const checked = await pipeline(
	planned.slice(0, 4),
	async (angle, _original, index) => ({
		angle,
		finding: await agent(
			`Research this angle and cite every material claim:\n\nQuestion: ${question}\n\nAngle: ${angle}`,
			{ label: `research:${index}` },
		),
	}),
	async (row, _angle, index) => {
		if (row.finding === null) return null;
		const verdict = await agent(
			`Verify every cited claim and URL:\n\n${row.finding}`,
			{ label: `verify:${index}`, schema: VERDICT },
		);
		return verdict?.passed ? row : null;
	},
);
const trusted = checked.filter(Boolean);
if (!trusted.length) return "No research angle passed source verification.";

phase("Report");
return agent(
	`Answer the question using only these verified findings:\n\n${trusted.map((row) => row.finding).join("\n\n")}`,
	{ label: "report" },
);

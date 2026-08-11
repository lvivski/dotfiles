// Fan out research across independent angles, verify sourced claims, and synthesize a report.
export const meta = {
	name: "deep-research",
	description: "Fan out web research, verify sourced claims, and synthesize a cited report.",
	limits: {
		maxConcurrentSubagents: 6,
		maxTotalSubagents: 40,
		timeoutSeconds: 1800,
		maxAiCredits: 10000,
	},
};

const input = context.args;
const question = String(
	input && typeof input === "object" && !Array.isArray(input)
		? input.question || input.q || ""
		: input || "",
).trim();
const requestedAngles = Number(
	input && typeof input === "object" && !Array.isArray(input)
		? input.angles ?? 5
		: 5,
);
if (!question) throw new Error("deep-research: provide a non-empty question");
if (!Number.isInteger(requestedAngles) || requestedAngles < 1) {
	throw new Error("deep-research: angles must be a positive integer");
}
const maxAngles = Math.min(requestedAngles, 12);

phase("Plan");
const planned = await agent(
	`Break this research question into ${maxAngles} independent, non-overlapping angles.

Question: ${question}`,
	{
		label: "plan",
		schema: { type: "array", items: { type: "string" } },
	},
);
if (planned === null) {
	return "# Research incomplete\n\nPlanning failed. No research was performed.";
}
const seen = new Set();
const angles = planned
	.map((angle) => String(angle).trim())
	.filter(Boolean)
	.filter((angle) => {
		const key = angle.toLowerCase().replace(/\s+/g, " ");
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	})
	.slice(0, maxAngles);
if (!angles.length) {
	return "# Research incomplete\n\nThe planner returned no usable research angles.";
}
log(`deep-research: ${angles.length} angle(s)`);

const VERDICT = {
	type: "object",
	properties: {
		passed: { type: "boolean" },
		reasons: { type: "string" },
	},
	required: ["passed", "reasons"],
};

phase("Research");
const checked = await pipeline(
	angles,
	async (angle) => ({
		angle,
		finding: await agent(
			`Research this assigned angle using web search. Cite every material claim with a source URL and flag thin or conflicting evidence.

Original question:
${question}

Assigned angle:
${angle}`,
			{ label: `research:${angle.slice(0, 32)}` },
		),
	}),
	async (row) => {
		if (row.finding === null) return { ...row, verdict: null };
		const verdict = await agent(
			`Independently check every material claim and cited URL below. Pass only when the sources are credible, accessible, relevant, and support the claims.

Question:
${question}

Angle:
${row.angle}

Finding:
${row.finding}`,
			{ label: `verify:${row.angle.slice(0, 32)}`, schema: VERDICT },
		);
		return { ...row, verdict };
	},
);

const rows = checked.map((row, index) =>
	row ?? { angle: angles[index], finding: null, verdict: null },
);
const trusted = rows.filter((row) => row.finding !== null && row.verdict?.passed === true);
const failed = rows.filter((row) => row.finding === null || row.verdict === null).length;
const rejected = rows.filter((row) => row.verdict && !row.verdict.passed).length;
const boundaries = requestedAngles > maxAngles
	? ` Requested ${requestedAngles} angles; capped at ${maxAngles}.`
	: "";
const coverage =
	`Coverage: ${rows.length} angles researched; ${trusted.length} source-verified, ` +
	`${rejected} rejected, ${failed} failed.${boundaries}`;
if (!trusted.length) {
	return `# Research unsupported\n\nNo research angle passed source verification.\n\n_${coverage}_`;
}

phase("Report");
const findings = trusted
	.map((row, index) => `=== Finding ${index + 1}: ${row.angle} ===\n${row.finding}`)
	.join("\n\n");
const report = await agent(
	`Write a well-structured cited report answering the question from these verified findings. Keep only supported claims and list open questions.

Question:
${question}

${findings}`,
	{ label: "report" },
);
if (report === null) {
	return `# Research incomplete\n\nVerified findings could not be synthesized.\n\n_${coverage}_`;
}
return `${report}\n\n_${coverage}_`;

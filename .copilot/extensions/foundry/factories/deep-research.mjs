// Fan out research across independent angles, verify sourced claims, and synthesize a report.
import {
	UNTRUSTED_DATA_WARNING,
	untrustedBlock,
} from "../prompts.mjs";
const RESEARCH_OPTIONS_SCHEMA = {
	type: "object",
	required: ["question"],
	properties: {
		question: { type: "string" },
		angles: { type: "integer" },
	},
};
const MAX_FIXED_SUBAGENTS = 3;
const MAX_SUBAGENTS_PER_ANGLE = 3;
const MAX_PARALLEL_ANGLES = 2;

export const meta = {
	name: "deep-research",
	description:
		"Fan out web research, verify sourced claims, and synthesize a cited report. " +
		"Args: { question: string, angles?: number } or a question string.",
	phases: [{ title: "Plan" }, { title: "Research" }, { title: "Report" }],
	argsSchema: {
		anyOf: [
			{ type: "string" },
			RESEARCH_OPTIONS_SCHEMA,
			{
				type: "object",
				required: ["q"],
				properties: {
					q: { type: "string" },
					angles: { type: "integer" },
				},
			},
		],
	},
	limits: {
		maxConcurrentSubagents: MAX_PARALLEL_ANGLES,
		maxTotalSubagents: 40,
		timeoutSeconds: 3600,
		maxAiCredits: 10000,
	},
};

export async function run(factory) {
const input = factory.args;
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
const budgetedAngles = Math.floor(
	(meta.limits.maxTotalSubagents - MAX_FIXED_SUBAGENTS) /
		MAX_SUBAGENTS_PER_ANGLE,
);
const maxAngles = Math.min(requestedAngles, 12, budgetedAngles);

factory.phase("Plan");
const planned = await factory.agent(
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
factory.log(`deep-research: ${angles.length} angle(s)`);

const VERDICT = {
	type: "object",
	properties: {
		passed: { type: "boolean" },
		reasons: { type: "string" },
	},
	required: ["passed", "reasons"],
};

factory.phase("Research");
const checked = [];
for (let offset = 0; offset < angles.length; offset += MAX_PARALLEL_ANGLES) {
	const batch = angles.slice(offset, offset + MAX_PARALLEL_ANGLES).map(
		(angle, index) => ({ angle, index: offset + index }),
	);
	factory.log(
		`deep-research: angle batch ${Math.floor(offset / MAX_PARALLEL_ANGLES) + 1}/${
			Math.ceil(angles.length / MAX_PARALLEL_ANGLES)
		}`,
	);
	const batchResults = await factory.pipeline(
		batch,
		async ({ angle, index }) => ({
			angle,
			index,
			// Factory agent profiles are not selectable yet, so use a factory-owned router.
			finding: await factory.agent(
				`Act only as a routing agent. Call the task tool exactly once with:
- agent_type: "research"
- mode: "sync"

In the delegated prompt, instruct the research agent to use web search, cite every material claim with a source URL, and flag thin or conflicting evidence. Return the research agent's report without adding unsupported claims. Do not research the angle yourself or silently fall back; report a delegation failure explicitly.

Original question:
${question}

Assigned angle from the planning agent:
${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", angle)}`,
				{ label: `research:${index + 1}:${angle.slice(0, 32)}` },
			),
		}),
		async (row) => {
			if (row.finding === null) return { ...row, verdict: null };
			const verdict = await factory.agent(
				`Independently check every material claim and cited URL below. Pass only when the sources are credible, accessible, relevant, and support the claims.

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("RESEARCH-ANGLE", row.angle)}

${untrustedBlock("RESEARCH-FINDING", row.finding)}`,
				{
					label: `verify:${row.index + 1}:${row.angle.slice(0, 32)}`,
					schema: VERDICT,
				},
			);
			return { ...row, verdict };
		},
	);
	checked.push(...batchResults);
}

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

factory.phase("Report");
const findings = trusted
	.map((row, index) => `=== Finding ${index + 1}: ${row.angle} ===\n${row.finding}`)
	.join("\n\n");
const report = await factory.agent(
	`Write a well-structured cited report answering the question from these verified findings. Keep only supported claims and list open questions.

Question:
${question}

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("VERIFIED-RESEARCH", findings)}`,
	{ label: "report" },
);
if (report === null) {
	return `# Research incomplete\n\nVerified findings could not be synthesized.\n\n_${coverage}_`;
}
return `${report}\n\n_${coverage}_`;
}

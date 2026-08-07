// Audit files for a concern, independently verify each review, and synthesize a report.
export const meta = {
	name: "audit",
	description: "Audit files for a concern, verify findings, and summarize actionable issues.",
	limits: {
		maxConcurrentSubagents: 4,
		maxTotalSubagents: 40,
		timeoutSeconds: 900,
		maxAiCredits: 100,
	},
};

const DEFAULT_CONCERN = "bugs, security issues, and missing error handling";
const input = context.args;
const rawPaths =
	input && typeof input === "object" && !Array.isArray(input)
		? input.paths
		: input;
const concern =
	input && typeof input === "object" && !Array.isArray(input)
		? String(input.concern ?? DEFAULT_CONCERN).trim()
		: DEFAULT_CONCERN;

if (!Array.isArray(rawPaths) || !rawPaths.length) {
	throw new Error('audit: provide {"paths":["src/a.js"],"concern":"..."} or an array of paths');
}
const paths = [...new Set(rawPaths.map((path) => String(path).trim()).filter(Boolean))];
if (!paths.length) throw new Error("audit: paths must contain at least one non-empty path");
if (!concern) throw new Error("audit: concern must be non-empty");

const VERDICT = {
	type: "object",
	properties: {
		passed: { type: "boolean" },
		reasons: { type: "string" },
	},
	required: ["passed", "reasons"],
};

phase("Audit");
const checked = await pipeline(
	paths,
	async (path) => ({
		path,
		finding: await agent(
			`Open \`${path}\` and review it for ${concern}. Give concrete issues with line references, or reply exactly "NO ISSUES".`,
			{ label: `review:${path}` },
		),
	}),
	async (reviewed) => {
		if (reviewed.finding === null) {
			return { ...reviewed, status: "failed", reason: "review agent failed" };
		}
		const noIssues = reviewed.finding.trim().toUpperCase() === "NO ISSUES";
		const verdict = await agent(
			`Independently open \`${reviewed.path}\` and check this review for ${concern}.
Pass only when every reported issue is real and supported by the file, or when the NO ISSUES claim is accurate.

Review:
${reviewed.finding}`,
			{ label: `verify:${reviewed.path}`, schema: VERDICT },
		);
		if (verdict === null) return { ...reviewed, status: "failed", reason: "verification agent failed" };
		return {
			...reviewed,
			status: verdict.passed ? (noIssues ? "clean" : "verified") : "rejected",
			reason: verdict.reasons,
		};
	},
);

const rows = checked.map((row, index) =>
	row ?? { path: paths[index], finding: null, status: "failed", reason: "pipeline branch failed" },
);
const verified = rows.filter((row) => row.status === "verified");
const counts = Object.fromEntries(
	["verified", "clean", "rejected", "failed"].map((status) => [
		status,
		rows.filter((row) => row.status === status).length,
	]),
);
const coverage =
	`Coverage: ${rows.length}/${paths.length} files processed; ` +
	`${counts.verified} verified, ${counts.clean} clean, ${counts.rejected} rejected, ${counts.failed} failed.`;

if (!verified.length) {
	const incomplete = counts.failed || counts.rejected;
	return `${incomplete ? "# Audit incomplete" : "# Audit"}\n\n${
		incomplete
			? "No issue report survived verification; do not interpret this as a clean audit."
			: `No verified issues found for ${concern}.`
	}\n\n_${coverage}_`;
}

phase("Report");
const findings = verified
	.map((row) => `## ${row.path}\n${row.finding}`)
	.join("\n\n");
const report = await agent(
	`Summarize these independently verified findings about ${concern}. Group by severity and include a concise fix for each issue.

${findings}`,
	{ label: "report" },
);
if (report === null) {
	return `# Audit incomplete\n\nVerified findings could not be synthesized.\n\n_${coverage}_`;
}
return `${report}\n\n_${coverage}_`;

// Audit files for a concern, independently verify each review, and synthesize a report.
import {
	UNTRUSTED_DATA_WARNING,
	safeJson,
	untrustedBlock,
} from "../prompts.mjs";
const PATHS_SCHEMA = {
	type: "array",
	items: { type: "string" },
};
const MAX_SUBAGENTS_PER_PATH = 3;

export const meta = {
	name: "audit",
	description:
		"Audit files for a concern, verify findings, and summarize actionable issues. " +
		"Args: { paths: string[], concern?: string } or a string array.",
	phases: [{ title: "Audit" }, { title: "Report" }],
	argsSchema: {
		anyOf: [
			PATHS_SCHEMA,
			{
				type: "object",
				required: ["paths"],
				properties: {
					paths: PATHS_SCHEMA,
					concern: { type: "string" },
				},
			},
		],
	},
	limits: {
		maxConcurrentSubagents: 4,
		maxTotalSubagents: 40,
		timeoutSeconds: 900,
		maxAiCredits: 10000,
	},
};

export async function run(factory) {
const DEFAULT_CONCERN = "bugs, security issues, and missing error handling";
const input = factory.args;
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
if (concern.length > 4_000) {
	throw new Error("audit: concern must contain at most 4000 characters");
}
const normalizedPaths = rawPaths.map((path, index) => {
	const value = String(path).trim();
	if (value.length > 4_096) {
		throw new Error(`audit: path ${index + 1} exceeds 4096 characters`);
	}
	return value;
});
const paths = [...new Set(normalizedPaths.filter(Boolean))];
if (!paths.length) throw new Error("audit: paths must contain at least one non-empty path");
if (!concern) throw new Error("audit: concern must be non-empty");
const maxPaths = Math.floor(
	(meta.limits.maxTotalSubagents - 1) / MAX_SUBAGENTS_PER_PATH,
);
if (paths.length > maxPaths) {
	throw new Error(
		`audit: ${paths.length} paths require more than ${meta.limits.maxTotalSubagents} subagents; maximum is ${maxPaths}`,
	);
}
factory.log(`audit: ${paths.length} path(s)`);

const VERDICT = {
	type: "object",
	properties: {
		passed: { type: "boolean" },
		reasons: { type: "string" },
	},
	required: ["passed", "reasons"],
};

factory.phase("Audit");
const checked = await factory.pipeline(
	paths,
	async (path) => ({
		path,
		finding: await factory.agent(
			`Open the file at ${safeJson(path)} and review it for ${concern}. Give concrete issues with line references, or reply exactly "NO ISSUES".`,
			{ label: `review:${path}` },
		),
	}),
	async (reviewed) => {
		if (reviewed.finding === null) {
			return { ...reviewed, status: "failed", reason: "review agent failed" };
		}
		const noIssues = reviewed.finding.trim().toUpperCase() === "NO ISSUES";
		const verdict = await factory.agent(
			`Independently open the file at ${safeJson(reviewed.path)} and check this review for ${concern}.
Pass only when every reported issue is real and supported by the file, or when the NO ISSUES claim is accurate.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("PRIMARY-REVIEW", reviewed.finding)}`,
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

factory.phase("Report");
const findings = verified
	.map((row) => `## ${row.path}\n${row.finding}`)
	.join("\n\n");
const report = await factory.agent(
	`Summarize these independently verified findings about ${concern}. Group by severity and include a concise fix for each issue.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("VERIFIED-FINDINGS", findings)}`,
	{ label: "report" },
);
if (report === null) {
	return `# Audit incomplete\n\nVerified findings could not be synthesized.\n\n_${coverage}_`;
}
return `${report}\n\n_${coverage}_`;
}

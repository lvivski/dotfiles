// Audit files for a concern, independently verify each review, and synthesize a report.
import { arrayOf, isList, isRecord, nullable, readBoolean, readString, recordOf } from "../data.mjs";
import { UNTRUSTED_DATA_WARNING, safeJson, untrustedBlock } from "../prompt.mjs";
const PATHS_SCHEMA = {
	type: "array",
	items: { type: "string" },
};
/** @type {import("@github/copilot-sdk").WorkflowMeta} */
export const meta = {
	name: "audit",
	description:
		"Audit files for a concern, verify findings, and summarize actionable issues. " +
		"Args: { paths: string[], concern?: string, pauseBeforeWork?: boolean } or a string array.",
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
					pauseBeforeWork: { type: "boolean" },
				},
			},
		],
	},
};

/** @param {Pick<import("@github/copilot-sdk").WorkflowContext, "args" | "phase" | "agent" | "pipeline" | "step" | "log" | "pause">} workflow */
export async function run(workflow) {
	const DEFAULT_CONCERN = "bugs, security issues, and missing error handling";
	const input = workflow.args;
	const opts =
		isRecord(input)
			? input
			: {};
	if (opts.pauseBeforeWork !== undefined && typeof opts.pauseBeforeWork !== "boolean") {
		throw new Error("audit: pauseBeforeWork must be a boolean");
	}
	const rawPaths = isList(input) ? input : opts.paths;
	const requestedConcern = String(opts.concern ?? DEFAULT_CONCERN);

	if (!isList(rawPaths) || !rawPaths.length) {
		throw new Error('audit: provide {"paths":["src/a.js"],"concern":"..."} or an array of paths');
	}
	const normalizedPaths = rawPaths.map((path, index) => {
		if (typeof path !== "string" || path.includes("\0")) {
			throw new Error(`audit: path ${index + 1} must be a string without NUL`);
		}
		return path;
	});
	const selectedPaths = [...new Set(normalizedPaths.filter(value => value.trim()))];
	if (!selectedPaths.length) throw new Error("audit: paths must contain at least one non-empty path");
	if (!requestedConcern.trim() || requestedConcern.includes("\0")) throw new Error("audit: concern must be non-empty without NUL");
	const { paths, concern } = recordOf({ paths: arrayOf(readString), concern: readString })(await workflow.step("audit:prepared-scope:v2", () => ({
		paths: selectedPaths,
		concern: requestedConcern,
	})));
	workflow.log(`audit: ${paths.length} path(s)`);
	if (opts.pauseBeforeWork) {
		workflow.log(`audit: prepared scope ${safeJson({ paths, concern }, 0)}`);
		await workflow.pause("audit:before-audit:v1");
	}

	const VERDICT = {
		type: "object",
		additionalProperties: false,
		properties: {
			passed: { type: "boolean" },
			reasons: { type: "string" },
		},
		required: ["passed", "reasons"],
	};

	workflow.phase("Audit");
	/** @type {Array<{path: string, finding: string | null, status: string, reason: string}>} */
	const reports = paths.map((path) => ({ path, finding: null, status: "failed", reason: "review agent failed" }));
	const checked = await workflow.pipeline(
		paths,
		async (_path, _original, index) => {
			const report = reports[index];
			report.finding = nullable(readString)(await workflow.agent(
				`Open the file at ${safeJson(report.path)} and review it for ${concern}. Give concrete issues with line references, or reply exactly "NO ISSUES".`,
				{ label: `review:${report.path}` },
			));
			return report;
		},
		async (_reviewed, _original, index) => {
			const reviewed = reports[index];
			if (reviewed.finding === null) {
				return { ...reviewed, status: "failed", reason: "review agent failed" };
			}
			const noIssues = reviewed.finding.trim().toUpperCase() === "NO ISSUES";
			const verdict = nullable(recordOf({ passed: readBoolean, reasons: readString }))(await workflow.agent(
				`Independently open the file at ${safeJson(reviewed.path)} and check this review for ${concern}.
Pass only when every reported issue is real and supported by the file, or when the NO ISSUES claim is accurate.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("PRIMARY-REVIEW", reviewed.finding)}`,
				{ label: `verify:${reviewed.path}`, schema: VERDICT },
			));
			reviewed.status = verdict === null ? "failed" : verdict.passed ? (noIssues ? "clean" : "verified") : "rejected";
			reviewed.reason = verdict?.reasons ?? "verification agent failed";
			return reviewed;
		},
	);

	const rows = checked.map((row, index) =>
		row === null ? { path: paths[index], finding: null, status: "failed", reason: "pipeline branch failed" } : reports[index],
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
		return `${incomplete ? "# Audit incomplete" : "# Audit"}\n\n${incomplete
				? "No issue report survived verification; do not interpret this as a clean audit."
				: `No verified issues found for ${concern}.`
			}\n\n_${coverage}_`;
	}

	workflow.phase("Report");
	const findings = verified
		.map((row) => `## ${row.path}\n${row.finding}`)
		.join("\n\n");
	const report = await workflow.agent(
		`Summarize these independently verified findings about ${concern}. Group by severity and include a concise fix for each issue.

${UNTRUSTED_DATA_WARNING}
${untrustedBlock("VERIFIED-FINDINGS", findings)}`,
		{ label: "report" },
	);
	const narrative = typeof report === "string" && report.trim()
		? report
		: "# Audit incomplete\n\nNarrative synthesis failed; the independently verified findings are retained below.";
	return `${narrative}\n\n# Verified findings\n\n${findings}\n\n_${coverage}_`;
}

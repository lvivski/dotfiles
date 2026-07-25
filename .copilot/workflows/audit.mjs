// audit.mjs — audit files for a concern, adversarially verify findings, synthesize a report.
//
//   run_workflow({ name: "audit", budget: 1000,
//                  args: { paths: ["src/a.js", "src/b.js"], concern: "missing input validation" } })
//   run_workflow({ name: "audit", args: ["src/a.js", "src/b.js"] })
//
// Read-only: agents view the files from the directory the workflow is launched in.
export const meta = {
	name: "audit",
	description: "Audit files for a concern, verify findings, and summarize actionable issues.",
	phases: ["audit", "verify", "report"],
};

const DEFAULT_CONCERN = "bugs, security issues, and missing error handling";

const input = context.args;
let paths, concern;
if (input && typeof input === "object" && !Array.isArray(input)) {
	paths = input.paths || [];
	concern = input.concern ?? DEFAULT_CONCERN;
} else if (Array.isArray(input)) {
	paths = input;
	concern = DEFAULT_CONCERN;
} else {
	paths = [];
	concern = DEFAULT_CONCERN;
}

if (!Array.isArray(paths) || !paths.length) throw new Error('audit: provide files, e.g. args {"paths":["a.js"],"concern":"..."}');
paths = [...new Set(paths.map((path) => String(path).trim()).filter(Boolean))];
if (!paths.length) throw new Error("audit: paths must contain at least one non-empty file path");
concern = String(concern || "").trim();
if (!concern) throw new Error("audit: concern must be a non-empty string");

const review = async (path) => {
	const finding = await agent(
		`Review the file \`${path}\` for: ${concern}. List concrete issues with line references, or reply exactly 'NO ISSUES' if there are none.`,
		{ agentType: "worker", label: path, profile: "read-only" },
	);
	return { path, finding };
};

const verifyReview = async (reviewed) => {
	const { path, finding } = reviewed;
	if (!finding.ok) return { ...reviewed, status: "failed", error: finding.error || "review agent failed" };
	const noIssues = finding.content.trim().toUpperCase() === "NO ISSUES";
	const verdict = await phase("verify", () => verify(
		`File under review: ${path}\n\nReviewer result:\n${finding.content}`,
		`Open \`${path}\` and independently check the original file. The reviewer result must accurately cover '${concern}'. ` +
			(noIssues ? "Pass only if the no-issues claim is supported by the file." : "Pass only if every reported issue is real, relevant, and supported by the cited lines."),
		{
			refute: true,
			label: path,
			profile: "read-only",
		},
	));
	if (!verdict.ok) return { ...reviewed, verdict, noIssues, status: "failed", error: verdict.error || "verification failed" };
	if (context.dryRun) return { ...reviewed, verdict, noIssues: false, status: "verified" };
	return { ...reviewed, verdict, noIssues, status: verdict.passed ? (noIssues ? "clean" : "verified") : "rejected" };
};

const checked = await phase("audit", () => pipeline(paths, review, verifyReview));
const solid = checked.filter((row) => row.status === "verified");
const counts = {
	verified: solid.length,
	clean: checked.filter((row) => row.status === "clean").length,
	rejected: checked.filter((row) => row.status === "rejected").length,
	failed: checked.filter((row) => row.status === "failed").length,
};
const coverage = `Coverage: ${checked.length}/${paths.length} files processed; ${counts.verified} with verified issues, ${counts.clean} independently clean, ${counts.rejected} rejected review result(s), ${counts.failed} failed.`;

if (!solid.length) {
	const heading = counts.failed || counts.rejected ? "# Audit incomplete" : "# Audit";
	const conclusion = counts.failed || counts.rejected ? "No issue report survived verification; do not interpret this as a clean audit." : `No verified issues found for: ${concern}.`;
	return `${heading}\n\n${conclusion}\n\n_${coverage}_`;
}

const findingsText = solid.map(({ path, finding }) => `## ${path}\n${finding.content}`).join("\n\n");
const report = await phase("report", () =>
	agent(
		`Summarize these verified findings about '${concern}'. Group by severity, most serious first, and give a one-line fix suggestion per issue.\n\n${findingsText}`,
		{ label: "report", profile: "none" },
	),
);
if (!report.ok) return `# Audit incomplete\n\nVerified findings could not be synthesized: ${report.error || "report agent failed"}\n\n_${coverage}_`;
return `${report.content}\n\n_${coverage}_`;

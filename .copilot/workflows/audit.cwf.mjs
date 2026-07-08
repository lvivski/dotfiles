// audit.cwf.mjs — audit files for a concern, adversarially verify findings, synthesize a report.
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

let paths, concern;
if (args && typeof args === "object" && !Array.isArray(args)) {
	paths = args.paths || [];
	concern = args.concern ?? DEFAULT_CONCERN;
} else if (Array.isArray(args)) {
	paths = args;
	concern = DEFAULT_CONCERN;
} else {
	paths = [];
	concern = DEFAULT_CONCERN;
}

if (!paths.length) return 'audit: provide files, e.g. args {"paths":["a.js"],"concern":"..."}';

const noTools = quarantine({ allowAllTools: false });

const review = async (path) => {
	const finding = await agent(
		`Review the file \`${path}\` for: ${concern}. List concrete issues with line references, or reply exactly 'NO ISSUES' if there are none.`,
		// untrusted file content: read-only, no shell/write/network/MCP
		{ agentType: "worker", label: path, phase: "audit", ...quarantine() },
	);
	return [path, finding];
};

const verifyReview = async (reviewed) => {
	const [path, finding] = reviewed;
	if (!finding.ok || finding.content.toUpperCase().includes("NO ISSUES")) return [path, finding, null];
	const verdict = await verify(finding, `each reported issue is real and relevant to: ${concern}`, {
		refute: true,
		label: path,
		phase: "verify",
		...noTools,
	});
	return [path, finding, verdict];
};

const checked = (await pipeline(paths, review, verifyReview)).filter((row) => row !== null);
const solid = checked.filter(([, , v]) => v && v.passed).map(([p, f]) => [p, f]);

if (!solid.length) return `audit: no verified issues found for: ${concern}`;

const report = await synthesize(
	solid.map(([p, f]) => `## ${p}\n${f.content}`),
	{
		prompt: `Summarize these verified findings about '${concern}'. Group by severity, most serious first, and give a one-line fix suggestion per issue.`,
		label: "report",
		...noTools,
	},
);
return report.content;

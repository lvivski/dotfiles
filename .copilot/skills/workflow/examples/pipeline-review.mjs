// pipeline-review.mjs — stream files through review then adversarial verify, report survivors.
export const meta = { name: "pipeline-review", description: "Review files for real bugs, verify, and group by severity." };

const files = args || ["README.md"];

const review = (path) => agent(`Review ${path} for real, reproducible bugs. Say NO ISSUES if none.`, { agentType: "worker", phase: "review", label: path });

const verifyRow = async (reviewResult, path) => ({
	path,
	review: reviewResult,
	verdict: await verify(reviewResult, "real, reproducible bug with enough evidence to act", { phase: "verify", label: path }),
});

const rows = (await pipeline(files, review, verifyRow)).filter((row) => row !== null);
const solid = rows.filter((row) => row.verdict.passed);

if (!solid.length) return "No verified issues found.";

const report = await synthesize(
	solid.map((row) => `${row.path}:\n${row.review.content}`),
	{ prompt: "Group these verified findings by severity.", label: "report" },
);
return report.content;

// pipeline-review.mjs — stream files through review then adversarial verify, report survivors.
export const meta = { name: "pipeline-review", description: "Review files for real bugs, verify, and group by severity." };

const files = context.args || ["README.md"];

const review = (path) => phase("review", () => agent(`Review ${path} for real, reproducible bugs. Say NO ISSUES if none.`, { agentType: "worker", label: path }));

const verifyRow = async (reviewResult, path) => ({
	path,
	review: reviewResult,
	verdict: await phase("verify", () => verify(reviewResult, "real, reproducible bug with enough evidence to act", { label: path })),
});

const rows = (await pipeline(files, review, verifyRow)).filter((row) => row !== null);
const solid = rows.filter((row) => row.verdict.passed);

if (!solid.length) return "No verified issues found.";

const report = await agent(
	`Group these verified findings by severity.\n\n${solid.map((row) => `${row.path}:\n${row.review.content}`).join("\n\n")}`,
	{ label: "report" },
);
return report.content;

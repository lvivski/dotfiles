// minimal-review.mjs — the smallest useful workflow: review, verify, synthesize.
export const meta = { name: "minimal-review", description: "Review items, verify findings, and synthesize a report." };

const items = context.args || ["item one", "item two"];

const review = (item) => phase("review", () => agent(`Review this item and report concrete findings: ${item}`, { agentType: "worker", label: String(item).slice(0, 24) }));

const verifyRow = async (result, item) => ({
	item,
	finding: result,
	verdict: await phase("verify", () => verify(result, "specific, supported, and actionable", { label: String(item).slice(0, 24) })),
});

const rows = (await pipeline(items, review, verifyRow)).filter((row) => row !== null);
const kept = rows.filter((row) => row.verdict.passed).map((row) => row.finding);

const report = await agent(`Deduplicate and summarize these verified findings.\n\n${kept.map((r) => r.content).join("\n\n")}`, { label: "report" });
return report.content;

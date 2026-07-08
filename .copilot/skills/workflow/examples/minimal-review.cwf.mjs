// minimal-review.cwf.mjs — the smallest useful workflow: review, verify, synthesize.
export const meta = { name: "minimal-review", description: "Review items, verify findings, and synthesize a report." };

const items = args || ["item one", "item two"];

const review = (item) => agent(`Review this item and report concrete findings: ${item}`, { agentType: "worker", phase: "review", label: String(item).slice(0, 24) });

const verifyRow = async (result, item) => ({
	item,
	finding: result,
	verdict: await verify(result, "specific, supported, and actionable", { phase: "verify", label: String(item).slice(0, 24) }),
});

const rows = (await pipeline(items, review, verifyRow)).filter((row) => row !== null);
const kept = rows.filter((row) => row.verdict.passed).map((row) => row.finding);

const report = await synthesize(kept, { prompt: "Deduplicate and summarize these verified findings.", label: "report" });
return report.content;

// fanout-synthesize.mjs — fan out summaries over items (a barrier), then merge into one overview.
export const meta = { name: "fanout-synthesize", description: "Summarize each item in parallel, then synthesize one overview." };

const items = context.args || ["README.md"];

const parts = await pipeline(items, (item) =>
	phase("summarize", () => agent(`Summarize the relevant facts from ${item}.`, { agentType: "worker", label: String(item).slice(0, 24) })),
);

const report = await agent(`Write one coherent overview from these summaries.\n\n${parts.map((p) => p.content).join("\n\n")}`, { label: "report" });
return report.content;
